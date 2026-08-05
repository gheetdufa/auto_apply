import { db } from "@/db";
import { jobs, companies, drafts, jobDescriptions, applications } from "@/db/schema";
import { eq, and, ne, desc } from "drizzle-orm";
import { draftJobById } from "@/lib/tailor/draft-job";
import { applyToJob, type ApplyOutcome } from "./index";
import { tailorResumeForJob, jobResumePdfPath } from "@/lib/resume/compile-job";
import { existsSync } from "node:fs";

export type RunApplyResult = { blocked: string } | ApplyOutcome;

/**
 * The full apply flow for one job: ensure draft → double-apply guard →
 * drive the browser → record EXACTLY what was submitted in `applications`.
 * Shared by the API route and the batch CLI.
 */
export async function runApplyForJob(
  jobId: number,
  opts: { force?: boolean; headless?: boolean; submit?: boolean } = {},
): Promise<RunApplyResult> {
  let [draft] = await db.select().from(drafts).where(eq(drafts.jobId, jobId)).orderBy(desc(drafts.createdAt)).limit(1);
  if (!draft) {
    await draftJobById(jobId); // enriches (JD + form) then tailors draft + resume
    [draft] = await db.select().from(drafts).where(eq(drafts.jobId, jobId)).orderBy(desc(drafts.createdAt)).limit(1);
  }
  const [row] = await db
    .select({
      companyId: jobs.companyId,
      applyUrl: jobs.applyUrl,
      finalUrl: jobs.finalUrl,
      atsType: jobs.atsType,
      title: jobs.title,
      kind: jobs.kind,
      company: companies.name,
      jd: jobDescriptions.text,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(jobDescriptions, eq(jobDescriptions.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  if (!row || !draft) throw new Error("job/draft missing");

  // Ensure a per-job resume exists (older drafts may predate this feature).
  if (!existsSync(jobResumePdfPath(jobId)) && row.jd) {
    try {
      tailorResumeForJob({ jobId, kind: row.kind, title: row.title, jdText: row.jd });
    } catch (e) {
      console.warn(`[apply] resume tailor failed for job ${jobId}:`, e instanceof Error ? e.message : e);
    }
  }

  // Double-apply guard: same company, another job already applied.
  if (!opts.force) {
    const [dup] = await db
      .select({ id: jobs.id, title: jobs.title })
      .from(jobs)
      .where(and(eq(jobs.companyId, row.companyId), eq(jobs.status, "applied"), ne(jobs.id, jobId)))
      .limit(1);
    if (dup) {
      return { blocked: `already applied to ${row.company} — "${dup.title}" (job ${dup.id})` };
    }
  }

  const outcome = await applyToJob({
    url: row.finalUrl ?? row.applyUrl,
    ats: row.atsType,
    qa: draft.qaJson,
    coverLetterMd: draft.coverLetterMd,
    company: row.company,
    title: row.title,
    jdText: row.jd ?? "",
    kind: row.kind,
    jobId,
    submit: opts.submit ?? process.env.AUTO_SUBMIT !== "0",
    headless: opts.headless,
    jobTag: `${jobId}-${Date.now()}`,
  });

  // Audit trail — every attempt is recorded, not just successes.
  await db.insert(applications).values({
    jobId,
    outcome: outcome.status,
    answersJson: outcome.answers,
    resumeAttached: outcome.resumeAttached,
    screenshot: outcome.screenshot,
    message: outcome.message,
  });

  if (outcome.status === "submitted") {
    await db
      .update(jobs)
      .set({ status: "applied", notes: `auto-applied ${new Date().toISOString()}`, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
  }

  // Manual-finish watcher: the window stayed open and applyToJob keeps driving
  // it (auto-filling the email code after a manual Submit). Wrap the promise so
  // the eventual finish lands in the DB — batch awaits it; the API route lets
  // it run on in the server process.
  if (outcome.status === "needs_attention" && outcome.assist) {
    const watched = outcome.assist;
    outcome.assist = watched
      .then(async (fin) => {
        if (!fin) return null;
        await db.insert(applications).values({
          jobId,
          outcome: "submitted",
          answersJson: outcome.answers,
          resumeAttached: outcome.resumeAttached,
          screenshot: fin.screenshot,
          message: "submitted after manual finish in the open window",
        });
        await db
          .update(jobs)
          .set({ status: "applied", notes: `auto-applied ${new Date().toISOString()}`, updatedAt: new Date() })
          .where(eq(jobs.id, jobId));
        console.log(`[apply] job ${jobId}: finished manually in the window — recorded as submitted`);
        return fin;
      })
      .catch(() => null);
  }
  return outcome;
}
