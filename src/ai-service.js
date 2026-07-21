const fs = require('node:fs/promises');
const path = require('node:path');
const { analysisPrompt, MAX_COMMIT_INPUT } = require('./codex-service');

const PROVIDERS = Object.freeze({
  codex: { label: 'Codex (compte ChatGPT)', baseUrl: '', needsApiKey: false },
  openai: { label: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', needsApiKey: true },
  anthropic: { label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', needsApiKey: true },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsApiKey: true },
  'openai-compatible': { label: 'API compatible OpenAI', baseUrl: '', needsApiKey: true },
});
const DEFAULT_AI_SETTINGS = Object.freeze({
  provider: 'codex', model: '', baseUrl: '', reasoningEffort: 'medium', maxOutputTokens: 5000,
  timeoutSeconds: 180, language: 'français', customInstructions: '', saveAnalyses: true,
});
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function cleanText(value, maximum, label) {
  const text = String(value || '').trim();
  if (text.length > maximum || /\0/.test(text)) throw new Error(`${label} invalide.`);
  return text;
}

function normalizeAiSettings(value = {}) {
  const provider = String(value.provider || DEFAULT_AI_SETTINGS.provider);
  if (!PROVIDERS[provider]) throw new Error('Fournisseur IA invalide.');
  const model = cleanText(value.model, 200, 'Nom de modèle');
  if (model && /[\r\n]/.test(model)) throw new Error('Nom de modèle invalide.');
  const reasoningEffort = String(value.reasoningEffort || 'medium');
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw new Error('Niveau de raisonnement invalide.');
  const maxOutputTokens = Math.round(Number(value.maxOutputTokens || DEFAULT_AI_SETTINGS.maxOutputTokens));
  if (maxOutputTokens < 500 || maxOutputTokens > 32_000) throw new Error('La limite de sortie doit être comprise entre 500 et 32 000 jetons.');
  const timeoutSeconds = Math.round(Number(value.timeoutSeconds || DEFAULT_AI_SETTINGS.timeoutSeconds));
  if (timeoutSeconds < 10 || timeoutSeconds > 600) throw new Error('Le délai doit être compris entre 10 et 600 secondes.');
  const language = cleanText(value.language || 'français', 60, 'Langue');
  const customInstructions = cleanText(value.customInstructions, 4000, 'Consignes personnalisées');
  let baseUrl = cleanText(value.baseUrl, 500, 'URL d’API');
  if (provider !== 'codex') baseUrl ||= PROVIDERS[provider].baseUrl;
  if (baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error('URL d’API invalide.'); }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error('L’URL d’API doit utiliser HTTPS (HTTP est accepté uniquement en local).');
    baseUrl = baseUrl.replace(/\/+$/, '');
  }
  if (provider === 'openai-compatible' && !baseUrl) throw new Error('L’URL de l’API compatible OpenAI est obligatoire.');
  return { provider, model, baseUrl, reasoningEffort, maxOutputTokens, timeoutSeconds, language, customInstructions, saveAnalyses: value.saveAnalyses !== false };
}

function jsonFromText(value) {
  const source = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Le fournisseur IA a renvoyé une analyse illisible.');
  return validateAnalysis(JSON.parse(source.slice(start, end + 1)));
}

function validateAnalysis(value) {
  const listNames = ['functionalChanges', 'technicalChanges', 'impacts', 'risks', 'tests'];
  if (!value || typeof value !== 'object' || typeof value.summary !== 'string') throw new Error('Le fournisseur IA a renvoyé une analyse incomplète.');
  for (const name of listNames) {
    if (!Array.isArray(value[name]) || value[name].some((entry) => typeof entry !== 'string')) throw new Error('Le fournisseur IA a renvoyé une analyse incomplète.');
  }
  if (!Array.isArray(value.files) || value.files.some((entry) => !entry || typeof entry.path !== 'string' || typeof entry.change !== 'string')) throw new Error('Le fournisseur IA a renvoyé une liste de fichiers invalide.');
  return value;
}

function providerPrompt(commitData, settings, truncated) {
  const additions = [
    `Rédige toute l’analyse en ${settings.language}.`,
    `Niveau de détail attendu : ${settings.reasoningEffort}.`,
    settings.customInstructions ? `Consignes supplémentaires :\n${settings.customInstructions}` : '',
    'Retourne uniquement un objet JSON conforme au schéma demandé.',
  ].filter(Boolean).join('\n');
  return `${analysisPrompt(commitData, truncated)}\n\n${additions}`;
}

async function requestJson(url, options, timeoutSeconds, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`Le fournisseur IA a refusé la requête (${response.status}).`);
      error.details = data?.error?.message || data?.message || String(data.raw || '').slice(0, 2000);
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Le fournisseur IA n’a pas répondu dans le délai configuré.');
    throw error;
  } finally { clearTimeout(timer); }
}

