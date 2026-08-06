'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const scriptProperties = new Map();
const userProperties = new Map();
function propertyStore(map) {
  return {
    getProperty(key) { return map.has(key) ? map.get(key) : null; },
    setProperty(key, value) { map.set(key, String(value)); return this; },
    deleteProperty(key) { map.delete(key); return this; },
    getProperties() { return Object.fromEntries(map); }
  };
}
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
  PropertiesService: {
    getScriptProperties: () => propertyStore(scriptProperties),
    getUserProperties: () => propertyStore(userProperties)
  },
  ScriptApp: {
    getOAuthToken: () => 'test-oauth-token',
    getProjectTriggers: () => context.__triggers,
    deleteTrigger(trigger) { context.__triggers = context.__triggers.filter(item => item !== trigger); },
    newTrigger(handler) {
      const builder = {
        interval: 0,
        timeBased() { return this; },
        everyMinutes(minutes) { this.interval = minutes; return this; },
        create() {
          const trigger = { handler, interval: this.interval, getHandlerFunction: () => handler };
          context.__triggers.push(trigger);
          return trigger;
        }
      };
      return builder;
    }
  },
  UrlFetchApp: {
    fetch(url, options) {
      context.__fetches.push({url, options});
      const response = context.__fetchResponse || {status: 200, body: JSON.stringify({id:'r-new', message:{id:'m-new', threadId:'t-new'}})};
      return {
        getResponseCode: () => response.status,
        getContentText: () => response.body
      };
    }
  },
  __fetches: [],
  __fetchResponse: null,
  __triggers: [],
  getConfig_: () => ({ 'Minimum research confidence': 65 }),
};
vm.createContext(context);
for (const file of ['Constants.gs','Utilities.gs','Configuration.gs','LeadRepository.gs','DoNotContactService.gs','EmailValidator.gs','EmailGenerationService.gs','GmailService.gs','SendingService.gs','FollowUpService.gs','ReplyTrackingService.gs','ResearchService.gs','TriggerService.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}
context.getConfig_ = () => ({ 'Minimum research confidence': 65 });

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
  const email = {subject:'Service portal idea',subject_alternatives:['Parts visibility','Service coordination'],body_plain_text:'Hi Jane',personalized_opener:'A specific opener',project_hypothesis:'Portal',impact_metric:'none',impact_hypothesis:'',impact_assumptions:[],impact_confidence:'Low',cta:'Worth discussing?',quality_score:90,quality_issues:[],research_claims_used:['Makes machines'],safe_to_send:true};
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
  const email = {subject:'Pump service portal',subject_alternatives:['A','B'],body_plain_text:'Hi Jane,\n\nI know Acme is still using spreadsheets for service. Pixelate builds a service portal.\n\nWould that help?',personalized_opener:'Acme makes industrial pumps',project_hypothesis:'Portal',impact_metric:'none',impact_hypothesis:'',impact_assumptions:[],impact_confidence:'Low',cta:'Would that help?',quality_score:90,quality_issues:[],research_claims_used:['Acme makes industrial pumps'],safe_to_send:true};
  const config = {'Maximum email word count':110,'Minimum research confidence':65,'Minimum fit score':50,'Minimum email quality score':80,'Allow case-study reference':false,'Business-case estimates enabled':false};
  const result = context.validateGeneratedEmail_(lead,email,config,[]);
  assert.ok(result.hardIssues.some(issue => /unsupported/.test(issue)));
});

