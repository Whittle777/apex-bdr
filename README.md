# Apex — SDR/BDR Sales Enablement Platform

A full-stack, AI-powered sales engagement platform featuring an **Agentic Command Center UI** — natural language → task execution in one interface.

---

## Quick Start

### 1. Backend

```bash
# Install dependencies
npm install

# Configure environment (copy and fill in)
cp .env.example .env   # set DATABASE_URL, GEMINI_API_KEY, JWT_SECRET at minimum

# Run database migrations
npx prisma migrate dev --name init

# Start the API server (port 3000) + WebSocket server (port 8080)
npm run dev
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev    # Vite dev server at http://localhost:5173
```

### Minimum Required Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT token signing secret |
| `GEMINI_API_KEY` | Google Gemini API key — powers the NLQ Command Center |
| `PORT` | API port (default: `3000`) |

Optional (activate corresponding features):
- `SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS` — email sending
- `AZURE_SERVICE_BUS_*` — Azure Service Bus queueing
- `AWS_SQS_*` — AWS SQS integration
- `REDIS_HOST / REDIS_PORT` — Redis rate limiting
- `TTS_PROVIDER_API_KEY` — ElevenLabs / Azure Speech TTS
- `DEMO_MODE=true` — exposes a "Demo Sign In" button on the login page that mints a JWT for a synthetic demo user. Lets reviewers (e.g. IT) walk through the app without Microsoft SSO. **Disable in production once your tenant admin has granted consent.**

---

## UI Navigation Guide

The frontend is a single-page React app served at `http://localhost:5173`. The sidebar has three sections: **Core**, **Intelligence**, and **Settings**.

---

### Layer 1 — Command Center (`/`)

**The Agentic Chat Interface.** This is the primary entry point for all workflows.

**How to use:**
1. Type a natural language prompt in the chat input at the bottom, e.g.:
   - `"Find VP of Marketing prospects using HubSpot"`
   - `"Show me uncontacted leads in the US with a tech company"`
   - `"Build a call list of C-suite prospects at Series B companies"`
2. The **Gemini NLQ Orchestrator** processes the prompt, shows a real-time reasoning log (chain-of-thought steps), and returns a filtered **Playlist** of matching prospects.
3. Two actions from the result card:
   - **Execute Operations** → navigates directly to `/dialer` with the generated playlist pre-loaded.
   - **Save Playlist** → saves the list to the sidebar for later use.
4. **Saved Lists** appear in the left sidebar of the Command Center. Click any list to enter **List Editor Mode** — you can rename it, edit the description, and remove individual prospects.
5. Click **Enrich Database** (top of chat) to run a simulated ZoomInfo-style enrichment pass that fills in missing tech stack and title fields.

**Layer 1 → Layer 3 Progression:**
```
Type prompt → AI reasons → Playlist generated → Click "Execute Operations" → Power Dialer (Layer 3)
```

---

### Layer 3 — Power Dialer (`/dialer`)

**The Task Execution Engine.** A 3-pane split layout for working through a call playlist.

**Panes:**
- **Left Rail (Queue):** Full ordered list of prospects. Completed calls are faded with a ✓. The active prospect is highlighted in indigo.
- **Center Pane (Context & Script):** Shows the prospect's name, company, email, and a dynamically generated AI Info Brief + call script.
- **Right Pane (Call Controls):** Dial button, call status indicator, and disposition logging.

**Workflow:**
1. Arrive here from the Command Center (playlist auto-loaded) or directly (falls back to all prospects).
2. Click **Dial** to initiate a simulated MS Teams PSTN call via the backend WebSocket.
3. The status transitions: `IDLE → DIALING → CONNECTED` — driven by the backend via WebSocket push.
4. When a call connects, a timer starts. Click **Hang Up** to enter wrap-up.
5. Select a disposition (Connected, Voicemail, No Answer, Callback) to log the outcome.
6. **Auto-Advance:** The queue automatically moves to the next prospect. Toggle **Auto-Dial** to continuously dial without manual triggers.
7. When all prospects are processed: "Playlist Complete" screen is shown.

---

### Sequences (`/sequence-manager`)

**Email sequence builder with step-by-step template editor.**

**Left Pane:** List of all sequences. Click **+ New Sequence** to create one. Click any sequence name to select it.

**Right Pane (Tabs):**
- **Steps tab:** View, add, edit, and reorder email steps. Each step has: Order, Delay Days (send after X days), Subject Template, Body Template. Use `{{firstName}}`, `{{company}}` merge tags.
- **Prospects tab:** Shows prospects currently enrolled in this sequence.

**Adding a step:** Click **+ Add Step** → fill in the form → Save. Steps are auto-ordered.

---

### Prospects (`/prospects`)

**Full CRM contact manager with bulk operations.**

