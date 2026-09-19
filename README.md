# company-enrich

Turn a raw list of company domains or email addresses into CRM rows you can
trust: dedupe against what you already have, fetch each company's own
website, extract a handful of fields with an LLM, **verify every field
against a verbatim quote from the page**, put the batch in front of a human,
then insert in one transaction.

Built and run in production at a small B2B food-trading company, where
the address lists feed weekly offer mailings and a wrong "buyer/seller" or
country costs real sends. Node.js, Postgres, one npm dependency.

## The problem

Prospect lists arrive as scrapes, official register exports, exhibitor
lists, partner-shared contacts. Each is a pile of domains and addresses
with no reliable country, role or product line. Enriching them by hand at 2–3 minutes per company does
not scale past a few dozen; enriching them with an LLM alone produces
confident nonsense — a by-products trader described as a plant-protein
company because the wrong product page was read, a city recorded as a
country, a "producer" claim that appears nowhere on the site.

The pipeline exists to make LLM extraction *auditable*: every value carries
the exact text it was taken from, the code checks that text really is on the
page, and anything that fails is dropped rather than trusted.

## What it does

- **Dedupe first** (`dedupe.js`) — sorts an incoming list into five buckets
  against the database: already a contact, company already touched, company
  known but never touched, brand-new company, brand-new free-mail address.
  "Touched" means a logged send, not a row — a bare row is not a relationship.
- **Fetch with fallback** (`enrich.js`) — Jina Reader → Jina over plain
  HTTP → DataForSEO On-Page → direct fetch as a last resort, so the bulk of
  traffic never comes from the operator's own IP. Follows about/contact/
  products links, and on a splash page follows same-domain links instead.
- **Extract with proof** — one OpenRouter call returns 7 fields, each paired
  with a `*_quote` that must be a verbatim excerpt. The code normalises
  whitespace and checks every quote is a substring of the fetched text;
  unverified fields are rejected and listed separately in the result.
  Closed-set fields (role, type, category) are rejected if outside the set.
- **Never let the model use the domain as evidence** — the prompt forbids
  inferring country from the TLD. A separate, deterministic ccTLD fallback
  runs afterwards and labels its output `INFERRED`, so a guess never looks
  like a stated fact.
- **Verdict per company** — `good` / `thin` / `dead` / `blocked`. A 403 or
  CAPTCHA is *blocked*, not dead: the site is alive and refused us, which
  deserves a manual look. Thin results are retried once and the better of
  the two attempts is kept by score.
- **Review before insert** (`review_table.js`) — a Markdown table of the
  batch with flags (`NO-COUNTRY`, `NAME=DOMAIN`, `BLOCKED`, `REJ n`, …) and,
  with `--quotes`, the quote behind every value for spot-checking.
- **Operator overrides** (`lists/<name>/corrections.js`) — a per-list file
  of manual verdicts keyed by domain. Validated on load; a typo'd column name
  stops the run instead of being silently ignored.
- **Insert in one transaction** (`insert_batch.js` and friends) — dry-run by
  default, `--apply` to write. Business rules (own domains, excluded markets)
  live in `.env`, not in code.

## Numbers

| | |
|---|---|
| Domains processed on the first production run | 214 |
| Real bugs found and fixed during that run | 11 |
| Fetch sources, in fallback order | 3 (+ the plain-HTTP retry) |
| Fields extracted per company, each with a verbatim quote | 7 |
| Free-mail / ISP / directory domains that can never become a company key | 215 exact domains, plus 7 suffix patterns |
| Contacts that had silently merged under free-mail "companies" before that blocklist existed | 331 across 42 fake rows |
| Unrelated companies merged under directory/aggregator domains in one register import | 1,025 into 73 fake rows |

The verdict split (good/thin/dead/blocked) of the 214-domain run was not
kept — the results file is a per-list working file. See *What I would change*.

## What the first run taught

The 214-domain run was reviewed by eye, table by table. The fixes that came
out of it, generalised:

- **Stale reader cache.** The fetch proxy served a cached copy of a page that
  had since changed. Fixed with a no-cache header.
- **Navigation crowding out content.** On mega-menu sites the home page
  alone ran 40–150K characters of boilerplate and pushed the real "about us"
  text past the prompt budget. Now each page is capped and subpages go
  before the home page in the prompt.
