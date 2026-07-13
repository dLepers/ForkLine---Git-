const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('src/renderer/app.js');
const html = read('src/renderer/index.html');
const preload = read('src/preload.js');
const main = read('src/main.js');

function captures(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

test('all static renderer ID selectors refer to declared interface elements', () => {
  const usedIds = new Set(captures(renderer, /\$\('#([A-Za-z][\w-]*)'\)/g));
  const declaredIds = new Set(captures(`${html}\n${renderer}`, /\bid=["']([A-Za-z][\w-]*)["']/g));
  captures(renderer, /\.id\s*=\s*'([A-Za-z][\w-]*)'/g).forEach((id) => declaredIds.add(id));
  const missing = [...usedIds].filter((id) => !declaredIds.has(id)).sort();

  assert.deepEqual(missing, []);
  assert.equal(usedIds.size > 70, true, 'Le test doit couvrir l’essentiel de l’interface renderer.');
});

test('all renderer calls are exposed by the preload bridge', () => {
  const usedMethods = new Set(captures(renderer, /window\.forkline\.([A-Za-z][\w]*)/g));
  const exposedMethods = new Set(captures(preload, /^\s{2}([A-Za-z][\w]*):/gm));
  const missing = [...usedMethods].filter((method) => !exposedMethods.has(method)).sort();

  assert.deepEqual(missing, []);
});

test('all preload IPC invocations have a main-process handler', () => {
  const invokedChannels = new Set(captures(preload, /invoke\('([^']+)'/g));
  const handledChannels = new Set(captures(main, /handle\('([^']+)'/g));
  captures(main, /\['([^']+)',\s*\(value\)\s*=>/g).forEach((suffix) => handledChannels.add(`repository:${suffix}`));
  const missing = [...invokedChannels].filter((channel) => !handledChannels.has(channel)).sort();

  assert.deepEqual(missing, []);
});
