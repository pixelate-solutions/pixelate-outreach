function onOpen() {
  buildMenu_();
}

function onInstall() {
  onOpen();
}

function viewActivityLog() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Activity Log');
  if (sheet) SpreadsheetApp.getActive().setActiveSheet(sheet);
}

