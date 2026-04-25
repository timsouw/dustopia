# dustopia

Living wallet portrait — every Ethereum address rendered as a 3D sphere of
swirling NFT thumbnails, animated in real time. Open Edition NFT drop where the
artwork stays alive: each token's `animation_url` shows the current holder's
collection as a generative orb.

**Live**: <https://dustopia.xyz>

---

## Stack

- **Frontend** (`index.html`) — single-file WebGL2 renderer. ~1300 lines of
  HTML/CSS/JS/GLSL. No build step. Pure browser tech.
- **Backend** (`worker.js`) — Cloudflare Worker that proxies the Alchemy NFT API,
  hides the API key, and caches responses in KV. Deployed at `api.dustopia.xyz`.
- **Hosting** — Cloudflare Pages (frontend) + Cloudflare Workers (backend) +
  Cloudflare KV (cache).

## Repo layout

```
.
├── index.html         frontend, deployed to Cloudflare Pages
├── worker.js          backend Worker proxy (Alchemy + ENS), deployed via wrangler
├── wrangler.toml      Worker deploy config
├── README.md          this file
├── CLAUDE.md          full project context for AI assistants
└── .gitignore
```

## Local dev

The frontend is a single HTML file. To preview locally:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The Worker can be run locally via wrangler:

```bash
npx wrangler dev
# Worker becomes available at http://localhost:8787
```

To test the frontend against the local Worker, edit `index.html` and set:

```js
const API_URL = 'http://localhost:8787';
```

## Deploy

**Frontend** — auto-deploys on `git push` if connected to Cloudflare Pages.

**Worker** — manual via wrangler:

```bash
npx wrangler deploy
```

First-time setup:

```bash
npx wrangler login
echo "<your-alchemy-key>" | npx wrangler secret put ALCHEMY_KEY
```

## Environment

- Alchemy NFT API v3 (Free tier currently — 25 req/sec rate limit)
- ENS resolution via `api.ensideas.com` (no key needed)
- Cloudflare KV cache: `WALLET_CACHE` (30min TTL for wallet data, 24h for ENS)

## License

TBD.
