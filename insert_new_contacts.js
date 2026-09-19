// Merge the "some prior relationship" part of a list into the database:
// addresses whose company we have already touched, or whose company row
// already exists. Inserts the contact and appends the source tag to the company.
// Dry-run by default; --apply writes, in one transaction.
//
//   node insert_new_contacts.js --list <dir> --source <tag> [--touched <csv>] [--known <csv>] [--apply]
//
// Defaults under --list: <dir>/dedupe_touched_company.csv and
// <dir>/dedupe_known_company.csv (a missing file counts as empty). Rows with
// an email insert a contact; rows with only a domain (domain-mode lists)
// just get the source tag appended to the company. Companies already at
// do_not_contact / unsubscribed are left alone entirely -- no point adding
// a name to a company we have decided not to mail.

const fs = require('fs');
const { getClient } = require('./lib/db.js');
const { parseCli, listPaths, readCsv, writeCsv, appendSource } = require('./common.js');

const USAGE = `usage: node insert_new_contacts.js --list <dir> --source <tag> [--touched <csv>] [--known <csv>] [--apply]

  --list <dir>       lists/<name>/ -- supplies the two defaults below and receives the reports
  --source <tag>     value written to contacts.sources and appended to companies.sources
  --touched <csv>    email/domain rows for companies with a real touch (default: <list>/dedupe_touched_company.csv)
  --known <csv>      rows for companies that exist but were never touched (default: <list>/dedupe_known_company.csv)
  --apply            write. Without it: print what would be written, touch nothing`;

const { values: opt } = parseCli({
  usage: USAGE,
  options: {
    list: { type: 'string' }, source: { type: 'string' },
    touched: { type: 'string' }, known: { type: 'string' }, apply: { type: 'boolean' },
  },
});
if (!opt.source) { console.error('--source <tag> is required\n\n' + USAGE); process.exit(1); }
if (!opt.list && !opt.touched && !opt.known) { console.error('give --list <dir>, or --touched/--known files\n\n' + USAGE); process.exit(1); }

const L = opt.list ? listPaths(opt.list) : null;
const files = [opt.touched || (L && L.touched), opt.known || (L && L.known)].filter(Boolean);

const candidates = [];
for (const file of files) {
  if (!fs.existsSync(file)) { console.log(`(no file ${file} -- treated as empty)`); continue; }
  for (const row of readCsv(file)) {
    const domain = (row.domain || '').toLowerCase();
    if (!domain) continue;
    candidates.push({ email: (row.email || '').toLowerCase() || null, domain });
  }
}

(async () => {
  const client = await getClient();

  const dnc = await client.query(`select company_key from companies where contact_status in ('do_not_contact', 'unsubscribed')`);
  const dncDomains = new Set(dnc.rows.map((r) => r.company_key));
  const emails = candidates.map((c) => c.email).filter(Boolean);
  const have = emails.length
    ? new Set((await client.query('select lower(email) as email from contacts where lower(email) = any($1)', [emails])).rows.map((r) => r.email))
    : new Set();

  const excluded = candidates.filter((c) => dncDomains.has(c.domain));
  const eligible = candidates.filter((c) => !dncDomains.has(c.domain));
  const toInsert = eligible.filter((c) => c.email && !have.has(c.email));
  const alreadyPresent = eligible.filter((c) => c.email && have.has(c.email));
  const tagOnly = eligible.filter((c) => !c.email);
  const companiesToTag = [...new Set(eligible.map((c) => c.domain))];

  console.log(`source: ${opt.source} | ${opt.apply ? 'APPLY' : 'dry run'}`);
  console.log(`Candidates: ${candidates.length}`);
  const shown = excluded.slice(0, 12).map((c) => c.email || c.domain).join(', ');
  console.log(`Excluded (company do_not_contact/unsubscribed): ${excluded.length}` +
    (excluded.length ? ` -- ${shown}${excluded.length > 12 ? `, ... and ${excluded.length - 12} more` : ''}` : ''));
  console.log(`Already in contacts (kept as they are): ${alreadyPresent.length}`);
  console.log(`Domain-only rows (source tag appended, no contact): ${tagOnly.length}`);
  console.log(`Contacts to insert: ${toInsert.length}`);
  console.log(`Companies to tag with the source: ${companiesToTag.length}`);
  for (const c of toInsert) console.log(`  + ${c.email} -> ${c.domain}`);

  if (!opt.apply) {
    console.log('\nDry run -- nothing written. Re-run with --apply to write.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const { email, domain } of toInsert) {
      await client.query('insert into contacts (email, company_key, sources) values ($1, $2, $3)', [email, domain, opt.source]);
    }
    for (const domain of companiesToTag) await appendSource(client, domain, opt.source);
    await client.query('COMMIT');
    console.log(`\nInserted ${toInsert.length} contacts; source appended on ${companiesToTag.length} companies.`);

    if (L) {
      writeCsv(L.insertedKnown, 'email,domain', toInsert.map((c) => `${c.email},${c.domain}`));
      writeCsv(L.excludedDnc, 'email,domain', excluded.map((c) => `${c.email || ''},${c.domain}`));
      console.log(`Reports: ${L.insertedKnown}, ${L.excludedDnc}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nROLLBACK -- nothing written:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
