function initializeWorkbook() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another setup operation is already running.');
  try {
    var spreadsheet = SpreadsheetApp.getActive();
    spreadsheet.setSpreadsheetTimeZone(APP_TIMEZONE);
    spreadsheet.setName(APP_NAME);
    ensureSheetWithHeaders_(spreadsheet, 'Leads', LEAD_HEADERS, 1000);
    ensureSheetWithHeaders_(spreadsheet, 'Configuration', ['Setting', 'Value', 'Description'], Object.keys(DEFAULT_CONFIG).length + 10);
    ensureSheetWithHeaders_(spreadsheet, 'Activity Log', ACTIVITY_HEADERS, 1000);
    ensureSheetWithHeaders_(spreadsheet, 'Do Not Contact', DNC_HEADERS, 500);
    ensureSheetWithHeaders_(spreadsheet, 'Templates', ['Template', 'Content'], 50);
    ensureSheetWithHeaders_(spreadsheet, 'Dashboard', ['Metric', 'Value'], 40);
    ensureSheetWithHeaders_(spreadsheet, CACHE_SHEET, CACHE_HEADERS, 500);
    populateConfiguration_();
    populateTemplates_();
    populateDashboard_();
    formatWorkbook_();
    spreadsheet.getSheetByName(CACHE_SHEET).hideSheet();
    logActivity_({ action: 'Initialize Workbook', result: 'Success', details: 'Workbook initialized or repaired.' });
    SpreadsheetApp.getActive().toast('Pixelate Outbound Assistant is ready.', APP_NAME, 5);
  } finally {
    lock.releaseLock();
  }
}

function ensureSheetWithHeaders_(spreadsheet, name, headers, minimumRows) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  if (sheet.getMaxRows() < minimumRows) sheet.insertRowsAfter(sheet.getMaxRows(), minimumRows - sheet.getMaxRows());
  var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  headers.forEach(function(header, index) {
    if (!existing[index]) sheet.getRange(1, index + 1).setValue(header);
    else if (existing[index] !== header && sheet.getLastRow() <= 1) sheet.getRange(1, index + 1).setValue(header);
  });
  return sheet;
}

function populateConfiguration_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Configuration');
  var existing = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function(row) { existing[row[0]] = row[1]; });
  }
  var rows = Object.keys(DEFAULT_CONFIG).map(function(key) {
    var value = Object.prototype.hasOwnProperty.call(existing, key) ? existing[key] : DEFAULT_CONFIG[key];
    if (key === 'OpenAI API key status') value = PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY) ? 'Configured' : 'Missing';
    return [key, value, CONFIG_DESCRIPTIONS[key] || 'Editable setting used by the outreach workflow.'];
  });
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 3).clearContent();
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  var booleanKeys = Object.keys(DEFAULT_CONFIG).filter(function(key) { return typeof DEFAULT_CONFIG[key] === 'boolean'; });
  booleanKeys.forEach(function(key) {
    var row = Object.keys(DEFAULT_CONFIG).indexOf(key) + 2;
    sheet.getRange(row, 2).insertCheckboxes();
  });
}

function populateTemplates_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Templates');
  var current = {};
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function(row) { current[row[0]] = row[1]; });
  var rows = TEMPLATE_ROWS.map(function(row) { return [row[0], Object.prototype.hasOwnProperty.call(current, row[0]) ? current[row[0]] : row[1]]; });
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 2).clearContent();
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function getTemplate_(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Templates');
  if (!sheet || sheet.getLastRow() < 2) return '';
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) if (values[i][0] === name) return String(values[i][1] || '');
  return '';
}

