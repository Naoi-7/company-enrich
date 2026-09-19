// Fetch a company's own website (Jina Reader -> DataForSEO On-Page -> direct
// fetch), extract country/role/type/category via one OpenRouter call with a
// verbatim quote behind every field, verify every quote against the page,
// and write the results to a local JSON file for review.
// Does NOT write to the database -- a human reviews the batch first
// (review_table.js), then insert_batch.js writes it.

const fs = require('fs');
const path = require('path');
require('./lib/env.js');
const { isNonCompanyDomain, domainFromUrl } = require('./lib/normalize.js');

// Infrastructure domains that show up in nav/footer links but are never the
// company's own content -- cookie-consent widgets, hosting-provider default
// pages, etc. Extends normalize.js's freemail/social/directory blocklist,
// which already covers facebook/linkedin/twitter/instagram.
const NON_CONTENT_DOMAINS = new Set(['cookiedatabase.org', 'cookiebot.com', 'onetrust.com', 'trustarc.com', 'iubenda.com', 'help.ovhcloud.com', 'ovhcloud.com']);

const ABOUT_WORDS = ['about', 'über', 'uber', 'a-propos', 'apropos', 'sobre', 'chi-siamo', 'chisiamo', 'company', 'profile', 'o-nas', 'onas', 'o-firmie', 'o-nama', 'wie-zijn-we', 'wie zijn we', 'wie-wij-zijn'];
const CONTACT_WORDS = ['contact', 'kontakt', 'contacto', 'contactez', 'kontaktai', 'kontakty'];
// Product-page words. Deliberately broad: a company often splits its range
// across several pages, and the interesting one for us is rarely called
// "products" -- one German trader listed its animal proteins under /petfood/
// while /plant-based-protein-raw-materials/ was what matched "product", so the
// run described a pet food offal trader as a plant-protein company (2026-09-08).
const PRODUCTS_WORDS = ['product', 'produkt', 'produit', 'produs', 'produto', 'prodotti', 'proizvod', 'oferta', 'services', 'petfood', 'pet-food', 'pet food', 'feed', 'futtermittel', 'rohstoffe', 'raw-material', 'raw material', 'sortiment', 'assortment', 'range'];

// Deterministic fallback only -- not an LLM guess. A company's OWN domain
// ccTLD is a real signal (unlike a personal email's TLD): companies
// overwhelmingly register under their home country's ccTLD. Used only when
// nothing explicit was found in the page text, and always marked as
// domain-inferred in the output so it's never confused with a stated fact.
const CCTLD_COUNTRY = {
  es: 'Spain', pt: 'Portugal', fr: 'France', de: 'Germany', it: 'Italy', nl: 'Netherlands',
  be: 'Belgium', at: 'Austria', ch: 'Switzerland', dk: 'Denmark', se: 'Sweden', no: 'Norway',
  fi: 'Finland', ee: 'Estonia', lv: 'Latvia', lt: 'Lithuania', pl: 'Poland', cz: 'Czech Republic',
  sk: 'Slovakia', hu: 'Hungary', ro: 'Romania', bg: 'Bulgaria', gr: 'Greece', hr: 'Croatia',
  si: 'Slovenia', rs: 'Serbia', ba: 'Bosnia and Herzegovina', mk: 'North Macedonia', al: 'Albania',
  me: 'Montenegro', md: 'Moldova', ua: 'Ukraine', tr: 'Turkey', cy: 'Cyprus', mt: 'Malta',
  lu: 'Luxembourg', is: 'Iceland', ie: 'Ireland', uk: 'United Kingdom', za: 'South Africa',
  ph: 'Philippines', th: 'Thailand', my: 'Malaysia', cn: 'China', hk: 'Hong Kong', us: 'United States', au: 'Australia',
};
const VALID_COUNTRIES = new Set([
  ...Object.values(CCTLD_COUNTRY),
  'United States', 'United States of America', 'USA', 'United Kingdom', 'UK',
  'United Arab Emirates', 'Czechia', 'Macedonia', 'Republic of North Macedonia',
]);

