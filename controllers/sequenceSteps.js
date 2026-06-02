
const prisma = require('../services/database');
const { createSequenceStep, updateSequenceStep } = require('../models/SequenceStep');

exports.getAllSequenceSteps = async (req, res) => {
  try {
    const sequenceSteps = await prisma.sequenceStep.findMany();
    res.json(sequenceSteps);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sequence steps' });
  }
};

exports.getSequenceStepById = async (req, res) => {
  try {
    const sequenceStep = await prisma.sequenceStep.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!sequenceStep) {
      return res.status(404).json({ error: 'Sequence step not found' });
    }
    res.json(sequenceStep);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sequence step' });
  }
};

exports.createSequenceStep = async (req, res) => {
  try {
    const { sequenceId, order, delayDays, subject, body, bento } = req.body;
    const sequenceStep = await createSequenceStep(sequenceId, order, delayDays, subject, body, bento);
    res.status(201).json(sequenceStep);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create sequence step' });
  }
};

exports.updateSequenceStep = async (req, res) => {
  try {
    const { order, delayDays, subject, body, bento, state } = req.body;
    const sequenceStep = await updateSequenceStep(parseInt(req.params.id), order, delayDays, subject, body, bento, state);
    res.json(sequenceStep);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update sequence step' });
  }
};

exports.deleteSequenceStep = async (req, res) => {
  try {
    const sequenceStep = await prisma.sequenceStep.delete({
      where: { id: parseInt(req.params.id) },
    });
    res.json(sequenceStep);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete sequence step' });
  }
};
