function refreshDashboard() {
  populateDashboard_();
  SpreadsheetApp.flush();
  return { refreshedAt: nowIso_() };
}