// A country stated in its own local-language form (found verbatim on a site
// written in that language) is just as real as the English spelling -- only
// cities/regions should get rejected. Found 2026-09-07 on a Polish site: the
// model correctly quoted "Polska" (real, on-page) but it got treated as
// invalid alongside actual city names like "Praha"/"Olsztyn", losing a real
// explicit statement to the ccTLD guess instead. Maps local name -> English.
const COUNTRY_ALIASES = {
  polska: 'Poland', deutschland: 'Germany', 'espana': 'Spain', 'españa': 'Spain',
  italia: 'Italy', nederland: 'Netherlands', belgie: 'Belgium', 'belgië': 'Belgium',
  belgique: 'Belgium', osterreich: 'Austria', 'österreich': 'Austria', schweiz: 'Switzerland',
  suisse: 'Switzerland', svizzera: 'Switzerland', danmark: 'Denmark', sverige: 'Sweden',
  norge: 'Norway', suomi: 'Finland', eesti: 'Estonia', latvija: 'Latvia', lietuva: 'Lithuania',
  'ceska republika': 'Czech Republic', 'česká republika': 'Czech Republic', cesko: 'Czech Republic',
  'česko': 'Czech Republic', slovensko: 'Slovakia', magyarorszag: 'Hungary', 'magyarország': 'Hungary',
  romania: 'Romania', 'românia': 'Romania', bulgaria: 'Bulgaria', 'българия': 'Bulgaria',
  balgariya: 'Bulgaria', grecia: 'Greece', 'ελλάδα': 'Greece', ellada: 'Greece', hrvatska: 'Croatia',
  slovenija: 'Slovenia', srbija: 'Serbia', 'srbija ': 'Serbia', 'bosna i hercegovina': 'Bosnia and Herzegovina',
  makedonija: 'North Macedonia', 'северна македонија': 'North Macedonia', shqiperia: 'Albania',
  'shqipëria': 'Albania', 'crna gora': 'Montenegro', moldova: 'Moldova', ukraina: 'Ukraine',
  'україна': 'Ukraine', turkiye: 'Turkey', 'türkiye': 'Turkey', eire: 'Ireland', 'éire': 'Ireland',
  // Everyday names for the same state, as companies actually write them.
  holland: 'Netherlands', 'great britain': 'United Kingdom', england: 'United Kingdom',
  scotland: 'United Kingdom', wales: 'United Kingdom', 'northern ireland': 'United Kingdom',
  'republic of ireland': 'Ireland', 'u.k.': 'United Kingdom', 'u.s.a.': 'United States',
  'united states of america': 'United States', deutchland: 'Germany',
};
// Canonical spelling for any accepted country, keyed lowercase -- so "SPAIN",
// "spain" and "Spain" all resolve, instead of only the exact stored casing.
const CANONICAL_COUNTRY = new Map([...VALID_COUNTRIES].map((c) => [c.toLowerCase(), c]));

function normalizeCountry(raw) {
  if (!raw) return raw;
  // Drop a leading article: "The Netherlands" is how Dutch sites write it, and
  // it was being rejected as a non-country (found 2026-09-07 on a Dutch
  // site whose footer reads "<town>, The Netherlands").
  const key = raw.trim().toLowerCase().replace(/^the\s+/, '');
  return COUNTRY_ALIASES[key] || CANONICAL_COUNTRY.get(key) || raw;
}

function countryFromCcTld(domain) {
  const parts = domain.toLowerCase().split('.');
  const tld = parts[parts.length - 1];
  const second = parts.length > 2 ? parts[parts.length - 2] : null;
  // handle co.uk / com.mk style second-level domains
  const key = (second === 'co' || second === 'com') && CCTLD_COUNTRY[tld] ? tld : tld;
  return CCTLD_COUNTRY[key] || null;
}

async function fetchViaJina(url) {
  // Jina Reader works without a key at a lower rate limit; only send the
  // header when there is one, a blank "Bearer " is rejected.
  const headers = {
    'X-Retain-Images': 'none',
    'X-With-Links-Summary': 'all',
    'X-No-Cache': 'true',
  };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jina ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

async function fetchViaDataForSEO(url) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  const res = await fetch('https://api.dataforseo.com/v3/on_page/instant_pages', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ url, enable_javascript: true }]),
  });
  const json = await res.json();
  const task = json.tasks && json.tasks[0];
  const item = task && task.result && task.result[0] && task.result[0].items && task.result[0].items[0];
  if (!task || task.status_code !== 20000 || !item) throw new Error(`DataForSEO: ${JSON.stringify(json).slice(0, 300)}`);
  const html = item.page_content || '';
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { plain, html };
}

async function fetchViaDirect(url) {
  // Last resort only -- tried after both Jina and DataForSEO fail. Some
  // sites block known cloud/datacenter IP ranges (which is plausibly why
  // both paid proxies failed to even connect) but allow a normal fetch.
  // Meant to stay a rare fallback, not the default -- the bulk of domains
  // is kept off our own IP on purpose.
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; company-enrich/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`direct ${res.status}`);
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { plain, html };
}

async function fetchPage(url) {
  const errors = [];

  try {
    const content = await fetchViaJina(url);
    if (content && content.trim().length > 200) return { content, linkSource: content, method: 'jina', ok: true };
    throw new Error('too thin');
  } catch (err) {
    errors.push(`jina(${url}): ${err.message}`);
  }

  // Some sites have broken/refusing HTTPS but redirect fine over plain HTTP
  // (found on a .com.mk domain redirecting to its .mk twin) -- Jina follows
  // the redirect server-side, so this still never touches our own IP.
  if (url.startsWith('https://')) {
    const httpUrl = 'http://' + url.slice('https://'.length);
    try {
      const content = await fetchViaJina(httpUrl);
      if (content && content.trim().length > 200) return { content, linkSource: content, method: 'jina-http', ok: true };
      throw new Error('too thin');
    } catch (err) {
      errors.push(`jina-http(${httpUrl}): ${err.message}`);
    }
  }

  try {
    const { plain, html } = await fetchViaDataForSEO(url);
    if (plain && plain.trim().length > 200) return { content: plain, linkSource: html, method: 'dataforseo', ok: true };
    throw new Error('too thin');
  } catch (err) {
    errors.push(`dataforseo: ${err.message}`);
  }

  try {
    const { plain, html } = await fetchViaDirect(url);
    return { content: plain, linkSource: html, method: 'direct', ok: true };
  } catch (err) {
    errors.push(`direct: ${err.message}`);
  }

  return { content: '', linkSource: '', method: 'none', ok: false, error: errors.join(' | ') };
}

