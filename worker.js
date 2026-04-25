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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

const WALLET_TTL = 30 * 60;          // 30 minutes
const ENS_TTL    = 24 * 60 * 60;     // 24 hours
const ALCH_TIMEOUT_MS = 12000;

function jsonResponse(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: message }, { status });
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

async function handleWallet(address, pageKey, env) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return errorResponse(400, 'invalid address');
  }
  const cacheKey = `wallet:${address.toLowerCase()}:${pageKey || ''}`;

  // Try KV cache first
  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(cached, { headers: { 'X-Cache': 'HIT' } });
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
    return errorResponse(502, `alchemy unreachable: ${e.message}`);
  }
  if (!r.ok) return errorResponse(r.status === 429 ? 429 : 502, `alchemy HTTP ${r.status}`);

  const body = await r.text();
  // Fire-and-forget cache write (don't block response)
  env.WALLET_CACHE.put(cacheKey, body, { expirationTtl: WALLET_TTL }).catch(() => {});

  return jsonResponse(body, { headers: { 'X-Cache': 'MISS' } });
}

async function handleEns(name, env) {
  if (!/^[a-z0-9.-]{3,253}\.eth$/i.test(name)) {
    return errorResponse(400, 'invalid ENS name');
  }
  const cacheKey = `ens:${name.toLowerCase()}`;

  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(cached, { headers: { 'X-Cache': 'HIT' } });
  }

  let r;
  try {
    r = await upstreamFetch(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(name)}`);
  } catch (e) {
    return errorResponse(502, `ens unreachable: ${e.message}`);
  }
  if (!r.ok) return errorResponse(502, `ens HTTP ${r.status}`);

  const body = await r.text();
  env.WALLET_CACHE.put(cacheKey, body, { expirationTtl: ENS_TTL }).catch(() => {});

  return jsonResponse(body, { headers: { 'X-Cache': 'MISS' } });
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return errorResponse(405, 'method not allowed');
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      return jsonResponse({ ok: true, ts: Date.now() });
    }

    // /api/wallet/<address>
    const walletMatch = path.match(/^\/api\/wallet\/([^/]+)\/?$/);
    if (walletMatch) {
      return handleWallet(walletMatch[1], url.searchParams.get('pageKey') || '', env);
    }

    // /api/ens/<name>
    const ensMatch = path.match(/^\/api\/ens\/([^/]+)\/?$/);
    if (ensMatch) {
      return handleEns(decodeURIComponent(ensMatch[1]), env);
    }

    return errorResponse(404, 'not found');
  },
};
