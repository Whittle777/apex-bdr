const express = require('express');
const router = express.Router();

const prisma = require('../services/database');
// Get all saved agentic lists
router.get('/', async (req, res) => {
  try {
    const lists = await prisma.prospectList.findMany({
      include: {
        _count: { select: { prospects: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(lists);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific list with full prospect items
router.get('/:id', async (req, res) => {
  try {
    const list = await prisma.prospectList.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { prospects: true }
    });
    if (!list) return res.status(404).json({ error: 'List not found' });
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update list metadata (editable title)
router.put('/:id', async (req, res) => {
  try {
    const { title, description } = req.body;
    const updated = await prisma.prospectList.update({
      where: { id: parseInt(req.params.id) },
      data: { title, description }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove a prospect from a list (editable arrays)
router.delete('/:id/prospects/:prospectId', async (req, res) => {
  try {
    const listId = parseInt(req.params.id);
    const prospectId = parseInt(req.params.prospectId);
    
    await prisma.prospectList.update({
      where: { id: listId },
      data: {
        prospects: {
          disconnect: { id: prospectId }
        }
      }
    });
    res.json({ message: 'Prospect removed from list successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
