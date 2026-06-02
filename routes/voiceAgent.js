const express = require('express');
const router = express.Router();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');

const prisma = require('../services/database');
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

// ─── Resolve ElevenLabs credentials ──────────────────────────────────────────
const getElevenCreds = async () => {
  const cred = await prisma.integrationCredential.findFirst({
    where: { provider: 'elevenlabs' },
  });
  if (!cred?.clientId) throw new Error('ElevenLabs API key not configured — add it in Integrations.');
  return { apiKey: cred.clientId, agentId: cred.clientSecret, voiceId: cred.email };
};

// ─── Resolve Claude credentials ───────────────────────────────────────────────
const getClaudeKey = async () => {
  const cred = await prisma.integrationCredential.findFirst({ where: { provider: 'claude' } });
  return cred?.clientId || process.env.ANTHROPIC_API_KEY || null;
};

// ─── Build per-prospect system prompt ────────────────────────────────────────
const buildSystemPrompt = (prospect, template) => {
  const base = template || `You are a professional SDR making an outbound sales call on behalf of the team. You are warm, concise, and focused on booking a discovery meeting.

Prospect context:
- Name: {{firstName}} {{lastName}}
- Title: {{title}}
- Company: {{company}}
- Status: {{status}}
- Notes: {{notes}}

Your goal: qualify the prospect and book a 20-minute discovery call. Handle objections gracefully. If they express no interest, thank them politely and end the call. Keep each response under 3 sentences. Do not make up product details you don't know.`;

  return base
    .replace(/{{firstName}}/g, prospect.firstName || '')
    .replace(/{{lastName}}/g, prospect.lastName || '')
    .replace(/{{title}}/g, prospect.title || 'Unknown title')
    .replace(/{{company}}/g, prospect.companyName || 'their company')
    .replace(/{{status}}/g, prospect.status || 'Uncontacted')
    .replace(/{{notes}}/g, prospect.notes?.slice(0, 400) || 'No prior notes.');
};

