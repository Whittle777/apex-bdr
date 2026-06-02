/**
 * routes/calls.js — Teams Calls API integration
 *
 * POST   /calls/initiate          Initiate an outbound call from rep's Teams Phone
 * POST   /calls/webhook           Microsoft Graph callback — call state events (no auth)
 * POST   /calls/:callId/vm-drop   Manually trigger voicemail drop for an active call
 * DELETE /calls/:callId           Hang up an active call
 * GET    /calls/active            List active calls for the current user
 */

const express  = require('express');
const router   = express.Router();

const prisma = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { initiateCall, hangupCall, playPrompt } = require('../services/teamsCallService');
const wss = require('../websocketServer');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// How long the call must ring before we assume it hit voicemail (ms).
// Humans typically answer in < 8 s; VM systems pick up after the ring timeout (~15-30 s).
const VM_RING_THRESHOLD_MS = parseInt(process.env.VM_RING_THRESHOLD_MS || '12000', 10);
// How long after the call is "established" we wait before playing the prompt —
// gives the VM greeting time to finish before the beep.
const VM_GREETING_DELAY_MS = parseInt(process.env.VM_GREETING_DELAY_MS || '4000', 10);

// In-memory call session store: callId → session object
const activeCalls = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ── POST /calls/initiate ──────────────────────────────────────────────────────
router.post('/initiate', authenticateToken, async (req, res) => {
  const { prospectId, phone, enrollmentId, vmRecordingId } = req.body;
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  const [user, cred] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId }, select: { azureAdId: true } }),
    prisma.integrationCredential.findUnique({
      where: { provider_userId: { provider: 'microsoft', userId: req.userId } },
      select: { tenantId: true },
    }),
  ]);

  if (!user?.azureAdId || !cred?.tenantId) {
    return res.status(503).json({
      message: 'Teams calling requires re-connecting your Microsoft account. Sign out and sign in again.',
    });
  }

  if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
    return res.status(503).json({ message: 'Microsoft app credentials not configured on this server.' });
  }

  try {
    const { callId, tenantId } = await initiateCall(user.azureAdId, cred.tenantId, phone);

    activeCalls.set(callId, {
      callId,
      prospectId:    prospectId    ? parseInt(prospectId)    : null,
      enrollmentId:  enrollmentId  ? parseInt(enrollmentId)  : null,
      vmRecordingId: vmRecordingId ? parseInt(vmRecordingId) : null,
      repUserId:     req.userId,
      tenantId,
      state:         'establishing',
      initiatedAt:   Date.now(),
      startedAt:     null,
      endedAt:       null,
      vmDropped:     false,
      vmDropTimer:   null,
    });

    res.json({ callId, state: 'establishing' });
  } catch (err) {
    console.error('[Teams Call] initiate failed:', err.response?.data || err.message);
    const detail = err.response?.data?.error?.message || err.message;
    res.status(502).json({ message: `Teams call failed: ${detail}` });
  }
});

