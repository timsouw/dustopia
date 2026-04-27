// =====================================================================
// Frankenstein API — Cloudflare Worker
// Proxies Alchemy NFT API + ENS resolution, hides API key, caches in KV.
// =====================================================================
//
// ENDPOINTS:
//   GET /api/wallet/<address>?pageKey=<opt>  → Alchemy getNFTsForOwner
//   GET /api/ens/<name>                       → ENS resolve via ensideas
//   GET /api/health                           → ping
//
// REQUIRED BINDINGS (set in dashboard):
//   - Environment variable: ALCHEMY_KEY  (the secret API key)
//   - KV namespace binding: WALLET_CACHE
//
// CACHE TTL:
//   - Wallet pages: 30 minutes (NFT holdings change, but rarely on minute scale)
//   - ENS resolves: 24 hours (names rarely change)

// CORS: production sites only. Browser direct-navigation and server-to-server
// callers (curl, marketplace bots) don't send Origin — for those we omit ACAO
// entirely, which means a same-origin response with no cross-origin promise.
// Browsers refuse to expose such responses to JS on other origins, so this is
// safer than the old `*` fallback (which let arbitrary pages read sensitive
// per-wallet data via fetch).
//
// Marketplace-serving endpoints (/api/metadata/, /api/preview/) explicitly
// override to `*` via metadataResponse / their own headers — they're public
// by contract and need to be reachable by anonymous bots.
const ALLOWED_ORIGINS = new Set([
  'https://dustopia.xyz',
  'https://www.dustopia.xyz',
  'https://dustopia.pages.dev',
]);
const PAGES_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.dustopia\.pages\.dev$/;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin && (ALLOWED_ORIGINS.has(origin) || PAGES_PREVIEW_RE.test(origin));
  const headers = {
    'Vary':                         'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
    // Content-Encoding is required for gzipped atlas uploads (PUT /api/atlas/...).
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding',
    'Access-Control-Max-Age':       '86400',
  };
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (origin) {
    // Origin present but disallowed — explicit null blocks JS reads.
    headers['Access-Control-Allow-Origin'] = 'null';
  }
  // No Origin header (direct nav, curl, server-to-server) → omit ACAO. The
  // response still arrives, but a browser context with a different Origin
  // can't expose it to JS without a permissive ACAO header.
  return headers;
}

const WALLET_TTL = 30 * 60;          // 30 minutes
const ENS_TTL    = 24 * 60 * 60;     // 24 hours
const ALCH_TIMEOUT_MS = 12000;

// Rate limit: per-IP counter in KV, bucketed by minute. Eventually consistent
// (KV writes propagate within ~60s), so this is a soft deterrent against quota
// drain rather than a precise throttle. For stricter limits, layer Cloudflare's
// built-in rate-limiting rules on top.
//
// Two buckets: GENERAL for read-heavy endpoints, PUT for write endpoints
// (atlas, preview-cap, config). PUT is much tighter because every entry
// touches R2 storage — abuse there has a real $ cost, while abuse of
// reads only burns Worker CPU which Cloudflare already free-tier-caps.
const RATE_LIMIT_PER_MIN     = 60;
const RATE_LIMIT_PUT_PER_MIN = 10;

async function rateLimitOk(request, env, bucket = 'general') {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const cap = bucket === 'put' ? RATE_LIMIT_PUT_PER_MIN : RATE_LIMIT_PER_MIN;
  const key = `rl:${bucket}:${ip}:${minute}`;
  const current = parseInt((await env.WALLET_CACHE.get(key)) || '0', 10);
  if (current >= cap) return false;
  // Fire-and-forget increment; 90s TTL ensures keys self-expire.
  env.WALLET_CACHE.put(key, String(current + 1), { expirationTtl: 90 }).catch(() => {});
  return true;
}

function jsonResponse(body, request, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request), ...(init.headers || {}) },
  });
}

function errorResponse(status, message, request) {
  return jsonResponse({ error: message }, request, { status });
}

// Retry-aware upstream fetch (handles transient 5xx + timeouts)
async function upstreamFetch(url, attempts = 3) {
  const RETRIABLE = new Set([429, 500, 502, 503, 504]);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ALCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return r;
      if (!RETRIABLE.has(r.status)) return r;        // permanent error → bubble up
      lastErr = new Error(`upstream HTTP ${r.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
    if (i < attempts - 1) {
      await new Promise(res => setTimeout(res, 250 * Math.pow(3, i)));
    }
  }
  throw lastErr;
}

// Alchemy pageKey is an opaque base64ish token. We pass it back upstream
// untouched, but cap the length and limit the charset so a malicious caller
// can't smuggle path-traversal or huge values into our cache key.
const PAGE_KEY_RE = /^[A-Za-z0-9_=:.\-]{1,512}$/;

async function handleWallet(address, pageKey, request, env) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return errorResponse(400, 'invalid address', request);
  }
  if (pageKey && !PAGE_KEY_RE.test(pageKey)) {
    return errorResponse(400, 'invalid pageKey', request);
  }
  const addrLower = address.toLowerCase();
  const cacheKey = `wallet:${addrLower}:${pageKey || ''}`;

  // Try KV cache first
  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(cached, request, { headers: { 'X-Cache': 'HIT' } });
  }

  // Cache miss → upstream
  const u = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_KEY}/getNFTsForOwner`);
  u.searchParams.set('owner', address);
  u.searchParams.set('pageSize', '100');
  u.searchParams.set('withMetadata', 'true');
  u.searchParams.set('excludeFilters[]', 'SPAM');
  if (pageKey) u.searchParams.set('pageKey', pageKey);

  let r;
  try {
    r = await upstreamFetch(u.toString());
  } catch (e) {
    return errorResponse(502, `alchemy unreachable: ${e.message}`, request);
  }
  if (!r.ok) return errorResponse(r.status === 429 ? 429 : 502, `alchemy HTTP ${r.status}`, request);

  const body = await r.text();
  // Fire-and-forget cache write (don't block response)
  env.WALLET_CACHE.put(cacheKey, body, { expirationTtl: WALLET_TTL }).catch(() => {});

  return jsonResponse(body, request, { headers: { 'X-Cache': 'MISS' } });
}

// ENS labels: a-z 0-9 hyphen, 1-63 chars per label, no leading/trailing hyphen,
// dot-separated, must end in .eth. Reject anything else before it hits the
// upstream resolver or pollutes our KV cache (cache key uses the lowercased
// name, so we normalize before doing anything with it).
const ENS_LABEL_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/;

