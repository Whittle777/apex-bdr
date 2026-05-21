# Apex BDR — Microsoft Integration Approval Request

**Submitted by:** Henry Whittle (henry.whittle@c3.ai)
**App:** Apex BDR (internal SDR/BDR tool)
**Azure App Registration:** `apex-bdr` · App ID `4a2c47db-d36e-4a99-8102-a617a3d9ffe0`
**Sign-in audience:** AzureADMyOrg (single-tenant — C3.ai only, enforced at the Azure AD level)
**Deployment:** https://apex-bdr-production.up.railway.app
**Audience:** ~5–10 C3.ai BDR reps. Not customer-facing. Not public.

---

## TL;DR — What I'm asking for

**One click from a Global Admin.** Grant admin consent for the app's permissions in Entra. After that, BDR reps sign in with their C3.ai Microsoft accounts and the app sends sequence emails from each rep's own Outlook mailbox.

**One-click admin-consent URL:**
```
https://login.microsoftonline.com/53ad779a-93e7-485c-ba20-ac8290d7252b/adminconsent
  ?client_id=4a2c47db-d36e-4a99-8102-a617a3d9ffe0
  &redirect_uri=https://apex-bdr-production.up.railway.app/auth/microsoft/callback
```

**Or via portal:** Entra ID → Enterprise Applications → search `apex-bdr` → Permissions → **Grant admin consent for C3.ai**.

That's it for the pilot. No PowerShell, no Teams admin changes required at this stage.

### Two-phase rollout (so this ask stays small)

| Phase | What it enables | What IT does |
|---|---|---|
| **Phase 1 — now (this ask)** | Email sending + reply detection from each rep's Outlook mailbox. | One-click admin consent above. |
| **Phase 2 — later, separate ask** | Outbound calling from each rep's Teams Phone number. | A short Teams PowerShell setup (Application Access Policy) — only when we're ready to enable calling. |

The calling permissions (`Calls.Initiate.All`, `Calls.AccessMedia.All`) are included in the consent screen now so IT isn't asked to redo this flow later — but they remain **inert until Phase 2's Teams setup is performed**. With no Application Access Policy in place, any call attempt is rejected by Teams itself with *"application not authorized to access this resource."* They're listed but cannot be exercised.

---

## What Apex BDR does (in one paragraph)

A BDR-only outreach tool. Reps sign in with their C3.ai Microsoft accounts. The app organizes their target accounts, drafts personalized emails using an AI model, **routes every AI-generated draft to a human review queue before sending**, then sends the approved email from the rep's own Outlook mailbox. *(A future phase will add outbound calling through each rep's own Teams Phone number — that's a separate, smaller ask in Phase 2 and is not exercised in this pilot.)* Nothing is exposed to customers, prospects, or the public.

**Out of scope for this pilot (no integration requested):** Microsoft Dynamics / Dataverse / any CRM system, SharePoint, OneDrive, Teams chat, calendar, contacts, files. Prospect and account data is entered directly in Apex; no CRM read or write occurs.

---

## Email reputation & deliverability protections (the part most relevant to IT)

C3.ai's `@c3.ai` sender reputation is protected by multiple layers:

| Protection | How it works |
|---|---|
| **No bulk blasts.** Every email is one-to-one, sent from the rep's individual Outlook mailbox via Graph `Mail.Send`. | No shared sender. No third-party SMTP relay. No bypass of normal C3.ai outbound mail filters. |
| **Human-in-the-loop on every AI draft.** | When a rep enables AI personalization on a step, the AI generates a draft but **does not send it**. The draft lands in a review queue. The rep reads, edits, and approves before the email actually goes out. **No "AI slop" can leave the tenant unreviewed.** Code: `routes/emailActivities.js` (POST `/:id/approve`). |
| **Hard daily cap per deployment** (`MAX_EMAILS_PER_DAY=200`, configurable). | Once today's count is reached, the mailer stops. No way to override. |
| **Per-send throttle** (`EMAIL_SEND_DELAY_MS=2000`, configurable). | Two-second gap between sends — well under Microsoft's per-mailbox sending throttle. |
| **Hard-bounce auto-pause.** | SMTP 550–554 / "user not found" / "mailbox unavailable" → enrollment paused immediately, prospect flagged as `Bounced`. Code: `services/sequenceMailer.js → isHardBounce()`. |
| **Repeat-failure auto-pause.** | 3 failed sends to the same enrollment in 7 days → paused. |
| **RFC 8058 one-click unsubscribe headers** on every send. | `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` — required by Gmail/Yahoo bulk-sender rules. Implemented in both Graph and SMTP send paths. |
| **Reply detection auto-pauses sequences.** | Every 10 min the app polls each rep's Inbox (via `Mail.Read`) for replies to its own sent emails (matched by `In-Reply-To` Message-ID). On reply, the enrollment stops. Out-of-office replies pause-and-resume; genuine replies stop the sequence. |
| **Tracking pixel — first-party only.** | Open-tracking pixel served from `apex-bdr-production.up.railway.app`, not a third-party tracker. No pixel data shared externally. |
| **Tenant-restricted at the Entra level.** | App registration `signInAudience = AzureADMyOrg`. Tokens cannot be issued to identities outside C3.ai. |

