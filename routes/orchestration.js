const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');

const prisma = require('../services/database');
const { getEmailStats, getQueueEngagementStats } = require('../services/emailStats');
// ─── Resolve active AI provider ───────────────────────────────────────────────
// Priority: Claude (DB cred) > Claude (env) > Gemini (DB cred) > Gemini (env)
const resolveAIProvider = async () => {
  try {
    const claudeCred = await prisma.integrationCredential.findFirst({
      where: { provider: 'claude' },
    });
    if (claudeCred?.clientId) {
      return {
        provider: 'claude',
        apiKey: claudeCred.clientId,
        model: claudeCred.clientSecret || 'claude-opus-4-6',
      };
    }
  } catch { /* DB not ready — fall through */ }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'claude',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    };
  }

  return { provider: 'gemini' };
};

// ─── Claude helper ────────────────────────────────────────────────────────────
const generateWithClaude = async (apiKey, model, systemPrompt) => {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: 'You are an expert AI assistant built into a B2B sales CRM. Always respond with valid JSON only — no markdown, no explanation.',
    messages: [{ role: 'user', content: systemPrompt }],
  });
  return response.content[0].text;
};

// ─── Gemini helper ────────────────────────────────────────────────────────────
const generateWithGemini = async (prompt) => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json' },
  });
  return response.text;
};

// ─── Unified generate ─────────────────────────────────────────────────────────
const generateContent = async (prompt) => {
  const ai = await resolveAIProvider();
  if (ai.provider === 'claude') return generateWithClaude(ai.apiKey, ai.model, prompt);
  if (!process.env.GEMINI_API_KEY) throw new Error('No AI provider configured. Add an Anthropic API key in Integrations or set GEMINI_API_KEY in .env');
  return generateWithGemini(prompt);
};

// ─── Aggregate helpers ────────────────────────────────────────────────────────

