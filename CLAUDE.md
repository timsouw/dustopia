# dustopia — context for Claude Code (and other AI assistants)

This file is the orientation doc for any new AI session working on this repo.
It is structured to be skim-readable: top sections are critical, deeper
sections explain physics constants and edit-points.

---

## TL;DR

- **What it is**: A live, browser-rendered 3D sphere of swirling NFT thumbnails
  that updates in real time based on a connected Ethereum wallet's holdings.
  Designed to be the on-chain artwork for an Open Edition NFT drop.
- **Where it lives**: <https://dustopia.xyz>
- **Backend**: Cloudflare Worker at `https://api.dustopia.xyz` (proxies Alchemy
  NFT API, hides the API key, caches in KV).
- **Tech**: WebGL2, no build step. The frontend is a **single self-contained
  `index.html`** file (~1300 lines). The Worker is `worker.js` (~150 lines).

## Repo layout

```
index.html        single-file frontend (HTML + CSS + JS + GLSL)
worker.js         Cloudflare Worker proxy
wrangler.toml     wrangler config for the Worker
README.md         user-facing project description
CLAUDE.md         this file (AI orientation)
.gitignore
```

That's it. There is no `node_modules`, no bundler, no transpiler. **Edit
`index.html` directly and reload.**

---

## Architecture

```
                        (browser)
                            │
                visit https://dustopia.xyz
                            │
                   loads index.html (HTML/JS/GLSL)
                            │
                user types ENS or 0x address
                            │
            JS calls https://api.dustopia.xyz/api/...
                            │
                  (Cloudflare Worker)
                            │
        ┌───── checks Cloudflare KV cache ─────┐
        │ HIT (50ms)                  MISS     │
        │                                ↓     │
        │                       Alchemy NFT v3 │
        │                       api.ensideas.com (ENS)
        │                                ↓     │
        │                       store in KV    │
        └───────── return JSON ────────────────┘
                            │
                  (back to browser)
                            │
            JS fetches each NFT's thumbnail URL
              (with fallback chain: thumbnail → cached → png)
                            │
            builds 192×192 atlas in a 2D canvas
                            │
            uploads atlas + token positions to GPU
                            │
            WebGL2 POINTS renderer with custom shader
                            │
                 sphere of swirling pixels
```

## Live URLs

- **Frontend (production)**: <https://dustopia.xyz>
- **API Worker**: <https://api.dustopia.xyz/api/health> → returns `{"ok":true}`
- **Legacy frontend** (Worker static-assets): <https://withered-leaf-3b78.cryptokynata.workers.dev>
  — being replaced by Cloudflare Pages deploy from this repo
- **Legacy API URL**: <https://franken-api.cryptokynata.workers.dev> — same
  Worker as `api.dustopia.xyz`, kept working for backward compat

## Cloudflare account

- Account: `Cryptokynata@gmail.com`
- Account ID: `245c03682858d0c1200c5c577eb25da7`
- Domain: `dustopia.xyz` (registered through Cloudflare; nameservers
  `jeff.ns.cloudflare.com`, `lina.ns.cloudflare.com`)
- Workers & Pages projects: `franken-api`, `withered-leaf-3b78`
- KV namespace: `WALLET_CACHE` (id: `043aff23e1894533b81aaab958718377`)
- Worker secrets: `ALCHEMY_KEY` (Alchemy NFT API key — never commit it)

## Alchemy

- NFT API v3, Free tier (25 req/sec, 30M CU/month)
- Used endpoints: `getNFTsForOwner`
- Image fetching uses Alchemy CDN (cachedUrl/thumbnailUrl) — CORS-safe

---

## Key files in detail

### `index.html`

A single self-contained HTML file. Sections are clearly commented inside.
Roughly:

| Lines       | Section                                                       |
|-------------|---------------------------------------------------------------|
| 1–145       | HTML head + CSS                                               |
| 146–195     | Body + load panel UI + canvas                                 |
| 200–230     | Top-level constants (GRID, HISTORY_LEN, flock weights, etc.)  |
| ~240–520    | Live data pipeline: ENS, Alchemy fetch, atlas builder         |
| ~520–680    | WebGL setup: shaders, textures, init                          |
| ~680–770    | Per-collection seeding, layer assignment, big-wave data       |
| ~770–960    | Vertex shader (GLSL, embedded as JS template literal)         |
| ~960–1010   | Fragment shader                                               |
| ~1010–1200  | Per-frame uniforms, viewport, FPS HUD, theme toggle           |
| ~1200–1320  | Physics step (CPU): tangent flow, flocking, advection         |
| ~1320–1450  | Render loop, atlas upload, mouse/touch controls               |
| End         | `main()` invocation + crash guard                             |

