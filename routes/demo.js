/**
 * Demo Mode routes
 * POST /demo/load  — wipe and repopulate with a rich, realistic demo dataset
 * DELETE /demo/clear — wipe all demo data (prospects, sequences, activities)
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const prisma = require('../services/database');
router.use(authenticateToken);

// ─── Rich demo dataset ──────────────────────────────────────────────────────

const PROSPECTS = [
  // Enterprise targets
  { firstName: 'Sarah',    lastName: 'Chen',       email: 'schen@vertexai.io',         companyName: 'Vertex AI Solutions', title: 'VP of Engineering',          phone: '+1 415 555 0192', status: 'Meeting Booked',  enrichmentStatus: 'enriched', techStack: 'AWS, Kubernetes, Python', country: 'US', region: 'San Francisco' },
  { firstName: 'Marcus',   lastName: 'Okafor',     email: 'mokafor@bridgepoint.com',   companyName: 'BridgePoint Capital', title: 'Head of Operations',         phone: '+1 212 555 0341', status: 'Replied',         enrichmentStatus: 'enriched', techStack: 'Salesforce, HubSpot',     country: 'US', region: 'New York' },
  { firstName: 'Priya',    lastName: 'Sharma',     email: 'priya.sharma@nexushr.co',   companyName: 'Nexus HR',            title: 'Chief People Officer',       phone: '+1 650 555 0887', status: 'In Sequence',     enrichmentStatus: 'enriched', techStack: 'Workday, Greenhouse',     country: 'US', region: 'Palo Alto' },
  { firstName: 'James',    lastName: 'Whitfield',  email: 'jwhitfield@lumencorp.com',  companyName: 'Lumen Corp',          title: 'Director of Sales',          phone: '+1 312 555 0554', status: 'In Sequence',     enrichmentStatus: 'enriched', techStack: 'Outreach, Salesloft, SFDC', country: 'US', region: 'Chicago' },
  { firstName: 'Elena',    lastName: 'Vasquez',    email: 'evasquez@orbitaldata.io',   companyName: 'Orbital Data',        title: 'CTO',                        phone: '+1 469 555 0211', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'Snowflake, dbt, Airflow',  country: 'US', region: 'Austin' },
  { firstName: 'Tom',      lastName: 'Gallagher',  email: 'tgallagher@apexsuite.com',  companyName: 'Apex Suite',          title: 'CEO',                        phone: '+1 617 555 0763', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'G Suite, Slack, HubSpot', country: 'US', region: 'Boston' },
  { firstName: 'Amara',    lastName: 'Nwosu',      email: 'anwosu@clearpath.tech',     companyName: 'ClearPath Tech',      title: 'VP of Product',              phone: '+1 737 555 0094', status: 'Meeting Booked',  enrichmentStatus: 'enriched', techStack: 'Jira, Figma, Amplitude',  country: 'US', region: 'Austin' },
  { firstName: 'David',    lastName: 'Kim',        email: 'dkim@stackbridge.dev',      companyName: 'StackBridge',         title: 'Engineering Manager',        phone: '+1 206 555 0437', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'GitHub, CircleCI, Docker', country: 'US', region: 'Seattle' },
  { firstName: 'Rachel',   lastName: 'Thornton',   email: 'rthornton@meridianhr.com',  companyName: 'Meridian HR',         title: 'Head of People & Culture',   phone: '+1 303 555 0619', status: 'Not Interested',  enrichmentStatus: 'enriched', techStack: 'BambooHR, Slack',         country: 'US', region: 'Denver' },
  { firstName: 'Carlos',   lastName: 'Mendez',     email: 'cmendez@quantumleap.io',    companyName: 'Quantum Leap',        title: 'COO',                        phone: '+1 512 555 0882', status: 'In Sequence',     enrichmentStatus: 'enriched', techStack: 'Monday.com, Salesforce',  country: 'US', region: 'Austin' },
  // Mid-market
  { firstName: 'Nina',     lastName: 'Petrov',     email: 'npetrov@driftanalytics.co', companyName: 'Drift Analytics',     title: 'Data Science Lead',          phone: '+1 415 555 0371', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'Python, Looker, BigQuery', country: 'US', region: 'San Francisco' },
  { firstName: 'Oliver',   lastName: 'Bennett',    email: 'obennett@catalystops.com',  companyName: 'Catalyst Ops',        title: 'VP of Customer Success',     phone: '+1 646 555 0248', status: 'Replied',         enrichmentStatus: 'enriched', techStack: 'Gainsight, Zendesk, SFDC', country: 'US', region: 'New York' },
  { firstName: 'Zoe',      lastName: 'Park',       email: 'zpark@novalink.io',         companyName: 'NovaLink',            title: 'Director of Growth',         phone: '+1 415 555 0993', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'Mixpanel, Segment, Braze', country: 'US', region: 'San Francisco' },
  { firstName: 'Ethan',    lastName: 'Reynolds',   email: 'ereynolds@fusionstack.com', companyName: 'FusionStack',         title: 'Head of RevOps',             phone: '+1 213 555 0177', status: 'In Sequence',     enrichmentStatus: 'enriched', techStack: 'Clari, Outreach, SFDC',   country: 'US', region: 'Los Angeles' },
  { firstName: 'Keiko',    lastName: 'Tanaka',     email: 'ktanaka@heliosgroup.co',    companyName: 'Helios Group',        title: 'Chief Revenue Officer',      phone: '+1 408 555 0562', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'HubSpot, Gong, ZoomInfo',  country: 'US', region: 'San Jose' },
  // SMB targets
  { firstName: 'Jordan',   lastName: 'Miles',      email: 'jmiles@frontierops.io',     companyName: 'Frontier Ops',        title: 'Founder & CEO',              phone: '+1 503 555 0284', status: 'Uncontacted',     enrichmentStatus: 'pending',  techStack: '', country: 'US', region: 'Portland' },
  { firstName: 'Valentina',lastName: 'Cruz',       email: 'vcruz@sunrisefintech.com',  companyName: 'Sunrise Fintech',     title: 'VP of Sales',                phone: '+1 305 555 0731', status: 'Uncontacted',     enrichmentStatus: 'pending',  techStack: '', country: 'US', region: 'Miami' },
  { firstName: 'Alistair', lastName: 'Forbes',     email: 'aforbes@pinnaclegrowth.co', companyName: 'Pinnacle Growth',     title: 'Sales Director',             phone: '+1 404 555 0166', status: 'Uncontacted',     enrichmentStatus: 'pending',  techStack: '', country: 'US', region: 'Atlanta' },
  { firstName: 'Mei',      lastName: 'Lin',        email: 'mlin@cloudnative.io',       companyName: 'CloudNative.io',      title: 'Head of Engineering',        phone: '+1 415 555 0829', status: 'Not Interested',  enrichmentStatus: 'enriched', techStack: 'K8s, Terraform, Go',      country: 'US', region: 'San Francisco' },
  { firstName: 'Brandon',  lastName: 'Walsh',      email: 'bwalsh@scalehq.com',        companyName: 'Scale HQ',            title: 'Director of Demand Gen',     phone: '+1 646 555 0455', status: 'In Sequence',     enrichmentStatus: 'enriched', techStack: 'Marketo, 6sense, SFDC',   country: 'US', region: 'New York' },
  { firstName: 'Isabelle', lastName: 'Moreau',     email: 'imoreau@synthetica.fr',     companyName: 'Synthetica',          title: 'Chief Marketing Officer',    phone: '+33 1 55 00 12 34', status: 'Uncontacted',   enrichmentStatus: 'enriched', techStack: 'Adobe, HubSpot, Tableau', country: 'FR', region: 'Paris' },
  { firstName: 'Liam',     lastName: 'O\'Brien',   email: 'lobrien@celtictech.ie',     companyName: 'Celtic Tech',         title: 'VP of Engineering',          phone: '+353 1 555 0876', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'AWS, Node.js, React',     country: 'IE', region: 'Dublin' },
  { firstName: 'Fatima',   lastName: 'Al-Hassan',  email: 'falhassan@meridacorp.ae',   companyName: 'Merida Corp',         title: 'Head of Digital',            phone: '+971 4 555 0123', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'Salesforce, Oracle',      country: 'AE', region: 'Dubai' },
  { firstName: 'Tomas',    lastName: 'Keller',     email: 'tkeller@automaxde.com',     companyName: 'AutoMax DE',          title: 'Sales Operations Lead',      phone: '+49 89 555 0456', status: 'Uncontacted',     enrichmentStatus: 'enriched', techStack: 'SAP, SFDC, Outreach',     country: 'DE', region: 'Munich' },
  { firstName: 'Aiko',     lastName: 'Yamamoto',   email: 'ayamamoto@techbridge.jp',   companyName: 'TechBridge Japan',    title: 'CTO',                        phone: '+81 3 5555 0789', status: 'Replied',         enrichmentStatus: 'enriched', techStack: 'AWS, React, PostgreSQL',  country: 'JP', region: 'Tokyo' },
];

const SEQUENCES = [
  {
    name: 'Q2 Enterprise Outbound',
    steps: [
      { order: 1, stepType: 'AUTO_EMAIL', delayDays: 0, subject: 'Quick question for {{firstName}}', body: 'Hi {{firstName}},\n\nI noticed {{company}} has been scaling its {{title}} function — congrats on the growth.\n\nI\'m reaching out because we\'ve helped similar teams cut their prospecting time in half using AI-powered outreach. Would a 15-minute call this week make sense?\n\nBest,\nHenry' },
      { order: 2, stepType: 'CALL',       delayDays: 2, subject: 'Discovery call with {{firstName}}', body: 'Objective: Understand current outreach process and pain points.\nTalk track: "Hi {{firstName}}, I sent you an email a couple of days ago about how we help teams like yours at {{company}}. Do you have 2 minutes?"' },
      { order: 3, stepType: 'AUTO_EMAIL', delayDays: 3, subject: 'Re: Quick question for {{firstName}}', body: 'Hi {{firstName}},\n\nFollowing up on my earlier note. I know you\'re busy — we\'ve helped 3 companies similar to {{company}} book 40% more meetings in their first month.\n\nWorth a quick chat?\n\nHenry' },
      { order: 4, stepType: 'LINKEDIN',   delayDays: 2, subject: 'Connect with {{firstName}} on LinkedIn', body: 'Personalised connection: "Hi {{firstName}}, I\'ve been following {{company}}\'s work in the space — would love to connect and share some ideas around outreach automation."' },
      { order: 5, stepType: 'CALL',       delayDays: 3, subject: 'Follow-up call — {{firstName}}', body: 'Second call attempt. Reference LinkedIn connection if accepted.\nTalk track: "Hi {{firstName}}, I connected with you on LinkedIn recently — wanted to follow up personally..."' },
      { order: 6, stepType: 'AUTO_EMAIL', delayDays: 4, subject: 'Closing the loop, {{firstName}}', body: 'Hi {{firstName}},\n\nI\'ll keep this brief — is outreach automation something on {{company}}\'s roadmap in the next 6 months?\n\nIf not, I\'ll stop reaching out. If yes, a 15-min call could save your team hours every week.\n\nHenry' },
    ],
  },
  {
    name: 'SMB Cold Outreach',
    steps: [
      { order: 1, stepType: 'AUTO_EMAIL', delayDays: 0, subject: 'Saw {{company}} on LinkedIn', body: 'Hi {{firstName}},\n\nI came across {{company}} while researching high-growth companies in the space. Impressive work.\n\nI help sales teams like yours automate personalised outreach so reps can focus on the conversations that matter. Happy to share a quick overview — just reply and I\'ll send it over.\n\nHenry' },
      { order: 2, stepType: 'CALL',       delayDays: 3, subject: 'Call — {{firstName}} at {{company}}', body: 'Quick intro call. Goal: qualify fit and identify pain around outbound volume/quality.\nTalk track: "Hi {{firstName}}, I emailed you a few days ago about helping {{company}} automate outreach. Did it land?"' },
      { order: 3, stepType: 'AUTO_EMAIL', delayDays: 4, subject: 'One thing I wanted to share', body: 'Hi {{firstName}},\n\n[Customer name] had the exact same challenge — their BDR team was spending 3 hours a day on manual research and personalisation. After 30 days with us, that dropped to 20 minutes.\n\nWould a 15-min walkthrough be worth your time?\n\nHenry' },
      { order: 4, stepType: 'TASK',       delayDays: 5, subject: 'Research {{company}} for final touch', body: 'Check LinkedIn for any recent news (funding, product launches, hiring). Use findings to personalise the final outreach.' },
    ],
  },
  {
    name: 'Inbound Trial Follow-Up',
    steps: [
      { order: 1, stepType: 'AUTO_EMAIL', delayDays: 0, subject: 'Welcome, {{firstName}} — let\'s make your trial count', body: 'Hi {{firstName}},\n\nThanks for signing up! I\'m your dedicated success contact at Apex.\n\nMost teams get their first 10 meetings booked within the first week. Want me to walk you through the quickest path to ROI for {{company}}?\n\nBook 15 mins: [LINK]\n\nHenry' },
      { order: 2, stepType: 'AUTO_EMAIL', delayDays: 2, subject: 'How\'s the trial going, {{firstName}}?', body: 'Hi {{firstName}},\n\nJust checking in — have you had a chance to explore the sequence builder yet? It\'s usually the "aha" moment for most teams.\n\nIf you\'re stuck or have questions, I\'m one reply away.\n\nHenry' },
      { order: 3, stepType: 'CALL',       delayDays: 3, subject: 'Trial check-in call — {{firstName}}', body: 'Goal: Identify blockers, drive activation. Check if they\'ve built a sequence yet.\nTalk track: "Hi {{firstName}}, I sent a couple of emails — just wanted to make sure your trial is going well and you\'re getting value..."' },
    ],
  },
];

// Helper to pick a date relative to now
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

// ─── POST /demo/load ────────────────────────────────────────────────────────
router.post('/load', async (req, res) => {
  try {
    // 1. Get or create the demo user
    let user = await prisma.user.findFirst();
    if (!user) {
      const bcrypt = require('bcrypt');
      const hashed = await bcrypt.hash('password123', 10);
      user = await prisma.user.create({
        data: { email: 'henry@apex-bdr.ai', username: 'henry', password: hashed },
      });
    }

    // 2. Clear existing demo data (in FK order)
    await prisma.emailActivity.deleteMany({});
    await prisma.callActivity.deleteMany({});
    await prisma.sequenceEnrollment.deleteMany({});
    await prisma.sequenceStep.deleteMany({});
    await prisma.sequence.deleteMany({});
    await prisma.prospect.deleteMany({});

    // 3. Create prospects
    const createdProspects = [];
    for (const p of PROSPECTS) {
      const prospect = await prisma.prospect.create({ data: { ...p, ownedById: req.userId } });
      createdProspects.push(prospect);
    }

    // 4. Create sequences with steps
    const createdSequences = [];
    for (const seqDef of SEQUENCES) {
      const seq = await prisma.sequence.create({
        data: {
          name: seqDef.name,
          userId: req.userId,
          steps: { create: seqDef.steps },
        },
        include: { steps: { orderBy: { order: 'asc' } } },
      });
      createdSequences.push(seq);
    }

    const [enterpriseSeq, smbSeq, inboundSeq] = createdSequences;

    // 5. Create enrollments with realistic states
    // Enterprise sequence enrollments
    const enterpriseEnrollments = [
      // Sarah Chen — Meeting Booked — completed sequence
      { prospect: createdProspects.find(p => p.email === 'schen@vertexai.io'), stepOrder: 3, status: 'replied', lastContactedAt: daysAgo(4), nextStepDue: null },
      // Marcus Okafor — Replied after step 2
      { prospect: createdProspects.find(p => p.email === 'mokafor@bridgepoint.com'), stepOrder: 2, status: 'replied', lastContactedAt: daysAgo(6), nextStepDue: null },
      // Priya Sharma — Active, on step 3, due tomorrow
      { prospect: createdProspects.find(p => p.email === 'priya.sharma@nexushr.co'), stepOrder: 2, status: 'active', lastContactedAt: daysAgo(3), nextStepDue: daysFromNow(1) },
      // James Whitfield — Active, on step 2 (call due today)
      { prospect: createdProspects.find(p => p.email === 'jwhitfield@lumencorp.com'), stepOrder: 1, status: 'active', lastContactedAt: daysAgo(2), nextStepDue: new Date() },
      // Carlos Mendez — Paused
      { prospect: createdProspects.find(p => p.email === 'cmendez@quantumleap.io'), stepOrder: 1, status: 'paused', lastContactedAt: daysAgo(8), nextStepDue: null, pausedAt: daysAgo(5), pausedReason: 'Out of office until next week' },
      // Oliver Bennett — Replied
      { prospect: createdProspects.find(p => p.email === 'obennett@catalystops.com'), stepOrder: 2, status: 'replied', lastContactedAt: daysAgo(3), nextStepDue: null },
      // Ethan Reynolds — Active step 4 (LinkedIn touch due in 2 days)
      { prospect: createdProspects.find(p => p.email === 'ereynolds@fusionstack.com'), stepOrder: 3, status: 'active', lastContactedAt: daysAgo(5), nextStepDue: daysFromNow(2) },
      // Rachel Thornton — Opted out
      { prospect: createdProspects.find(p => p.email === 'rthornton@meridianhr.com'), stepOrder: 1, status: 'opted_out', lastContactedAt: daysAgo(12), nextStepDue: null, optedOutAt: daysAgo(10) },
    ];

    const enrollmentRecords = [];
    for (const e of enterpriseEnrollments) {
      if (!e.prospect) continue;
      const enrollment = await prisma.sequenceEnrollment.create({
        data: {
          prospectId: e.prospect.id,
          sequenceId: enterpriseSeq.id,
          currentStepOrder: e.stepOrder,
          status: e.status,
          lastContactedAt: e.lastContactedAt,
          nextStepDue: e.nextStepDue,
          pausedAt: e.pausedAt || null,
          pausedReason: e.pausedReason || null,
          optedOutAt: e.optedOutAt || null,
          enrolledAt: daysAgo(14),
        },
      });
      enrollmentRecords.push({ enrollment, prospect: e.prospect, stepOrder: e.stepOrder });
    }

    // SMB sequence enrollments
    const smbProspects = [
      createdProspects.find(p => p.email === 'jmiles@frontierops.io'),
      createdProspects.find(p => p.email === 'vcruz@sunrisefintech.com'),
      createdProspects.find(p => p.email === 'aforbes@pinnaclegrowth.co'),
      createdProspects.find(p => p.email === 'bwalsh@scalehq.com'),
    ];
    for (const [i, sp] of smbProspects.entries()) {
      if (!sp) continue;
      await prisma.sequenceEnrollment.create({
        data: {
          prospectId: sp.id,
          sequenceId: smbSeq.id,
          currentStepOrder: i === 3 ? 2 : 0,
          status: i === 3 ? 'active' : 'active',
          lastContactedAt: i === 3 ? daysAgo(4) : null,
          nextStepDue: i === 3 ? daysFromNow(1) : daysFromNow(0),
          enrolledAt: daysAgo(7),
        },
      });
    }

    // Inbound sequence enrollments
    const inboundProspects = [
      createdProspects.find(p => p.email === 'ayamamoto@techbridge.jp'),
      createdProspects.find(p => p.email === 'imoreau@synthetica.fr'),
    ];
    for (const ip of inboundProspects) {
      if (!ip) continue;
      await prisma.sequenceEnrollment.create({
        data: {
          prospectId: ip.id,
          sequenceId: inboundSeq.id,
          currentStepOrder: 1,
          status: ip.status === 'Replied' ? 'replied' : 'active',
          lastContactedAt: daysAgo(2),
          nextStepDue: ip.status === 'Replied' ? null : daysFromNow(1),
          enrolledAt: daysAgo(3),
        },
      });
    }

    // 6. Create EmailActivity records for the enterprise sequence
    const step1 = enterpriseSeq.steps.find(s => s.order === 1);
    const step3 = enterpriseSeq.steps.find(s => s.order === 3);

    // Refresh enrollment records with their IDs
    const allEnrollments = await prisma.sequenceEnrollment.findMany({
      where: { sequenceId: enterpriseSeq.id },
      include: { prospect: true },
    });

    const getEnrollment = (email) => allEnrollments.find(e => e.prospect.email === email);

    const emailActivityData = [
      // Sarah Chen — step 1 sent & opened (link clicked), step 3 sent & opened → meeting booked
      { email: 'schen@vertexai.io',       step: step1, status: 'opened',    sentAt: daysAgo(14), openedAt: daysAgo(13), clickedAt: daysAgo(13), clickCount: 2 },
      { email: 'schen@vertexai.io',       step: step3, status: 'opened',    sentAt: daysAgo(9),  openedAt: daysAgo(8) },
      // Marcus Okafor — step 1 opened, replied after
      { email: 'mokafor@bridgepoint.com', step: step1, status: 'opened',    sentAt: daysAgo(10), openedAt: daysAgo(9) },
      // Priya Sharma — step 1 sent, step 2 was call, step 3 pending
      { email: 'priya.sharma@nexushr.co', step: step1, status: 'sent',      sentAt: daysAgo(7),  openedAt: null },
      // James Whitfield — step 1 sent
      { email: 'jwhitfield@lumencorp.com', step: step1, status: 'sent',     sentAt: daysAgo(2),  openedAt: null },
      // Ethan Reynolds — step 1 opened (link clicked), step 3 sent
      { email: 'ereynolds@fusionstack.com', step: step1, status: 'opened',  sentAt: daysAgo(12), openedAt: daysAgo(11), clickedAt: daysAgo(10), clickCount: 1 },
      { email: 'ereynolds@fusionstack.com', step: step3, status: 'sent',    sentAt: daysAgo(5),  openedAt: null },
      // Rachel Thornton — step 1 sent (then opted out)
      { email: 'rthornton@meridianhr.com', step: step1, status: 'sent',     sentAt: daysAgo(12), openedAt: null },
      // Oliver Bennett — step 1 opened twice
      { email: 'obennett@catalystops.com', step: step1, status: 'opened',   sentAt: daysAgo(8),  openedAt: daysAgo(7) },
      // A failed send
      { email: 'cmendez@quantumleap.io',   step: step1, status: 'failed',   sentAt: null,        openedAt: null, failureReason: 'SMTP connection timeout — credentials not configured' },
    ];

    for (const ea of emailActivityData) {
      const enr = getEnrollment(ea.email);
      if (!enr || !ea.step) continue;
      await prisma.emailActivity.create({
        data: {
          prospectId: enr.prospect.id,
          sequenceStepId: ea.step.id,
          enrollmentId: enr.id,
          status: ea.status,
          subject: ea.step.subject,
          sentAt: ea.sentAt,
          openedAt: ea.openedAt,
          clickedAt: ea.clickedAt || null,
          clickCount: ea.clickCount || 0,
          failureReason: ea.failureReason || null,
          createdAt: ea.sentAt || daysAgo(8),
        },
      });
    }

    // 7. Create CallActivity records
    const step2 = enterpriseSeq.steps.find(s => s.order === 2);
    const step5 = enterpriseSeq.steps.find(s => s.order === 5);

    const callActivityData = [
      // Sarah Chen — connected, led to meeting
      { email: 'schen@vertexai.io',       step: step2, status: 'completed', outcome: 'connected',    durationSecs: 432, notes: 'Great call — she\'s evaluating 3 tools. Demo booked for Friday.',   completedAt: daysAgo(12) },
      // Marcus Okafor — voicemail, then replied to email
      { email: 'mokafor@bridgepoint.com', step: step2, status: 'completed', outcome: 'voicemail',     durationSecs: 45,  notes: 'Left voicemail. Called back via email instead.',                    completedAt: daysAgo(8) },
      // Priya Sharma — no answer first attempt
      { email: 'priya.sharma@nexushr.co', step: step2, status: 'completed', outcome: 'no_answer',     durationSecs: null, notes: 'No answer. Will retry next call step.',                           completedAt: daysAgo(4) },
      // Oliver Bennett — connected, interested
      { email: 'obennett@catalystops.com', step: step2, status: 'completed', outcome: 'connected',   durationSecs: 614, notes: 'Warm conversation. He\'s the champion — needs to loop in VP Sales.', completedAt: daysAgo(5) },
      // Ethan Reynolds — connected on step 5
      { email: 'ereynolds@fusionstack.com', step: step5, status: 'completed', outcome: 'connected',  durationSecs: 287, notes: 'Short call — he asked me to email a one-pager.',                    completedAt: daysAgo(2) },
      // James Whitfield — planned call (scheduled for today)
      { email: 'jwhitfield@lumencorp.com', step: step2, status: 'planned',  outcome: null,            durationSecs: null, notes: null, scheduledFor: new Date() },
    ];

    for (const ca of callActivityData) {
      const enr = getEnrollment(ca.email);
      if (!enr || !ca.step) continue;
      await prisma.callActivity.create({
        data: {
          prospectId: enr.prospect.id,
          sequenceStepId: ca.step.id,
          enrollmentId: enr.id,
          status: ca.status,
          outcome: ca.outcome,
          durationSecs: ca.durationSecs,
          notes: ca.notes,
          scheduledFor: ca.scheduledFor || (ca.status !== 'planned' ? daysAgo(Math.floor(Math.random() * 10) + 1) : null),
          completedAt: ca.status !== 'planned' ? (ca.scheduledFor || daysAgo(3)) : null,
          createdAt: daysAgo(15),
        },
      });
    }

    const summary = {
      prospects: createdProspects.length,
      sequences: createdSequences.length,
      enrollments: await prisma.sequenceEnrollment.count(),
      emailActivities: await prisma.emailActivity.count(),
      callActivities: await prisma.callActivity.count(),
    };

    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[Demo] Load failed:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /demo/clear ─────────────────────────────────────────────────────
// Wipes all user-created CRM data — keeps User and IntegrationCredential
// (auth) so the operator stays logged in and connected to providers.
router.delete('/clear', async (req, res) => {
  try {
    // Children first to respect FKs (most have onDelete: Cascade, but being
    // explicit is safer and the counts are useful for the response).
    const emails    = await prisma.emailActivity.deleteMany({});
    const calls     = await prisma.callActivity.deleteMany({});
    const replies   = await prisma.replyActivity.deleteMany({});
    const meetings  = await prisma.meetingActivity.deleteMany({});
    const vms       = await prisma.vmRecording.deleteMany({}).catch(() => ({ count: 0 }));
    const owners    = await prisma.prospectOwner.deleteMany({});
    const enrolls   = await prisma.sequenceEnrollment.deleteMany({});
    const steps     = await prisma.sequenceStep.deleteMany({});
    const sequences = await prisma.sequence.deleteMany({});
    const prospects = await prisma.prospect.deleteMany({});
    const accounts  = await prisma.account.deleteMany({});

    res.json({
      ok: true,
      cleared: {
        emailActivities:     emails.count,
        callActivities:      calls.count,
        replyActivities:     replies.count,
        meetingActivities:   meetings.count,
        vmRecordings:        vms.count,
        prospectOwners:      owners.count,
        sequenceEnrollments: enrolls.count,
        sequenceSteps:       steps.count,
        sequences:           sequences.count,
        prospects:           prospects.count,
        accounts:            accounts.count,
      },
    });
  } catch (err) {
    console.error('[demo/clear]', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
