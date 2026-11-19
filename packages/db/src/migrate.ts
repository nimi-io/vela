import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Applies SQL migrations from packages/db/migrations.
 * Usable both from source (tsx) and bundled builds: MIGRATIONS_DIR overrides the folder.
 */
export async function runMigrations(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const folder = process.env.MIGRATIONS_DIR ?? path.resolve(here, "../migrations");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
