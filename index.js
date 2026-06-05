require('dotenv').config();
const express = require('express');

const cors = require('cors');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const prospectsRoutes = require('./routes/prospects');
const sequencesRouter = require('./routes/sequences');
const sequenceStepsRouter = require('./routes/sequenceSteps');
const integrationsRouter = require('./routes/integrations');
const orchestrationRouter = require('./routes/orchestration');
const listsRouter = require('./routes/lists');
const voiceRouter = require('./routes/voice');
const hitlRouter = require('./routes/hitl');
const voiceAgentRouter = require('./routes/voiceAgent');
const consumeMessages = require('./awsSqsConsumer');
const wss = require('./websocketServer');
const microsoftOAuthRouter = require('./routes/microsoftOAuth');
const emailActivitiesRouter = require('./routes/emailActivities');
const callActivitiesRouter = require('./routes/callActivities');
const demoRouter = require('./routes/demo');
const replyActivitiesRouter = require('./routes/replyActivities');
const meetingActivitiesRouter = require('./routes/meetingActivities');
const accountsRouter = require('./routes/accounts');
const callsRouter = require('./routes/calls');
const vmRecordingsRouter = require('./routes/vmRecordings');
const researchRouter = require('./routes/research');
const mcpBridgeRouter = require('./routes/mcpBridge');
const cron = require('node-cron');
const { runDueSequenceEmails, prepareUpcomingDrafts } = require('./services/sequenceMailer');
const { runReplyDetection } = require('./services/replyDetector');

const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;
const prisma = require('./services/database');
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/prospects', prospectsRoutes);
app.use('/sequences', sequencesRouter);
app.use('/sequenceSteps', sequenceStepsRouter);
app.use('/integrations', integrationsRouter);
app.use('/orchestration', orchestrationRouter);
app.use('/lists', listsRouter);
app.use('/voice', voiceRouter);
app.use('/hitl', hitlRouter);
app.use('/voice-agent', voiceAgentRouter);
app.use('/auth/microsoft', microsoftOAuthRouter);
app.use('/email-activities', emailActivitiesRouter);
app.use('/call-activities', callActivitiesRouter);
app.use('/demo', demoRouter);
app.use('/reply-activities', replyActivitiesRouter);
app.use('/meeting-activities', meetingActivitiesRouter);
app.use('/accounts', accountsRouter);
app.use('/calls', callsRouter);
app.use('/vm-recordings', vmRecordingsRouter);
app.use('/research', researchRouter);
app.use('/api/mcp', mcpBridgeRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Apex BDR API' });
});

// Serve built frontend in production
const path = require('path');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'frontend/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
  });
}

// Attach WebSocket to the same HTTP server (shares PORT — required for Railway)
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server attached on same port`);
});

// Start consuming messages from SQS
consumeMessages({
  connectionString: process.env.SERVICE_BUS_CONNECTION_STRING,
  queueName: process.env.SERVICE_BUS_QUEUE_NAME,
});

// ── Sequence email scheduler ─────────────────────────────────────────────────
// Runs every 15 minutes — sends any sequence step emails that are due.
cron.schedule('*/15 * * * *', async () => {
  try {
    const results = await runDueSequenceEmails();
    if (results.sent > 0 || results.failed > 0) {
      console.log(`[Sequence Mailer] Sent: ${results.sent}, Failed: ${results.failed}`);
    }
  } catch (err) {
    console.error('[Sequence Mailer] Cron error:', err.message);
  }
});

// ── Lookahead drafter ────────────────────────────────────────────────────────
// Runs every 30 minutes — pre-generates AI personalized drafts for
// upcoming sequence steps so the reviewer has time to approve them
// before their scheduled send time. Sooner-scheduled sends are drafted
// first. Configurable via DRAFT_LOOKAHEAD_DAYS (default 7) and
// MAX_DRAFTS_PER_RUN (default 20).
cron.schedule('*/30 * * * *', async () => {
  try {
    await prepareUpcomingDrafts();
  } catch (err) {
    console.error('[Pre-draft] Cron error:', err.message);
  }
});

// ── Reply detection + OOO auto-resumer ───────────────────────────────────────
// Runs every 10 minutes — polls inbox for replies, resumes OOO-paused enrollments.
cron.schedule('*/10 * * * *', async () => {
  try {
    await runReplyDetection();
  } catch (err) {
    console.error('[Reply Detector] Cron error:', err.message);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
