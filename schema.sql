-- Minimal schema for company-enrich. Three tables and one view -- exactly what
-- the scripts read and write, nothing more. Drop it into an existing CRM
-- database or start from it; the column names are what the scripts expect.

CREATE TABLE IF NOT EXISTS companies (
  company_key            text PRIMARY KEY,   -- the company's own domain (see lib/normalize.js for what never qualifies)
  company_name           text NOT NULL,
  country                text,
  type                   text,               -- producer / trader / importer / exporter / wholesaler / coldstore / packer / other, comma-separated
  role                   text CHECK (role IN ('buyer', 'seller', 'buyer, seller')),
  category_general       text,               -- meat / seafood / fruit / vegetable / other, comma-separated
  category_specific      text,               -- free text: the actual products named on the site
  market                 text,               -- operator's own segment tags (MARKET_TAGS in .env)
  sources                text,               -- comma-separated provenance tags, additive, never rewritten
  key_type               text CHECK (key_type IN ('domain', 'name')),
  status                 text CHECK (status IN ('processed', 'unprocessed')),
  contact_status         text CHECK (contact_status IN ('in_touch', 'do_not_contact', 'unsubscribed')),
  contact_status_details text,               -- always filled when contact_status is a blocking value
  description            text
);

CREATE TABLE IF NOT EXISTS contacts (
  id          serial PRIMARY KEY,
  email       text NOT NULL,
  company_key text REFERENCES companies (company_key),  -- NULL for a free-mail address with no company behind it
  sources     text
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_lower ON contacts (lower(email));

-- One row per touch (a send, a bounce, a reply). dedupe.js does not read this
-- table directly, only the view below -- but the view needs it to exist.
CREATE TABLE IF NOT EXISTS outreach_log (
  id          serial PRIMARY KEY,
  company_key text REFERENCES companies (company_key),
  contact_email text,
  status      text CHECK (status IN ('sent', 'bounced', 'replied', 'inbound')),
  event_date  date
);

-- "Have we ever actually reached out to this company?" A companies row on its
-- own proves nothing -- it may be a bare scrape or a merge. A logged touch is
-- the real signal, which is why dedupe.js buckets on touch_count, not on
-- whether the row exists.
CREATE OR REPLACE VIEW company_activity AS
SELECT
  c.company_key,
  (SELECT count(*) FROM outreach_log t WHERE t.company_key = c.company_key)                        AS touch_count,
  EXISTS (SELECT 1 FROM outreach_log r WHERE r.company_key = c.company_key AND r.status = 'replied') AS has_replied
FROM companies c;
