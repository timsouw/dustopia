// =====================================================================
// dustopia API Worker
// Endpoints, bindings, cache TTLs all documented in CLAUDE.md.
// =====================================================================

// CORS allowlist: Browser direct-nav and server-to-server callers (curl,
// marketplace bots) don't send Origin — for those we omit ACAO entirely.
// Marketplace-facing endpoints (/api/metadata/, /api/preview/) override to
// `*` in their own response headers since they're reachable by anonymous bots.
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
  // No Origin = no ACAO; response arrives but JS in a foreign origin can't read it.
  return headers;
}

// Wallet listings (Alchemy getNFTsForOwner) cached for 6h. NFT holdings
// change rarely on a 30-min scale, often enough on a 24h scale (mints,
// trades). 6h is the sweet spot for protecting Alchemy's 25 req/s
// free-tier from the burst of "10 first-time visitors clicking Render
// at the same time" — each unique wallet gets fetched once per 6h,
// repeat visits hit KV instantly.
const WALLET_TTL = 6 * 60 * 60;      // 6 hours
const ENS_TTL    = 24 * 60 * 60;     // 24 hours
const ALCH_TIMEOUT_MS = 12000;

// Rate limit: per-IP counter in KV, bucketed by minute. Eventually consistent
// (KV writes propagate within ~60s), so this is a soft deterrent against quota
// drain rather than a precise throttle. For stricter limits, layer Cloudflare's
// built-in rate-limiting rules on top.
//
// Two buckets: GENERAL for read-heavy endpoints, PUT for write endpoints
// (atlas, preview-cap, config). PUT is much tighter because every entry
// touches R2 storage.
//
// GENERAL bucket also gates Alchemy-backed routes (wallet, owned,
// metadata). At a 300-token limited edition the audience is small
// enough that abuse-grade defenses (formerly 20 req/min) just hurt UX
// when friends share a link and a bunch of tabs hit the worker at
// once. 60 req/min = ~1/sec sustained, comfortable for normal use,
// still bounded against an actual flood. Repeat hits on the same
// wallet cost zero (6h KV cache) so the Alchemy CU exposure is the
// same as before — only the per-minute burst ceiling went up.
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

