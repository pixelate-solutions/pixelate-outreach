function openLeadReviewSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('ReviewSidebar').setTitle('Pixelate Lead Review');
  SpreadsheetApp.getUi().showSidebar(html);
}

function getReviewLead(rowNumber) {
  var leads = getAllLeads_();
  if (!leads.length) return { empty: true };
  var index = -1;
  if (rowNumber) index = leads.map(function(lead) { return lead._rowNumber; }).indexOf(Number(rowNumber));
  if (index < 0) {
    var active = getLeadsSheet_().getActiveCell().getRow();
    index = leads.map(function(lead) { return lead._rowNumber; }).indexOf(active);
  }
  if (index < 0) index = leads.findIndex(function(lead) { return lead['Research Status'] === 'Completed' || lead['Email Subject']; });
  if (index < 0) index = 0;
  var lead = leads[index];
  var config = getConfig_();
  return {
    empty: false,
    rowNumber: lead._rowNumber,
    previousRow: index > 0 ? leads[index - 1]._rowNumber : null,
    nextRow: index < leads.length - 1 ? leads[index + 1]._rowNumber : null,
    leadId: lead['Lead ID'],
    contact: lead['Full Name'],
    title: lead['Job Title'],
    company: lead['Company'],
    website: lead['Website'],
    fitScore: lead['Fit Score'],
    fitLevel: lead['Fit Level'],
    confidence: lead['Research Confidence'],
    recommendedProject: lead['Recommended Project'],
    subject: lead['Email Subject'],
    body: lead['Email Body'],
    approved: lead['Approved'] === true,
    draftStatus: lead['Draft Status'],
    warning: lead['Company Outreach Warning'],
    qualityWarnings: lead['Email Quality Warnings'],
    evidence: [
      { claim: lead['Evidence 1'], url: lead['Evidence 1 URL'] },
      { claim: lead['Evidence 2'], url: lead['Evidence 2 URL'] }
    ].filter(function(item) { return item.claim || item.url; }),
    signatureHtml: config['Gmail signature HTML'] || PropertiesService.getScriptProperties().getProperty(SIGNATURE_PROPERTY) || '',
    optOut: config['Opt-out sentence'] || ''
  };
}

function handleReviewAction(action, rowNumber) {
  var lead = getLeadByRow_(Number(rowNumber));
  if (!lead) throw new Error('Lead row no longer exists.');
  switch (action) {
    case 'approve':
      updateLeadRow_(lead._rowNumber, { 'Approved': true, 'Last Updated': new Date() });
      logActivity_({ lead: lead, action: 'Approve Email', result: 'Success' });
      break;
    case 'approve_draft':
      updateLeadRow_(lead._rowNumber, { 'Approved': true, 'Last Updated': new Date() });
      createDraftRows_([lead._rowNumber]);
      break;
    case 'regenerate':
      generateEmailRows_([lead._rowNumber]);
      break;
    case 'edit':
      var map = getLeadHeaderMap_();
      var sheet = getLeadsSheet_();
      SpreadsheetApp.getActive().setActiveSheet(sheet);
      sheet.setActiveRange(sheet.getRange(lead._rowNumber, map['Email Subject'], 1, map['Email Body'] - map['Email Subject'] + 1));
      break;
    case 'low_fit':
      updateLeadRow_(lead._rowNumber, { 'Fit Score': Math.min(Number(lead['Fit Score'] || 0), 49), 'Fit Level': 'Low', 'Approved': false, 'Draft Status': 'Blocked', 'Last Updated': new Date() });
      logActivity_({ lead: lead, action: 'Mark Low Fit', result: 'Success' });
      break;
    case 'dnc':
      addToDoNotContact_(lead, 'Marked from review sidebar', 'Review sidebar', '', true);
      break;
    case 'skip':
      logActivity_({ lead: lead, action: 'Skip Review', result: 'Success' });
      break;
    default:
      throw new Error('Unknown review action.');
  }
  return getReviewLead(lead._rowNumber);
}

