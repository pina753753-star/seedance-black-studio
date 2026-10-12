const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const menuPages = [
  'index.html',
  'cancel-subscription.html',
  'credits-info.html',
  'generate-prod.html',
  'help.html',
  'pricing.html',
  'profile.html'
];

test('すべての公開メニューでH3のBETA表記を維持する', () => {
  for (const file of menuPages) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const link = html.match(/<a href=["']\.\/h3-live\.html["'][^>]*>[\s\S]*?<\/a>/);
    assert.ok(link, `${file}: H3メニューリンクがありません`);
    assert.match(link[0], /BETA/, `${file}: H3のBETA表記がありません`);
  }
});