### `worker.js`

A small Cloudflare Worker. Three endpoints:

```
GET /api/health                 → ping/health check
GET /api/wallet/<0x...>?pageKey=  → proxy to Alchemy getNFTsForOwner
GET /api/ens/<name.eth>         → proxy to ENS resolver
```

Caching:
- Wallet pages: 30-minute TTL
- ENS resolutions: 24-hour TTL

Retry logic: 3 attempts with exponential backoff (250ms → 750ms → 2.25s) on
429/500/502/503/504. 15-second AbortController timeout per attempt.

CORS: `Access-Control-Allow-Origin: *` so any origin can call the API
(currently locked to dustopia.xyz uses but no enforcement).

---

## Visual physics constants (most-tweaked)

These all live near the top of `index.html`. Tweak ranges below are good
starting points; numbers in **bold** are current production values.

### Particle density

- `GRID` = **192** — particles per token side (192² = 36,864 per token).
  Lower (96) for older GPUs; higher (256+) at your own risk.
- `LIVE_TILE` = **192** — atlas tile size in pixels. Must match `GRID`.
- `HISTORY_LEN` = **320** — frames of pos/fwd history kept (used for the
  shear/streak effect). Should be ≥ `GRID + GRID·SHEAR_FACTOR`.
- `LANE_WIDTH` = **0.32 / 192** — angular width of each token's swarm on the
  unit sphere. Keep numerator at 0.32 to match the established look.

### Sphere sizing

- `SPHERE_FACTOR` = **0.032** (halved from 0.064 for denser packing)
- `SPHERE_FRAC_MIN` = **0.20** — minimum sphere radius as fraction of viewport
- `SPHERE_FRAC_MAX` = **0.23** — max (silhouette safety)

### Layer system (depth)

- `LAYER_INNER_R` = **0.78** — inner shell radius
- `LAYER_OUTER_R` = **1.18** — outer shell radius
- Each collection oscillates between these with a per-collection phase and
  frequency (`radiusFreq` = 0.06–0.16 rad/s, ~40–105s per cycle).
- The layer cycling animation runs every frame via the bigWaveTex update.

### Flocking (Reynolds three rules)

- `FLOCK_COHESION` = **0.35** — pull tokens toward collection centroid
- `FLOCK_ALIGN`    = **0.55** — align with collection's average heading
- `SEPARATION_STRENGTH` = **0.20** — push collections apart from each other
- `SEPARATION_RADIUS`   = **1.1** — distance below which separation activates
- `FLOCK_REST_ARC` = **0.18** — no cohesion pull within this arc (~10°)

### Pole avoidance

- `POLE_THRESHOLD` = **0.65** — push starts at |y| > this (~50° from equator)
- `POLE_PUSH_MAX`  = **0.55** — max equator-bias at the pole

### Wind & waves

- `WAVE_AMPLITUDE` = **0.033** — per-token sphere-radius wave
- `BIG_WAVE_AMP`   = WAVE_AMPLITUDE × 2.6 (≈ 0.086)
- `BIG_WAVE_FREQ`  = **0.6**
- `WIND_AMP_LOW`   = **0.014** — image-coherent low-freq wind
- `WIND_AMP_HIGH`  = **0.004** — high-freq wispy jitter
- `SHEAR_FACTOR`   = **0.55** — windswept skew

### Spawn spread (low-N case)

- `SPAWN_SPREAD_TIGHT` = 0.22 — base cluster arc (used for high-N wallets)
- `SPAWN_SPREAD_BASE`  = 1.20 — extra spread added at N=1, decays exponentially
  with `exp(-N/12)`. So tiny wallets (1-10 tokens) get spread of ~1.4 rad
  (~80° of sphere) — fills the orb. Big wallets get tight 0.22 rad clusters
  so collections stay distinct.

### Depth fog

- `u_fogStrength` = **0.72** — back of sphere fades toward bg color
- `u_fogColor` — set per frame from current theme's clear color

---

## Data caching (browser-side)

The frontend has an in-memory cache (`walletCache`, `ensCache`, `atlasCache`)
keyed by lowercased input. TTL: 5 minutes. Re-clicking Load on the same wallet
within that window is instant.

