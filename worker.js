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

// CORS: production sites only. Direct visits (no Origin header, e.g. curl or
// the browser address bar) are also allowed so /api/health etc. stay testable.
// All other origins get null ACAO and effectively cannot read responses from JS.
const ALLOWED_ORIGINS = new Set([
  'https://dustopia.xyz',
  'https://www.dustopia.xyz',
  'https://dustopia.pages.dev',
]);
const PAGES_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.dustopia\.pages\.dev$/;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = !origin || ALLOWED_ORIGINS.has(origin) || PAGES_PREVIEW_RE.test(origin);
  return {
    'Access-Control-Allow-Origin':  allowed ? (origin || '*') : 'null',
    'Vary':                         'Origin',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    // Content-Encoding is required for gzipped atlas uploads (PUT /api/atlas/...).
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding',
    'Access-Control-Max-Age':       '86400',
  };
}

const WALLET_TTL = 30 * 60;          // 30 minutes
const ENS_TTL    = 24 * 60 * 60;     // 24 hours
const ALCH_TIMEOUT_MS = 12000;

// Rate limit: per-IP counter in KV, bucketed by minute. Eventually consistent
// (KV writes propagate within ~60s), so this is a soft deterrent against quota
// drain rather than a precise throttle. For stricter limits, layer Cloudflare's
// built-in rate-limiting rules on top.
const RATE_LIMIT_PER_MIN = 60;

async function rateLimitOk(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${ip}:${minute}`;
  const current = parseInt((await env.WALLET_CACHE.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_PER_MIN) return false;
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

async function handleWallet(address, pageKey, request, env) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return errorResponse(400, 'invalid address', request);
  }
  const cacheKey = `wallet:${address.toLowerCase()}:${pageKey || ''}`;

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

async function handleEns(name, request, env) {
  if (!/^[a-z0-9.-]{3,253}\.eth$/i.test(name)) {
    return errorResponse(400, 'invalid ENS name', request);
  }
  const cacheKey = `ens:${name.toLowerCase()}`;

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
// NFT METADATA — what marketplaces (OpenSea, kinds) call via tokenURI()
// =====================================================================
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
  // ownerOf returns address left-padded to 32 bytes. Last 20 bytes are it.
  const owner = ('0x' + json.result.slice(-40)).toLowerCase();
  // Sanity check: should be a valid hex address, not the zero address.
  if (!/^0x[0-9a-f]{40}$/.test(owner) || owner === '0x' + '00'.repeat(20)) {
    return null;
  }

  env.WALLET_CACHE.put(cacheKey, owner, { expirationTtl: OWNER_TTL }).catch(() => {});
  return owner;
}

// Animated SVG placeholder for the metadata `image` field. Marketplaces show
// this in grids / search / Twitter previews where they can't run the live
// animation_url iframe. SMIL animation (animateTransform / animate) survives
// most marketplace SVG sanitizers — we'll know within a day whether OpenSea
// preserves it. Per-token hue + rotation phase keeps each tile distinct so
// the grid reads as a curated set rather than a wall of clones.
//
// TODO: replace with a real Cloudflare Browser Rendering capture of the
// live sphere (animated WebP, ~5s loop). This SVG is a stand-in until then.
async function handlePreview(rawTokenId, request) {
  const tokenId = rawTokenId.replace(/\.(svg|png|webp)$/i, '');
  if (!/^\d+$/.test(tokenId) || tokenId.length > 78) {
    return errorResponse(400, 'invalid token id', request);
  }
  const id    = parseInt(tokenId, 10) || 0;
  const hue   = (id * 47) % 360;        // distinct base hue per token
  const phase = (id * 13) % 360;        // distinct starting rotation
  const dots  = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(deg => {
    const rad = deg * Math.PI / 180;
    const x = (Math.cos(rad) * 230).toFixed(1);
    const y = (Math.sin(rad) * 230).toFixed(1);
    const dotHue = (hue + deg) % 360;
    const begin  = (deg / 360 * 3).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="3" fill="hsl(${dotHue},70%,75%)"><animate attributeName="opacity" values="0.15;1;0.15" dur="3s" begin="${begin}s" repeatCount="indefinite"/></circle>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid meet">
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
  <text x="400" y="700" text-anchor="middle" font-family="-apple-system,Helvetica,sans-serif" font-size="24" fill="#9a9aa5" letter-spacing="0.08em">dustopia #${tokenId}</text>
  <text x="400" y="730" text-anchor="middle" font-family="-apple-system,Helvetica,sans-serif" font-size="13" fill="#55555e" letter-spacing="0.04em">live wallet portrait -- open to view</text>
</svg>`;
  return new Response(svg, {
    headers: {
      'Content-Type':                'image/svg+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // SVG content is deterministic per tokenId — cache for a day to cut
      // worker invocations to a trickle. If we change the visuals we'll
      // either DELETE the relevant cache entries or wait out the TTL.
      'Cache-Control':               'public, max-age=86400',
    },
  });
}

