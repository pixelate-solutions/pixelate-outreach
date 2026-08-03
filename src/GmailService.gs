function loadGmailSignature() {
  var config = getConfig_();
  var desired = normalizeEmail_(config['Default Gmail alias'] || config['Default sender Gmail address']);
  var result = Gmail.Users.Settings.SendAs.list('me');
  var identities = result.sendAs || [];
  var selected = null;
  for (var i = 0; i < identities.length; i++) {
    if (normalizeEmail_(identities[i].sendAsEmail) === desired) selected = identities[i];
  }
  if (!selected && identities.length === 1) selected = identities[0];
  if (!selected) throw new Error('Configured sender/alias was not found in Gmail send-as settings.');
  setConfigValue_('Default sender Gmail address', selected.sendAsEmail || desired);
  if (!config['Sender display name'] && selected.displayName) setConfigValue_('Sender display name', selected.displayName);
  setConfigValue_('Gmail signature HTML', selected.signature || '');
  PropertiesService.getScriptProperties().setProperty(SIGNATURE_PROPERTY, selected.signature || '');
  if (!config['Gmail signature plain-text fallback'] && selected.signature) setConfigValue_('Gmail signature plain-text fallback', stripHtml_(selected.signature));
  logActivity_({ action: 'Load Gmail Signature', result: 'Success', details: 'Loaded signature for ' + selected.sendAsEmail });
  SpreadsheetApp.getActive().toast('Gmail signature loaded for ' + selected.sendAsEmail + '.', APP_NAME, 5);
  return { email: selected.sendAsEmail, displayName: selected.displayName || '', hasSignature: Boolean(selected.signature) };
}

function createDraftsForSelectedLeads() {
  var rows = selectedLeadRows_();
  if (!rows.length) throw new Error('Select one or more lead rows first.');
  return createDraftRows_(rows);
}

function createDraftsForApprovedLeads() {
  var config = getConfig_();
  var rows = getAllLeads_().filter(function(lead) {
    var initial = lead['Approved'] === true && lead['Send Status'] !== 'Sent' && normalizeWhitespace_(lead['Email Subject']) !== '';
    var followUp = lead['Follow-Up Approved'] === true && lead['Send Status'] === 'Sent' && normalizeWhitespace_(lead['Follow-Up Body']) !== '';
    return initial || followUp;
  }).slice(0, Number(config['Maximum drafts per batch'])).map(function(lead) { return lead._rowNumber; });
  if (!rows.length) {
    SpreadsheetApp.getActive().toast('No approved leads are waiting for drafts.', APP_NAME, 5);
    return { created: 0 };
  }
  return createDraftRows_(rows);
}

