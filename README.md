# Pixelate Outbound Assistant

Pixelate Outbound Assistant is a container-bound Google Apps Script project for researched, approval-based Gmail outreach from Google Sheets. Apollo is used only as the original CSV source. The application does not use Apollo for research, enrichment, sequencing, drafting, or sending.

The verified native workbook is [Pixelate Outbound Assistant](https://docs.google.com/spreadsheets/d/1HFYt7STSJIYV3D_FgmBNjbaZ5utdJPbp48p0-Nhw7qo/edit). The supplied Apollo export has been mapped, deduplicated, and loaded as 147 contacts. Production recipient targeting is enabled, while automatic sending remains off and every lead remains unapproved.

## Initial safety defaults

- Test mode is on.
- Automatic sending is off.
- Follow-ups are off.
- The default daily send limit is 10.
- Draft creation requires lead approval.
- Sending requires row approval, quality/fit/confidence gates, a valid draft, an explicit menu action, and a second confirmation dialog.
- Sending is impossible in Test mode.
- Test drafts are redirected to the configured test email and prefixed `[TEST]`.
- Do Not Contact entries block drafts, sends, and follow-ups by email, domain, or company.
- API keys are stored only in Script Properties.

No email was sent while this project was built or tested.

## What the system does

1. Imports an Apollo CSV through a preview-and-confirm dialog.
2. Normalizes emails, websites, and domains; generates stable lead IDs; preserves unmapped Apollo fields as compact JSON; and avoids overwriting workflow state on repeat imports.
3. Fetches an official company website first, prioritizing operational pages such as products, service, parts, maintenance, manuals, training, support, and portals.
4. Caches company research by domain so multiple contacts do not trigger duplicate account research.
5. Uses the OpenAI Responses API with strict JSON Schema outputs for research, email generation, and follow-ups.
6. Applies deterministic quality checks for evidence, confidence, names, length, placeholders, em dashes, buzzwords, unsupported claims, case studies, and batch similarity.
7. Provides a one-lead-at-a-time review sidebar.
8. Retrieves an authorized Gmail send-as signature or accepts pasted HTML and plain text.
9. Creates or updates MIME multipart Gmail drafts idempotently through Gmail's authenticated JSON API.
10. Sends only explicitly approved and confirmed messages inside configured windows and daily limits.
11. Detects and classifies replies, suppresses opt-outs, and stops follow-ups.
12. Generates at most two approval-required follow-ups, disabled by default.

## Project structure

The Apps Script source lives in `src/` and is split by responsibility:

- `Setup.gs`, `Configuration.gs`, `Menu.gs`: workbook and settings lifecycle.
- `ImportCsv.gs`, `LeadRepository.gs`, `DoNotContactService.gs`: lead ingestion and storage.
- `WebsiteService.gs`, `ResearchService.gs`, `OpenAIService.gs`: grounded research and strict AI calls.
- `EmailGenerationService.gs`, `EmailValidator.gs`: controlled writing and deterministic validation.
- `GmailService.gs`, `SendingService.gs`: MIME drafts, signatures, confirmation, limits, and sends.
- `ReplyTrackingService.gs`, `FollowUpService.gs`: replies, opt-outs, and approval-based follow-ups.
- `ActivityLogger.gs`, `TriggerService.gs`, `DashboardService.gs`: audit and recovery.
- HTML files: CSV import, secure configuration, send confirmation, and review sidebar.

The manifest uses the V8 runtime and least-privilege practical scopes for the requested functions. Gmail reading is required for reply checks, Gmail compose/send for drafts and explicit sends, Gmail settings for the signature, external requests for website/OpenAI calls, and the current spreadsheet for workbook operations.

## Data sent to OpenAI

Research calls can send:

- company name and domain;
- Apollo industry and employee count as explicitly labeled, unverified context;
- text excerpts and URLs retrieved from public company pages;
- public search context when the configured OpenAI web-search fallback is needed.

Email-generation calls send the recipient's professional first name and job title, company name, stored research summary/evidence, and the proposed project. Follow-up calls also send the original email and project hypothesis.

The application does **not** send the recipient's email address, Gmail signature HTML, Gmail message contents unrelated to the lead, API key, or Do Not Contact list to OpenAI. Gmail signatures are appended locally after AI generation.

OpenAI requests use `store: false`. Review your organization's OpenAI data controls and retention terms before production use.

## Local development

Requirements: Node.js 20+ and a Google account permitted to use Apps Script, Gmail, and the target spreadsheet.

```bash
npm install
npm test
npm run check
```

`@google/clasp` 3.3.0 is pinned as a development dependency. See [SETUP.md](SETUP.md) for binding and authorization.

## Operating workflow

After setup:

1. Keep Test mode enabled and configure your own test email.
2. Use **Pixelate Outreach → Import Apollo CSV**.
3. Research a small selected group, then inspect evidence and fit.
4. Generate emails and review them in the sidebar or directly in the sheet.
5. Approve one test row and create a draft. Verify recipient, subject, body, opt-out, and signature in Gmail.
6. Check replies and follow-up behavior using controlled messages to your own address.
7. Only after validation, add the physical address, verify sender identity, disable Test mode, approve a small production group, and use the explicit send confirmation.

## Reliability notes

- Document locks protect import, research, generation, draft, send, reply, and follow-up batches.
- Per-row failures are logged and do not stop a batch.
- OpenAI and website requests retry transient failures with exponential backoff.
- Long research and send batches create continuation triggers.
- The send confirmation stays open with live processed, sent, failed, pending, and scheduled counts, plus a direct Activity Log button.
- Existing Gmail draft IDs are checked and updated instead of duplicated.
- Every send gate is re-evaluated immediately before sending.
- A confirmed send continuation expires after 24 hours and rechecks Test mode, daily limits, Do Not Contact, and send windows.

## Compliance

The software includes accurate sender fields, configurable reply-to, opt-out text, physical-address configuration, suppression enforcement, non-deceptive first-contact subjects, and no automatic sending. These controls do not replace legal review. The operator is responsible for applicable anti-spam, privacy, and industry rules and for ensuring every recipient and claim is appropriate.

## Uninstall

Run `removeAllPixelateTriggers()` from the Apps Script editor, delete any Gmail drafts you no longer want, remove the bound Apps Script project through **Extensions → Apps Script → Project Settings/Delete project** as permitted by Google, and delete the Sheet if it is no longer required. Deleting the script removes its Script Properties, including the OpenAI key.