function populateDashboard_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Dashboard');
  var map = headerMapFromValues_(LEAD_HEADERS);
  function col(name) { return columnLetter_(map[name]); }
  var metrics = [
    ['Total imported contacts', '=COUNTA(Leads!A2:A10000)'],
    ['Unique companies', '=IFERROR(COUNTA(UNIQUE(FILTER(Leads!' + col('Company') + '2:' + col('Company') + '10000,Leads!' + col('Company') + '2:' + col('Company') + '10000<>""))),0)'],
    ['High-fit leads', '=COUNTIF(Leads!' + col('Fit Level') + '2:' + col('Fit Level') + '10000,"High")'],
    ['Medium-fit leads', '=COUNTIF(Leads!' + col('Fit Level') + '2:' + col('Fit Level') + '10000,"Medium")'],
    ['Low-fit leads', '=COUNTIF(Leads!' + col('Fit Level') + '2:' + col('Fit Level') + '10000,"Low")'],
    ['Research completed', '=COUNTIF(Leads!' + col('Research Status') + '2:' + col('Research Status') + '10000,"Completed")'],
    ['Emails generated', '=COUNTIF(Leads!' + col('Email Subject') + '2:' + col('Email Subject') + '10000,"?*")'],
    ['Drafts created', '=COUNTIF(Leads!' + col('Draft Status') + '2:' + col('Draft Status') + '10000,"Created")+COUNTIF(Leads!' + col('Draft Status') + '2:' + col('Draft Status') + '10000,"Updated")'],
    ['Emails approved', '=COUNTIF(Leads!' + col('Approved') + '2:' + col('Approved') + '10000,TRUE)'],
    ['Emails sent', '=COUNTIF(Leads!' + col('Send Status') + '2:' + col('Send Status') + '10000,"Sent")'],
    ['Replies', '=COUNTIF(Leads!' + col('Reply Status') + '2:' + col('Reply Status') + '10000,"Replied")'],
    ['Positive replies', '=COUNTIF(Leads!' + col('Reply Classification') + '2:' + col('Reply Classification') + '10000,"Positive interest")'],
    ['Negative replies', '=COUNTIF(Leads!' + col('Reply Classification') + '2:' + col('Reply Classification') + '10000,"Not interested")'],
    ['Opt-outs', '=COUNTIF(Leads!' + col('Reply Classification') + '2:' + col('Reply Classification') + '10000,"Unsubscribe")'],
    ['Meetings or opportunities', '=COUNTIF(Leads!' + col('Reply Classification') + '2:' + col('Reply Classification') + '10000,"Positive interest")'],
    ['Errors', '=COUNTIF(Leads!' + col('Last Error') + '2:' + col('Last Error') + '10000,"?*")'],
    ['Reply rate', '=IFERROR(B12/B11,0)'],
    ['Positive reply rate', '=IFERROR(B13/B11,0)']
  ];
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 2).clearContent();
  sheet.getRange(2, 1, metrics.length, 1).setValues(metrics.map(function(row) { return [row[0]]; }));
  sheet.getRange(2, 2, metrics.length, 1).setFormulas(metrics.map(function(row) { return [row[1]]; }));
}

