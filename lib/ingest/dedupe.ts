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
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(20\d{2}|i{2,3}|sr|jr|new grad|university|college|summer|fall|spring|winter|intern(ship)?)\b/g, " ")
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