async function handleEns(rawName, request, env) {
  const name = String(rawName || '').toLowerCase();
  if (name.length < 5 || name.length > 253 || !ENS_LABEL_RE.test(name)) {
    return errorResponse(400, 'invalid ENS name', request);
  }
  const cacheKey = `ens:${name}`;

  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(cached, request, { headers: { 'X-Cache': 'HIT' } });
  }

  let r;
  try {
    r = await upstreamFetch(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(name)}`);
  } catch (e) {
    return errorResponse(502, `ens unreachable: ${e.message}`, request);
  }
  if (!r.ok) return errorResponse(502, `ens HTTP ${r.status}`, request);

  const body = await r.text();
  env.WALLET_CACHE.put(cacheKey, body, { expirationTtl: ENS_TTL }).catch(() => {});

  return jsonResponse(body, request, { headers: { 'X-Cache': 'MISS' } });
}

// =====================================================================
// OWNED TOKENS — list of dustopia tokenIds owned by an address. Used by
// the /configure page to populate the user's "your tokens" list right
// after wallet connect. One Alchemy call, short KV cache. Public — token
// ownership is on-chain anyway, no privacy concern in exposing the read.
// =====================================================================
const OWNED_TTL = 60;             // seconds — ownership shifts often during sales

async function handleOwned(addr, request, env) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
  }
  const addrLower = addr.toLowerCase();
  const cacheKey = `owned:${addrLower}`;
  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(cached, request, { headers: { 'X-Cache': 'HIT' } });
  }

  // Alchemy paginates getNFTsForOwner at 100 per page; whales with hundreds
  // of dustopia tokens are unlikely but this loop costs nothing in the
  // common (≤1 page) case and avoids silently truncating the list.
  const tokenIds = [];
  let pageKey = null;
  for (let p = 0; p < 50; p++) {
    const u = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_KEY}/getNFTsForOwner`);
    u.searchParams.set('owner', addr);
    u.searchParams.append('contractAddresses[]', NFT_CONTRACT);
    u.searchParams.set('pageSize', '100');
    u.searchParams.set('withMetadata', 'false');
    if (pageKey) u.searchParams.set('pageKey', pageKey);

    let r;
    try { r = await upstreamFetch(u.toString()); }
    catch (e) { return errorResponse(502, `alchemy unreachable: ${e.message}`, request); }
    if (!r.ok) return errorResponse(502, `alchemy HTTP ${r.status}`, request);

    let data;
    try { data = await r.json(); }
    catch { return errorResponse(502, 'alchemy returned invalid JSON', request); }

    for (const n of (data.ownedNfts || [])) {
      const id = n && (n.tokenId || (n.id && n.id.tokenId));
      if (typeof id !== 'string') continue;
      // Alchemy may return either decimal ("1") or hex ("0x01"). Normalize.
      let dec;
      try { dec = BigInt(id).toString(10); }
      catch { continue; }
      if (!/^\d+$/.test(dec) || dec.length > 78) continue;
      tokenIds.push(dec);
    }
    if (!data.pageKey) break;
    pageKey = data.pageKey;
  }

  const body = JSON.stringify({ contract: NFT_CONTRACT, owner: addrLower, tokenIds });
  env.WALLET_CACHE.put(cacheKey, body, { expirationTtl: OWNED_TTL }).catch(() => {});
  return jsonResponse(body, request, { headers: { 'X-Cache': 'MISS' } });
}
// The drop contract's baseURI is set to https://api.dustopia.xyz/api/metadata/
// so tokenURI(N) becomes /api/metadata/N. We respond with a standard ERC-721
// metadata JSON whose animation_url loads the live sphere of the token's
// current owner.
//
// Owner is resolved on-demand via Alchemy eth_call to ownerOf(uint256) on
// the production contract. Result is cached in KV for OWNER_TTL seconds so
// marketplace polling doesn't hammer the upstream. If the lookup fails for
// any reason we fall back to OWNER_FALLBACK so the NFT keeps rendering
// instead of breaking on transient outages.

// OE drop contract on Ethereum mainnet (OpenSea Drops). When/if we add a
// testnet contract too, this becomes a chain → address map.
const NFT_CONTRACT   = '0x8196e52111255d71732c2187F0F8420704417cE6';
// Resilience anchor: the deploy wallet. Used when Alchemy can't tell us who
// currently owns a token (network blip, key rotation race, etc.).
const OWNER_FALLBACK = '0x014c2b84bce4f4ec280c8d91d9f6a9eb46063daf';
const OWNER_TTL      = 5 * 60;  // KV TTL for owner lookups (seconds)
const METADATA_TTL   = 60;      // Cache-Control: max-age on the JSON response

function metadataResponse(body, request, init = {}) {
  // Marketplaces fetch from various servers (often server-to-server, no
  // Origin header). Always allow * for metadata so OpenSea / wallets / dapps
  // can read it without CORS friction. Short Cache-Control lets owner
  // changes propagate quickly. Explicit charset=utf-8 keeps em-dashes and
  // other non-ASCII chars rendering correctly across raw-JSON viewers.
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':              `public, max-age=${METADATA_TTL}`,
      ...(init.headers || {}),
    },
  });
}

// Look up the current owner of `tokenId` on the OE drop contract.
// Returns lowercase 0x address, or null if the token doesn't exist / lookup
// failed. Caches positive results in KV for OWNER_TTL seconds.
async function lookupOwner(tokenId, env) {
  const cacheKey = `owner:${NFT_CONTRACT.toLowerCase()}:${tokenId}`;
  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) return cached;

  // ABI-encode ownerOf(uint256): selector 0x6352211e + 32-byte tokenId.
  const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
  const data = '0x6352211e' + paddedId;
  const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;

  let json;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ALCH_TIMEOUT_MS);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'eth_call',
        params:  [{ to: NFT_CONTRACT, data }, 'latest'],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    json = await r.json();
  } catch {
    return null;
  }

  // Contract revert (token doesn't exist) shows up as { error: {...} }.
  if (json.error || !json.result || json.result === '0x') return null;
  // ownerOf returns 32-byte word: '0x' + 64 hex chars, address in last 40.
  // Anything shorter is a malformed RPC response — refuse rather than
  // truncate our way into a fake-looking address.
  if (typeof json.result !== 'string' || json.result.length < 66) return null;
  const owner = ('0x' + json.result.slice(-40)).toLowerCase();
  // Sanity check: should be a valid hex address, not the zero address.
  if (!/^0x[0-9a-f]{40}$/.test(owner) || owner === '0x' + '00'.repeat(20)) {
    return null;
  }

  env.WALLET_CACHE.put(cacheKey, owner, { expirationTtl: OWNER_TTL }).catch(() => {});
  return owner;
}

