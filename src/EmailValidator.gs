function validateEmailJson_(email) {
  var errors = [];
  if (!email || typeof email !== 'object') errors.push('Email output is not an object.');
  if (!normalizeWhitespace_(email && email.subject)) errors.push('Subject is required.');
  if (!Array.isArray(email && email.subject_alternatives) || email.subject_alternatives.length !== 2) errors.push('Exactly two alternative subjects are required.');
  if (!normalizeWhitespace_(email && email.body_plain_text)) errors.push('Body is required.');
  var allowedImpactMetrics = ['labor_dollars_saved', 'revenue_gained', 'cycle_time_reduced', 'error_reduction', 'support_tickets_avoided', 'none'];
  if (allowedImpactMetrics.indexOf(String(email && email.impact_metric || '')) === -1) errors.push('impact_metric is invalid.');
  if (typeof (email && email.impact_hypothesis) !== 'string') errors.push('impact_hypothesis must be a string.');
  if (!Array.isArray(email && email.impact_assumptions) || email.impact_assumptions.length > 2) errors.push('impact_assumptions must be an array with no more than two items.');
  if (['High', 'Medium', 'Low'].indexOf(String(email && email.impact_confidence || '')) === -1) errors.push('impact_confidence is invalid.');
  if (!Array.isArray(email && email.quality_issues)) errors.push('quality_issues must be an array.');
  if (!Array.isArray(email && email.research_claims_used)) errors.push('research_claims_used must be an array.');
  if (!isFinite(Number(email && email.quality_score)) || Number(email.quality_score) < 0 || Number(email.quality_score) > 100) errors.push('quality_score must be between 0 and 100.');
  if (errors.length) throw new Error('Invalid email output: ' + errors.join(' '));
  return email;
}

