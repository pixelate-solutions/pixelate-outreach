function loadDoNotContactIndex_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Do Not Contact');
  var index = { emails: {}, domains: {}, companies: {} };
  if (!sheet || sheet.getLastRow() < 2) return index;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, DNC_HEADERS.length).getValues().forEach(function(row) {
    var email = normalizeEmail_(row[0]);
    var domain = normalizeDomain_(row[1]);
    var company = normalizeWhitespace_(row[2]).toLowerCase();
    if (email) index.emails[email] = true;
    if (domain) index.domains[domain] = true;
    if (company) index.companies[company] = true;
  });
  return index;
}

function isDoNotContact_(lead, index) {
  var dnc = index || loadDoNotContactIndex_();
  if (lead['Do Not Contact'] === true || String(lead['Do Not Contact']).toLowerCase() === 'true') return true;
  var email = normalizeEmail_(lead['Email']);
  var domain = normalizeDomain_(lead['Company Domain']) || normalizeDomain_(email);
  var company = normalizeWhitespace_(lead['Company']).toLowerCase();
  return Boolean((email && dnc.emails[email]) || (domain && dnc.domains[domain]) || (company && dnc.companies[company]));
}

function addToDoNotContact_(lead, reason, source, notes, blockDomain) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Do Not Contact');
  if (!sheet) throw new Error('Initialize the workbook first.');
  var email = normalizeEmail_(lead['Email']);
  var domain = blockDomain === false ? '' : (normalizeDomain_(lead['Company Domain']) || normalizeDomain_(email));
  var existing = loadDoNotContactIndex_();
  if (!existing.emails[email] || (domain && !existing.domains[domain])) {
    sheet.appendRow([email, domain, lead['Company'] || '', reason || 'Manual opt-out', source || 'Sheet', new Date(), notes || '']);
  }
  updateLeadRow_(lead._rowNumber, {
    'Do Not Contact': true,
    'Approved': false,
    'Follow-Up Approved': false,
    'Follow-Up Due': '',
    'Draft Status': lead['Draft Status'] === 'Not Created' ? 'Blocked' : lead['Draft Status'],
    'Last Updated': new Date()
  });
  logActivity_({ lead: lead, action: 'Add Do Not Contact', result: 'Success', details: reason || 'Manual opt-out' });
}

function markSelectedAsDoNotContact() {
  var rows = selectedLeadRows_();
  if (!rows.length) throw new Error('Select one or more lead rows first.');
  rows.forEach(function(row) {
    var lead = getLeadByRow_(row);
    if (lead) addToDoNotContact_(lead, 'Manually suppressed', 'Pixelate Outreach menu', '', true);
  });
  SpreadsheetApp.getActive().toast(rows.length + ' lead(s) added to Do Not Contact.', APP_NAME, 5);
}