// Animated SVG fallback for the metadata `image` field. Used when no captured
// WebP exists in R2 yet for this token's owner. Marketplaces show this in
// grids / search / Twitter previews where they can't run the live
// animation_url iframe. SMIL animation (animateTransform / animate) survives
// most marketplace SVG sanitizers — we'll know within a day whether OpenSea
// preserves it. Per-token hue + rotation phase keeps each tile distinct so
// the grid reads as a curated set rather than a wall of clones.
function previewSvg(tokenId) {
  const id    = parseInt(tokenId, 10) || 0;
  const hue   = (id * 47) % 360;
  const phase = (id * 13) % 360;
  const dots  = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(deg => {
    const rad = deg * Math.PI / 180;
    const x = (Math.cos(rad) * 230).toFixed(1);
    const y = (Math.sin(rad) * 230).toFixed(1);
    const dotHue = (hue + deg) % 360;
    const begin  = (deg / 360 * 3).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="3" fill="hsl(${dotHue},70%,75%)"><animate attributeName="opacity" values="0.15;1;0.15" dur="3s" begin="${begin}s" repeatCount="indefinite"/></circle>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="g${id}" cx="38%" cy="32%" r="65%">
      <stop offset="0%"   stop-color="hsl(${hue},80%,90%)" stop-opacity="0.95"/>
      <stop offset="35%"  stop-color="hsl(${(hue + 30) % 360},65%,68%)" stop-opacity="0.85"/>
      <stop offset="70%"  stop-color="hsl(${(hue + 60) % 360},55%,38%)" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#0a0a12" stop-opacity="0.95"/>
    </radialGradient>
  </defs>
  <rect width="800" height="800" fill="#14141a"/>
  <circle cx="400" cy="400" r="240" fill="url(#g${id})">
    <animate attributeName="opacity" values="0.55;0.85;0.55" dur="5s" repeatCount="indefinite"/>
    <animate attributeName="r" values="220;255;220" dur="6s" repeatCount="indefinite"/>
  </circle>
  <g transform="translate(400 400)">
    <g fill="none" stroke="#3a3a44" stroke-width="1.2">
      <animateTransform attributeName="transform" type="rotate" from="${phase}" to="${phase + 360}" dur="24s" repeatCount="indefinite"/>
      <ellipse rx="220" ry="220"/>
      <ellipse rx="220" ry="160"/>
      <ellipse rx="220" ry="100"/>
      <ellipse rx="220" ry="40"/>
      <ellipse rx="40"  ry="220"/>
      <ellipse rx="100" ry="220"/>
      <ellipse rx="160" ry="220"/>
    </g>
    <g>
      <animateTransform attributeName="transform" type="rotate" from="0" to="-360" dur="32s" repeatCount="indefinite"/>
      ${dots}
    </g>
  </g>
  <text x="400" y="700" text-anchor="middle" font-family="-apple-system,Helvetica,sans-serif" font-size="24" fill="#9a9aa5" letter-spacing="0.08em">Dustopia #${tokenId}</text>
  <text x="400" y="730" text-anchor="middle" font-family="-apple-system,Helvetica,sans-serif" font-size="13" fill="#55555e" letter-spacing="0.04em">live wallet portrait -- open to view</text>
</svg>`;
}

// Resolve token preview: animated WebP captured by a real visitor's browser
// if we have one in R2, otherwise the animated SVG fallback. The URL accepts
// .webp / .svg / no extension — Worker decides the response media type based
// on what's actually stored, not the suffix.
async function handlePreview(rawTokenId, request, env, ctx) {
  const tokenId = rawTokenId.replace(/\.(svg|png|webp|gif)$/i, '');
  if (!/^\d+$/.test(tokenId) || tokenId.length > 78) {
    return errorResponse(400, 'invalid token id', request);
  }

  // Resolve owner so we can look up their captured preview. Falls back to
  // the deploy wallet on transient lookup failure (matches metadata behaviour).
  // Re-validate before constructing R2 keys so a malformed upstream value
  // can't traverse outside the preview/ prefix.
  let owner = (await lookupOwner(tokenId, env)) || OWNER_FALLBACK;
  if (!/^0x[0-9a-f]{40}$/.test(owner)) owner = OWNER_FALLBACK;
  const previewKey = `preview/${owner}.bin`;

  // Try R2 first. Wrap with edge cache so popular tokens skip the R2 op
  // entirely on the second hit per region.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set('X-Edge-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers: h });
  }

  const obj = await env.ATLAS.get(previewKey);
  if (obj) {
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      // Short TTL so re-captures (after a wallet's holdings change) propagate
      // within an hour to marketplaces. The edge cache layer above handles
      // the high-RPS amortization.
      'Cache-Control':               'public, max-age=3600',
      'X-Edge-Cache':                'MISS',
    });
    obj.writeHttpMetadata(headers);
    // httpMetadata remembers the stored asset's actual type (PNG today,
    // historical entries may still be GIF or WebP).
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'image/png');
    const resp = new Response(obj.body, { headers });
    if (ctx) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }

  // No captured preview yet — serve the animated SVG so marketplace grids at
  // least show something living until the first /embed visitor seeds R2.
  const svg = previewSvg(tokenId);
  const resp = new Response(svg, {
    headers: {
      'Content-Type':                'image/svg+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // Shorter than the WebP path: we WANT marketplaces to re-fetch fast
      // once a real capture lands.
      'Cache-Control':               'public, max-age=300',
      'X-Edge-Cache':                'MISS',
    },
  });
  if (ctx) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// =====================================================================
// PREVIEW CAPTURE — animated WebP loops captured client-side from the live
// sphere and stored in R2. The frontend in /embed/<addr> waits for the
// sphere to settle, grabs ~5s of frames at 12 fps, encodes via the webpxmux
// wasm muxer, and uploads here. The upload is fire-and-forget; OpenSea
// auto-refreshes metadata on transfer, and our metadata image URL points at
// /api/preview/<tokenId> which transparently returns the captured WebP once
// it's available (or the animated SVG fallback before then).
//
// Storage key: preview/<addr_lower>.webp
//
// V1 is unauthenticated like atlas. Size + MIME validated; SIWE-gated PUT
// is the eventual hardening.
const PREVIEW_MAX = 4 * 1024 * 1024;     // 4 MiB ceiling — PNG snapshots run ~150-500 KiB
const PREVIEW_MIN = 512;                 // weed out empty/garbage PUTs
// Accept PNG (current frontend), JPEG, GIF, WebP. We sniff magic bytes on
// PUT and reject anything that doesn't match its declared Content-Type, so
// the Worker is encoder-agnostic and we can swap formats client-side later
// without redeploying.
const PREVIEW_OK_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function detectImageType(buf) {
  if (buf.byteLength < 12) return null;
  const sig = new Uint8Array(buf, 0, 12);
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47
   && sig[4] === 0x0d && sig[5] === 0x0a && sig[6] === 0x1a && sig[7] === 0x0a) return 'image/png';
  // JPEG: FF D8 FF
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) return 'image/jpeg';
  // GIF89a / GIF87a
  if (sig[0] === 0x47 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x38) return 'image/gif';
  // RIFF .... WEBP
  if (sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46
   && sig[8] === 0x57 && sig[9] === 0x45 && sig[10] === 0x42 && sig[11] === 0x50) return 'image/webp';
  return null;
}

async function handlePreviewCap(addr, request, env, ctx) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
  }
  // Single key per address. The httpMetadata contentType remembers whether
  // it's GIF or WebP so GET serves the right MIME without sniffing.
  const key = `preview/${addr.toLowerCase()}.bin`;

  if (request.method === 'HEAD') {
    const head = await env.ATLAS.head(key);
    if (!head) return errorResponse(404, 'no preview cached', request);
    const ct = (head.httpMetadata && head.httpMetadata.contentType) || 'image/png';
    return new Response(null, {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Content-Type':   ct,
        'Content-Length': String(head.size),
      },
    });
  }

  if (request.method === 'GET') {
    const obj = await env.ATLAS.get(key);
    if (!obj) return errorResponse(404, 'no preview cached', request);
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=3600',
    });
    obj.writeHttpMetadata(headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'image/png');
    return new Response(obj.body, { headers });
  }

  if (request.method === 'PUT') {
    const ct = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
    if (!PREVIEW_OK_TYPES.includes(ct)) {
      return errorResponse(415, `expected one of ${PREVIEW_OK_TYPES.join(', ')}`, request);
    }
    // Require Content-Length so we reject oversize bodies BEFORE buffering
    // any of them. Browser fetch() with Blob body always sets it; clients
    // that send chunked-encoded uploads have to declare their size up-front.
    const lenHdr = request.headers.get('Content-Length');
    if (!lenHdr) return errorResponse(411, 'Content-Length required', request);
    const len = parseInt(lenHdr, 10);
    if (!Number.isFinite(len) || len < 0) return errorResponse(400, 'invalid Content-Length', request);
    if (len > PREVIEW_MAX) return errorResponse(413, `body too large (${len} > ${PREVIEW_MAX})`, request);
    if (len < PREVIEW_MIN) return errorResponse(400, 'body too small', request);

    const buf = await request.arrayBuffer();
    // Defense in depth: actual body length must match the declared Content-Length.
    if (buf.byteLength !== len)        return errorResponse(400, 'body length mismatch', request);
    const detected = detectImageType(buf);
    if (!detected)                     return errorResponse(400, 'unrecognized image format', request);
    if (detected !== ct)               return errorResponse(400, `body is ${detected} but Content-Type is ${ct}`, request);

    await env.ATLAS.put(key, buf, {
      httpMetadata: { contentType: detected },
    });
    return jsonResponse({ ok: true, bytes: buf.byteLength, type: detected }, request);
  }

  if (request.method === 'DELETE') {
    await env.ATLAS.delete(key).catch(() => {});
    return jsonResponse({ ok: true }, request);
  }

  return errorResponse(405, 'method not allowed', request);
}

// Best-effort owner-collection summary derived from the cached atlas meta
// stored in R2. Returns { tokens, collections } if any meta is available,
// or null if the address has never been built. Reads desktop grid first
// (most adresses), falls back to mobile grid; either is fine since they
// share the same token list.
async function readOwnerSummary(owner, env) {
  for (const grid of [192, 128]) {
    const obj = await env.ATLAS.get(`${owner.toLowerCase()}/${grid}.json`);
    if (!obj) continue;
    let meta;
    try { meta = await obj.json(); } catch { continue; }
    if (!meta || !Array.isArray(meta.tokens)) continue;
    const collections = new Set();
    for (const t of meta.tokens) {
      if (t && typeof t.collection === 'string' && t.collection.length) {
        collections.add(t.collection);
      }
    }
    return { tokens: meta.tokens.length, collections: collections.size };
  }
  return null;
}

async function handleMetadata(rawTokenId, request, env) {
  // Some contracts append .json; strip it defensively even though our test
  // contract (ERC721A) does not.
  const tokenId = rawTokenId.replace(/\.json$/i, '');
  if (!/^\d+$/.test(tokenId) || tokenId.length > 78) {
    return errorResponse(400, 'invalid token id', request);
  }

  // Look up the current owner; fall back to the deploy wallet so transient
  // upstream failures don't blank the NFT in marketplaces. Re-validate the
  // address shape one more time before interpolating into URLs — defensive
  // against any future code path that bypasses lookupOwner's own checks.
  let owner = (await lookupOwner(tokenId, env)) || OWNER_FALLBACK;
  if (!/^0x[0-9a-f]{40}$/.test(owner)) owner = OWNER_FALLBACK;
  // animation_url → chrome-free embed view (just the sphere) with tokenId
  // hint so the renderer can fetch the per-token config and filter the
  // wallet to the holder's chosen subset. external_url → the landing
  // page so the OpenSea "external link" still feels right.
  const animUrl     = `https://dustopia.xyz/embed/${owner}?token=${tokenId}`;
  const externalUrl = `https://dustopia.xyz/#${owner}`;
  const shortOwner  = `${owner.slice(0, 6)}…${owner.slice(-4)}`;

  // Build OpenSea-style attributes. Token ID + Network are always present.
  // Tokens / Collections are added when we have a cached atlas meta in R2;
  // they update automatically as the holder's collection changes (the
  // atlas is rebuilt + reuploaded on every full visit).
  const attributes = [
    { trait_type: 'Token ID', value: Number(tokenId) },
    { trait_type: 'Network',  value: 'Ethereum' },
    { trait_type: 'Owner',    value: shortOwner },
  ];
  const summary = await readOwnerSummary(owner, env).catch(() => null);
  if (summary) {
    attributes.push({ trait_type: 'Tokens',      value: summary.tokens,      display_type: 'number' });
    attributes.push({ trait_type: 'Collections', value: summary.collections, display_type: 'number' });
  }

  return metadataResponse({
    name:          `Dustopia #${tokenId}`,
    description:   "Living wallet portrait -- every Ethereum address rendered as a 3D sphere of swirling NFT thumbnails. The artwork updates with the holder's collection.",
    // Worker decides the actual MIME (PNG / SVG fallback) per request based
    // on what's in R2 for the token's owner; the URL is extension-less so
    // marketplaces don't lock onto a specific format.
    image:         `https://api.dustopia.xyz/api/preview/${tokenId}`,
    animation_url: animUrl,
    external_url:  externalUrl,
    attributes,
  }, request);
}

// =====================================================================
// ATLAS CACHE — persistent R2 storage of pre-built atlases (binary RGB pixel
// data + JSON meta). The frontend builds the atlas client-side (fetching all
// NFT thumbnails, drawing them into a canvas, dumping RGB tiles into a
// Uint8Array). That work takes 10–60s on a cold wallet — and once done, the
// result is deterministic for that (wallet, GRID) pair until the holdings
// change. We cache it forever and serve it from R2 on every subsequent visit.
//
// Invalidation is manual today: DELETE /api/atlas/<addr> blows away both grids
// and forces a rebuild on next load. A future Alchemy webhook on Transfer
// events will call DELETE automatically when an NFT moves in/out of a wallet.
//
// Keys:
//   <addr_lower>/<grid>.bin   raw RGB8 (N · grid² · 3 bytes)
//   <addr_lower>/<grid>.json  meta { count, lods, offsets, tokens, ... }
//
// V1 is unauthenticated: anyone can PUT for any address. The size cap and
// MIME validation prevent random garbage from blowing up the bucket. Under
// adversarial load we'd add a SIWE signature requirement here.
const ATLAS_GRIDS_OK = new Set([128, 192]);
const ATLAS_TOKEN_LIMIT = 1024;        // mirror MAX_TOKENS in index.html
const ATLAS_META_MAX = 256 * 1024;     // 256 KiB ceiling for the JSON meta
const ATLAS_BIN_MAX  = ATLAS_TOKEN_LIMIT * 192 * 192 * 3 + 1024;
const ATLAS_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// Hard ceiling on atlas R2 entries per address. Each saved selection adds
// up to 4 entries (2 grids × bin/json), so even a holder with a dozen
// saved selections lands well under this. Real purpose: stop unauthenticated
// PUT spam from filling R2 with random fingerprints under one address.
const ATLAS_PER_ADDR_CAP = 64;

// Per-(addr, grid, fingerprint) cache key. The frontend computes a SHA-256
// fingerprint of the selection blob and passes it as ?fp=<hex16>. fp='all'
// (default subset = entire wallet) keeps the legacy key shape so existing
// R2 entries stay reachable; any non-'all' fp lives in a sibling key. fp
// must be /^[a-z0-9]{16}$/ or the literal 'all' — anything else is rejected
// at the route layer to keep the key namespace clean.
const ATLAS_FP_RE = /^[a-z0-9]{16}$/;
function atlasKey(addr, grid, kind, fp) {
  const a = addr.toLowerCase();
  if (!fp || fp === 'all') return `${a}/${grid}.${kind}`;
  return `${a}/${grid}-${fp}.${kind}`;
}

function atlasResponse(body, request, init = {}) {
  // Same wide-open CORS as metadata: this is hit by the live frontend AND by
  // direct browser navigations (cache warmups), so * is fine. Long max-age
  // because atlases are immutable per (addr, grid) until DELETE clears them.
  return new Response(body, {
    ...init,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               ATLAS_CACHE_CONTROL,
      ...(init.headers || {}),
    },
  });
}

async function handleAtlasGet(addr, grid, wantMeta, fp, request, env, ctx) {
  // ── Edge cache layer ──────────────────────────────────────────────
  // Cloudflare's free per-colocation cache. R2 is fast but every miss
  // costs a Class B op + cross-region latency. Wrapping with caches.default
  // means a second visitor in the same region pays nothing — the bytes
  // come straight off the edge node. Cache-Control: immutable on the
  // upstream response means the edge respects long TTLs.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set('X-Edge-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers: h });
  }

  const key = atlasKey(addr, grid, wantMeta ? 'json' : 'bin', fp);
  const obj = await env.ATLAS.get(key);
  if (!obj) return errorResponse(404, 'atlas not cached', request);

  // Build response from R2 object; preserve stored metadata (in particular
  // Content-Encoding: gzip when the client gzipped before upload — browsers
  // decompress transparently on fetch).
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               ATLAS_CACHE_CONTROL,
    'X-Edge-Cache':                'MISS',
  });
  obj.writeHttpMetadata(headers);
  // Fallback content-type if R2 didn't have one stored.
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', wantMeta ? 'application/json; charset=utf-8' : 'application/octet-stream');
  }

  const resp = new Response(obj.body, { headers });
  // Seed the edge cache for the next visitor. waitUntil so we don't block
  // this response on the cache write.
  if (ctx) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

