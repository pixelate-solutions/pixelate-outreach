function scheduleContinuation_(handlerFunction, minutesFromNow) {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handlerFunction) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(handlerFunction).timeBased().after(Math.max(1, Number(minutesFromNow || 1)) * 60000).create();
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
  PropertiesService.getScriptProperties().deleteProperty('SEND_CONTINUATION');
  logActivity_({ action: 'Clear Processing Locks', result: 'Success', details: count + ' row state(s) reset.' });
  SpreadsheetApp.getActive().toast(count + ' processing state(s) cleared.', APP_NAME, 5);
}

function removeAllPixelateTriggers() {
  var allowed = ['researchNextBatch', 'generateNextEmailBatch', 'continueSendBatch_', 'checkForReplies'];
  var count = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (allowed.indexOf(trigger.getHandlerFunction()) > -1) {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });
  return count;
}
