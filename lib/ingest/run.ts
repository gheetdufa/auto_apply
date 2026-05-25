import { db } from "@/db";
import { companies, jobs, ingestRuns, type AtsType } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { SOURCES, rawUrl, type RepoSource } from "./sources";
import { parseTables, parseHtmlTables } from "./markdown-table";
import { normalizeRow, type RawJobRow } from "./row-normalizer";
import { dedupeKey, normalizeCompany } from "./dedupe";
import { classify, isTarget } from "./location";
import { detectAts } from "../ats/detect";

const SWE_TITLE_RE =
  /\b(software\s*engineer|swe|sde|software\s*developer|backend|frontend|full[\s-]?stack|infra|infrastructure|platform|systems|mle|ml\s*engineer|ai\s*engineer|data\s*engineer|new\s*grad|intern(ship)?|university|college)\b/i;

const NEGATIVE_TITLE_RE =
  /\b(sales|marketing|recruit(er|ing)|hr\b|human resources|finance|accounting|legal|admin|customer support|operations|teacher|nurse|paralegal|janitor)\b/i;

type CollectedRow = RawJobRow & { sources: string[] };

export async function runIngest(): Promise<{
  totalRowsSeen: number;
  uniqueCandidates: number;
  newJobs: number;
  triagedJobs: number;
  perSource: Record<string, { rowsSeen: number; rowsKept: number; error?: string }>;
}> {
  const [run] = await db.insert(ingestRuns).values({}).returning();

  const perSource: Record<string, { rowsSeen: number; rowsKept: number; error?: string }> = {};
  const collected = new Map<string, CollectedRow>();

  for (const src of SOURCES) {
    perSource[src.key] = { rowsSeen: 0, rowsKept: 0 };
    try {
      const md = await fetchReadme(src);
      let kept = 0;
      let seen = 0;
      const tableIter = function* () {
        yield* parseTables(md);
        yield* parseHtmlTables(md);
      };
      for (const table of tableIter()) {
        let lastCompany = "";
        for (const cells of table.rows) {
          seen += 1;
          const firstCell = cells[0] ?? "";
          const isSubRow = /↳|⤷|`->`|^&nbsp;|^\s*$/i.test(firstCell);
          const row = normalizeRow(table.headers, cells);
          if (!row) continue;
          if (isSubRow && lastCompany) row.company = lastCompany;
          else lastCompany = row.company;
          if (row.isClosed) continue;
          if (NEGATIVE_TITLE_RE.test(row.title)) continue;
          if (!SWE_TITLE_RE.test(row.title)) continue;

          const key = dedupeKey(row.company, row.title, row.locationRaw);
          const existing = collected.get(key);
          if (existing) {
            if (!existing.sources.includes(src.key)) existing.sources.push(src.key);
          } else {
            collected.set(key, { ...row, sources: [src.key] });
          }
          kept += 1;
        }
      }
      perSource[src.key] = { rowsSeen: seen, rowsKept: kept };
    } catch (e) {
      perSource[src.key] = { rowsSeen: 0, rowsKept: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let newJobs = 0;
  let triagedJobs = 0;
  const totalRowsSeen = Object.values(perSource).reduce((s, x) => s + x.rowsSeen, 0);

  for (const [key, row] of collected) {
    const loc = classify(row.locationRaw);
    if (!isTarget(loc)) continue;

    const companyId = await upsertCompany(row.company);
    const ats: AtsType = detectAts(row.applyUrl);

    const existing = db.select().from(jobs).where(eq(jobs.dedupeKey, key)).all();
    if (existing.length > 0) {
      const j = existing[0];
      const merged = Array.from(new Set([...(j.sourceRepos ?? []), ...row.sources]));
      if (merged.length !== (j.sourceRepos ?? []).length) {
        await db.update(jobs).set({ sourceRepos: merged, updatedAt: new Date() }).where(eq(jobs.id, j.id));
      }
      continue;
    }

    await db.insert(jobs).values({
      companyId,
      title: row.title,
      locationRaw: row.locationRaw,
      locationClass: loc,
      applyUrl: row.applyUrl,
      atsType: ats,
      postedDate: row.postedDate,
      sourceRepos: row.sources,
      status: "discovered",
      dedupeKey: key,
    });
    newJobs += 1;
    triagedJobs += 1;
  }

  await db
    .update(ingestRuns)
    .set({
      finishedAt: new Date(),
      status: "ok",
      newJobs,
      triagedJobs,
    })
    .where(eq(ingestRuns.id, run.id));

  return { totalRowsSeen, uniqueCandidates: collected.size, newJobs, triagedJobs, perSource };
}

async function fetchReadme(src: RepoSource): Promise<string> {
  const res = await fetch(rawUrl(src), { headers: { "User-Agent": "auto-apply/0.1" } });
  if (!res.ok) {
    if (res.status === 404) {
      const alt = await fetch(rawUrl({ ...src, branch: src.branch === "main" ? "master" : "main" }), {
        headers: { "User-Agent": "auto-apply/0.1" },
      });
      if (alt.ok) return alt.text();
    }
    throw new Error(`${src.key}: HTTP ${res.status}`);
  }
  return res.text();
}

async function upsertCompany(displayName: string): Promise<number> {
  const normalized = normalizeCompany(displayName);
  const existing = db.select().from(companies).where(eq(companies.normalizedName, normalized)).all();
  if (existing.length > 0) return existing[0].id;
  const [inserted] = await db
    .insert(companies)
    .values({ name: displayName, normalizedName: normalized })
    .returning({ id: companies.id });
  return inserted.id;
}

export async function totalJobCount(): Promise<number> {
  const r = await db.select({ n: sql<number>`count(*)` }).from(jobs);
  return r[0]?.n ?? 0;
}
