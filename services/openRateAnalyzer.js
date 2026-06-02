
const prisma = require('./database');
const { analyzeSentiment } = require('./llm');

async function analyzeOpenRates(messages) {
  for (const message of messages) {
    const { prospectId, bento } = message;
    const shard = getShard(bento);
    const trackingPixelEvents = await prisma[shard].trackingPixelEvent.findMany({
      where: { prospectId },
    });

    const openCount = trackingPixelEvents.length;
    const totalCount = await prisma[shard].prospect.count({
      where: { id: prospectId },
    });

    const openRate = (openCount / totalCount) * 100;
    console.log(`Open rate for prospectId ${prospectId}: ${openRate.toFixed(2)}%`);

    // Analyze sentiment for each tracking pixel event
    for (const event of trackingPixelEvents) {
      const sentiment = await analyzeSentiment(event.data);
      console.log(`Sentiment for event ${event.id}: ${sentiment}`);
    }
  }
}

function getShard(bento) {
  // Simple sharding logic based on bento value
  // For example, you can use a hash function or a modulo operation
  return `shard_${bento % 3}`;
}

module.exports = { analyzeOpenRates };