async function handleWallet(address, pageKey, includeSpam, bust, request, env) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return errorResponse(400, 'invalid address', request);
  }
  if (pageKey && !PAGE_KEY_RE.test(pageKey)) {
    return errorResponse(400, 'invalid pageKey', request);
  }
  const addrLower = address.toLowerCase();
  // Cache key includes the spam-mode so the configurator's "show
  // everything" call doesn't poison the renderer's clean default cache
  // (and vice-versa). Without this, whichever request landed first
  // would set the cache and the other would silently get the wrong shape.
  const cacheKey = `wallet:${addrLower}:${pageKey || ''}:${includeSpam ? 'all' : 'clean'}`;

  // Try KV cache first — unless the caller asked for a fresh fetch.
  // /configure's "Refresh sphere" sets ?bust=1 so a newly-bought NFT
  // isn't masked by the WALLET_TTL on-disk cache.
  if (!bust) {
    const cached = await env.WALLET_CACHE.get(cacheKey);
    if (cached) {
      return jsonResponse(cached, request, { headers: { 'X-Cache': 'HIT' } });
    }
  }

  // Cache miss → upstream
  const u = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_KEY}/getNFTsForOwner`);
  u.searchParams.set('owner', address);
  u.searchParams.set('pageSize', '100');
  u.searchParams.set('withMetadata', 'true');
  // Default behaviour drops Alchemy-flagged spam (good for the renderer's
  // default "show all" mode). The configurator passes ?spam=include so
  // holders can pick from EVERYTHING they own — false-positives on real
  // collections (CryptoPunks, Punks v1, etc.) used to silently disappear.
  if (!includeSpam) u.searchParams.set('excludeFilters[]', 'SPAM');
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
const OWNED_TTL = 6 * 60 * 60;    // 6h — bounds the staleness window for ownership changes. /configure's "Refresh sphere" sends ?bust=1 for the impatient case.

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

// =====================================================================
// /api/all-tokens — enumerate every minted token + its current owner +
// (when available) the owner's sphere stats. Used by /gallery and
// /leaderboard. KV-cached briefly because totalSupply rarely changes
// and per-token owner lookups are themselves cached.
//
// The endpoint walks 1..totalSupply, calls the existing lookupOwner()
// helper (which is itself KV-backed), and pulls per-owner stats from
// readOwnerSummary() (which reads cached atlas meta from R2). Owners
// who haven't rendered their sphere yet show up with null stats —
// frontend renders gracefully.
//
// Cache TTL is short (5 min) so the leaderboard / gallery feel fresh
// when transfers happen, but long enough that bursts don't fan-out.
// =====================================================================
const ALL_TOKENS_TTL          = 30 * 60;    // 30 min — recomputed only when the supply count changes; mint events would need to be wired up to invalidate sooner if instant gallery refresh ever matters
const ALL_TOKENS_HARD_CAP     = 2000;       // safety cap on enumeration
const ALL_TOKENS_CONCURRENCY  = 25;         // owner-lookup parallelism
const TOTAL_SUPPLY_TTL        = 5 * 60;     // 5 min — totalSupply only ticks when a token mints; no need to fetch every minute

async function fetchTotalSupply(env) {
  const cacheKey = `totalsupply:${NFT_CONTRACT.toLowerCase()}`;
  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    const n = Number(cached);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // ABI: totalSupply() — selector 0x18160ddd, no args.
  const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
  let json;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ALCH_TIMEOUT_MS);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: NFT_CONTRACT, data: '0x18160ddd' }, 'latest'],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return 0;
    json = await r.json();
  } catch { return 0; }
  if (json.error || !json.result || json.result === '0x') return 0;
  let n;
  try { n = Number(BigInt(json.result)); }
  catch { return 0; }
  if (!Number.isFinite(n) || n < 0) return 0;
  env.WALLET_CACHE.put(cacheKey, String(n), { expirationTtl: TOTAL_SUPPLY_TTL }).catch(() => {});
  return n;
}

async function handleAllTokens(request, env, ctx) {
  const cacheKey = `all-tokens:v1`;
  const cached = await env.WALLET_CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(cached, request, { headers: { 'X-Cache': 'HIT' } });
  }

  const totalSupply = await fetchTotalSupply(env);
  const enumerateUpTo = Math.min(totalSupply, ALL_TOKENS_HARD_CAP);
  const ids = Array.from({ length: enumerateUpTo }, (_, i) => i + 1);

  // Parallel owner lookups in chunks to respect Alchemy's free-tier
  // 25 req/s burst limit.
  const owners = new Array(ids.length);
  for (let off = 0; off < ids.length; off += ALL_TOKENS_CONCURRENCY) {
    const slice = ids.slice(off, off + ALL_TOKENS_CONCURRENCY);
    const results = await Promise.all(slice.map(id => lookupOwner(String(id), env)));
    for (let i = 0; i < results.length; i++) owners[off + i] = results[i];
  }

  // Owner summaries: only one R2 call per UNIQUE owner (multi-token
  // holders share the same atlas meta).
  const uniqueOwners = [...new Set(owners.filter(Boolean))];
  const summaryEntries = await Promise.all(
    uniqueOwners.map(async (o) => [o, await readOwnerSummary(o, env)])
  );
  const summaryByOwner = new Map(summaryEntries);

  const tokens = [];
  for (let i = 0; i < ids.length; i++) {
    const owner = owners[i];
    if (!owner) continue;
    const s = summaryByOwner.get(owner);
    tokens.push({
      tokenId:     ids[i],
      owner,
      tokens:      s ? s.tokens      : null,
      collections: s ? s.collections : null,
    });
  }

  const body = JSON.stringify({
    totalSupply,
    returned: tokens.length,
    tokens,
  });
  if (ctx) ctx.waitUntil(
    env.WALLET_CACHE.put(cacheKey, body, { expirationTtl: ALL_TOKENS_TTL })
                    .catch(() => {})
  );
  return jsonResponse(body, request, {
    headers: {
      'X-Cache':       'MISS',
      'Cache-Control': `public, max-age=${ALL_TOKENS_TTL}`,
    },
  });
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

// Dustopia ERC-721 on Ethereum mainnet. When/if we add a testnet contract
// too, this becomes a chain → address map.
const NFT_CONTRACT   = '0xFc2c97FFE6a6B85e3a0eaf15Aa395d1A6DcC1DFb';
// Resilience anchor: the deploy wallet. Used when Alchemy can't tell us who
// currently owns a token (network blip, key rotation race, etc.).
const OWNER_FALLBACK = '0x014c2b84bce4f4ec280c8d91d9f6a9eb46063daf';
const OWNER_TTL      = 24 * 60 * 60;  // 24h KV TTL — handleConfigPut invalidates the entry when the owner saves a new selection; otherwise we re-resolve once a day. OpenSea / marketplace polling no longer eats KV writes.
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
// Static SVG fallback served when no captured WebP exists in R2 yet
// (or for unminted tokens). Style matches our brand: streaked sphere
// over dark bg, with token-specific procedural variation so a cold
// gallery still reads as 300 distinct items, not 300 placeholders.
//
// Drops the previous SMIL animations — Safari (iOS especially) silently
// fails to render <animate>/<animateTransform> when the SVG is loaded
// directly into an <img>, which is exactly how OpenSea + our own
// gallery use it. Static is universally rendered.
function previewSvg(tokenId, summary, ownerShort) {
  const id     = parseInt(tokenId, 10) || 0;
  const hue    = (id * 47) % 360;
  // Streak count + per-streak rotation/oblateness derived from id so
  // every token has a fingerprint. 3..6 streaks; below 3 the sphere
  // looks naked, above 6 it gets too busy at thumbnail size.
  const nStreaks = 3 + (Math.abs(id * 7)  % 4);
  const streaks = [];
  for (let i = 0; i < nStreaks; i++) {
    const angle    = (id * 17 + i * 53) % 360;
    const ry       = 20 + (Math.abs(id * 13 + i * 11) % 110);   // 20..130
    const opacity  = (i % 2 === 0) ? 0.62 : 0.35;
    const stroke   = (i % 2 === 0) ? 3.2  : 1.8;
    streaks.push(
      `<ellipse cx="0" cy="0" rx="200" ry="${ry}" stroke-opacity="${opacity}" stroke-width="${stroke}" transform="rotate(${angle})"/>`
    );
  }
  // Subtitle: stats if known, otherwise the brand line.
  const subtitle = (summary && typeof summary.tokens === 'number' && typeof summary.collections === 'number')
    ? `${summary.tokens.toLocaleString('en-US')} NFTs · ${summary.collections} collections`
    : 'living wallet portrait';
  const ownerLine = (typeof ownerShort === 'string' && ownerShort)
    ? ownerShort
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="g${id}" cx="38%" cy="32%" r="68%">
      <stop offset="0%"   stop-color="hsl(${hue},85%,92%)"/>
      <stop offset="32%"  stop-color="hsl(${(hue + 30) % 360},70%,72%)"/>
      <stop offset="65%"  stop-color="hsl(${(hue + 60) % 360},60%,42%)"/>
      <stop offset="100%" stop-color="#0a0a14"/>
    </radialGradient>
    <clipPath id="c${id}"><circle cx="400" cy="380" r="200"/></clipPath>
  </defs>
  <rect width="800" height="800" fill="#14141a"/>
  <text x="60" y="76" font-family="-apple-system,Helvetica,sans-serif" font-size="13" letter-spacing="0.22em" fill="#9a9aa5">DUSTOPIA</text>
  <circle cx="400" cy="380" r="200" fill="url(#g${id})"/>
  <g clip-path="url(#c${id})" transform="translate(400 380)" fill="none" stroke="#ffffff" stroke-linecap="round">
    ${streaks.join('\n    ')}
  </g>
  <text x="60" y="700" font-family="-apple-system,Helvetica,sans-serif" font-size="44" font-weight="500" fill="#fafafa" letter-spacing="-0.015em">Dustopia #${tokenId}</text>
  <text x="60" y="730" font-family="-apple-system,Helvetica,sans-serif" font-size="15" fill="#9a9aa5" letter-spacing="0.02em">${subtitle}</text>
  ${ownerLine ? `<text x="60" y="755" font-family="ui-monospace,Menlo,monospace" font-size="13" fill="#55555e" letter-spacing="0.04em">${ownerLine}</text>` : ''}
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
      // 5 min TTL — short enough that a holder's "Save" in /configure
      // propagates fast to the landing + marketplace caches. We also
      // explicitly purge the edge cache on save, so 5 min is just the
      // floor for downstream caches we don't control.
      'Cache-Control':               'public, max-age=300',
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

  // No captured preview yet — serve the procedural SVG so marketplace
  // grids show a per-token fingerprint (different streaks + hue per id)
  // plus a wallet stats line if we have an atlas-meta cached for the
  // current owner. We deliberately DO NOT edge-cache this response:
  // holders saving a new selection delete preview/<addr>.bin and rely
  // on the next /embed visit re-uploading. If we cached the SVG here
  // that fresh upload would be shadowed until max-age expired.
  const summary = await readOwnerSummary(owner, env).catch(() => null);
  const ownerShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
  const svg = previewSvg(tokenId, summary, ownerShort);
  return new Response(svg, {
    headers: {
      'Content-Type':                'image/svg+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=60',
      'X-Edge-Cache':                'BYPASS',
    },
  });
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
// Invalidation: /configure's "Refresh sphere" reloads the embed iframe with
// ?fresh=1, which sends ?bust=1 to the wallet endpoint. The atlas itself
// is keyed by (addr, grid, selection-fingerprint), so a different selection
// just writes a new R2 entry rather than overwriting the previous one.
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

async function handleAtlasPut(addr, grid, wantMeta, fp, request, env, ctx) {
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

  // When the meta JSON for this (addr, fp) lands, kick off a server-side
  // bake in the background — by the time anyone GETs /api/loop/<addr> the
  // blob is ready. No-op if the loop already exists. Best-effort: failures
  // are swallowed because the browser-side recording is still a fallback.
  if (wantMeta && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(bakeAndStore(addr, fp, env).catch(() => {}));
  }

  return jsonResponse({ ok: true, bytes: buf.byteLength, encoded: isGzipped ? ce : null }, request);
}

async function handleAtlas(addr, request, env, ctx) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
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
  if (request.method === 'PUT') return handleAtlasPut(addr, grid, wantMeta, fpRaw, request, env, ctx);
  return errorResponse(405, 'method not allowed', request);
}

// =====================================================================
// LOOP CACHE — pre-recorded 30 s of flocking simulation, stored as a
// quantized Int16 binary in R2. The frontend records the live physics
// once, uploads, and from then on every visitor (and every iframe in the
// gallery / pfp feed) downloads the same buffer and plays it back without
// running any physics. Removes the per-visitor CPU cost that made the
// live render unviable on weak devices.
//
// Key shape: loop/<addr_lower>/<fp>.bin
//   fp is the same selection fingerprint used for the atlas key, so a
//   different selection lives at a different key. Old loops for previous
//   selections are orphaned but harmless — bounded by LOOP_PER_ADDR_CAP.
//
// Wire format (frame-major, little-endian):
//   16-byte header:
//     [0..3]   magic 'DSTL'
//     [4]      version u8 = 1
//     [5]      flags u8 (reserved)
//     [6..7]   frames u16  (e.g. 900)
//     [8..9]   tokens u16  (matches meta.count)
//     [10..13] posScale f32 (dequant: pos = q / posScale)
//     [14..15] fwdScale u16-as-bits — actually written as the next 6 bytes
//   ...layout finalised by the frontend; worker treats payload as opaque.
//   The worker just enforces size caps + Content-Type + optional gzip.
//
// Upload may be Content-Encoding: gzip; we forward as-is so the browser
// decompresses transparently on GET (mirrors the atlas path).
// =====================================================================
const LOOP_BIN_MAX        = 16 * 1024 * 1024;  // 16 MiB ceiling — covers v2 (LOOP_FPS=60, LOOP_FRAMES=1800) at N=512: ~11 MB raw, ~4 MB gzipped, plenty of headroom
const LOOP_PER_ADDR_CAP   = 16;                // distinct selections per address before we 429 the PUT
const LOOP_FP_RE          = /^[a-z0-9]{16}$/;
const LOOP_CACHE_CONTROL  = 'public, max-age=31536000, immutable';

function loopKey(addr, fp) {
  const a = addr.toLowerCase();
  return fp === 'all' ? `loop/${a}/all.bin` : `loop/${a}/${fp}.bin`;
}

async function handleLoopGet(addr, fp, request, env) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set('X-Edge-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers: h });
  }

  const obj = await env.ATLAS.get(loopKey(addr, fp));
  if (!obj) return errorResponse(404, 'loop not cached', request);

  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               LOOP_CACHE_CONTROL,
    'X-Edge-Cache':                'MISS',
  });
  obj.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  return new Response(obj.body, { headers });
}

async function handleLoopHead(addr, fp, request, env) {
  const head = await env.ATLAS.head(loopKey(addr, fp));
  if (!head) return errorResponse(404, 'loop not cached', request);
  const ct = (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream';
  return new Response(null, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      'Content-Type':   ct,
      'Content-Length': String(head.size),
    },
  });
}

async function handleLoopPut(addr, fp, request, env) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
  if (ct !== 'application/octet-stream') {
    return errorResponse(415, 'expected application/octet-stream', request);
  }
  const lenHdr = request.headers.get('Content-Length');
  if (!lenHdr) return errorResponse(411, 'Content-Length required', request);
  const len = parseInt(lenHdr, 10);
  if (!Number.isFinite(len) || len <= 0) return errorResponse(400, 'invalid Content-Length', request);
  if (len > LOOP_BIN_MAX) return errorResponse(413, `body too large (${len} > ${LOOP_BIN_MAX})`, request);

  const buf = await request.arrayBuffer();
  if (buf.byteLength !== len) return errorResponse(400, 'body length mismatch', request);

  // Per-address cap so a malicious client can't fill R2 with thousands of
  // bogus selections. Atlas has the same shape (ATLAS_PER_ADDR_CAP).
  const list = await env.ATLAS.list({
    prefix: `loop/${addr.toLowerCase()}/`,
    limit:  LOOP_PER_ADDR_CAP + 1,
  }).catch(() => null);
  if (list && list.objects.length >= LOOP_PER_ADDR_CAP) {
    const targetKey = loopKey(addr, fp);
    const exists    = list.objects.some(o => o.key === targetKey);
    if (!exists) return errorResponse(429, `loop cache cap reached (${LOOP_PER_ADDR_CAP} entries per address)`, request);
  }

  // Content-Encoding: gzip is fine — frontend may compress before PUT to
  // save bandwidth. We persist the encoding metadata so GET returns the
  // gzipped bytes and the browser auto-decompresses.
  const ce = (request.headers.get('Content-Encoding') || '').toLowerCase().trim();
  const httpMetadata = { contentType: 'application/octet-stream' };
  if (ce === 'gzip') httpMetadata.contentEncoding = 'gzip';

  await env.ATLAS.put(loopKey(addr, fp), buf, { httpMetadata });
  return jsonResponse({ ok: true, bytes: buf.byteLength, encoded: ce === 'gzip' ? 'gzip' : null }, request);
}

async function handleLoop(addr, request, env, ctx) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
  }
  const url = new URL(request.url);
  const fp  = url.searchParams.get('fp') || 'all';
  if (fp !== 'all' && !LOOP_FP_RE.test(fp)) {
    return errorResponse(400, 'invalid fp', request);
  }
  if (request.method === 'GET')  return handleLoopGet(addr, fp, request, env);
  if (request.method === 'HEAD') return handleLoopHead(addr, fp, request, env);
  if (request.method === 'PUT')  return handleLoopPut(addr, fp, request, env);
  return errorResponse(405, 'method not allowed', request);
}

// =====================================================================
// SERVER-SIDE BAKE — runs the flock physics deterministically on the
// worker, writes the resulting loop blob to R2 so visitors never have to
// record. Triggered by:
//   - explicit POST /api/bake/<addr>?fp=<fp>
//   - implicit ctx.waitUntil from atlas PUT (just-built atlas → bake)
//   - implicit ctx.waitUntil from /api/pfp-feed POST (feed entry added)
//
// Idempotent — early-returns when the blob already exists in R2. Reads
// atlas meta from the same key the renderer reads (so the token order +
// collection grouping matches exactly what the browser would have seen).
//
// Cost (measured locally, V8): ~70 ms for N=50, ~350 ms for N=512. Fits
// inside a synchronous request, but we still prefer waitUntil where the
// caller doesn't need the result.
// =====================================================================
async function readAtlasMetaForBake(addr, fp, env) {
  const a = addr.toLowerCase();
  // Try the same fp first; fall back to the legacy 'all' meta when the
  // selection-specific one is missing (selection often = full wallet).
  const candidates = [];
  if (fp && fp !== 'all') candidates.push(`${a}/192-${fp}.json`);
  candidates.push(`${a}/192.json`);
  candidates.push(`${a}/128-${fp}.json`);
  candidates.push(`${a}/128.json`);
  for (const key of candidates) {
    const obj = await env.ATLAS.get(key).catch(() => null);
    if (!obj) continue;
    let meta;
    try { meta = await obj.json(); } catch { continue; }
    if (meta && Array.isArray(meta.tokens) && meta.tokens.length > 0) return meta;
  }
  return null;
}

async function gzipBytes(u8) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([u8]).stream().pipeThrough(cs);
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

// runs the actual bake. Returns { ok, reason, bytes? }.
// Force=true skips the existence check (used to overwrite a stale entry).
async function bakeAndStore(addr, fp, env, { force = false } = {}) {
  const key = loopKey(addr, fp);
  if (!force) {
    // Read first 5 bytes of the existing blob (R2 supports range reads)
    // to verify the on-disk version matches our current LOOP_VERSION. If
    // not, treat it as missing and re-bake. This auto-invalidates blobs
    // baked by a previous version of physics.js without needing a manual
    // R2 wipe — frontend GETs old blob → decode-rejects → POSTs bake →
    // version mismatch → re-bakes with current code.
    const obj = await env.ATLAS.get(key, { range: { offset: 0, length: 5 } }).catch(() => null);
    if (obj) {
      try {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        if (bytes.length >= 5) {
          const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const magic = dv.getUint32(0, true);
          const ver   = dv.getUint8(4);
          if (magic === LOOP_MAGIC && ver === LOOP_VERSION) {
            const head = await env.ATLAS.head(key).catch(() => null);
            return { ok: true, reason: 'exists', bytes: head ? head.size : null };
          }
        }
      } catch { /* fall through to re-bake */ }
    }
  }
  const meta = await readAtlasMetaForBake(addr, fp, env);
  if (!meta) return { ok: false, reason: 'no atlas meta — atlas must be uploaded first' };

  // Per-address quota — same shape as handleLoopPut, applied here too so
  // a malicious flood of /api/bake calls can't overshoot the cap.
  const list = await env.ATLAS.list({
    prefix: `loop/${addr.toLowerCase()}/`,
    limit:  LOOP_PER_ADDR_CAP + 1,
  }).catch(() => null);
  if (list && list.objects.length >= LOOP_PER_ADDR_CAP) {
    const exists = list.objects.some(o => o.key === key);
    if (!exists) return { ok: false, reason: `loop cache cap reached (${LOOP_PER_ADDR_CAP} per address)` };
  }

  const result = runBake(addr, meta.tokens);
  const raw    = encodeLoopBlob(result);
  const gz     = await gzipBytes(raw);
  const httpMetadata = { contentType: 'application/octet-stream' };
  let body = raw;
  if (gz && gz.byteLength < raw.byteLength) {
    body = gz;
    httpMetadata.contentEncoding = 'gzip';
  }
  if (body.byteLength > LOOP_BIN_MAX) {
    return { ok: false, reason: `bake produced ${body.byteLength} bytes, over LOOP_BIN_MAX` };
  }
  await env.ATLAS.put(key, body, { httpMetadata });
  return { ok: true, reason: 'baked', bytes: body.byteLength };
}

async function handleBake(addr, request, env, ctx) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
  }
  if (request.method !== 'POST') return errorResponse(405, 'method not allowed', request);
  const url = new URL(request.url);
  const fp  = url.searchParams.get('fp') || 'all';
  if (fp !== 'all' && !LOOP_FP_RE.test(fp)) {
    return errorResponse(400, 'invalid fp', request);
  }
  const force = url.searchParams.get('force') === '1';
  const result = await bakeAndStore(addr, fp, env, { force });
  const status = result.ok ? 200 : 409;
  return jsonResponse(result, request, { status });
}

// =====================================================================
// PER-TOKEN CONFIG — stored in R2 under config/<tokenId>.json. Owner-gated
// PUT (verified via EIP-191 personal_sign) lets the holder pick which of
// their NFTs go into the sphere; without a config the renderer falls back
// to "show everything in the wallet".
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
import { runBake, encodeLoopBlob, LOOP_MAGIC, LOOP_VERSION } from './physics.js';

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

async function handleConfigPut(tokenId, request, env, ctx) {
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

  // Stale-preview invalidation. The owner's previous preview-cap WebP no
  // longer reflects what the sphere will render with the new selection,
  // so wipe the R2 entry AND the edge-cache copy of /api/preview/<id>.
  // Both are best-effort — if a delete fails the worst case is OpenSea
  // sees a stale frame for up to 1 hour (Cache-Control max-age) until
  // the next /embed visitor seeds a fresh capture.
  if (ctx) {
    const previewKey = `preview/${parsed.owner}.bin`;
    const previewUrl = new URL(request.url);
    previewUrl.pathname = `/api/preview/${tokenId}`;
    previewUrl.search = '';
    ctx.waitUntil((async () => {
      await env.ATLAS.delete(previewKey).catch(() => {});
      await caches.default.delete(new Request(previewUrl.toString())).catch(() => {});
    })());
  }

  return jsonResponse({ ok: true, savedAt: stored.savedAt }, request);
}

async function handleConfig(rawTokenId, request, env, ctx) {
  const tokenId = String(rawTokenId).replace(/\.json$/i, '');
  if (!/^\d+$/.test(tokenId) || tokenId.length > 78) {
    return errorResponse(400, 'invalid token id', request);
  }
  if (request.method === 'GET')    return handleConfigGet(tokenId, request, env);
  if (request.method === 'PUT')    return handleConfigPut(tokenId, request, env, ctx);
  return errorResponse(405, 'method not allowed', request);
}

// =====================================================================
// PFP FEED — the /pfp page logs every successfully-rendered address
// into a public, append-only feed so newcomers see "real people are
// using this". Pre-mint, this is also the cheapest demand-signal we
// have: a long feed = visible interest, even before any token exists
// on chain.
//
// Single KV blob (`pfp-feed:recent`), JSON array, capped at 50, dedup
// by address (most-recent-wins). Read-modify-write: occasional lost
// writes under heavy concurrency are acceptable — losing one entry
// out of fifty is invisible to the user. 30-day TTL keeps the feed
// "fresh" without an explicit purge job.
// =====================================================================

const FEED_KEY       = 'pfp-feed:recent';
const FEED_TOTAL_KEY = 'pfp-feed:total';
const FEED_SEEN_PFX  = 'pfp-seen:';            // pfp-seen:<addr>
const FEED_MAX       = 200;                   // visible cap on the recent list
const FEED_TTL       = 60 * 60 * 24 * 30;     // 30 days for the recent blob
const FEED_SEEN_TTL  = 60 * 60 * 24 * 365;    // 1 year for first-seen markers

async function readFeed(env) {
  const raw = await env.WALLET_CACHE.get(FEED_KEY);
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

async function readFeedTotal(env) {
  const raw = await env.WALLET_CACHE.get(FEED_TOTAL_KEY);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function handleFeedGet(request, env) {
  const [list, total] = await Promise.all([readFeed(env), readFeedTotal(env)]);
  return jsonResponse({ entries: list, total }, request);
}

async function handleFeedAdd(rawAddr, request, env, ctx) {
  const addr = String(rawAddr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return errorResponse(400, 'invalid address', request);
  }
  // First-seen check: separate KV marker per address with a 1-year
  // TTL. If no marker exists, this is a brand-new wallet — bump the
  // total counter. The visible 200-cap list is for *recent activity*
  // ("look how many people just rendered"); the total counter is the
  // bragging-rights stat ("look how many people EVER rendered").
  const seenKey = FEED_SEEN_PFX + addr;
  const alreadySeen = await env.WALLET_CACHE.get(seenKey);
  let total = await readFeedTotal(env);
  if (!alreadySeen) {
    total += 1;
    await env.WALLET_CACHE.put(seenKey, '1', { expirationTtl: FEED_SEEN_TTL });
    await env.WALLET_CACHE.put(FEED_TOTAL_KEY, String(total));
  }
  // Update visible-list (most-recent-wins dedup, capped at FEED_MAX).
  const list = await readFeed(env);
  const filtered = list.filter(e => e && e.addr !== addr);
  filtered.unshift({ addr, ts: Date.now() });
  const trimmed = filtered.slice(0, FEED_MAX);
  await env.WALLET_CACHE.put(FEED_KEY, JSON.stringify(trimmed), {
    expirationTtl: FEED_TTL,
  });

  // Pre-warm the loop cache for this address so the iframe in the feed
  // hits playback immediately. No-op if a loop already exists, and won't
  // run if there's no atlas meta yet (caller will retry once their atlas
  // upload finishes — handleAtlasPut also schedules a bake).
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(bakeAndStore(addr, 'all', env).catch(() => {}));
  }

  return jsonResponse({ ok: true, count: trimmed.length, total }, request);
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


export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Atlas cache: GET (any browser) or PUT (frontend after build). Routed
    // before the global method check below because it accepts non-GET.
    // PUTs use the tighter rate-limit bucket since each one writes R2.
    const atlasMatch = path.match(/^\/api\/atlas\/([^/]+)\/?$/);
    if (atlasMatch) {
      const bucket = request.method === 'PUT' ? 'put' : 'general';
      if (!(await rateLimitOk(request, env, bucket))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handleAtlas(atlasMatch[1], request, env, ctx);
    }

    // Loop cache: pre-recorded flocking buffer. Same shape as atlas — GET
    // is hot (every visitor + every gallery iframe), PUT is cold (server-
    // side bake or, as a fallback, browser-side recording).
    const loopMatch = path.match(/^\/api\/loop\/([^/]+)\/?$/);
    if (loopMatch) {
      const bucket = request.method === 'PUT' ? 'put' : 'general';
      if (!(await rateLimitOk(request, env, bucket))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handleLoop(loopMatch[1], request, env, ctx);
    }

    // Server-side bake: runs flock physics on the worker, writes a loop
    // blob to R2. POST-only; idempotent (no-op if blob already exists).
    const bakeMatch = path.match(/^\/api\/bake\/([^/]+)\/?$/);
    if (bakeMatch) {
      if (!(await rateLimitOk(request, env, 'put'))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      return handleBake(bakeMatch[1], request, env, ctx);
    }

    // Preview capture upload/serve. PUT from /embed/<addr> after the sphere
    // is captured; HEAD from /embed/<addr> to skip re-captures; GET for
    // direct testing.
    const previewCapMatch = path.match(/^\/api\/preview-cap\/([^/]+)\/?$/);
    if (previewCapMatch) {
      const bucket = request.method === 'PUT' ? 'put' : 'general';
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

    // PFP feed: GET (public list) or POST /api/pfp-feed/<addr> (append).
    // Routed before the GET-only gate because POST is allowed.
    if (path === '/api/pfp-feed' || path === '/api/pfp-feed/') {
      if (!(await rateLimitOk(request, env))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      if (request.method !== 'GET') return errorResponse(405, 'method not allowed', request);
      return handleFeedGet(request, env);
    }
    const feedAddMatch = path.match(/^\/api\/pfp-feed\/([^/]+)\/?$/);
    if (feedAddMatch) {
      const bucket = request.method === 'POST' ? 'put' : 'general';
      if (!(await rateLimitOk(request, env, bucket))) {
        return errorResponse(429, 'rate limit exceeded', request);
      }
      if (request.method !== 'POST') return errorResponse(405, 'method not allowed', request);
      return handleFeedAdd(feedAddMatch[1], request, env, ctx);
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

    // Per-IP rate limit. /api/wallet pagination continuations (those
    // carrying a pageKey from a previous Alchemy response) bypass the
    // counter — a whale's wallet can be 10-15 pages and each page is
    // a separate frontend request, but they're all part of one user
    // intent. Only the FIRST page (no pageKey) counts. Attackers
    // can't fake a pageKey because Alchemy issues opaque ones; an
    // invalid one returns 400 from upstream without burning quota.
    const isPaginatedWallet = path.startsWith('/api/wallet/')
                           && url.searchParams.get('pageKey');
    if (!isPaginatedWallet && !(await rateLimitOk(request, env))) {
      return errorResponse(429, 'rate limit exceeded', request);
    }

    // /api/wallet/<address>
    const walletMatch = path.match(/^\/api\/wallet\/([^/]+)\/?$/);
    if (walletMatch) {
      const includeSpam = url.searchParams.get('spam') === 'include';
      const bust        = url.searchParams.get('bust') === '1';
      return handleWallet(walletMatch[1], url.searchParams.get('pageKey') || '', includeSpam, bust, request, env);
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

    // /api/all-tokens — every minted tokenId + owner + sphere stats
    if (path === '/api/all-tokens') {
      return handleAllTokens(request, env, ctx);
    }

    return errorResponse(404, 'not found', request);
  },
};
