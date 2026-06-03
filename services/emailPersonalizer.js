/**
 * Email personalizer — Track B.
 *
 * Generates a personalized email draft using:
 *   - The SequenceStep's intent (aiPurpose) + voice/style guide (aiInstructions)
 *   - The template (subject/body) as a starting reference
 *   - The Account's research (useCases, stakeholders, warmIntroPaths, weeklyFocus,
 *     notes, myNotes, industry, priorityTier, etc.)
 *   - The Prospect's details (title, notes, techStack)
 *
 * Returns { subject, body, prompt, reasoning, model, provider }.
 * The full prompt is returned so HITL can display & re-edit it for regeneration.
 */
const { generate } = require('./aiProvider');
const prisma = require('./database');

const HISTORY_EMAIL_LIMIT = 8;   // most recent N outbound emails to include
const HISTORY_REPLY_LIMIT = 5;   // most recent N inbound replies to include
const HISTORY_BODY_CAP    = 600; // chars per body snippet — keeps prompt size bounded

const SYSTEM_PROMPT = `You are an expert B2B sales BDR personalizing existing outbound email
templates. Your job is to adapt a template's opening hook to a specific
prospect — NOT to rewrite the message from scratch.

Write in a natural, conversational, peer-to-peer tone. Never use phrases
like "I hope this email finds you well", "quick question", or "circling
back". Length should match the template — do not summarize or shorten the
pitch.

Output strict JSON: { "subject": string, "body": string, "reasoning": string }
  - "subject" must be under 60 chars
  - "body" should be plain text with \\n for line breaks; preserve any
    bullet lists from the template using "- " prefixes
  - "reasoning" is 1-2 sentences explaining what context you leveraged
    and which parts of the template you kept verbatim`;

function compactList(items) {
  return items.filter(Boolean).join('\n');
}

function buildAccountSection(account) {
  if (!account) return '(no linked account)';
  return compactList([
    `Company: ${account.name}`,
    account.industry && `Industry: ${account.industry}${account.subIndustry ? ` / ${account.subIndustry}` : ''}`,
    account.revenue && `Revenue: ${account.revenue}`,
    account.priorityTier && `Tier: ${account.priorityTier}`,
    account.dealMotion && `Deal Motion: ${account.dealMotion}`,
    account.useCases && `Top Use Cases: ${account.useCases}`,
    account.primaryStakeholder && `Primary Stakeholder: ${account.primaryStakeholder}`,
    account.backupStakeholders && `Backup Stakeholders: ${account.backupStakeholders}`,
    account.warmIntroPaths && `Warm Intro Paths: ${account.warmIntroPaths}`,
    account.weeklyFocus && `Q1 Focus: ${account.weeklyFocus}`,
    account.description && `Description: ${account.description}`,
    account.researchSummary && `Account Research (authoritative):\n${account.researchSummary}`,
    account.notes && `Notes: ${account.notes}`,
    account.myNotes && `My Notes: ${account.myNotes}`,
    account.techStack && `Tech Stack: ${account.techStack}`,
  ]);
}

function buildProspectSection(prospect) {
  return compactList([
    `Name: ${prospect.firstName} ${prospect.lastName}`,
    prospect.title && `Title: ${prospect.title}`,
    prospect.companyName && `Company (denormalized): ${prospect.companyName}`,
    prospect.techStack && `Tech Stack: ${prospect.techStack}`,
    prospect.researchBrief && `Prospect Research Brief (authoritative):\n${prospect.researchBrief}`,
    prospect.notes && `Notes: ${prospect.notes}`,
  ]);
}

/**
 * Pull the prospect's outbound + inbound conversation history so the LLM
 * can avoid repeating prior content and reference past touchpoints
 * naturally. Capped to keep prompt size reasonable.
 */
async function fetchProspectHistory(prospectId) {
  if (!prospectId) return { emails: [], replies: [] };
  const [emails, replies] = await Promise.all([
    prisma.emailActivity.findMany({
      where: {
        prospectId,
        status: { in: ['sent', 'opened'] },
      },
      orderBy: { sentAt: 'desc' },
      take: HISTORY_EMAIL_LIMIT,
      select: {
        id: true,
        subject: true,
        sentAt: true,
        status: true,
        openedAt: true,
        draftBody: true, // populated for AI-personalized sends
        sequenceStep: { select: { order: true } },
      },
    }).catch(() => []),
    prisma.replyActivity.findMany({
      where: { prospectId },
      orderBy: { receivedAt: 'desc' },
      take: HISTORY_REPLY_LIMIT,
      select: {
        id: true,
        subject: true,
        bodySnippet: true,
        classification: true,
        receivedAt: true,
      },
    }).catch(() => []),
  ]);
  return { emails, replies };
}

