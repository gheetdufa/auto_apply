import { createHash } from "node:crypto";

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|corp|corporation|co|labs|technologies|tech|the)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // Keep intern / co-op / new-grad tokens — firms like Jane Street reuse the
    // same base title across employment types (metadata-only distinction).
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(20\d{2}|i{2,3}|sr|jr|university|college|summer|fall|spring|winter|full[\s-]?time|experienced)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLocation(loc: string): string {
  return loc.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 40);
}

export function dedupeKey(company: string, title: string, location: string): string {
  const key = `${normalizeCompany(company)}|${normalizeTitle(title)}|${normalizeLocation(location)}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/**
 * Cross-source duplicate guard. Different sources write the same location
 * differently ("SF" vs "San Francisco, California, United States"), which
 * defeats the exact dedupeKey — so the coarse key buckets by location CLASS.
 */
export function coarseKey(company: string, title: string, locationClass: string): string {
  return `${normalizeCompany(company)}|${normalizeTitle(title)}|${locationClass}`;
}
