// Shared pieces of the list-import pipeline (dedupe -> enrich -> review ->
// insert). Kept deliberately small: CLI parsing, the per-list file names,
// CSV reading, corrections loading, the operator's exclusion rules, and the
// two SQL fragments that more than one script needs. The procedure itself is
// in README.md, not here.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');
const { envList } = require('./lib/env.js');

// ---------------------------------------------------------------- CLI

function parseCli({ options, allowPositionals = false, usage }) {
  const withHelp = { ...options, help: { type: 'boolean', short: 'h' } };
  let parsed;
  try {
    parsed = parseArgs({ options: withHelp, allowPositionals, strict: true });
  } catch (err) {
    console.error(err.message);
    console.error('\n' + usage);
    process.exit(1);
  }
  if (parsed.values.help) {
    console.log(usage);
    process.exit(0);
  }
  return parsed;
}

// ------------------------------------------------------ per-list files

// One place for the file names inside lists/<name>/. Everything except
// README.md and corrections.js is gitignored (see the repo .gitignore).
function listPaths(dir) {
  const p = (name) => path.join(dir, name);
  return {
    dir,
    list: p('list.csv'),
    alreadyContact: p('dedupe_already_contact.csv'),
    touched: p('dedupe_touched_company.csv'),
    known: p('dedupe_known_company.csv'),
    brandNewCompany: p('dedupe_brand_new_company.csv'),
    brandNewFreemail: p('dedupe_brand_new_freemail.csv'),
    excluded: p('dedupe_excluded.csv'),
    domains: p('dedupe_domains.txt'),
    lastBatch: p('last_batch.txt'),
    enrich: p('enrich.json'),
    corrections: p('corrections.js'),
    insertedKnown: p('inserted_known.csv'),
    excludedDnc: p('excluded_do_not_contact.csv'),
  };
}

// ------------------------------------------------------------------ CSV

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

// Read a CSV into objects keyed by lowercased header. Tolerates a BOM, CRLF,
// quoted fields and blank lines.
//
// Also reads the sectioned shape an earlier list used before dedupe.js
// learned to write two files: a preamble, then blocks each starting with a
// "--- <name> ---" line followed by its own header. Pass
// { section: 'company' | 'free' } to pick the block whose marker contains
// that word; with no marker in the file, the whole file is one block.
function readCsv(file, { section } = {}) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
  const markers = lines.map((l, i) => (l.startsWith('---') ? i : -1)).filter((i) => i !== -1);

  let block;
  if (!markers.length) {
    if (section) throw new Error(`${file} has no "--- section ---" markers, cannot select section "${section}"`);
    block = lines;
  } else {
    if (!section) throw new Error(`${file} is sectioned; pass { section: 'company' | 'free' }`);
    const start = markers.find((i) => lines[i].toLowerCase().includes(section));
    if (start === undefined) throw new Error(`no "--- ... ${section} ... ---" section in ${file}`);
    const end = markers.find((i) => i > start) ?? lines.length;
    block = lines.slice(start + 1, end);
  }
  if (!block.length) return [];

  const header = splitCsvLine(block[0]).map((h) => h.toLowerCase());
  return block.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

function writeCsv(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header + '\n' + rows.join('\n') + (rows.length ? '\n' : ''));
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ---------------------------------------------------------- corrections

// Columns a corrections.js entry may set. Anything else is a typo (seen:
// contact_status_detail without the s) and used to be silently spread into
// the row and ignored -- now it stops the run.
const CORRECTION_COLUMNS = new Set([
  'company_name', 'country', 'market', 'role', 'type', 'category_general', 'category_specific',
  'company_name_quote', 'country_quote', 'market_quote', 'role_quote', 'type_quote',
  'category_general_quote', 'category_specific_quote',
  'contact_status', 'contact_status_details', 'description',
]);
const CONTACT_STATUSES = new Set(['in_touch', 'do_not_contact', 'unsubscribed']);

