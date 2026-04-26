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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    image:         'https://dustopia.xyz/preview.png',
    animation_url: animUrl,
    external_url:  externalUrl,
    attributes:    [
      { trait_type: 'token_id', value: Number(tokenId) },
    ],
  }, request);
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'GET') {
      return errorResponse(405, 'method not allowed', request);
    }

    const url = new URL(request.url);
    const path = url.pathname;

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