function buildHistorySection({ emails, replies }) {
  if ((!emails || emails.length === 0) && (!replies || replies.length === 0)) {
    return '(no prior outreach to this prospect — this is a fresh contact)';
  }
  const lines = [];
  if (emails && emails.length > 0) {
    lines.push('Past outbound emails to this prospect (most recent first):');
    for (const e of emails) {
      const when = e.sentAt ? new Date(e.sentAt).toISOString().slice(0, 10) : 'unsent';
      const opened = e.status === 'opened' || e.openedAt ? ' [OPENED]' : '';
      const stepLabel = e.sequenceStep?.order ? ` (step ${e.sequenceStep.order})` : '';
      lines.push(`- ${when}${opened}${stepLabel} — Subject: "${e.subject || '(no subject)'}"`);
      if (e.draftBody) {
        const snippet = e.draftBody.slice(0, HISTORY_BODY_CAP);
        const ellipsis = e.draftBody.length > HISTORY_BODY_CAP ? '…' : '';
        lines.push(`  Body excerpt: ${snippet.replace(/\n+/g, ' ')}${ellipsis}`);
      }
    }
  }
  if (replies && replies.length > 0) {
    lines.push('');
    lines.push('Replies received from this prospect (most recent first):');
    for (const r of replies) {
      const when = r.receivedAt ? new Date(r.receivedAt).toISOString().slice(0, 10) : '?';
      const cls  = r.classification ? ` [${r.classification}]` : '';
      lines.push(`- ${when}${cls} — Subject: "${r.subject || '(no subject)'}"`);
      if (r.bodySnippet) lines.push(`  Excerpt: ${r.bodySnippet.slice(0, HISTORY_BODY_CAP).replace(/\n+/g, ' ')}`);
    }
  }
  return lines.join('\n');
}

function buildStepSection(step) {
  return compactList([
    `Step Order: ${step.order} (delay ${step.delayDays} days)`,
    step.replyToPrevious && `THREAD CONTINUATION: This step sends as a reply in the existing email thread (same Outlook conversation as the prior sent email).`,
    step.aiPurpose && `Intent: ${step.aiPurpose}`,
    step.aiInstructions && `Voice/Style/Constraints:\n${step.aiInstructions}`,
    step.subject && `Reference subject template: ${step.subject}`,
    step.body && `Reference body template:\n${step.body}`,
  ]);
}

