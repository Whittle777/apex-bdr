
const prisma = require('./database');
const DoubleWriteStrategy = require('../doubleWriteStrategy');
const config = require('../config');
const BackupService = require('../services/backup');

class Migration {
  constructor() {
    this.doubleWriteStrategy = new DoubleWriteStrategy();
    this.config = config.getConfig();
    this.doubleWriteStrategy.setLegacyDatastore(this.config.legacyDatastore);
    this.doubleWriteStrategy.setNewDatastore(this.config.newDatastore);
    this.backupService = new BackupService();
  }

  async migrateProspects() {
    try {
      // Create a backup before starting the migration
      await this.backupService.createBackup();

      // Fetch all prospects from the legacy datastore
      const legacyProspects = await this.fetchLegacyProspects();

      // Migrate each prospect to the new datastore using double-write strategy
      for (const prospect of legacyProspects) {
        await this.doubleWriteStrategy.write({
          type: 'prospect',
          data: {
            firstName: prospect.firstName,
            lastName: prospect.lastName,
            email: prospect.email,
            companyName: prospect.companyName,
            status: prospect.status,
            phoneNumber: prospect.phoneNumber,
          },
        });
      }

      console.log('Prospect migration completed successfully.');
    } catch (error) {
      console.error('Error during prospect migration:', error);
      // In case of error, revert to the backup
      await this.backupService.restoreBackup();
      console.error('Rollback to backup completed.');
    }
  }

  async fetchLegacyProspects() {
    // Implement logic to fetch prospects from the legacy datastore
    // For now, let's assume it's a no-op and return some dummy data
    return [
      {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        companyName: 'Example Corp',
        status: 'Uncontacted',
        phoneNumber: '123-456-7890',
      },
    ];
  }
}

module.exports = Migration;
