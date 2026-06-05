const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../services/database');

// User registration
router.post('/', userController.createUser);

// ── MCP bridge token (per-user, hashed at rest) ──────────────────────────────
// Used by the local Claude Desktop MCP server to authenticate as a specific
// user and send through THAT user's connected Microsoft 365 account.
// Plaintext is shown to the user ONCE at generation; we store only the
// SHA-256 hash so a DB leak doesn't expose any tokens.

const hashToken = (plain) => crypto.createHash('sha256').update(plain).digest('hex');

// GET /users/me/mcp-token — status of the current user's MCP token.
// Returns whether one is set + a hint (last 4 chars) + when it was created.
router.get('/me/mcp-token', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { mcpTokenHash: true, mcpTokenHint: true, mcpTokenCreatedAt: true },
    });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({
      configured: !!user.mcpTokenHash,
      hint: user.mcpTokenHint ? `…${user.mcpTokenHint}` : null,
      createdAt: user.mcpTokenCreatedAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /users/me/mcp-token — generate a new token. Returns plaintext ONCE.
// Replaces any existing token (rotates). Hash + hint stored on User.
router.post('/me/mcp-token', authenticateToken, async (req, res) => {
  try {
    const plain = 'apexbdr_' + crypto.randomBytes(24).toString('hex'); // 56 chars total
    const hash  = hashToken(plain);
    const hint  = plain.slice(-4);
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        mcpTokenHash: hash,
        mcpTokenHint: hint,
        mcpTokenCreatedAt: new Date(),
      },
    });
    res.json({
      token: plain,
      hint:  `…${hint}`,
      createdAt: new Date().toISOString(),
      note: 'Save this now — it will not be shown again.',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /users/me/mcp-token — revoke. Existing Claude Desktop config
// using this token immediately stops working on the next call.
router.delete('/me/mcp-token', authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: { mcpTokenHash: null, mcpTokenHint: null, mcpTokenCreatedAt: null },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all users (protected)
router.get('/', authenticateToken, userController.getAllUsers);

// Get single user by ID (protected)
router.get('/:id', authenticateToken, userController.getUserById);

// Update user by ID (protected)
router.put('/:id', authenticateToken, userController.updateUser);

// Delete user by ID (protected)
router.delete('/:id', authenticateToken, userController.deleteUser);

module.exports = router;
