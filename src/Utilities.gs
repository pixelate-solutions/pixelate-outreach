function normalizeWhitespace_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeEmail_(value) {
  return normalizeWhitespace_(value).toLowerCase();
}

function isValidEmail_(value) {
  var email = normalizeEmail_(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function normalizeDomain_(value) {
  var raw = normalizeWhitespace_(value).toLowerCase();
  if (!raw) return '';
  if (raw.indexOf('@') > -1 && raw.indexOf('://') === -1) raw = raw.split('@').pop();
  raw = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/?#]/)[0];
  raw = raw.replace(/:\d+$/, '').replace(/\.+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? raw : '';
}

function normalizeWebsite_(value, fallbackDomain) {
  var raw = normalizeWhitespace_(value);
  var domain = normalizeDomain_(raw) || normalizeDomain_(fallbackDomain);
  if (!domain) return '';
  if (!raw || raw.indexOf('://') === -1) return 'https://' + domain;
  return 'https://' + domain;
}

function stableLeadId_(email, company, fullName) {
  var key = [normalizeEmail_(email), normalizeDomain_(company), normalizeWhitespace_(fullName).toLowerCase()].join('|');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8);
  var hex = bytes.map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  return 'LEAD-' + hex.slice(0, 16).toUpperCase();
}

function parseCsv_(text) {
  var input = String(text || '').replace(/^\uFEFF/, '');
  var rows = [];
  var row = [];
  var field = '';
  var quoted = false;
  for (var i = 0; i < input.length; i++) {
    var ch = input.charAt(i);
    if (quoted) {
      if (ch === '"' && input.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(function(v) { return v !== ''; })) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  row.push(field.replace(/\r$/, ''));
  if (row.some(function(v) { return v !== ''; })) rows.push(row);
  return rows;
}

function rowsToRecords_(rows) {
  if (!rows || rows.length < 2) return [];
  var headers = rows[0].map(function(v) { return normalizeWhitespace_(v); });
  return rows.slice(1).map(function(values) {
    var record = {};
    headers.forEach(function(header, i) { record[header] = values[i] == null ? '' : values[i]; });
    return record;
  });
}

function aliasValue_(record, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    if (Object.prototype.hasOwnProperty.call(record, aliases[i]) && normalizeWhitespace_(record[aliases[i]]) !== '') {
      return record[aliases[i]];
    }
  }
  return '';
}

function mapApolloRecord_(record) {
  var mappedKeys = {};
  Object.keys(APOLLO_FIELD_ALIASES).forEach(function(key) {
    APOLLO_FIELD_ALIASES[key].forEach(function(alias) { mappedKeys[alias] = true; });
  });
  var first = normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.firstName));
  var last = normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.lastName));
  var full = normalizeWhitespace_([first, last].join(' '));
  var email = normalizeEmail_(aliasValue_(record, APOLLO_FIELD_ALIASES.email));
  var websiteValue = aliasValue_(record, APOLLO_FIELD_ALIASES.website);
  var domain = normalizeDomain_(websiteValue) || normalizeDomain_(email);
  var original = {};
  Object.keys(record).forEach(function(key) {
    if (!mappedKeys[key] && normalizeWhitespace_(record[key]) !== '') original[key] = record[key];
  });
  var emailStatus = normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.emailStatus));
  if (!email) emailStatus = 'Missing';
  else if (!isValidEmail_(email)) emailStatus = 'Invalid';
  return {
    'Lead ID': stableLeadId_(email, domain, full),
    'First Name': first,
    'Last Name': last,
    'Full Name': full,
    'Job Title': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.jobTitle)),
    'Seniority': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.seniority)),
    'Email': email,
    'Email Status': emailStatus,
    'Company': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.company)),
    'Website': normalizeWebsite_(websiteValue, domain),
    'Company Domain': domain,
    'LinkedIn URL': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.linkedIn)),
    'City': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.city)),
    'State': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.state)),
    'Country': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.country)),
    'Employee Count': numberOrBlank_(aliasValue_(record, APOLLO_FIELD_ALIASES.employees)),
    'Industry': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.industry)),
    'Apollo Source Data': JSON.stringify(original),
    'Segment': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.segment)),
    'Priority': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.priority)),
    'Recommended Project': normalizeWhitespace_(aliasValue_(record, APOLLO_FIELD_ALIASES.recommendedProject)),
    'Research Status': 'Not Started',
    'Draft Status': 'Not Created',
    'Approved': false,
    'Send Status': 'Not Sent',
    'Reply Status': 'No Reply',
    'Do Not Contact': false,
    'Sequence Name': '',
    'Follow-Up Count': 0,
    'Follow-Up Approved': false,
    'Follow-Up Status': 'Not Generated',
    'Is Test Record': false,
    'Last Updated': new Date()
  };
}

