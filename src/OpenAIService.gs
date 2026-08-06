function researchOutputSchema_() {
  return {
    type: 'object',
    properties: {
      company_name: { type: 'string' },
      domain: { type: 'string' },
      segment: { type: 'string' },
      fit_score: { type: 'integer', minimum: 0, maximum: 100 },
      fit_level: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      research_summary: { type: 'string' },
      evidence: {
        type: 'array', minItems: 1, maxItems: 8,
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            source_url: { type: 'string' },
            source_type: { type: 'string', enum: ['official_company_website', 'trustworthy_public_source'] }
          },
          required: ['claim', 'source_url', 'source_type'],
          additionalProperties: false
        }
      },
      existing_portal_found: { type: 'boolean' },
      existing_portal_details: { type: 'string' },
      likely_workflow_problem: { type: 'string' },
      recommended_project: { type: 'string' },
      buyer_relevance: { type: 'string' },
      personalized_opener: { type: 'string' },
      confidence: { type: 'integer', minimum: 0, maximum: 100 },
      should_contact: { type: 'boolean' },
      disqualification_reason: { type: 'string' }
    },
    required: ['company_name', 'domain', 'segment', 'fit_score', 'fit_level', 'research_summary', 'evidence', 'existing_portal_found', 'existing_portal_details', 'likely_workflow_problem', 'recommended_project', 'buyer_relevance', 'personalized_opener', 'confidence', 'should_contact', 'disqualification_reason'],
    additionalProperties: false
  };
}

function emailOutputSchema_() {
  return {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      subject_alternatives: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } },
      body_plain_text: { type: 'string' },
      personalized_opener: { type: 'string' },
      project_hypothesis: { type: 'string' },
      impact_metric: { type: 'string', enum: ['labor_dollars_saved', 'revenue_gained', 'cycle_time_reduced', 'error_reduction', 'support_tickets_avoided', 'none'] },
      impact_hypothesis: { type: 'string' },
      impact_assumptions: { type: 'array', maxItems: 2, items: { type: 'string' } },
      impact_confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      cta: { type: 'string' },
      quality_score: { type: 'integer', minimum: 0, maximum: 100 },
      quality_issues: { type: 'array', items: { type: 'string' } },
      research_claims_used: { type: 'array', items: { type: 'string' } },
      safe_to_send: { type: 'boolean' }
    },
    required: ['subject', 'subject_alternatives', 'body_plain_text', 'personalized_opener', 'project_hypothesis', 'impact_metric', 'impact_hypothesis', 'impact_assumptions', 'impact_confidence', 'cta', 'quality_score', 'quality_issues', 'research_claims_used', 'safe_to_send'],
    additionalProperties: false
  };
}

function followUpOutputSchema_() {
  return {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body_plain_text: { type: 'string' },
      new_relevant_thought: { type: 'string' },
      safe_to_send: { type: 'boolean' }
    },
    required: ['subject', 'body_plain_text', 'new_relevant_thought', 'safe_to_send'],
    additionalProperties: false
  };
}

function emailQualityReviewSchema_() {
  return {
    type: 'object',
    properties: {
      safe_to_send: { type: 'boolean' },
      quality_score: { type: 'integer', minimum: 0, maximum: 100 },
      unsupported_claims: { type: 'array', items: { type: 'string' } },
      quality_issues: { type: 'array', items: { type: 'string' } }
    },
    required: ['safe_to_send', 'quality_score', 'unsupported_claims', 'quality_issues'],
    additionalProperties: false
  };
}

function callOpenAIJson_(request) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY);
  if (!apiKey) throw new Error('OpenAI API key is not configured. Use Pixelate Outreach > Secure API Key & Signature.');
  var config = getConfig_();
  var input = [
    { role: 'developer', content: request.systemPrompt },
    { role: 'user', content: request.userPrompt }
  ];
  var payload = {
    model: config['OpenAI model'],
    reasoning: { effort: config['OpenAI reasoning effort'] || 'low' },
    input: input,
    text: {
      format: {
        type: 'json_schema',
        name: request.schemaName,
        strict: true,
        schema: request.schema
      }
    },
    store: false
  };
  if (request.allowWebSearch === true) payload.tools = [{ type: 'web_search_preview', search_context_size: 'medium' }];
  var response = retryOperation_(function() {
    var httpResponse = UrlFetchApp.fetch(OPENAI_API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + apiKey }
    });
    var status = httpResponse.getResponseCode();
    var body = httpResponse.getContentText();
    if (status === 429 || status >= 500) {
      var transient = new Error('OpenAI API transient HTTP ' + status + ': ' + truncate_(body, 500));
      transient.transient = true;
      throw transient;
    }
    if (status < 200 || status >= 300) throw new Error('OpenAI API HTTP ' + status + ': ' + truncate_(body, 1200));
    return safeJsonParse_(body, null);
  }, { attempts: 4, baseDelayMs: 1000, retryWhen: function(error) { return error.transient === true; } });
  if (!response) throw new Error('OpenAI API returned invalid JSON.');
  if (response.error) throw new Error('OpenAI API error: ' + (response.error.message || JSON.stringify(response.error)));
  var outputText = '';
  var citations = [];
  (response.output || []).forEach(function(item) {
    if (item.type !== 'message') return;
    (item.content || []).forEach(function(content) {
      if (content.type === 'refusal') throw new Error('OpenAI refused the request: ' + (content.refusal || 'Unknown reason'));
      if (content.type === 'output_text') {
        outputText += content.text || '';
        (content.annotations || []).forEach(function(annotation) {
          if (annotation.url) citations.push(annotation.url);
        });
      }
    });
  });
  if (!outputText) throw new Error('OpenAI response did not contain output_text.');
  var parsed = safeJsonParse_(outputText, null);
  if (!parsed) throw new Error('OpenAI structured output could not be parsed.');
  return { data: parsed, citations: citations, responseId: response.id || '' };
}
