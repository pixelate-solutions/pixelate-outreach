function researchSelectedLeads() {
  var rows = selectedLeadRows_();
  if (!rows.length) throw new Error('Select one or more lead rows first.');
  return researchRows_(rows);
}

function researchNextBatch() {
  var config = getConfig_();
  var limit = Math.max(1, Number(config['Maximum leads per research batch']));
  var rows = nextLeadRows_(limit, function(lead) {
    return ['Not Started', 'Failed', 'Manual Review', ''].indexOf(String(lead['Research Status'] || '')) > -1 && !isDoNotContact_(lead);
  });
  if (!rows.length) {
    SpreadsheetApp.getActive().toast('No leads are waiting for research.', APP_NAME, 5);
    return { processed: 0 };
  }
  return researchRows_(rows);
}

function researchRows_(rows) {
  var config = getConfig_();
  if (!config['Research enabled']) throw new Error('Research is disabled in Configuration.');
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another batch is already running.');
  var startedAt = Date.now();
  var summary = { processed: 0, cached: 0, failed: 0, manualReview: 0 };
  var grouped = {};
  try {
    rows.forEach(function(row) {
      var lead = getLeadByRow_(row);
      if (!lead) return;
      var domain = normalizeDomain_(lead['Company Domain']) || normalizeDomain_(lead['Website']);
      if (!domain) {
        updateLeadRow_(row, { 'Research Status': 'Manual Review', 'Last Error': 'A valid company domain is required.', 'Last Updated': new Date() });
        summary.manualReview++;
        return;
      }
      if (!grouped[domain]) grouped[domain] = [];
      grouped[domain].push(lead);
    });
    var domains = Object.keys(grouped);
    for (var i = 0; i < domains.length; i++) {
      if (isExecutionTimeLow_(startedAt, 270000)) {
        scheduleContinuation_('researchNextBatch', 1);
        break;
      }
      var domain = domains[i];
      var companyLeads = grouped[domain];
      var representative = companyLeads[0];
      try {
        if (isDoNotContact_(representative)) throw new Error('Lead is on the Do Not Contact list.');
        companyLeads.forEach(function(lead) { updateLeadRow_(lead._rowNumber, { 'Research Status': 'Processing', 'Last Error': '', 'Last Updated': new Date() }); });
        var cached = getCompanyResearchCache_(domain);
        var research = cached;
        if (!research) {
          research = researchCompany_(representative);
          saveCompanyResearchCache_(domain, representative['Company'], research);
        } else summary.cached += companyLeads.length;
        companyLeads.forEach(function(lead) {
          applyResearchToLead_(lead, research);
          summary.processed++;
          if (research._manualReview) summary.manualReview++;
        });
      } catch (error) {
        companyLeads.forEach(function(lead) {
          updateLeadRow_(lead._rowNumber, { 'Research Status': 'Failed', 'Last Error': truncate_(error.message, 1000), 'Last Updated': new Date() });
          logActivity_({ lead: lead, action: 'Research Company', result: 'Failed', error: error.message });
          summary.failed++;
        });
      }
    }
    SpreadsheetApp.getActive().toast('Research processed ' + summary.processed + ' lead(s); ' + summary.failed + ' failed.', APP_NAME, 6);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function researchCompany_(lead) {
  var pages = fetchOfficialWebsitePages_(lead['Website'] || ('https://' + lead['Company Domain']));
  if (!pages.length) throw new Error('The official website could not be retrieved. Manual review is required.');
  var config = getConfig_();
  var provider = String(config['Research provider settings'] || '');
  var officialTextLength = pages.reduce(function(sum, page) { return sum + page.text.length; }, 0);
  var allowWebSearch = provider.indexOf('openai_web_search_fallback') > -1 && (pages.length < 2 || officialTextLength < 3000);
  var userPrompt = [
    'Research this company for a realistic Pixelate software project.',
    'Company: ' + lead['Company'],
    'Domain: ' + lead['Company Domain'],
    'Industry from Apollo (unverified context only): ' + (lead['Industry'] || 'Unknown'),
    'Employee count from Apollo (unverified context only): ' + (lead['Employee Count'] || 'Unknown'),
    '',
    'Fit rules: High 75-100, Medium 50-74, Low below 50. High requires at least two verified evidence items. Penalize software companies, agencies, recruiters, consultants, and unrelated businesses. Focus on equipment, installed machines, service, parts, maintenance, rentals, inspections, field technicians, support, documentation, training, dealers, distributors, installation, warranty, serial numbers, production status, and order status.',
    'Never state that the company uses spreadsheets, email, disconnected systems, or has a problem unless a source explicitly says so. Phrase inferred workflow needs as possibilities. Recommend exactly one concrete project. Use only URLs actually supplied below or found through the enabled web-search tool.',
    '',
    serializeWebsitePagesForPrompt_(pages)
  ].join('\n');
  var response = callOpenAIJson_({
    schemaName: 'pixelate_company_research',
    schema: researchOutputSchema_(),
    systemPrompt: getTemplate_('Research system prompt'),
    userPrompt: userPrompt,
    allowWebSearch: allowWebSearch
  });
  var allowedUrls = pages.map(function(page) { return page.url; }).concat(response.citations || []);
  var validated = validateResearchJson_(response.data, lead, allowedUrls, allowWebSearch);
  validated._responseId = response.responseId;
  return validated;
}

function validateResearchJson_(research, lead, allowedUrls, usedWebSearch) {
  var errors = [];
  if (!research || typeof research !== 'object') throw new Error('Research output is not an object.');
  var score = Number(research.fit_score);
  var confidence = Number(research.confidence);
  if (!isFinite(score) || score < 0 || score > 100) errors.push('fit_score must be between 0 and 100.');
  if (!isFinite(confidence) || confidence < 0 || confidence > 100) errors.push('confidence must be between 0 and 100.');
  if (research.fit_level !== fitLevel_(score)) errors.push('fit_level does not match fit_score.');
  if (!Array.isArray(research.evidence) || research.evidence.length < 1) errors.push('At least one evidence item is required.');
  if (research.fit_level === 'High' && research.evidence.length < 2) errors.push('High Fit requires at least two evidence items.');
  var officialDomain = normalizeDomain_(lead['Company Domain']);
  var canonicalAllowed = (allowedUrls || []).map(canonicalWebUrl_);
  (research.evidence || []).forEach(function(item, index) {
    if (!item.claim || !item.source_url || !/^https?:\/\//i.test(item.source_url)) errors.push('Evidence ' + (index + 1) + ' requires a claim and HTTP(S) source URL.');
    if (item.source_type === 'official_company_website' && normalizeDomain_(item.source_url) !== officialDomain) errors.push('Evidence ' + (index + 1) + ' is labeled official but uses a different domain.');
    if (!usedWebSearch && allowedUrls.indexOf(item.source_url) === -1 && normalizeDomain_(item.source_url) !== officialDomain) errors.push('Evidence ' + (index + 1) + ' URL was not among retrieved official sources.');
    if (item.source_type === 'trustworthy_public_source' && usedWebSearch && canonicalAllowed.indexOf(canonicalWebUrl_(item.source_url)) === -1) errors.push('Evidence ' + (index + 1) + ' public URL was not present in web-search citations.');
  });
  if (!research.recommended_project && research.should_contact) errors.push('A contactable company requires one recommended project.');
  if (errors.length) throw new Error('Invalid research output: ' + errors.join(' '));
  research.fit_score = score;
  research.confidence = confidence;
  research.domain = normalizeDomain_(research.domain) || officialDomain;
  research._manualReview = confidence < Number(getConfig_()['Minimum research confidence']) || research.evidence.length < 2;
  return research;
}

function canonicalWebUrl_(value) {
  return String(value || '').trim().replace(/^http:/i, 'https:').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
}

function applyResearchToLead_(lead, research) {
  var evidence = research.evidence || [];
  var status = research._manualReview ? 'Manual Review' : 'Completed';
  updateLeadRow_(lead._rowNumber, {
    'Segment': research.segment || lead['Segment'],
    'Fit Score': research.fit_score,
    'Fit Level': research.fit_level,
    'Research Status': status,
    'Research Summary': research.research_summary,
    'Evidence 1': evidence[0] ? evidence[0].claim : '',
    'Evidence 1 URL': evidence[0] ? evidence[0].source_url : '',
    'Evidence 2': evidence[1] ? evidence[1].claim : '',
    'Evidence 2 URL': evidence[1] ? evidence[1].source_url : '',
    'Additional Evidence': evidence.length > 2 ? JSON.stringify(evidence.slice(2)) : '',
    'Existing Portal Found': research.existing_portal_found,
    'Likely Workflow Problem': research.likely_workflow_problem,
    'Recommended Project': research.recommended_project,
    'Buyer Relevance': research.buyer_relevance,
    'Research Confidence': research.confidence,
    'Personalized Opener': research.personalized_opener,
    'Approved': false,
    'Last Error': research._manualReview ? 'Research requires manual review because confidence or evidence is below the configured standard.' : '',
    'Last Updated': new Date()
  });
  logActivity_({
    lead: lead,
    action: 'Research Company',
    result: status,
    details: 'Fit ' + research.fit_score + '; confidence ' + research.confidence + '; response ' + (research._responseId || 'cached')
  });
}

function getCompanyResearchCache_(domain) {
  var normalized = normalizeDomain_(domain);
  if (!normalized) return null;
  var memory = CacheService.getDocumentCache().get('research:' + normalized);
  if (memory) return safeJsonParse_(memory, null);
  var sheet = SpreadsheetApp.getActive().getSheetByName(CACHE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  for (var i = 0; i < values.length; i++) {
    if (normalizeDomain_(values[i][0]) === normalized) {
      var parsed = safeJsonParse_(values[i][2], null);
      if (parsed) CacheService.getDocumentCache().put('research:' + normalized, JSON.stringify(parsed), 21600);
      return parsed;
    }
  }
  return null;
}

function saveCompanyResearchCache_(domain, company, research) {
  var normalized = normalizeDomain_(domain);
  var sheet = SpreadsheetApp.getActive().getSheetByName(CACHE_SHEET);
  var json = JSON.stringify(research);
  var row = 0;
  if (sheet.getLastRow() > 1) {
    var domains = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < domains.length; i++) if (normalizeDomain_(domains[i][0]) === normalized) row = i + 2;
  }
  if (row) sheet.getRange(row, 1, 1, 4).setValues([[normalized, company || '', json, new Date()]]);
  else sheet.appendRow([normalized, company || '', json, new Date()]);
  CacheService.getDocumentCache().put('research:' + normalized, json, 21600);
}
