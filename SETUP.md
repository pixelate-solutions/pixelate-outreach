# Setup and deployment

The native Google Sheet is:

https://docs.google.com/spreadsheets/d/1HFYt7STSJIYV3D_FgmBNjbaZ5utdJPbp48p0-Nhw7qo/edit

It already contains the required tabs, formatting, dashboard formulas, a native Leads table, dropdown columns, checkbox/boolean columns, and the `America/Detroit` timezone. The remaining deployment step requires your Google authorization because a bound Apps Script project cannot be created or pushed on your behalf without `clasp` OAuth.

## 1. Enable Apps Script API access

Open https://script.google.com/home/usersettings and enable **Google Apps Script API** for the Google account that owns the Sheet.

## 2. Install and authenticate clasp

From this repository:

```bash
cd /Users/morrison/Development/pixelate-outreach
npm install
npx clasp login
```

Complete the Google OAuth flow using the same account that owns the Sheet. The repository currently reports `Not logged in` from `npx clasp show-authorized-user`, so this step is required.

## 3. Create the container-bound Apps Script project

Run exactly:

```bash
npx clasp create \
  --type sheets \
  --title "Pixelate Outbound Assistant" \
  --parentId 1HFYt7STSJIYV3D_FgmBNjbaZ5utdJPbp48p0-Nhw7qo \
  --rootDir src
```

This creates `.clasp.json` locally. Do not commit that file if the script ID is private.

If you instead create the bound project manually with **Extensions → Apps Script**, copy `.clasp.json.example` to `.clasp.json`, paste the bound Script ID from **Project Settings**, and keep `"rootDir": "src"`.

## 4. Push the complete source

```bash
npx clasp push
npx clasp open-container
```

Confirm that all `.gs` and `.html` files and `appsscript.json` appear in the editor.

## 5. Verify Gmail advanced service and Cloud API

The manifest declares Gmail API v1 under `enabledAdvancedServices`. In the Apps Script editor:

1. Open **Services** and verify **Gmail API** is listed.
2. Open **Project Settings** and locate the Google Cloud project.
3. If the editor reports that Gmail API is disabled, open the Cloud console for that project and enable **Gmail API**.

No web-app deployment is required; this is a spreadsheet-bound application.

## 6. Authorize and initialize

Reload the Sheet. The **Pixelate Outreach** menu should appear. Choose **Initialize Workbook** and accept the requested Google scopes. Initialization preserves imported/workflow data and repairs missing structure.

The scopes are declared in `src/appsscript.json`:

- current spreadsheet;
- container UI;
- external requests;
- Apps Script trigger management;
- Gmail compose, send, read-only, and settings-basic.

## 7. Configure the OpenAI key

In the Sheet choose **Pixelate Outreach → Secure API Key & Signature**. Paste the API key and save. The key is written to Script Properties under `OPENAI_API_KEY`; the raw value never appears in a spreadsheet cell or log.

The default model is `gpt-5.6-sol`, configured once in the Configuration tab. Change that cell if your OpenAI project uses another compatible structured-output model.

## 8. Configure sender and signature

In Configuration set:

- Default sender Gmail address;
- authorized Default Gmail alias, if used;
- Sender display name;
- Reply-to address;
- physical mailing address;
- opt-out sentence;
- your own Test email address.

Then use **Pixelate Outreach → Load Signature from Gmail**. The service reads the signature for the configured send-as identity. If Gmail does not expose the desired signature, use **Secure API Key & Signature** to paste the original HTML and plain-text fallback. The AI never recreates or receives the signature.

## 9. Import the Apollo CSV

Choose **Pixelate Outreach → Import Apollo CSV**, select `/Users/morrison/Downloads/apollo-contacts-export.csv`, review the preview, and confirm.

The importer:

- maps common Apollo names;
- deduplicates normalized email addresses;
- flags missing/invalid addresses;
- preserves unrecognized nonblank Apollo fields as compact JSON;
- normalizes domains and websites;
- generates stable lead IDs;
- preserves existing research, emails, drafts, sends, and replies on repeat import.

The optional checkbox refreshes mapped Apollo source fields on existing contacts. It still preserves workflow state.

