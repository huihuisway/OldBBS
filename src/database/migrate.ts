import 'reflect-metadata';
import { AppDataSource } from './data-source';

async function main() {
  const action = process.argv[2] === 'revert' ? 'revert' : 'migrate';
  try {
    await AppDataSource.initialize();
    if (action === 'revert') {
      await AppDataSource.undoLastMigration();
      console.log('Reverted the last OldBBS migration.');
    } else {
      const applied = await AppDataSource.runMigrations();
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is already up to date.');
    }
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
