// Classify a raw list against the database before anything is enriched or
// inserted. Reads the database, writes CSVs into lists/<name>/, never writes
// to the database. Re-running after inserts shrinks the brand-new set -- that
// is how a half-finished list is resumed.
//
//   node dedupe.js --list <dir> --emails <csv>    email list (header: email[,...])
//   node dedupe.js --list <dir> --domains <csv>   scrape list (header: domain[,name][,url][,country])
//
// Buckets (see the summary printed at the end):
//   already_contact   this exact address is already in `contacts`      (email mode)
//   touched_company   the company has a real touch in company_activity  -> insert_new_contacts.js
//   known_company     a companies row exists but was never touched       -> insert_new_contacts.js
//   brand_new_company domain unseen: the enrichment queue                -> enrich.js
//   brand_new_freemail free-mail address, no company behind it           -> insert_free_domain_contacts.js
//   excluded          own domain, excluded domain, non-company domain, unparsable
//
// company_activity.touch_count is the real "have we ever reached out"
// signal -- a companies row on its own can be a bare scrape/merge row with
// no send ever logged against it, which is not a relationship.

const fs = require('fs');
const { getClient } = require('./lib/db.js');
const { domainFromEmail, domainFromUrl, isNonCompanyDomain } = require('./lib/normalize.js');
const { parseCli, listPaths, readCsv, writeCsv, isExcludedDomain, OWN_DOMAINS } = require('./common.js');

const USAGE = `usage: node dedupe.js --list <dir> (--emails <csv> | --domains <csv>)

  --list <dir>      lists/<name>/ -- created if missing; outputs land here
  --emails <csv>    email list, header must contain "email" (other columns ignored)
  --domains <csv>   scrape list, header domain[,name][,url][,country]; domain may be
                    empty when url is given`;

const { values: opt } = parseCli({
  usage: USAGE,
  options: { list: { type: 'string' }, emails: { type: 'string' }, domains: { type: 'string' } },
});
if (!opt.list) { console.error('--list <dir> is required\n\n' + USAGE); process.exit(1); }
if (!opt.emails === !opt.domains) { console.error('give exactly one of --emails / --domains\n\n' + USAGE); process.exit(1); }

