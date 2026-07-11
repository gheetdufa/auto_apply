import { db } from "@/db";
import { jobs, companies, drafts, jobDescriptions, applications } from "@/db/schema";
import { eq, and, ne, desc } from "drizzle-orm";
import { draftJobById } from "@/lib/tailor/draft-job";
import { applyToJob, type ApplyOutcome } from "./index";

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
    await draftJobById(jobId); // enriches (JD + form) then tailors
    [draft] = await db.select().from(drafts).where(eq(drafts.jobId, jobId)).orderBy(desc(drafts.createdAt)).limit(1);
  }
  const [row] = await db
    .select({
      companyId: jobs.companyId,
      applyUrl: jobs.applyUrl,
      finalUrl: jobs.finalUrl,
      atsType: jobs.atsType,
      title: jobs.title,
      company: companies.name,
      jd: jobDescriptions.text,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(jobDescriptions, eq(jobDescriptions.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  if (!row || !draft) throw new Error("job/draft missing");

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
  return outcome;
}
