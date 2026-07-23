#!/usr/bin/env node
// Publishes client-gateway.html to a WordPress page on nomadassetcollective.com.
//
// Creates the page on first run (idempotent — reuses it after that) and writes
// the full HTML into the ACF field `raw_html_code`, which the site's raw-HTML
// page template echoes verbatim. The page is BLIND: it only shows a login gate
// until the worker verifies a token, so it is safe to host publicly.
//
//   node scripts/gateway-wp.mjs
//
// Env / secrets:
//   WP_APP_PASSWORD        (required) — WP Application Password, same value the
//                          Property-Hub / Brochures repos already use.
//   WP_USER                (default admin_web)
//   WP_BASE_URL            (default https://nomadassetcollective.com)
//   WP_GATEWAY_SLUG        (default client-gateway)  → /<slug>/
//   WP_GATEWAY_TITLE       (default "Client Gateway")
//   WP_STATUS              (default private) — 'private' shows only to logged-in
//                          WP editors; set 'publish' to open it to anyone with
//                          the URL (the token gate still protects the data).
//   WP_TEMPLATE_SAMPLE_SLUG(default property-hub) — an existing page whose
//                          template echoes raw_html_code; the new page copies it.
//   WP_ACF_FIELD           (default raw_html_code)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WP_BASE   = (process.env.WP_BASE_URL || 'https://nomadassetcollective.com').replace(/\/$/, '');
const WP_API    = `${WP_BASE}/wp-json/wp/v2`;
const WP_USER   = process.env.WP_USER || 'admin_web';
const WP_PASS   = process.env.WP_APP_PASSWORD;
const SLUG      = process.env.WP_GATEWAY_SLUG || 'client-gateway';
const TITLE     = process.env.WP_GATEWAY_TITLE || 'Client Gateway';
const STATUS    = process.env.WP_STATUS || 'private';
// Default sample = the Malta brochure page (verified live, raw-HTML template that
// echoes raw_html_code). Override with WP_TEMPLATE_SAMPLE_SLUG for a different one.
const SAMPLE    = process.env.WP_TEMPLATE_SAMPLE_SLUG || 'chuong-trinh-malta-thuong-tru-nhan-rbi';
const ACF_FIELD = process.env.WP_ACF_FIELD || 'raw_html_code';
const HTML_PATH = join(__dirname, '..', 'client-gateway.html');

if (!WP_PASS) { console.error('✗ WP_APP_PASSWORD env var is required'); process.exit(1); }

const AUTH  = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// nomadassetcollective.com sits behind Imunify360 bot-protection that
// intermittently 403/503s runner IPs or returns a 200 "access denied" body.
// Retry idempotent GETs; writes throw on first failure so we never double-create.
function isBotGate(p) {
  const m = p && typeof p === 'object' && typeof p.message === 'string' ? p.message : '';
  return /imunify360|access denied by|bot-protection/i.test(m);
}
async function wp(pathname, options = {}) {
  const method = options.method || 'GET';
  const retryable = method === 'GET';
  const max = retryable ? 5 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    let res, text;
    try {
      res = await fetch(`${WP_API}${pathname}`, {
        ...options,
        headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
      });
      text = await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < max) { await sleep(2000 * 2 ** (attempt - 1)); continue; }
      throw e;
    }
    if (res.ok) {
      if (!text) return null;
      let parsed;
      try { parsed = JSON.parse(text); }
      catch {
        lastErr = new Error(`WP ${method} ${pathname} → 200 non-JSON (bot challenge?): ${text.slice(0, 120)}`);
        if (retryable && attempt < max) { await sleep(2000 * 2 ** (attempt - 1)); continue; }
        throw lastErr;
      }
      if (isBotGate(parsed)) {
        lastErr = new Error(`WP ${method} ${pathname} → bot-gate: ${parsed.message.slice(0, 120)}`);
        if (retryable && attempt < max) { await sleep(2000 * 2 ** (attempt - 1)); continue; }
        throw lastErr;
      }
      return parsed;
    }
    lastErr = new Error(`WP ${method} ${pathname} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    if (retryable && (res.status === 403 || res.status === 429 || res.status >= 500) && attempt < max) {
      await sleep(2000 * 2 ** (attempt - 1)); continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

async function detectTemplate() {
  try {
    const sample = await wp(`/pages?slug=${encodeURIComponent(SAMPLE)}&per_page=1&context=edit`);
    if (sample?.length && sample[0].template) {
      console.log(`  template: "${sample[0].template}" (from ${SAMPLE})`);
      return sample[0].template;
    }
  } catch (e) { console.warn(`  ⚠ template detect failed (${e.message}) — using default`); }
  console.warn(`  ⚠ no template on sample "${SAMPLE}" — using theme default (the page may not render raw HTML; point WP_TEMPLATE_SAMPLE_SLUG at a raw-HTML page)`);
  return '';
}

async function findPage() {
  const pages = await wp(`/pages?slug=${encodeURIComponent(SLUG)}&per_page=10&status=publish,draft,private,future,pending`);
  return (pages && pages.length) ? pages[0] : null;
}

async function main() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const safeHtml = html.replace(/\\/g, '\\\\'); // survive wp_unslash()
  console.log(`Syncing Client Gateway → ${WP_BASE}/${SLUG}/`);

  let page = await findPage();
  if (!page) {
    const template = await detectTemplate();
    const body = { title: TITLE, slug: SLUG, status: STATUS };
    if (template) body.template = template;
    page = await wp('/pages', { method: 'POST', body: JSON.stringify(body) });
    console.log(`  ✓ created page ${page.id} (status: ${STATUS})`);
  } else {
    console.log(`  ↻ reusing page ${page.id} (status: ${page.status})`);
  }

  await wp(`/pages/${page.id}`, { method: 'POST', body: JSON.stringify({ acf: { [ACF_FIELD]: safeHtml } }) });
  console.log(`  ✓ wrote ${html.length.toLocaleString()} chars into acf.${ACF_FIELD}`);
  console.log(`\nDone → ${page.link || `${WP_BASE}/${SLUG}/`}`);
  if (STATUS === 'private') console.log(`Note: page is PRIVATE (WP-editor-only). Flip to Publish in WP, or re-run with WP_STATUS=publish, to open it to consultants.`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