function validateGeneratedEmail_(lead, email, config, existingBodies) {
  validateEmailJson_(email);
  var body = String(email.body_plain_text || '').trim();
  var subject = normalizeWhitespace_(email.subject);
  var issues = [];
  var hardIssues = [];
  var score = 100;
  var wordCount = countWords_(body);
  var maximum = Number(config['Maximum email word count'] || 110);
  var minimumConfidence = Number(config['Minimum research confidence'] || 65);

  function add(issue, penalty, hard) {
    if (issues.indexOf(issue) === -1) issues.push(issue);
    score -= penalty;
    if (hard && hardIssues.indexOf(issue) === -1) hardIssues.push(issue);
  }

  if (wordCount < 65) add('Email is shorter than the 65-word target.', 12, false);
  if (wordCount > maximum) add('Email exceeds the configured maximum word count.', 30, true);
  if (containsEmDash_(body + ' ' + subject)) add('Email contains an em dash.', 20, true);
  if (hasPlaceholder_(body + ' ' + subject)) add('Email contains placeholder text.', 35, true);
  BUZZWORDS.forEach(function(word) {
    if ((body + ' ' + subject).toLowerCase().indexOf(word) > -1) add('Email contains prohibited phrase: ' + word + '.', 15, true);
  });
  if (/^\s*(re|fwd)\s*:/i.test(subject)) add('First-contact subject uses a deceptive reply/forward prefix.', 30, true);
  if (body.indexOf(lead['First Name']) === -1) add('Recipient first name is missing or incorrect.', 25, true);
  if (body.toLowerCase().indexOf(String(lead['Company'] || '').toLowerCase()) === -1) add('Company name is missing or incorrect.', 20, true);
  if (!/[?]\s*$/.test(body)) add('Email does not end with one low-pressure question.', 10, false);
  var questionCount = (body.match(/\?/g) || []).length;
  if (questionCount > 1) add('Email contains more than one question.', 8, false);
  if ((body.match(/\bPixelate\b/gi) || []).length > 1) add('Pixelate is mentioned more than once.', 10, false);
  var projectPhrases = ['customer portal', 'dealer portal', 'service request portal', 'technical support system', 'order tracking', 'production tracking', 'parts-request system', 'maintenance-history portal', 'document library', 'manual library', 'field-service coordination', 'customer status dashboard', 'quote-request workflow', 'internal operations dashboard', 'equipment registration'];
  var projectMatches = projectPhrases.filter(function(phrase) { return body.toLowerCase().indexOf(phrase) > -1; });
  if (projectMatches.length > 1) add('Email appears to propose more than one primary project.', 20, true);
  if (/\b(book|schedule|grab)\b.{0,20}\b(call|meeting|calendar)\b/i.test(body)) add('Call to action may be too aggressive.', 12, false);
  if (/\b(amazing|impressive|incredible|love what|big fan)\b/i.test(body)) add('Email contains a generic or fake compliment.', 15, true);
  if (/\b(I know|you are struggling|you struggle|still using spreadsheets|current process is inefficient)\b/i.test(body)) add('Email contains an unsupported internal-process claim.', 30, true);
  if (/\b(without (?:changing|replacing)|no (?:changes?|replacement|migration)|replace(?:ment|s|d|ing)?|migrat(?:e|es|ed|ing|ion)|integrat(?:e|es|ed|ing|ion))\b/i.test(body)) add('Email contains an unsupported implementation or current-state claim.', 30, true);
  validateBusinessCaseEstimate_(email, body, config).forEach(function(issue) { add(issue, 25, true); });
  if (Number(lead['Research Confidence']) < minimumConfidence) add('Research confidence is below the configured threshold.', 40, true);
  if (!lead['Evidence 1 URL'] || !lead['Evidence 1']) add('Verified source evidence is missing.', 40, true);
  if (lead['Fit Level'] === 'Low' || Number(lead['Fit Score']) < Number(config['Minimum fit score'])) add('Lead is below the configured fit threshold.', 50, true);
  if (!email.safe_to_send) add('The generation model marked the email unsafe to send.', 30, true);
  if (!config['Allow case-study reference'] && /\b(case study|client|customer result|we built for)\b/i.test(body)) add('Email contains an unapproved case-study reference.', 40, true);

  var evidenceClaims = [lead['Evidence 1'], lead['Evidence 2']].filter(function(v) { return v; });
  var claimsUsed = email.research_claims_used || [];
  if (!claimsUsed.length) add('No research claim was declared as used.', 20, true);
  claimsUsed.forEach(function(claim) {
    var supported = evidenceClaims.some(function(evidence) { return jaccardSimilarity_(claim, evidence) >= 0.12; });
    if (!supported) add('A declared research claim is not supported by stored evidence.', 25, true);
  });

  var opener = String(email.personalized_opener || lead['Personalized Opener'] || '');
  var openerSpecific = evidenceClaims.some(function(evidence) { return jaccardSimilarity_(opener, evidence) >= 0.10; });
  if (opener.length < 25 || !openerSpecific) add('Personalized opener may be generic or weakly grounded.', 15, false);

  var firstTwoParagraphs = body.split(/\n\s*\n/).slice(0, 2).join(' ');
  (existingBodies || []).some(function(otherBody) {
    var otherFirstTwo = String(otherBody || '').split(/\n\s*\n/).slice(0, 2).join(' ');
    if (otherFirstTwo && jaccardSimilarity_(firstTwoParagraphs, otherFirstTwo) >= 0.78) {
      add('Opening paragraphs are too similar to another generated email.', 25, true);
      return true;
    }
    return false;
  });

  (email.quality_issues || []).forEach(function(issue) {
    if (normalizeWhitespace_(issue)) add('AI quality note: ' + normalizeWhitespace_(issue), 3, false);
  });
  score = Math.max(0, Math.min(score, Number(email.quality_score)));
  var minimumQuality = Number(config['Minimum email quality score'] || 80);
  var safe = hardIssues.length === 0 && score >= minimumQuality;
  return { score: score, issues: issues, hardIssues: hardIssues, safeToDraft: safe, wordCount: wordCount };
}