function findLinks(content, words) {
  const hits = [];

  // Jina Reader markdown links: [label](url)
  for (const m of content.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const [, label, href] = m;
    const hay = (label + ' ' + href).toLowerCase();
    if (words.some((w) => hay.includes(w))) hits.push(href);
  }

  // Raw HTML anchors, e.g. from DataForSEO's stripped page_content: <a href="url">label</a>
  for (const m of content.matchAll(/<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]*)<\/a>/gi)) {
    const [, href, label] = m;
    const hay = (label + ' ' + href).toLowerCase();
    if (words.some((w) => hay.includes(w))) hits.push(href);
  }

  const realHit = hits.find((href) => {
    const d = domainFromUrl(href);
    return d && !isNonCompanyDomain(d) && !NON_CONTENT_DOMAINS.has(d);
  });
  return realHit || null;
}

// Same matching as findLinks, but returns up to `limit` distinct pages instead
// of only the first. Used for product pages: one page rarely covers a
// company's whole range, and the line that matters to us may not be the first
// one linked.
function findAllLinks(content, words, limit) {
  const seen = new Set();
  const out = [];
  const push = (href, label) => {
    if (out.length >= limit || !href) return;
    const hay = ((label || '') + ' ' + href).toLowerCase();
    if (!words.some((w) => hay.includes(w))) return;
    const clean = href.split('#')[0];
    const d = domainFromUrl(clean);
    if (!d || isNonCompanyDomain(d) || NON_CONTENT_DOMAINS.has(d)) return;
    if (/^https?:\/\/[^/]+\/?$/.test(clean)) return; // the home page, already fetched
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  for (const m of content.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) push(m[2], m[1]);
  for (const m of content.matchAll(/<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]*)<\/a>/gi)) push(m[1], m[2]);
  return out;
}

// Markers of a site that isn't really there any more. Only ever consulted when
// a domain also produced no usable fields -- on its own, a phrase like "under
// construction" can appear on a perfectly live site, so it must never be the
// sole basis for writing a company off.
const DEAD_SITE_MARKERS = [
  'returned error 404', 'returned error 410', 'returned error 5', // Jina's "Target URL returned error NNN"
  'critical error on this website', 'error establishing a database connection',
  'page not found', 'sivua ei löydy', 'lehte ei leitud', 'страница не найдена',
  'courtesy.register.it', 'domain is for sale', 'this domain may be for sale',
  'domain has been assigned', 'under construction', 'site en construction',
  'in costruzione', 'strona w budowie',
  'account suspended', 'temporarily unavailable', 'coming soon',
];

// Being refused is not the same as being gone -- a 403/CAPTCHA means the site
// is alive and simply won't serve our fetchers, so it deserves a manual look
// rather than a "dead site" note in the CRM (found 2026-09-07 on a live site
// behind a Cloudflare challenge).
const BLOCKED_MARKERS = [
  'returned error 401', 'returned error 403', 'returned error 429',
  'access denied', "you don't have permission", 'attention required! | cloudflare',
  'enable javascript and cookies to continue', 'captcha',
];

function discoverSubpages(linkSource) {
  const about = findLinks(linkSource, ABOUT_WORDS);
  const contact = findLinks(linkSource, CONTACT_WORDS);
  const products = findAllLinks(linkSource, PRODUCTS_WORDS, 3);
  return [...new Set([about, contact, ...products].filter(Boolean))];
}

// A "splash" homepage -- a language chooser or a bare frameset -- has almost no
// text of its own, and its links ("Deutsch", "English", "start.php",
// "seite2.html") match none of the about/contact/products words, so discovery
// finds nothing and the company is recorded as no-data. Found 2026-09-07 on
// two live meat companies (one Polish, one German) whose entire site sat one
// click away. When the home page is this thin, follow its own same-domain
// links instead of giving up.
const THIN_PAGE_CHARS = 700;

function findSameDomainLinks(content, domain, limit) {
  const seen = new Set();
  const out = [];
  const push = (href) => {
    const clean = href.split('#')[0].replace(/[).,]+$/, '');
    if (!clean || seen.has(clean)) return;
    if (domainFromUrl(clean) !== domain) return;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|css|js|ico)$/i.test(clean)) return;
    if (/^https?:\/\/[^/]+\/?$/.test(clean)) return; // the home page itself
    seen.add(clean);
    out.push(clean);
  };
  for (const m of content.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) push(m[2]);
  for (const m of content.matchAll(/<a\s+[^>]*href=["'](https?:\/\/[^"']+)["']/gi)) push(m[1]);
  return out.slice(0, limit);
}