test('implementation and no-change promises are blocked', () => {
  const lead = {'First Name':'Jane','Company':'Acme','Research Confidence':90,'Fit Level':'High','Fit Score':90,'Evidence 1':'Acme makes industrial pumps','Evidence 1 URL':'https://acme.com/pumps','Evidence 2':'Acme offers field service'};
  const email = {subject:'Pump service portal',subject_alternatives:['A','B'],body_plain_text:'Hi Jane,\n\nAcme makes industrial pumps. Pixelate could build a service portal without changing existing tools.\n\nWould that be useful?',personalized_opener:'Acme makes industrial pumps',project_hypothesis:'Portal',impact_metric:'none',impact_hypothesis:'',impact_assumptions:[],impact_confidence:'Low',cta:'Would that be useful?',quality_score:90,quality_issues:[],research_claims_used:['Acme makes industrial pumps'],safe_to_send:true};
  const config = {'Maximum email word count':110,'Minimum research confidence':65,'Minimum fit score':50,'Minimum email quality score':80,'Allow case-study reference':false,'Business-case estimates enabled':false};
  const result = context.validateGeneratedEmail_(lead,email,config,[]);
  assert.ok(result.hardIssues.some(issue => /implementation or current-state/.test(issue)));
});

test('transparent business-case ranges pass deterministic estimate validation', () => {
  const lead = {'First Name':'Jane','Company':'Acme','Research Confidence':90,'Fit Level':'High','Fit Score':90,'Evidence 1':'Acme makes industrial pumps','Evidence 1 URL':'https://acme.com/pumps','Evidence 2':'Acme offers field service'};
  const hypothesis = 'If Acme handled 400 service requests a month and each saved 5 to 10 minutes at a $75 loaded hourly rate, that could equal roughly $30,000 to $60,000 in annual labor capacity.';
  const email = {subject:'Pump service capacity',subject_alternatives:['Service request impact','A service workflow hypothesis'],body_plain_text:'Hi Jane,\n\nAcme makes industrial pumps and offers field service.\n\n' + hypothesis + '\n\nPixelate could build a service request portal for intake, technical details, and status updates.\n\nWould it be useful to compare those assumptions?',personalized_opener:'Acme makes industrial pumps and offers field service.',project_hypothesis:'Service request portal',impact_metric:'labor_dollars_saved',impact_hypothesis:hypothesis,impact_assumptions:['400 service requests a month','5 to 10 minutes at a $75 loaded hourly rate'],impact_confidence:'Low',cta:'Would it be useful to compare those assumptions?',quality_score:95,quality_issues:[],research_claims_used:['Acme makes industrial pumps'],safe_to_send:true};
  const config = {'Maximum email word count':110,'Minimum research confidence':65,'Minimum fit score':50,'Minimum email quality score':80,'Allow case-study reference':false,'Business-case estimates enabled':true,'Business-case metric priorities':'labor_dollars_saved,cycle_time_reduced','Default loaded hourly rate':75};
  const result = context.validateGeneratedEmail_(lead,email,config,[]);
  assert.ok(!result.hardIssues.some(issue => /business-case|impact|metric|guaranteed/i.test(issue)), result.hardIssues.join('\n'));
});

