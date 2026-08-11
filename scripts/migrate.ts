import { openDatabase, runMigrations, seedReferenceData } from '../src/lib/db/client';
import { MIGRATIONS } from '../src/lib/db/migrations';
import { config } from '../src/lib/config/env';

/**
 * Applies pending migrations and seeds reference data.
 *
 * Safe to run repeatedly and on every deploy: migrations are checksum-verified
 * and applied exactly once, and the seed is idempotent.
 */
function main(): void {
  const cfg = config();
  const database = openDatabase({ migrate: false });
  const result = runMigrations(database, MIGRATIONS);
  seedReferenceData(database);
  database.close();

  process.stdout.write(
    `${cfg.databasePath}\n` +
      (result.applied.length === 0
        ? `already at schema version ${result.current}\n`
        : `applied migration(s) ${result.applied.join(', ')} → schema version ${result.current}\n`),
  );
}

main();
