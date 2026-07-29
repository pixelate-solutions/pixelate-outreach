const APP_NAME = 'Pixelate Outbound Assistant';
const MENU_NAME = 'Pixelate Outreach';
const APP_TIMEZONE = 'America/Detroit';
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_KEY_PROPERTY = 'OPENAI_API_KEY';
const SEND_CONFIRMATION_PREFIX = 'SEND_CONFIRMATION_';
const SIGNATURE_PROPERTY = 'GMAIL_SIGNATURE_HTML';
const CACHE_SHEET = 'Company Research Cache';

const REQUIRED_SHEETS = Object.freeze([
  'Leads',
  'Configuration',
  'Activity Log',
  'Do Not Contact',
  'Templates',
  'Dashboard'
]);

const LEAD_HEADERS = Object.freeze([
  'Lead ID', 'First Name', 'Last Name', 'Full Name', 'Job Title', 'Seniority',
  'Email', 'Email Status', 'Company', 'Website', 'Company Domain', 'LinkedIn URL',
  'City', 'State', 'Country', 'Employee Count', 'Industry', 'Apollo Source Data',
  'Segment', 'Priority', 'Fit Score', 'Fit Level', 'Research Status',
  'Research Summary', 'Evidence 1', 'Evidence 1 URL', 'Evidence 2', 'Evidence 2 URL',
  'Additional Evidence', 'Existing Portal Found', 'Likely Workflow Problem',
  'Recommended Project', 'Buyer Relevance', 'Research Confidence',
  'Personalized Opener', 'Email Subject', 'Email Body', 'Email Quality Score',
  'Draft Status', 'Gmail Draft ID', 'Approved', 'Send Status', 'Sent Message ID',
  'Gmail Thread ID', 'Sent At', 'Reply Status', 'Replied At',
  'Reply Classification', 'Follow-Up Due', 'Do Not Contact', 'Last Error',
  'Last Updated',
  'Company Outreach Warning', 'Email Quality Warnings', 'Sequence Name',
  'Follow-Up Count', 'Follow-Up Subject', 'Follow-Up Body', 'Follow-Up Draft ID',
  'Follow-Up Approved', 'Follow-Up Status', 'Is Test Record'
]);

const ACTIVITY_HEADERS = Object.freeze([
  'Timestamp', 'Lead ID', 'Contact', 'Company', 'Action', 'Result', 'Details',
  'Draft ID', 'Message ID', 'Error', 'Execution ID'
]);

const DNC_HEADERS = Object.freeze([
  'Email', 'Domain', 'Company', 'Reason', 'Source', 'Date Added', 'Notes'
]);

const CACHE_HEADERS = Object.freeze(['Domain', 'Company', 'Research JSON', 'Updated At']);

const DEFAULT_CONFIG = Object.freeze({
  'OpenAI API key status': 'Missing',
  'OpenAI model': 'gpt-5.6-sol',
  'OpenAI reasoning effort': 'low',
  'Research enabled': true,
  'Maximum leads per research batch': 10,
  'Maximum leads per generation batch': 10,
  'Maximum drafts per batch': 10,
  'Maximum sends per day': 10,
  'Automatic sending enabled': false,
  'Default sender Gmail address': '',
  'Default Gmail alias': '',
  'Sender display name': '',
  'Reply-to address': '',
  'Gmail signature HTML': '',
  'Gmail signature plain-text fallback': '',
  'Opt-out sentence': 'If you would rather not hear from me, just let me know.',
  'Physical mailing address': '',
  'Minimum fit score': 50,
  'Minimum research confidence': 65,
  'Minimum email quality score': 80,
  'Second AI quality check enabled': true,
  'Maximum email word count': 110,
  'Send days': 'Monday,Tuesday,Wednesday,Thursday,Friday',
  'Send start time': '09:00',
  'Send end time': '16:30',
  'Timezone': APP_TIMEZONE,
  'Default sequence name': 'Initial Outreach',
  'Follow-up delay': 7,
  'Follow-ups enabled': false,
  'Maximum follow-ups': 2,
  'Test mode': true,
  'Test email address': '',
  'Approved case-study text': '',
  'Allow case-study reference': false,
  'Research provider settings': 'official_site_first;openai_web_search_fallback',
  'Logging level': 'INFO'
});