function dedupeRecords_(records) {
  var seen = {};
  var unique = [];
  var duplicates = [];
  records.forEach(function(record) {
    var email = normalizeEmail_(record['Email']);
    var key = email || record['Lead ID'];
    if (seen[key]) duplicates.push(record);
    else {
      seen[key] = true;
      unique.push(record);
    }
  });
  return { unique: unique, duplicates: duplicates };
}

function numberOrBlank_(value) {
  var normalized = String(value == null ? '' : value).replace(/[^0-9.-]/g, '');
  if (!normalized) return '';
  var result = Number(normalized);
  return isFinite(result) ? result : '';
}

function fitLevel_(score) {
  var n = Number(score);
  if (n >= 75) return 'High';
  if (n >= 50) return 'Medium';
  return 'Low';
}

function countWords_(text) {
  var normalized = normalizeWhitespace_(text);
  return normalized ? normalized.split(' ').length : 0;
}

function containsEmDash_(text) {
  return String(text || '').indexOf('—') > -1;
}

function hasPlaceholder_(text) {
  return PLACEHOLDER_PATTERNS.some(function(pattern) { return pattern.test(String(text || '')); });
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainTextToHtml_(text) {
  return String(text || '').split(/\n\s*\n/).map(function(paragraph) {
    return '<p style="margin:0 0 12px 0">' + escapeHtml_(paragraph).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

function stripHtml_(html) {
  return normalizeWhitespace_(String(html || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'));
}

function concatenateSignature_(body, optOut, signature, isHtml) {
  var content = String(body || '').trim();
  var opt = String(optOut || '').trim();
  var sig = String(signature || '').trim();
  if (sig && normalizeWhitespace_(isHtml ? stripHtml_(content) : content).indexOf(normalizeWhitespace_(isHtml ? stripHtml_(sig) : sig)) > -1) sig = '';
  if (isHtml) {
    var htmlBody = /<[^>]+>/.test(content) ? content : plainTextToHtml_(content);
    var htmlOpt = opt ? '<p style="margin:12px 0">' + escapeHtml_(opt) + '</p>' : '';
    return htmlBody + htmlOpt + (sig ? '<div class="gmail_signature">' + sig + '</div>' : '');
  }
  return [content, opt, sig].filter(function(v) { return v; }).join('\n\n');
}

function columnLetter_(columnNumber) {
  var n = Number(columnNumber);
  var result = '';
  while (n > 0) {
    var remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function headerMapFromValues_(headers) {
  var map = {};
  headers.forEach(function(header, index) { map[String(header)] = index + 1; });
  return map;
}

function safeJsonParse_(text, fallback) {
  try { return JSON.parse(text); } catch (error) { return fallback; }
}

function truncate_(value, maxLength) {
  var text = String(value || '');
  return text.length <= maxLength ? text : text.slice(0, maxLength - 1) + '…';
}

function executionId_() {
  return Utilities.getUuid();
}

function nowIso_() {
  return Utilities.formatDate(new Date(), APP_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function sleepRandom_(minimumMs, maximumMs) {
  var min = Math.max(0, Number(minimumMs) || 0);
  var max = Math.max(min, Number(maximumMs) || min);
  Utilities.sleep(Math.floor(min + Math.random() * (max - min + 1)));
}

function retryOperation_(operation, options) {
  var settings = options || {};
  var attempts = Number(settings.attempts || 3);
  var baseDelay = Number(settings.baseDelayMs || 500);
  var retryWhen = settings.retryWhen || function() { return true; };
  var lastError;
  for (var attempt = 0; attempt < attempts; attempt++) {
    try {
      return operation(attempt + 1);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !retryWhen(error)) throw error;
      Utilities.sleep(baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
    }
  }
  throw lastError;
}

function isExecutionTimeLow_(startedAt, limitMs) {
  return Date.now() - startedAt > Number(limitMs || 270000);
}

function decodeHeaderValue_(value) {
  return String(value || '').replace(/\r?\n/g, ' ');
}

function base64UrlEncode_(text) {
  return Utilities.base64EncodeWebSafe(String(text || ''), Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function base64UrlDecode_(value) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(String(value || ''))).getDataAsString();
}

function jaccardSimilarity_(a, b) {
  function words(value) {
    var set = {};
    normalizeWhitespace_(value).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').forEach(function(word) {
      if (word.length > 3) set[word] = true;
    });
    return set;
  }
  var left = words(a);
  var right = words(b);
  var union = {};
  Object.keys(left).concat(Object.keys(right)).forEach(function(key) { union[key] = true; });
  var intersection = Object.keys(left).filter(function(key) { return right[key]; }).length;
  var denominator = Object.keys(union).length;
  return denominator ? intersection / denominator : 0;
}

