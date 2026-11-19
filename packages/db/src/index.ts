import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export { sql, eq, and, or, desc, asc, inArray, isNull, isNotNull, gte, lte, lt, gt, ilike, ne, count } from "drizzle-orm";

export type DB = PostgresJsDatabase<typeof schema>;

let _db: DB | undefined;
let _client: postgres.Sql | undefined;

export function getDb(url = process.env.DATABASE_URL): DB {
  if (_db) return _db;
  if (!url) throw new Error("DATABASE_URL is not set");
  _client = postgres(url, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    onnotice: () => {},
  });
  _db = drizzle(_client, { schema });
  return _db;
}

export async function closeDb() {
  await _client?.end({ timeout: 5 });
  _db = undefined;
  _client = undefined;
}
