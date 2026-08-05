import { readFileSync, existsSync } from "node:fs";
import { normalizeCompany } from "./dedupe";
import { isEarlyCareerTitle } from "./early-career";

/**
 * Big-tech company blocklist (config/company-blocklist.json) — postings from
 * these companies are skipped for generic / senior roles (Amazon-tier spray
 * is usually low-ROI). Early-career / new-grad / university titles are an
 * exception: those programs are time-boxed and worth surfacing.
 *
 * Matching is by normalized name, so "Google LLC" / "google" / "Google, Inc."
 * all match a "Google" entry. Edit the JSON to taste; changes apply on the
 * next ingest (`pnpm blocklist:sweep` only skips non-early-career leftovers).
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

export function isBlockedCompany(name: string, opts?: { title?: string }): boolean {
  if (!blockedCompanies().has(normalizeCompany(name))) return false;
  // Mega-tech early-career / new-grad / university programs still get through.
  if (opts?.title && isEarlyCareerTitle(opts.title)) return false;
  return true;
}
