# dustopia — context for Claude Code (and other AI assistants)

Orientation doc for any new AI session working on this repo. Skim-readable;
top sections are critical.

---

## TL;DR

- **What it is**: a live, browser-rendered 3D sphere of swirling NFT thumbnails
  that updates in real time based on a connected Ethereum wallet's holdings.
  The on-chain artwork for an Open Edition NFT drop on OpenSea Drops.
- **Live**: <https://dustopia.xyz>
- **Tech**: WebGL2, no build step. Each HTML page is self-contained.

## Repo layout

```
index.html              landing page
embed/index.html        sphere renderer (the actual artwork)
configure/index.html    per-token configurator (holders pick which NFTs render)
play/index.html         shareable wallet-input page
worker.js               Cloudflare Worker (Alchemy proxy, R2 cache, config save)
wrangler.toml           Worker deploy config
_redirects              Cloudflare Pages routing
_headers                CSP + security headers
package.json            single dev dep: viem (signature verification in worker)
README.md               public-facing project description
CLAUDE.md               this file
.gitignore
```

No bundler, no transpiler, no node_modules at runtime. **Edit HTML directly
and reload.** `node_modules/` exists only because viem ships from npm.

---

## Architecture

```
                            (browser)
                                │
                  visit https://dustopia.xyz
                                │
                       loads index.html (landing)
                                │
              opens /embed/<addr> (the actual sphere)
                                │
                JS calls https://api.dustopia.xyz/api/...
                                │
                      (Cloudflare Worker)
                                │
        ┌───── KV / R2 / Edge cache check ─────┐
        │ HIT: ms                MISS: tens of ms
        │                                │
        │                       Alchemy NFT v3 / ENS
        │                                │
        │                       cache + return
        └────────────── return JSON ────┘
                                │
                       (back to browser)
                                │
              JS fetches each NFT thumbnail (Alchemy CDN)
                                │
              builds 192×192 WebP atlas in a 2D canvas
                                │
              uploads atlas + token metadata to R2 (fire-and-forget)
                                │
              WebGL2 POINTS renderer with custom GLSL shader
                                │
                     sphere of swirling pixels
```

## Live URLs

- **Landing**: <https://dustopia.xyz>
- **Sphere**: <https://dustopia.xyz/embed/<addr>>
- **Configurator** (holders): <https://dustopia.xyz/configure/<tokenId>>
- **Playground**: <https://dustopia.xyz/play>
- **API**: <https://api.dustopia.xyz/api/health> → returns `{"ok":true}`
- **Pages preview**: <https://dustopia.pages.dev>

## Cloudflare account

- Domain: `dustopia.xyz` (registered through Cloudflare)
- Pages project: `dustopia` (static frontend, GitHub-connected to this repo)
- Worker: `franken-api` (API at `api.dustopia.xyz`, name is legacy-fixed
  because the custom domain is bound to that specific Worker name)
- KV namespace: `WALLET_CACHE` (id in `wrangler.toml`)
- R2 bucket: `dustopia-atlas` (atlas binaries + per-token configs + preview captures)
- Worker secrets:
  - `ALCHEMY_KEY` — Alchemy NFT API key (never commit)
  - `WEBHOOK_SECRET` — Alchemy Notify signing secret (HMAC verification on `/api/webhook/transfer`)

## Alchemy

- NFT API v3, Free tier (25 req/sec, 30M CU/month)
- Endpoints used: `getNFTsForOwner`, `eth_call` (for `ownerOf`)
- Image fetching uses Alchemy CDN (cachedUrl/thumbnailUrl) — CORS-safe

---

## Worker endpoints

```
GET  /api/health                       → ping
GET  /api/wallet/<addr>?pageKey&spam   → Alchemy getNFTsForOwner
GET  /api/ens/<name>                   → ENS resolver
GET  /api/owned/<addr>                 → Dustopia tokenIds owned by addr
GET  /api/metadata/<tokenId>           → ERC-721 metadata JSON
GET  /api/preview/<tokenId>            → preview image (animated WebP / SVG)

GET/PUT/DELETE  /api/atlas/<addr>      → R2 atlas cache
GET/PUT/HEAD/DELETE  /api/preview-cap/<addr>  → captured preview WebP
GET/PUT  /api/config/<tokenId>         → per-token holder selection (PUT signed)

POST /api/webhook/transfer             → Alchemy Notify webhook (HMAC-gated)
```

CORS: allowlist of dustopia.xyz origins; marketplace-facing endpoints
(metadata, preview) explicitly serve `*` since OpenSea bots have no Origin.

Caching:
- Wallet pages: 30 min KV
- ENS resolves: 24 h KV
- Preview: 5 min Cache-Control + edge cache, invalidated on config save
- Atlas: in R2 forever, keyed by `(addr, GRID, selection-fingerprint)`

Rate limit: per-IP per-minute counter in KV; PUT bucket tighter than GET.

---

## Visual physics constants

These live near the top of `embed/index.html`. **Bold** = current production
values.

### Particle density
- `GRID` = **192** — particles per token side (192² = 36 864 per token).
  Lower (96) for older GPUs.