// The operator's own market segments -- the tags the model may assign to
// "market". Configure in .env (MARKET_TAGS="segment_a,segment_b"); the
// defaults are placeholders to be replaced with your real segments.
const MARKET_TAGS = (process.env.MARKET_TAGS || 'region_a,region_b,region_c')
  .split(',').map((t) => t.trim()).filter(Boolean);

const SCHEMA_KEYS = [
  'company_name', 'company_name_quote',
  'country', 'country_quote',
  'market', 'market_quote',
  'role', 'role_quote',
  'type', 'type_quote',
  'category_general', 'category_general_quote',
  'category_specific', 'category_specific_quote',
];

async function extractFields(domain, sourceText) {
  const prompt = `You are a strict data-extraction function, not a summarizer. You receive raw scraped text from a company's website (homepage and possibly about/contact/products pages).

Output EXACTLY one JSON object with EXACTLY these 14 keys and no others: company_name, company_name_quote, country, country_quote, market, market_quote, role, role_quote, type, type_quote, category_general, category_general_quote, category_specific, category_specific_quote. Do not add pages, navigation, sections, address, or any other key. Do not describe or outline the site.

Every "*_quote" field MUST be built ONLY from VERBATIM copy-pasted excerpts taken directly from the TEXT below, character-for-character -- not a paraphrase, not a summary, not reformatted, and NEVER translated -- if the TEXT is in Polish/German/Bulgarian/whatever language, copy it in that same language exactly as written, even if the rest of your answer (like "type": "producer") is in English. A quote that rewrites two nearby list items into one new combined sentence is NOT verbatim, even if every word in it appears somewhere in the TEXT -- copy each item separately instead. For a single fact, use one short excerpt. For a list-style value (e.g. several items from a bulleted/comma list), join the exact individual excerpts with " || " between them -- each piece between the "||" separators must itself appear verbatim in the TEXT, in its original order and wording; do not merge or rewrite them into a new sentence. If you cannot find real text to copy for a field, that field and its value must both be null. One exception: the inferred-role case described below, where the quote field instead starts with the literal word "INFERRED:".

- "company_name" / "company_name_quote": the company's own legal or trading name as it appears in the TEXT (e.g. in a footer, "About" section, or copyright line) -- prefer a full legal name if one is given (e.g. "ACRI ALIMENT S.L.U.") over a marketing tagline. If more than one legal entity is named for the same business, pick the primary/first one.
- "country" / "country_quote": country name, only if a real place name (city, region, country) appears explicitly in the TEXT -- e.g. in an address or "we are based in...".
- "market" / "market_quote": ONLY if the company's own text explicitly states which regions/continents it trades with (e.g. "we export to Europe, Asia, Africa..."). This is the operator's own market-segmentation field, not a fact about the target company itself -- map explicit statements to these tags where they fit: ${MARKET_TAGS.join(', ')}, other -- comma-separated if more than one applies, plain-English region name if none of these fit. A tag names a market segment the operator sells into, not a location: a company merely based in or trading inside a region does NOT get that region's segment tag; write the plain region name for that instead. Never infer this from category or country alone -- only from an explicit statement of where the company itself trades.
- "role" / "role_quote": one of "buyer", "seller", "buyer, seller", or null.
  - Base this on explicit export/sell vs import/buy language when present.
  - EXCEPTION -- allowed inference: if "type" is "producer" of a FINISHED/processed meat product (sausages, hams, deli meats, ready meals -- anything beyond raw carcasses/primal cuts), you may set role to "buyer" (finished-meat producers typically source raw meat and offal as manufacturing input) even without explicit buy-language. In that case set role_quote to exactly "INFERRED: producer of processed meat products, likely sources raw meat/offal as input" -- do not invent a fake quote for this case.
- "type" / "type_quote": closed set only, comma-separated if more than one genuinely applies: producer, trader, importer, exporter, wholesaler, coldstore, packer, other. Never use the word "both".
- "category_general" / "category_general_quote": closed set only, comma-separated if mixed: meat, seafood, fruit, vegetable, other.
- "category_specific" / "category_specific_quote": explicit product terms only, e.g. beef, pork, poultry, lamb, offal, pet food raw materials.

The DOMAIN line below is given ONLY so you know which company the text belongs to. NEVER use the domain name, its TLD (e.g. ".mk", ".de", ".ro" tells you NOTHING about country), or the text's language to infer country, role, type, or category. If country is not spelled out as a real place name in the TEXT, country must be null -- a domain-based guess is a hard violation, worse than leaving it null. (A separate, non-LLM step handles a domain-based country fallback -- that is not your job.)

DOMAIN (identification only, not evidence): ${domain}

TEXT:
${sourceText.slice(0, 48000)}`;

  async function callOnce(maxTokens) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash-0731',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        // Without this, this model burns its entire completion budget on
        // hidden chain-of-thought reasoning before writing any visible JSON
        // (confirmed: reasoning_tokens == max_tokens, content: null). Same
        // fix the original n8n workflow already used for its OpenRouter
        // calls (reasoning: {effort: "none"}).
        reasoning: { effort: 'none' },
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const message = json.choices && json.choices[0] && json.choices[0].message;
    return message && message.content;
  }

  function tryParse(content) {
    if (!content) return null;
    const raw = content.trim().replace(/^```json\s*|```\s*$/g, '');
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null; // truncated or malformed -- caller retries with a bigger budget
    }
  }

  // The model sometimes answers with its own invented key names
  // ("company_country", "company_role", ...) instead of the schema's. Every
  // real value then gets stripped as schema drift and the company comes back
  // empty, so treat that as a failed call and retry rather than accept it
  // (seen 2026-09-07 on a Bulgarian site).
  const hasSchemaKeys = (p) => p && SCHEMA_KEYS.some((k) => k in p);

  let parsed = tryParse(await callOnce(900));
  if (parsed && !hasSchemaKeys(parsed)) {
    const second = tryParse(await callOnce(2000));
    if (hasSchemaKeys(second)) parsed = second;
  }
  if (!parsed) {
    // Either no content (this model occasionally burns its token budget on
    // hidden work before writing anything) or a truncated/unparseable JSON
    // response (hit the token limit mid-string) -- either way, retry once
    // with a much bigger budget before giving up.
    parsed = tryParse(await callOnce(2000));
  }
  if (!parsed) {
    throw new Error('OpenRouter returned no parseable content after retry');
  }

  const extraKeys = Object.keys(parsed).filter((k) => !SCHEMA_KEYS.includes(k));
  const clean = {};
  for (const k of SCHEMA_KEYS) clean[k] = parsed[k] ?? null;

  // Verify every quote is actually present in the source text (whitespace-
  // normalized substring match). A field whose quote isn't real gets nulled
  // instead of trusted -- this is what would have caught the unsupported
  // "producer" claim on a Czech conglomerate's site in the first pilot.
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const haystack = normalize(sourceText);
  const rejected = [];

  const CLOSED_SETS = {
    role: new Set(['buyer', 'seller', 'buyer, seller']),
    type: new Set(['producer', 'trader', 'importer', 'exporter', 'wholesaler', 'coldstore', 'packer', 'other']),
    category_general: new Set(['meat', 'seafood', 'fruit', 'vegetable', 'other']),
  };
  function withinClosedSet(field, value) {
    if (!CLOSED_SETS[field]) return true; // country/category_specific are free text
    return value.split(',').map((v) => v.trim().toLowerCase()).every((v) => CLOSED_SETS[field].has(v));
  }

  const fieldNames = ['company_name', 'country', 'market', 'role', 'type', 'category_general', 'category_specific'];
  for (const field of fieldNames) {
    const quoteKey = `${field}_quote`;
    const value = clean[field];
    const quote = clean[quoteKey];
    if (value === null) continue;
    // companies.role has a CHECK constraint accepting exactly 'buyer',
    // 'seller' or 'buyer, seller' -- the model sometimes writes the pair the
    // other way round ("seller, buyer"), which passes the closed-set test
    // (both tokens are valid) but is rejected by Postgres at insert time.
    // Found 2026-09-07 mid-batch.
    if (field === 'role' && /,/.test(value)) {
      const parts = value.split(',').map((v) => v.trim().toLowerCase());
      if (parts.includes('buyer') && parts.includes('seller')) clean[field] = 'buyer, seller';
    }
    if (!withinClosedSet(field, clean[field])) {
      rejected.push({ field, value, quote, reason: 'outside closed set' });
      clean[field] = null;
      clean[quoteKey] = null;
      continue;
    }
    if (quote && quote.startsWith('INFERRED:')) continue; // labeled inference, not a quote -- allowed
    if (!quote) {
      rejected.push({ field, value, quote, reason: 'no quote given' });
      clean[field] = null;
      clean[quoteKey] = null;
      continue;
    }
    // Quote may be several "||"-separated verbatim fragments (for list-style
    // values like a product list) -- every fragment must be individually
    // real, but they don't need to form one contiguous source string.
    const fragments = quote.split('||').map((f) => f.trim()).filter(Boolean);
    let allVerified = fragments.length > 0 && fragments.every((f) => haystack.includes(normalize(f)));
    // Fallback: the model often joins list items with ", " instead of the
    // instructed "||" (seen 2026-09-07 on two UK/NL wholesalers --
    // real per-item headers like "### Beef" / "### Chicken" got rejected because
    // "Beef, Chicken, ..." never appears as one contiguous string). Only applied
    // when the whole-string/"||" check already failed, and every comma-split
    // piece still has to be individually verified -- no fragment is trusted
    // without being a literal substring somewhere in the source.
    if (!allVerified && quote.includes(',')) {
      const commaFragments = quote.split(',').map((f) => f.trim()).filter(Boolean);
      allVerified = commaFragments.length > 1 && commaFragments.every((f) => haystack.includes(normalize(f)));
    }
    // Same fallback for ";" -- seen on Polish/Balkan sites where a bulleted
    // list of activities gets punctuated with semicolons in the source itself.
    if (!allVerified && quote.includes(';')) {
      const semiFragments = quote.split(';').map((f) => f.trim()).filter(Boolean);
      allVerified = semiFragments.length > 1 && semiFragments.every((f) => haystack.includes(normalize(f)));
    }
    if (!allVerified) {
      rejected.push({ field, value, quote, reason: 'quote not found in source' });
      clean[field] = null;
      clean[quoteKey] = null;
    }
  }

  if (extraKeys.length) clean._schema_drift = extraKeys;
  if (rejected.length) clean._rejected_unverified_quotes = rejected;
  return clean;
}