async function handleMetadata(rawTokenId, request, env) {
  // Some contracts append .json; strip it defensively even though our test
  // contract (ERC721A) does not.
  const tokenId = rawTokenId.replace(/\.json$/i, '');
  if (!/^\d+$/.test(tokenId) || tokenId.length > 78) {
    return errorResponse(400, 'invalid token id', request);
  }

  // Look up the current owner; fall back to the deploy wallet so transient
  // upstream failures don't blank the NFT in marketplaces.
  const owner = (await lookupOwner(tokenId, env)) || OWNER_FALLBACK;
  // animation_url → chrome-free embed view (just the sphere). external_url →
  // the landing page so the OpenSea "external link" still feels right.
  const animUrl     = `https://dustopia.xyz/embed/${owner}`;
  const externalUrl = `https://dustopia.xyz/#${owner}`;

  return metadataResponse({
    name:          `dustopia #${tokenId}`,
    description:   "Living wallet portrait -- every Ethereum address rendered as a 3D sphere of swirling NFT thumbnails. The artwork updates with the holder's collection.",
    image:         `https://api.dustopia.xyz/api/preview/${tokenId}.svg`,
    animation_url: animUrl,
    external_url:  externalUrl,
    attributes:    [
      { trait_type: 'token_id', value: Number(tokenId) },
    ],
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

function atlasKey(addr, grid, kind) {
  return `${addr.toLowerCase()}/${grid}.${kind}`;
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

async function handleAtlasGet(addr, grid, wantMeta, request, env, ctx) {
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

  const key = atlasKey(addr, grid, wantMeta ? 'json' : 'bin');
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

async function handleAtlasPut(addr, grid, wantMeta, request, env) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  const expectedCt = wantMeta ? 'application/json' : 'application/octet-stream';
  if (!ct.startsWith(expectedCt)) {
    return errorResponse(415, `expected ${expectedCt}`, request);
  }
  // The frontend may gzip the binary before upload to cut R2 bandwidth in
  // half; meta is too small to bother. Track the encoding so GET serves
  // the same Content-Encoding header back and the browser auto-decompresses.
  const ce = (request.headers.get('Content-Encoding') || '').toLowerCase();
  const isGzipped = !wantMeta && (ce === 'gzip' || ce === 'deflate' || ce === 'br');

  const max = wantMeta ? ATLAS_META_MAX : ATLAS_BIN_MAX;
  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > max) return errorResponse(413, `body too large (${len} > ${max})`, request);

  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) return errorResponse(413, 'body too large', request);
  if (!buf.byteLength) return errorResponse(400, 'empty body', request);

  // Binary sanity check: only meaningful for raw uploads. For compressed
  // uploads we trust the client's framing — corruption would cause the
  // meta count vs. binary length mismatch on read, which the frontend
  // already handles by falling through to a fresh build.
  if (!wantMeta && !isGzipped) {
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
    // before it lands in the bucket.
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(buf)); }
    catch { return errorResponse(400, 'meta is not valid JSON', request); }
    if (!meta || typeof meta.count !== 'number' || !Array.isArray(meta.lods) || !Array.isArray(meta.tokens)) {
      return errorResponse(400, 'meta missing required fields', request);
    }
    if (meta.count > ATLAS_TOKEN_LIMIT || meta.tokens.length !== meta.count) {
      return errorResponse(400, 'meta.count inconsistent', request);
    }
  }

  const httpMetadata = {
    contentType: wantMeta ? 'application/json; charset=utf-8' : 'application/octet-stream',
  };
  if (isGzipped) httpMetadata.contentEncoding = ce;

  await env.ATLAS.put(atlasKey(addr, grid, wantMeta ? 'json' : 'bin'), buf, { httpMetadata });
  return jsonResponse({ ok: true, bytes: buf.byteLength, encoded: isGzipped ? ce : null }, request);
}

async function handleAtlasDelete(addr, request, env, ctx) {
  // Wipe both grids in both kinds. Cheap because R2 deletes are individual
  // ops; only 4 keys per address. Idempotent — missing keys are no-ops.
  const keys = [];
  const cacheUrls = [];
  const origin = new URL(request.url).origin;
  for (const grid of ATLAS_GRIDS_OK) {
    keys.push(atlasKey(addr, grid, 'bin'));
    keys.push(atlasKey(addr, grid, 'json'));
    cacheUrls.push(`${origin}/api/atlas/${addr}?grid=${grid}`);
    cacheUrls.push(`${origin}/api/atlas/${addr}?grid=${grid}&meta=1`);
  }
  await Promise.all(keys.map(k => env.ATLAS.delete(k).catch(() => {})));
  // Edge cache purge — only clears this region's edge node. Other regions
  // serve stale bytes until their Cache-Control TTL expires. Acceptable for
  // a manual refresh button; if global propagation matters later we'll
  // version the URL or use the Cache Purge API.
  if (ctx) {
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
  if (request.method === 'GET') return handleAtlasGet(addr, grid, wantMeta, request, env, ctx);
  if (request.method === 'PUT') return handleAtlasPut(addr, grid, wantMeta, request, env);
  return errorResponse(405, 'method not allowed', request);
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
    // method check below because it accepts non-GET methods.
    const atlasMatch = path.match(/^\/api\/atlas\/([^/]+)\/?$/);
    if (atlasMatch) {
      if (!(await rateLimitOk(request, env))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handleAtlas(atlasMatch[1], request, env, ctx);
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

    // Preview image (SVG placeholder; eventually animated WebP from R2).
    // Same exemption from rate limit as /api/metadata: this is hit by
    // marketplace bots, must stay available, and the upstream cost is zero.
    const previewMatch = path.match(/^\/api\/preview\/([^/]+)\/?$/);
    if (previewMatch) {
      return handlePreview(previewMatch[1], request);
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

    return errorResponse(404, 'not found', request);
  },
};
