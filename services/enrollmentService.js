
const prisma = require('./database');
/**
 * Enroll one or more prospects into a sequence.
 * Safe to call multiple times — uses upsert so re-enrolling a completed/opted-out
 * prospect reactivates them from step 0.
 */
async function enrollProspects(sequenceId, prospectIds, enrolledById = null) {
  const seq = await prisma.sequence.findUnique({
    where: { id: sequenceId },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
  if (!seq) throw new Error(`Sequence ${sequenceId} not found`);

  const firstStep = seq.steps[0];
  const nextStepDue = firstStep ? addDays(new Date(), firstStep.delayDays) : null;

  const results = await Promise.all(
    prospectIds.map((prospectId) =>
      prisma.sequenceEnrollment.upsert({
        where: { prospectId_sequenceId: { prospectId, sequenceId } },
        update: {
          status: 'active',
          currentStepOrder: 0,
          nextStepDue,
          completedAt: null,
          optedOutAt: null,
          pausedAt: null,
          pausedReason: null,
          enrolledById,
        },
        create: {
          prospectId,
          sequenceId,
          currentStepOrder: 0,
          status: 'active',
          nextStepDue,
          enrolledById,
        },
        include: { prospect: true },
      })
    )
  );

  // Add the enrolling rep (and sequence owner) as prospect owners
  if (enrolledById) {
    const ownerIds = [...new Set([enrolledById, seq.userId].filter(Boolean))];
    await Promise.all(
      prospectIds.flatMap((prospectId) =>
        ownerIds.map((userId) =>
          prisma.prospectOwner.upsert({
            where: { prospectId_userId: { prospectId, userId } },
            update: {},
            create: { prospectId, userId },
          })
        )
      )
    );
    // Update ownedById to the enrolling rep (most recent sequencer)
    await prisma.prospect.updateMany({
      where: { id: { in: prospectIds } },
      data: { ownedById: enrolledById },
    });
  }

  return results;
}

/**
 * Unenroll (remove) a prospect from a sequence entirely.
 */
async function unenrollProspect(sequenceId, prospectId) {
  return prisma.sequenceEnrollment.delete({
    where: { prospectId_sequenceId: { prospectId, sequenceId } },
  });
}

/**
 * Mark enrollment as opted_out. Stops future emails and records the time.
 * Also sets Prospect.status to "Not Interested".
 */
async function optOutProspect(sequenceId, prospectId) {
  const [enrollment] = await Promise.all([
    prisma.sequenceEnrollment.update({
      where: { prospectId_sequenceId: { prospectId, sequenceId } },
      data: { status: 'opted_out', optedOutAt: new Date(), nextStepDue: null },
    }),
    prisma.prospect.update({
      where: { id: prospectId },
      data: { status: 'Not Interested' },
    }),
  ]);
  return enrollment;
}

/**
 * Pause an enrollment with an optional reason.
 */
async function pauseEnrollment(sequenceId, prospectId, reason = null) {
  return prisma.sequenceEnrollment.update({
    where: { prospectId_sequenceId: { prospectId, sequenceId } },
    data: { status: 'paused', pausedAt: new Date(), pausedReason: reason, nextStepDue: null },
  });
}

/**
 * Resume a paused enrollment. Schedules the next step due now.
 */
async function resumeEnrollment(sequenceId, prospectId) {
  const enrollment = await prisma.sequenceEnrollment.findUnique({
    where: { prospectId_sequenceId: { prospectId, sequenceId } },
    include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } } },
  });
  if (!enrollment) throw new Error('Enrollment not found');

  const nextStep = enrollment.sequence.steps.find(
    (s) => s.order > enrollment.currentStepOrder
  );

  return prisma.sequenceEnrollment.update({
    where: { prospectId_sequenceId: { prospectId, sequenceId } },
    data: {
      status: 'active',
      pausedAt: null,
      pausedReason: null,
      resumeAt: null,
      nextStepDue: nextStep ? new Date() : null,
    },
  });
}

/**
 * Pause an enrollment because the prospect is Out of Office.
 * Decrements currentStepOrder by 1 so the same step is retried when resumed.
 * resumeAt defaults to 7 days from now if returnDate is not provided or is in the past.
 */
