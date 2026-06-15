/**
 * Microsoft OAuth 2.0 — SSO login + email credential storage
 *
 * POST /auth/microsoft/start    → returns { url } to redirect to Microsoft login
 * GET  /auth/microsoft/callback → receives code, upserts User, issues JWT, redirects to frontend
 *
 * Requires env vars:
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *   APP_URL  (e.g. https://apex-bdr-production.up.railway.app)
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const prisma = require('../services/database');
const APP_URL      = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:5175';
const REDIRECT_URI = `${APP_URL}/auth/microsoft/callback`;

const MS_CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MS_TENANT        = process.env.MICROSOFT_TENANT_ID || 'common';

const SCOPES = [
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
  'openid',
].join(' ');

// Ephemeral state store — entries expire after 10 minutes
const pendingStates = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pendingStates.entries()) {
    if (v.createdAt < cutoff) pendingStates.delete(k);
  }
}, 60_000);

// ── POST /auth/microsoft/start ────────────────────────────────────────────────
router.post('/start', (req, res) => {
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    return res.status(503).json({ message: 'Microsoft SSO is not configured on this server.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { createdAt: Date.now() });

  const url =
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize` +
    `?client_id=${encodeURIComponent(MS_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${state}` +
    `&response_mode=query` +
    `&prompt=select_account`;

  res.json({ url });
});

// ── GET /auth/microsoft/callback ──────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description, admin_consent, tenant } = req.query;

  if (error) {
    const msg = encodeURIComponent(error_description || error);
    return res.redirect(`${FRONTEND_URL}/login?ms_error=${msg}`);
  }

  // Admin-consent flow lands here with ?admin_consent=True&tenant=<tid> after
  // a tenant admin approves the app. There is no auth-code exchange — Microsoft
  // has already recorded the consent on its side. Show the admin a friendly
  // confirmation instead of the OAuth state-mismatch error.
  if (admin_consent === 'True' || admin_consent === 'true') {
    return res.redirect(`${FRONTEND_URL}/login?ms_admin_consent=ok&tenant=${encodeURIComponent(tenant || '')}`);
  }

  const stateData = pendingStates.get(state);
  if (!stateData) {
    return res.redirect(`${FRONTEND_URL}/login?ms_error=Invalid+or+expired+state.+Please+try+again.`);
  }
  pendingStates.delete(state);

  try {
    // Exchange code for tokens
    const params = new URLSearchParams({
      client_id:     MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      code,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    });
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token } = tokenRes.data;

    // Decode Azure AD token claims (tid = tenant ID, oid = user object ID)
    let tenantId = '', azureAdId = '';
    try {
      const payload = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64').toString());
      tenantId  = payload.tid  || '';
      azureAdId = payload.oid  || '';
    } catch (_) {}

    // Fetch user profile from Graph
    const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const msEmail   = profileRes.data.mail || profileRes.data.userPrincipalName || '';
    const msName    = profileRes.data.displayName || '';
    const msObjId   = profileRes.data.id || azureAdId; // Graph /me id is the AAD object ID

    if (!msEmail) {
      return res.redirect(`${FRONTEND_URL}/login?ms_error=Could+not+read+your+Microsoft+email+address.`);
    }

    // Find or create the User record
    const user = await prisma.user.upsert({
      where:  { email: msEmail },
      update: { name: msName, azureAdId: msObjId },
      create: { email: msEmail, name: msName, azureAdId: msObjId },
    });

    // Store (or refresh) Microsoft credential for this user.
    // NOTE: we deliberately do NOT persist the confidential client secret here.
    // The app secret lives only in MICROSOFT_CLIENT_SECRET (env); storing a copy
    // on every row duplicated the credential across the DB (security finding).
    // clientSecret is left blank for Microsoft rows; token paths read the secret
    // from env (services/sequenceMailer.js, replyDetector.js, oauthService.js).
    await prisma.integrationCredential.upsert({
      where:  { provider_userId: { provider: 'microsoft', userId: user.id } },
      update: { clientId: MS_CLIENT_ID, clientSecret: '', refreshToken: refresh_token, email: msEmail, tenantId },
      create: { provider: 'microsoft', clientId: MS_CLIENT_ID, clientSecret: '', refreshToken: refresh_token, email: msEmail, tenantId, userId: user.id },
    });

    // Issue a long-lived JWT (30 days — reps shouldn't be re-authing constantly)
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.redirect(`${FRONTEND_URL}/auth/callback?token=${encodeURIComponent(token)}&name=${encodeURIComponent(msName)}`);
  } catch (err) {
    console.error('[Microsoft OAuth]', err.response?.data || err.message);
    const errMsg = encodeURIComponent(
      err.response?.data?.error_description || err.message || 'Authentication failed.'
    );
    res.redirect(`${FRONTEND_URL}/login?ms_error=${errMsg}`);
  }
});

module.exports = router;
