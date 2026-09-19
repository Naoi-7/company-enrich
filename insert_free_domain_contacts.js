// Load a list's free-mail addresses (gmail, abv.bg, ISP mailboxes ...) into
// the database as company-less contacts. Dry-run by default; --apply writes.
//
//   node insert_free_domain_contacts.js --list <dir> --source <tag> [--emails <csv>] [--apply]
//
// Default input under --list: <dir>/dedupe_brand_new_freemail.csv. Also
// accepts the old sectioned list shape (the free section is picked
// automatically).
//
// These deliberately get NO companies row keyed on their domain. A company
// keyed "gmail.com" or "abv.bg" merges unrelated businesses into one fake
// company -- the failure NON_COMPANY_DOMAINS exists to prevent (42 such rows
// had absorbed 331 unrelated contacts before it was caught). A company-less
// contact is a supported shape: contacts.company_key is nullable. Giving a
// *verified* free-mail contact an email-keyed company row later is a
// different, post-verification step, outside this repo.
//
// Left unverified on purpose -- an email-verification step runs next and
// fills verification_status / _source / _checked_at. Pull the cohort with:
//   select * from contacts where sources = '<tag>' and company_key is null;
//
// Addresses on EXCLUDED_DOMAINS are skipped rather than loaded and then
// suppressed, because `contacts` has no contact_status field -- a
// company-less contact can only be deleted.

const fs = require('fs');
const { getClient } = require('./lib/db.js');
const { domainFromEmail, isNonCompanyDomain } = require('./lib/normalize.js');
const { parseCli, listPaths, readCsv, isExcludedDomain } = require('./common.js');

const USAGE = `usage: node insert_free_domain_contacts.js --list <dir> --source <tag> [--emails <csv>] [--apply]

  --list <dir>      lists/<name>/ -- supplies the default input
  --source <tag>    value written to contacts.sources
  --emails <csv>    email[,domain] rows, or the old sectioned file (default: <list>/dedupe_brand_new_freemail.csv)
  --apply           write. Without it: print what would be written, touch nothing`;

const { values: opt } = parseCli({
  usage: USAGE,
  options: { list: { type: 'string' }, source: { type: 'string' }, emails: { type: 'string' }, apply: { type: 'boolean' } },
});
if (!opt.source) { console.error('--source <tag> is required\n\n' + USAGE); process.exit(1); }
if (!opt.list && !opt.emails) { console.error('give --list <dir> or --emails <csv>\n\n' + USAGE); process.exit(1); }

const file = opt.emails || listPaths(opt.list).brandNewFreemail;
const rows = /^---/m.test(fs.readFileSync(file, 'utf8')) ? readCsv(file, { section: 'free' }) : readCsv(file);
const emails = [...new Set(rows.map((r) => (r.email || '').toLowerCase()).filter((e) => e.includes('@')))];

// Guard: everything here must be on a non-company domain. Anything that
// isn't was mis-filed and deserves a companies row -- stop rather than
// quietly insert it company-less.
const misfiled = emails.filter((e) => { const d = domainFromEmail(e); return d && !isNonCompanyDomain(d); });
if (misfiled.length) {
  console.error('Refusing to run -- these are NOT free-mail domains and belong in the company flow:');
  misfiled.forEach((e) => console.error('  ' + e));
  process.exit(1);
}

(async () => {
  const excluded = emails.filter(isExcludedDomain);
  const wanted = emails.filter((e) => !isExcludedDomain(e));

  const client = await getClient();
  const existing = wanted.length
    ? await client.query('select lower(email) as email from contacts where lower(email) = any($1)', [wanted])
    : { rows: [] };
  const have = new Set(existing.rows.map((r) => r.email));
  const toInsert = wanted.filter((e) => !have.has(e));

  console.log(`source: ${opt.source} | ${opt.apply ? 'APPLY' : 'dry run'} | input: ${file}`);
  console.log(`${emails.length} free-domain addresses, ${excluded.length} skipped (EXCLUDED_DOMAINS), ${have.size} already in contacts, ${toInsert.length} to insert.`);

  if (!opt.apply) {
    console.log(toInsert.slice(0, 10).map((e) => '  + ' + e).join('\n') + (toInsert.length > 10 ? `\n  ... and ${toInsert.length - 10} more` : ''));
    console.log('\nDry run -- nothing written. Re-run with --apply to write.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const email of toInsert) {
      await client.query('insert into contacts (email, company_key, sources) values ($1, null, $2)', [email, opt.source]);
    }
    await client.query('COMMIT');
    console.log(`\n${toInsert.length} contacts inserted (company_key null, sources=${opt.source}).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nROLLBACK -- nothing written:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