async function pauseForOoo(sequenceId, prospectId, returnDate = null) {
  const enrollment = await prisma.sequenceEnrollment.findUnique({
    where: { prospectId_sequenceId: { prospectId, sequenceId } },
  });
  if (!enrollment) throw new Error('Enrollment not found');

  const minResumeAt = addDays(new Date(), 1);
  const fallbackResumeAt = addDays(new Date(), 7);

  let resumeAt;
  if (returnDate && returnDate > minResumeAt) {
    // Add 1-day buffer so we don't send the moment they're back
    resumeAt = addDays(returnDate, 1);
  } else {
    resumeAt = fallbackResumeAt;
  }

  // Decrement currentStepOrder so the same step is retried when the cron resumes
  const retryStepOrder = Math.max(0, enrollment.currentStepOrder - 1);

  return prisma.sequenceEnrollment.update({
    where: { prospectId_sequenceId: { prospectId, sequenceId } },
    data: {
      status: 'paused',
      pausedAt: new Date(),
      pausedReason: 'ooo',
      resumeAt,
      nextStepDue: null,
      currentStepOrder: retryStepOrder,
    },
  });
}

/**
 * Mark that a prospect replied. Stops sequence and updates Prospect status.
 */
async function markReplied(sequenceId, prospectId) {
  const [enrollment] = await Promise.all([
    prisma.sequenceEnrollment.update({
      where: { prospectId_sequenceId: { prospectId, sequenceId } },
      data: { status: 'replied', nextStepDue: null },
    }),
    prisma.prospect.update({
      where: { id: prospectId },
      data: { status: 'Replied' },
    }),
  ]);
  return enrollment;
}

/**
 * Record that a step email was sent, advance the enrollment to the next step.
 * Creates an EmailActivity record.
 * externalMessageId: Nodemailer Message-ID stored for reply-thread matching.
 */
async function recordStepSent(enrollment, step, externalMessageId = null) {
  const nextStep = await prisma.sequenceStep.findFirst({
    where: { sequenceId: enrollment.sequenceId, order: { gt: step.order } },
    orderBy: { order: 'asc' },
  });

  const nextStepDue = nextStep ? addDays(new Date(), nextStep.delayDays) : null;
  const isComplete = !nextStep;

  const [activity] = await Promise.all([
    prisma.emailActivity.create({
      data: {
        prospectId: enrollment.prospectId,
        sequenceStepId: step.id,
        enrollmentId: enrollment.id,
        status: 'sent',
        subject: step.subject,
        sentAt: new Date(),
        externalMessageId,
      },
    }),
    prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        currentStepOrder: step.order,
        lastContactedAt: new Date(),
        nextStepDue,
        status: isComplete ? 'completed' : 'active',
        completedAt: isComplete ? new Date() : null,
      },
    }),
    prisma.prospect.update({
      where: { id: enrollment.prospectId },
      data: { status: 'In Sequence' },
    }),
  ]);

  return activity;
}

/**
 * Record an open event on the most recent sent EmailActivity for this prospect+step.
 */
async function recordOpen(prospectId, sequenceStepId) {
  const activity = await prisma.emailActivity.findFirst({
    where: { prospectId, sequenceStepId, status: { in: ['sent', 'opened'] } },
    orderBy: { sentAt: 'desc' },
  });
  if (!activity) return null;
  return prisma.emailActivity.update({
    where: { id: activity.id },
    data: { status: 'opened', openedAt: activity.openedAt || new Date() },
  });
}

/**
 * Record a link click on the most recent sent EmailActivity for this
 * prospect+step. A click implies the email was opened, so openedAt and
 * status are backfilled too.
 */
async function recordClick(prospectId, sequenceStepId) {
  const activity = await prisma.emailActivity.findFirst({
    where: { prospectId, sequenceStepId, status: { in: ['sent', 'opened'] } },
    orderBy: { sentAt: 'desc' },
  });
  if (!activity) return null;
  return prisma.emailActivity.update({
    where: { id: activity.id },
    data: {
      status: 'opened',
      openedAt: activity.openedAt || new Date(),
      clickedAt: activity.clickedAt || new Date(),
      clickCount: { increment: 1 },
    },
  });
}

/**
 * Get all active enrollments where nextStepDue is now or in the past.
 * Used by the cron scheduler to find what to send.
 */
async function getDueEnrollments() {
  return prisma.sequenceEnrollment.findMany({
    where: {
      status: 'active',
      nextStepDue: { lte: new Date() },
    },
    include: {
      prospect: true,
      sequence: {
        include: { steps: { orderBy: { order: 'asc' } } },
      },
    },
  });
}

/**
 * Get enrollment summary for a prospect across all sequences.
 */
async function getProspectEnrollments(prospectId) {
  return prisma.sequenceEnrollment.findMany({
    where: { prospectId },
    include: {
      sequence: {
        select: {
          id: true,
          name: true,
          steps: { orderBy: { order: 'asc' } },
        },
      },
    },
    orderBy: { enrolledAt: 'desc' },
  });
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

module.exports = {
  enrollProspects,
  unenrollProspect,
  optOutProspect,
  pauseEnrollment,
  pauseForOoo,
  resumeEnrollment,
  markReplied,
  recordStepSent,
  recordOpen,
  recordClick,
  getDueEnrollments,
  getProspectEnrollments,
};
