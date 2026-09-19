// Insert a reviewed batch of enrich.js results into the database: one
// companies row per domain, and (for email lists) one contacts row per
// address found for that domain. Dry-run by default; --apply writes, in one
// transaction.
//
// Only run this after the batch has been reviewed (review_table.js) and the
// operator's verdicts are in the list's corrections.js -- see README.md.
//
//   node insert_batch.js --list <dir> --source <tag> [--batch <file> | domain ... | --all]
//                        [--results <json>] [--emails <csv>] [--domains <csv>]
//                        [--corrections <js>] [--apply]
//
// --list supplies the defaults: <dir>/enrich.json, <dir>/corrections.js (if
// present), <dir>/last_batch.txt as the selection, and the email/domain mode
// from the header of <dir>/dedupe_brand_new_company.csv. Every default can
// be overridden with an explicit path.

const fs = require('fs');
const path = require('path');
const { getClient } = require('./lib/db.js');
const { domainFromEmail } = require('./lib/normalize.js');
const {
  parseCli, listPaths, readCsv, readLines, loadCorrections, canonicalRole, isExcludedCountry,
} = require('./common.js');

const USAGE = `usage: node insert_batch.js --list <dir> --source <tag> [--batch <file> | domain ... | --all]
                          [--results <json>] [--emails <csv>] [--domains <csv>] [--corrections <js>] [--apply]

  --list <dir>         lists/<name>/ -- supplies defaults for everything below
  --source <tag>       value written to companies.sources / contacts.sources (required)
  --batch <file>       domains to insert, one per line (default: <list>/last_batch.txt)
  domain ...           insert just these (a re-run after a fix)
  --all                every domain in the results file (only when all have been reviewed)
  --results <json>     enrich.js output (default: <list>/enrich.json)
  --emails <csv>       email[,domain] rows, or the old sectioned file -- email mode
  --domains <csv>      domain[,name][,url][,country] rows -- domain-only mode, no contacts
  --corrections <js>   per-list overrides (default: <list>/corrections.js if it exists)
  --apply              write. Without it: print what would be written, touch nothing`;

const { values: opt, positionals } = parseCli({
  usage: USAGE,
  allowPositionals: true,
  options: {
    list: { type: 'string' },
    source: { type: 'string' },
    batch: { type: 'string' },
    all: { type: 'boolean' },
    results: { type: 'string' },
    emails: { type: 'string' },
    domains: { type: 'string' },
    corrections: { type: 'string' },
    apply: { type: 'boolean' },
  },
});

function fail(msg) { console.error(msg + '\n\n' + USAGE); process.exit(1); }

if (!opt.source) fail('--source <tag> is required');
if (!opt.list && !opt.results) fail('give --list <dir> or --results <json>');
if (opt.emails && opt.domains) fail('--emails and --domains are mutually exclusive');

const L = opt.list ? listPaths(opt.list) : null;
const resultsPath = opt.results || L.enrich;
const correctionsPath = opt.corrections || (L && fs.existsSync(L.corrections) ? L.corrections : null);

// A sectioned file (an older list shape) needs a section picked; a plain
// file is read whole.
function readRows(file, section) {
  return /^---/m.test(fs.readFileSync(file, 'utf8')) ? readCsv(file, { section }) : readCsv(file);
}

// ---- which mode, and where the emails / names come from ----------------
let mode; // 'email' | 'domain'
let emailsByDomain = new Map();
let listByDomain = new Map(); // domain -> { name, url, country } (domain mode)

if (opt.emails) mode = 'email';
else if (opt.domains) mode = 'domain';
else if (L && fs.existsSync(L.brandNewCompany)) {
  const header = fs.readFileSync(L.brandNewCompany, 'utf8').split(/\r?\n/)[0].toLowerCase();
  mode = header.split(',').map((h) => h.trim()).includes('email') ? 'email' : 'domain';
} else {
  mode = 'domain';
  console.log('note: no --emails/--domains and no dedupe_brand_new_company.csv -- domain-only mode, no email or name source');
}

if (mode === 'email') {
  const file = opt.emails || L.brandNewCompany;
  for (const row of readRows(file, 'company')) {
    const email = (row.email || '').toLowerCase();
    if (!email.includes('@')) continue;
    const domain = (row.domain || domainFromEmail(email) || '').toLowerCase();
    if (!domain) continue;
    if (!emailsByDomain.has(domain)) emailsByDomain.set(domain, new Set());
    emailsByDomain.get(domain).add(email);
  }
} else {
  const file = opt.domains || (L && fs.existsSync(L.brandNewCompany) ? L.brandNewCompany : null);
  if (file) {
    for (const row of readRows(file, 'company')) {
      const domain = (row.domain || '').toLowerCase();
      if (domain) listByDomain.set(domain, { name: row.name || '', url: row.url || '', country: row.country || '' });
    }
  }
}

// ---- which domains -------------------------------------------------------
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const byDomain = new Map(results.map((r) => [r.domain, r]));

let selected;
if (positionals.length) selected = positionals.map((d) => d.toLowerCase());
else if (opt.batch) selected = readLines(opt.batch);
else if (opt.all) selected = results.map((r) => r.domain);
else if (L && fs.existsSync(L.lastBatch)) selected = readLines(L.lastBatch);
else fail('nothing selected: pass domains, --batch <file>, or --all (one enrich.json holds every batch -- inserting all of it would include unreviewed rows)');