// Cap per page before concatenation -- on nav-heavy corporate sites (mega-menus,
// brand listers) a single page can run 40-150K chars of mostly boilerplate,
// which would silently crowd out every other page within extractFields' total
// budget. Found 2026-09-07 on a Dutch wholesaler: home page alone was 48K chars
// of nothing but nav, so the real "about us" text on the about-us subpage never
// reached the model at all.
const PER_PAGE_CHAR_CAP = 12000;

async function processCompany(domain) {
  const homeUrl = `https://${domain}`;
  const pagesFetched = [];
  const sections = []; // { url, content, isHome }

  const home = await fetchPage(homeUrl);
  pagesFetched.push({ url: homeUrl, ok: home.ok, method: home.method, error: home.error });
  if (home.ok) sections.push({ url: homeUrl, content: home.content, isHome: true });

  if (home.ok) {
    let subUrls = discoverSubpages(home.linkSource);
    let viaSplash = false;
    if (!subUrls.length && home.content.length < THIN_PAGE_CHARS) {
      subUrls = findSameDomainLinks(home.linkSource, domain, 2);
      viaSplash = true;
    }

    for (const url of subUrls) {
      const page = await fetchPage(url);
      pagesFetched.push({ url, ok: page.ok, method: page.method, error: page.error });
      if (!page.ok) continue;
      sections.push({ url, content: page.content, isHome: false });

      // The page behind a splash link is the site's real home page -- run the
      // normal about/contact/products discovery again from there.
      if (viaSplash) {
        for (const deep of discoverSubpages(page.linkSource)) {
          if (sections.some((s) => s.url === deep)) continue;
          const dp = await fetchPage(deep);
          pagesFetched.push({ url: deep, ok: dp.ok, method: dp.method, error: dp.error });
          if (dp.ok) sections.push({ url: deep, content: dp.content, isHome: false });
        }
      }
    }
  }

  // Subpages (about/contact/products) go first -- on larger sites they carry
  // the real substance, while the home page is often mostly navigation. Home
  // still gets included, just last, so small single-page sites (where home IS
  // the content) are unaffected.
  sections.sort((a, b) => (a.isHome === b.isHome ? 0 : a.isHome ? 1 : -1));
  const combined = sections
    .map((s) => `\n\n=== ${s.url} ===\n${s.content.slice(0, PER_PAGE_CHAR_CAP)}`)
    .join('');

  if (!combined.trim()) {
    return { domain, pagesFetched, extracted: null, skipped: 'no content fetched' };
  }

  const extracted = await extractFields(domain, combined);

  // Computed before the ccTLD country fallback below, deliberately -- a
  // domain-inferred country is not "real content found," and shouldn't make
  // a dead/parked page's junk <title> look trustworthy as a company name.
  const foundAnythingElse = ['country', 'role', 'type', 'category_general', 'category_specific'].some((f) => extracted[f]);

  if (extracted.country) extracted.country = normalizeCountry(extracted.country);

  if (extracted.country && !VALID_COUNTRIES.has(extracted.country)) {
    // Model gave a city/region instead of an actual country (seen: "Praha",
    // "Olsztyn") -- the quote can be a city, but the value must be a real
    // country name. Not trustworthy as stated -- treat like unstated and
    // fall through to the same ccTLD fallback below.
    extracted._rejected_unverified_quotes = extracted._rejected_unverified_quotes || [];
    extracted._rejected_unverified_quotes.push({ field: 'country', value: extracted.country, quote: extracted.country_quote, reason: 'not a real country name (likely a city/region)' });
    extracted.country = null;
    extracted.country_quote = null;
  }

  if (!extracted.country) {
    const fallback = countryFromCcTld(domain);
    if (fallback) {
      extracted.country = fallback;
      extracted.country_quote = `INFERRED: from domain ccTLD (.${domain.split('.').pop()}), not stated on the site`;
      extracted._country_source = 'domain_fallback';
    }
  } else {
    extracted._country_source = 'explicit';
  }

  if (!extracted.company_name) {
    // Jina prefixes fetched content with "Title: ...". Not verified against
    // the closed-set/quote rules above (it's structural metadata, not a
    // claim), but a company row needs SOME name -- fall back to a cleaned
    // title. Only trust the title when at least one other field was found
    // too, though -- a page that yielded nothing else is often a dead/
    // maintenance/parked page, and its "title" is often junk (seen:
    // "Website temporarily not working"), not a company name.
    const titleMatch = combined.match(/^Title:\s*(.+)$/m);
    // A page whose <title> is an asset filename (seen 2026-09-07 on a Finnish
    // site: "meat-products-1030x687.jpeg") is giving us a file, not a
    // company -- better to fall back to the domain than to name a company
    // after a JPEG.
    const titleLooksLikeFile = titleMatch && /\.(jpe?g|png|gif|webp|svg|pdf|html?|php|aspx)$/i.test(titleMatch[1].trim());
    // A title that is just a nav label ("ABOUT", "Home", "Kontakt") names a
    // page, not a company -- seen 2026-09-07 on a Danish site whose title was
    // literally "ABOUT" while the body gave the full legal name.
    const GENERIC_TITLES = /^(about( us)?|home|homepage|contact( us)?|kontakt|welcome|index|products?|start(seite)?|o nas|chi siamo|nosotros)$/i;
    const titleIsGeneric = titleMatch && GENERIC_TITLES.test(titleMatch[1].trim());
    if (titleMatch && foundAnythingElse && !titleLooksLikeFile && !titleIsGeneric) {
      extracted.company_name = titleMatch[1].trim();
      extracted._company_name_source = 'page_title';
    } else {
      extracted.company_name = domain;
      extracted._company_name_source = 'domain_fallback';
    }
  } else {
    extracted._company_name_source = 'explicit';
  }

  // Judge liveness on the HOME page alone. Scanning every fetched page let one
  // 404 subpage condemn a company whose home page was perfectly fine (found
  // 2026-09-07: a live Bulgarian company marked dead).
  const homeSection = sections.find((s) => s.isHome);
  const homeText = (homeSection ? homeSection.content : combined).toLowerCase();
  const blockedMarker = BLOCKED_MARKERS.find((m) => homeText.includes(m)) || null;
  const deadMarker = blockedMarker ? null : DEAD_SITE_MARKERS.find((m) => homeText.includes(m)) || null;

  return { domain, pagesFetched, extracted, deadMarker, blockedMarker };
}

