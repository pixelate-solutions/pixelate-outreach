function showSendConfirmation() {
  cleanupStaleSendState_();
  var config = getConfig_();
  if (config['Test mode'] === true) throw new Error('Sending is disabled while Test mode is enabled.');
  if (!isValidEmail_(configuredFromEmail_(config))) throw new Error('Configure a valid default sender Gmail address or authorized alias before sending.');
  var candidates = collectSendCandidates_(config);
  if (!candidates.length) throw new Error('No approved, eligible emails or follow-ups are ready to send.');
  var remaining = dailySendRemaining_(config, new Date());
  if (remaining <= 0) throw new Error('The daily send limit has already been reached.');
  candidates = candidates.slice(0, remaining);
  var token = Utilities.getUuid();
  var createdAt = Date.now();
  PropertiesService.getUserProperties().setProperty(SEND_CONFIRMATION_PREFIX + token, JSON.stringify({
    createdAt: createdAt,
    items: candidates.map(function(candidate) { return { row: candidate.lead._rowNumber, type: candidate.type }; })
  }));
  writeSendProgress_(token, {
    status: 'ready',
    total: candidates.length,
    processed: 0,
    sent: 0,
    failed: 0,
    scheduled: 0,
    createdAt: createdAt,
    message: 'Ready for confirmation.'
  });
  var template = HtmlService.createTemplateFromFile('ConfirmationDialog');
  template.data = {
    token: token,
    count: candidates.length,
    dailyLimit: config['Maximum sends per day'],
    sender: configuredFromEmail_(config),
    items: candidates.map(function(candidate) {
      return { recipient: candidate.lead['Email'], company: candidate.lead['Company'], type: candidate.type };
    })
  };
  SpreadsheetApp.getUi().showModalDialog(template.evaluate().setWidth(650).setHeight(640), 'Confirm Approved Send');
}

function confirmSendBatch(token) {
  token = String(token || '');
  var property = SEND_CONFIRMATION_PREFIX + String(token || '');
  var lock = null;
  try {
    var json = PropertiesService.getUserProperties().getProperty(property);
    if (!json) throw new Error('This confirmation expired. Open Send Approved Emails again.');
    PropertiesService.getUserProperties().deleteProperty(property);
    var request = safeJsonParse_(json, null);
    if (!request || Date.now() - Number(request.createdAt) > 10 * 60 * 1000) throw new Error('This confirmation expired.');
    var config = getConfig_();
    if (config['Test mode'] === true) throw new Error('Sending is disabled in Test mode.');
    if (!isWithinSendWindow_(new Date(), config)) throw new Error('Current time is outside the configured send days/hours.');
    lock = LockService.getDocumentLock();
    if (!lock.tryLock(30000)) throw new Error('Another draft or send operation is running.');
    var remaining = dailySendRemaining_(config, new Date());
    if (remaining <= 0) throw new Error('The daily send limit has already been reached.');
    var items = request.items.slice(0, remaining);
    writeSendProgress_(token, {
      status: 'running',
      total: items.length,
      processed: 0,
      sent: 0,
      failed: 0,
      scheduled: 0,
      createdAt: request.createdAt,
      startedAt: Date.now(),
      message: 'Starting approved send...'
    });
    var summary = processConfirmedSendItems_(items, config, Date.now(), token);
    refreshCompanyOutreachWarnings_();
    return summary;
  } catch (error) {
    var progress = readSendProgress_(token) || { total: 0, processed: 0, sent: 0, failed: 0, scheduled: 0, createdAt: Date.now() };
    progress.status = 'failed';
    progress.completedAt = Date.now();
    progress.message = 'Sending stopped.';
    progress.lastError = truncate_(error.message, 500);
    writeSendProgress_(token, progress);
    throw error;
  } finally {
    if (lock) lock.releaseLock();
  }
}

