
const prisma = require('./database');
class DealsService {
  async createDeal(dealData) {
    return await prisma.deal.create({ data: dealData });
  }

  async getDealById(id) {
    return await prisma.deal.findUnique({ where: { id } });
  }

  async updateDeal(id, dealData) {
    return await prisma.deal.update({ where: { id }, data: dealData });
  }

  async deleteDeal(id) {
    return await prisma.deal.delete({ where: { id } });
  }

  async getAllDeals() {
    return await prisma.deal.findMany();
  }
}

module.exports = new DealsService();
