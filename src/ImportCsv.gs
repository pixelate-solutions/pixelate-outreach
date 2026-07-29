function showCsvImportDialog() {
  var html = HtmlService.createHtmlOutputFromFile('CsvImportDialog').setWidth(760).setHeight(680);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import Apollo CSV');
}

function previewApolloCsv(csvText) {
  var rows = parseCsv_(csvText);
  if (rows.length < 2) throw new Error('The CSV does not contain a header and at least one data row.');
  var records = rowsToRecords_(rows);
  var mapped = records.map(mapApolloRecord_);
  var deduped = dedupeRecords_(mapped);
  var domains = {};
  deduped.unique.forEach(function(lead) { if (lead['Company Domain']) domains[lead['Company Domain']] = true; });
  return {
    rowCount: records.length,
    uniqueContactCount: deduped.unique.length,
    duplicateCount: deduped.duplicates.length,
    invalidEmailCount: deduped.unique.filter(function(lead) { return !isValidEmail_(lead['Email']); }).length,
    uniqueCompanyCount: Object.keys(domains).length,
    headers: rows[0],
    preview: deduped.unique.slice(0, 8).map(function(lead) {
      return {
        leadId: lead['Lead ID'], fullName: lead['Full Name'], email: lead['Email'],
        company: lead['Company'], domain: lead['Company Domain'], emailStatus: lead['Email Status']
      };
    })
  };
}

function importApolloCsv(csvText, updateExistingImportedFields) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another import or batch operation is running.');
  var executionId = executionId_();
  try {
    var rows = parseCsv_(csvText);
    var records = rowsToRecords_(rows);
    var deduped = dedupeRecords_(records.map(mapApolloRecord_));
    var existingByEmail = {};
    var existingById = {};
    getAllLeads_().forEach(function(lead) {
      if (normalizeEmail_(lead['Email'])) existingByEmail[normalizeEmail_(lead['Email'])] = lead;
      existingById[lead['Lead ID']] = lead;
    });
    var toAppend = [];
    var updated = 0;
    var skipped = 0;
    deduped.unique.forEach(function(imported) {
      var existing = existingByEmail[normalizeEmail_(imported['Email'])] || existingById[imported['Lead ID']];
      if (existing) {
        if (updateExistingImportedFields === true) {
          mergeImportedLead_(existing._rowNumber, imported);
          updated++;
        } else skipped++;
      } else {
        imported['Sequence Name'] = getConfig_()['Default sequence name'];
        toAppend.push(imported);
      }
    });
    appendLeadObjects_(toAppend);
    refreshCompanyOutreachWarnings_();
    var summary = {
      imported: toAppend.length,
      updated: updated,
      skippedExisting: skipped,
      duplicateRowsInFile: deduped.duplicates.length,
      invalidOrMissingEmails: deduped.unique.filter(function(lead) { return !isValidEmail_(lead['Email']); }).length,
      totalParsed: records.length
    };
    logActivity_({ action: 'Import Apollo CSV', result: 'Success', details: JSON.stringify(summary), executionId: executionId });
    return summary;
  } catch (error) {
    logActivity_({ action: 'Import Apollo CSV', result: 'Failed', error: error.message, executionId: executionId });
    throw error;
  } finally {
    lock.releaseLock();
  }
}
