/**
 * Unified AI provider — Track B.
 *
 * Priority chain:
 *   1. Claude — IntegrationCredential row with provider='claude' (clientId = API key)
 *   2. Claude — ANTHROPIC_API_KEY env var
 *   3. Gemini — GEMINI_API_KEY env var
 *
 * `mode='thorough'` enables extended thinking (Claude) or thinkingBudget (Gemini)
 * and prefers the higher-quality `*-pro` / `*-opus` models. Use 'fast' for
 * bulk / latency-sensitive calls.
 *
 * NOTE: routes/orchestration.js has its own copy of resolveAIProvider() for
 * historical reasons. New code should use this module.
 */
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');

const prisma = require('./database');
const DEFAULTS = {
  geminiPro:   'gemini-2.5-pro',
  geminiFast:  'gemini-2.5-flash',
  claudePro:   'claude-opus-4-7',
  claudeFast:  'claude-sonnet-4-6',
  thinkingBudgetThorough: 8192,
  thinkingBudgetFast:     0,
};

async function resolveProvider() {
  try {
    const claudeCred = await prisma.integrationCredential.findFirst({
      where: { provider: 'claude' },
    });
    if (claudeCred?.clientId) {
      return { provider: 'claude', apiKey: claudeCred.clientId };
    }
  } catch { /* DB not ready — fall through */ }

  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.GEMINI_API_KEY) {
    return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY };
  }
  return { provider: null };
}

function pickModel({ provider, mode, modelOverride }) {
  if (modelOverride) return modelOverride;
  if (provider === 'claude') return mode === 'thorough' ? DEFAULTS.claudePro : DEFAULTS.claudeFast;
  return mode === 'thorough' ? DEFAULTS.geminiPro : DEFAULTS.geminiFast;
}

/**
 * Generate content using the resolved provider.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt - System / role prompt
 * @param {string} opts.userPrompt   - The actual task prompt (with context inlined)
 * @param {string} [opts.mode]       - 'thorough' (default) | 'fast'
 * @param {string} [opts.model]      - explicit model override
 * @param {boolean}[opts.json]       - true to request JSON response
 * @returns {Promise<{text, provider, model, reasoning?}>}
 */
async function generate({ systemPrompt, userPrompt, mode = 'thorough', model: modelOverride, json = false }) {
  const resolved = await resolveProvider();
  if (!resolved.provider) {
    throw new Error('No AI provider configured. Add an Anthropic key in Integrations or set GEMINI_API_KEY.');
  }
  const model = pickModel({ provider: resolved.provider, mode, modelOverride });
  const thinkingBudget = mode === 'thorough' ? DEFAULTS.thinkingBudgetThorough : DEFAULTS.thinkingBudgetFast;

  if (resolved.provider === 'claude') {
    const client = new Anthropic({ apiKey: resolved.apiKey });
    const req = {
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (mode === 'thorough') {
      req.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
      // When thinking is enabled, max_tokens must exceed budget_tokens
      req.max_tokens = thinkingBudget + 4096;
    }
    const resp = await client.messages.create(req);
    let text = '';
    let reasoning = '';
    for (const block of resp.content || []) {
      if (block.type === 'thinking') reasoning += (block.thinking || block.text || '');
      else if (block.type === 'text') text += block.text;
    }
    return { text: text.trim(), provider: 'claude', model, reasoning: reasoning.trim() || undefined };
  }

  // Gemini
  const ai = new GoogleGenAI({ apiKey: resolved.apiKey });
  const config = {};
  if (json) config.responseMimeType = 'application/json';
  if (mode === 'thorough') {
    config.thinkingConfig = { thinkingBudget };
  }
  // System prompt support via systemInstruction
  if (systemPrompt) config.systemInstruction = systemPrompt;

  const resp = await ai.models.generateContent({
    model,
    contents: userPrompt,
    config,
  });
  return { text: (resp.text || '').trim(), provider: 'gemini', model };
}

async function status() {
  const r = await resolveProvider();
  return { provider: r.provider, configured: !!r.provider };
}

module.exports = { generate, resolveProvider, status, DEFAULTS };
