function generateEmailsForSelectedLeads() {
  var rows = selectedLeadRows_();
  if (!rows.length) throw new Error('Select one or more lead rows first.');
  return generateEmailRows_(rows);
}

function generateNextEmailBatch() {
  var config = getConfig_();
  var rows = nextLeadRows_(Number(config['Maximum leads per generation batch']), function(lead) {
    return lead['Research Status'] === 'Completed' && !lead['Email Subject'] && lead['Fit Level'] !== 'Low' && !isDoNotContact_(lead);
  });
  if (!rows.length) {
    SpreadsheetApp.getActive().toast('No researched leads are waiting for email generation.', APP_NAME, 5);
    return { processed: 0 };
  }
  return generateEmailRows_(rows);
}

function generateEmailRows_(rows) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another batch is already running.');
  var config = getConfig_();
  var existingBodies = getAllLeads_().map(function(lead) { return lead['Email Body']; }).filter(function(body) { return body; });
  var summary = { processed: 0, blocked: 0, failed: 0 };
  try {
    rows.forEach(function(row) {
      var lead = getLeadByRow_(row);
      if (!lead) return;
      try {
        assertLeadReadyForGeneration_(lead, config);
        var email = generateEmailForLead_(lead, config);
        var validation = validateGeneratedEmail_(lead, email, config, existingBodies);
        if (shouldRunSecondAiQualityCheck_(validation, email, config)) {
          var aiReview = runSecondAiEmailQualityCheck_(lead, email);
          validation.score = Math.min(validation.score, Number(aiReview.quality_score));
          (aiReview.unsupported_claims || []).forEach(function(issue) {
            var text = 'Second AI review unsupported claim: ' + issue;
            if (validation.issues.indexOf(text) === -1) validation.issues.push(text);
            if (validation.hardIssues.indexOf(text) === -1) validation.hardIssues.push(text);
          });
          (aiReview.quality_issues || []).forEach(function(issue) {
            var text = 'Second AI review: ' + issue;
            if (validation.issues.indexOf(text) === -1) validation.issues.push(text);
          });
          if (!aiReview.safe_to_send) {
            var unsafeText = 'Second AI review marked the email unsafe to send.';
            validation.issues.push(unsafeText);
            validation.hardIssues.push(unsafeText);
          }
          validation.safeToDraft = validation.hardIssues.length === 0 && validation.score >= Number(config['Minimum email quality score']);
        }
        var warningText = validation.issues.map(function(issue) {
          return (validation.hardIssues.indexOf(issue) > -1 ? '[BLOCKING] ' : '') + issue;
        }).join('\n');
        updateLeadRow_(lead._rowNumber, {
          'Personalized Opener': email.personalized_opener || lead['Personalized Opener'],
          'Email Subject': email.subject,
          'Email Body': email.body_plain_text,
          'Email Quality Score': validation.score,
          'Email Quality Warnings': warningText,
          'Draft Status': validation.safeToDraft ? 'Not Created' : 'Blocked',
          'Approved': false,
          'Is Test Record': config['Test mode'] === true,
          'Last Error': validation.safeToDraft ? '' : 'Email requires review before drafting.',
          'Last Updated': new Date()
        });
        logActivity_({
          lead: lead,
          action: 'Generate Email',
          result: validation.safeToDraft ? 'Success' : 'Blocked',
          details: 'Quality ' + validation.score + '; ' + validation.wordCount + ' words; alternatives: ' + email.subject_alternatives.join(' | ')
        });
        existingBodies.push(email.body_plain_text);
        summary.processed++;
        if (!validation.safeToDraft) summary.blocked++;
      } catch (error) {
        setLeadError_(lead, error, 'Generate Email');
        summary.failed++;
      }
    });
    SpreadsheetApp.getActive().toast('Generated ' + summary.processed + ' email(s); ' + summary.blocked + ' require review.', APP_NAME, 6);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function shouldRunSecondAiQualityCheck_(validation, email, config) {
  if (config['Second AI quality check enabled'] !== true) return false;
  return validation.score < 95 || (email.quality_issues || []).length > 0 || validation.issues.length > 0;
}

function runSecondAiEmailQualityCheck_(lead, email) {
  var prompt = [
    'Independently review this cold email. Do not rewrite it.',
    'Recipient first name: ' + lead['First Name'],
    'Company: ' + lead['Company'],
    'Allowed verified evidence 1: ' + lead['Evidence 1'],
    'Allowed verified evidence 2: ' + (lead['Evidence 2'] || 'None'),
    'Allowed project: ' + lead['Recommended Project'],
    'Subject: ' + email.subject,
    'Body: ' + email.body_plain_text,
    '',
    'Flag unsupported claims, wrong names, generic personalization, multiple projects, aggressive CTA, fake compliments, invented metrics/case studies, and internal-system assumptions. A reasonable workflow possibility is allowed only when phrased as a possibility.'
  ].join('\n');
  return callOpenAIJson_({
    schemaName: 'pixelate_email_quality_review',
    schema: emailQualityReviewSchema_(),
    systemPrompt: 'You are an independent B2B outreach quality reviewer. Be strict about factual grounding and recipient safety. Return only the requested structured output.',
    userPrompt: prompt,
    allowWebSearch: false
  }).data;
}

function assertLeadReadyForGeneration_(lead, config) {
  if (isDoNotContact_(lead)) throw new Error('Lead is on the Do Not Contact list.');
  if (lead['Research Status'] !== 'Completed') throw new Error('Research must be completed without a manual-review flag.');
  if (lead['Fit Level'] === 'Low' || Number(lead['Fit Score']) < Number(config['Minimum fit score'])) throw new Error('Low-fit leads cannot receive generated emails.');
  if (Number(lead['Research Confidence']) < Number(config['Minimum research confidence'])) throw new Error('Research confidence is below the configured threshold.');
  if (!lead['Evidence 1'] || !lead['Evidence 1 URL']) throw new Error('Verified research evidence is required.');
  if (!lead['First Name'] || !lead['Company']) throw new Error('First name and company are required.');
}

function generateEmailForLead_(lead, config) {
  var allowedCaseStudy = config['Allow case-study reference'] === true && normalizeWhitespace_(config['Approved case-study text']);
  var userPrompt = [
    'Create one controlled first-contact email for this lead.',
    'Recipient first name: ' + lead['First Name'],
    'Recipient title: ' + (lead['Job Title'] || 'Unknown'),
    'Company: ' + lead['Company'],
    'Verified evidence 1: ' + lead['Evidence 1'] + ' (' + lead['Evidence 1 URL'] + ')',
    'Verified evidence 2: ' + (lead['Evidence 2'] ? lead['Evidence 2'] + ' (' + lead['Evidence 2 URL'] + ')' : 'None'),
    'Research summary: ' + lead['Research Summary'],
    'One recommended project: ' + lead['Recommended Project'],
    'Workflow possibility: ' + lead['Likely Workflow Problem'],
    'Buyer relevance: ' + lead['Buyer Relevance'],
    '',
    'Required structure:',
    'Hi ' + lead['First Name'] + ',',
    '',
    '[One verified company-specific observation.]',
    '',
    '[One concise operational workflow possibility.]',
    '',
    'Pixelate builds [the one specific recommended portal/tool] that connects those workflows without requiring a complete system replacement.',
    '',
    '[One low-pressure question.]',
    '',
    'Rules: 65-' + config['Maximum email word count'] + ' words before signature and opt-out. Mention Pixelate no more than once. Use exactly one project idea. End with one question. No markdown, links, signature, em dashes, fake compliments, aggressive CTA, invented metrics, unsupported internal-system claims, or generic opening. Generate two alternative subjects in addition to the selected subject. Do not use Re: or Fwd: on first contact.',
    allowedCaseStudy ? 'The only approved case-study language is: ' + config['Approved case-study text'] : 'Do not mention any case study or customer.'
  ].join('\n');
  var response = callOpenAIJson_({
    schemaName: 'pixelate_outreach_email',
    schema: emailOutputSchema_(),
    systemPrompt: getTemplate_('Email system prompt') + '\n' + getTemplate_('Email rules'),
    userPrompt: userPrompt,
    allowWebSearch: false
  });
  return validateEmailJson_(response.data);
}
