# Send tracking + server-side held-domain block

Prepared for Henry Whittle, 2026-06-18. apex-bdr half of the BDR metrics-integrity work
(companion: `METRICS_INTEGRITY_DESIGN.md`, workbook/reconcile half). Grounded in a live probe
of the connected instance on 2026-06-18.

## Evidence (live probe)
- **A — id ambiguity:** all 1,408 `sent` items reported their id as the EWS/Graph item-id
  (`AAMk…`), not the RFC 5322 internet Message-ID (`<…@…outlook.com>`). Reconcile keyed on "a row
  with an id" double-counted every send (one `AAMk…` row + one `<…@…>` row), inflating counts/steps.
- **B — held-domain leaks:** sends reached `firstsolar.com`, `appliedmaterials.com`, and its alias
  `amat.com` (6/10–6/17), because the block lived only in agent-side scripts, never server-side.

## What was implemented (this repo)

### Change A — capture + return the internet Message-ID (highest priority)
- The `OutboundQueue.internetMessageId` column already exists and is populated post-send (Sent-Items
  poll). `check_email_queue` now returns **`internetMessageId`** (RFC `<…@…>`, the dedupe key) as a
  field **distinct from `graphItemId`** (the EWS item-id) — never collapsed into one `msgId` slot.
  A sent item with no captured Message-ID returns `internetMessageId: null` explicitly (no silent
  substitution). `prisma/schema.prisma` documents the two columns.

### Change B — server-side held-domain blocklist (compliance)
- `services/enqueueBatch.js`: `DEFAULT_BLOCKED_DOMAINS` seeds the full held set
  (`amd.com, onsemi.com, wdc.com, westerndigital.com, appliedmaterials.com, amat.com,
  firstsolar.com`); extend at runtime via `BLOCKED_SEND_DOMAINS` (comma-separated, no code edit).
- `domainIsBlocked()` matches the **registrable domain** so subdomains (`mail.amat.com`) and listed
  aliases (`amat.com` == `appliedmaterials.com`) are all caught; case + trailing dot normalized.
- EVERY send path checks it BEFORE queue/send — `enqueue_batch`/`enqueue_email` (via `validateItem`),
  `send_email`, and immediate `reply_to_email`. A blocked recipient is rejected with reason
  `BLOCKED_DOMAIN` (422 / per-item `rejected`), never queued, never sent, and **logged** so the
  workbook can raise a Review Queue row. Independent of any agent gate call.

### Change C — `clientRef` round-trips onto the sent record
- New durable `OutboundQueue.clientRef` column (indexed). Persisted at enqueue (both paths) and
  returned on **every** `check_email_queue` item (queued→sent), enabling a
  `(clientRef, internetMessageId)` join with no fuzzy matching. Survives restart (DB-backed).

### Change D — opaque `meta` passthrough (step / lane / any dimension)
- New `OutboundQueue.meta` column. Accepts an opaque JSON object per item at enqueue, stored and
  returned **verbatim** (e.g. `{"step":2,"lane":1,"rep":"Sai Konda"}`). The connector never inspects
  or validates it — covers step + lane + future dimensions without further schema changes.

## Not changed
Pacing, daily/weekly caps, send window, dedup scope, the Send-Health gate — all left intact.

## Acceptance
- Fresh batch: every sent item carries a non-null `internetMessageId` (`<…@…>`) distinct from
  `graphItemId`; reconcile keyed on `internetMessageId` yields one row per physical send.
- Enqueuing `x@amat.com`, `y@appliedmaterials.com`, `z@mail.firstsolar.com` rejects all three with
  `BLOCKED_DOMAIN`, queues none — with no gate call. Removing a domain from config re-enables it.
- `check_email_queue(batchId=…)` returns each item's `clientRef` and verbatim `meta`.

Tests: `tests/enqueueBatch.test.js` (alias/subdomain block, `BLOCKED_DOMAIN`, probe leak set).
