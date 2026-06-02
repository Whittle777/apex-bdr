const express = require('express');
const router = express.Router();
const wss = require('../websocketServer');

const prisma = require('../services/database');
// In-memory store of currently active calls keyed by prospectId
const activeCalls = new Map();

// GET /voice/calls — return all active calls for the Voice Fleet view
router.get('/calls', (req, res) => {
  res.json(Array.from(activeCalls.values()));
});

// POST /voice/dial/:prospectId — initiate a call (simulates MS Graph PSTN)
router.post('/dial/:prospectId', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.prospectId);
    const { isAutoDialing } = req.body;

    const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });

    // Seed an active call record immediately so Fleet view picks it up
    const callRecord = {
      id: `call-${prospectId}`,
      prospect: prospect ? `${prospect.firstName} ${prospect.lastName}` : `Prospect #${prospectId}`,
      company: prospect?.companyName || '—',
      phone: '+1 (000) 000-0000',
      status: 'DIALING',
      duration: 0,
      sentiment: 'Neutral',
      sentimentScore: 60,
      transcript: [],
      flag: null,
      prospectId,
      startedAt: Date.now(),
    };
    activeCalls.set(prospectId, callRecord);

    res.status(200).json({ message: 'Initiated Physical PSTN Call via Teams native application.' });

    const broadcast = (status) => {
      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ prospectId, status }));
        }
      });
    };

    // Simulate Graph webhooks: DIALING → CONNECTED
    setTimeout(() => {
      broadcast('DIALING');
    }, 200);

    setTimeout(() => {
      broadcast('CONNECTED');
      const call = activeCalls.get(prospectId);
      if (call) {
        call.status = 'CONNECTED';
        call.transcript.push({ speaker: 'System', text: '[Call connected via MS Teams PSTN bridge]' });
        activeCalls.set(prospectId, call);
      }
    }, 3500);

  } catch (error) {
    console.error('Teams Voice API Error:', error);
    res.status(500).json({ error: 'Failed to negotiate with Graph API.' });
  }
});

// POST /voice/calls/:prospectId/outcome — log call result and remove from active fleet
router.post('/calls/:prospectId/outcome', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.prospectId);
    const { outcome, duration, notes } = req.body;

    activeCalls.delete(prospectId);

    const callNote = notes && notes.trim() ? notes.trim() : null;

    // Append a timestamped call note entry to the prospect's notes field
    const timestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const noteHeader = `[Call · ${timestamp} · ${outcome || 'completed'}]`;
    const noteBody = callNote ? `\n${callNote}` : '';
    const noteEntry = `${noteHeader}${noteBody}\n\n`;

    const prospect = await prisma.prospect.findUnique({ where: { id: prospectId }, select: { notes: true } });
    await prisma.prospect.update({
      where: { id: prospectId },
      data: { notes: noteEntry + (prospect?.notes || '') },
    });

    res.json({ message: 'Call outcome logged.', outcome });
  } catch (error) {
    console.error('Outcome logging error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