function processConfirmedSendItems_(items, config, startedAt, progressToken) {
  var summary = { sent: 0, failed: 0, scheduled: 0 };
  var progress = readSendProgress_(progressToken) || {
    status: 'running', total: items.length, processed: 0, sent: 0, failed: 0, scheduled: 0, createdAt: Date.now(), startedAt: startedAt
  };
  for (var i = 0; i < items.length; i++) {
    if (isExecutionTimeLow_(startedAt, 260000)) {
      var remainder = items.slice(i);
      PropertiesService.getScriptProperties().setProperty(SEND_CONTINUATION_PROPERTY, JSON.stringify({ createdAt: Date.now(), items: remainder, progressToken: progressToken }));
      scheduleContinuation_('continueSendBatch_', 2);
      summary.scheduled = remainder.length;
      progress.status = 'scheduled';
      progress.scheduled = remainder.length;
      progress.message = 'The remaining emails are scheduled to continue in the background.';
      writeSendProgress_(progressToken, progress);
      break;
    }
    var lead = getLeadByRow_(Number(items[i].row));
    progress.status = 'running';
    progress.current = progress.processed + 1;
    progress.currentRecipient = lead ? lead['Email'] : 'Missing lead row ' + items[i].row;
    progress.message = 'Processing email ' + progress.current + ' of ' + progress.total + '...';
    writeSendProgress_(progressToken, progress);
    if (!lead) {
      summary.failed++;
      progress.failed++;
      progress.processed++;
      progress.lastError = 'The lead row no longer exists.';
      writeSendProgress_(progressToken, progress);
      continue;
    }
    try {
      if (items[i].type === 'follow_up') sendFollowUp_(lead, config);
      else sendInitial_(lead, config);
      summary.sent++;
      progress.sent++;
      progress.lastError = '';
      if (i < items.length - 1) sleepRandom_(700, 1600);
    } catch (error) {
      setLeadError_(lead, error, items[i].type === 'follow_up' ? 'Send Follow-Up' : 'Send Initial Email');
      summary.failed++;
      progress.failed++;
      progress.lastError = truncate_(error.message, 500);
    }
    progress.processed++;
    progress.scheduled = 0;
    progress.message = 'Processed ' + progress.processed + ' of ' + progress.total + '.';
    writeSendProgress_(progressToken, progress);
  }
  if (!summary.scheduled) {
    progress.status = 'completed';
    progress.currentRecipient = '';
    progress.completedAt = Date.now();
    progress.message = progress.failed ? 'Completed with some failures.' : 'Approved send completed.';
    writeSendProgress_(progressToken, progress);
  }
  return summary;
}

