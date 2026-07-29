# Testing

## Automated local tests

Run:

```bash
cd /Users/morrison/Development/pixelate-outreach
npm test
npm run check
```

The test harness loads Apps Script-compatible pure functions into a Node VM and uses the real Apollo export as a fixture. It does not call OpenAI, Google, Gmail, or any contact.

Covered behavior:

- CSV parsing, including quoted commas, escaped quotes, and embedded newlines;
- Apollo field mapping against all 147 fixture records;
- email/domain normalization and deduplication;
- stable lead IDs and preservation of source JSON;
- fit-level thresholds;
- research JSON validation and High Fit evidence enforcement;
- email JSON validation and word count;
- em-dash and placeholder rejection;
- unsupported internal-process claim warnings;
- Do Not Contact enforcement by email/domain;
- draft create-vs-update idempotency;
- daily send-limit calculation;
- Detroit send-day/time enforcement;
- reply classification;
- follow-up eligibility, reply stop, and count cap;
- signature concatenation and duplicate prevention;
- HTML escaping;
- exponential retry behavior;
- Apps Script syntax, manifest timezone, advanced service, OAuth scopes, and absence of core TODO stubs.

## Manual integration test: Google Sheet

1. Bind and push the project as described in `SETUP.md`.
2. Run **Initialize Workbook**.
3. Confirm all required tabs exist, headers are frozen, Leads has filters/table controls, boolean fields render as checkboxes, and categorical fields offer valid dropdowns.
4. Confirm spreadsheet timezone is America/Detroit.
5. Confirm Dashboard begins at zero and contains no formula errors.

## Manual integration test: import

1. Keep Test mode on.
2. Open the CSV import dialog and select the real Apollo export.
3. Confirm the preview reports 147 parsed contacts before file-level deduplication.
4. Confirm the import summary and verify invalid/missing emails are flagged.
5. Import the file again without the refresh checkbox and verify existing rows are skipped.
6. Edit one workflow field, repeat with refresh enabled, and verify the workflow field is preserved.
7. Confirm companies with multiple contacts show an outreach warning only when another contact becomes active.

## Manual integration test: research and generation

Use a maximum of three selected rows.

1. Configure an OpenAI key.
2. Research the selected rows.
3. Open every evidence URL and verify the stored claim.
4. Confirm duplicate company contacts reuse cached research.
5. Confirm Low Fit or low-confidence rows cannot generate an email.
6. Generate emails for eligible rows.
7. Verify 65-110 words, one company detail, one project, one question, no signature, no markdown, no em dash, and no unsupported internal-system claim.
8. Generate multiple contacts and check that duplicate-opening warnings appear when substance is too similar.

## Manual integration test: Gmail draft safety

1. Configure only your own Test email address.
2. Load or paste the exact Gmail signature.
3. Approve one row and create a draft.
4. Confirm recipient override, `[TEST]` subject, plain-text part, HTML body, opt-out, inline signature styles/images/links, sender identity, and reply-to.
5. Edit the body in the Sheet and recreate the draft. Verify the Gmail Draft ID is unchanged and no duplicate draft appears.
6. Mark the row Do Not Contact and verify drafting is blocked.
7. Leave Test mode on and invoke Send Approved Emails. Verify sending is refused before a confirmation dialog.

## Manual integration test: production gates

Perform only when you are ready to send to an address you control.

1. Disable Test mode.
2. Set daily limit to 1.
3. Use a lead whose recipient is an address you control and whose evidence/quality gates pass.
4. Verify no send occurs without Approved=true.
5. Invoke Send Approved Emails; inspect and cancel once.
6. Invoke again, confirm the single controlled message, and verify Sent Message ID, Thread ID, Sent At, Send Status, Follow-Up Due, and Activity Log.
7. Try again and verify the previous-send gate blocks duplication.
8. Set an out-of-window time/day configuration and verify sending is blocked.

## Manual integration test: replies and follow-ups

1. Reply from the controlled recipient with representative language for positive, not interested, out-of-office, and unsubscribe cases.
2. Run Check for Replies and inspect classification/date/thread fields.
3. Verify unsubscribe adds email/domain to Do Not Contact and clears follow-up approval/due date.
4. Enable Follow-ups, set an eligible due date on an unreplied controlled thread, and generate a follow-up.
5. Verify it is under 70 words, adds a relevant thought, avoids “just following up,” and is unapproved by default.
6. Approve and create/update the follow-up draft. Confirm it remains in the original Gmail thread.
7. Confirm a reply or count of two blocks further follow-ups.

## Failure and recovery tests

- Temporarily use an invalid OpenAI key and confirm one failed row does not stop others.
- Restore the key and use Retry Failed Rows.
- Interrupt a research batch and confirm Clear Processing Locks resets only Processing/Queued state.
- Temporarily set a very small send batch/window in a controlled account and verify a confirmed continuation rechecks Test mode, daily limit, and window.
- Confirm Activity Log contains action, result, details, error, IDs, and execution ID without any API key.