/** Group an array by a key, returning { key: count } */
const countBy = (arr, keyFn) =>
  arr.reduce((acc, item) => {
    const k = keyFn(item) || 'Unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

/** Return the top N entries of an object sorted by value descending */
const topN = (obj, n) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

// ─── Build CRM snapshot ───────────────────────────────────────────────────────
// Pre-compute aggregates so the AI doesn't have to count raw records itself,
// which leads to hallucinated numbers. Raw records are still included for
// list-building queries that need individual prospect IDs.
const buildCRMSnapshot = (prospects, sequences, emailStats = null, queueStats = null) => {
  const byStatus = countBy(prospects, p => p.status);
  const byCompany = topN(countBy(prospects, p => p.companyName), 20);

  const sequenceSummary = sequences.map(s => ({
    id: s.id,
    name: s.name,
    stepCount: s._count?.steps ?? 0,
    enrolledTotal: s._count?.prospectEnrollments ?? 0,
    enrolledActive: prospects.reduce(
      (n, p) => n + p.sequenceEnrollments.filter(e => e.sequenceId === s.id && e.status === 'active').length,
      0
    ),
  }));

  const enrollmentStatusCounts = countBy(
    prospects.flatMap(p => p.sequenceEnrollments),
    e => e.status
  );

  return {
    totalProspects: prospects.length,
    byStatus,
    byCompany,
    sequences: sequenceSummary,
    enrollmentStatusCounts,
    // Open/click tracking aggregates (all-time), pre-computed by
    // services/emailStats.js so the model never has to count raw rows.
    // Either cohort alone keeps the block alive: totals/bySequence go
    // null if sequence stats failed, queueSends is null until any
    // bridge/queue mail has been sent.
    emailEngagement: (emailStats || (queueStats && queueStats.sent > 0))
      ? {
          totals: emailStats
            ? {
                sent: emailStats.sent,
                opened: emailStats.opened,
                clicked: emailStats.clicked,
                failed: emailStats.failed,
                openRatePct: emailStats.openRate,
                clickRatePct: emailStats.clickRate,
              }
            : null,
          bySequence: emailStats
            ? (emailStats.groups || []).map(g => ({
                sequenceId: g.sequenceId,
                name: g.label,
                sent: g.sent,
                opened: g.opened,
                clicked: g.clicked,
                failed: g.failed,
                openRatePct: g.openRate,
                clickRatePct: g.clickRate,
              }))
            : null,
          // Bridge/queue one-off sends (MCP enqueue) — a separate cohort
          // from sequence emails; null until any have been sent.
          queueSends: queueStats && queueStats.sent > 0
            ? {
                sent: queueStats.sent,
                opened: queueStats.opened,
                clicked: queueStats.clicked,
                openRatePct: queueStats.openRate,
                clickRatePct: queueStats.clickRate,
              }
            : null,
        }
      : null,
  };
};

// ─── Slim prospect records for the prompt ────────────────────────────────────
// Include only fields Gemini needs to filter/match. Omitting heavy nested data
// that inflates token count without adding value.
const slimProspect = (p) => ({
  id: p.id,
  name: `${p.firstName} ${p.lastName}`,
  email: p.email,
  company: p.companyName,
  status: p.status,
  sequences: p.sequenceEnrollments.map(e => ({
    sequenceId: e.sequenceId,
    sequenceName: e.sequence?.name,
    status: e.status,
  })),
});

// ─── POST /orchestration/nlq ──────────────────────────────────────────────────
router.post('/nlq', async (req, res) => {
  try {
    const { prompt, conversationHistory = [] } = req.body;

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // ── Fetch CRM data ──────────────────────────────────────────────────────
    const [prospects, sequences, emailStats, queueStats] = await Promise.all([
      prisma.prospect.findMany({
        include: { sequenceEnrollments: { include: { sequence: true } } },
      }),
      prisma.sequence.findMany({
        include: { _count: { select: { prospectEnrollments: true, steps: true } } },
      }),
      // Engagement stats must never break the chat — degrade to null.
      getEmailStats({ groupBy: 'sequence' }).catch(err => {
        console.warn('[nlq] email stats unavailable:', err.message);
        return null;
      }),
      getQueueEngagementStats().catch(err => {
        console.warn('[nlq] queue engagement unavailable:', err.message);
        return null;
      }),
    ]);

    const snapshot = buildCRMSnapshot(prospects, sequences, emailStats, queueStats);
    const slimProspects = prospects.map(slimProspect);

    // ── Recent conversation context (last 6 turns) ──────────────────────────
    // Lets Gemini understand follow-up queries like "show me the same for Pepsi"
    const recentHistory = conversationHistory
      .slice(-6)
      .map(m => {
        if (m.role === 'user') return `User: ${m.content}`;
        if (m.role === 'agent') {
          if (m.type === 'query') return `Assistant: ${m.answer}`;
          if (m.type === 'action') return `Assistant: Generated call list "${m.playlist?.title}" (${m.playlist?.items?.length ?? 0} prospects)`;
          if (m.type === 'analysis') return `Assistant: Ran breakdown analysis — "${m.title}"`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n');

    // ── AI system prompt ────────────────────────────────────────────────────
    const systemInstruction = `You are an expert AI assistant built into a B2B sales engagement CRM.
You help SDRs and BDRs understand their pipeline, answer questions about their prospects, and build targeted call/email lists.

${recentHistory ? `RECENT CONVERSATION CONTEXT:\n${recentHistory}\n` : ''}
USER QUERY: "${prompt}"

─── CRM AGGREGATES (pre-computed — use these for counts and stats) ───
${JSON.stringify(snapshot, null, 2)}

─── FIELD DEFINITIONS ───
- status: Prospect contact status. Values seen in data: ${Object.keys(snapshot.byStatus).join(', ')}
- sequences[].status: Enrollment status. Common values: active, paused, completed, bounced
- company: Account / company name
- emailEngagement: open/click tracking aggregates (all-time). totals = across all sequences; bySequence = per-sequence breakdown; queueSends = the separate one-off/queued outreach cohort (not part of any sequence, null if none sent). openRatePct/clickRatePct are percentages of emails SENT. Use these (never compute your own) for any question about open rates, click rates, or email engagement. If emailEngagement is null, say engagement data is unavailable; if only emailEngagement.totals is null, say sequence engagement is unavailable but still report queueSends.

─── ALL PROSPECTS (slim — use IDs for list building) ───
${JSON.stringify(slimProspects, null, 2)}

─── INTENT CLASSIFICATION ───
Classify the query as one of three types:

1. "query" — User is ASKING A QUESTION (how many, who, what, show me, tell me, is/are).
   Answer conversationally using the aggregates above. NEVER hallucinate numbers — only use figures from the CRM data provided.

2. "analysis" — User wants a BREAKDOWN or SEGMENTATION (break down by, compare, split by, distribution, top companies, by status, how are my accounts segmented).
   Return structured segment data to render as a bar chart / leaderboard.

3. "action" — User wants to BUILD OR GENERATE A LIST (find me, give me a list, create a call list, show me all [X] to call, build a dialer).

─── RESPONSE FORMATS ───

For type "query":
{
  "type": "query",
  "answer": "Conversational 1-3 sentence answer. Cite real numbers from the aggregates. Be specific and helpful.",
  "stats": [
    { "label": "short label", "value": "number or short string" }
  ],
  "actions": [
    { "label": "Button label (e.g. 'Create a call list of Pepsi prospects')", "prompt": "The list-building prompt to run if clicked" }
  ]
}
stats: 0-4 key figures to highlight inline (e.g. total count, breakdown percentages). Empty array if not applicable.
actions: 1-3 natural follow-up actions. Suggest creating a call list from the data just discussed.

For type "analysis":
{
  "type": "analysis",
  "title": "Short title for the breakdown (e.g. 'Prospects by Company')",
  "description": "One sentence explaining what this shows",
  "segments": [
    { "label": "segment name", "count": 12, "percentage": 34.5, "prospectIds": [1,2,3] }
  ],
  "actions": [
    { "label": "Button label", "prompt": "list-building prompt for this segment" }
  ]
}
segments: sorted descending by count. Include up to 10 segments. Include prospectIds for each segment.

For type "action":
{
  "type": "action",
  "reasoningLogs": ["log 1", "log 2", "log 3"],
  "listTitle": "Short 3-5 word semantic title",
  "targetProspectIds": [1, 2, 3]
}

─── RULES ───
- Match company names, sequence names, and statuses case-insensitively.
- "VP" or "director" should match loosely (title contains, not exact match). Note: title field may not exist on all records.
- If context refers to a previous answer (e.g. "those prospects" or "same for Pepsi"), use RECENT CONVERSATION CONTEXT to resolve.
- Only include prospects that genuinely match — do not pad lists.
- For analysis, compute percentages as (count / totalProspects * 100) rounded to 1 decimal.`;

    // ── Call AI provider ────────────────────────────────────────────────────
    const outputText = await generateContent(systemInstruction);

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      // Last-resort: strip markdown fences Gemini sometimes adds
      const stripped = outputText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(stripped);
    }

    // ── Route by type ────────────────────────────────────────────────────────

    if (parsed.type === 'query') {
      return res.json({
        type: 'query',
        answer: parsed.answer || 'I found some relevant data in your CRM.',
        stats: parsed.stats || [],
        actions: parsed.actions || [],
      });
    }

    if (parsed.type === 'analysis') {
      return res.json({
        type: 'analysis',
        title: parsed.title || 'CRM Breakdown',
        description: parsed.description || '',
        segments: parsed.segments || [],
        actions: parsed.actions || [],
      });
    }

    // type === 'action' — build and return a call list
    const targetIds = parsed.targetProspectIds || [];
    const reasoningLogs = parsed.reasoningLogs || ['Generated constraints successfully'];
    const listTitle = parsed.listTitle || 'Agentic Task Pipeline';
    const filteredProspects = prospects.filter(p => targetIds.includes(p.id));

    res.json({
      type: 'action',
      reasoningLogs,
      playlist: {
        id: null,
        title: listTitle,
        items: filteredProspects,
        estimatedTime: `${Math.ceil(filteredProspects.length * 3)} mins`,
      },
    });

  } catch (error) {
    console.error('NLQ Error full:', error);
    const detail = error.message || String(error);
    res.status(500).json({ error: `AI error: ${detail}` });
  }
});

module.exports = router;
