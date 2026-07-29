function logActivity_(entry) {
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Activity Log');
    if (!sheet) return;
    var data = entry || {};
    var lead = data.lead || {};
    sheet.appendRow([
      new Date(),
      data.leadId || lead['Lead ID'] || '',
      data.contact || lead['Full Name'] || '',
      data.company || lead['Company'] || '',
      data.action || '',
      data.result || '',
      truncate_(data.details || '', 5000),
      data.draftId || lead['Gmail Draft ID'] || '',
      data.messageId || lead['Sent Message ID'] || '',
      truncate_(data.error || '', 2000),
      data.executionId || executionId_()
    ]);
  } catch (ignored) {
    console.error('Activity logging failed: ' + ignored.message);
  }
}