**Features:**
- **Search:** Filter prospects in real-time by name, email, or company.
- **Add Prospect:** Fill in the form at the top and click Add.
- **Bulk CSV Upload:** Click **Import CSV** and select a ZoomInfo or custom export. Column mapping is automatic (First Name, Last Name, Email Address, Company Name, Job Title, Technologies, Country, State).
- **Select & Bulk Actions:** Check individual rows or "select all" to bulk Delete, Opt Out, or Assign to a sequence.
- **Prospect Detail Drawer:** Click any row to open a slide-in drawer showing all fields, enrichment status, and an inline edit form.

---

### Analytics (`/analytics`)

**Sales performance dashboard and pipeline forecasting.**

**Sections:**
- **KPI Cards (top row):** Emails Sent, Calls Made, Reply Rate, Meetings Booked — with week-over-week trend indicators.
- **Pipeline Movement:** Stage-by-stage deal progression with WoW change deltas.
- **Engagement Rates:** Open/click/reply/bounce/unsubscribe rates with visual bars. AI Sentiment Distribution breakdown.
- **Rep Leaderboard:** Ranked by quota attainment with progress bars.
- **Q2 Forecasting:** AI-projected end-of-quarter revenue, pipeline coverage ratio, avg deal size, win rate.

**Period toggle:** Switch between Week / Month / Quarter views at top right.

---

### Review Queue — HITL (`/hitl`)

**Human-in-the-Loop oversight interface.** Every AI action below 85% confidence is routed here before execution.

**Three-pane layout:**

**Left Rail (Review Queue):**
- Shows all pending AI-generated actions (email drafts, call scripts).
- Each item shows: prospect name, company, action type, urgency, pipeline value, and a **confidence score bar** (Green >85%, Yellow 70-84%, Red <70%).
- Filter tabs: **All / Escalate (🔴) / Review (🟡) / Auto (🟢)**.

**Center Pane (Contextual Record):**
- Full prospect intelligence: avatar, title, pipeline value.
- **Omnichannel Context:** Web visits, calls made, last email reply.
- **Tech Stack chips:** Detected tools.
- **AI Reasoning Chain:** Step-by-step monospace log showing exactly how the agent arrived at this draft.

**Right Pane (Agentic Action Panel):**
- Confidence score bar at the top.
- **AI Summary** card.
- **Draft Content** — the exact email or call script the AI wrote.
- **✎ Inline Edit** toggle — converts the draft to an editable textarea.
- Action buttons:
  - **✓ Accept & Execute** — approves and queues the action.
  - **✎ Accept Edited Version** — (visible when editing) approves your modified version.
  - **✗ Reject** — blocks the action.
  - **↑ Escalate** — raises priority and flags for supervisor.

**Action Log:** At the bottom of the left rail, a running log of all completed decisions in this session.

---

### Voice Fleet Command (`/voice-fleet`)

**Real-time dashboard for monitoring simultaneous autonomous AI calls.**

**Left Pane (Fleet Overview):**
- Live count of connected calls and flagged calls.
- List of all active agent calls with: prospect name, company, live timer or status badge, real-time sentiment bar.
- Flag indicators (⚑ OBJECTION_DETECTED, etc.) shown inline.
- **+ Launch New Call Batch** button to enqueue a new dial session.

**Center Pane (Live Transcript):**
- Scrolling real-time transcript of the selected call.
- Messages are colour-coded: AI Agent (dark bubble, left), Prospect (indigo bubble, right), System (italic dashed, left).
- Typing indicator shows when the AI is processing a response.
- **Bridge Human Agent** button appears on connected calls — routes the live call to a sales rep's Teams client.
- **End Call** terminates the call immediately.

**Right Pane (Sentiment Analysis):**
- **Live Sentiment Score** gauge (0–100) with colour: Green (Positive), Yellow (Objection), Blue (Neutral), Red (Resistance).
- **Signal Breakdown:** Buying Interest / Resistance Level / Engagement Depth bars.
- **Flag Controls:** If an objection/resistance flag is active, shows advisory and Bridge / Dismiss buttons.
- **AMD Status:** Whether the call connected to a live human or was detected as an answering machine.

---

### Deliverability Gate (`/deliverability`)

**Pre-launch health check dashboard for email campaigns.**

**Sections:**
- **Data Quality Verification:** Stacked progress bar showing % verified vs. suppressed vs. flagged (honeypot/invalid) contacts.
- **Dynamic Send Limits:** Speedometer-style gauge showing today's send volume vs. the Gmail/org daily cap. Live-updating every 4 seconds.
- **Domain Health Monitoring:** Traffic-light indicators (Green/Yellow/Red) for SPF, DKIM (2048-bit), and DMARC records. Advisory shown if DMARC is still at `p=none`.
- **AI Email Warmup Status:** Outbound vs. warmup interaction ratio with health classification.
- **Reputation Monitoring:** Abuse complaint rate and bounce rate vs. thresholds. Checklist of compliance features (RFC 8058 unsubscribe, NDR parsing, etc.).

The **Safe to Send** badge (top right) turns red if any critical threshold is breached.

---

### Integrations (`/integrations`)

**Connect email and telephony providers.**

**Google Workspace:** Enter your OAuth2 Client ID, Client Secret, and Refresh Token. The backend performs a live token validation against Google's OAuth server before saving.

