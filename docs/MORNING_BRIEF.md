# Morning Brief

Morning Brief is the overnight account-prioritisation workflow for Apex. It
turns a target-account list into a ranked, source-backed set of sales actions.
It drafts recommendations only. It does not send email, place calls, or write
to an external system.

## Run it overnight

From the repository root:

```bash
npm run morning-brief
```

This runs the labelled demo fixture and writes:

- `artifacts/morning-brief/latest.json`
- `artifacts/morning-brief/latest.md`

To run it against supplied account targets:

```bash
node scripts/run-morning-brief.js --input path/to/targets.json --discover
```

The input can be an array or an object with a `targets` array. Each account
should include a `name` and may include `industry`, `employees`, `revenue`,
`triggerDate`, `closeDate`, `icp`, `disqualifiers`, and `signals`.

`--discover` searches bounded public Google News RSS feeds for each target.
It looks for funding, acquisitions, partnerships, launches, hiring, incidents,
expansion, earnings, and product releases. It keeps only source-linked results,
scores recency and trigger strength, and adds a suggested outreach angle.

Every signal that should count as evidence must include a `sourceUrl`:

```json
{
  "targets": [
    {
      "name": "Example Co",
      "industry": "Software",
      "employees": 1200,
      "revenue": "$500M",
      "triggerDate": "2026-09-09",
      "signals": [
        {
          "type": "trigger",
          "claim": "Example Co announced a new AI product.",
          "date": "2026-09-09",
          "sourceUrl": "https://example.com/news"
        }
      ]
    }
  ]
}
```

Claims without a source are shown as unverified and excluded from evidence
coverage and confidence.

The UI's **Search live signals** button uses the same discovery path against
the accounts already in Apex. It does not send outreach. A live run is marked
`live-discovery`, while the seeded demo remains explicitly labelled fixture
data.

## Product flow

1. Open **Morning Brief** in Apex.
2. Review the ranked account list and score breakdown.
3. Open evidence links to verify the trigger.
4. Read the suggested why-you-why-now angle.
5. Review the recommended first touch and call opener.
6. Approve or reject the action in the human-review modal.
7. Hand off to Accounts, Research, Calls, or the existing HITL flow.

The review endpoint records a decision only. It intentionally does not send
anything.

## Demo narrative

> “Droid built an overnight agent that researched my territory, ranked the
> accounts, showed me why each account moved up or down, and prepared the next
> conversation. I can approve the action, but the agent cannot send on my
> behalf.”

The demo fixture is deliberately labelled `DEMO / FIXTURE DATA` in both the
JSON and Markdown artifacts. Replace it with sourced account data before
using the workflow for real outreach.