function headersFor(provider, apiKey) {
  const headers = { 'content-type': 'application/json' };
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'gemini') headers['x-goog-api-key'] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

class CloudAiService {
  constructor(options = {}) { this.fetch = options.fetch || globalThis.fetch; }

  async models(settings, apiKey) {
    const clean = normalizeAiSettings(settings);
    if (!apiKey) return [];
    let url = `${clean.baseUrl}/models`;
    const data = await requestJson(url, { headers: headersFor(clean.provider, apiKey) }, Math.min(clean.timeoutSeconds, 30), this.fetch);
    const values = data.data || data.models || [];
    return values
      .filter((entry) => clean.provider !== 'gemini' || (entry.supportedGenerationMethods || []).includes('generateContent'))
      .map((entry) => ({ id: String(entry.id || entry.name || '').replace(/^models\//, ''), name: entry.displayName || entry.id || String(entry.name || '').replace(/^models\//, ''), description: entry.description || '' }))
      .filter((entry) => entry.id)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async analyze(commitData, settings, apiKey, schema) {
    const clean = normalizeAiSettings(settings);
    if (!apiKey) throw new Error('Ajoutez une clé API pour ce fournisseur avant de lancer une analyse.');
    if (!clean.model) throw new Error('Choisissez ou saisissez un modèle avant de lancer une analyse.');
    const truncated = commitData.length > MAX_COMMIT_INPUT;
    const prompt = providerPrompt(commitData.slice(0, MAX_COMMIT_INPUT), clean, truncated);
    const responseSchema = { ...schema };
    delete responseSchema.$schema;
    let url;
    let body;
    if (clean.provider === 'openai') {
      url = `${clean.baseUrl}/responses`;
      body = { model: clean.model, input: prompt, max_output_tokens: clean.maxOutputTokens, store: false, text: { format: { type: 'json_schema', name: 'commit_analysis', schema: responseSchema, strict: true } } };
      body.reasoning = { effort: clean.reasoningEffort };
    } else if (clean.provider === 'anthropic') {
      url = `${clean.baseUrl}/messages`;
      body = { model: clean.model, max_tokens: clean.maxOutputTokens, system: 'Tu es un analyste de commits Git. Réponds exclusivement en JSON.', messages: [{ role: 'user', content: `${prompt}\n\nSchéma JSON :\n${JSON.stringify(responseSchema)}` }] };
    } else if (clean.provider === 'gemini') {
      url = `${clean.baseUrl}/models/${encodeURIComponent(clean.model)}:generateContent`;
      body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: clean.maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: responseSchema } };
    } else {
      url = `${clean.baseUrl}/chat/completions`;
      body = { model: clean.model, max_tokens: clean.maxOutputTokens, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_schema', json_schema: { name: 'commit_analysis', strict: true, schema: responseSchema } } };
    }
    const data = await requestJson(url, { method: 'POST', headers: headersFor(clean.provider, apiKey), body: JSON.stringify(body) }, clean.timeoutSeconds, this.fetch);
    const output = clean.provider === 'openai'
      ? (data.output_text || data.output?.flatMap((entry) => entry.content || []).find((entry) => entry.type === 'output_text')?.text)
      : clean.provider === 'anthropic' ? data.content?.find((entry) => entry.type === 'text')?.text
        : clean.provider === 'gemini' ? data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('')
          : data.choices?.[0]?.message?.content;
    return { analysis: jsonFromText(output), truncated };
  }
}

class AiSecretStore {
  constructor(filePath, safeStorage) { this.filePath = filePath; this.safeStorage = safeStorage; this.session = new Map(); }
  securePersistenceAvailable() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.()) && !(process.platform === 'linux' && this.safeStorage.getSelectedStorageBackend?.() === 'basic_text');
  }
  async read() { try { return JSON.parse(await fs.readFile(this.filePath, 'utf8')); } catch { return {}; } }
  async get(provider) {
    if (this.session.has(provider)) return this.session.get(provider);
    if (!this.securePersistenceAvailable()) return '';
    const value = (await this.read())[provider];
    if (!value) return '';
    try { return this.safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
  }
  async set(provider, apiKey, persist = true) {
    const key = String(apiKey || '').trim();
    if (key) this.session.set(provider, key); else this.session.delete(provider);
    const entries = await this.read();
    if (key && persist && this.securePersistenceAvailable()) entries[provider] = this.safeStorage.encryptString(key).toString('base64');
    else delete entries[provider];
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    return { hasApiKey: Boolean(key), persisted: Boolean(key && persist && this.securePersistenceAvailable()) };
  }
}

module.exports = { AiSecretStore, CloudAiService, DEFAULT_AI_SETTINGS, PROVIDERS, jsonFromText, normalizeAiSettings, providerPrompt, requestJson, validateAnalysis };