// ─── GET /voice-agent/voices ──────────────────────────────────────────────────
router.get('/voices', async (req, res) => {
  try {
    const { apiKey } = await getElevenCreds();
    const r = await axios.get(`${ELEVEN_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey },
    });
    const voices = (r.data.voices || []).map(v => ({
      id: v.voice_id,
      name: v.name,
      preview: v.preview_url,
      category: v.category,
    }));
    res.json(voices);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /voice-agent/provision ─────────────────────────────────────────────
// Auto-creates or updates the ElevenLabs agent for this workspace
router.post('/provision', async (req, res) => {
  try {
    const { apiKey, voiceId } = await getElevenCreds();

    const agentConfig = {
      name: 'Apex Voice Agent',
      conversation_config: {
        agent: {
          prompt: {
            prompt: 'You are a professional SDR. Full context will be provided per call.',
            llm: 'claude-3-5-sonnet',
            temperature: 0.7,
            tools: [],
          },
          first_message: "Hi, this is an AI assistant calling on behalf of our team. Is now a good time?",
          language: 'en',
        },
        tts: {
          model_id: 'eleven_turbo_v2_5',
          voice_id: voiceId || '21m00Tcm4TlvDq8ikWAM', // Rachel (default)
          optimize_streaming_latency: 4,
        },
        asr: { quality: 'high', provider: 'elevenlabs', user_input_audio_format: 'pcm_16000' },
        turn: { turn_timeout: 7, silence_end_call_timeout: 30 },
      },
    };

    const cred = await prisma.integrationCredential.findFirst({ where: { provider: 'elevenlabs' } });
    let agentId = cred?.clientSecret;

    if (agentId) {
      // Update existing agent
      await axios.patch(`${ELEVEN_BASE}/convai/agents/${agentId}`, agentConfig, {
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      });
    } else {
      // Create new agent
      const r = await axios.post(`${ELEVEN_BASE}/convai/agents/create`, agentConfig, {
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      });
      agentId = r.data.agent_id;
      // Persist agent ID back into clientSecret
      await prisma.integrationCredential.updateMany({
        where: { provider: 'elevenlabs' },
        data: { clientSecret: agentId },
      });
    }

    res.json({ agentId, status: 'provisioned' });
  } catch (err) {
    console.error('Provision error:', err.response?.data || err.message);
    res.status(400).json({ error: err.response?.data?.detail || err.message });
  }
});

// ─── POST /voice-agent/session ────────────────────────────────────────────────
// Creates a signed ElevenLabs session URL with prospect context injected
router.post('/session', async (req, res) => {
  try {
    const { prospectId, promptTemplate } = req.body;
    const { apiKey, agentId } = await getElevenCreds();

    if (!agentId) {
      return res.status(400).json({ error: 'Agent not provisioned. Click "Activate Agent" first.' });
    }

    let prospect = null;
    let systemPrompt = promptTemplate || null;

    if (prospectId) {
      prospect = await prisma.prospect.findUnique({ where: { id: parseInt(prospectId) } });
      if (prospect) systemPrompt = buildSystemPrompt(prospect, promptTemplate);
    }

    const overrides = systemPrompt ? {
      agent: {
        prompt: { prompt: systemPrompt },
        first_message: prospect
          ? `Hi ${prospect.firstName}, this is an AI assistant from our team. Is now a good time for a quick call?`
          : undefined,
      },
    } : {};

    const r = await axios.post(
      `${ELEVEN_BASE}/convai/conversations/initiate`,
      { agent_id: agentId, conversation_config_override: overrides },
      { headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' } }
    );

    res.json({
      signedUrl: r.data.signed_url,
      conversationId: r.data.conversation_id,
      prospect: prospect ? {
        id: prospect.id,
        name: `${prospect.firstName} ${prospect.lastName}`,
        company: prospect.companyName,
        title: prospect.title,
        status: prospect.status,
      } : null,
    });
  } catch (err) {
    console.error('Session error:', err.response?.data || err.message);
    res.status(400).json({ error: err.response?.data?.detail || err.message });
  }
});

// ─── POST /voice-agent/llm ────────────────────────────────────────────────────
// OpenAI-compatible streaming endpoint — for use as ElevenLabs custom LLM
// Requires a publicly accessible server URL configured in the ElevenLabs agent
router.post('/llm', async (req, res) => {
  try {
    const { messages = [], system } = req.body;
    const systemPrompt = system || 'You are a concise AI SDR on a live call. Keep responses under 3 sentences.';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const claudeKey = await getClaudeKey();

    if (claudeKey) {
      // Claude path
      const client = new Anthropic({ apiKey: claudeKey });
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        system: systemPrompt,
        messages: messages.filter(m => m.role === 'user' || m.role === 'assistant'),
      });
      stream.on('text', (text) => {
        res.write(`data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
      });
      stream.on('finalMessage', () => {
        res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      stream.on('error', (err) => { console.error('Claude stream error:', err); res.end(); });
      return;
    }

    if (process.env.GEMINI_API_KEY) {
      // Gemini fallback — stream and reformat as OpenAI-compatible SSE
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const geminiMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

      const stream = await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: geminiMessages,
        config: { maxOutputTokens: 256, systemInstruction: systemPrompt },
      });

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          res.write(`data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.status(500).json({ error: 'No AI provider configured. Add a Claude key in Integrations or set GEMINI_API_KEY in .env.' });
  } catch (err) {
    console.error('LLM route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /voice-agent/transcript ────────────────────────────────────────────
router.post('/transcript', async (req, res) => {
  try {
    const { prospectId, transcript = [], duration, outcome } = req.body;
    if (!prospectId) return res.status(400).json({ error: 'prospectId required' });

    const ts = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const note = `\n\n--- Voice Agent Call — ${ts} (${duration || 0}s) ---\n${outcome ? `Outcome: ${outcome}\n` : ''}${transcript.map(t => `${t.role === 'agent' ? 'AI' : 'Prospect'}: ${t.message}`).join('\n')}\n--- End Call ---`;

    const prospect = await prisma.prospect.findUnique({ where: { id: parseInt(prospectId) } });
    await prisma.prospect.update({
      where: { id: parseInt(prospectId) },
      data: { notes: (prospect?.notes || '') + note },
    });

    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /voice-agent/calls ───────────────────────────────────────────────────
router.get('/calls', async (req, res) => {
  try {
    const prospects = await prisma.prospect.findMany({
      where: { notes: { contains: '--- Voice Agent Call' } },
      select: { id: true, firstName: true, lastName: true, companyName: true, notes: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    const calls = prospects.flatMap(p => {
      const matches = [...(p.notes || '').matchAll(/--- Voice Agent Call — (.+?) \((\d+)s\) ---\n(?:Outcome: (.+?)\n)?/g)];
      return matches.map(m => ({
        prospectId: p.id,
        prospectName: `${p.firstName} ${p.lastName}`,
        company: p.companyName,
        date: m[1], duration: parseInt(m[2]) || 0, outcome: m[3] || null,
      }));
    });

    res.json(calls.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
