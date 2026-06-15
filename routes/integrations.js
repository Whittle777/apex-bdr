const express = require('express');
const router = express.Router();
const axios = require('axios'); // Added axios for verification tests
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const prisma = require('../services/database');
const { authenticateToken } = require('../middleware/auth');

// Single-tenant: scope Microsoft token endpoints to our Entra tenant via
// MICROSOFT_TENANT_ID (matches routes/microsoftOAuth.js); 'common' only as a
// local-dev fallback when the env var is unset.
const MS_TENANT = process.env.MICROSOFT_TENANT_ID || 'common';

// Credential rows must never ship their secret values to the browser. The
// IntegrationCredential columns are overloaded per provider, so secrets live
// in different fields:
//   microsoft  → refreshToken (mailbox token); clientSecret now '', clientId = app id
//   google     → clientSecret (Gmail app password) + refreshToken
//   claude     → clientId (API key);  clientSecret = model name (safe to show)
//   elevenlabs → clientId (API key);  clientSecret = agent id (safe to show)
//   apify      → clientId (API token) + refreshToken
// We mask only the secret fields per provider with a truthy sentinel, so the
// UI's "connected?" checks (which test truthiness) and the Claude-model /
// ElevenLabs-agent-id display values keep working. Unknown providers are
// masked conservatively (all three credential fields).
const REDACTED = '__redacted__';
const SECRET_FIELDS = {
  microsoft:  ['refreshToken'],
  google:     ['clientSecret', 'refreshToken'],
  claude:     ['clientId'],
  elevenlabs: ['clientId'],
  apify:      ['clientId', 'refreshToken'],
};
const DEFAULT_SECRET_FIELDS = ['clientId', 'clientSecret', 'refreshToken'];
function redactCredential(c) {
  if (!c) return c;
  const fields = SECRET_FIELDS[c.provider] || DEFAULT_SECRET_FIELDS;
  const out = { ...c };
  for (const f of fields) if (out[f]) out[f] = REDACTED; // hide value, preserve truthiness
  return out;
}

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const creds = await prisma.integrationCredential.findMany({
      where: { userId: req.userId }
    });
    res.json(creds.map(redactCredential));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', async (req, res) => {
  const { provider, clientId, clientSecret, refreshToken, email } = req.body;
  
  // LIVE CREDENTIAL VALIDATION
  try {
    if (provider === 'claude') {
      if (!clientId) return res.status(400).json({ message: 'API Key is required.' });
      const client = new Anthropic({ apiKey: clientId });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } else if (provider === 'elevenlabs') {
      if (!clientId) return res.status(400).json({ message: 'API Key is required.' });
      // Validate by listing voices (lightweight call)
      await axios.get('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': clientId },
      });
    } else if (provider === 'apify') {
      if (!clientId) return res.status(400).json({ message: 'Apify API token is required.' });
      // Validate against the Apify user endpoint
      await axios.get('https://api.apify.com/v2/users/me', {
        headers: { Authorization: `Bearer ${clientId}` },
      });
    } else if (provider === 'google') {
      // clientId = email address, clientSecret = App Password (16-char Gmail App Password)
      if (!clientId || !clientSecret) {
        return res.status(400).json({ message: 'Email and App Password are required.' });
      }
      const transport = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: clientId, pass: clientSecret.replace(/\s/g, '') },
      });
      try {
        await transport.verify();
      } catch (smtpErr) {
        return res.status(400).json({ message: 'Gmail SMTP verification failed. Check your email address and App Password.' });
      }
    } else if (provider === 'microsoft') {
      // NOTE: For the Power Dialer / Phase 14 to work, this Microsoft auth flow 
      // must explicitly request the following Graph API Scopes from Azure Entra ID:
      // - Calls.InitiateGroupCall.All 
      // - Calls.AccessMedia.All
      // - offline_access

      await axios.post(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
    }
  } catch (authErr) {
    return res.status(400).json({ message: 'Invalid Credentials. Authorization server rejected the handshake.' });
  }

  // PROCEED TO SAVE
  try {
    const cred = await prisma.integrationCredential.upsert({
      where: { provider_userId: { provider, userId: req.userId } },
      update: { clientId, clientSecret, refreshToken, email },
      create: { provider, clientId, clientSecret, refreshToken, email, userId: req.userId }
    });
    res.json(redactCredential(cred));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:provider', async (req, res) => {
  const { provider } = req.params;
  try {
    await prisma.integrationCredential.delete({
      where: { provider_userId: { provider, userId: req.userId } }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