function createDraftRows_(rows) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another draft or send operation is running.');
  var config = getConfig_();
  var dnc = loadDoNotContactIndex_();
  var summary = { created: 0, updated: 0, blocked: 0, failed: 0 };
  try {
    rows.slice(0, Number(config['Maximum drafts per batch'])).forEach(function(row) {
      var lead = getLeadByRow_(row);
      if (!lead) return;
      try {
        if (lead['Send Status'] === 'Sent' && lead['Follow-Up Approved'] === true) {
          if (!followUpEligible_(lead, config, new Date())) throw new Error('Follow-up is not eligible or is blocked.');
          var followUpDraft = createOrUpdateFollowUpDraft_(lead, config);
          updateLeadRow_(lead._rowNumber, { 'Is Test Record': config['Test mode'] === true, 'Last Error': '', 'Last Updated': new Date() });
          if (lead['Follow-Up Draft ID']) summary.updated++;
          else summary.created++;
          return;
        }
        if (lead['Approved'] !== true) throw new Error('Approve the lead before creating a draft.');
        var decision = draftDecision_(lead, config, dnc);
        if (!decision.allowed) throw new Error(decision.reasons.join(' '));
        var result = upsertInitialDraft_(lead, config);
        updateLeadRow_(lead._rowNumber, {
          'Draft Status': result.updated ? 'Updated' : 'Created',
          'Gmail Draft ID': result.draftId,
          'Gmail Thread ID': result.threadId || lead['Gmail Thread ID'],
          'Is Test Record': config['Test mode'] === true,
          'Last Error': '',
          'Last Updated': new Date()
        });
        logActivity_({ lead: lead, action: result.updated ? 'Update Gmail Draft' : 'Create Gmail Draft', result: 'Success', draftId: result.draftId, details: config['Test mode'] ? 'Test recipient enforced.' : 'Production recipient draft.' });
        if (result.updated) summary.updated++;
        else summary.created++;
      } catch (error) {
        updateLeadRow_(lead._rowNumber, { 'Draft Status': /Approve|threshold|Contact|Invalid|blocked|quality/i.test(error.message) ? 'Blocked' : 'Failed', 'Last Error': truncate_(error.message, 1000), 'Last Updated': new Date() });
        logActivity_({ lead: lead, action: 'Create Gmail Draft', result: 'Failed', error: error.message });
        if (/Approve|threshold|Contact|Invalid|blocked|quality/i.test(error.message)) summary.blocked++;
        else summary.failed++;
      }
    });
    refreshCompanyOutreachWarnings_();
    SpreadsheetApp.getActive().toast('Drafts: ' + summary.created + ' created, ' + summary.updated + ' updated, ' + summary.blocked + ' blocked.', APP_NAME, 6);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function upsertInitialDraft_(lead, config) {
  var message = buildInitialMimeMessage_(lead, config);
  var resource = { message: { raw: message.raw } };
  var draftId = normalizeWhitespace_(lead['Gmail Draft ID']);
  var updated = false;
  var draft;
  var existingDraft = draftId ? gmailDraftExists_(draftId) : false;
  if (draftMutationPlan_(draftId, existingDraft) === 'update') {
    draft = saveGmailDraft_(draftId, resource);
    updated = true;
  } else {
    draft = saveGmailDraft_('', resource);
  }
  return { draftId: draft.id, messageId: draft.message && draft.message.id, threadId: draft.message && draft.message.threadId, updated: updated };
}

function draftMutationPlan_(draftId, existingDraftFound) {
  return normalizeWhitespace_(draftId) && existingDraftFound === true ? 'update' : 'create';
}

function buildInitialMimeMessage_(lead, config) {
  var recipient = normalizeEmail_(lead['Email']);
  var subject = normalizeWhitespace_(lead['Email Subject']);
  if (config['Test mode'] === true) {
    recipient = normalizeEmail_(config['Test email address']);
    if (!isValidEmail_(recipient)) throw new Error('Test mode requires a valid configured test email address.');
    if (subject.indexOf('[TEST]') !== 0) subject = '[TEST] ' + subject;
  }
  var signatureHtml = config['Gmail signature HTML'] || PropertiesService.getScriptProperties().getProperty(SIGNATURE_PROPERTY) || '';
  var signaturePlain = config['Gmail signature plain-text fallback'] || stripHtml_(signatureHtml);
  var complianceFooter = [config['Opt-out sentence'] || '', config['Physical mailing address'] || ''].filter(function(value) { return normalizeWhitespace_(value); }).join(' ');
  var plain = concatenateSignature_(lead['Email Body'], complianceFooter, signaturePlain, false);
  var html = concatenateSignature_(lead['Email Body'], complianceFooter, signatureHtml, true);
  var raw = buildMimeMessage_({
    to: recipient,
    subject: subject,
    fromEmail: configuredFromEmail_(config),
    fromName: config['Sender display name'],
    replyTo: config['Reply-to address'],
    plainText: plain,
    html: html
  });
  return { raw: raw, recipient: recipient, subject: subject };
}

function buildFollowUpMimeMessage_(lead, config) {
  var recipient = normalizeEmail_(lead['Email']);
  var subject = normalizeWhitespace_(lead['Follow-Up Subject'] || lead['Email Subject']);
  if (config['Test mode'] === true) {
    recipient = normalizeEmail_(config['Test email address']);
    if (!isValidEmail_(recipient)) throw new Error('Test mode requires a valid configured test email address.');
    if (subject.indexOf('[TEST]') !== 0) subject = '[TEST] ' + subject;
  }
  var signatureHtml = config['Gmail signature HTML'] || PropertiesService.getScriptProperties().getProperty(SIGNATURE_PROPERTY) || '';
  var signaturePlain = config['Gmail signature plain-text fallback'] || stripHtml_(signatureHtml);
  var complianceFooter = [config['Opt-out sentence'] || '', config['Physical mailing address'] || ''].filter(function(value) { return normalizeWhitespace_(value); }).join(' ');
  var plain = concatenateSignature_(lead['Follow-Up Body'], complianceFooter, signaturePlain, false);
  var html = concatenateSignature_(lead['Follow-Up Body'], complianceFooter, signatureHtml, true);
  var headers = {};
  var rfcMessageId = getRfcMessageId_(lead['Sent Message ID']);
  if (rfcMessageId) {
    headers['In-Reply-To'] = rfcMessageId;
    headers.References = headers['In-Reply-To'];
  }
  return buildMimeMessage_({
    to: recipient,
    subject: /^Re:/i.test(subject) ? subject : 'Re: ' + subject,
    fromEmail: configuredFromEmail_(config),
    fromName: config['Sender display name'],
    replyTo: config['Reply-to address'],
    plainText: plain,
    html: html,
    headers: headers
  });
}

function getRfcMessageId_(gmailMessageId) {
  if (!gmailMessageId) return '';
  try {
    var message = Gmail.Users.Messages.get('me', gmailMessageId, { format: 'metadata', metadataHeaders: ['Message-ID'] });
    var value = extractGmailHeader_(message.payload, 'Message-ID');
    return value ? (value.charAt(0) === '<' ? value : '<' + value.replace(/[<>]/g, '') + '>') : '';
  } catch (error) {
    console.warn('Could not resolve RFC Message-ID: ' + error.message);
    return '';
  }
}

function buildMimeMessage_(options) {
  var boundary = 'pixelate_' + Utilities.getUuid().replace(/-/g, '');
  var fromEmail = normalizeEmail_(options.fromEmail);
  if (!isValidEmail_(fromEmail)) throw new Error('A valid default sender Gmail address or authorized alias is required.');
  var from = options.fromName ? '"' + decodeHeaderValue_(options.fromName).replace(/"/g, '\\"') + '" <' + fromEmail + '>' : fromEmail;
  var lines = [
    'MIME-Version: 1.0',
    'From: ' + from,
    'To: ' + decodeHeaderValue_(options.to),
    'Subject: ' + encodeMimeHeader_(options.subject),
    options.replyTo ? 'Reply-To: ' + decodeHeaderValue_(options.replyTo) : '',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  ];
  var extra = options.headers || {};
  Object.keys(extra).forEach(function(name) { if (extra[name]) lines.push(name + ': ' + decodeHeaderValue_(extra[name])); });
  lines = lines.filter(function(line) { return line !== ''; });
  lines.push('', '--' + boundary, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64_(Utilities.base64Encode(String(options.plainText || ''), Utilities.Charset.UTF_8)), '--' + boundary, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64_(Utilities.base64Encode(String(options.html || ''), Utilities.Charset.UTF_8)), '--' + boundary + '--', '');
  return Utilities.base64EncodeWebSafe(lines.join('\r\n'), Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function wrapBase64_(value) {
  return String(value || '').replace(/.{1,76}/g, '$&\r\n').trim();
}

function encodeMimeHeader_(value) {
  var text = decodeHeaderValue_(value);
  return /^[\x20-\x7E]*$/.test(text) ? text : '=?UTF-8?B?' + Utilities.base64Encode(text, Utilities.Charset.UTF_8) + '?=';
}

function configuredFromEmail_(config) {
  return normalizeEmail_(config['Default Gmail alias'] || config['Default sender Gmail address']);
}

function gmailDraftExists_(draftId) {
  try {
    gmailApiRequest_('get', 'drafts/' + encodeURIComponent(draftId) + '?format=minimal');
    return true;
  } catch (error) {
    if (Number(error.statusCode) === 404 || /404|not found|Invalid draft/i.test(error.message)) return false;
    throw error;
  }
}

function saveGmailDraft_(draftId, resource) {
  var id = normalizeWhitespace_(draftId);
  return gmailApiRequest_(id ? 'put' : 'post', id ? 'drafts/' + encodeURIComponent(id) : 'drafts', resource);
}

function sendExistingGmailDraft_(draftId) {
  var id = normalizeWhitespace_(draftId);
  if (!id) throw new Error('A Gmail draft ID is required before sending.');
  return gmailApiRequest_('post', 'drafts/send', { id: id });
}

function gmailApiRequest_(method, path, payload) {
  var options = {
    method: String(method || 'get').toLowerCase(),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (payload !== undefined) {
    options.contentType = 'application/json; charset=UTF-8';
    options.payload = JSON.stringify(payload);
  }
  var response = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + String(path || '').replace(/^\/+/, ''), options);
  var status = response.getResponseCode();
  var body = response.getContentText();
  var parsed = safeJsonParse_(body, {});
  if (status < 200 || status >= 300) {
    var message = parsed && parsed.error && parsed.error.message ? parsed.error.message : (body || 'Unknown Gmail API error');
    var error = new Error('Gmail API request failed (' + status + '): ' + truncate_(message, 500));
    error.statusCode = status;
    throw error;
  }
  return parsed;
}

function createOrUpdateFollowUpDraft_(lead, config) {
  var raw = buildFollowUpMimeMessage_(lead, config);
  var resource = { message: { raw: raw, threadId: lead['Gmail Thread ID'] || undefined } };
  var draftId = normalizeWhitespace_(lead['Follow-Up Draft ID']);
  var draft;
  var updated = false;
  if (draftId && gmailDraftExists_(draftId)) {
    draft = saveGmailDraft_(draftId, resource);
    updated = true;
  } else draft = saveGmailDraft_('', resource);
  updateLeadRow_(lead._rowNumber, { 'Follow-Up Draft ID': draft.id, 'Follow-Up Status': 'Draft Created', 'Last Updated': new Date() });
  logActivity_({ lead: lead, action: updated ? 'Update Follow-Up Draft' : 'Create Follow-Up Draft', result: 'Success', draftId: draft.id });
  return draft;
}
