#!/usr/bin/env node
// Regenerates the embedded sitemap tree in sitemap/index.html from the LIVE
// Rank Math sitemaps of both NAC WordPress sites, so the visualisation contains
// EVERY published URL (not a hand-pasted sample).
//
//   node sitemap/build-data.mjs           # fetch live + rewrite sitemap/index.html
//   node sitemap/build-data.mjs --dry     # print stats only, no write
//
// Needs outbound network (fetches *.xml). Re-run anytime to refresh the snapshot.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const DRY = process.argv.includes('--dry');

// Site metadata preserved from the existing snapshot (subtitle/color/masthead).
const SITES = [
  { id: 'main', origin: 'https://nomadassetcollective.com',      title: 'nomadassetcollective.com',      subtitle: 'Main site · WordPress · Vietnamese', color: '#1800AD' },
  { id: 'blog', origin: 'https://blog.nomadassetcollective.com', title: 'blog.nomadassetcollective.com', subtitle: 'NAC Times · editorial',             color: '#F4622A', masthead: 'https://blog.nomadassetcollective.com/wp-content/uploads/2026/05/Masthead.png' },
];

// Emoji labels for known top-level path segments (cosmetic; everything else is Title Cased).
const SECTION_LABEL = {
  'property-hub-bat-dong-san': '🏢 Property Hub',
  'citizenships': '🛂 Citizenships', 'citizenship': '🛂 Citizenship',
  'residences': '🌍 Residences', 'residence': '🌍 Residence',
  'compare': '⚖️ Compare', 'compares': '⚖️ Compares', 'so-sanh': '⚖️ So Sánh', 'compare-cat': '⚖️ Compare Categories',
  'category': '🏷 Categories', 'danh-muc': '🏷 Danh Mục', 'chuyen-muc': '🏷 Chuyên Mục',
  'citizenship-region': '🛂 Citizenship Regions', 'residence-region': '🌍 Residence Regions',
  'khu-vuc': '🌏 Khu Vực', 'nhan-tam-trang': '🧭 Nhãn Tâm Trạng',
  'nac-residence-index': '📊 NAC Residence Index',
  'tu-van-nhanh': '💬 Tư Vấn Nhanh', 'brochures': '📑 Brochures', 'brochure': '📑 Brochures',
  'en': '🇬🇧 English', 'blog-tintuc': '📰 Blog / Tin Tức',
};
const POSTS_LABEL = '📝 Bài Viết';

const titleize = (slug) => decodeURIComponent(slug).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const labelFor = (seg, depth) => depth === 0 ? (SECTION_LABEL[seg] || titleize(seg)) : titleize(seg);
const dateOnly = (lm) => (lm || '').slice(0, 10) || undefined;

async function getXml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NAC sitemap builder)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Pull <loc>/<lastmod> pairs out of a urlset or sitemapindex.
function parseEntries(xml) {
  const out = [];
  const blocks = xml.match(/<(?:url|sitemap)\b[\s\S]*?<\/(?:url|sitemap)>/g) || [];
  for (const b of blocks) {
    const loc = (b.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/) || [])[1];
    const lm = (b.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/) || [])[1];
    if (loc) out.push({ loc: loc.trim(), lm: lm && lm.trim() });
  }
  return out;
}

// Fetch a site's sitemap index → every child sub-sitemap → every page URL.
// type = sub-sitemap basename (e.g. "post", "page", "citizenship").
async function collectUrls(origin) {
  const index = parseEntries(await getXml(`${origin}/sitemap_index.xml`));
  const urls = [];
  for (const child of index) {
    const type = (child.loc.match(/\/([a-z0-9-]+)-sitemap\.xml/i) || [])[1] || 'page';
    let entries = [];
    try { entries = parseEntries(await getXml(child.loc)); }
    catch (e) { console.warn(`  ! skip ${child.loc}: ${e.message}`); continue; }
    for (const e of entries) urls.push({ ...e, type });
  }
  return urls;
}

// Build a path-nested tree; flat posts get bucketed under a Posts section so the
// "parents only" view stays clean.
function buildTree(origin, urls) {
  const roots = [];
  const byPath = new Map();
  let home = null;

  const ensure = (segs) => {
    let parent = null, accum = '';
    for (const seg of segs) {
      accum = accum ? `${accum}/${seg}` : seg;
      let n = byPath.get(accum);
      if (!n) {
        n = { _seg: seg, _depth: accum.split('/').length - 1, children: [] };
        byPath.set(accum, n);
        (parent ? parent.children : roots).push(n);
      }
      parent = n;
    }
    return parent;
  };

  for (const { loc, lm, type } of urls) {
    let pathname;
    try { pathname = new URL(loc).pathname; } catch { continue; }
    const segs = pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s).toLowerCase());
    if (!segs.length) { home = { _seg: '', name: '🏠 Home', loc, lm: dateOnly(lm), children: [] }; continue; }
    const node = ensure(segs);
    node.loc = loc; node.lm = dateOnly(lm); node._type = type;
  }

  // Bucket flat (top-level, childless) posts under a Posts section.
  const posts = roots.filter(n => n._type === 'post' && !n.children.length);
  if (posts.length) {
    for (const p of posts) roots.splice(roots.indexOf(p), 1);
    roots.push({ _seg: 'posts', _depth: 0, name: POSTS_LABEL, children: posts });
  }
  if (home) roots.unshift(home);

  // Name + sort, recursively.
  const finish = (nodes, depth) => {
    for (const n of nodes) {
      if (!n.name) n.name = labelFor(n._seg, depth);
      if (n.children.length) finish(n.children, depth + 1);
    }
    nodes.sort((a, b) => {
      if (a._seg === '') return -1; if (b._seg === '') return 1;           // Home first
      const ac = a.children.length ? 0 : 1, bc = b.children.length ? 0 : 1; // sections before leaves
      return ac - bc || a.name.localeCompare(b.name);
    });
  };
  finish(roots, 0);

  // Strip internal fields.
  const clean = (nodes) => nodes.map(n => ({
    name: n.name, ...(n.loc ? { loc: n.loc } : {}), ...(n.lm ? { lm: n.lm } : {}),
    children: clean(n.children),
  }));
  return clean(roots);
}

const countLeaves = (nodes) => nodes.reduce((n, x) => n + (x.children.length ? countLeaves(x.children) : 1), 0);

async function main() {
  const sites = [];
  for (const s of SITES) {
    process.stdout.write(`▸ ${s.id}: fetching ${s.origin} …\n`);
    const urls = await collectUrls(s.origin);
    const children = buildTree(s.origin, urls);
    sites.push({ id: s.id, title: s.title, subtitle: s.subtitle, color: s.color, ...(s.masthead ? { masthead: s.masthead } : {}), total: urls.length, children });
    console.log(`    ${urls.length} URLs · ${children.length} top sections · ${countLeaves(children)} leaves`);
  }

  const data = { generated: new Date().toISOString().slice(0, 10), sites };
  const json = JSON.stringify(data);

  if (DRY) { console.log('\n(dry run — not writing)'); return; }

  let html = await fs.readFile(FILE, 'utf-8');
  const re = /(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  if (!re.test(html)) throw new Error('data <script> block not found in index.html');
  html = html.replace(re, `$1${json}$3`);
  await fs.writeFile(FILE, html, 'utf-8');
  console.log(`\n✓ wrote ${(json.length / 1024).toFixed(1)} KB into ${path.relative(process.cwd(), FILE)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
