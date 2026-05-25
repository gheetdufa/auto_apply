import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { jobs, companies, jobDescriptions, drafts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { JobActions } from "./_components/job-actions";
import { DraftEditor } from "./_components/draft-editor";
import { ChevronLeft, ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) notFound();

  const [row] = await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      locationRaw: jobs.locationRaw,
      locationClass: jobs.locationClass,
      applyUrl: jobs.applyUrl,
      atsType: jobs.atsType,
      status: jobs.status,
      sourceRepos: jobs.sourceRepos,
      company: companies.name,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, id));

  if (!row) notFound();

  const [jd] = await db.select().from(jobDescriptions).where(eq(jobDescriptions.jobId, id));
  const [draft] = await db.select().from(drafts).where(eq(drafts.jobId, id)).orderBy(desc(drafts.createdAt)).limit(1);

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]">
          <ChevronLeft className="h-4 w-4" /> Inbox
        </Link>
        <JobActions
          jobId={id}
          status={row.status}
          applyUrl={row.applyUrl}
          hasJd={!!jd}
          hasDraft={!!draft}
        />
      </div>

      <header className="mb-5">
        <div className="text-[color:var(--color-muted)] text-sm">{row.company}</div>
        <h1 className="text-xl font-semibold mt-0.5">{row.title}</h1>
        <div className="mt-1.5 flex items-center gap-3 text-xs text-[color:var(--color-muted)]">
          <span>{row.locationRaw}</span>
          <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase">{row.atsType}</span>
          <a
            href={row.applyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-[color:var(--color-accent)]"
          >
            {hostnameOf(row.applyUrl)} <ExternalLink className="h-3 w-3" />
          </a>
          <span>· seen in {(row.sourceRepos as string[]).length} repo{(row.sourceRepos as string[]).length === 1 ? "" : "s"}</span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-6">
        <section className="rounded-lg border bg-[color:var(--color-panel)]">
          <div className="border-b px-4 py-2 text-xs uppercase text-[color:var(--color-muted)]">Job description</div>
          <div className="max-h-[75vh] overflow-y-auto p-4 text-[13px] whitespace-pre-wrap leading-relaxed">
            {jd?.text ?? (
              <span className="text-[color:var(--color-muted)]">
                Not fetched yet. Click <span className="font-mono">Fetch JD</span> above.
              </span>
            )}
          </div>
        </section>

        <section className="rounded-lg border bg-[color:var(--color-panel)]">
          <div className="border-b px-4 py-2 text-xs uppercase text-[color:var(--color-muted)]">
            Draft {draft && <span className="ml-2 text-[10px] normal-case opacity-60">{draft.model}</span>}
          </div>
          {draft ? (
            <DraftEditor jobId={id} initial={{ coverLetterMd: draft.coverLetterMd, qa: draft.qaJson }} />
          ) : (
            <div className="p-4 text-[color:var(--color-muted)] text-sm">
              {jd ? "No draft yet. Click Generate Draft above." : "Fetch JD first, then generate a draft."}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}
