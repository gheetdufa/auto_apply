import { db } from "@/db";
import { jobs, companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runIngest, type IngestResult } from "@/lib/ingest/run";
import { scoutBoards, type ScoutBoardsResult } from "@/lib/scout/boards";
import { scoutHn, type ScoutHnResult } from "@/lib/scout/hn";
import { scoutRemote, type ScoutRemoteResult } from "@/lib/scout/remote";
import { enrichJob } from "@/lib/enrich";
import { draftJobById } from "@/lib/tailor/draft-job";
import { tailoringReady } from "@/lib/tailor/generate";
import { notifyMac } from "@/lib/notify";

export type PipelineResult = {
  ingest: IngestResult;
  scout: { boards?: ScoutBoardsResult; hn?: ScoutHnResult; remote?: ScoutRemoteResult; error?: string };
  enriched: number;
  drafted: number;
  draftErrors: string[];
  notified: boolean;
};

/**
 * The full loop: ingest all sources → detect newly released jobs →
 * enrich each (final URL, ATS, JD, real form questions) → auto-draft
 * when API key + profile are configured → macOS notification.
 *
 * Backfill runs (first ingest / mass insert) skip enrich/draft/notify —
 * those jobs get enriched lazily when opened in the UI.
 */
export async function runPipeline(opts: { notify: boolean }): Promise<PipelineResult> {
  const ingest = await runIngest();
  const result: PipelineResult = { ingest, scout: {}, enriched: 0, drafted: 0, draftErrors: [], notified: false };

  // Scout: direct ATS board polling every run; HN Who's Hiring at most twice a day.
  const newIds: number[] = ingest.backfill ? [] : [...ingest.newJobIds];
  try {
    const boards = await scoutBoards();
    result.scout.boards = boards;
    if (!boards.backfill) newIds.push(...boards.newJobIds);
    const hn = await scoutHn();
    result.scout.hn = hn;
    newIds.push(...hn.newJobIds); // HN volume is small; backfill flag rarely trips
    const remote = await scoutRemote();
    result.scout.remote = remote;
    newIds.push(...remote.newJobIds);
  } catch (e) {
    result.scout.error = e instanceof Error ? e.message : String(e);
  }

  if (newIds.length === 0) return result;

  const ready = tailoringReady();
  // Enrich + draft in small parallel batches — slow career sites must not serialize the run.
  const BATCH = 5;
  for (let i = 0; i < newIds.length; i += BATCH) {
    const batch = newIds.slice(i, i + BATCH);
    const outcomes = await Promise.allSettled(
      batch.map(async (id) => {
        const enriched = await enrichJob(id);
        if (enriched.ok) result.enriched += 1;
        if (ready.ok) await draftJobById(id);
      }),
    );
    if (ready.ok) {
      outcomes.forEach((o, idx) => {
        if (o.status === "fulfilled") result.drafted += 1;
        else result.draftErrors.push(`job ${batch[idx]}: ${o.reason instanceof Error ? o.reason.message : String(o.reason)}`);
      });
    }
  }

  if (opts.notify) {
    const headline = await newJobsHeadline(newIds);
    notifyMac(
      `auto-apply: ${newIds.length} new job${newIds.length === 1 ? "" : "s"}`,
      headline + (result.drafted > 0 ? ` — ${result.drafted} drafted` : ""),
    );
    result.notified = true;
  }

  return result;
}

async function newJobsHeadline(ids: number[]): Promise<string> {
  const rows = await db
    .select({ title: jobs.title, company: companies.name })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, ids[0]));
  const first = rows[0] ? `${rows[0].company} — ${rows[0].title}` : "";
  return ids.length > 1 ? `${first}, +${ids.length - 1} more` : first;
}