function continueSendBatch_() {
  var property = PropertiesService.getScriptProperties().getProperty(SEND_CONTINUATION_PROPERTY);
  if (!property) return { sent: 0, failed: 0, scheduled: 0 };
  var request = safeJsonParse_(property, null);
  if (!request || Date.now() - Number(request.createdAt) > 24 * 60 * 60 * 1000) {
    PropertiesService.getScriptProperties().deleteProperty(SEND_CONTINUATION_PROPERTY);
    throw new Error('Confirmed send continuation expired after 24 hours.');
  }
  var config = getConfig_();
  if (config['Test mode'] === true) {
    PropertiesService.getScriptProperties().deleteProperty(SEND_CONTINUATION_PROPERTY);
    throw new Error('Send continuation cancelled because Test mode is enabled.');
  }
  if (!isWithinSendWindow_(new Date(), config)) {
    updateScheduledSendProgress_(request.progressToken, request.items.length, 'Waiting for the configured send window.');
    scheduleContinuation_('continueSendBatch_', 60);
    return { sent: 0, failed: 0, scheduled: request.items.length };
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    updateScheduledSendProgress_(request.progressToken, request.items.length, 'Waiting for the active send operation to finish.');
    scheduleContinuation_('continueSendBatch_', 2);
    return { sent: 0, failed: 0, scheduled: request.items.length };
  }
  try {
    var remainingToday = dailySendRemaining_(config, new Date());
    if (remainingToday <= 0) {
      updateScheduledSendProgress_(request.progressToken, request.items.length, 'Waiting for the next available daily send allowance.');
      scheduleContinuation_('continueSendBatch_', 60);
      return { sent: 0, failed: 0, scheduled: request.items.length };
    }
    var currentItems = request.items.slice(0, remainingToday);
    var futureItems = request.items.slice(remainingToday);
    PropertiesService.getScriptProperties().deleteProperty(SEND_CONTINUATION_PROPERTY);
    var result = processConfirmedSendItems_(currentItems, config, Date.now(), request.progressToken);
    if (futureItems.length && !PropertiesService.getScriptProperties().getProperty(SEND_CONTINUATION_PROPERTY)) {
      PropertiesService.getScriptProperties().setProperty(SEND_CONTINUATION_PROPERTY, JSON.stringify({ createdAt: request.createdAt, items: futureItems, progressToken: request.progressToken }));
      updateScheduledSendProgress_(request.progressToken, futureItems.length, 'Waiting for the next available daily send allowance.');
      scheduleContinuation_('continueSendBatch_', 60);
      result.scheduled += futureItems.length;
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getSendProgress(token) {
  var progress = readSendProgress_(String(token || ''));
  return progress || { status: 'not_found', total: 0, processed: 0, sent: 0, failed: 0, scheduled: 0, message: 'No progress record was found.' };
}

function readSendProgress_(token) {
  if (!token) return null;
  return safeJsonParse_(PropertiesService.getScriptProperties().getProperty(SEND_PROGRESS_PREFIX + token), null);
}

function writeSendProgress_(token, progress) {
  if (!token || !progress) return;
  progress.updatedAt = Date.now();
  PropertiesService.getScriptProperties().setProperty(SEND_PROGRESS_PREFIX + token, JSON.stringify(progress));
}

function updateScheduledSendProgress_(token, count, message) {
  var progress = readSendProgress_(token);
  if (!progress) return;
  progress.status = 'scheduled';
  progress.scheduled = Number(count || 0);
  progress.message = message;
  writeSendProgress_(token, progress);
}

function cleanupStaleSendState_() {
  var now = Date.now();
  var scriptStore = PropertiesService.getScriptProperties();
  var scriptValues = scriptStore.getProperties();
  Object.keys(scriptValues).forEach(function(key) {
    if (key.indexOf(SEND_PROGRESS_PREFIX) !== 0) return;
    var value = safeJsonParse_(scriptValues[key], null);
    if (!value || now - Number(value.createdAt || value.updatedAt || 0) > 3 * 86400000) scriptStore.deleteProperty(key);
  });
  var userStore = PropertiesService.getUserProperties();
  var userValues = userStore.getProperties();
  Object.keys(userValues).forEach(function(key) {
    if (key.indexOf(SEND_CONFIRMATION_PREFIX) !== 0) return;
    var value = safeJsonParse_(userValues[key], null);
    if (!value || now - Number(value.createdAt || 0) > 60 * 60 * 1000) userStore.deleteProperty(key);
  });
}

function collectSendCandidates_(config) {
  var dnc = loadDoNotContactIndex_();
  var candidates = [];
  getAllLeads_().forEach(function(lead) {
    if (isDoNotContact_(lead, dnc)) return;
    if (lead['Follow-Up Approved'] === true && lead['Follow-Up Status'] !== 'Sent' && followUpEligible_(lead, config, new Date())) {
      candidates.push({ lead: lead, type: 'follow_up' });
      return;
    }
    var decision = draftDecision_(lead, config, dnc);
    if (lead['Approved'] === true && !hasPreviousSend_(lead) && decision.allowed) candidates.push({ lead: lead, type: 'initial' });
  });
  return candidates;
}

function sendInitial_(lead, config) {
  if (lead['Approved'] !== true) throw new Error('Initial email is not approved.');
  if (hasPreviousSend_(lead)) throw new Error('Initial email was already sent.');
  var decision = draftDecision_(lead, config, loadDoNotContactIndex_());
  if (!decision.allowed) throw new Error(decision.reasons.join(' '));
  var draftId = normalizeWhitespace_(lead['Gmail Draft ID']);
  if (!draftId || !gmailDraftExists_(draftId)) {
    var created = upsertInitialDraft_(lead, config);
    draftId = created.draftId;
    updateLeadRow_(lead._rowNumber, { 'Gmail Draft ID': draftId, 'Draft Status': 'Created' });
  } else {
    var updated = upsertInitialDraft_(lead, config);
    draftId = updated.draftId;
  }
  var message = sendExistingGmailDraft_(draftId);
  var sentAt = new Date();
  var due = new Date(sentAt.getTime() + Number(config['Follow-up delay']) * 86400000);
  updateLeadRow_(lead._rowNumber, {
    'Send Status': 'Sent',
    'Sent Message ID': message.id || '',
    'Gmail Thread ID': message.threadId || lead['Gmail Thread ID'],
    'Sent At': sentAt,
    'Follow-Up Due': due,
    'Approved': false,
    'Last Error': '',
    'Last Updated': sentAt
  });
  logActivity_({ lead: lead, action: 'Send Initial Email', result: 'Success', draftId: draftId, messageId: message.id || '', details: 'Explicitly approved and confirmed send.' });
}

function sendFollowUp_(lead, config) {
  if (lead['Follow-Up Approved'] !== true) throw new Error('Follow-up is not approved.');
  if (isDoNotContact_(lead)) throw new Error('Lead is on the Do Not Contact list.');
  if (!followUpEligible_(lead, config, new Date())) throw new Error('Follow-up is not eligible.');
  var draftId = normalizeWhitespace_(lead['Follow-Up Draft ID']);
  if (!draftId || !gmailDraftExists_(draftId)) draftId = createOrUpdateFollowUpDraft_(lead, config).id;
  else createOrUpdateFollowUpDraft_(lead, config);
  var message = sendExistingGmailDraft_(draftId);
  var sentAt = new Date();
  var count = Number(lead['Follow-Up Count'] || 0) + 1;
  var due = count < Number(config['Maximum follow-ups']) ? new Date(sentAt.getTime() + Number(config['Follow-up delay']) * 86400000) : '';
  updateLeadRow_(lead._rowNumber, {
    'Follow-Up Count': count,
    'Follow-Up Status': 'Sent',
    'Follow-Up Approved': false,
    'Follow-Up Due': due,
    'Gmail Thread ID': message.threadId || lead['Gmail Thread ID'],
    'Last Error': '',
    'Last Updated': sentAt
  });
  logActivity_({ lead: lead, action: 'Send Follow-Up', result: 'Success', draftId: draftId, messageId: message.id || '', details: 'Follow-up ' + count + ' explicitly approved and confirmed.' });
}

function dailySendRemaining_(config, now) {
  return calculateDailyRemaining_(Number(config['Maximum sends per day']), sentCountToday_(now, config['Timezone']));
}

function calculateDailyRemaining_(limit, sentCount) {
  return Math.max(0, Number(limit || 0) - Number(sentCount || 0));
}

function sentCountToday_(now, timezone) {
  var target = Utilities.formatDate(now, timezone || APP_TIMEZONE, 'yyyy-MM-dd');
  var sheet = SpreadsheetApp.getActive().getSheetByName('Activity Log');
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ACTIVITY_HEADERS.length).getValues();
  return rows.filter(function(row) {
    var timestamp = row[0];
    var action = String(row[4] || '');
    var result = String(row[5] || '');
    return timestamp instanceof Date && Utilities.formatDate(timestamp, timezone || APP_TIMEZONE, 'yyyy-MM-dd') === target && /^Send /.test(action) && result === 'Success';
  }).length;
}

function isWithinSendWindow_(date, config) {
  var timezone = config['Timezone'] || APP_TIMEZONE;
  var day = Utilities.formatDate(date, timezone, 'EEEE');
  var allowedDays = String(config['Send days'] || '').split(',').map(function(value) { return value.trim().toLowerCase(); });
  if (allowedDays.indexOf(day.toLowerCase()) === -1) return false;
  var current = Utilities.formatDate(date, timezone, 'HH:mm');
  var start = normalizeSendTime_(config['Send start time'], timezone);
  var end = normalizeSendTime_(config['Send end time'], timezone);
  if (!start || !end) return false;
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function normalizeSendTime_(value, timezone) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timezone || APP_TIMEZONE, 'HH:mm');
  }
  if (typeof value === 'number' && isFinite(value)) {
    var fraction = ((value % 1) + 1) % 1;
    var minutes = Math.round(fraction * 1440) % 1440;
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }
  var match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return '';
  var hour = Number(match[1]);
  var minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}
