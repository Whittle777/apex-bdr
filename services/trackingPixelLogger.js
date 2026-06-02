
const prisma = require('./database');
async function logTrackingPixelEvent(prospectId, bento, trackingPixelData) {
  const shard = getShard(bento);
  return await prisma[shard].trackingPixelEvent.create({
    data: {
      prospectId,
      bento,
      trackingPixelData,
    },
  });
}

function getShard(bento) {
  // Simple sharding logic based on bento value
  // For example, you can use a hash function or a modulo operation
  return `shard_${bento % 3}`;
}

module.exports = { logTrackingPixelEvent };
