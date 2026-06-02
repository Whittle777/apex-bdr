
const prisma = require('./database');
class MetricsService {
  async getConversionRates() {
    // Example query to get conversion rates
    const conversionRates = await prisma.callFlag.findMany({
      select: {
        source: true,
        conversionRate: true,
      },
    });
    return conversionRates;
  }

  async getWinLossStatistics() {
    // Example query to get win/loss statistics
    const winLossStatistics = await prisma.callFlag.findMany({
      select: {
        outcome: true,
        count: true,
      },
    });
    return winLossStatistics;
  }
}

module.exports = new MetricsService();
