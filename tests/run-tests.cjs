'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = {
  console,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  isFinite,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(algorithm, value) { return [...crypto.createHash(algorithm).update(value, 'utf8').digest()].map(v => v > 127 ? v - 256 : v); },
    sleep() {},
    getUuid: () => crypto.randomUUID(),
    base64Encode(value) { return Buffer.from(String(value), 'utf8').toString('base64'); },
    base64EncodeWebSafe(value) { return Buffer.from(String(value), 'utf8').toString('base64url'); },
    base64DecodeWebSafe(value) { return Buffer.from(String(value), 'base64url'); },
    newBlob(value) { return { getDataAsString: () => Buffer.from(value).toString('utf8') }; },
    formatDate(date, timezone, pattern) {
      if (pattern === 'EEEE') return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date);
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(date).map(p => [p.type,p.value]));
      if (pattern === 'HH:mm') return `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
      if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
      return date.toISOString();
    }
  },
  getConfig_: () => ({ 'Minimum research confidence': 65 }),
};
vm.createContext(context);
for (const file of ['Constants.gs','Utilities.gs','LeadRepository.gs','DoNotContactService.gs','EmailValidator.gs','EmailGenerationService.gs','GmailService.gs','SendingService.gs','FollowUpService.gs','ReplyTrackingService.gs','ResearchService.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('CSV parsing handles quoted commas, escaped quotes, and embedded newlines', () => {
  const rows = context.parseCsv_('Name,Note\r\n"Doe, Jane","Said ""hello""\nand left"\r\n');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], 'Doe, Jane');
  assert.strictEqual(rows[1][1], 'Said "hello"\nand left');
});

test('real Apollo fixture maps all rows and keeps source data', () => {
  const csv = fs.readFileSync('/Users/morrison/Downloads/apollo-contacts-export.csv', 'utf8');
  const records = context.rowsToRecords_(context.parseCsv_(csv));
  assert.strictEqual(records.length, 147);
  const mapped = context.mapApolloRecord_(records[0]);
  assert.strictEqual(mapped['Company'], 'Dart Controls');
  assert.strictEqual(mapped['Company Domain'], 'dartcontrols.com');
  assert.ok(mapped['Lead ID'].startsWith('LEAD-'));
  assert.ok(JSON.parse(mapped['Apollo Source Data'])['Apollo Contact Id']);
});

test('email and domain normalization are stable', () => {
  assert.strictEqual(context.normalizeEmail_('  Jane.Doe@Example.COM '), 'jane.doe@example.com');
  assert.strictEqual(context.normalizeDomain_('https://www.Example.com/path?q=1'), 'example.com');
  assert.strictEqual(context.normalizeDomain_('jane@example.com'), 'example.com');
});

test('deduplication uses normalized email', () => {
  const a = {'Email':'A@example.com','Lead ID':'1'};
  const b = {'Email':'a@EXAMPLE.com','Lead ID':'2'};
  const result = context.dedupeRecords_([a,b]);
  assert.strictEqual(result.unique.length, 1);
  assert.strictEqual(result.duplicates.length, 1);
});

test('fit level thresholds are exact', () => {
  assert.strictEqual(context.fitLevel_(75), 'High');
  assert.strictEqual(context.fitLevel_(50), 'Medium');
  assert.strictEqual(context.fitLevel_(49), 'Low');
});

test('research JSON validation enforces high-fit evidence', () => {
  const research = {company_name:'Acme',domain:'acme.com',segment:'Machinery',fit_score:80,fit_level:'High',research_summary:'Summary',evidence:[{claim:'Makes machines',source_url:'https://acme.com/products',source_type:'official_company_website'}],existing_portal_found:false,existing_portal_details:'',likely_workflow_problem:'Service coordination may be complex.',recommended_project:'Service portal',buyer_relevance:'Operations',personalized_opener:'I noticed Acme makes machines.',confidence:80,should_contact:true,disqualification_reason:''};
  assert.throws(() => context.validateResearchJson_(research, {'Company Domain':'acme.com'}, ['https://acme.com/products'], false), /High Fit requires/);
  research.evidence.push({claim:'Offers parts',source_url:'https://acme.com/parts',source_type:'official_company_website'});
  assert.strictEqual(context.validateResearchJson_(research, {'Company Domain':'acme.com'}, ['https://acme.com/products','https://acme.com/parts'], false).fit_level, 'High');
});

test('email JSON validation and word count work', () => {
  const email = {subject:'Service portal idea',subject_alternatives:['Parts visibility','Service coordination'],body_plain_text:'Hi Jane',personalized_opener:'A specific opener',project_hypothesis:'Portal',cta:'Worth discussing?',quality_score:90,quality_issues:[],research_claims_used:['Makes machines'],safe_to_send:true};
  assert.strictEqual(context.validateEmailJson_(email), email);
  assert.strictEqual(context.countWords_('one two\nthree'), 3);
});

test('em dash and placeholder rejection are deterministic', () => {
  assert.strictEqual(context.containsEmDash_('hello — there'), true);
  assert.strictEqual(context.hasPlaceholder_('Hi [First Name]'), true);
  assert.strictEqual(context.hasPlaceholder_('Hi Jane'), false);
});

test('unsupported-claim warnings catch internal process assumptions', () => {
  const lead = {'First Name':'Jane','Company':'Acme','Research Confidence':90,'Fit Level':'High','Fit Score':90,'Evidence 1':'Acme makes industrial pumps','Evidence 1 URL':'https://acme.com/pumps','Evidence 2':'Acme offers field service'};
  const email = {subject:'Pump service portal',subject_alternatives:['A','B'],body_plain_text:'Hi Jane,\n\nI know Acme is still using spreadsheets for service. Pixelate builds a service portal.\n\nWould that help?',personalized_opener:'Acme makes industrial pumps',project_hypothesis:'Portal',cta:'Would that help?',quality_score:90,quality_issues:[],research_claims_used:['Acme makes industrial pumps'],safe_to_send:true};
  const config = {'Maximum email word count':110,'Minimum research confidence':65,'Minimum fit score':50,'Minimum email quality score':80,'Allow case-study reference':false};
  const result = context.validateGeneratedEmail_(lead,email,config,[]);
  assert.ok(result.hardIssues.some(issue => /unsupported/.test(issue)));
});

test('implementation and no-change promises are blocked', () => {
  const lead = {'First Name':'Jane','Company':'Acme','Research Confidence':90,'Fit Level':'High','Fit Score':90,'Evidence 1':'Acme makes industrial pumps','Evidence 1 URL':'https://acme.com/pumps','Evidence 2':'Acme offers field service'};
  const email = {subject:'Pump service portal',subject_alternatives:['A','B'],body_plain_text:'Hi Jane,\n\nAcme makes industrial pumps. Pixelate could build a service portal without changing existing tools.\n\nWould that be useful?',personalized_opener:'Acme makes industrial pumps',project_hypothesis:'Portal',cta:'Would that be useful?',quality_score:90,quality_issues:[],research_claims_used:['Acme makes industrial pumps'],safe_to_send:true};
  const config = {'Maximum email word count':110,'Minimum research confidence':65,'Minimum fit score':50,'Minimum email quality score':80,'Allow case-study reference':false};
  const result = context.validateGeneratedEmail_(lead,email,config,[]);
  assert.ok(result.hardIssues.some(issue => /implementation or current-state/.test(issue)));
});

test('email regeneration excludes the current row from similarity checks', () => {
  const records = [
    {rowNumber: 2, body: 'Current row body'},
    {rowNumber: 3, body: 'Another lead body'}
  ];
  assert.deepStrictEqual(Array.from(context.otherLeadBodies_(records, 2)), ['Another lead body']);
});

test('Do Not Contact enforcement matches email and domain', () => {
  const lead = {'Email':'jane@acme.com','Company Domain':'acme.com','Company':'Acme','Do Not Contact':false};
  assert.strictEqual(context.isDoNotContact_(lead,{emails:{'jane@acme.com':true},domains:{},companies:{}}),true);
  assert.strictEqual(context.isDoNotContact_(lead,{emails:{},domains:{'acme.com':true},companies:{}}),true);
});

test('draft idempotency chooses update for an existing ID', () => {
  assert.strictEqual(context.draftMutationPlan_('draft-1',true),'update');
  assert.strictEqual(context.draftMutationPlan_('draft-1',false),'create');
  assert.strictEqual(context.draftMutationPlan_('',false),'create');
});

test('daily send-limit calculation never goes negative', () => {
  assert.strictEqual(context.calculateDailyRemaining_(10,3),7);
  assert.strictEqual(context.calculateDailyRemaining_(10,12),0);
});

test('send window honors Detroit weekdays and hours', () => {
  const config = {'Timezone':'America/Detroit','Send days':'Monday,Tuesday,Wednesday,Thursday,Friday','Send start time':'09:00','Send end time':'16:30'};
  assert.strictEqual(context.isWithinSendWindow_(new Date('2026-07-29T14:00:00Z'),config),true);
  assert.strictEqual(context.isWithinSendWindow_(new Date('2026-08-01T14:00:00Z'),config),false);
});

test('reply classification covers key outcomes', () => {
  assert.strictEqual(context.classifyReply_('Please unsubscribe me',''), 'Unsubscribe');
  assert.strictEqual(context.classifyReply_('Interested. Let\'s talk next week.',''), 'Positive interest');
  assert.strictEqual(context.classifyReply_('Please contact Alex instead.',''), 'Referral to another person');
  assert.strictEqual(context.classifyReply_('Automatic reply: I am out of office.',''), 'Out of office');
});

test('follow-up eligibility stops on reply and caps count', () => {
  const config = {'Maximum follow-ups':2,'Follow-ups enabled':true};
  const base = {'Sent Message ID':'m1','Send Status':'Sent','Reply Status':'No Reply','Do Not Contact':false,'Follow-Up Count':0,'Follow-Up Due':new Date('2026-07-01T00:00:00Z')};
  assert.strictEqual(context.followUpEligible_(base,config,new Date('2026-07-10T00:00:00Z')),true);
  assert.strictEqual(context.followUpEligible_({...base,'Reply Status':'Replied'},config,new Date('2026-07-10T00:00:00Z')),false);
  assert.strictEqual(context.followUpEligible_({...base,'Follow-Up Count':2},config,new Date('2026-07-10T00:00:00Z')),false);
});

test('signature concatenation avoids duplication and escapes HTML', () => {
  assert.strictEqual(context.escapeHtml_('<Jane & Co>'), '&lt;Jane &amp; Co&gt;');
  const plain = context.concatenateSignature_('Hello','Opt out','Jane\nPixelate',false);
  assert.strictEqual(plain,'Hello\n\nOpt out\n\nJane\nPixelate');
  assert.strictEqual((context.concatenateSignature_('Hello\n\nJane Pixelate','','Jane Pixelate',false).match(/Jane Pixelate/g)||[]).length,1);
});

test('retry behavior succeeds after transient failures', () => {
  let attempts=0;
  const value=context.retryOperation_(()=>{attempts++;if(attempts<3){const e=new Error('retry');e.transient=true;throw e;}return 'ok';},{attempts:3,baseDelayMs:1,retryWhen:e=>e.transient});
  assert.strictEqual(value,'ok');
  assert.strictEqual(attempts,3);
});

let passed = 0;
for (const {name,fn} of tests) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode=1; }
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`\n${passed}/${tests.length} tests passed.`);
