import { db } from "@/db";
import { jobs } from "@/db/schema";
import { upsertCompany, NEGATIVE_TITLE_RE } from "@/lib/ingest/run";
import { dedupeKey, coarseKey } from "@/lib/ingest/dedupe";
import { isBlockedCompany } from "@/lib/ingest/blocklist";
import { detectAts } from "@/lib/ats/detect";
import { loadState, saveState } from "./discover";
import { loadCoarseKeys } from "./coarse";

/**
 * Remote-US aggregator scout: Remotive's public software-dev feed (keyless).
 * Remote-only by nature, so it covers the remote_us slice of the target.
 * Gated to twice a day; postings enter quietly on the first scan and as
 * normal releases afterwards (same seeding semantics as the board scout).
 */

const FEED = "https://remotive.com/api/remote-jobs?category=software-dev&limit=400";
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

const EARLY_RE = /\b(new\s*grad|graduate|university|college|early\s*career|entry[\s-]?level|junior|associate|intern(ship)?|engineer\s+i\b)\b/i;
const US_OK_RE = /\b(usa|united states|u\.s\.|americas|worldwide|anywhere|northern america)\b/i;

export type ScoutRemoteResult = { skipped: boolean; seen: number; newJobIds: number[]; seeded: number };

export async function scoutRemote(): Promise<ScoutRemoteResult> {
  const state = loadState();
  if (Date.now() - (state.lastRemoteScanAt ?? 0) < MIN_INTERVAL_MS) {
    return { skipped: true, seen: 0, newJobIds: [], seeded: 0 };
  }
  const firstScan = !state.lastRemoteScanAt;

  const res = await fetch(FEED, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { skipped: false, seen: 0, newJobIds: [], seeded: 0 };
  const data = (await res.json()) as {
    jobs?: Array<{ title: string; company_name: string; candidate_required_location?: string; url: string }>;
  };

  const existingKeys = new Set(db.select({ k: jobs.dedupeKey }).from(jobs).all().map((r) => r.k));
  const coarseKeys = loadCoarseKeys();
  const now = new Date();
  const newJobIds: number[] = [];
  let seeded = 0;

  for (const j of data.jobs ?? []) {
    if (!EARLY_RE.test(j.title)) continue;
    if (NEGATIVE_TITLE_RE.test(j.title)) continue;
    if (isBlockedCompany(j.company_name)) continue;
    const loc = j.candidate_required_location ?? "";
    if (loc && !US_OK_RE.test(loc)) continue; // must allow US candidates
    const locationRaw = loc ? `Remote (${loc})` : "Remote, US";
    const key = dedupeKey(j.company_name, j.title, locationRaw);
    if (existingKeys.has(key)) continue;
    const ck = coarseKey(j.company_name, j.title, "remote_us");
    if (coarseKeys.has(ck)) continue;
    existingKeys.add(key);
    coarseKeys.add(ck);
    const companyId = await upsertCompany(j.company_name);
    const [inserted] = await db
      .insert(jobs)
      .values({
        companyId,
        title: j.title,
        kind: /intern(ship)?/i.test(j.title) ? "internship" : "new-grad",
        locationRaw,
        locationClass: "remote_us",
        applyUrl: j.url,
        atsType: detectAts(j.url),
        sourceRepos: ["scout:remotive"],
        status: "discovered",
        dedupeKey: key,
        backfilled: firstScan,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: jobs.id });
    if (firstScan) seeded += 1;
    else newJobIds.push(inserted.id);
  }

  const fresh = loadState(); // don't clobber fields written by other scouts meanwhile
  fresh.lastRemoteScanAt = Date.now();
  saveState(fresh);
  return { skipped: false, seen: data.jobs?.length ?? 0, newJobIds, seeded };
}