// Verdict on how usable a result is, so a weak one is caught by the tool rather
// than by eye when reviewing a 20-domain table.
function classifyResult(result) {
  const e = result.extracted;
  if (!e) return { level: 'dead', reason: result.skipped || 'no content fetched' };
  if (!(result.pagesFetched || []).some((p) => p.ok)) return { level: 'dead', reason: 'no page could be fetched' };

  const filled = ['market', 'role', 'type', 'category_general', 'category_specific'].filter((f) => e[f]).length;
  const statedCountry = e._country_source === 'explicit';
  const statedName = e._company_name_source === 'explicit';
  // A stated country and a real company name are worth as much as a category
  // field when comparing two attempts at the same domain -- scoring only the
  // category fields once let a retry that had lost an explicit country replace
  // a better first attempt (seen 2026-09-07).
  const score = filled + (statedCountry ? 1 : 0) + (statedName ? 1 : 0);

  if (filled === 0 && !statedCountry && !statedName) {
    if (result.blockedMarker) {
      return { level: 'blocked', reason: `site refused our fetchers ("${result.blockedMarker}") -- may still be live, needs a manual look`, filled, score };
    }
    return {
      level: 'dead',
      reason: result.deadMarker ? `site looks dead/parked ("${result.deadMarker}")` : 'fetched, but nothing extractable',
      filled, score,
    };
  }
  if (filled <= 1) {
    return { level: 'thin', reason: `only ${filled} field(s)${statedName ? '' : ', no stated company name'}`, filled, score };
  }
  return { level: 'good', reason: `${filled} fields, ${statedCountry ? 'stated' : 'inferred'} country`, filled, score };
}

