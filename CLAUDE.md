# NAC Dashboard — Project Rules

## Architecture (DO NOT CHANGE)

Two separate Cloudflare Workers serve different purposes:

| Worker | URL | Purpose |
|--------|-----|---------|
| `nac-dashboard` | `nac-dashboard.ray-vtt.workers.dev` | **API backend** — runs `worker.js` |
| `nac-dashboard-ui` | `nac-dashboard-ui.ray-vtt.workers.dev` | **Frontend** — serves `index.html` from GitHub |

### CRITICAL RULES

1. **`wrangler.toml` must always have `name = "nac-dashboard"`** — NEVER change it to `nac-dashboard-ui`. GitHub Actions deploys `worker.js` using this name. Changing it will overwrite the frontend with API code and break the dashboard.

2. **`nac-dashboard-ui` is NOT deployed from GitHub.** It's a simple Cloudflare Worker configured manually via the Cloudflare editor. Its only job is to fetch `index.html` from GitHub raw. Never deploy to it via wrangler or GitHub Actions.

3. **If `nac-dashboard-ui` breaks** (shows JSON like `{"error":"Not found"}` instead of the dashboard), fix it by going to Cloudflare → Workers & Pages → `nac-dashboard-ui` → Edit code → replace ALL code with:
```javascript
export default {
  async fetch(request) {
    const resp = await fetch(
      'https://raw.githubusercontent.com/rayvtt/NAC-Dashboard/main/index.html',
      { cf: { cacheTtl: 300 } }
    );
    return new Response(resp.body, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};
```
Then click Deploy.

## File Roles

- `index.html` — Dashboard frontend (all pages, JS, CSS). Changes auto-appear within 5 min after push.
- `worker.js` — API backend (social APIs, agents, blog tracking, lead gen, Notion CRM). Auto-deployed via GitHub Actions on push.
- `wrangler.toml` — Worker config. **Name must stay `nac-dashboard`.**
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

- Colors: `#1800ad` (primary blue-purple) + `#F4622A` (Claude orange) + white
- Site: nomadassetcollective.com
- Blog: blog.nomadassetcollective.com

## Blog Analytics

A tracking script on the WordPress blog sends events to `POST /api/track` on the worker. Dashboard Analytics page shows the data via `GET /api/blog/stats`.