There is **no** persistent cache — F5 wipes browser cache. Worker-side KV
cache survives reloads (30min TTL).

---

## Deploy flow

### Frontend

If Cloudflare Pages is connected to this repo:

```bash
git push
# Cloudflare Pages auto-builds and deploys to dustopia.xyz within ~30s
```

If not yet connected (manual upload via dashboard):

1. Drag the repo root folder onto the Worker static-assets uploader, OR
2. Set up Pages → Connect to Git → select this repo

### Worker (`worker.js`)

```bash
npx wrangler login         # one-time
npx wrangler deploy
```

The secret `ALCHEMY_KEY` was set via the dashboard; if you ever need to set it
from CLI:

```bash
echo "<key>" | npx wrangler secret put ALCHEMY_KEY
```

---

## Common edits

### Tweak a physics value
Edit the constant at top of `index.html`, `git push`, done.

### Add a new endpoint to the Worker
Add a route in the `match` block of `worker.js` (around the `/api/wallet` and
`/api/ens` checks). Re-deploy with `wrangler deploy`. Frontend can then call
the new endpoint.

### Change the visual look (colors, theme)
CSS is at the top of `index.html`, in the `<style>` block (~lines 7–145).
Light theme uses `body.light` selectors.

### Add MP4 export back
The original code lives in `franken_prototype.html` (~lines 1218–1374) — kept
in the outputs/ folder of earlier sessions but NOT in this repo. Port it by
copying the MP4 export pipeline (REC_*, MediaRecorder, captureStream) and the
recording UI button.

---

## Pending / planned

- [ ] **Per-flock drifting orbit axes** — each collection should also have its
  own slow-drifting orbit-axis (currently they share the global Y-rotation).
  Designed in earlier sessions as task #18, never implemented.
- [ ] **Manifold contract deployment** — Open Edition ERC-721 with
  `tokenURI` returning JSON whose `animation_url` is `https://dustopia.xyz/embed/<tokenId>`.
- [ ] **`/embed/<tokenId>` route on the frontend** — looks up token's owner
  via on-chain call, then loads the live sphere for that owner.
- [ ] **WebP loop generator** — server-side headless Chrome capture producing
  ~5s animated WebP for OpenSea grid previews and Twitter cards. Stored in R2.
- [ ] **Atlas pre-build service** — Worker that builds the atlas server-side
  at mint/transfer time and stores in R2, so first-time visitors don't wait
  30-60s for image fetching.

---

## Brand decisions (locked)

- **Name**: dustopia (lowercase, single word)
- **Domain**: dustopia.xyz
- **Tagline candidates**: "your wallet, in motion" / "the dust of what you own"
- **Mint platform**: Manifold (Open Edition, 7-day claim window)
- **Chain**: probably Base for cheap gas, possibly Ethereum mainnet
- **Pricing**: 0.001 ETH per mint or free with tip jar (TBD, leaning free)

---

## Things to NEVER commit

- The Alchemy API key (lives only as Worker secret `ALCHEMY_KEY`)
- Personal wallet private keys (we don't have any in this repo, but never add)
- A `.dev.vars` file with local secrets (it's gitignored)

---

## Working with this codebase as Claude Code

- The whole frontend is **one file**. Use Edit tool to make targeted changes
  rather than rewriting the file.
- After non-trivial JS edits, run a syntax check by extracting the script
  block and piping to `node --check`. Example:
  ```bash
  python3 -c "import re; s=open('index.html').read(); m=re.search(r'<script>(.*?)</script>', s, re.S); open('/tmp/check.js','w').write(m.group(1))"
  node --check /tmp/check.js
  ```
- Visual changes are best validated by the user opening the live site after
  `git push`. There's no automated visual regression — trust the user to
  describe what looks off.
- The shader is GLSL embedded as a JS template literal. `node --check` won't
  catch GLSL errors; only WebGL2 itself will (look for `gl.compileShader`
  errors in the browser console).

## Useful searches

```
GRID             = constants section, near top of index.html
function frame   = render loop
const FS         = fragment shader
const VS         = vertex shader
seedCollections  = per-wallet RNG-driven layout setup
buildAtlasBinary = the in-browser atlas builder
fetchWithRetry   = the robust fetch helper
```

---

That's the orientation. Open `index.html`, find the constant or section you
want, edit, push. The site updates within ~30 seconds.