function validateBusinessCaseEstimate_(email, body, config) {
  var issues = [];
  var estimatesEnabled = config && config['Business-case estimates enabled'] === true;
  var metric = String(email && email.impact_metric || '');
  var hypothesis = normalizeWhitespace_(email && email.impact_hypothesis);
  var assumptions = Array.isArray(email && email.impact_assumptions) ? email.impact_assumptions.map(normalizeWhitespace_).filter(function(value) { return value; }) : [];
  var normalizedBody = normalizeWhitespace_(body);
  var hasFinancialOrPercent = /\b\d+(?:\.\d+)?%\b|\$\s?\d/i.test(body);

  if (!estimatesEnabled) {
    if (metric !== 'none' || hypothesis || assumptions.length || hasFinancialOrPercent) issues.push('Email contains a quantified business-case estimate while estimates are disabled.');
    return issues;
  }

  var configuredMetrics = configuredBusinessCaseMetrics_(config);
  if (configuredMetrics.indexOf(metric) === -1) issues.push('Business-case metric is not allowed by the configured priority list.');
  if (!hypothesis) issues.push('Business-case estimate is missing its declared impact hypothesis.');
  else if (normalizedBody.indexOf(hypothesis) === -1) issues.push('Declared impact hypothesis does not appear verbatim in the email body.');
  if (assumptions.length < 1 || assumptions.length > 2) issues.push('Business-case estimate must declare one or two assumptions.');
  assumptions.forEach(function(assumption) {
    if (normalizedBody.indexOf(assumption) === -1) issues.push('A declared impact assumption does not appear verbatim in the email body.');
  });
  if (!hasConservativeEstimateRange_(hypothesis)) issues.push('Business-case estimate must use one conservative numeric range with "to".');
  if (!/\b(could|may|might|roughly|about|approximately|estimate|estimated|hypothesis|potential|potentially)\b/i.test(hypothesis)) issues.push('Business-case estimate is not clearly framed as a hypothesis.');
  if (/\b(guarantee(?:d|s)?|will (?:save|generate|reduce|increase|return)|proven roi|payback (?:in|within)|actual savings?)\b/i.test(hypothesis)) issues.push('Business-case estimate promises or implies a guaranteed result.');
  return issues;
}

function hasConservativeEstimateRange_(value) {
  return /(?:\$\s?)?\d[\d,]*(?:\.\d+)?%?\s+to\s+(?:\$\s?)?\d[\d,]*(?:\.\d+)?%?/i.test(String(value || ''));
}

function unsupportedClaimWarnings_(lead, email) {
  return validateGeneratedEmail_(lead, email, getConfig_(), []).issues.filter(function(issue) {
    return /unsupported|unverified|evidence|claim|case-study/i.test(issue);
  });
}

function draftDecision_(lead, config, dncIndex) {
  var reasons = [];
  if (!isValidEmail_(lead['Email'])) reasons.push('Invalid or missing email.');
  if (INVALID_EMAIL_STATUSES.indexOf(String(lead['Email Status'] || '').toLowerCase()) > -1) reasons.push('Suppressed email status.');
  if (isDoNotContact_(lead, dncIndex)) reasons.push('Do Not Contact.');
  if (lead['Fit Level'] === 'Low' || Number(lead['Fit Score']) < Number(config['Minimum fit score'])) reasons.push('Below fit threshold.');
  if (Number(lead['Research Confidence']) < Number(config['Minimum research confidence'])) reasons.push('Below research-confidence threshold.');
  if (Number(lead['Email Quality Score']) < Number(config['Minimum email quality score'])) reasons.push('Below email-quality threshold.');
  if (!normalizeWhitespace_(lead['Email Subject']) || !normalizeWhitespace_(lead['Email Body'])) reasons.push('Email has not been generated.');
  if (String(lead['Email Quality Warnings'] || '').indexOf('[BLOCKING]') > -1) reasons.push('Blocking quality warning.');
  return { allowed: reasons.length === 0, reasons: reasons };
}
