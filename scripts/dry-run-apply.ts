// Fill a job's real application form WITHOUT submitting, to sanity-check the
// autofill before trusting Auto-apply. Usage: pnpm apply:dry <jobId>
import "./load-env";
import { db } from "../db";
import { jobs, companies, drafts, jobDescriptions, applicationForms } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { applyToJob } from "../lib/apply";

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isFinite(id)) throw new Error("usage: pnpm apply:dry <jobId>");

  const [row] = await db
    .select({
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
    .where(eq(jobs.id, id));
  if (!row) throw new Error(`job ${id} not found`);

  const [draft] = await db.select().from(drafts).where(eq(drafts.jobId, id)).orderBy(desc(drafts.createdAt)).limit(1);
  const [form] = await db.select().from(applicationForms).where(eq(applicationForms.jobId, id));

  // Use the real draft when it exists; otherwise synthesize placeholders.
  const qa =
    draft?.qaJson ??
    (form?.fields ?? [])
      .filter((f) => f.type !== "attachment")
      .map((f) => ({
        question: f.label,
        answer:
          f.type === "select" || f.type === "multiselect"
            ? (f.options?.find((o) => o !== "…") ?? "Yes")
            : `PLACEHOLDER (no draft yet): ${f.label.slice(0, 40)}`,
      }));

  const outcome = await applyToJob({
    url: row.finalUrl ?? row.applyUrl,
    ats: row.atsType,
    qa,
    coverLetterMd: draft?.coverLetterMd ?? "PLACEHOLDER cover letter (no draft yet)",
    company: row.company,
    title: row.title,
    jdText: row.jd ?? "",
    submit: false,
    headless: process.env.HEADLESS !== "0" ? true : false,
    jobTag: `dryrun-${id}`,
  });
  console.log(JSON.stringify(outcome, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
