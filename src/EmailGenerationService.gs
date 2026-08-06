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
  var existingBodyRecords = getAllLeads_().map(function(lead) {
    return { rowNumber: lead._rowNumber, body: lead['Email Body'] };
  }).filter(function(record) { return record.body; });
  var summary = { processed: 0, blocked: 0, failed: 0 };
  try {
    rows.forEach(function(row) {
      var lead = getLeadByRow_(row);
      if (!lead) return;
      try {
        assertLeadReadyForGeneration_(lead, config);
        var email = generateEmailForLead_(lead, config);
        var validation = validateGeneratedEmail_(lead, email, config, otherLeadBodies_(existingBodyRecords, lead._rowNumber));
        if (shouldRunSecondAiQualityCheck_(validation, email, config)) {
          var aiReview = runSecondAiEmailQualityCheck_(lead, email, config);
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
          if (Number(aiReview.quality_score) < Number(config['Minimum email quality score'])) {
            var scoreText = 'Second AI review quality score ' + Number(aiReview.quality_score) + ' is below the configured minimum of ' + Number(config['Minimum email quality score']) + '.';
            if (validation.issues.indexOf(scoreText) === -1) validation.issues.push(scoreText);
            if (validation.hardIssues.indexOf(scoreText) === -1) validation.hardIssues.push(scoreText);
          }
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
        existingBodyRecords = existingBodyRecords.filter(function(record) { return record.rowNumber !== lead._rowNumber; });
        existingBodyRecords.push({ rowNumber: lead._rowNumber, body: email.body_plain_text });
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

function otherLeadBodies_(records, rowNumber) {
  return (records || []).filter(function(record) {
    return Number(record.rowNumber) !== Number(rowNumber);
  }).map(function(record) { return record.body; }).filter(function(body) { return body; });
}

function shouldRunSecondAiQualityCheck_(validation, email, config) {
  if (config['Second AI quality check enabled'] !== true) return false;
  if (config['Business-case estimates enabled'] === true && email.impact_metric !== 'none') return true;
  return validation.score < 95 || (email.quality_issues || []).length > 0 || validation.issues.length > 0;
}

function runSecondAiEmailQualityCheck_(lead, email, config) {
  var estimatesEnabled = config && config['Business-case estimates enabled'] === true;
  var prompt = [
    'Independently review this cold email. Do not rewrite it.',
    'Recipient first name: ' + lead['First Name'],
    'Company: ' + lead['Company'],
    'Allowed verified evidence 1: ' + lead['Evidence 1'],
    'Allowed verified evidence 2: ' + (lead['Evidence 2'] || 'None'),
    'Allowed project: ' + lead['Recommended Project'],
    'Business-case estimates enabled: ' + (estimatesEnabled ? 'Yes' : 'No'),
    'Declared impact metric: ' + (email.impact_metric || 'none'),
    'Declared impact hypothesis: ' + (email.impact_hypothesis || 'None'),
    'Declared assumptions: ' + ((email.impact_assumptions || []).join(' | ') || 'None'),
    'Declared confidence: ' + (email.impact_confidence || 'Low'),
    'Subject: ' + email.subject,
    'Body: ' + email.body_plain_text,
    '',
    'Flag unsupported claims, wrong names, generic personalization, multiple projects, aggressive CTA, fake compliments, unapproved case studies, guaranteed outcomes, unlabeled metrics, and internal-system assumptions. A reasonable workflow possibility is allowed only when phrased as a possibility.',
    estimatesEnabled ? 'A business-case estimate is allowed only when the exact declared impact hypothesis appears in the body, uses a conservative numeric range, exposes one or two assumptions that also appear in the body, and uses could, may, might, roughly, about, approximately, estimate, hypothesis, or potential language. Recompute the estimate from its assumptions when the arithmetic is inspectable, and flag a materially inconsistent calculation. Do not flag a transparent hypothetical estimate merely because its assumptions are not verified facts. Flag it if it is presented as an actual result, guarantee, current-state fact, or case study.' : 'Any quantified financial or percentage claim is disallowed because business-case estimates are disabled.',
    'Scoring rubric: 90-100 means safe, grounded, specific, and compliant. 80-89 means safe with only minor nonblocking issues. Use a score below 80 only when unsupported_claims or quality_issues names at least one concrete defect. If safe_to_send is true and both issue arrays are empty, the score must be 90-100.'
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
  var estimateInstructions = businessCaseEstimateInstructions_(config);
  var estimateStructure = config['Business-case estimates enabled'] === true
    ? '[One concise business-case estimate sentence. State one or two assumptions, give one conservative numeric range, and use could, may, might, roughly, about, approximately, estimate, hypothesis, or potential language.]'
    : '[One concise operational workflow possibility using "could" or "may". Do not claim anything about current systems, processes, teams, ownership, integration, replacement, or migration.]';
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
    '[One verified company-specific observation that uses the exact company name "' + lead['Company'] + '".]',
    '',
    estimateStructure,
    '',
    'Pixelate could build [the one specific recommended portal/tool and its evidence-grounded capabilities].',
    '',
    '[One low-pressure question.]',
    '',
    estimateInstructions,
    'Rules: 65-' + config['Maximum email word count'] + ' words before signature and opt-out. Use the exact company name at least once. Mention Pixelate no more than once. Use exactly one project idea and no more than one quantified estimate. End with one question. Never claim that existing or current resources, systems, processes, teams, or tools will remain unchanged. Never make an integration, replacement, migration, or implementation claim. Do not use "without changing," "without replacing," or similar language. No markdown, links, signature, em dashes, fake compliments, aggressive CTA, guaranteed outcomes, unsupported metrics outside the declared business-case estimate, unsupported internal-system claims, internal-team assumptions, or generic opening. Generate two alternative subjects in addition to the selected subject. Do not use Re: or Fwd: on first contact.',
    'Structured-output rule: research_claims_used must contain only exact verbatim copies of Verified evidence 1 and/or Verified evidence 2. Do not put project hypotheses, paraphrases, or any other claim in that array.',
    'Scoring rule: use quality_score 90-100 when every rule is met. Use a score below 80 only when quality_issues names a concrete defect, and set safe_to_send false for any blocking defect.',
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

function configuredBusinessCaseMetrics_(config) {
  var allowed = ['labor_dollars_saved', 'revenue_gained', 'cycle_time_reduced', 'error_reduction', 'support_tickets_avoided'];
  var configured = String((config && config['Business-case metric priorities']) || '').split(',').map(function(value) {
    return normalizeWhitespace_(value).toLowerCase();
  }).filter(function(value, index, values) {
    return allowed.indexOf(value) > -1 && values.indexOf(value) === index;
  });
  return configured.length ? configured : allowed;
}

function businessCaseEstimateInstructions_(config) {
  if (!config || config['Business-case estimates enabled'] !== true) {
    return 'Business-case estimates are disabled. Set impact_metric to none, impact_hypothesis to an empty string, impact_assumptions to an empty array, and impact_confidence to Low. Do not include a dollar, percentage, ROI, payback, or other quantified outcome claim.';
  }
  var metrics = configuredBusinessCaseMetrics_(config);
  var hourlyRate = Math.max(1, Number(config['Default loaded hourly rate'] || 75));
  return [
    'Business-case estimate requirement:',
    'Choose exactly one metric from this priority order: ' + metrics.join(', ') + '.',
    'Create one conservative range from one or two transparent assumptions. Unknown volume, time, cost, conversion, error, or ticket inputs must be labeled as assumptions, never as facts about the company.',
    'Prefer labor_dollars_saved, cycle_time_reduced, error_reduction, or support_tickets_avoided. Use revenue_gained only when the verified evidence makes a revenue workflow directly relevant.',
    'For labor_dollars_saved, use $' + hourlyRate + ' per hour as the loaded-rate assumption unless verified evidence supplies a better figure, and show that rate in the email.',
    'Use simple arithmetic that a recipient can inspect: volume times time saved times loaded rate, cycle duration times a conservative reduction, or volume times a conservative error or ticket reduction.',
    'The impact_hypothesis must be the exact full estimate sentence copied verbatim from the email body. Every impact_assumptions item must also be an exact phrase copied from that sentence. Use no more than two items.',
    'The estimate sentence must include a numeric range using "to" and uncertainty language such as could, may, might, roughly, about, approximately, estimate, hypothesis, or potential.',
    'Set impact_confidence to High only when relevant calculation inputs are verified; otherwise use Medium or Low. Do not claim actual savings, guaranteed ROI, a payback period, or a customer result. Estimate assumptions are not research claims.'
  ].join(' ');
}