const corrections = loadCorrections(correctionsPath);

// ---- owner's rules applied at insert time -------------------------------
// A company in an EXCLUDED_COUNTRIES market is written, but as
// do_not_contact, so the record exists and never reaches a mailing list.
// Deterministic, and visible as the EXCL flag in review_table.js before this
// ever runs. A corrections.js entry that sets contact_status wins.
function excludedCountryRule(e, correction) {
  if (isExcludedCountry(e.country) && !correction.contact_status) {
    return { contact_status: 'do_not_contact', contact_status_details: `${e.country} -- excluded market (EXCLUDED_COUNTRIES).` };
  }
  return {};
}

// Domain-mode lists carry a name and sometimes a country from the catalogue.
// The name is used only when extraction fell back to the domain or to a page
// <title> (enrich.js itself calls the title "structural metadata, not a
// claim"). The country only when extraction found nothing at all -- a
// catalogue's country column is a stated fact, not a TLD/language guess.
// Both are marked so the review table shows where they came from.
function listOverrides(e, row) {
  if (!row) return {};
  const out = {};
  const nameSrc = e._company_name_source;
  if (row.name && (nameSrc === 'domain_fallback' || nameSrc === 'page_title' || !e.company_name)) {
    out.company_name = row.name;
    out._company_name_source = 'list';
  }
  if (row.country && !e.country) {
    out.country = row.country;
    out._country_source = 'list';
  }
  return out;
}

(async () => {
  const client = await getClient();
  console.log(`mode: ${mode}${mode === 'domain' ? ' (domain-only: no contacts will be written)' : ''} | source: ${opt.source} | results: ${resultsPath} | corrections: ${correctionsPath ? `${Object.keys(corrections).length} loaded` : 'none'} | ${opt.apply ? 'APPLY' : 'dry run'}`);
  console.log(`selected: ${selected.length} domain(s)\n`);

  const plan = []; // { domain, e, emails }
  const notes = { missing: 0, noExtraction: 0, existing: 0 };

  for (const domain of selected) {
    const r = byDomain.get(domain);
    if (!r) { console.log('MISSING (not enriched):', domain); notes.missing++; continue; }
    const correction = corrections[domain] || {};
    if (!r.extracted && !correction.contact_status) {
      console.log('SKIP (no extraction, no override -- add a do_not_contact reason to corrections.js if the site is dead):', domain);
      notes.noExtraction++;
      continue;
    }
    const existing = await client.query('select 1 from companies where company_key = $1', [domain]);
    if (existing.rows.length) { console.log('SKIP (already in companies):', domain); notes.existing++; continue; }

    const extracted = r.extracted || {};
    const base = { company_name: domain, ...extracted };
    const e = { ...base, ...listOverrides(base, listByDomain.get(domain)), ...excludedCountryRule(base, correction), ...correction };
    e.role = canonicalRole(e.role);

    let emails = [];
    if (mode === 'email' && e.contact_status !== 'do_not_contact') {
      const found = [...(emailsByDomain.get(domain) || [])];
      if (found.length) {
        const have = await client.query('select lower(email) as email from contacts where lower(email) = any($1)', [found]);
        const present = new Set(have.rows.map((x) => x.email));
        emails = found.filter((em) => !present.has(em));
        const dup = found.length - emails.length;
        if (dup) console.log(`  note: ${dup} address(es) for ${domain} already in contacts, skipped`);
      }
    }
    plan.push({ domain, e, emails });

    const src = (k) => (e[`_${k}_source`] ? ` [${e[`_${k}_source`]}]` : '');
    const status = e.contact_status ? ` | ${e.contact_status}: ${e.contact_status_details || ''}` : '';
    console.log(`WRITE ${domain} | ${e.company_name}${src('company_name')} | ${e.country || '-'}${src('country')} | role=${e.role || '-'} | type=${e.type || '-'} | ${e.category_general || '-'} / ${e.category_specific || '-'} | market=${e.market || '-'}${status}`);
    if (emails.length) console.log(`      contacts: ${emails.join(', ')}`);
  }

  const contactsPlanned = plan.reduce((n, p) => n + p.emails.length, 0);
  console.log(`\n${plan.length} companies to write, ${contactsPlanned} contacts to write` +
    ` (${notes.missing} missing, ${notes.noExtraction} no extraction, ${notes.existing} already in companies)`);

  if (!opt.apply) {
    console.log('\nDry run -- nothing written. Re-run with --apply to write.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const { domain, e, emails } of plan) {
      await client.query(
        `insert into companies (company_key, company_name, country, type, role, category_general, category_specific, market, sources, key_type, status, contact_status, contact_status_details, description)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'domain', 'processed', $10, $11, $12)`,
        [domain, e.company_name, e.country || null, e.type || null, e.role || null, e.category_general || null, e.category_specific || null,
          e.market || null, opt.source, e.contact_status || null, e.contact_status_details || null, e.description || null]
      );
      for (const email of emails) {
        await client.query('insert into contacts (email, company_key, sources) values ($1, $2, $3)', [email, domain, opt.source]);
      }
    }
    await client.query('COMMIT');
    console.log(`\nWritten: ${plan.length} companies, ${contactsPlanned} contacts.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nROLLBACK -- nothing written:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
