# dustopia

Living wallet portrait. Every Ethereum address rendered as a 3D sphere of
swirling NFT thumbnails, animated in real time. Open Edition NFT drop on
OpenSea Drops where each token's `animation_url` shows the current holder's
collection as a generative orb that updates with every wallet change.

**Live**: <https://dustopia.xyz>

---

## Stack

- **Frontend** — multiple self-contained HTML files (landing, sphere
  renderer, configurator, playground). WebGL2 + GLSL, no build step.
- **Worker** (`worker.js`) — Cloudflare Worker at `api.dustopia.xyz`.
  Proxies Alchemy NFT API + ENS, serves ERC-721 metadata, persists per-token
  configurations and atlas/preview captures in R2, verifies EIP-191
  signatures via viem.
- **Hosting** — Cloudflare Pages (frontend), Cloudflare Workers (API),
  Cloudflare KV (cache), Cloudflare R2 (atlases + previews + configs).

## Repo layout

```
.
├── index.html             landing page
├── embed/index.html       sphere renderer (the actual artwork)
├── configure/index.html   per-token configurator (holders curate which NFTs render)
├── play/index.html        shareable wallet-input page
├── worker.js              Cloudflare Worker
├── wrangler.toml          Worker deploy config
├── _redirects             Pages routing
├── _headers               CSP + security headers
├── package.json           single dev dep: viem (signature verification)
├── README.md              this file
├── CLAUDE.md              project context for AI assistants
└── .gitignore
```

## Local dev

The frontend is plain HTML. To preview:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Run the Worker locally:

```bash
npx wrangler dev
# Worker becomes available at http://localhost:8787
```

To point a local frontend at the local Worker, edit `API_URL` in the page
you're working on (`embed/index.html` or `configure/index.html`).

## Deploy

**Frontend** auto-deploys on push to `main` if the repo is connected to
Cloudflare Pages.

**Worker** is manual:

```bash
npx wrangler deploy
```

First-time setup:

```bash
npx wrangler login
echo "<your-alchemy-key>" | npx wrangler secret put ALCHEMY_KEY
```

## Environment

- Alchemy NFT API v3 (Free tier currently)
- ENS resolution via `api.ensideas.com` (no key)
- Cloudflare KV: `WALLET_CACHE` (30 min wallet, 24 h ENS, 5 min preview)
- Cloudflare R2: `dustopia-atlas` (atlas binaries, preview captures, per-token configs)

## License

TBD.
