import { readFileSync, existsSync } from "node:fs";
import { normalizeCompany } from "./dedupe";

/**
 * Big-tech company blocklist (config/company-blocklist.json) — postings from
 * these companies are never ingested. Matching is by normalized name, so
 * "Google LLC" / "google" / "Google, Inc." all match a "Google" entry.
 * Edit the JSON to taste; changes apply on the next ingest run
 * (`pnpm blocklist:sweep` retroactively skips already-ingested jobs).
 */

const BLOCKLIST_PATH = "./config/company-blocklist.json";

let cached: Set<string> | null = null;

export function blockedCompanies(): Set<string> {
  if (!cached) {
    const names = existsSync(BLOCKLIST_PATH)
      ? (JSON.parse(readFileSync(BLOCKLIST_PATH, "utf-8")) as string[])
      : [];
    cached = new Set(names.map(normalizeCompany).filter(Boolean));
  }
  return cached;
}

export function isBlockedCompany(name: string): boolean {
  return blockedCompanies().has(normalizeCompany(name));
}
