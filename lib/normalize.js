function domainFromEmail(email) {
  if (!email) return null;
  const first = String(email).split(',')[0].trim().toLowerCase();
  const parts = first.split('@');
  if (parts.length !== 2 || !parts[1].includes('.')) return null;
  return parts[1];
}

function domainFromUrl(url) {
  if (!url) return null;
  let d = String(url).trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split(':')[0];
  if (!d.includes('.')) return null;
  return d;
}

// Free-mail and social-media domains: never usable as a company's identity.
// A shared personal @gmail.com address (or a facebook.com/instagram.com
// profile link) does not mean two companies are the same company -- treating
// it as a domain key merges unrelated companies together. Found 2026-08-27
// after 11 such domains had silently merged 176 contacts across 6+ sources.
const NON_COMPANY_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.com.ph', 'hotmail.com', 'outlook.com', 'live.com', 'aol.com',
  'icloud.com', 'me.com', 'msn.com', 'mail.ru', 'yandex.ru', 'qq.com', '163.com',
  '126.com', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'naver.com', 'abv.bg',
  'wp.pl', 'onet.pl', 'o2.pl', 'libero.it',
  // Third wave, found 2026-09-03 while building the CRM company list: sorting
  // by touch count put seznam.cz, tiscali.it and hotmail.es at the top, i.e.
  // freemail domains were sitting in `companies` as if they were businesses.
  // 42 such rows had absorbed 331 unrelated contacts. Two gaps caused it:
  // only the .com variants of the big providers were listed (hotmail.com but
  // not hotmail.es/.it/.fr), and no European ISP mail was listed at all --
  // which is what small European meat producers actually use.
  'googlemail.com', 'yahoo.fr', 'yahoo.it', 'yahoo.es', 'yahoo.de', 'yahoo.co.uk', 'yahoo.gr',
  'hotmail.fr', 'hotmail.it', 'hotmail.es', 'hotmail.de', 'hotmail.co.uk', 'hotmail.be',
  'hotmail.nl', 'hotmail.se', 'outlook.fr', 'outlook.it', 'outlook.es', 'outlook.de',
  'live.fr', 'live.it', 'live.nl', 'live.be', 'proton.me', 'gmx.at', 'gmx.ch', 'gmx.net',
  'zoho.com', 'yandex.com', 'rambler.ru', 'ukr.net', 'i.ua', 'meta.ua', 'bigmir.net',
  // European ISP mail -- the biggest single gap.
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'neuf.fr', 'bbox.fr',
  'club-internet.fr', 'alice.it', 'virgilio.it', 'tiscali.it', 'tin.it', 'inwind.it',
  'fastwebnet.it', 'email.it', 'tim.it', 't-online.de', 'freenet.de', 'arcor.de',
  'bluewin.ch', 'sunrise.ch', 'skynet.be', 'telenet.be', 'proximus.be', 'scarlet.be',
  'voo.be', 'seznam.cz', 'email.cz', 'centrum.cz', 'volny.cz', 'atlas.cz', 'post.cz',
  'siol.net', 'telemach.net', 't-2.net', 'terra.es', 'telefonica.net', 'movistar.es',
  'ono.com', 'wanadoo.es', 'planet.nl', 'xs4all.nl', 'ziggo.nl', 'kpnmail.nl', 'home.nl',
  'hetnet.nl', 'online.no', 'broadpark.no', 'telia.com', 'telia.se', 'bredband.net',
  'spray.se', 'mail.bg', 'otenet.gr', 'hol.gr', 'sapo.pt', 'mail.pt', 'netcabo.pt',
  'iol.pt', 'interia.pl', 'op.pl', 'gazeta.pl',
  // Found 2026-09-06 processing an imported list: eircom.net (Ireland's
  // incumbent telecom/ISP, "eir") is the same class of gap as the rest of
  // this list -- an ISP-provided personal mailbox, not a company.
  'eircom.net',
  // Found 2026-09-07, same list: t-online.hu is Magyar Telekom's consumer
  // portal (the .de sibling was already listed -- the gap was the ccTLD, not
  // the provider), and vip.bg is a Bulgarian free-mail provider. Listed as
  // exact domains, NOT suffixes: a business page hosted *under* the ISP
  // (<firm>.t-online.hu) is a real, if poor, company site and stays usable.
  't-online.hu', 'vip.bg',
  // Found 2026-09-10 in a campaign's send pool. Each had keyed exactly one
  // company, so nothing had merged yet -- but the next firm on the same
  // provider would have collapsed into it. interia.pl was already listed; the
  // gap was its .eu sibling.
  'email.com', 'freemail.hu', 'interia.eu',
  // Italian certified email (PEC). A legal delivery relay, never the company's
  // own identity -- 65 contacts were merged under pec.it and legalmail.it alone.
  'pec.it', 'legalmail.it', 'arubapec.it', 'pec.buffetti.it', 'postecert.it',
  'cert.legalmail.it', 'registerpec.it',
  // Italy's state PEC service, one mailbox per VAT number
  // (<partita IVA>@impresa.italia.it). Found 2026-09-15 when one bounced
  // "554 PEO not allowed" -- it refuses ordinary mail outright, and two
  // different firms had been merged under it as one company.
  'impresa.italia.it',
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'wa.me', 'whatsapp.com', 'wechat.com', 't.me',
  // Business directories / registries / trade portals, found 2026-08-27:
  // their own contact address, or a shared listing page, gets mistaken for
  // the actual company's identity or contact -- same failure mode as a
  // free-mail domain, different cause (a third party, not a personal inbox).
  'gowork.pl', 'panoramafirm.pl', 'ceginformacio.hu', 'rekvizitai.vz.lt',
  'webgate.ec.europa.eu', 'emis.com', 'archive.org',
  'petsglobal.com', 'globalpetindustry.com',
  // Same failure mode, found 2026-09-01 importing an official-register export:
  // a "not found" row's URL/EMAIL column held a directory/aggregator/
  // registry/certification-body/lead-gen-tool listing page instead of the
  // company's own site -- merged 1,025 unrelated companies into 73 fake
  // "companies" (one, zoominfo.com, collided with a real pre-existing one).
  'zoominfo.com', 'infobel.com', 'rocketreach.co', 'prospeo.io', 'efoodalert.com',
  'pitchbook.com', 'freshdi.com', 'verif.com', 'waze.com', 'bestfoodimporters.com',
  'tracxn.com', 'largestcompanies.com', 'creditsafe.com', 'northdata.com',
  'northdata.de', 'domain.com', 'mail.com', 'certificat.ecocert.com',
  'frozenb2b.com', 'europages.co.uk', 'sph.health.mil', 'yumpu.com', 'rspo.org',
  'trademarkelite.com', 'scribd.com', 'gourmets.net', 'needl.co', 'tripadvisor.com',
  'tenderinfo.org', 'okredo.com', 'go4worldbusiness.com', 'gff.co.uk',
  'dnb.com', 'bbs.fobshanghai.com',
  '路路路路路.com',
  // Fourth wave, found 2026-09-05 profiling the 704 company-less contacts:
  // Asian free-mail was almost entirely absent, which is precisely where the
  // HK/China/Vietnam/Korea lists live. netvigator.com (a Hong Kong ISP) had
  // already become a company row -- a real HK trading firm -- so the next
  // @netvigator.com import would have merged a stranger into it. Listed
  // here are the domains actually seen in the data plus the direct siblings of
  // the same providers (Yahoo ccTLDs, the Mail.ru and NetEase families), since
  // finding one of a provider's domains always means the rest are coming.
  '139.com', '188.com', 'yeah.net', 'sina.com', 'sina.cn', 'china.com',
  'aliyun.com', 'foxmail.com', 'nate.com', 'daum.net', 'hanmail.net',
  'hotmail.co.kr', 'live.hk', 'netvigator.com', 'ymail.com', 'rocketmail.com',
  'yahoo.ca', 'yahoo.com.au', 'yahoo.com.hk', 'yahoo.com.sg', 'yahoo.co.jp',
  'yahoo.com.tw', 'yahoo.co.in', 'yahoo.com.vn',
  'list.ru', 'bk.ru', 'inbox.ru',
]);

// Domains whose subdomains are just as unusable as the bare domain --
// kompass.com runs one lookalike per country (fr.kompass.com,
// gb.kompass.com, ...); m.yelp.com/m.facebook.com/be.linkedin.com are
// mobile/locale subdomains of directories already blocked above.
// NetEase and Sina sell "vip" subdomains as paid personal mail (vip.163.com,
// vip.126.com, vip.sina.com), so the bare domain alone is not enough.
const NON_COMPANY_DOMAIN_SUFFIXES = [
  'kompass.com', 'yelp.com', 'facebook.com', 'linkedin.com',
  '163.com', '126.com', 'sina.com',
];

function isNonCompanyDomain(domain) {
  if (!domain) return false;
  if (NON_COMPANY_DOMAINS.has(domain)) return true;
  return NON_COMPANY_DOMAIN_SUFFIXES.some((s) => domain === s || domain.endsWith('.' + s));
}

module.exports = {
  domainFromEmail,
  domainFromUrl,
  NON_COMPANY_DOMAINS,
  NON_COMPANY_DOMAIN_SUFFIXES,
  isNonCompanyDomain,
};
