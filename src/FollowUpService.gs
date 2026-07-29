function generateFollowUps() {
  var config = getConfig_();
  if (config['Follow-ups enabled'] !== true) throw new Error('Follow-ups are disabled in Configuration.');
  var eligible = getAllLeads_().filter(function(lead) { return followUpEligible_(lead, config, new Date()); });
  if (!eligible.length) {
    SpreadsheetApp.getActive().toast('No leads are eligible for a follow-up.', APP_NAME, 5);
    return { generated: 0 };
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another batch is already running.');
  var summary = { generated: 0, failed: 0 };
  try {
    eligible.slice(0, Number(config['Maximum leads per generation batch'])).forEach(function(lead) {
      try {
        var output = generateFollowUpForLead_(lead, config);
        var body = String(output.body_plain_text || '').trim();
        var issues = [];
        if (countWords_(body) > 70) issues.push('Follow-up exceeds 70 words.');
        if (/just following up|following up on my/i.test(body)) issues.push('Follow-up uses prohibited follow-up phrasing.');
        if (containsEmDash_(body)) issues.push('Follow-up contains an em dash.');
        if (hasPlaceholder_(body)) issues.push('Follow-up contains placeholder text.');
        if (!output.safe_to_send) issues.push('Model marked follow-up unsafe.');
        if (issues.length) throw new Error(issues.join(' '));
        updateLeadRow_(lead._rowNumber, {
          'Follow-Up Subject': output.subject || lead['Email Subject'],
          'Follow-Up Body': body,
          'Follow-Up Approved': false,
          'Follow-Up Status': 'Generated',
          'Last Error': '',
          'Last Updated': new Date()
        });
        logActivity_({ lead: lead, action: 'Generate Follow-Up', result: 'Success', details: countWords_(body) + ' words.' });
        summary.generated++;
      } catch (error) {
        updateLeadRow_(lead._rowNumber, { 'Follow-Up Status': 'Failed', 'Last Error': truncate_(error.message, 1000), 'Last Updated': new Date() });
        logActivity_({ lead: lead, action: 'Generate Follow-Up', result: 'Failed', error: error.message });
        summary.failed++;
      }
    });
    SpreadsheetApp.getActive().toast('Generated ' + summary.generated + ' follow-up(s); approval is still required.', APP_NAME, 6);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function followUpEligible_(lead, config, now) {
  if (config['Follow-ups enabled'] !== true) return false;
  if (!hasPreviousSend_(lead)) return false;
  if (lead['Reply Status'] === 'Replied') return false;
  if (isDoNotContact_(lead, { emails: {}, domains: {}, companies: {} })) return false;
  if (Number(lead['Follow-Up Count'] || 0) >= Number(config['Maximum follow-ups'] || 2)) return false;
  var due = lead['Follow-Up Due'];
  if (!(due instanceof Date)) {
    if (!due) return false;
    due = new Date(due);
  }
  return isFinite(due.getTime()) && due.getTime() <= now.getTime();
}

function generateFollowUpForLead_(lead, config) {
  var prompt = [
    'Write one approval-required follow-up for this recipient.',
    'First name: ' + lead['First Name'],
    'Company: ' + lead['Company'],
    'Original subject: ' + lead['Email Subject'],
    'Original project hypothesis: ' + lead['Recommended Project'],
    'Verified evidence: ' + lead['Evidence 1'],
    'Original email: ' + lead['Email Body'],
    '',
    'Add one relevant thought connected to the project hypothesis. Keep it under 70 words. Do not say just following up. Do not invent new facts. End with one low-pressure question. Return a subject suitable for the existing thread; do not add Re: yourself.'
  ].join('\n');
  return callOpenAIJson_({
    schemaName: 'pixelate_follow_up',
    schema: followUpOutputSchema_(),
    systemPrompt: getTemplate_('Email system prompt') + '\n' + getTemplate_('Follow-up rule'),
    userPrompt: prompt,
    allowWebSearch: false
  }).data;
}
