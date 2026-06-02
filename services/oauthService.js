const axios = require('axios');

const prisma = require('./database');
async function getOAuthToken(provider, userId) {
  // Try to find a valid standard token record if one was established previously
  const tokenRecord = await prisma.oauthToken.findUnique({
    where: { provider_userId: { provider, userId } },
  });

  if (tokenRecord && !isTokenExpired(tokenRecord.expiry)) {
    return tokenRecord.token;
  }

  // Generate a fresh one using the User's explicitly supplied credentials
  const newToken = await fetchNewToken(provider, userId);
  
  await prisma.oauthToken.upsert({
    where: { provider_userId: { provider, userId } },
    update: { token: newToken, expiry: calculateExpiry() },
    create: { provider, userId, token: newToken, expiry: calculateExpiry() }
  });

  return newToken;
}

function isTokenExpired(expiry) {
  return new Date().getTime() > expiry;
}

async function fetchNewToken(provider, userId) {
  const cred = await prisma.integrationCredential.findUnique({
    where: { provider_userId: { provider, userId } }
  });
  if (!cred) throw new Error(`Integration configuration missing for ${provider}`);

  if (provider === 'google') {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken,
      grant_type: 'refresh_token',
    });
    return response.data.access_token;
  } else if (provider === 'microsoft') {
    const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken,
      grant_type: 'refresh_token',
    });
    return response.data.access_token;
  }
  throw new Error('Unsupported provider');
}

function calculateExpiry() {
  return new Date().getTime() + 3600 * 1000;
}

module.exports = { getOAuthToken };
