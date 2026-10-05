import path from 'node:path';
import { openDatabase, type OpenPulseDb } from '@/lib/storage/db';

export function memoryDb(): OpenPulseDb {
  return openDatabase(':memory:', { migrationsFolder: path.join(process.cwd(), 'drizzle') });
}
