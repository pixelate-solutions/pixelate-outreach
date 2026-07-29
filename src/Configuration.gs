function getConfig_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Configuration');
  var config = {};
  Object.keys(DEFAULT_CONFIG).forEach(function(key) { config[key] = DEFAULT_CONFIG[key]; });
  if (!sheet || sheet.getLastRow() < 2) return config;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function(row) {
    var key = String(row[0] || '');
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return;
    config[key] = coerceConfigValue_(row[1], DEFAULT_CONFIG[key]);
  });
  config['OpenAI API key status'] = PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY) ? 'Configured' : 'Missing';
  return config;
}

function coerceConfigValue_(value, defaultValue) {
  if (typeof defaultValue === 'boolean') {
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
  }
  if (typeof defaultValue === 'number') {
    var number = Number(value);
    return isFinite(number) ? number : defaultValue;
  }
  return value == null ? '' : String(value);
}

function setConfigValue_(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) throw new Error('Unknown configuration setting: ' + key);
  var sheet = SpreadsheetApp.getActive().getSheetByName('Configuration');
  if (!sheet) throw new Error('Initialize the workbook first.');
  var values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === key) {
      sheet.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, CONFIG_DESCRIPTIONS[key] || '']);
}

function openConfiguration() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Configuration');
  if (!sheet) {
    initializeWorkbook();
    sheet = SpreadsheetApp.getActive().getSheetByName('Configuration');
  }
  SpreadsheetApp.getActive().setActiveSheet(sheet);
}

function showApiKeyDialog() {
  var html = HtmlService.createHtmlOutputFromFile('ConfigurationDialog').setWidth(520).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Secure Configuration');
}

function getSecureConfigurationForDialog() {
  var config = getConfig_();
  return {
    apiKeyConfigured: config['OpenAI API key status'] === 'Configured',
    signatureHtml: config['Gmail signature HTML'] || PropertiesService.getScriptProperties().getProperty(SIGNATURE_PROPERTY) || '',
    signaturePlainText: config['Gmail signature plain-text fallback'] || '',
    testEmail: config['Test email address'] || ''
  };
}

function saveSecureConfiguration(payload) {
  var data = payload || {};
  var apiKey = String(data.apiKey || '').trim();
  if (apiKey) PropertiesService.getScriptProperties().setProperty(OPENAI_KEY_PROPERTY, apiKey);
  if (data.clearApiKey === true) PropertiesService.getScriptProperties().deleteProperty(OPENAI_KEY_PROPERTY);
  if (typeof data.signatureHtml === 'string') {
    setConfigValue_('Gmail signature HTML', data.signatureHtml);
    PropertiesService.getScriptProperties().setProperty(SIGNATURE_PROPERTY, data.signatureHtml);
  }
  if (typeof data.signaturePlainText === 'string') setConfigValue_('Gmail signature plain-text fallback', data.signaturePlainText);
  if (typeof data.testEmail === 'string') setConfigValue_('Test email address', normalizeEmail_(data.testEmail));
  setConfigValue_('OpenAI API key status', PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY) ? 'Configured' : 'Missing');
  return { ok: true, status: getConfig_()['OpenAI API key status'] };
}

