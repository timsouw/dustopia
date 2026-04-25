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