function loadCorrections(file) {
  if (!file) return {};
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`corrections file not found: ${abs}`);
  const map = require(abs);
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`${abs} must export an object keyed by domain`);

  const problems = [];
  for (const [domain, entry] of Object.entries(map)) {
    if (domain !== domain.toLowerCase() || !domain.includes('.')) problems.push(`"${domain}": key must be a lowercase domain`);
    if (!entry || typeof entry !== 'object') { problems.push(`"${domain}": value must be an object`); continue; }
    for (const col of Object.keys(entry)) {
      if (!CORRECTION_COLUMNS.has(col)) problems.push(`"${domain}": unknown column "${col}"`);
    }
    if (entry.contact_status !== undefined && entry.contact_status !== null && !CONTACT_STATUSES.has(entry.contact_status)) {
      problems.push(`"${domain}": contact_status "${entry.contact_status}" not in ${[...CONTACT_STATUSES].join('/')}`);
    }
    if (entry.contact_status === 'do_not_contact' && !entry.contact_status_details) {
      problems.push(`"${domain}": do_not_contact needs a contact_status_details reason`);
    }
  }
  if (problems.length) {
    throw new Error(`corrections file ${abs} has problems:\n  ` + problems.join('\n  '));
  }
  return map;
}

// ------------------------------------------------------- owner's rules
//
// Markets the operator has decided not to sell into. Kept in .env, not in
// code, because the rule is a business decision, not a property of the data:
//
//   EXCLUDED_COUNTRIES  country names as extraction writes them ("Freedonia")
//                       -> insert_batch.js marks the company do_not_contact,
//                          review_table.js shows an EXCL flag
//   EXCLUDED_DOMAINS    domain suffixes ("fd", "mail.example") matched on
//                       both email addresses and bare domains
//                       -> dedupe.js and insert_free_domain_contacts.js drop
//                          the address before it is ever enriched
//
// Two mechanisms because they catch different things: a ccTLD is known
// before any fetch, the country only after extraction.

const EXCLUDED_COUNTRIES = new Set(envList('EXCLUDED_COUNTRIES'));
const EXCLUDED_DOMAINS = envList('EXCLUDED_DOMAINS');

function isExcludedCountry(country) {
  return !!country && EXCLUDED_COUNTRIES.has(String(country).trim().toLowerCase());
}

function isExcludedDomain(emailOrDomain) {
  const s = String(emailOrDomain || '').trim().toLowerCase();
  const domain = s.includes('@') ? s.split('@').pop() : s;
  return EXCLUDED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

// The operator's own domains turn up in shared contact lists and mailbox
// exports; never a lead. OWN_DOMAINS="example.com,example.org" in .env.
const OWN_DOMAINS = new Set(envList('OWN_DOMAINS'));

// ------------------------------------------------------------------ SQL

// companies.role has a CHECK accepting exactly 'buyer', 'seller' or
// 'buyer, seller'. Extraction sometimes writes the pair the other way round.
function canonicalRole(role) {
  if (!role || !/,/.test(role)) return role;
  const parts = role.split(',').map((v) => v.trim().toLowerCase());
  if (parts.includes('buyer') && parts.includes('seller')) return 'buyer, seller';
  return role;
}

// Append a source tag to companies.sources without duplicating it.
async function appendSource(client, companyKey, tag) {
  await client.query(
    `update companies
        set sources = case
          when sources is null then $1
          when sources like '%' || $1 || '%' then sources
          else sources || ', ' || $1
        end
      where company_key = $2`,
    [tag, companyKey]
  );
}

module.exports = {
  parseCli, listPaths, readCsv, writeCsv, readLines, splitCsvLine,
  loadCorrections, CORRECTION_COLUMNS,
  isExcludedCountry, isExcludedDomain, OWN_DOMAINS, canonicalRole, appendSource,
};
