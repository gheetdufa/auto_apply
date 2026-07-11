import { db } from "@/db";
import { jobs, companies, jobDescriptions, applicationForms } from "@/db/schema";
import { eq } from "drizzle-orm";
import { follow, fetchJdFromPage, type FetchedPage } from "@/lib/jd/fetch";
import { fetchFormFields, greenhouseJobRef, probeGreenhouseBoard } from "@/lib/ats/questions";

export type EnrichResult = {
  ok: boolean;
  jdLength: number;
  formSource: "greenhouse" | "fallback";
  error?: string;
};

/**
 * Everything a job needs before it can be drafted, in one pass:
 * resolve redirects → persist finalUrl + real ATS → fetch JD → fetch real form questions.
 * Safe to re-run; each step upserts.
 */
export async function enrichJob(jobId: number): Promise<EnrichResult> {
  const [job] = await db
    .select({ id: jobs.id, applyUrl: jobs.applyUrl, atsType: jobs.atsType, company: companies.name })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, jobId));
  if (!job) return { ok: false, jdLength: 0, formSource: "fallback", error: "job not found" };

  try {
    let page: FetchedPage = await follow(job.applyUrl);

    // Embedded gh_jid page whose board token isn't in the static HTML (JS-rendered
    // career sites): probe the API by company-name slugs, then canonicalize the URL
    // so the JD + form fetchers hit the Greenhouse API directly.
    if (/[?&]gh_jid=/i.test(page.url) && !greenhouseJobRef(page.url, page.html)) {
      const probed = await probeGreenhouseBoard(page.url, job.company);
      if (probed) {
        page = { url: `https://boards.greenhouse.io/${probed.board}/jobs/${probed.id}`, html: page.html };
      }
    }

    const jd = await fetchJdFromPage(page, job.atsType);

    await db
      .update(jobs)
      .set({ finalUrl: page.url, atsType: jd.ats, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));

    await db
      .insert(jobDescriptions)
      .values({ jobId, text: jd.text })
      .onConflictDoUpdate({ target: jobDescriptions.jobId, set: { text: jd.text, fetchedAt: new Date() } });

    const form = await fetchFormFields({ url: page.url, html: page.html, ats: jd.ats });
    await db
      .insert(applicationForms)
      .values({ jobId, fields: form.fields, source: form.source })
      .onConflictDoUpdate({
        target: applicationForms.jobId,
        set: { fields: form.fields, source: form.source, fetchedAt: new Date() },
      });

    return { ok: true, jdLength: jd.text.length, formSource: form.source };
  } catch (e) {
    return { ok: false, jdLength: 0, formSource: "fallback", error: e instanceof Error ? e.message : String(e) };
  }
}
