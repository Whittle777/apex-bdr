// services/taskQueue.js

const prisma = require('./database');
const Worker = require('./worker');

class TaskQueue {
  constructor() {
    this.worker = new Worker();
  }

  async addTask(task) {
    return await prisma.task.create({
      data: task,
    });
  }

  async getPendingTasks() {
    return await prisma.task.findMany({
      where: { status: 'PENDING' },
    });
  }

  async updateTask(id, status) {
    return await prisma.task.update({
      where: { id: parseInt(id) },
      data: { status },
    });
  }

  async executePendingTasks() {
    const pendingTasks = await this.getPendingTasks();
    for (const task of pendingTasks) {
      await this.worker.executeTask(task);
    }
  }
}

module.exports = new TaskQueue();
