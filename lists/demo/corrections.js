// Operator's verdicts for this list, keyed by lowercase domain. Loaded by
// review_table.js (shown as CORR / DNC flags) and insert_batch.js (applied
// on top of the extraction). Only the columns in common.js CORRECTION_COLUMNS
// are allowed; an unknown column stops the run.
module.exports = {
  // Extraction fell back to the domain for the name; the site states it in an image.
  'example-one.com': { company_name: 'Example One Ltd' },

  // Dead site, but the company is real -- keep the row, never mail it.
  'example-two.net': {
    contact_status: 'do_not_contact',
    contact_status_details: 'site parked since 2024, no other contact channel',
  },

  // Extraction found only the home page; the products page names the range.
  'example-three.org': { category_specific: 'beef, lamb, offal', role: 'buyer' },
};
