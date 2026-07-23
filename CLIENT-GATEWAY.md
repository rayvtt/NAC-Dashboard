# Client Gateway — setup

The Client Gateway (`client-gateway.html`) is a standalone, login-gated console
that shows each client A→Z (consultation → tools/code/touchpoints → documents →
property → deal/payment/financing → passport). It ships **blind**: no client data
is in the page — real records load only after the Worker verifies your token.

- **App (live):** https://rayvtt.github.io/NAC-Dashboard/client-gateway.html
- **Reachable from:** NAC-Dashboard sidebar (🛂) and the MCC cockpit (Grow nav)
- **API:** `nac-dashboard.ray-vtt.workers.dev/api/gateway/clients` (token-gated)

Until the secrets below are set, **Demo mode** (login screen → "Preview with demo
data") works everywhere for UI review.

---

## Goal A — turn on the live CRM (real records at login)

Sets two secrets on the `nac-dashboard` Cloudflare Worker.

1. **Pick a login token.** Use the one generated for you, or any strong string.
2. **Cloudflare dashboard** → Workers & Pages → **nac-dashboard** → Settings →
   **Variables and Secrets** → *Add* (type **Secret**) for each:
   - `GATEWAY_TOKEN` = your login token
   - `GATEWAY_EMAILS` = `ray.vtt@gmail.com,ray@nomadassetcollective.com` *(optional allowlist)*
   - `NOTION_API_TOKEN` = your Notion integration token
   Save (applies immediately — no redeploy needed).
   *CLI alternative (from this repo folder):* `npx wrangler secret put GATEWAY_TOKEN` (repeat per secret).
3. **Connect the Notion integration to the two databases** it must read
   (else queries come back empty). In Notion, open each → **•••** → *Connections*
   → add your integration:
   - **NAC Lead CRM** (`2fe48ec2-5e86-80ef-a3a3-fb8113cf6657`)
   - **🤝 NAC - Partners** (`a0402cbc-9b57-4ded-ac07-8e087228f19c`)
4. **Test:** open the app URL → enter your email (in the allowlist) + token →
   real clients load.
   - `401 / "not recognised"` → token (or email) mismatch.
   - empty list / Notion error → `NOTION_API_TOKEN` missing or not connected to the DBs.

Each client is assembled from the Lead CRM (name, contact, programs, budget,
status→stage, notes) joined to Partners (access code, opens, materials). Deal /
documents / property-lock show "not started" until those live in Notion.

---

## Goal B — publish it on nomadassetcollective.com

Creates `nomadassetcollective.com/client-gateway/` and keeps it in sync.

1. **GitHub** → repo `rayvtt/NAC-Dashboard` → Settings → **Secrets and variables
   → Actions**:
   - *Secrets* → New → `WP_APP_PASSWORD` = your WP Application Password
     (same value the Property-Hub / Brochures repos use). If your WP user isn't
     `admin_web`, also add `WP_USER`.
   - *Variables* → New → `WP_TEMPLATE_SAMPLE_SLUG` = the slug of an existing page
     that renders raw HTML, so the new page inherits its template
     (e.g. `property-hub`, or a brochure slug). *(Optional but recommended.)*
2. **Run it:** Actions tab → **"Sync Client Gateway → WordPress"** → *Run workflow*
   → status **private** → Run. The log prints the page URL.
   *(It also runs automatically on every push that touches `client-gateway.html`.)*
3. **Verify:** visit `nomadassetcollective.com/client-gateway/` (logged into WP if
   private). Renders the login gate → success. Blank / normal page → the template
   didn't attach; set `WP_TEMPLATE_SAMPLE_SLUG` to a known raw-HTML page and re-run.
4. **Go live:** when happy, re-run with status **publish** (or WP admin → edit the
   page → Visibility → Public). The page is blind + `noindex`, so public is safe.

---

## Notes
- The login token unlocks client PII — treat it like a password; rotate by setting
  a new `GATEWAY_TOKEN` value anytime.
- Light/dark: the ◐ toggle in the top bar (defaults to your OS, remembers choice).
- Nothing here requires a code change or push — it's all secrets + one workflow run.
