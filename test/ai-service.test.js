const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AiSecretStore, CloudAiService, jsonFromText, normalizeAiSettings } = require('../src/ai-service');
const schema = require('../src/codex-analysis-schema.json');

const analysis = { summary: 'Résumé', functionalChanges: [], technicalChanges: [], impacts: [], risks: [], tests: [], files: [] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test('normalizes configurable cloud provider settings and rejects unsafe remote URLs', () => {
  assert.deepEqual(normalizeAiSettings({ provider: 'openai', model: 'gpt-test' }), {
    provider: 'openai', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', reasoningEffort: 'medium',
    maxOutputTokens: 5000, timeoutSeconds: 180, language: 'français', customInstructions: '', saveAnalyses: true,
  });
  assert.throws(() => normalizeAiSettings({ provider: 'unknown' }), /Fournisseur IA invalide/);
  assert.throws(() => normalizeAiSettings({ provider: 'openai-compatible', baseUrl: 'http://example.com/v1' }), /HTTPS/);
  assert.equal(normalizeAiSettings({ provider: 'openai-compatible', baseUrl: 'http://localhost:9000/v1' }).baseUrl, 'http://localhost:9000/v1');
});

test('rejects incomplete provider output before it reaches the renderer', () => {
  assert.throws(() => jsonFromText('{"summary":"Résumé"}'), /analyse incomplète/);
});

test('uses OpenAI Responses structured output without server-side response storage', async () => {
  let request;
  const service = new CloudAiService({ fetch: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return response({ output_text: JSON.stringify(analysis) });
  } });
  const result = await service.analyze('commit data', { provider: 'openai', model: 'gpt-test' }, 'secret', schema);
  assert.deepEqual(result.analysis, analysis);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, 'json_schema');
});

test('returns a generic structured plan for future AI tools', async () => {
  const plan = { action: 'commit', summary: 'Créer le commit.', confirmation: 'Confirmer.', revision: '', stashRef: '', branch: '', startPoint: '', message: 'feat: test', stageAll: true };
  const service = new CloudAiService({ fetch: async () => response({ output_text: JSON.stringify(plan) }) });
  const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: true };
  assert.deepEqual(await service.structured('Planifie', { provider: 'openai', model: 'gpt-test' }, 'secret', schema, 'git_action_plan'), plan);
});

test('supports Claude, Gemini and OpenAI-compatible response shapes', async () => {
  const cases = [
    [{ provider: 'anthropic', model: 'claude-test' }, { content: [{ type: 'text', text: JSON.stringify(analysis) }] }, '/messages'],
    [{ provider: 'gemini', model: 'gemini-test' }, { candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }] }, ':generateContent'],
    [{ provider: 'openai-compatible', model: 'custom', baseUrl: 'https://ai.example/v1' }, { choices: [{ message: { content: JSON.stringify(analysis) } }] }, '/chat/completions'],
  ];
  for (const [settings, body, expectedUrl] of cases) {
    let url;
    const service = new CloudAiService({ fetch: async (value) => { url = value; return response(body); } });
    assert.deepEqual((await service.analyze('diff', settings, 'secret', schema)).analysis, analysis);
    assert.match(url, new RegExp(expectedUrl.replace(/[?]/g, '\\?')));
  }
});

test('lists only Gemini models able to generate content', async () => {
  const service = new CloudAiService({ fetch: async () => response({ models: [
    { name: 'models/gemini-a', displayName: 'Gemini A', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
  ] }) });
  assert.deepEqual(await service.models({ provider: 'gemini' }, 'secret'), [{ id: 'gemini-a', name: 'Gemini A', description: '' }]);
});

test('encrypts persistent API keys and falls back to session memory with an unsafe Linux backend', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-ai-secret-'));
  const file = path.join(directory, 'secrets.json');
  const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (text) => Buffer.from(`encrypted:${text}`), decryptString: (buffer) => buffer.toString().replace('encrypted:', '') };
  try {
    const store = new AiSecretStore(file, safe);
    assert.deepEqual(await store.set('openai', 'sk-private', true), { hasApiKey: true, persisted: true });
    assert.equal(await store.get('openai'), 'sk-private');
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /sk-private/);
    safe.getSelectedStorageBackend = () => 'basic_text';
    assert.deepEqual(await store.set('anthropic', 'session-key', true), { hasApiKey: true, persisted: false });
    assert.equal(await store.get('anthropic'), 'session-key');
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /session-key/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
