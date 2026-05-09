# NAC Dashboard — Project Rules

## Architecture

| Layer | URL | Purpose |
|-------|-----|---------|
| **Frontend** | `rayvtt.github.io/NAC-Dashboard` | GitHub Pages serves `index.html` directly from `main` |
| **API** | `nac-dashboard.ray-vtt.workers.dev` | Cloudflare Worker — runs `worker.js` |

### How it works
- `index.html` is served by **GitHub Pages** directly from the `main` branch root. No Cloudflare worker involved.
- Changes to `index.html` pushed to `main` go live in ~30 seconds automatically.
- `worker.js` is the API backend. It is deployed via GitHub Actions when `worker.js` or `wrangler.toml` changes.

### CRITICAL RULES
1. **`wrangler.toml` must always have `name = "nac-dashboard"`** — this deploys the API worker only.
2. **Do NOT create or use a `nac-dashboard-ui` Cloudflare Worker** — it is no longer part of the architecture.
3. **Never change the GitHub Pages source** — it should always be `main` branch, `/ (root)`.

## File Roles

- `index.html` — Dashboard frontend (all pages, JS, CSS). Push to main → live in ~30s via GitHub Pages.
- `worker.js` — API backend (social APIs, agents, blog tracking, lead gen, Notion CRM). Auto-deployed via GitHub Actions.
- `wrangler.toml` — Cloudflare Worker config. Name must stay `nac-dashboard`.
- `.github/workflows/deploy-worker.yml` — Deploys `worker.js` to Cloudflare on push to main.

## GitHub Repo

- Repo: `github.com/rayvtt/NAC-Dashboard`
- Branch: `main`
- Owner: `rayvtt` (ray.vtt@gmail.com)

## Cloudflare Secrets (on `nac-dashboard` worker)

Already configured: `ANTHROPIC_API_KEY`
KV Namespace: `NAC_AGENTS` (bound)

Still needed:
- `FB_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID`, `IG_USER_ID` (Meta)
- `TIKTOK_ACCESS_TOKEN` (TikTok)
- `GA4_PROPERTY_ID`, `GA4_CLIENT_EMAIL`, `GA4_PRIVATE_KEY` (Google Analytics)
- `NOTION_API_TOKEN` (Notion CRM for Lead Gen)

## Brand

- Colors: `#1800ad` (primary blue-purple) + `#F4622A` (orange) + white
- Site: nomadassetcollective.com
- Blog: blog.nomadassetcollective.com

## Blog Analytics

A tracking script on the WordPress blog sends events to `POST /api/track` on the worker. Dashboard Analytics page shows the data via `GET /api/blog/stats`.