---

## Permissions requested

### Delegated — act as the signed-in rep only

| Permission | What it does | Why it's needed |
|---|---|---|
| `openid` | Identify the user at sign-in | Required for SSO |
| `offline_access` | Refresh the rep's access token over time | Lets sequences keep running without re-prompting the rep every hour |
| `User.Read` | Read the rep's name, email, and AAD object ID | Provisions the rep's local account on first login; the object ID is required for the Calls API |
| `Mail.Send` | Send email from the rep's mailbox | Sequence emails go from the rep's own address (e.g. `henry.whittle@c3.ai`), not a shared inbox |
| `Mail.Read` | Read the rep's mailbox | Detect replies to sequence emails so we can auto-pause sequences when prospects respond |

**Honest note on `Mail.Read`:** the reply-detection cron runs every 10 minutes and uses the rep's stored refresh token to fetch new access tokens — meaning it will read the rep's inbox whether the rep is actively in a browser session or not. This is intentional (sequences need to pause on prospect replies even when reps are away), but you should know about it. The rep can disconnect at any time (see "How to revoke" below), which deletes the refresh token and stops all background access immediately.

### Application — run server-side for outbound calling

| Permission | What it does | Why it's needed |
|---|---|---|
| `Calls.Initiate.All` | Place an outbound PSTN call from a Teams Phone number | Rep clicks "Dial" in the app → their Teams client rings → they pick up → the prospect is called |
| `Calls.AccessMedia.All` | Connect the audio channel for the call | Microsoft requires this alongside `Calls.Initiate.All` for any PSTN call |

**Honest note on application permissions:** these are **tenant-wide application permissions**, not delegated. Technically the app's service principal could initiate a call from *any* Teams-licensed user in the tenant. In practice the app only initiates a call when a signed-in rep clicks Dial on a specific prospect — but the permission grant itself is broader than the usage. Mitigations:
- Restrict the app via **Assignment required = Yes** (see below) so only the BDR group can sign in.
- All call placements are logged in our `CallActivity` table with the initiating user ID and prospect ID.
- No bulk dialing. No cron-triggered calls. No queue-based calling. Each call is one rep + one click.

---

## What data is accessed and what is stored

| Data | Accessed? | Stored by Apex? | Retention |
|---|---|---|---|
| Rep's name, work email, AAD object ID | Yes — at login | Yes | Until rep account is deleted |
| OAuth refresh token (per rep) | Yes — at login | Yes — in a private PostgreSQL database on Railway | Until rep disconnects, or admin revokes consent |
| Outbound email content | Yes — to send via Graph | **No** — only subject line, recipient, sent timestamp, and Message-ID stored | Activity rows kept until account deleted |
| Rep's inbox | Yes — scanned for replies to sequence emails (matched by Message-ID) | Only subject + first ~500 chars of matched replies + classification (`ooo` / `genuine_reply` / `bounce` / `unsubscribe`) | 90 days |
| Call audio | **No** — Microsoft routes audio directly between rep and prospect; Apex never sees it | No | N/A |
| Call metadata (duration, outcome, disposition) | Yes — via Microsoft webhook + rep-logged data | Yes | Until rep account is deleted |
| Calendar, contacts, files, Teams chat, OneDrive, SharePoint | **No** | **No** | Not requested |

**Where it's stored:**
- Database: managed PostgreSQL on Railway (US region, private network, encrypted at rest at the volume level).
- App credentials (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `JWT_SECRET`) live as Railway environment variables — never in source code or the repository.
- No data leaves Apex for any external service except Microsoft Graph (to send/read mail and place calls) and the AI provider (Google Gemini or Anthropic Claude) for personalization drafting.

