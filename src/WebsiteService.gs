function fetchOfficialWebsitePages_(website) {
  var normalized = normalizeWebsite_(website, website);
  if (!normalized) return [];
  assertPublicWebUrl_(normalized);
  var home = fetchWebsitePage_(normalized);
  var pages = home ? [home] : [];
  if (!home) return pages;
  var prioritized = extractPrioritizedLinks_(home.html, normalized).slice(0, 5);
  prioritized.forEach(function(url) {
    if (pages.length >= 6) return;
    try {
      var page = fetchWebsitePage_(url);
      if (page && page.text.length >= 100) pages.push(page);
    } catch (error) {
      console.warn('Skipped website page ' + url + ': ' + error.message);
    }
  });
  return pages;
}

function fetchWebsitePage_(url) {
  assertPublicWebUrl_(url);
  var response = retryOperation_(function() {
    var result = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true,
      headers: { 'User-Agent': 'PixelateOutboundAssistant/1.0 (+company research)' }
    });
    var status = result.getResponseCode();
    if (status === 429 || status >= 500) {
      var transient = new Error('Website returned HTTP ' + status);
      transient.transient = true;
      throw transient;
    }
    if (status < 200 || status >= 400) return null;
    return result;
  }, { attempts: 3, baseDelayMs: 500, retryWhen: function(error) { return error.transient === true; } });
  if (!response) return null;
  var headers = response.getHeaders();
  var contentType = String(headers['Content-Type'] || headers['content-type'] || '');
  if (contentType && contentType.indexOf('text/html') === -1 && contentType.indexOf('text/plain') === -1) return null;
  var html = response.getContentText().slice(0, 500000);
  var text = htmlToResearchText_(html).slice(0, 12000);
  return { url: url, text: text, html: html };
}

function assertPublicWebUrl_(url) {
  var value = String(url || '');
  if (!/^https?:\/\//i.test(value)) throw new Error('Only HTTP(S) website URLs are supported.');
  var domain = normalizeDomain_(value);
  if (!domain) throw new Error('Website URL has an invalid domain.');
  if (domain === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(domain) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(domain)) {
    throw new Error('Private or local network URLs are not allowed.');
  }
}

function extractPrioritizedLinks_(html, baseUrl) {
  var keywords = ['about', 'products', 'services', 'support', 'parts', 'maintenance', 'resources', 'manuals', 'training', 'rentals', 'industries', 'portal', 'dealer', 'careers', 'contact', 'installation', 'warranty'];
  var baseDomain = normalizeDomain_(baseUrl);
  var origin = String(baseUrl).match(/^https?:\/\/[^/]+/i)[0];
  var seen = {};
  var matches = [];
  var regex = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    var href = match[1].trim();
    var label = htmlToResearchText_(match[2]).toLowerCase();
    var scoreText = (href + ' ' + label).toLowerCase();
    if (!keywords.some(function(keyword) { return scoreText.indexOf(keyword) > -1; })) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    var absolute = href.indexOf('//') === 0 ? 'https:' + href : (href.charAt(0) === '/' ? origin + href : (/^https?:\/\//i.test(href) ? href : origin + '/' + href.replace(/^\.\//, '')));
    absolute = absolute.split('#')[0];
    if (normalizeDomain_(absolute) !== baseDomain || seen[absolute]) continue;
    seen[absolute] = true;
    matches.push(absolute);
  }
  return matches;
}

function htmlToResearchText_(html) {
  return normalizeWhitespace_(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>'));
}

function serializeWebsitePagesForPrompt_(pages) {
  return pages.map(function(page, index) {
    return 'OFFICIAL SOURCE ' + (index + 1) + '\nURL: ' + page.url + '\nTEXT: ' + truncate_(page.text, 9000);
  }).join('\n\n');
}

