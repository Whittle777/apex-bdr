
const prisma = require('./database');
const { acquireLock, releaseLock } = require('./stateMachine');
const { handleProspectStatusChange } = require('./eventHandlers');
const { logTrackingPixelEvent, wrapLink } = require('./trackingPixelLogger');
const { analyzeOpenRates } = require('./openRateAnalyzer');
const { validateEmailBatch, validateWebhookPayload, validateSPFRecord, validateDMARCPolicy } = require('./validation');
const { checkRateLimit, resetRateLimit, handleRateLimitError, checkReputation } = require('./rateLimiting');
const { getShard } = require('./getShard');
const { google } = require('googleapis');
const axios = require('axios');
const redis = require('redis');
const { createAbuseComplaint } = require('../models/AbuseComplaint');
const { processBounceNotification } = require('../services/bounceNotificationProcessor');
const mcp = require('./mcp');
const { authenticateMicrosoft } = require('../services/microsoftAuth');
const azureServiceBusProducer = require('../services/azureServiceBusProducer');
const rabbitMQProducer = require('../services/rabbitMQProducer');
const naturalLanguageGuardrails = require('./naturalLanguageGuardrails');
const doubleWriteStrategy = require('../services/doubleWriteStrategy');
const logger = require('../services/logger');

async function run() {
  await azureServiceBusProducer.sendMessage({ topic: 'ngoe-tasks', message: 'Initialize NGOE' });
  await rabbitMQProducer.sendMessage({ queue: 'ngoe-tasks', message: 'Initialize NGOE' });

  await consumer.connect();
  await consumer.subscribe({ topic: 'ngoe-tasks', fromBeginning: true });
  await redisClient.connect();

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const task = JSON.parse(message.value.toString());
        await executeTask(task);
      } catch (error) {
        logger.error('Error processing NGOE task:', error);
      }
    },
  });
}

async function executeTask(task) {
  const { type, payload } = task;

  logger.info(`Starting NGOE task: ${type}`, { payload });

  try {
    switch (type) {
      case 'sendEmail':
        await sendEmail(payload);
        break;
      case 'updateDMARCPolicy':
        await updateDMARCPolicy(payload);
        break;
      case 'logTrackingPixelEvent':
        await logTrackingPixelEvent(payload);
        break;
      case 'wrapLinks':
        await wrapLinks(payload);
        break;
      case 'analyzeOpenRates':
        await analyzeOpenRates(payload);
        break;
      case 'processBounceNotification':
        await processBounceNotification(payload);
        break;
      case 'mcpSecureCommunication':
        await mcpSecureCommunication(payload);
        break;
      case 'authenticateMicrosoft':
        await authenticateMicrosoft(payload);
        break;
      default:
        logger.error('Unknown task type:', type);
    }
  } catch (error) {
    logger.error(`Error executing NGOE task: ${type}`, { error, payload });
  } finally {
    logger.info(`Completed NGOE task: ${type}`, { payload });
  }
}

async function sendEmail(payload) {
  const { prospectId, bento, emailContent, provider } = payload;

  // Enforce natural language guardrails
  naturalLanguageGuardrails.enforcePolicyDirectives(emailContent);

  if (provider === 'google') {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    });
    const accessToken = await auth.getClient().getAccessToken();
    const gmail = google.gmail({ version: 'v1', auth });

    const encodedMessage = Buffer.from(emailContent).toString('base64');
    const email = {
      raw: encodedMessage,
    };

    await gmail.users.messages.send({
      userId: 'me',
      resource: email,
    });

    logger.info(`Email sent to prospectId: ${prospectId} via Google`, { emailContent });
  } else if (provider === 'microsoft') {
    const auth = new google.auth.OAuth2({
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    });

    auth.setCredentials({
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
    });

    const encodedMessage = Buffer.from(emailContent).toString('base64');
    const email = {
      Message: {
        Raw: encodedMessage,
      },
    };

    await axios.post('https://graph.microsoft.com/v1.0/me/sendMail', email, {
      headers: {
        Authorization: `Bearer ${payload.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    logger.info(`Email sent to prospectId: ${prospectId} via Microsoft`, { emailContent });
  }
}

async function updateDMARCPolicy(payload) {
  const { prospectId, bento, dmarcPolicy } = payload;
  if (await validateDMARCPolicy(dmarcPolicy)) {
    await updateProspectDMARCPolicy(prospectId, bento, dmarcPolicy);
    logger.info(`DMARC policy updated for prospectId: ${prospectId}`, { dmarcPolicy });
  } else {
    logger.error('Invalid DMARC policy', { dmarcPolicy });
    throw new Error('Invalid DMARC policy');
  }
}

async function logTrackingPixelEvent(payload) {
  const { prospectId, bento, trackingPixelData } = payload;
  await logTrackingPixelEvent(prospectId, bento, trackingPixelData);
  logger.info(`Tracking pixel event logged for prospectId: ${prospectId}`, { trackingPixelData });
}

async function wrapLinks(payload) {
  const { emailContent, trackingPixelData } = payload;
  const wrappedEmailContent = wrapLinksInEmail(emailContent, trackingPixelData);
  logger.info(`Wrapped email content for prospectId: ${payload.prospectId}`, { wrappedEmailContent });
}

async function updateProspectDMARCPolicy(prospectId, bento, dmarcPolicy) {
  const shard = getShard(bento);
  return await prisma[shard].prospect.update({
    where: { id: prospectId },
    data: { dmarcPolicy },
  });
}

function wrapLinksInEmail(emailContent, trackingPixelData) {
  // Simple regex to find and wrap links
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  return emailContent.replace(linkRegex, (url) => wrapLink(url, trackingPixelData));
}

async function mcpSecureCommunication(payload) {
  const { data, signature } = payload;

  if (!mcp.verify(data, signature)) {
    logger.error('Invalid MCP signature', { data, signature });
    throw new Error('Invalid MCP signature');
  }

  const decryptedData = mcp.decrypt(data);
  logger.info('Received and decrypted MCP data:', decryptedData);

  // Process the decrypted data as needed
  // For example, you can parse the decrypted data and perform actions
  const task = JSON.parse(decryptedData);
  await executeTask(task);
}

module.exports = { run, executeTask };