module.exports = { fetchPage, findLinks, findAllLinks, extractFields, processCompany, classifyResult, countryFromCcTld, ABOUT_WORDS, CONTACT_WORDS, PRODUCTS_WORDS };

if (require.main === module) {
  (async () => {
    const { parseCli, listPaths, readLines } = require('./common.js');
    const USAGE = `usage: node enrich.js [--list <dir>] [--out <json>] [--next <N>] [domain ...]

  --list <dir>   lists/<name>/ -- results go to <dir>/enrich.json, --next reads <dir>/dedupe_domains.txt
  --out <json>   results file (default: <list>/enrich.json, or results_YYYY-MM-DD.json here without --list)
  --next <N>     take the next N queued domains (use 20) not yet in the results file,
                 and record them in <list>/last_batch.txt for review_table.js / insert_batch.js
  domain ...     run just these (a re-run after a fix) -- never touches last_batch.txt

Does not write to the database.`;
    const { values: opt, positionals } = parseCli({
      usage: USAGE,
      allowPositionals: true,
      options: { list: { type: 'string' }, out: { type: 'string' }, next: { type: 'string' } },
    });
    const wantNext = opt.next !== undefined;
    const nextN = wantNext ? parseInt(opt.next, 10) : 0;
    if (wantNext && !(nextN > 0)) { console.error('--next needs a positive number, e.g. --next 20\n\n' + USAGE); process.exit(1); }
    if (wantNext && !opt.list) { console.error('--next needs --list <dir>\n\n' + USAGE); process.exit(1); }
    if (!wantNext && !positionals.length) { console.error(USAGE); process.exit(1); }

    const L = opt.list ? listPaths(opt.list) : null;
    const outFile = opt.out
      ? path.resolve(opt.out)
      : (L ? L.enrich : path.join(__dirname, `results_${new Date().toISOString().slice(0, 10)}.json`));

    // Merge into the existing results file rather than overwrite it. Re-running
    // a couple of domains after a fix is the normal workflow (no point
    // re-spending calls on companies that already came out clean), and an
    // overwrite would silently drop the rest of the batch still waiting to be
    // reviewed/inserted.
    let merged = [];
    if (fs.existsSync(outFile)) {
      try {
        merged = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (err) {
        console.error('Could not parse existing', outFile, '-- starting fresh:', err.message);
      }
    }
    const done = new Set(merged.map((r) => r.domain));

    // The batch is the next N queued domains that have no result yet. It is
    // written to last_batch.txt so the review and the insert see the same set.
    // Positional domains are extra and are NOT recorded -- a selective re-run
    // must not redefine what the batch was.
    let batch = [];
    if (wantNext) {
      const queue = readLines(L.domains);
      batch = queue.filter((d) => !done.has(d)).slice(0, nextN);
      if (!batch.length) console.log(`nothing left in ${L.domains} that is not already in ${outFile}`);
      else fs.writeFileSync(L.lastBatch, batch.join('\n') + '\n');
      console.log(`queue: ${queue.length} | already enriched: ${queue.filter((d) => done.has(d)).length} | this batch: ${batch.length}${batch.length ? ` -> ${L.lastBatch}` : ''}`);
    }
    const domains = [...new Set([...batch, ...positionals.map((d) => d.toLowerCase())])];
    if (!domains.length) return;

    const results = [];
    for (const domain of domains) {
      console.log('Processing', domain, '...');
      try {
        let result = await processCompany(domain);
        let verdict = classifyResult(result);

        // One retry for a thin result -- the extraction step is the flaky part
        // (the model sometimes paraphrases instead of quoting, and a paraphrased
        // quote gets correctly rejected, leaving fields empty). A dead site is
        // not retried: re-fetching a 404 twice just costs another call.
        // A "dead" verdict with no dead-site marker means the page fetched fine
        // and the extraction is what came back empty -- worth one more attempt.
        // A confirmed dead site (404/parked/500) is not retried.
        if (verdict.level === 'thin' || (verdict.level === 'dead' && !result.deadMarker)) {
          console.log(`  thin (${verdict.reason}) -- retrying once`);
          const retry = await processCompany(domain);
          const retryVerdict = classifyResult(retry);
          if ((retryVerdict.score || 0) > (verdict.score || 0)) {
            result = retry;
            verdict = retryVerdict;
            console.log(`  retry was better (${verdict.reason})`);
          }
        }

        result.verdict = verdict;
        results.push(result);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('FAILED', domain, err.message);
        results.push({ domain, error: err.message, verdict: { level: 'dead', reason: err.message } });
      }
    }

    for (const result of results) {
      const i = merged.findIndex((r) => r.domain === result.domain);
      if (i === -1) { merged.push(result); continue; }
      // Keep whichever attempt actually came out better. Extraction is
      // non-deterministic, so a re-run can come back worse than what it would
      // replace -- a re-run should never cost us data we already had.
      const oldScore = (merged[i].verdict || {}).score || 0;
      const newScore = (result.verdict || {}).score || 0;
      if (newScore >= oldScore) merged[i] = result;
      else console.log(`  kept earlier, better result for ${result.domain} (score ${oldScore} > ${newScore})`);
    }
    merged.sort((a, b) => a.domain.localeCompare(b.domain));
    fs.writeFileSync(outFile, JSON.stringify(merged, null, 2));
    console.log(`\nWrote ${outFile} (${results.length} this run, ${merged.length} total)`);

    console.log('\n=== quality summary (this run) ===');
    for (const level of ['good', 'thin', 'blocked', 'dead']) {
      const rows = results.filter((r) => (r.verdict || {}).level === level);
      if (!rows.length) continue;
      console.log(`\n${level.toUpperCase()} (${rows.length}):`);
      for (const r of rows) console.log(`  ${r.domain} -- ${r.verdict.reason}`);
    }
  })();
}