async function handleAtlasPut(addr, grid, wantMeta, fp, request, env) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
  // Atlas binaries used to be raw RGB (application/octet-stream, optionally
  // gzipped via Content-Encoding). We've moved to WebP-encoded 2D atlas
  // images (image/webp) — same pixel data, ~10× smaller payload because
  // photographic NFT thumbnails compress well with format-aware codecs.
  // Both shapes are still accepted on PUT to keep older clients working.
  const ATLAS_BIN_TYPES = ['application/octet-stream', 'image/webp', 'image/png'];
  if (wantMeta) {
    if (!ct.startsWith('application/json')) {
      return errorResponse(415, 'expected application/json for meta', request);
    }
  } else {
    if (!ATLAS_BIN_TYPES.includes(ct)) {
      return errorResponse(415, `expected one of ${ATLAS_BIN_TYPES.join(', ')}`, request);
    }
  }
  const ce = (request.headers.get('Content-Encoding') || '').toLowerCase();
  const isGzipped = !wantMeta && ct === 'application/octet-stream'
                              && (ce === 'gzip' || ce === 'deflate' || ce === 'br');
  const isImage   = !wantMeta && (ct === 'image/webp' || ct === 'image/png');

  const max = wantMeta ? ATLAS_META_MAX : ATLAS_BIN_MAX;
  // Require Content-Length so we reject oversize bodies BEFORE buffering
  // any of them. Browser fetch() with ArrayBuffer / Blob body always sets it.
  const lenHdr = request.headers.get('Content-Length');
  if (!lenHdr) return errorResponse(411, 'Content-Length required', request);
  const len = parseInt(lenHdr, 10);
  if (!Number.isFinite(len) || len < 0) return errorResponse(400, 'invalid Content-Length', request);
  if (len > max)  return errorResponse(413, `body too large (${len} > ${max})`, request);
  if (len === 0) return errorResponse(400, 'empty body', request);

  const buf = await request.arrayBuffer();
  if (buf.byteLength !== len) return errorResponse(400, 'body length mismatch', request);

  if (!wantMeta && isImage) {
    // Verify magic bytes match the declared content-type. Cheap check
    // that prevents a client from declaring image/webp but uploading
    // arbitrary bytes that bypass the raw-RGB structural validation.
    const detected = detectImageType(buf);
    if (!detected) return errorResponse(400, 'unrecognized image format', request);
    if (detected !== ct) return errorResponse(400, `body is ${detected} but Content-Type is ${ct}`, request);
  } else if (!wantMeta && !isGzipped) {
    // Legacy raw-RGB upload: byte length must be exactly N × tile² × 3.
    const tile = grid * grid * 3;
    if (buf.byteLength % tile !== 0) {
      return errorResponse(400, `binary not aligned to grid² · 3 (${tile} bytes)`, request);
    }
    const n = buf.byteLength / tile;
    if (n < 1 || n > ATLAS_TOKEN_LIMIT) {
      return errorResponse(400, `token count ${n} out of range [1, ${ATLAS_TOKEN_LIMIT}]`, request);
    }
  } else if (wantMeta) {
    // Meta: must be valid JSON with the expected shape. Reject anything else
    // before it lands in the bucket. We also cap the per-token string
    // lengths so a malicious client can't shove a few MB of payload into
    // each entry of a 1024-token array.
    const TOKEN_FIELD_MAX = 256;
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(buf)); }
    catch { return errorResponse(400, 'meta is not valid JSON', request); }
    if (!meta || typeof meta.count !== 'number' || !Array.isArray(meta.lods) || !Array.isArray(meta.tokens)) {
      return errorResponse(400, 'meta missing required fields', request);
    }
    if (meta.count > ATLAS_TOKEN_LIMIT || meta.tokens.length !== meta.count) {
      return errorResponse(400, 'meta.count inconsistent', request);
    }
    if (meta.lods.length > 8) {
      return errorResponse(400, 'meta.lods too large', request);
    }
    for (let i = 0; i < meta.tokens.length; i++) {
      const t = meta.tokens[i];
      if (!t || typeof t !== 'object') return errorResponse(400, `meta.tokens[${i}] must be object`, request);
      const c = t.collection, id = t.tokenId;
      if (c  !== undefined && (typeof c  !== 'string' || c.length  > TOKEN_FIELD_MAX)) {
        return errorResponse(400, `meta.tokens[${i}].collection invalid`, request);
      }
      if (id !== undefined && (typeof id !== 'string' || id.length > TOKEN_FIELD_MAX)) {
        return errorResponse(400, `meta.tokens[${i}].tokenId invalid`, request);
      }
    }
  }

  // Persist the actual MIME so GET serves the right Content-Type back.
  let storedCt = 'application/octet-stream';
  if (wantMeta)        storedCt = 'application/json; charset=utf-8';
  else if (isImage)    storedCt = ct;       // image/webp or image/png
  const httpMetadata = { contentType: storedCt };
  if (isGzipped) httpMetadata.contentEncoding = ce;

  // Per-addr R2 entry cap. Atlas keys for one address fan out by grid
  // (128/192) × fp (one per saved selection × bin/json). Even a heavy
  // user shouldn't accumulate more than a few dozen entries; the cap
  // here closes the unauthenticated-PUT spam vector without breaking
  // the legitimate "anyone can populate the cache for any wallet"
  // model. We only enforce when adding a NEW key; updates to an
  // existing key (same fp) bypass the cap.
  const targetKey = atlasKey(addr, grid, wantMeta ? 'json' : 'bin', fp);
  const existing  = await env.ATLAS.head(targetKey).catch(() => null);
  if (!existing) {
    const list = await env.ATLAS.list({
      prefix: `${addr.toLowerCase()}/`,
      limit: ATLAS_PER_ADDR_CAP + 1,
    }).catch(() => null);
    if (list && list.objects.length >= ATLAS_PER_ADDR_CAP) {
      return errorResponse(429, `atlas cache cap reached (${ATLAS_PER_ADDR_CAP} entries per address)`, request);
    }
  }

  await env.ATLAS.put(targetKey, buf, { httpMetadata });
  return jsonResponse({ ok: true, bytes: buf.byteLength, encoded: isGzipped ? ce : null }, request);
}