const L = listPaths(opt.list);
const mode = opt.emails ? 'email' : 'domain';
const csvQuote = (v) => (/[",\n]/.test(v || '') ? `"${String(v).replace(/"/g, '""')}"` : (v || ''));

// ---- read and normalise the input -----------------------------------------
const excluded = []; // `${value},${reason}`
const items = [];    // email mode: { email, domain } ; domain mode: { domain, name, url, country }

if (mode === 'email') {
  const seen = new Set();
  for (const row of readCsv(opt.emails)) {
    const email = (row.email || '').toLowerCase();
    if (!email) continue;
    if (!email.includes('@') || !domainFromEmail(email)) { excluded.push(`${email},unparsable`); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    const domain = domainFromEmail(email);
    if (OWN_DOMAINS.has(domain)) { excluded.push(`${email},own_domain`); continue; }
    if (isExcludedDomain(email)) { excluded.push(`${email},excluded_domain`); continue; }
    items.push({ email, domain });
  }
} else {
  const seen = new Set();
  for (const row of readCsv(opt.domains)) {
    const domain = (row.domain || domainFromUrl(row.url) || '').toLowerCase();
    const label = domain || row.url || row.name || '(empty row)';
    if (!domain) { excluded.push(`${csvQuote(label)},unparsable`); continue; }
    if (seen.has(domain)) continue;
    seen.add(domain);
    if (OWN_DOMAINS.has(domain)) { excluded.push(`${domain},own_domain`); continue; }
    if (isExcludedDomain(domain)) { excluded.push(`${domain},excluded_domain`); continue; }
    // A scrape's "website" column is often a facebook page or a directory
    // listing -- that is not the company's own domain and must not become
    // a company_key.
    if (isNonCompanyDomain(domain)) { excluded.push(`${domain},non_company_domain`); continue; }
    items.push({ domain, name: row.name || '', url: row.url || '', country: row.country || '' });
  }
}

(async () => {
  const client = await getClient();

  const existing = await client.query('select lower(email) as email from contacts');
  const knownEmails = new Set(existing.rows.map((r) => r.email));
  const activity = await client.query('select company_key, touch_count, has_replied from company_activity');
  const activityByDomain = new Map(activity.rows.map((r) => [r.company_key, r]));
  const companies = await client.query('select company_key from companies');
  const knownDomains = new Set(companies.rows.map((r) => r.company_key));
  await client.end();

  const alreadyContact = [];
  const touched = [];
  const known = [];
  const brandNewCompany = [];
  const brandNewFreemail = [];

  for (const it of items) {
    if (mode === 'email' && knownEmails.has(it.email)) { alreadyContact.push(it.email); continue; }

    const realCompanyDomain = !isNonCompanyDomain(it.domain);
    const act = realCompanyDomain ? activityByDomain.get(it.domain) : null;
    const rowText = mode === 'email'
      ? `${it.email},${it.domain}`
      : [it.domain, it.name, it.url, it.country].map(csvQuote).join(',');

    if (act && Number(act.touch_count) > 0) touched.push(`${rowText},${act.touch_count},${act.has_replied}`);
    else if (realCompanyDomain && knownDomains.has(it.domain)) known.push(rowText);
    else if (realCompanyDomain) brandNewCompany.push(rowText);
    else brandNewFreemail.push(rowText); // email mode only -- domain mode excluded these above
  }

  const byDomain = (a, b) => a.split(',')[1].localeCompare(b.split(',')[1]) || a.localeCompare(b);
  if (mode === 'email') { brandNewCompany.sort(byDomain); brandNewFreemail.sort(byDomain); }
  else brandNewCompany.sort();

  const domainOf = (line) => (mode === 'email' ? line.split(',')[1] : line.split(',')[0]);
  const queue = [...new Set(brandNewCompany.map(domainOf))].sort();

  fs.mkdirSync(L.dir, { recursive: true });
  const rowHeader = mode === 'email' ? 'email,domain' : 'domain,name,url,country';
  if (mode === 'email') writeCsv(L.alreadyContact, 'email', alreadyContact);
  writeCsv(L.touched, `${rowHeader},touch_count,has_replied`, touched);
  writeCsv(L.known, rowHeader, known);
  writeCsv(L.brandNewCompany, rowHeader, brandNewCompany);
  if (mode === 'email') writeCsv(L.brandNewFreemail, rowHeader, brandNewFreemail);
  writeCsv(L.excluded, 'value,reason', excluded);
  fs.writeFileSync(L.domains, queue.join('\n') + (queue.length ? '\n' : ''));

  const total = items.length + excluded.length;
  console.log(`Mode: ${mode} | input rows after de-duplication: ${total}`);
  console.log(`Excluded: ${excluded.length}` + (excluded.length ? ` (${summarise(excluded)})` : ''));
  if (mode === 'email') console.log(`Already a contact in the database: ${alreadyContact.length}`);
  console.log(`Company already touched (real prior relationship): ${touched.length}`);
  console.log(`Company row exists but never touched: ${known.length}`);
  console.log(`Brand new company domain: ${brandNewCompany.length} rows, ${queue.length} unique domains -> ${L.domains}`);
  if (mode === 'email') console.log(`Brand new free-mail address (no company behind it): ${brandNewFreemail.length}`);
  console.log(`\nOutputs in ${L.dir}/ (dedupe_*.csv, dedupe_domains.txt). Nothing written to the database.`);
})();

function summarise(rows) {
  const counts = {};
  for (const r of rows) { const reason = r.split(',').pop(); counts[reason] = (counts[reason] || 0) + 1; }
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}
