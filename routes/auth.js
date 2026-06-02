const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const prisma = require('../services/database');
const { authenticateToken } = require('../middleware/auth');

const isDemoMode = () => process.env.DEMO_MODE === 'true';

// GET /auth/config — public bootstrap endpoint. Tells the frontend which
// sign-in methods are available without exposing secrets.
router.get('/config', (req, res) => {
  res.json({
    demoMode: isDemoMode(),
    microsoftConfigured: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
  });
});

// POST /auth/demo-login — only available when DEMO_MODE=true.
// Mints a 1-day JWT for a synthetic demo user so people (including IT
// reviewers) can poke around without going through Microsoft SSO.
// Disable by removing the env var.
router.post('/demo-login', async (req, res) => {
  if (!isDemoMode()) {
    return res.status(404).json({ message: 'Not found' });
  }
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: 'JWT_SECRET not configured' });
  }
  try {
    const user = await prisma.user.upsert({
      where: { email: 'demo@apex-bdr.local' },
      update: { name: 'Demo User' },
      create: { email: 'demo@apex-bdr.local', name: 'Demo User' },
    });
    const token = jwt.sign(
      { userId: user.id, demo: true },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, demo: true } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /auth/me — returns the current user's profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