async function handleAtlasDelete(addr, request, env, ctx) {
  // Wipe every (grid, fingerprint) entry for this address. We list under
  // the addr prefix instead of enumerating because the holder may have
  // saved several distinct selections — each has its own fp-suffixed key.
  // Idempotent — missing keys are no-ops.
  const a = addr.toLowerCase();
  let truncated = true;
  let cursor = undefined;
  const keys = [];
  while (truncated && keys.length < 256) {  // hard ceiling = sanity
    const list = await env.ATLAS.list({ prefix: `${a}/`, cursor }).catch(() => null);
    if (!list) break;
    for (const obj of list.objects) keys.push(obj.key);
    truncated = list.truncated;
    cursor = list.cursor;
  }
  await Promise.all(keys.map(k => env.ATLAS.delete(k).catch(() => {})));
  // Edge cache purge — only clears this region's edge node. Other regions
  // serve stale bytes until their Cache-Control TTL expires. Acceptable for
  // a manual refresh button; if global propagation matters later we'll
  // version the URL or use the Cache Purge API.
  if (ctx) {
    const origin = new URL(request.url).origin;
    const cacheUrls = [];
    for (const grid of ATLAS_GRIDS_OK) {
      cacheUrls.push(`${origin}/api/atlas/${addr}?grid=${grid}`);
      cacheUrls.push(`${origin}/api/atlas/${addr}?grid=${grid}&meta=1`);
    }
    ctx.waitUntil(Promise.all(cacheUrls.map(u =>
      caches.default.delete(new Request(u, { method: 'GET' })).catch(() => {})
    )));
  }
  return jsonResponse({ ok: true, deleted: keys.length }, request);
}

