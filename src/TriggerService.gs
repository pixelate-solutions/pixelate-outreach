function scheduleContinuation_(handlerFunction, minutesFromNow) {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handlerFunction) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(handlerFunction).timeBased().after(Math.max(1, Number(minutesFromNow || 1)) * 60000).create();
}

function enableAutomaticScheduling() {
  setConfigValue_('Automatic sending enabled', true);
  ensureAutomaticSendTrigger_();
  var status = {
    status: 'enabled',
    checkedAt: Date.now(),
    message: 'Automatic scheduling is enabled and checks every ' + AUTOMATIC_SEND_INTERVAL_MINUTES + ' minutes.'
  };
  writeAutomaticSendStatus_(status);
  logActivity_({ action: 'Enable Automatic Scheduling', result: 'Success', details: status.message });
  SpreadsheetApp.getActive().toast(status.message, APP_NAME, 7);
  return getAutomaticSchedulingStatus_();
}

function pauseAutomaticScheduling() {
  setConfigValue_('Automatic sending enabled', false);
  var status = {
    status: 'paused',
    checkedAt: Date.now(),
    message: 'Automatic scheduling is paused. The installed trigger will not send while this setting is off.'
  };
  writeAutomaticSendStatus_(status);
  logActivity_({ action: 'Pause Automatic Scheduling', result: 'Success', details: status.message });
  SpreadsheetApp.getActive().toast(status.message, APP_NAME, 7);
  return getAutomaticSchedulingStatus_();
}

function showAutomaticSchedulingStatus() {
  var status = getAutomaticSchedulingStatus_();
  var message = (status.enabled ? 'Enabled' : 'Paused') + '; trigger ' + (status.triggerInstalled ? 'installed' : 'not installed') + '. ' + (status.last.message || 'No scheduler run has been recorded yet.');
  SpreadsheetApp.getActive().toast(message, APP_NAME, 10);
  return status;
}

function ensureAutomaticSendTrigger_() {
  var matches = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === AUTOMATIC_SEND_TRIGGER_HANDLER;
  });
  if (matches.length === 1) return matches[0];
  matches.forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  return ScriptApp.newTrigger(AUTOMATIC_SEND_TRIGGER_HANDLER).timeBased().everyMinutes(AUTOMATIC_SEND_INTERVAL_MINUTES).create();
}

function getAutomaticSchedulingStatus_() {
  var config = getConfig_();
  var triggerInstalled = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === AUTOMATIC_SEND_TRIGGER_HANDLER;
  });
  return {
    enabled: config['Automatic sending enabled'] === true,
    triggerInstalled: triggerInstalled,
    intervalMinutes: AUTOMATIC_SEND_INTERVAL_MINUTES,
    last: safeJsonParse_(PropertiesService.getScriptProperties().getProperty(AUTOMATIC_SEND_STATUS_PROPERTY), {})
  };
}

function writeAutomaticSendStatus_(status) {
  var value = status || {};
  value.updatedAt = Date.now();
  PropertiesService.getScriptProperties().setProperty(AUTOMATIC_SEND_STATUS_PROPERTY, JSON.stringify(value));
}

function retryFailedRows() {
  var config = getConfig_();
  var researchRows = getAllLeads_().filter(function(lead) { return lead['Research Status'] === 'Failed'; }).slice(0, Number(config['Maximum leads per research batch'])).map(function(lead) { return lead._rowNumber; });
  var emailRows = getAllLeads_().filter(function(lead) {
    return lead['Research Status'] === 'Completed' && lead['Last Error'] && (!lead['Email Subject'] || lead['Draft Status'] === 'Failed');
  }).slice(0, Number(config['Maximum leads per generation batch'])).map(function(lead) { return lead._rowNumber; });
  var result = { research: null, emails: null };
  if (researchRows.length) result.research = researchRows_(researchRows);
  if (emailRows.length) result.emails = generateEmailRows_(emailRows);
  if (!researchRows.length && !emailRows.length) SpreadsheetApp.getActive().toast('No failed rows are ready to retry.', APP_NAME, 5);
  return result;
}

function clearProcessingLocks() {
  var count = 0;
  getAllLeads_().forEach(function(lead) {
    if (lead['Research Status'] === 'Processing' || lead['Research Status'] === 'Queued' || lead['Send Status'] === 'Queued') {
      var updates = { 'Last Error': 'Processing state cleared manually; row is ready to retry.', 'Last Updated': new Date() };
      if (lead['Research Status'] === 'Processing' || lead['Research Status'] === 'Queued') updates['Research Status'] = 'Failed';
      if (lead['Send Status'] === 'Queued') updates['Send Status'] = 'Not Sent';
      updateLeadRow_(lead._rowNumber, updates);
      count++;
    }
  });
  var handlers = ['researchNextBatch', 'generateNextEmailBatch', 'continueSendBatch_'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(trigger);
  });
  PropertiesService.getScriptProperties().deleteProperty(SEND_CONTINUATION_PROPERTY);
  logActivity_({ action: 'Clear Processing Locks', result: 'Success', details: count + ' row state(s) reset.' });
  SpreadsheetApp.getActive().toast(count + ' processing state(s) cleared.', APP_NAME, 5);
}

function removeAllPixelateTriggers() {
  var allowed = ['researchNextBatch', 'generateNextEmailBatch', 'continueSendBatch_', 'checkForReplies', AUTOMATIC_SEND_TRIGGER_HANDLER];
  var count = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (allowed.indexOf(trigger.getHandlerFunction()) > -1) {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });
  PropertiesService.getScriptProperties().deleteProperty(AUTOMATIC_SEND_STATUS_PROPERTY);
  return count;
}
