import { db } from "@/db";
import { jobs, companies, jobDescriptions, applicationForms, drafts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { enrichJob } from "@/lib/enrich";
import { generateDraft } from "./generate";

/**
 * Generate and store a tailored draft for a job. Enriches first if the JD
 * hasn't been fetched yet. Used by both the watcher (auto-draft) and the UI.
 */
export async function draftJobById(jobId: number): Promise<{ draftId: number }> {
  let [row] = await loadJob(jobId);
  if (!row) throw new Error("job not found");

  if (!row.jd) {
    const enriched = await enrichJob(jobId);
    if (!enriched.ok) throw new Error(`enrich failed: ${enriched.error}`);
    [row] = await loadJob(jobId);
    if (!row?.jd) throw new Error("no job description after enrichment");
  }

  const { result, model } = await generateDraft({
    company: row.company,
    title: row.title,
    locationRaw: row.locationRaw,
    jdText: row.jd,
    formFields: row.formFields,
    formSource: row.formSource ?? "fallback",
  });

  const [inserted] = await db
    .insert(drafts)
    .values({ jobId, coverLetterMd: result.coverLetterMd, qaJson: result.qa, model })
    .returning({ id: drafts.id });
  await db.update(jobs).set({ status: "drafted", updatedAt: new Date() }).where(eq(jobs.id, jobId));
  return { draftId: inserted.id };
}

function loadJob(jobId: number) {
  return db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      locationRaw: jobs.locationRaw,
      company: companies.name,
      jd: jobDescriptions.text,
      formFields: applicationForms.fields,
      formSource: applicationForms.source,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(jobDescriptions, eq(jobDescriptions.jobId, jobs.id))
    .leftJoin(applicationForms, eq(applicationForms.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
}
