function getLeadsSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Leads');
  if (!sheet) throw new Error('Initialize the workbook first.');
  return sheet;
}

function getLeadHeaderMap_() {
  var sheet = getLeadsSheet_();
  return headerMapFromValues_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
}

function leadFromRowValues_(values, headers, rowNumber) {
  var lead = { _rowNumber: rowNumber };
  headers.forEach(function(header, index) { lead[header] = values[index]; });
  return lead;
}

function getAllLeads_() {
  var sheet = getLeadsSheet_();
  if (sheet.getLastRow() < 2) return [];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().map(function(row, index) {
    return leadFromRowValues_(row, headers, index + 2);
  }).filter(function(lead) { return normalizeWhitespace_(lead['Lead ID']) !== ''; });
}

function getLeadByRow_(rowNumber) {
  var sheet = getLeadsSheet_();
  if (rowNumber < 2 || rowNumber > sheet.getLastRow()) return null;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return leadFromRowValues_(sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0], headers, rowNumber);
}

function getLeadById_(leadId) {
  var id = normalizeWhitespace_(leadId);
  var leads = getAllLeads_();
  for (var i = 0; i < leads.length; i++) if (leads[i]['Lead ID'] === id) return leads[i];
  return null;
}

function updateLeadRow_(rowNumber, updates) {
  var sheet = getLeadsSheet_();
  var map = getLeadHeaderMap_();
  Object.keys(updates).forEach(function(header) {
    if (!map[header]) throw new Error('Unknown Leads column: ' + header);
    sheet.getRange(rowNumber, map[header]).setValue(updates[header]);
  });
}

function appendLeadObjects_(leadObjects) {
  if (!leadObjects.length) return;
  var sheet = getLeadsSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var startRow = getAllLeads_().length === 0 && sheet.getLastRow() <= 2 ? 2 : sheet.getLastRow() + 1;
  if (sheet.getMaxRows() < startRow + leadObjects.length - 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), startRow + leadObjects.length - 1 - sheet.getMaxRows());
  }
  var rows = leadObjects.map(function(lead) { return headers.map(function(header) { return Object.prototype.hasOwnProperty.call(lead, header) ? lead[header] : ''; }); });
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  applyLeadRowControls_(startRow, rows.length);
}

function applyLeadRowControls_(startRow, rowCount) {
  if (!rowCount) return;
  var sheet = getLeadsSheet_();
  var map = getLeadHeaderMap_();
  ['Approved', 'Do Not Contact', 'Follow-Up Approved', 'Is Test Record'].forEach(function(header) {
    sheet.getRange(startRow, map[header], rowCount, 1).insertCheckboxes();
  });
}

function selectedLeadRows_() {
  var sheet = getLeadsSheet_();
  var range = sheet.getActiveRange();
  if (!range || range.getRow() > sheet.getLastRow()) return [];
  var start = Math.max(2, range.getRow());
  var end = Math.min(sheet.getLastRow(), range.getLastRow());
  var rows = [];
  for (var row = start; row <= end; row++) rows.push(row);
  return rows;
}

function nextLeadRows_(limit, predicate) {
  var rows = [];
  getAllLeads_().some(function(lead) {
    if (predicate(lead)) rows.push(lead._rowNumber);
    return rows.length >= limit;
  });
  return rows;
}

function mergeImportedLead_(rowNumber, imported) {
  var safeHeaders = [
    'First Name', 'Last Name', 'Full Name', 'Job Title', 'Seniority', 'Email',
    'Email Status', 'Company', 'Website', 'Company Domain', 'LinkedIn URL', 'City',
    'State', 'Country', 'Employee Count', 'Industry', 'Apollo Source Data', 'Segment',
    'Priority'
  ];
  var current = getLeadByRow_(rowNumber);
  var updates = {};
  safeHeaders.forEach(function(header) {
    if (imported[header] !== '' && imported[header] != null) updates[header] = imported[header];
  });
  if (!current['Recommended Project'] && imported['Recommended Project']) updates['Recommended Project'] = imported['Recommended Project'];
  updates['Last Updated'] = new Date();
  updateLeadRow_(rowNumber, updates);
}

function refreshCompanyOutreachWarnings_() {
  var leads = getAllLeads_();
  var byDomain = {};
  leads.forEach(function(lead) {
    var domain = normalizeDomain_(lead['Company Domain']);
    if (!domain) return;
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(lead);
  });
  Object.keys(byDomain).forEach(function(domain) {
    var active = byDomain[domain].filter(function(lead) {
      return lead['Send Status'] === 'Sent' || lead['Draft Status'] === 'Created' || lead['Draft Status'] === 'Updated' || lead['Approved'] === true;
    });
    byDomain[domain].forEach(function(lead) {
      var others = active.filter(function(other) { return other['Lead ID'] !== lead['Lead ID']; });
      updateLeadRow_(lead._rowNumber, {
        'Company Outreach Warning': others.length ? 'Warning: ' + others.length + ' other active contact(s) at this company.' : ''
      });
    });
  });
}

function hasPreviousSend_(lead) {
  return normalizeWhitespace_(lead['Sent Message ID']) !== '' || lead['Send Status'] === 'Sent';
}

function setLeadError_(lead, error, action) {
  var message = truncate_(error && error.message ? error.message : error, 1000);
  updateLeadRow_(lead._rowNumber, { 'Last Error': message, 'Last Updated': new Date() });
  logActivity_({
    lead: lead,
    action: action || 'Process Lead',
    result: 'Failed',
    error: message
  });
}