## 10. First research batch

Keep Test mode enabled. Select no more than three rows for the first integration test and choose **Research Selected Leads**. Verify:

- official URLs open and support each claim;
- High Fit has at least two evidence items;
- inferred workflow language is framed as a possibility;
- no unsupported spreadsheet/email/system claim appears;
- the recommended project is concrete and singular.

Use **Research Next Batch** only after the small test passes.

## 11. Generate and review emails

Select the tested rows and choose **Generate Emails for Selected Leads**. Open **Lead Review Sidebar** and inspect evidence, warnings, subject, body, opt-out preview, and signature preview. Approval is initially false after every generation/regeneration.

Blocked warnings must be corrected before drafting. Editing the subject/body in the Sheet is supported; draft creation re-evaluates deterministic gates.

## 12. Create test drafts

With Test mode on and your Test email address configured:

1. Approve one row.
2. Choose **Create Drafts for Selected Leads** or **Approve and Create Draft** in the sidebar.
3. Open Gmail and verify the draft is addressed only to your test address and subject-prefixed `[TEST]`.
4. Edit the subject/body in the Sheet and create the draft again. The same Gmail draft should update instead of duplicating.

Test mode can create no more than the rows you explicitly select/approve; for the formal test run use at most three.

## 13. Production sending

Before production:

1. Confirm the sender address/alias is authorized in Gmail.
2. Confirm signature, reply-to, opt-out, and physical address.
3. Review every row and evidence source.
4. Disable Test mode.
5. Leave Automatic sending disabled unless you deliberately build an unattended policy later.
6. Approve a small batch.
7. Choose **Send Approved Emails** and inspect the confirmation list.
8. Confirm only if recipients, companies, sender, and count are correct.

The default daily limit is 10, Monday-Friday, 09:00-16:30 America/Detroit. Each send is revalidated immediately beforehand.

## 14. Replies and follow-ups

Choose **Check for Replies**. Replies are associated to stored Gmail threads when possible and classified without automatic response. Unsubscribe replies set Do Not Contact and add email/domain suppression entries.

Follow-ups are disabled by default. To test them, enable Follow-ups in Configuration, use a controlled sent test thread, set an eligible due date, choose **Generate Follow-Ups**, review the under-70-word body, check Follow-Up Approved, create/update the follow-up draft, and use the same explicit send confirmation. At most two follow-ups are permitted; any reply stops them.

## 15. Troubleshooting

- **Menu missing:** reload the Sheet; verify the project is bound to the correct parent ID and `onOpen` exists.
- **Authorization error:** run a menu action again and approve scopes; admins may need to allow the app/scopes.
- **Gmail service error:** enable Gmail API in Services and the linked Cloud project.
- **OpenAI 401:** resave the key in Secure Configuration.
- **OpenAI 429/5xx:** the application retries transient failures; reduce batch size if failures persist.
- **Website fetch failure:** verify the official URL; some sites block automated retrieval and should be marked for manual review.
- **No signature:** verify the configured alias exactly matches a Gmail send-as identity, then reload it.
- **Draft blocked:** inspect Last Error and Email Quality Warnings; approval alone cannot bypass fit, evidence, confidence, suppression, or quality gates.
- **Send blocked:** check Test mode, send window, daily limit, approval, previous send, and Do Not Contact.
- **Interrupted batch:** use **Retry Failed Rows**. Use **Clear Processing Locks** only when rows remain Processing/Queued after an interrupted execution.
- **Apps Script execution limit:** reduce batch sizes. Confirmed sends schedule a bounded continuation when needed.

## 16. Quotas

Google Workspace and consumer Gmail accounts have different Apps Script, Gmail, and UrlFetch quotas. Start with small batches. The configuration limit is an application safety cap, not a promise that the account has matching quota.

## 17. Remove triggers and uninstall

In the Apps Script editor run:

```javascript
removeAllPixelateTriggers()
```

Then delete unwanted Gmail drafts, remove or delete the bound Apps Script project, and delete the Sheet if appropriate. Deleting the script removes Script Properties, including the OpenAI API key. You can also run `npx clasp logout` to remove the local clasp authorization.

