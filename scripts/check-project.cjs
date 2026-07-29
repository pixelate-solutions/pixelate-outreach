'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const files = fs.readdirSync(src).sort();
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'appsscript.json'), 'utf8'));
const requiredScopes = [
  'https://www.googleapis.com/auth/spreadsheets.currentonly',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.settings.basic'
];
for (const scope of requiredScopes) {
  if (!manifest.oauthScopes.includes(scope)) throw new Error(`Missing OAuth scope: ${scope}`);
}
if (manifest.timeZone !== 'America/Detroit') throw new Error('Manifest timezone must be America/Detroit.');
if (!manifest.dependencies.enabledAdvancedServices.some(s => s.serviceId === 'gmail' && s.version === 'v1')) throw new Error('Gmail advanced service v1 is not enabled.');

for (const file of files.filter(file => file.endsWith('.gs'))) {
  const source = fs.readFileSync(path.join(src, file), 'utf8');
  try { new vm.Script(source, { filename: file }); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}
for (const file of files.filter(file => file.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(src, file), 'utf8');
  if (!/<html[>\s]/i.test(html) || !/<script[>\s]/i.test(html)) throw new Error(`${file} is missing expected HTML/script structure.`);
}
const combined = files.filter(file => /\.(gs|html)$/.test(file)).map(file => fs.readFileSync(path.join(src, file), 'utf8')).join('\n');
if (/\bTODO\b|placeholder implementation|throw new Error\(['"]Not implemented/i.test(combined)) throw new Error('Core source contains a TODO or placeholder implementation.');
console.log(`Project check passed: ${files.length} source files, ${manifest.oauthScopes.length} OAuth scopes.`);