**Microsoft 365:** Same form — validated against Microsoft's token endpoint. Required Graph API scopes for Power Dialer: `Calls.InitiateGroupCall.All`, `Calls.AccessMedia.All`, `offline_access`.

Connected providers show a green **Connected** badge. Click **Disconnect** to revoke.

---

## Backend API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/login` | Authenticate user, receive JWT |
| `POST` | `/auth/register` | Create new user account |
| `GET` | `/prospects` | List all prospects |
| `POST` | `/prospects` | Create prospect |
| `PUT` | `/prospects/:id` | Update prospect |
| `DELETE` | `/prospects/:id` | Delete prospect |
| `POST` | `/prospects/bulk` | Bulk upload prospects (CSV import) |
| `POST` | `/prospects/enrich` | Simulate ZoomInfo enrichment pass |
| `GET` | `/sequences` | List all sequences |
| `POST` | `/sequences` | Create sequence |
| `GET` | `/sequenceSteps` | List all sequence steps |
| `POST` | `/sequenceSteps` | Create step |
| `PUT` | `/sequenceSteps/:id` | Update step |
| `DELETE` | `/sequenceSteps/:id` | Delete step |
| `POST` | `/orchestration/nlq` | Natural language query → filtered prospect playlist |
| `GET` | `/lists` | Get all saved agentic lists |
| `GET` | `/lists/:id` | Get list with full prospects |
| `PUT` | `/lists/:id` | Rename/update list metadata |
| `DELETE` | `/lists/:id/prospects/:pid` | Remove prospect from list |
| `POST` | `/voice/dial/:prospectId` | Initiate PSTN call via MS Teams |
| `GET` | `/hitl/queue` | Get pending HITL review items |
| `POST` | `/hitl/queue` | Add item to review queue |
| `POST` | `/hitl/queue/:id/accept` | Accept AI draft |
| `POST` | `/hitl/queue/:id/reject` | Reject AI action |
| `POST` | `/hitl/queue/:id/edit` | Accept edited version |
| `POST` | `/hitl/queue/:id/escalate` | Escalate to supervisor |
| `GET` | `/hitl/stats` | Review queue summary stats |
| `GET` | `/integrations` | List connected provider credentials |
| `POST` | `/integrations` | Save/update provider credentials |
| `DELETE` | `/integrations/:provider` | Disconnect provider |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              React Frontend (Vite)                  │
│  Dashboard → NLQ → Playlist → Power Dialer          │
│  HITL Review ← Confidence Routing ← AI Engine       │
│  Voice Fleet ← WebSocket ← MS Teams / ACS API       │
└──────────────────┬──────────────────────────────────┘
                   │ REST + WebSocket
┌──────────────────▼──────────────────────────────────┐
│           Express.js API (Node.js)                  │
│  /auth  /prospects  /sequences  /orchestration      │
│  /voice  /hitl  /lists  /integrations               │
└──────────────────┬──────────────────────────────────┘
                   │ Prisma ORM
┌──────────────────▼──────────────────────────────────┐
│              PostgreSQL Database                    │
│  Users · Prospects · Sequences · SequenceSteps      │
│  EmailActivities · VoiceAgentCalls · ProspectLists  │
│  TrackingPixelEvents · TimeBlockConfig              │
└─────────────────────────────────────────────────────┘
```

**Message Queues:** AWS SQS / Azure Service Bus / RabbitMQ for async call dispatch
**AI Engine:** Google Gemini 2.5 Flash for NLQ and agentic reasoning
**Telephony:** Microsoft Azure ACS Call Automation + Graph API for Teams PSTN calls
**TTS:** ElevenLabs / Azure AI Speech for voicemail generation
**Rate Limiting:** Redis with atomic Lua scripts (Token Bucket / Sliding Window)

---

## Testing

```bash
# Backend unit and integration tests
npm test

# Run specific test file
npx jest tests/rateLimitingService.test.js
```

Test files live in `tests/` and cover: rate limiting, tracking pixel logging, message broker, MCP gateway, open rate analysis, and migration utilities.

---

## Key File Locations

| Area | Files |
|---|---|
| Frontend entry | `frontend/src/main.jsx` |
| App routing | `frontend/src/App.jsx` |
| Design system | `frontend/src/styles.css` |
| Command Center | `frontend/src/components/Dashboard.jsx` |
| Power Dialer | `frontend/src/components/PowerDialerView.jsx` |
| HITL Review | `frontend/src/components/HITLReviewView.jsx` |
| Voice Fleet | `frontend/src/components/VoiceFleetCommand.jsx` |
| Analytics | `frontend/src/components/AnalyticsDashboard.jsx` |
| Deliverability | `frontend/src/components/DeliverabilityGate.jsx` |
| Backend entry | `index.js` |
| NLQ Orchestration | `routes/orchestration.js` |
| HITL API | `routes/hitl.js` |
| Voice/Dialer API | `routes/voice.js` |
| DB Schema | `prisma/schema.prisma` |