async function handleAtlas(addr, request, env, ctx) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
  }
  if (request.method === 'DELETE') {
    return handleAtlasDelete(addr, request, env, ctx);
  }
  const url = new URL(request.url);
  const grid = parseInt(url.searchParams.get('grid') || '0', 10);
  if (!ATLAS_GRIDS_OK.has(grid)) {
    return errorResponse(400, `grid must be one of ${[...ATLAS_GRIDS_OK].join(',')}`, request);
  }
  const wantMeta = url.searchParams.get('meta') === '1';
  // Optional per-selection fingerprint. Default 'all' = entire wallet,
  // matches the legacy key shape so existing R2 entries stay reachable.
  const fpRaw = url.searchParams.get('fp') || 'all';
  if (fpRaw !== 'all' && !ATLAS_FP_RE.test(fpRaw)) {
    return errorResponse(400, 'invalid fp', request);
  }
  if (request.method === 'GET') return handleAtlasGet(addr, grid, wantMeta, fpRaw, request, env, ctx);
  if (request.method === 'PUT') return handleAtlasPut(addr, grid, wantMeta, fpRaw, request, env);
  return errorResponse(405, 'method not allowed', request);
}

// =====================================================================
// PER-TOKEN CONFIG — stored in R2 under config/<tokenId>.json. Owner-gated
// PUT (verified via EIP-191 personal_sign) lets the holder pick which of
// their NFTs go into the sphere; without a config the renderer falls back
// to "show everything in the wallet". A separate Alchemy Notify webhook
// hits /api/webhook/transfer to wipe the config when the token changes
// hands, so a new owner never inherits the previous owner's selection.
//
// Config schema (all fields required):
//   {
//     "tokenId":     1,
//     "ownerAtSave": "0x014c...",
//     "savedAt":     1714123456,
//     "selection":   {
//       "mode":        "all" | "subset",
//       "collections": ["0xcontract1", ...],            // contract addrs
//       "tokens":      [{"contract": "0x...", "tokenId": "..."}]
//     }
//   }
//
// SIWE-style PUT body (everything required):
//   {
//     "config":    { ...config above... },
//     "message":   "Configure Dustopia #<id>\nOwner: 0x...\n
//                   Timestamp: <ISO>\nNonce: <hex>",
//     "signature": "0x..."
//   }
//
// Worker verifies:
//   1. message regex parses out tokenId / owner / timestamp / nonce
//   2. tokenId in message matches URL tokenId
//   3. timestamp ≤ 5 minutes old (replay window)
//   4. signature recovers to `owner` from message
//   5. ownerOf(tokenId) on-chain == that owner
// Then writes config to R2.
// =====================================================================
import { verifyMessage, isAddress, getAddress } from 'viem';

const CONFIG_REPLAY_WINDOW_MS = 5 * 60 * 1000;     // 5 min
const CONFIG_MAX_BYTES = 256 * 1024;               // 256 KiB ceiling on body
const CONFIG_MAX_COLLECTIONS = 1024;
const CONFIG_MAX_TOKENS      = 4096;

const CONFIG_SIWE_RE = /^Configure Dustopia #(\d+)\nOwner: (0x[0-9a-fA-F]{40})\nTimestamp: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\nNonce: ([0-9a-fA-F]{8,64})$/;

function configKey(tokenId) { return `config/${tokenId}.json`; }

// Returns { tokenId, owner, timestamp, nonce } or null if message is malformed.
function parseSiweMessage(msg) {
  if (typeof msg !== 'string' || msg.length > 1024) return null;
  const m = msg.match(CONFIG_SIWE_RE);
  if (!m) return null;
  const ts = Date.parse(m[3]);
  if (!Number.isFinite(ts)) return null;
  return { tokenId: m[1], owner: m[2].toLowerCase(), timestamp: ts, nonce: m[4] };
}

