
const prisma = require('./database');
const redis = require('redis');

async function handleProspectStatusChange(prospectId, bento, newStatus) {
  const shard = getShard(bento);
  const prospect = await prisma[shard].prospect.findUnique({
    where: { id: prospectId },
  });

  if (!prospect) {
    throw new Error('Prospect not found');
  }

  if (prospect.status === newStatus) {
    console.log('Prospect status is already up to date');
    return;
  }

  await prisma[shard].prospect.update({
    where: { id: prospectId },
    data: { status: newStatus },
  });

  console.log(`Prospect status updated from ${prospect.status} to ${newStatus}`);
}

function getShard(bento) {
  // Simple sharding logic based on bento value
  // For example, you can use a hash function or a modulo operation
  return `shard_${bento % 3}`;
}

async function acquireLock(lockKey) {
  const lockAcquired = await redisClient.set(lockKey, 'locked', {
    NX: true, // Only set if the key does not exist
    EX: 10,   // Expire the lock after 10 seconds
  });
  return lockAcquired === 'OK';
}

async function releaseLock(lockKey) {
  await redisClient.del(lockKey);
}

module.exports = {
  handleProspectStatusChange,
  acquireLock,
  releaseLock,
};
