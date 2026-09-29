const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { build, OUT } = require('../scripts/build-offline');

test('offline/poker-night.html is up to date with the sources', () => {
  const fresh = build();
  const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  assert.ok(committed === fresh, 'The offline build is stale: run `npm run build:offline` and commit the result');
});

test('offline build is fully self-contained', () => {
  const html = build();
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts');
  assert.doesNotMatch(html, /<link[^>]+stylesheet/, 'no external stylesheets');
  assert.doesNotMatch(html, /url\("fonts\//, 'font is inlined');
  assert.match(html, /window\.LocalServer/);
});