// Validates the user-submitted selection blob. Returns the cleaned shape on
// success (drops unknown fields, lowercases addresses) or null on any
// structural problem.
function sanitizeSelection(sel) {
  if (!sel || typeof sel !== 'object') return null;
  if (sel.mode !== 'all' && sel.mode !== 'subset') return null;
  if (sel.mode === 'all') {
    return { mode: 'all', collections: [], tokens: [] };
  }
  // subset: validate collections + tokens arrays
  const cols = Array.isArray(sel.collections) ? sel.collections : [];
  const tks  = Array.isArray(sel.tokens)      ? sel.tokens      : [];
  if (cols.length > CONFIG_MAX_COLLECTIONS) return null;
  if (tks.length  > CONFIG_MAX_TOKENS)      return null;
  const collections = [];
  for (const c of cols) {
    if (typeof c !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c)) return null;
    collections.push(c.toLowerCase());
  }
  const tokens = [];
  for (const t of tks) {
    if (!t || typeof t !== 'object') return null;
    if (typeof t.contract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.contract)) return null;
    if (typeof t.tokenId !== 'string'  || !/^\d+$/.test(t.tokenId) || t.tokenId.length > 78) return null;
    tokens.push({ contract: t.contract.toLowerCase(), tokenId: t.tokenId });
  }
  return { mode: 'subset', collections, tokens };
}

async function handleConfigGet(tokenId, request, env) {
  const obj = await env.ATLAS.get(configKey(tokenId));
  if (!obj) {
    // Default config = render full wallet. Returned with 200 so the frontend
    // doesn't have to special-case 404 — a missing config and a saved
    // mode:"all" config behave identically.
    return jsonResponse({ tokenId: Number(tokenId), selection: { mode: 'all', collections: [], tokens: [] } }, request, {
      headers: { 'Cache-Control': 'public, max-age=30' },
    });
  }
  let body;
  try { body = await obj.text(); }
  catch { return errorResponse(500, 'config read failed', request); }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      ...corsHeaders(request),
      'Cache-Control':               'public, max-age=30',
    },
  });
}

async function handleConfigPut(tokenId, request, env) {
  // Strict body cap — config payloads are tiny (a few KB at most).
  const lenHdr = request.headers.get('Content-Length');
  if (!lenHdr) return errorResponse(411, 'Content-Length required', request);
  const len = parseInt(lenHdr, 10);
  if (!Number.isFinite(len) || len < 0) return errorResponse(400, 'invalid Content-Length', request);
  if (len > CONFIG_MAX_BYTES) return errorResponse(413, `body too large (${len} > ${CONFIG_MAX_BYTES})`, request);
  if (len === 0) return errorResponse(400, 'empty body', request);

  let payload;
  try { payload = await request.json(); }
  catch { return errorResponse(400, 'body is not valid JSON', request); }
  if (!payload || typeof payload !== 'object') return errorResponse(400, 'body must be a JSON object', request);
  const { config, message, signature } = payload;
  if (!config || typeof message !== 'string' || typeof signature !== 'string') {
    return errorResponse(400, 'missing config / message / signature', request);
  }
  if (!/^0x[0-9a-fA-F]{130,132}$/.test(signature)) {
    return errorResponse(400, 'malformed signature', request);
  }

  // 1. Parse the SIWE message and verify its claims line up with the request.
  const parsed = parseSiweMessage(message);
  if (!parsed) return errorResponse(400, 'malformed message', request);
  if (parsed.tokenId !== tokenId) return errorResponse(400, 'message tokenId mismatch', request);
  const ageMs = Date.now() - parsed.timestamp;
  if (ageMs < -60_000 || ageMs > CONFIG_REPLAY_WINDOW_MS) {
    return errorResponse(401, 'message timestamp outside replay window', request);
  }

  // 2. Verify the signature actually came from `parsed.owner`.
  let okSig;
  try {
    okSig = await verifyMessage({ address: getAddress(parsed.owner), message, signature });
  } catch {
    return errorResponse(401, 'signature verification failed', request);
  }
  if (!okSig) return errorResponse(401, 'signature does not match owner', request);

  // 3. Verify the signer is the *current* owner on-chain. Don't trust the
  //    cached owner lookup — go straight to source. (lookupOwner uses 5min
  //    KV cache which would let a recently-sold-from owner re-sign here.)
  //    We do it inline rather than calling lookupOwner so the result isn't
  //    cached against future PUTs from the new owner.
  const currentOwner = await fetchOwnerFresh(tokenId, env);
  if (!currentOwner) return errorResponse(502, 'could not verify on-chain owner', request);
  if (currentOwner !== parsed.owner) {
    return errorResponse(403, 'signer is not the current owner', request);
  }

  // 4. Sanitize the selection blob. Caps array sizes, lowercases addresses.
  const cleanSelection = sanitizeSelection(config.selection);
  if (!cleanSelection) return errorResponse(400, 'invalid selection shape', request);

  const stored = {
    tokenId:     Number(tokenId),
    ownerAtSave: parsed.owner,
    savedAt:     Math.floor(Date.now() / 1000),
    selection:   cleanSelection,
  };
  await env.ATLAS.put(configKey(tokenId), JSON.stringify(stored), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return jsonResponse({ ok: true, savedAt: stored.savedAt }, request);
}

async function handleConfig(rawTokenId, request, env, ctx) {
  const tokenId = String(rawTokenId).replace(/\.json$/i, '');
  if (!/^\d+$/.test(tokenId) || tokenId.length > 78) {
    return errorResponse(400, 'invalid token id', request);
  }
  if (request.method === 'GET')    return handleConfigGet(tokenId, request, env);
  if (request.method === 'PUT')    return handleConfigPut(tokenId, request, env);
  if (request.method === 'DELETE') {
    // Internal-only via webhook; reject direct calls to avoid griefing.
    return errorResponse(405, 'use /api/webhook/transfer', request);
  }
  return errorResponse(405, 'method not allowed', request);
}

// Bypass the OWNER_TTL KV cache so the verification step in PUT can't be
// fooled by stale ownership. Same encoding as lookupOwner but no cache R/W.
async function fetchOwnerFresh(tokenId, env) {
  const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
  const data = '0x6352211e' + paddedId;
  const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
  let json;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ALCH_TIMEOUT_MS);
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
                                params: [{ to: NFT_CONTRACT, data }, 'latest'] }),
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    json = await r.json();
  } catch { return null; }
  if (json.error || !json.result || json.result === '0x') return null;
  if (typeof json.result !== 'string' || json.result.length < 66) return null;
  const owner = ('0x' + json.result.slice(-40)).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner) || owner === '0x' + '00'.repeat(20)) return null;
  return owner;
}

// =====================================================================
// ALCHEMY WEBHOOK — receives Transfer events from our NFT contract and
// wipes the per-token config so the new owner doesn't inherit the old
// owner's selection. Authenticated by HMAC-SHA256 over the raw body using
// the signing key Alchemy gives us at webhook creation time. Stored as a
// Worker secret WEBHOOK_SECRET (set via `wrangler secret put`).
// =====================================================================

