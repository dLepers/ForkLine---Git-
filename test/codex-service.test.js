const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CodexAnalysisStore,
  CodexService,
  normalizeCodexSettings,
  parseModelCatalog,
} = require('../src/codex-service');

const result = {
  summary: 'Le commit ajoute une analyse.',
  functionalChanges: ['Affiche un résumé.'],
  technicalChanges: ['Ajoute un service.'],
  impacts: [],
  risks: [],
  tests: ['Un test couvre le service.'],
  files: [{ path: 'src/app.js', change: 'Affiche le résultat.' }],
};

test('normalizes and validates Codex settings', () => {
  assert.deepEqual(normalizeCodexSettings(), { model: '', reasoningEffort: 'medium', saveAnalyses: true });
  assert.deepEqual(normalizeCodexSettings({ model: 'gpt-5.6-sol', reasoningEffort: 'high', saveAnalyses: false }), { model: 'gpt-5.6-sol', reasoningEffort: 'high', saveAnalyses: false });
  assert.throws(() => normalizeCodexSettings({ model: 'model\ninvalid' }), /modèle Codex invalide/);
  assert.throws(() => normalizeCodexSettings({ reasoningEffort: 'ultra' }), /raisonnement Codex invalide/);
});

test('extracts visible models and supported reasoning levels from the Codex catalog', () => {
  const models = parseModelCatalog(JSON.stringify({ models: [
    { slug: 'visible', display_name: 'Visible', description: 'Recommended', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
    { slug: 'hidden', visibility: 'hide' },
  ] }));
  assert.deepEqual(models, [{ id: 'visible', name: 'Visible', description: 'Recommended', defaultReasoningEffort: 'low', reasoningEfforts: ['low', 'high'] }]);
});

test('recognizes a successful Codex login status written to stderr', async () => {
  const service = new CodexService({ run: async () => ({
    stdout: '',
    stderr: 'WARNING: PATH aliases unavailable\nLogged in using ChatGPT\n',
  }) });

  assert.deepEqual(await service.status('/usr/bin/codex'), {
    installed: true,
    authenticated: true,
    label: 'Logged in using ChatGPT',
  });
});

test('runs commit analysis through an ephemeral read-only Codex process with isolated input', async () => {
  let invocation;
  const service = new CodexService({ run: async (executable, args, options) => {
    invocation = { executable, args, options };
    return { stdout: JSON.stringify(result), stderr: '' };
  } });

  const response = await service.analyze('/usr/bin/codex', 'commit 123\ndiff --git a/a b/a', { model: 'gpt-test', reasoningEffort: 'high', saveAnalyses: true }, { schemaPath: '/app/schema.json', cwd: '/isolated' });

  assert.deepEqual(response, { analysis: result, truncated: false });
  assert.equal(invocation.executable, '/usr/bin/codex');
  assert.equal(invocation.options.cwd, '/isolated');
  assert.match(invocation.options.input, /<commit_data>[\s\S]*diff --git/);
  assert.match(invocation.options.input, /N’utilise aucun outil et n’exécute aucune commande/);
  assert.deepEqual(invocation.args.slice(0, 8), ['exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--color', 'never']);
  assert.equal(invocation.args.includes('--model'), true);
  assert.equal(invocation.args.includes('gpt-test'), true);
  assert.equal(invocation.args.at(-1), '-');
});

test('runs a free-form Codex agent in the repository with Git write access', async () => {
  let invocation;
  const service = new CodexService({ run: async (executable, args, options) => {
    invocation = { executable, args, options };
    return { stdout: 'Deux commits fonctionnels créés.', stderr: '' };
  } });
  assert.deepEqual(await service.agent('/usr/bin/codex', 'commit en séparant les fonctionnalités', { reasoningEffort: 'medium' }, { cwd: '/repository', timeout: 60_000 }), { message: 'Deux commits fonctionnels créés.' });
  assert.match(invocation.args.join(' '), /--dangerously-bypass-approvals-and-sandbox/);
  assert.equal(invocation.args.includes('--output-schema'), false);
  assert.equal(invocation.args.includes('--ignore-user-config'), false);
  assert.equal(invocation.options.cwd, '/repository');
  assert.equal(invocation.options.input, 'commit en séparant les fonctionnalités');
});

test('stores analyses by hashed repository identity and supports deletion and full clearing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-codex-store-'));
  const file = path.join(directory, 'analyses.json');
  const store = new CodexAnalysisStore(file);
  try {
    const record = { ...result, createdAt: new Date().toISOString() };
    await store.set('/private/customer/repository', 'abc123', record);
    assert.deepEqual(await store.get('/private/customer/repository', 'abc123'), record);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /private\/customer\/repository/);
    await store.delete('/private/customer/repository', 'abc123');
    assert.equal(await store.get('/private/customer/repository', 'abc123'), null);
    await store.set('/private/customer/repository', 'def456', record);
    await store.clear();
    assert.equal(await store.get('/private/customer/repository', 'def456'), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
