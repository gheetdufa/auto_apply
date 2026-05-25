import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.DB_PATH ?? "./data/db.sqlite";

declare global {
  // eslint-disable-next-line no-var
  var __sqlite: Database.Database | undefined;
}

function getSqlite() {
  if (!global.__sqlite) {
    if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });
    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    global.__sqlite = sqlite;
  }
  return global.__sqlite;
}

export const db = drizzle(getSqlite(), { schema });
export { schema };