test('business-case guarantees and unlabeled financial claims remain blocked', () => {
  const lead = {'First Name':'Jane','Company':'Acme','Research Confidence':90,'Fit Level':'High','Fit Score':90,'Evidence 1':'Acme makes industrial pumps','Evidence 1 URL':'https://acme.com/pumps','Evidence 2':'Acme offers field service'};
  const guaranteed = 'Acme will save $30,000 to $60,000 each year.';
  const email = {subject:'Pump service capacity',subject_alternatives:['A','B'],body_plain_text:'Hi Jane,\n\nAcme makes industrial pumps. ' + guaranteed + ' Pixelate could build a service request portal.\n\nWould that be useful?',personalized_opener:'Acme makes industrial pumps',project_hypothesis:'Service request portal',impact_metric:'labor_dollars_saved',impact_hypothesis:guaranteed,impact_assumptions:['$30,000 to $60,000 each year'],impact_confidence:'Low',cta:'Would that be useful?',quality_score:95,quality_issues:[],research_claims_used:['Acme makes industrial pumps'],safe_to_send:true};
  const config = {'Maximum email word count':110,'Minimum research confidence':65,'Minimum fit score':50,'Minimum email quality score':80,'Allow case-study reference':false,'Business-case estimates enabled':true,'Business-case metric priorities':'labor_dollars_saved'};
  const result = context.validateGeneratedEmail_(lead,email,config,[]);
  assert.ok(result.hardIssues.some(issue => /hypothesis|guaranteed/i.test(issue)));

  email.impact_metric = 'none';
  email.impact_hypothesis = '';
  email.impact_assumptions = [];
  const disabled = Object.assign({}, config, {'Business-case estimates enabled':false});
  const disabledResult = context.validateGeneratedEmail_(lead,email,disabled,[]);
  assert.ok(disabledResult.hardIssues.some(issue => /estimates are disabled/.test(issue)));
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

test('company outreach warnings count only other active contacts', () => {
  const leads = [
    {_rowNumber:2,'Lead ID':'a','Company Domain':'acme.com','Approved':true,'Send Status':'Not Sent','Draft Status':''},
    {_rowNumber:3,'Lead ID':'b','Company Domain':'acme.com','Approved':true,'Send Status':'Not Sent','Draft Status':''},
    {_rowNumber:4,'Lead ID':'c','Company Domain':'other.com','Approved':false,'Send Status':'Not Sent','Draft Status':''}
  ];
  const warnings = context.companyOutreachWarnings_(leads);
  assert.ok(warnings[2].includes('1 other active'));
  assert.ok(warnings[3].includes('1 other active'));
  assert.strictEqual(warnings[4], '');
});

test('draft idempotency chooses update for an existing ID', () => {
  assert.strictEqual(context.draftMutationPlan_('draft-1',true),'update');
  assert.strictEqual(context.draftMutationPlan_('draft-1',false),'create');
  assert.strictEqual(context.draftMutationPlan_('',false),'create');
});

test('Gmail draft REST calls use JSON metadata endpoints and draft send payloads', () => {
  context.__fetches.length = 0;
  context.__fetchResponse = null;
  context.saveGmailDraft_('', {message:{raw:'abc'}});
  context.saveGmailDraft_('r-existing', {message:{raw:'def'}});
  context.sendExistingGmailDraft_('r-existing');
  assert.strictEqual(context.__fetches[0].options.method, 'post');
  assert.ok(context.__fetches[0].url.endsWith('/users/me/drafts'));
  assert.deepStrictEqual(JSON.parse(context.__fetches[0].options.payload), {message:{raw:'abc'}});
  assert.strictEqual(context.__fetches[1].options.method, 'put');
  assert.ok(context.__fetches[1].url.endsWith('/users/me/drafts/r-existing'));
  assert.strictEqual(context.__fetches[2].options.method, 'post');
  assert.ok(context.__fetches[2].url.endsWith('/users/me/drafts/send'));
  assert.deepStrictEqual(JSON.parse(context.__fetches[2].options.payload), {id:'r-existing'});
});

test('Gmail REST failures preserve the HTTP status for missing-draft recovery', () => {
  context.__fetchResponse = {status: 404, body: JSON.stringify({error:{message:'Draft not found'}})};
  assert.strictEqual(context.gmailDraftExists_('r-missing'), false);
  context.__fetchResponse = null;
});

test('send progress records round-trip for the confirmation dialog', () => {
  context.writeSendProgress_('token-1', {status:'running', total:3, processed:1, sent:1, failed:0, scheduled:0});
  const progress = context.getSendProgress('token-1');
  assert.strictEqual(progress.status, 'running');
  assert.strictEqual(progress.processed, 1);
  assert.ok(progress.updatedAt > 0);
});

test('stale send progress and confirmations are cleaned up', () => {
  scriptProperties.set('SEND_PROGRESS_old', JSON.stringify({createdAt:Date.now() - 4 * 86400000}));
  scriptProperties.set('SEND_PROGRESS_current', JSON.stringify({createdAt:Date.now()}));
  userProperties.set('SEND_CONFIRMATION_old', JSON.stringify({createdAt:Date.now() - 2 * 60 * 60 * 1000}));
  context.cleanupStaleSendState_();
  assert.strictEqual(scriptProperties.has('SEND_PROGRESS_old'), false);
  assert.strictEqual(scriptProperties.has('SEND_PROGRESS_current'), true);
  assert.strictEqual(userProperties.has('SEND_CONFIRMATION_old'), false);
});

test('daily send-limit calculation never goes negative', () => {
  assert.strictEqual(context.calculateDailyRemaining_(10,3),7);
  assert.strictEqual(context.calculateDailyRemaining_(10,12),0);
});

test('automatic scheduling uses the smaller of daily capacity and approved candidates', () => {
  assert.strictEqual(context.calculateAutomaticSendCount_(true,false,true,50,97),50);
  assert.strictEqual(context.calculateAutomaticSendCount_(true,false,true,50,12),12);
  assert.strictEqual(context.calculateAutomaticSendCount_(false,false,true,50,97),0);
  assert.strictEqual(context.calculateAutomaticSendCount_(true,true,true,50,97),0);
  assert.strictEqual(context.calculateAutomaticSendCount_(true,false,false,50,97),0);
});

test('automatic scheduler installs exactly one recurring trigger', () => {
  context.__triggers.length = 0;
  const first = context.ensureAutomaticSendTrigger_();
  const second = context.ensureAutomaticSendTrigger_();
  assert.strictEqual(first, second);
  assert.strictEqual(context.__triggers.length, 1);
  assert.strictEqual(context.__triggers[0].handler, 'runAutomaticSendBatch');
  assert.strictEqual(context.__triggers[0].interval, 15);
});

test('send window honors Detroit weekdays and hours', () => {
  const config = {'Timezone':'America/Detroit','Send days':'Monday,Tuesday,Wednesday,Thursday,Friday','Send start time':'09:00','Send end time':'16:30'};
  assert.strictEqual(context.isWithinSendWindow_(new Date('2026-07-29T14:00:00Z'),config),true);
  assert.strictEqual(context.isWithinSendWindow_(new Date('2026-08-01T14:00:00Z'),config),false);
});

test('send window accepts native Sheets time serials', () => {
  const config = {'Timezone':'America/Detroit','Send days':'Monday,Tuesday,Wednesday,Thursday,Friday','Send start time':0,'Send end time':1439/1440};
  assert.strictEqual(context.normalizeSendTime_(config['Send start time'], config.Timezone),'00:00');
  assert.strictEqual(context.normalizeSendTime_(config['Send end time'], config.Timezone),'23:59');
  assert.strictEqual(context.isWithinSendWindow_(new Date('2026-08-03T14:31:00Z'),config),true);
});

test('configuration uses displayed time text instead of stringified Date objects', () => {
  const rawTime = new Date('1899-12-30T05:00:00Z');
  assert.strictEqual(context.configCellValue_('Send start time', rawTime, '0:00'),'0:00');
  assert.strictEqual(context.configCellValue_('Send end time', rawTime, '23:59'),'23:59');
  assert.strictEqual(context.configCellValue_('Timezone', 'America/Detroit', 'America/Detroit'),'America/Detroit');
});

test('send window supports overnight ranges', () => {
  const config = {'Timezone':'America/Detroit','Send days':'Monday','Send start time':'22:00','Send end time':'02:00'};
  assert.strictEqual(context.isWithinSendWindow_(new Date('2026-08-04T03:00:00Z'),config),true);
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

test('message footer excludes the optional physical mailing address', () => {
  assert.strictEqual(context.buildMessageFooter_({'Opt-out sentence':'Opt out here.','Physical mailing address':'Shelby Township, MI 48316'}), 'Opt out here.');
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
