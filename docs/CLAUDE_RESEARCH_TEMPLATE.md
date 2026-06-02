# Pre-researching Prospects in Claude Enterprise

If you have Claude Enterprise (no API access required), you can have it do
deep web research on a list of prospects, output a CSV in apex-bdr's
expected shape, and upload that file via the **Research → Prospect briefs**
tab. The system will detect the brief column and skip its own LLM /
LinkedIn-scrape step — your Claude-generated briefs land directly on each
Prospect record, ready to feed AI-personalized sequence emails.

## The prompt

Paste this into a Claude chat, replace the prospect list at the bottom,
and let Claude take its time. Output is a single CSV block you can copy
into a `.csv` file (or save Claude's response as a file).

```
You are an SDR research analyst. I will give you a list of prospects. For
each one, use your web research tools to investigate the prospect and the
company they work at, then produce a row of CSV output.

For each prospect, research:

1. The company: industry, size, recent news, funding stage, strategic
   priorities, public statements about technology investments, current
   pain points or initiatives that map to AI / data / sales-tech, key
   executives, any recent reorgs or budget signals.

2. The prospect: their role and likely scope, their tenure at the company,
   prior companies (especially if there are shared backgrounds with C3 AI
   investors / customers / employees that could be a warm-intro angle),
   recent LinkedIn or press activity, and what their role's priorities
   typically look like at a company of this size and industry.

3. Anything that makes outreach feel non-generic: a specific use case the
   company would care about, a public quote from the prospect or a peer,
   a recent product launch or hire that's relevant.

Then output a single CSV block with EXACTLY these column headers — no
extra columns, no commentary above or below the CSV, no markdown table:

First Name,Last Name,Email,Company Name,Job Title,LinkedIn URL,Country,Person State,Research Brief,Account Research

Rules for the CSV:
- "Research Brief" must be a 3–5 sentence natural-language paragraph
  about THIS specific prospect. No bullets. No preamble. No quotes
  unless they're part of the prose. Anchor in one concrete detail you
  found in research — a recent move, a stated priority, a peer quote —
  so the brief could not be sent to anyone else.
- "Account Research" must be a 4–8 sentence paragraph about the company.
  This will be reused across every prospect at the same company, so
  write company-level context, not prospect-specific stuff.
- If a column would be empty, leave the cell blank — do not write "N/A"
  or "unknown".
- Properly escape commas and double quotes inside cells using CSV
  conventions (wrap in double quotes; escape internal quotes by doubling).
- One row per prospect. Do not skip prospects. If you cannot find
  research for one, still emit the row with the basic fields and an
  empty Research Brief / Account Research.

Take your time. Quality matters more than speed.

PROSPECT LIST:
<paste your prospect list here — one per line, ideally with name +
 company + email + title + LinkedIn URL if you have them>
```

## What apex-bdr does with the upload

When you upload the CSV through **Research → Prospect briefs**:

- **Prospects** are upserted by email. Existing rows get their
  `researchBrief` updated; new rows are created.
- **Accounts** matching `Company Name` get the `Account Research` block
  appended under a date header (preserving any prior research). Accounts
  that don't exist yet are created.
- **No Apify call, no internal LLM call** happens for rows where
  `Research Brief` is populated — the Claude brief is saved as-is.
- Sequence steps with **AI-personalize on** will then use both your
  Claude-generated prospect brief and the appended account research as
  authoritative context when drafting outbound emails.

## Tips for getting the most out of Claude Enterprise

- **Batch in groups of ~20**: Claude does better research with smaller
  batches because it can spend more web-search budget per prospect.
- **Include LinkedIn URLs** in the input list when you have them — Claude
  can pull richer signal from a direct profile reference.
- **Ask Claude for the CSV in one block at the end** rather than streaming
  it interleaved with research notes; easier to copy/paste cleanly.
- If the CSV looks malformed, ask Claude to "re-output only the CSV, no
  commentary, with proper escaping for commas inside cells."
