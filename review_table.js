// Print the review table for a batch of enrich.js results -- the thing the
// operator looks at before anything is inserted. No network, no database.
//
//   node review_table.js --list <dir> [--results <json>] [--corrections <js>]
//                        [--batch <file> | domain ... | --all] [--quotes]
//
// Selection: positional domains > --batch <file> > <list>/last_batch.txt.
// --all prints every domain in the results file. --quotes adds, under each
// row, the verbatim quote behind every filled field and the fetch methods,
// for spot-checking a value against the site.
//
// Flags column:
//   EXCL         country is in EXCLUDED_COUNTRIES (insert_batch.js will mark it do_not_contact)
//   NO-COUNTRY   nothing stated and no ccTLD fallback -- needs a correction
//   NAME=DOMAIN  no company name found; the domain is standing in
//   TITLE-NAME   name came from the page <title>, not stated text
//   CORR / DNC   a corrections.js entry exists / it sets do_not_contact
//   BLOCKED      403 / CAPTCHA -- alive, refused us; not the same as dead
//   DEAD(...)    dead-site marker seen on the home page
//   REJ n        n fields dropped because their quote was not on the page
//   DRIFT        the model answered with invented keys (auto-retried)
//   NOT-ENRICHED no result for this domain yet

const fs = require('fs');
const { parseCli, listPaths, readLines, loadCorrections, isExcludedCountry } = require('./common.js');

const USAGE = `usage: node review_table.js --list <dir> [--results <json>] [--corrections <js>] [--batch <file> | domain ... | --all] [--quotes]`;

const { values: opt, positionals } = parseCli({
  usage: USAGE,
  allowPositionals: true,
  options: {
    list: { type: 'string' }, results: { type: 'string' }, corrections: { type: 'string' },
    batch: { type: 'string' }, all: { type: 'boolean' }, quotes: { type: 'boolean' },
  },
});
if (!opt.list && !opt.results) { console.error('give --list <dir> or --results <json>\n\n' + USAGE); process.exit(1); }

const L = opt.list ? listPaths(opt.list) : null;
const resultsPath = opt.results || L.enrich;
const correctionsPath = opt.corrections || (L && fs.existsSync(L.corrections) ? L.corrections : null);
const corrections = loadCorrections(correctionsPath);
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const byDomain = new Map(results.map((r) => [r.domain, r]));

let selected;
if (positionals.length) selected = positionals.map((d) => d.toLowerCase());
else if (opt.batch) selected = readLines(opt.batch);
else if (opt.all) selected = results.map((r) => r.domain);
else if (L && fs.existsSync(L.lastBatch)) selected = readLines(L.lastBatch);
else { console.error('nothing selected: pass domains, --batch <file>, or --all\n\n' + USAGE); process.exit(1); }

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '/').replace(/\s+/g, ' '));
const clip = (v, n) => { const s = cell(v); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const header = ['#', 'domain', 'verdict', 'company', 'country', 'role', 'type', 'cat_general', 'cat_specific', 'market', 'flags'];
const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
const details = [];
const counts = {};

selected.forEach((domain, i) => {
  const r = byDomain.get(domain);
  const c = corrections[domain];
  if (!r) {
    lines.push(`| ${i + 1} | ${domain} | — | — | — | — | — | — | — | — | NOT-ENRICHED${c ? ' CORR' : ''} |`);
    counts['not-enriched'] = (counts['not-enriched'] || 0) + 1;
    return;
  }
  const e = r.extracted || {};
  const v = r.verdict || {};
  counts[v.level || '?'] = (counts[v.level || '?'] || 0) + 1;

  const flags = [];
  if (isExcludedCountry(e.country)) flags.push('EXCL');
  if (r.extracted && !e.country) flags.push('NO-COUNTRY');
  if (e._company_name_source === 'domain_fallback') flags.push('NAME=DOMAIN');
  if (e._company_name_source === 'page_title') flags.push('TITLE-NAME');
  if (c) flags.push(c.contact_status === 'do_not_contact' ? 'DNC' : 'CORR');
  if (r.blockedMarker) flags.push('BLOCKED');
  if (r.deadMarker) flags.push(`DEAD(${r.deadMarker})`);
  if ((e._rejected_unverified_quotes || []).length) flags.push(`REJ ${e._rejected_unverified_quotes.length}`);
  if ((e._schema_drift || []).length) flags.push('DRIFT');
  if (r.error) flags.push('ERROR');

  const name = e.company_name + (e._company_name_source && e._company_name_source !== 'explicit' ? ` (${e._company_name_source})` : '');
  const country = e.country ? e.country + (e._country_source && e._country_source !== 'explicit' ? ` (${e._country_source})` : '') : null;

  lines.push(`| ${i + 1} | ${domain} | ${cell(v.level)} | ${clip(name, 40)} | ${clip(country, 28)} | ${cell(e.role)} | ${clip(e.type, 30)} | ${clip(e.category_general, 30)} | ${clip(e.category_specific, 60)} | ${clip(e.market, 30)} | ${flags.join(' ') || '—'} |`);

  if (opt.quotes) {
    const q = [];
    q.push(`### ${domain} — ${v.level}${v.reason ? `: ${v.reason}` : ''}`);
    q.push(`pages: ${(r.pagesFetched || []).map((p) => `${p.url} [${p.ok ? p.method : 'FAIL'}]`).join(', ') || '(none)'}`);
    for (const f of ['company_name', 'country', 'market', 'role', 'type', 'category_general', 'category_specific']) {
      if (e[f]) q.push(`- ${f}: ${e[f]}  ←  "${cell(e[`${f}_quote`])}"`);
    }
    for (const rej of e._rejected_unverified_quotes || []) q.push(`- REJECTED ${rej.field}=${rej.value}: ${rej.reason}`);
    if (c) q.push(`- corrections.js: ${JSON.stringify(c)}`);
    details.push(q.join('\n'));
  }
});

console.log(lines.join('\n'));
console.log(`\n${selected.length} domains — ` + Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') +
  ` | results: ${resultsPath} | corrections: ${correctionsPath ? Object.keys(corrections).length + ' loaded' : 'none'}`);
if (details.length) console.log('\n' + details.join('\n\n'));
