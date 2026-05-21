const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const enforceSchemaTag = require('../middleware/schemaTag');
const scheduling = require('../services/scheduling');

exports.getAllSequences = async (req, res) => {
  try {
    const sequences = await prisma.sequence.findMany({
      include: { prospectEnrollments: { include: { prospect: true } } }
    });
    res.json(sequences);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sequences' });
  }
};

exports.getSequenceById = async (req, res) => {
  try {
    const sequence = await prisma.sequence.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { steps: true },
    });
    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }
    res.json(sequence);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sequence' });
  }
};

exports.createSequence = [
  enforceSchemaTag,
  async (req, res) => {
    try {
      const { name } = req.body;
      const sequence = await prisma.sequence.create({
        data: { name, userId: req.userId, schemaTag: req.body.schemaTag || 'default' },
      });
      res.status(201).json(sequence);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create sequence', details: error.message, stack: error.stack });
    }
  }
];

exports.updateSequence = [
  enforceSchemaTag,
  async (req, res) => {
    try {
      const { name, interval, nextRun } = req.body;
      const sequence = await prisma.sequence.update({
        where: { id: parseInt(req.params.id) },
        data: { name, interval, nextRun },
      });
      res.json(sequence);
    } catch (error) {
      res.status(500).json({ error: 'Failed to update sequence' });
    }
  }
];

exports.deleteSequence = async (req, res) => {
  try {
    const sequence = await prisma.sequence.delete({
      where: { id: parseInt(req.params.id) },
    });
    res.json(sequence);
  } catch (error) {
    // Surface the real Prisma error so foreign-key / constraint issues aren't
    // hidden behind a generic message. See createSequence for the same pattern.
    console.error('[deleteSequence] failed', error);
    res.status(500).json({
      error: 'Failed to delete sequence',
      details: error.message,
      code: error.code,
    });
  }
};

exports.scheduleSequence = async (req, res) => {
  try {
    const { sequenceId, bento } = req.body;
    const nextRun = await scheduling.scheduleSequence(sequenceId, bento);
    res.json({ nextRun });
  } catch (error) {
    res.status(500).json({ error: 'Failed to schedule sequence' });
  }
};