function buildPrompt({ step, prospect, account, customInstructions, history }) {
  const sections = [
    `=== STEP BRIEF ===\n${buildStepSection(step)}`,
    `=== PROSPECT ===\n${buildProspectSection(prospect)}`,
    `=== ACCOUNT RESEARCH ===\n${buildAccountSection(account)}`,
    `=== PRIOR OUTREACH (avoid repeating these openers/insights; reference naturally if relevant) ===\n${buildHistorySection(history || { emails: [], replies: [] })}`,
  ];
  if (customInstructions && customInstructions.trim()) {
    sections.push(`=== ADDITIONAL INSTRUCTIONS (override) ===\n${customInstructions}`);
  }
  sections.push(
    `=== TASK ===
Your job is to personalize an existing email by adapting the opener so it
speaks directly to this prospect. You are NOT writing a fresh email; the
reference body template above is the authoritative pitch that must reach
the prospect.

PRESERVE from the reference body template (verbatim or near-verbatim):
- Product / solution / brand names (e.g. specific product names like
  "C3 AI Reliability")
- Named customers, case studies, or proof points (e.g. "Holcim,
  ExxonMobil, Shell")
- Specific benefits, metrics, or value props as listed
- Bullet lists and their structure
- The call to action exactly as written
- Sender sign-off and signature tokens like {{sender.name}}
  (any {{...}} token in the template is a merge field resolved at send
  time — keep them exactly as-is, do not replace with invented names)
- Any URLs and links present in the template — keep them verbatim
  whether they are bare https://... URLs or markdown [text](url) form.
  If you add a new link of your own (e.g. a calendar booking URL or a
  case study), write it in markdown form: [short label](https://...).

PERSONALIZE:
- The opener: replace the template's first 1-2 sentences with a hook
  grounded in one concrete detail from the Prospect Research Brief or
  Account Research (a recent move, a stated priority, a public quote, a
  named stakeholder, a warm-intro path). This is the only place you get
  to be creative.
- One bridge sentence connecting the prospect's situation to the
  product pitch. Inserts between your personalized opener and the
  template's product description.
- The greeting: use the prospect's first name. Replace any {{first_name}}
  or {{firstName}} token.
- The subject line: write a fresh subject that's concrete to this
  prospect but consistent with the pitch and CTA being delivered.

DO NOT:
- Swap or paraphrase the product being pitched
- Drop or invent customer name-drops / proof points
- Invent benefits or metrics not in the template
- Change or soften the call to action
- Summarize the pitch to make it shorter
- Replace the product positioning with something the research suggests
  might be a "better fit" — that's a strategy decision, not your call

If both research blocks are empty, write a generic opener based on the
prospect's title + company, keep everything else from the template
verbatim, and note this in the reasoning field.

REPLY STEPS (when "THREAD CONTINUATION" is noted in the step brief):
- Write this as a short follow-up note to the prior email in the
  thread, NOT a fresh standalone pitch. Skip the full product pitch
  re-state; the prior email in the thread already delivered it.
- 40-100 words total. One short paragraph or two at most.
- Start with a brief contextual nudge ("Following up on this — ",
  "Wanted to circle back on the note below — ", etc.) that
  references the thread implicitly. No greeting like "Hi {{first_name}}",
  because this is a reply in an open thread.
- Add one piece of new value: a relevant case study, a specific
  question, a fresh data point, or a calendar link / time options.
- Subject line is ignored at send time (Outlook auto-prefixes "Re: "
  on the original subject). Still output a value (the template
  subject works); it just won't be used for the actual send.

USE THE PRIOR OUTREACH SECTION:
- Do NOT reuse the opener angle or hook from any previous email in
  the list. If the last email led with "Noticed you just shipped X",
  pick a different angle (a different priority, a different signal).
- If a reply was received, reference it briefly and naturally (e.g.
  "appreciated your note on X" or "following up on what you said
  about Y"). Never re-pitch as if no reply happened.
- For follow-up steps (step order > 1), acknowledge that this is a
  continuation, not a first-touch — adjust the opener accordingly.

Output JSON only.`
  );
  return sections.join('\n\n');
}

function parseModelOutput(text) {
  // The model may wrap JSON in ```json ... ``` — strip if present
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    // Last-resort: try to extract the first JSON object substring
    const match = s.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    throw new Error(`Model output was not valid JSON: ${e.message}\n---\n${s.slice(0, 300)}`);
  }
}

/**
 * Generate an email draft.
 *
 * @param {Object} params
 * @param {Object} params.step       - SequenceStep with aiPurpose/aiInstructions/aiModel
 * @param {Object} params.prospect   - Prospect record (with optional account expanded)
 * @param {Object} [params.account]  - Account record. If absent, falls back to prospect.account.
 * @param {string} [params.customInstructions] - HITL-time override (regeneration prompt edits)
 * @returns {Promise<{subject, body, prompt, reasoning, model, provider}>}
 */
async function personalize({ step, prospect, account, customInstructions }) {
  const acct = account || prospect.account || null;
  const history = await fetchProspectHistory(prospect?.id);
  const userPrompt = buildPrompt({ step, prospect, account: acct, customInstructions, history });

  const result = await generate({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    mode: 'thorough',
    model: step.aiModel || undefined,
    json: true,
  });

  const parsed = parseModelOutput(result.text);
  if (!parsed.subject || !parsed.body) {
    throw new Error(`Model output missing subject or body: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return {
    subject: parsed.subject,
    body: parsed.body,
    reasoning: parsed.reasoning || result.reasoning || '',
    prompt: userPrompt,
    model: result.model,
    provider: result.provider,
  };
}

module.exports = { personalize, buildPrompt, SYSTEM_PROMPT };