**What the AI provider sees:** when an AI-personalized draft is requested, the prompt sent to Gemini/Claude contains the prospect's name + title + company + the account research the rep entered in Apex (use cases, stakeholders, etc.). The provider does not see any inbox content, calendar, files, or other Microsoft Graph data.

---

## Security controls

- **Tenant-restricted at Entra.** The app registration uses `signInAudience = AzureADMyOrg`. Azure AD will reject any sign-in from outside the C3.ai tenant before a token is even issued. *(Note: the app's OAuth client uses Microsoft's `/common/` endpoint and relies on Entra to enforce the tenant restriction. We can switch to `/{tenant_id}/` and add a code-side `tid` claim check on request — see "Open follow-ups for IT" below.)*
- **No passwords stored.** All authentication is Microsoft SSO. Apex stores only the OAuth refresh token issued by Microsoft, never a password.
- **OAuth state parameter** with 10-minute TTL prevents CSRF on the redirect.
- **Session JWTs** signed with a secret held only in Railway env vars; 30-day expiry; not refreshable (rep must re-sign with Microsoft when expired).
- **Tracking pixel, unsubscribe handler, and all webhook endpoints are public-by-design** but signed/validated; no privileged operations exposed publicly.
- **Source code available for review.** Henry can grant read access to the private GitHub repo (`henry-whittle-C3/apex-bdr`) on request.

---

## How to restrict access (strongly recommended)

After granting admin consent, restrict sign-in to the BDR group only:

1. Entra ID → Enterprise Applications → apex-bdr → **Properties**
2. Set **Assignment required** = **Yes**
3. **Users and groups** → add the BDR team (individual users or a security group like `bdr-team@c3.ai`)

With this on, even though admin consent is granted tenant-wide, only assigned users can sign in.

---

## How to revoke instantly

| To do this | Where |
|---|---|
| Kill the entire app, all rep sessions, all refresh tokens | Entra → Enterprise Applications → apex-bdr → **Delete** |
| Remove one rep's access | Entra → Users → [rep] → **Apps and permissions** → Remove apex-bdr |
| Pause without deleting | Entra → Enterprise Applications → apex-bdr → **Properties** → set **Enabled for users to sign in?** to **No** |
| Revoke a single refresh token | Entra → Users → [rep] → **Authentication methods** → revoke sessions |

All of the above take effect within minutes. Subsequent Graph API calls with the revoked token return 401 and the app surfaces the error in its UI.

---

## Audit & monitoring (what IT can inspect)

Inside Apex:
- `EmailActivity` table — every email send/fail/open/reply with timestamps and `sentBy` rep
- `CallActivity` table — every call placed, including duration and outcome
- `IntegrationCredential` table — who has connected which provider, when

Inside Microsoft (no Apex involvement):
- Entra ID Sign-in logs — who signed in to apex-bdr, when, from where
- Microsoft Graph audit logs — every Graph API call apex-bdr's service principal makes
- Teams Admin Center — call detail records

Apex never modifies or hides any of these — IT retains full visibility through standard Microsoft tooling.

---

## Open follow-ups (planned hardening, before scaling beyond pilot)

These are not blockers for pilot approval but I'd like to land them before we expand the user count:

1. **Code-side tenant-ID claim check.** Add `if (payload.tid !== C3_TENANT_ID) reject` in the OAuth callback as a belt-and-suspenders defense on top of the Entra-side restriction.
2. **Column-level encryption of refresh tokens at rest.** Railway already provides volume encryption; column-level adds defense-in-depth.
3. **Granular audit log** for every Graph API call (rep, action, target, timestamp) — would feed into a security report I can hand to IT on demand.

Happy to prioritize any of these if IT considers them blocking.

---

## Source code pointers

| File | What it does |
|---|---|
| `routes/microsoftOAuth.js` | Sign-in flow + token storage |
| `services/sequenceMailer.js` | Email send (Graph + SMTP fallback) + send-safety guardrails |
| `services/replyDetector.js` | Reply polling, classification, auto-pause |
| `services/teamsCallService.js` | Calls API — place call, handle media |
| `routes/calls.js` | Call state webhooks from Microsoft |
| `routes/hitl.js` / `routes/emailActivities.js` | Human-in-the-loop review of AI-personalized drafts |
| `prisma/schema.prisma` | Full data model — every field stored is listed here |

---

## Contact

**Henry Whittle** — henry.whittle@c3.ai
Happy to schedule a 15-minute walkthrough or screen share to demonstrate any of the above. I can also run any specific test scenario IT wants to see (e.g., revocation propagation time, bounce handling, HITL review of a sample AI draft).