- `LIVE_TILE` = **192** — atlas tile size in pixels. Must match `GRID`.
- `HISTORY_LEN` = **320** — frames of pos/fwd history (used for shear/streak).
  Should be ≥ `GRID + GRID·SHEAR_FACTOR`.
- `LANE_WIDTH` = **0.32 / 192** — angular width of each token's swarm.
- `MAX_TOKENS` = **1024** — hard cap on tokens per sphere.

### Sphere sizing
- `SPHERE_FACTOR` = **0.032**
- `SPHERE_FRAC_MIN` = **0.20**, `SPHERE_FRAC_MAX` = **0.23**

### Layer / depth
- `LAYER_INNER_R` = **0.78**, `LAYER_OUTER_R` = **1.18**
- Per-collection oscillation: `radiusFreq` = 0.06–0.16 rad/s

### Flocking (Reynolds)
- `FLOCK_COHESION` = **0.35**, `FLOCK_ALIGN` = **0.55**
- `SEPARATION_STRENGTH` = **0.20**, `SEPARATION_RADIUS` = **1.1**
- `FLOCK_REST_ARC` = **0.18**

### Pole avoidance
- `POLE_THRESHOLD` = **0.65**, `POLE_PUSH_MAX` = **0.55**

### Wind & waves
- `WAVE_AMPLITUDE` = **0.033**, `BIG_WAVE_AMP` ≈ **0.086**, `BIG_WAVE_FREQ` = **0.6**
- `WIND_AMP_LOW` = **0.014**, `WIND_AMP_HIGH` = **0.004**, `SHEAR_FACTOR` = **0.55**

### Spawn spread
- `SPAWN_SPREAD_TIGHT` = 0.22 (high-N wallets)
- `SPAWN_SPREAD_BASE` = 1.20 (decays as `exp(-N/12)`; tiny wallets fill the orb)

### Depth fog
- `u_fogStrength` = **0.72**, `u_fogColor` set per frame from theme

---

## Deploy flow

### Frontend
Cloudflare Pages auto-deploys `main` on push (~30 s).

### Worker
Manual via wrangler (Pages doesn't deploy `worker.js`):

```bash
npx wrangler deploy
```

First-time setup:

```bash
npx wrangler login
echo "<key>" | npx wrangler secret put ALCHEMY_KEY
```

---

## Common edits

### Tweak a physics value
Edit constant at top of `embed/index.html`, `git push`, done.

### Add a new Worker endpoint
Add a route in the dispatcher block at the bottom of `worker.js`. Re-deploy
with `wrangler deploy`. Frontend can then call it.

### Change colors / theme
CSS lives at the top of each HTML file in a `<style>` block. Light theme uses
`body.light` selectors. Same `franken-theme` localStorage key syncs choice
across landing / play / embed / configure.

### Wire up Alchemy Notify (one-time)
The Worker has an `/api/webhook/transfer` endpoint that wipes a token's
saved selection + owner cache + edge-cached preview when the NFT changes
hands. To activate:

1. Set the secret on the Worker:
   ```bash
   echo "<alchemy-signing-key>" | npx wrangler secret put WEBHOOK_SECRET
   ```
2. In Alchemy dashboard → Notify → "Address Activity" webhook
   - Network: Ethereum mainnet
   - URL: `https://api.dustopia.xyz/api/webhook/transfer`
   - Addresses: `0x8196e52111255d71732c2187F0F8420704417cE6` (the Drops contract)
   - Categories: `external`, `internal` aren't needed; activate ERC-721 transfers
3. Copy the signing key shown after creation back into the secret.

After this, every Transfer event fires the webhook → handler verifies HMAC,
deletes `config/<tokenId>.json` from R2, clears the KV `owner:` cache, and
purges the edge cache for `/api/preview/<tokenId>`. New owner sees a clean
default; OpenSea picks up the new render on its next refresh.

---

## Pending / planned

- [ ] **Per-flock drifting orbit axes** — each collection should also have
  its own slow-drifting orbit-axis (currently they share global Y-rotation).
- [ ] **Atlas pre-build service** — Worker that builds the atlas server-side
  at mint/transfer time, so first-time visitors don't wait 30–60 s for image
  fetching. Today the atlas is built in the visitor's browser and lazily
  uploaded to R2.

---

## Things to NEVER commit

- The Alchemy API key (lives only as Worker secret `ALCHEMY_KEY`)
- Any private key
- A `.dev.vars` file with local secrets (it's gitignored)

---

## Working with this codebase as Claude Code

- Each HTML page is self-contained. Use Edit on the right file rather than
  rewriting.
- After non-trivial JS edits, syntax-check by extracting the script blocks:
  ```bash
  python3 -c "import re; s=open('embed/index.html').read(); ms=re.findall(r'<script>([\s\S]*?)</script>', s); open('/tmp/c.js','w').write('\n;\n'.join(ms))"
  node --check /tmp/c.js
  ```
- The shader is GLSL embedded as a JS template literal. `node --check` won't
  catch GLSL errors; only WebGL2 will (`gl.compileShader` errors in console).
- Worker changes need `npx wrangler deploy` separately from `git push` —
  Pages deploys frontend only.
