// services/worker.js

const prisma = require('./database');
const aiAgent = require('./aiAgent');

class Worker {
  async executeTask(task) {
    try {
      await aiAgent.executeTask(task);
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'COMPLETED' },
      });
    } catch (error) {
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'FAILED', error: error.message },
      });
    }
  }
}

module.exports = Worker;