- **Local-language country names rejected.** "Polska" was on the page,
  quoted correctly, and thrown away as "not a country" — losing a stated
  fact to the ccTLD guess. Added an alias table; only cities and regions are
  rejected now.
- **"The Netherlands"** rejected because of the article.
- **Schema drift.** The model sometimes answers with its own key names
  (`company_country`), which made every value look unverifiable. Now
  treated as a failed call and retried.
- **`seller, buyer`** passed the closed-set check and failed the Postgres
  CHECK constraint mid-batch. Canonicalised before insert.
- **List quotes joined with commas.** The instruction says `||`; the model
  often uses `, `. Added a comma fallback where every piece is still
  individually verified — no fragment is trusted without being on the page.
- **Splash pages.** A language chooser has no text and no about/contact
  links, so a live company was recorded as no-data. Now follows same-domain
  links when the home page is under 700 characters.
- **Page titles as company names.** `meat-products-1030x687.jpeg` and
  `ABOUT` were both used as a company name. A title is only trusted when at
  least one other field was found and it is neither a filename nor a nav
  label.
- **One dead subpage condemning a live site.** Liveness is judged on the
  home page only.
- **A worse retry replacing a better first attempt**, because the score
  counted category fields but not a stated country or name.

## How it works

```
input list (emails or domains)
        │
        ▼
  dedupe.js ──► lists/<name>/dedupe_*.csv  + dedupe_domains.txt (the queue)
        │
        ▼
  enrich.js --next 20 ──► lists/<name>/enrich.json  + last_batch.txt
        │      fetch: Jina → Jina/http → DataForSEO → direct
        │      extract: 1 OpenRouter call, 7 fields + 7 quotes
        │      verify: every quote ⊂ page text, closed sets, ccTLD fallback labelled
        │      verdict: good / thin (retry once) / dead / blocked
        ▼
  review_table.js ──► Markdown table + flags  (human reads it)
        │
        ▼
  lists/<name>/corrections.js  (operator's verdicts, keyed by domain)
        │
        ▼
  insert_batch.js --apply ──► companies + contacts, one transaction
  insert_new_contacts.js      (addresses for companies already known)
  insert_free_domain_contacts.js  (gmail & co. — contacts with no company row)
```

`lib/normalize.js` holds the one piece of domain knowledge the whole thing
rests on: which domains can never identify a company. Free-mail, national
ISP mailboxes, Italian certified email, social profiles, business
directories, registries. Every entry was added after it caused a real merge.

## Run it

You need: **Node.js 18+**, a **Postgres** database (local, Docker, or a
free hosted one), and API keys — **OpenRouter** (required, pay-per-call)
and **Jina Reader** (free tier is enough). DataForSEO is optional: without
it the fetch falls through to the next source. A terminal, no GUI.

```sh
cp .env.example .env                  # keys, Postgres, and your own rules
npm install                           # installs pg, nothing else
psql -d <your_database> -f schema.sql # three tables, one view

# input.csv: a header row with "domain" (optionally name, url, country)
node dedupe.js --list lists/demo --domains input.csv
node enrich.js --list lists/demo --next 20
node review_table.js --list lists/demo --quotes
#   ...edit lists/demo/corrections.js...
node insert_batch.js --list lists/demo --source demo          # dry run
node insert_batch.js --list lists/demo --source demo --apply
```

Every script prints `--help`. Every writing script is a dry run unless
`--apply` is given. `enrich.js` never writes to the database at all.

## What I would change

- **Keep a per-run summary somewhere permanent.** The verdict split of the
  first 214 domains is the number a reader most wants and it is gone,
  because the results file is a working file. One line per run appended to a
  log would have cost nothing.
- **Make the field definitions a config.** The prompt is written for one
  industry (meat and by-products); the mechanism — quote, verify, closed
  sets, labelled fallback — is not. Moving the field list and closed sets to
  a JSON file would make the same pipeline serve any B2B list.
- **Fixtures.** There are no tests. A dozen saved page dumps with expected
  output would let the verifier and the verdict logic be checked offline,
  which is where every one of the eleven bugs would have been caught.
- **A small worker pool.** Processing is sequential by design (readable
  logs, no rate-limit surprises). Past a few hundred domains that is the
  bottleneck; 3–4 workers would be the first change.
