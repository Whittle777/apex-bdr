const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const prisma = require('../services/database');
router.use(authenticateToken);

router.post('/', async (req, res) => {
  const {
    sequenceId, order, delayDays, subject, body, stepType,
    aiPersonalize, aiPurpose, aiInstructions, aiModel,
  } = req.body;
  try {
    const step = await prisma.sequenceStep.create({
      data: {
        sequenceId,
        order,
        stepType: stepType ?? 'AUTO_EMAIL',
        delayDays: delayDays ?? 0,
        subject: subject ?? '',
        body: body ?? '',
        aiPersonalize: !!aiPersonalize,
        aiPurpose: aiPurpose || null,
        aiInstructions: aiInstructions || null,
        aiModel: aiModel || null,
      }
    });
    res.status(201).json(step);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const steps = await prisma.sequenceStep.findMany();
    res.json(steps);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const step = await prisma.sequenceStep.findUnique({ where: { id: parseInt(id) } });
    if (step) {
      res.json(step);
    } else {
      res.status(404).json({ message: 'Sequence Step not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    order, delayDays, subject, body, stepType,
    aiPersonalize, aiPurpose, aiInstructions, aiModel,
  } = req.body;
  try {
    const step = await prisma.sequenceStep.update({
      where: { id: parseInt(id) },
      data: {
        order, delayDays, subject, body,
        ...(stepType && { stepType }),
        ...(aiPersonalize !== undefined  && { aiPersonalize: !!aiPersonalize }),
        ...(aiPurpose !== undefined      && { aiPurpose: aiPurpose || null }),
        ...(aiInstructions !== undefined && { aiInstructions: aiInstructions || null }),
        ...(aiModel !== undefined        && { aiModel: aiModel || null }),
      }
    });
    res.json(step);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.sequenceStep.delete({ where: { id: parseInt(id) } });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