async function verifyAlchemySignature(rawBody, signatureHex, secret) {
  if (!secret || typeof signatureHex !== 'string' || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time-ish compare.
  if (computed.length !== signatureHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signatureHex.toLowerCase().charCodeAt(i);
  }
  return diff === 0;
}

async function handleWebhookTransfer(request, env, ctx) {
  if (request.method !== 'POST') return errorResponse(405, 'method not allowed', request);
  const sigHeader = request.headers.get('X-Alchemy-Signature') || '';
  // Read body as text so we can both HMAC-verify and JSON-parse it.
  const rawBody = await request.text();
  if (rawBody.length > CONFIG_MAX_BYTES * 4) {
    return errorResponse(413, 'webhook body too large', request);
  }
  if (!env.WEBHOOK_SECRET) {
    return errorResponse(500, 'WEBHOOK_SECRET not configured', request);
  }
  const ok = await verifyAlchemySignature(rawBody, sigHeader, env.WEBHOOK_SECRET);
  if (!ok) return errorResponse(401, 'bad webhook signature', request);

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return errorResponse(400, 'webhook body is not JSON', request); }

  // Alchemy Address Activity webhook payload (v3 format) carries an array of
  // activity items under event.activity. We only care about ERC-721
  // transfers from our NFT contract — extract their tokenIds and DELETE
  // the corresponding config keys. Format may evolve; we defend by
  // checking each field's shape rather than assuming structure.
  const activities = (body && body.event && Array.isArray(body.event.activity))
    ? body.event.activity : [];
  const tokenIds = new Set();
  for (const act of activities) {
    if (!act || typeof act !== 'object') continue;
    if ((act.category || '').toLowerCase() !== 'erc721') continue;
    const contract = (act.rawContract && act.rawContract.address) || act.contractAddress || '';
    if (typeof contract !== 'string' || contract.toLowerCase() !== NFT_CONTRACT.toLowerCase()) continue;
    // Token id arrives as hex string ("0x1") in some payloads, decimal in others.
    const idRaw = act.erc721TokenId || (act.rawContract && act.rawContract.tokenId) || act.tokenId;
    if (typeof idRaw !== 'string') continue;
    let idDec;
    try {
      idDec = idRaw.startsWith('0x') ? BigInt(idRaw).toString(10) : BigInt(idRaw).toString(10);
    } catch { continue; }
    if (!/^\d+$/.test(idDec) || idDec.length > 78) continue;
    tokenIds.add(idDec);
  }
  if (!tokenIds.size) return jsonResponse({ ok: true, cleared: 0 }, request);

  const ids = [...tokenIds];
  // Fire-and-forget the deletes via waitUntil so we ack the webhook fast
  // (Alchemy retries on slow responses).
  if (ctx) {
    ctx.waitUntil(Promise.all(ids.map(id => env.ATLAS.delete(configKey(id)).catch(() => {}))));
  } else {
    await Promise.all(ids.map(id => env.ATLAS.delete(configKey(id)).catch(() => {})));
  }
  // Also clear the per-token owner KV cache so the next metadata fetch
  // sees the new owner immediately (without waiting OWNER_TTL).
  if (ctx) {
    ctx.waitUntil(Promise.all(ids.map(id =>
      env.WALLET_CACHE.delete(`owner:${NFT_CONTRACT.toLowerCase()}:${id}`).catch(() => {})
    )));
  }
  return jsonResponse({ ok: true, cleared: ids.length, tokenIds: ids }, request);
}

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Atlas cache: GET (any browser), PUT (frontend after build), DELETE
    // (refresh button / future Alchemy webhook). Routed before the global
    // method check below because it accepts non-GET methods. PUTs use the
    // tighter rate-limit bucket since each one writes R2.
    const atlasMatch = path.match(/^\/api\/atlas\/([^/]+)\/?$/);
    if (atlasMatch) {
      const bucket = (request.method === 'PUT' || request.method === 'DELETE') ? 'put' : 'general';
      if (!(await rateLimitOk(request, env, bucket))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handleAtlas(atlasMatch[1], request, env, ctx);
    }

    // Preview capture upload/serve. PUT from /embed/<addr> after the sphere
    // is captured; HEAD from /embed/<addr> to skip re-captures; GET for
    // direct testing.
    const previewCapMatch = path.match(/^\/api\/preview-cap\/([^/]+)\/?$/);
    if (previewCapMatch) {
      const bucket = (request.method === 'PUT' || request.method === 'DELETE') ? 'put' : 'general';
      if (!(await rateLimitOk(request, env, bucket))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handlePreviewCap(previewCapMatch[1], request, env, ctx);
    }

    // Per-token config: GET is public, PUT is owner-gated via signature.
    // Routed before the global GET-only check because PUT is allowed.
    const configMatch = path.match(/^\/api\/config\/([^/]+)\/?$/);
    if (configMatch) {
      const bucket = request.method === 'PUT' ? 'put' : 'general';
      if (!(await rateLimitOk(request, env, bucket))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handleConfig(configMatch[1], request, env, ctx);
    }

    // Alchemy webhook: HMAC-authed POST that fires on any Transfer event of
    // our NFT contract. We use it to wipe the per-token config so the new
    // owner never inherits the prior owner's selection. POST-only by design.
    if (path === '/api/webhook/transfer') {
      // Webhook traffic is bounded by Alchemy's retry policy and HMAC-gated,
      // so it's exempt from per-IP rate limiting (Alchemy's IP would burn
      // the bucket on a deploy that triggers a backlog).
      return handleWebhookTransfer(request, env, ctx);
    }

    if (request.method !== 'GET') {
      return errorResponse(405, 'method not allowed', request);
    }

    // Health is exempt from rate limiting so monitoring stays cheap.
    if (path === '/api/health') {
      return jsonResponse({ ok: true, ts: Date.now() }, request);
    }

    // Metadata is hit by marketplaces (often unattended bots) and must stay
    // available even under load — exempt from per-IP rate limiting. The
    // upstream cost is zero (we don't call Alchemy here yet) and downstream
    // browsers see the Cache-Control header.
    const metaMatch = path.match(/^\/api\/metadata\/([^/]+)\/?$/);
    if (metaMatch) {
      return handleMetadata(metaMatch[1], request, env);
    }

    // Preview image — animated WebP captured by visitors when available,
    // animated SVG fallback otherwise. Hit by marketplace bots; exempt from
    // per-IP rate limit and the global GET-only check has been deferred
    // below so we can still 405 non-GET on this path consistently.
    const previewMatch = path.match(/^\/api\/preview\/([^/]+)\/?$/);
    if (previewMatch) {
      if (request.method !== 'GET') return errorResponse(405, 'method not allowed', request);
      return handlePreview(previewMatch[1], request, env, ctx);
    }

    if (!(await rateLimitOk(request, env))) {
      return errorResponse(429, 'rate limit exceeded', request);
    }

    // /api/wallet/<address>
    const walletMatch = path.match(/^\/api\/wallet\/([^/]+)\/?$/);
    if (walletMatch) {
      return handleWallet(walletMatch[1], url.searchParams.get('pageKey') || '', request, env);
    }

    // /api/ens/<name>
    const ensMatch = path.match(/^\/api\/ens\/([^/]+)\/?$/);
    if (ensMatch) {
      return handleEns(decodeURIComponent(ensMatch[1]), request, env);
    }

    // /api/owned/<address> — dustopia tokenIds owned by addr
    const ownedMatch = path.match(/^\/api\/owned\/([^/]+)\/?$/);
    if (ownedMatch) {
      return handleOwned(ownedMatch[1], request, env);
    }

    return errorResponse(404, 'not found', request);
  },
};
