function checkForReplies() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another batch is already running.');
  var config = getConfig_();
  var summary = { checked: 0, replied: 0, optOuts: 0, failed: 0 };
  try {
    getAllLeads_().forEach(function(lead) {
      if (!hasPreviousSend_(lead) || lead['Reply Status'] === 'Replied') return;
      summary.checked++;
      try {
        var reply = findReplyForLead_(lead, config);
        if (!reply) return;
        var classification = classifyReply_(reply.text, reply.from);
        updateLeadRow_(lead._rowNumber, {
          'Reply Status': 'Replied',
          'Replied At': reply.date,
          'Reply Classification': classification,
          'Follow-Up Due': '',
          'Follow-Up Approved': false,
          'Last Error': '',
          'Last Updated': new Date()
        });
        if (classification === 'Unsubscribe') {
          addToDoNotContact_(lead, 'Unsubscribe reply', 'Gmail reply tracking', truncate_(reply.text, 500), true);
          summary.optOuts++;
        }
        logActivity_({ lead: lead, action: 'Detect Reply', result: 'Success', messageId: reply.messageId, details: classification });
        summary.replied++;
      } catch (error) {
        setLeadError_(lead, error, 'Check for Reply');
        summary.failed++;
      }
    });
    SpreadsheetApp.getActive().toast('Checked ' + summary.checked + '; found ' + summary.replied + ' replies.', APP_NAME, 6);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function findReplyForLead_(lead, config) {
  var threadId = normalizeWhitespace_(lead['Gmail Thread ID']);
  var thread = null;
  if (threadId) {
    try { thread = Gmail.Users.Threads.get('me', threadId, { format: 'full' }); } catch (error) {
      if (!/404|not found/i.test(error.message)) throw error;
    }
  }
  if (!thread) {
    var query = 'from:(' + normalizeEmail_(lead['Email']) + ') newer_than:1y';
    if (lead['Email Subject']) query += ' subject:"' + String(lead['Email Subject']).replace(/"/g, '') + '"';
    var listed = Gmail.Users.Threads.list('me', { q: query, maxResults: 5 });
    if (!listed.threads || !listed.threads.length) return null;
    thread = Gmail.Users.Threads.get('me', listed.threads[0].id, { format: 'full' });
    updateLeadRow_(lead._rowNumber, { 'Gmail Thread ID': thread.id });
  }
  var sentTime = lead['Sent At'] instanceof Date ? lead['Sent At'].getTime() : 0;
  var ownAddresses = [configuredFromEmail_(config), normalizeEmail_(config['Default sender Gmail address']), normalizeEmail_(config['Reply-to address'])].filter(function(v) { return v; });
  var replies = (thread.messages || []).map(function(message) {
    var from = extractGmailHeader_(message.payload, 'From');
    var fromAddress = normalizeEmail_((from.match(/<([^>]+)>/) || [null, from])[1]);
    return {
      messageId: message.id,
      from: from,
      fromAddress: fromAddress,
      date: new Date(Number(message.internalDate || 0)),
      text: extractGmailMessageText_(message.payload)
    };
  }).filter(function(message) {
    return message.date.getTime() > sentTime && ownAddresses.indexOf(message.fromAddress) === -1;
  }).sort(function(a, b) { return a.date - b.date; });
  return replies.length ? replies[0] : null;
}

function extractGmailHeader_(payload, name) {
  var target = String(name || '').toLowerCase();
  var headers = payload && payload.headers ? payload.headers : [];
  for (var i = 0; i < headers.length; i++) if (String(headers[i].name || '').toLowerCase() === target) return headers[i].value || '';
  return '';
}

function extractGmailMessageText_(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return base64UrlDecode_(payload.body.data);
  var plain = '';
  var html = '';
  (payload.parts || []).forEach(function(part) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) plain += base64UrlDecode_(part.body.data) + '\n';
    else if (part.mimeType === 'text/html' && part.body && part.body.data) html += stripHtml_(base64UrlDecode_(part.body.data)) + '\n';
    else if (part.parts) {
      var nested = extractGmailMessageText_(part);
      if (nested) plain += nested + '\n';
    }
  });
  if (!plain && payload.body && payload.body.data) plain = base64UrlDecode_(payload.body.data);
  return normalizeWhitespace_(plain || html);
}

function classifyReply_(body, from) {
  var text = (String(body || '') + ' ' + String(from || '')).toLowerCase();
  if (/unsubscribe|remove me|opt[ -]?out|do not (email|contact)|stop emailing/.test(text)) return 'Unsubscribe';
  if (/mailer-daemon|delivery status notification|undeliverable|address not found|recipient rejected|mailbox unavailable/.test(text)) return 'Invalid address';
  if (/out of (the )?office|automatic reply|auto.?reply|away from (the )?office|on vacation/.test(text)) return 'Out of office';
  if (/not interested|no interest|please don.?t|not a fit/.test(text)) return 'Not interested';
  if (/already (have|using|solved|covered)|we have .* in place|currently covered/.test(text)) return 'Already solved';
  if (/not now|circle back|later this|next (quarter|year|month)|bad timing|revisit/.test(text)) return 'Not now';
  if (/reach out to|contact .* instead|the right person|forwarded (this|your)|copied .* here/.test(text)) return 'Referral to another person';
  if (/send (me )?(more|some) (information|info|details)|tell me more|more information|what would/.test(text)) return 'Request for more information';
  if (/interested|let.?s (talk|chat|connect)|schedule|available .* (call|meeting)|sounds useful|yes[, ]/.test(text)) return 'Positive interest';
  return 'Other';
}

