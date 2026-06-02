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

function buildStepSection(step) {
  return compactList([
    `Step Order: ${step.order} (delay ${step.delayDays} days)`,
    step.aiPurpose && `Intent: ${step.aiPurpose}`,
    step.aiInstructions && `Voice/Style/Constraints:\n${step.aiInstructions}`,
    step.subject && `Reference subject template: ${step.subject}`,
    step.body && `Reference body template:\n${step.body}`,
  ]);
}

function buildPrompt({ step, prospect, account, customInstructions }) {
  const sections = [
    `=== STEP BRIEF ===\n${buildStepSection(step)}`,
    `=== PROSPECT ===\n${buildProspectSection(prospect)}`,
    `=== ACCOUNT RESEARCH ===\n${buildAccountSection(account)}`,
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
  const userPrompt = buildPrompt({ step, prospect, account: acct, customInstructions });

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