const CONFIG_DESCRIPTIONS = Object.freeze({
  'OpenAI API key status': 'Read-only status. Save the key through the menu; the raw key is never stored in a cell.',
  'OpenAI model': 'Single configurable Responses API model used by research and generation.',
  'OpenAI reasoning effort': 'Supported value such as none, low, medium, or high.',
  'Research enabled': 'Master switch for all company research calls.',
  'Automatic sending enabled': 'Reserved for unattended triggers. Explicit menu sends still require approval and confirmation.',
  'Gmail signature HTML': 'HTML loaded from the selected Gmail send-as identity or pasted by you.',
  'Physical mailing address': 'Included for compliance when supplied.',
  'Minimum email quality score': 'Drafts and sends are blocked below this deterministic score.',
  'Second AI quality check enabled': 'Runs a separate schema-constrained review for borderline or warned emails.',
  'Send days': 'Comma-separated weekday names in the configured timezone.',
  'Follow-up delay': 'Days after the previous send before a follow-up becomes eligible.',
  'Test mode': 'When enabled, draft recipients are replaced with the test address, subjects are prefixed [TEST], and sending is disabled.',
  'Test email address': 'Required for test drafts. Must be an address you control.',
  'Research provider settings': 'Official site is always first. The OpenAI web-search fallback is used only when configured and needed.'
});

const TEMPLATE_ROWS = Object.freeze([
  ['Research system prompt', 'You are a careful B2B company researcher. Use only supplied official-site evidence and trustworthy public search results. Never invent facts. Clearly label workflow hypotheses as possibilities. Return only the requested structured output.'],
  ['Email system prompt', 'Write concise, natural B2B outreach grounded in verified evidence. Follow the controlled structure and return only the requested structured output. Do not use markdown or a signature.'],
  ['Base messaging', 'Pixelate builds focused customer portals, internal workflow systems, dashboards, and integrations for small and midsized industrial companies.'],
  ['Initial CTA', 'Is that already well covered, or would it be useful to compare notes?'],
  ['Follow-up rule', 'Add one relevant thought connected to the original project hypothesis. Never say just following up. Keep the message under 70 words.'],
  ['Email rules', '65-110 words; one researched detail; one operational possibility; one project; one low-pressure question; no em dashes, buzzwords, fake familiarity, unsupported claims, markdown, or signature.'],
  ['Approved case-study rule', 'Case studies are forbidden unless Allow case-study reference is true and Approved case-study text is nonblank.']
]);

const APOLLO_FIELD_ALIASES = Object.freeze({
  firstName: ['First Name', 'first_name'],
  lastName: ['Last Name', 'last_name'],
  jobTitle: ['Title', 'Job Title', 'title'],
  seniority: ['Seniority', 'seniority'],
  email: ['Email', 'Primary Email', 'email'],
  emailStatus: ['Email Status', 'Primary Email Status', 'email_status'],
  company: ['Company Name', 'Company', 'Organization Name', 'company_name'],
  website: ['Website', 'Company Website', 'website_url'],
  linkedIn: ['Person Linkedin Url', 'LinkedIn URL', 'Person LinkedIn URL'],
  city: ['City', 'Contact City'],
  state: ['State', 'Contact State'],
  country: ['Country', 'Contact Country'],
  employees: ['# Employees', 'Employee Count', 'Employees'],
  industry: ['Industry', 'industry'],
  segment: ['Segment', 'Target Segment'],
  priority: ['Priority', 'Tier'],
  recommendedProject: ['Recommended Project', 'Project Recommendation']
});

const INVALID_EMAIL_STATUSES = Object.freeze(['invalid', 'bounced', 'unavailable', 'guessed']);
const BUZZWORDS = Object.freeze([
  'revolutionize', 'game-changing', 'cutting-edge', 'synergy', 'leverage ai',
  'hope this email finds you well'
]);
const PLACEHOLDER_PATTERNS = Object.freeze([
  /\[[^\]]*(first|name|company|title|insert|placeholder)[^\]]*\]/i,
  /\{\{[^}]+\}\}/,
  /<[^>]*(first|name|company|insert)[^>]*>/i,
  /\bTBD\b/i
]);