// ── POST /calls/webhook ───────────────────────────────────────────────────────
// No auth — Microsoft Graph posts call state changes here.
router.post('/webhook', express.json(), async (req, res) => {
  res.sendStatus(202);

  const notifications = req.body?.value || [];

  for (const notif of notifications) {
    const odataType = notif.resourceData?.['@odata.type'] || '';

    // ── playPrompt operation completed ──────────────────────────────────────
    // Resource path: /communications/calls/{callId}/operations/{opId}
    if (odataType === '#microsoft.graph.playPromptOperation') {
      const status = notif.resourceData?.status;
      // Extract callId from resource URL e.g. "/communications/calls/abc123/operations/op456"
      const match = (notif.resource || '').match(/calls\/([^/]+)\/operations/);
      const callId = match?.[1];
      if (callId && status === 'completed') {
        const session = activeCalls.get(callId);
        if (session) {
          broadcast({ type: 'call_state', callId, state: 'vm_drop_complete' });
          // Auto-hangup after voicemail drop completes
          try {
            await hangupCall(callId, session.tenantId);
          } catch (e) {
            console.error('[Teams Call] auto-hangup after VM drop failed:', e.message);
          }
        }
      }
      continue;
    }

    // ── Standard call state change ───────────────────────────────────────────
    const callId    = notif.resourceData?.id;
    const newState  = notif.resourceData?.state;
    const resultInfo = notif.resourceData?.resultInfo;

    if (!callId || !newState) continue;

    const session = activeCalls.get(callId);
    if (!session) continue;

    session.state = newState;

    if (newState === 'established') {
      session.startedAt = new Date();

      // ── Auto voicemail drop heuristic ─────────────────────────────────────
      // If the call rang longer than VM_RING_THRESHOLD_MS, it almost certainly
      // hit voicemail. Wait VM_GREETING_DELAY_MS for the greeting to finish,
      // then inject our pre-recorded message via playPrompt.
      const ringMs = Date.now() - session.initiatedAt;
      if (
        !session.vmDropped &&
        session.vmRecordingId &&
        ringMs >= VM_RING_THRESHOLD_MS
      ) {
        const audioUrl = `${APP_URL}/vm-recordings/${session.vmRecordingId}/audio`;
        broadcast({ type: 'call_state', callId, state: 'vm_drop_pending' });

        session.vmDropTimer = setTimeout(async () => {
          try {
            await playPrompt(callId, session.tenantId, audioUrl);
            session.vmDropped = true;
            broadcast({ type: 'call_state', callId, state: 'vm_dropping' });
          } catch (e) {
            console.error('[Teams Call] playPrompt failed:', e.response?.data || e.message);
            broadcast({ type: 'call_state', callId, state: 'vm_drop_failed' });
          }
        }, VM_GREETING_DELAY_MS);
      }
    }

    if (newState === 'terminated') {
      if (session.vmDropTimer) clearTimeout(session.vmDropTimer);
      session.endedAt = new Date();
      const durationSecs = session.startedAt
        ? Math.round((session.endedAt - session.startedAt) / 1000)
        : null;

      try {
        if (session.prospectId) {
          const outcome = session.vmDropped
            ? 'voicemail'
            : durationSecs > 0
            ? 'connected'
            : 'no_answer';

          await prisma.callActivity.create({
            data: {
              prospectId:   session.prospectId,
              enrollmentId: session.enrollmentId || undefined,
              status:       outcome,
              outcome,
              completedAt:  session.endedAt,
              durationSecs,
            },
          });
        }
      } catch (dbErr) {
        console.error('[Teams Call] failed to write CallActivity:', dbErr.message);
      }

      activeCalls.delete(callId);
    }

    broadcast({
      type:         'call_state',
      callId,
      state:        newState,
      vmDropped:    session.vmDropped,
      durationSecs: session.startedAt
        ? Math.round((Date.now() - session.startedAt) / 1000)
        : null,
      resultInfo,
    });
  }
});

// ── POST /calls/:callId/vm-drop ───────────────────────────────────────────────
// Manual voicemail drop — rep clicks "Drop VM" button during an active call.
// Specific path must come before /:callId wildcard.
router.post('/:callId/vm-drop', authenticateToken, async (req, res) => {
  const { callId } = req.params;
  const session = activeCalls.get(callId);

  if (!session) return res.status(404).json({ message: 'Call not found or already ended.' });
  if (session.repUserId !== req.userId) return res.status(403).json({ message: 'Not your call.' });
  if (session.vmDropped) return res.status(409).json({ message: 'Voicemail already dropped for this call.' });

  // Allow caller to specify a recording; fall back to the one set at dial time
  const vmRecordingId = req.body?.vmRecordingId
    ? parseInt(req.body.vmRecordingId)
    : session.vmRecordingId;

  if (!vmRecordingId) {
    return res.status(400).json({ message: 'No VM recording specified.' });
  }

  const audioUrl = `${APP_URL}/vm-recordings/${vmRecordingId}/audio`;

  try {
    await playPrompt(callId, session.tenantId, audioUrl);
    session.vmDropped    = true;
    session.vmRecordingId = vmRecordingId;
    broadcast({ type: 'call_state', callId, state: 'vm_dropping', vmDropped: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Teams Call] manual vm-drop failed:', err.response?.data || err.message);
    const detail = err.response?.data?.error?.message || err.message;
    res.status(502).json({ message: `VM drop failed: ${detail}` });
  }
});

// ── DELETE /calls/:callId ─────────────────────────────────────────────────────
router.delete('/:callId', authenticateToken, async (req, res) => {
  const { callId } = req.params;
  const session = activeCalls.get(callId);

  if (!session) return res.status(404).json({ message: 'Call not found or already ended.' });
  if (session.repUserId !== req.userId) return res.status(403).json({ message: 'Not your call.' });

  if (session.vmDropTimer) clearTimeout(session.vmDropTimer);

  try {
    await hangupCall(callId, session.tenantId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Teams Call] hangup failed:', err.response?.data || err.message);
    res.status(502).json({ message: 'Hangup failed — call may have already ended.' });
  }
});

// ── GET /calls/active ─────────────────────────────────────────────────────────
// Must come before /:callId so it doesn't match as a callId lookup.
router.get('/active', authenticateToken, (req, res) => {
  const mine = [...activeCalls.values()]
    .filter(s => s.repUserId === req.userId)
    .map(({ vmDropTimer, ...s }) => s); // strip non-serialisable timer ref
  res.json(mine);
});

module.exports = router;