function formatWorkbook_() {
  var spreadsheet = SpreadsheetApp.getActive();
  var navy = '#17324D';
  var blue = '#2F6F9F';
  var paleBlue = '#EAF3F8';
  var paleYellow = '#FFF6D8';
  REQUIRED_SHEETS.concat([CACHE_SHEET]).forEach(function(name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) return;
    sheet.setFrozenRows(1);
    sheet.setHiddenGridlines(true);
    var lastColumn = Math.max(sheet.getLastColumn(), 1);
    sheet.getRange(1, 1, 1, lastColumn).setBackground(navy).setFontColor('#FFFFFF').setFontWeight('bold').setVerticalAlignment('middle');
    sheet.setRowHeight(1, 32);
    var hasNativeTable = false;
    try { hasNativeTable = typeof sheet.getTables === 'function' && sheet.getTables().length > 0; } catch (ignored) {}
    if (sheet.getLastRow() > 1 && !sheet.getFilter() && !hasNativeTable && name !== 'Leads' && name !== 'Dashboard' && name !== 'Configuration' && name !== 'Templates') {
      sheet.getRange(1, 1, sheet.getMaxRows(), lastColumn).createFilter();
    }
  });

  var leads = spreadsheet.getSheetByName('Leads');
  var leadMap = headerMapFromValues_(LEAD_HEADERS);
  var editable = ['Email Subject', 'Email Body', 'Approved', 'Follow-Up Subject', 'Follow-Up Body', 'Follow-Up Approved'];
  editable.forEach(function(header) { leads.getRange(2, leadMap[header], leads.getMaxRows() - 1, 1).setBackground(paleYellow); });
  ['Research Summary', 'Additional Evidence', 'Likely Workflow Problem', 'Email Body', 'Email Quality Warnings', 'Follow-Up Body'].forEach(function(header) {
    leads.getRange(2, leadMap[header], leads.getMaxRows() - 1, 1).setWrap(true);
  });
  ['Approved', 'Do Not Contact', 'Follow-Up Approved', 'Is Test Record'].forEach(function(header) {
    applyUnlessNativeTableBlocks_(function() {
      leads.getRange(2, leadMap[header], leads.getMaxRows() - 1, 1).insertCheckboxes();
    });
  });
  addLeadValidations_(leads, leadMap);
  addLeadConditionalFormatting_(leads, leadMap);
  leads.setColumnWidth(leadMap['Lead ID'], 150);
  leads.setColumnWidth(leadMap['Company'], 190);
  leads.setColumnWidth(leadMap['Research Summary'], 340);
  leads.setColumnWidth(leadMap['Email Body'], 420);
  leads.setColumnWidth(leadMap['Last Error'], 260);
  applyUnlessNativeTableBlocks_(function() { leads.getRange(2, leadMap['Sent At'], leads.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm'); });
  applyUnlessNativeTableBlocks_(function() { leads.getRange(2, leadMap['Replied At'], leads.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm'); });
  applyUnlessNativeTableBlocks_(function() { leads.getRange(2, leadMap['Follow-Up Due'], leads.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd'); });
  applyUnlessNativeTableBlocks_(function() { leads.getRange(2, leadMap['Last Updated'], leads.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm'); });
  leads.getRange(1, 1, 1, LEAD_HEADERS.length).setNotes([LEAD_HEADERS.map(function(header) { return leadColumnNote_(header); })]);

  var config = spreadsheet.getSheetByName('Configuration');
  config.setColumnWidth(1, 260);
  config.setColumnWidth(2, 320);
  config.setColumnWidth(3, 520);
  applyUnlessNativeTableBlocks_(function() { config.getRange(2, 2, Math.max(config.getLastRow() - 1, 1), 1).setBackground(paleYellow); });
  applyUnlessNativeTableBlocks_(function() { config.getRange(2, 3, Math.max(config.getLastRow() - 1, 1), 1).setBackground(paleBlue).setWrap(true); });

  var templates = spreadsheet.getSheetByName('Templates');
  templates.setColumnWidth(1, 240);
  templates.setColumnWidth(2, 780);
  applyUnlessNativeTableBlocks_(function() { templates.getRange(2, 2, Math.max(templates.getLastRow() - 1, 1), 1).setBackground(paleYellow).setWrap(true); });

  var dashboard = spreadsheet.getSheetByName('Dashboard');
  dashboard.setColumnWidth(1, 260);
  dashboard.setColumnWidth(2, 160);
  applyUnlessNativeTableBlocks_(function() { dashboard.getRange('A2:B19').setBorder(false, false, false, false, true, true, '#D8E1E8', SpreadsheetApp.BorderStyle.SOLID); });
  applyUnlessNativeTableBlocks_(function() { dashboard.getRange('A2:A19').setFontWeight('bold').setBackground(paleBlue); });
  applyUnlessNativeTableBlocks_(function() { dashboard.getRange('B2:B19').setFontSize(14).setFontWeight('bold').setFontColor(blue); });
  applyUnlessNativeTableBlocks_(function() { dashboard.getRange('B18:B19').setNumberFormat('0.0%'); });

  spreadsheet.getSheetByName('Activity Log').setColumnWidth(7, 420);
  spreadsheet.getSheetByName('Do Not Contact').setColumnWidth(7, 360);
}

function addLeadValidations_(sheet, map) {
  var options = {
    'Priority': ['High', 'Medium', 'Low'],
    'Fit Level': ['High', 'Medium', 'Low'],
    'Research Status': ['Not Started', 'Queued', 'Processing', 'Completed', 'Manual Review', 'Failed'],
    'Draft Status': ['Not Created', 'Created', 'Updated', 'Blocked', 'Failed'],
    'Send Status': ['Not Sent', 'Queued', 'Sent', 'Blocked', 'Failed'],
    'Reply Status': ['No Reply', 'Replied'],
    'Reply Classification': ['Positive interest', 'Referral to another person', 'Request for more information', 'Not now', 'Not interested', 'Already solved', 'Out of office', 'Unsubscribe', 'Invalid address', 'Other'],
    'Follow-Up Status': ['Not Generated', 'Generated', 'Draft Created', 'Sent', 'Blocked', 'Failed']
  };
  Object.keys(options).forEach(function(header) {
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(options[header], true).setAllowInvalid(false).build();
    applyUnlessNativeTableBlocks_(function() {
      sheet.getRange(2, map[header], sheet.getMaxRows() - 1, 1).setDataValidation(rule);
    });
  });
}

function applyUnlessNativeTableBlocks_(operation) {
  try {
    operation();
  } catch (error) {
    if (String(error && error.message || error).indexOf('typed column') === -1) throw error;
  }
}

function addLeadConditionalFormatting_(sheet, map) {
  applyUnlessNativeTableBlocks_(function() {
    var rules = sheet.getConditionalFormatRules().filter(function(rule) { return false; });
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('High').setBackground('#D9EAD3').setRanges([sheet.getRange(2, map['Fit Level'], sheet.getMaxRows() - 1, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Medium').setBackground('#FFF2CC').setRanges([sheet.getRange(2, map['Fit Level'], sheet.getMaxRows() - 1, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Low').setBackground('#F4CCCC').setRanges([sheet.getRange(2, map['Fit Level'], sheet.getMaxRows() - 1, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Replied').setBackground('#D9EAD3').setRanges([sheet.getRange(2, map['Reply Status'], sheet.getMaxRows() - 1, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=LEN($' + columnLetter_(map['Last Error']) + '2)>0').setBackground('#F4CCCC').setRanges([sheet.getRange(2, map['Last Error'], sheet.getMaxRows() - 1, 1)]).build());
    sheet.setConditionalFormatRules(rules);
  });
}

function leadColumnNote_(header) {
  var notes = {
    'Lead ID': 'Stable deterministic identifier. Do not edit.',
    'Apollo Source Data': 'Compact JSON containing unrecognized nonblank Apollo fields.',
    'Research Confidence': '0-100 confidence based on verifiable evidence.',
    'Approved': 'Required before an initial draft can be sent.',
    'Do Not Contact': 'Blocks research-to-draft continuation, drafting, sending, and follow-ups.',
    'Company Outreach Warning': 'Shows when another active contact at the same company is in outreach.',
    'Follow-Up Approved': 'Separate approval gate for a generated follow-up.',
    'Is Test Record': 'True when the row was processed under test mode.'
  };
  return notes[header] || '';
}
