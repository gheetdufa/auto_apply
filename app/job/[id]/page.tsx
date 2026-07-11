import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { jobs, companies, jobDescriptions, applicationForms, drafts, applications } from "@/db/schema";
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
      kind: jobs.kind,
      locationRaw: jobs.locationRaw,
      applyUrl: jobs.applyUrl,
      finalUrl: jobs.finalUrl,
      atsType: jobs.atsType,
      status: jobs.status,
      closedAt: jobs.closedAt,
      firstSeenAt: jobs.firstSeenAt,
      sourceRepos: jobs.sourceRepos,
      company: companies.name,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, id));

  if (!row) notFound();

  const [jd] = await db.select().from(jobDescriptions).where(eq(jobDescriptions.jobId, id));
  const [form] = await db.select().from(applicationForms).where(eq(applicationForms.jobId, id));
  const [draft] = await db.select().from(drafts).where(eq(drafts.jobId, id)).orderBy(desc(drafts.createdAt)).limit(1);
  const [application] = await db
    .select()
    .from(applications)
    .where(eq(applications.jobId, id))
    .orderBy(desc(applications.createdAt))
    .limit(1);

  const applyHref = row.finalUrl ?? row.applyUrl;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]">
          <ChevronLeft className="h-4 w-4" /> Inbox
        </Link>
        <JobActions
          jobId={id}
          status={row.status}
          applyUrl={applyHref}
          hasDraft={!!draft}
          canAutoApply={row.atsType !== "workday" && row.atsType !== "linkedin"}
        />
      </div>

      <header className="mb-5">
        <div className="text-[color:var(--color-muted)] text-sm">{row.company}</div>
        <h1 className="text-xl font-semibold mt-0.5">{row.title}</h1>
        <div className="mt-1.5 flex items-center gap-3 text-xs text-[color:var(--color-muted)]">
          <span>{row.locationRaw}</span>
          <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase">{row.atsType}</span>
          {row.kind === "internship" && <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase">intern</span>}
          {row.closedAt && (
            <span className="rounded bg-[color:var(--color-danger)]/15 px-1.5 py-0.5 uppercase text-[color:var(--color-danger)]">
              closed
            </span>
          )}
          <a
            href={applyHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-[color:var(--color-accent)]"
          >
            {hostnameOf(applyHref)} <ExternalLink className="h-3 w-3" />
          </a>
          <span>· first seen {row.firstSeenAt.toLocaleDateString()}</span>
        </div>
      </header>

      {application && (
        <section className="mb-5 rounded-lg border border-[color:var(--color-success)]/30 bg-[color:var(--color-success)]/5">
          <div className="border-b px-4 py-2 text-xs uppercase text-[color:var(--color-muted)] flex items-center justify-between">
            <span>
              Application record · {application.outcome} · {application.createdAt.toLocaleString()}
            </span>
            <span className="text-[10px] normal-case">
              resume {application.resumeAttached ? "attached ✓" : "NOT attached"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 p-4 text-[12px]">
            {application.answersJson.map((a, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-[color:var(--color-muted)] shrink-0 max-w-[55%] truncate" title={a.label}>
                  {a.label}:
                </span>
                <span className="truncate" title={a.answer}>
                  {a.answer}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-2 gap-6">
        <section className="rounded-lg border bg-[color:var(--color-panel)]">
          <div className="border-b px-4 py-2 text-xs uppercase text-[color:var(--color-muted)]">Job description</div>
          <div className="max-h-[75vh] overflow-y-auto p-4 text-[13px] whitespace-pre-wrap leading-relaxed">
            {jd?.text ?? (
              <span className="text-[color:var(--color-muted)]">
                Not fetched yet. <span className="font-mono">Fetch details</span> pulls the JD and the real
                application-form questions.
              </span>
            )}
          </div>
        </section>

        <section className="rounded-lg border bg-[color:var(--color-panel)]">
          <div className="border-b px-4 py-2 text-xs uppercase text-[color:var(--color-muted)] flex items-center justify-between">
            <span>
              Application {draft && <span className="ml-2 text-[10px] normal-case opacity-60">{draft.model}</span>}
            </span>
            {form && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] normal-case ${
                  form.source === "greenhouse"
                    ? "bg-[color:var(--color-success)]/10 text-[color:var(--color-success)]"
                    : "bg-white/5"
                }`}
              >
                {form.source === "greenhouse" ? "real form questions" : "standard questions"}
              </span>
            )}
          </div>
          {draft ? (
            <DraftEditor jobId={id} initial={{ coverLetterMd: draft.coverLetterMd, qa: draft.qaJson }} />
          ) : form ? (
            <div className="max-h-[75vh] overflow-y-auto p-4 space-y-2">
              <p className="text-[color:var(--color-muted)] text-sm mb-3">
                This form asks the following — <span className="font-mono">Generate Draft</span> writes tailored
                answers for each:
              </p>
              {form.fields.map((f, i) => (
                <div key={i} className="rounded border bg-black/20 px-3 py-2 text-[13px]">
                  {f.label}
                  {f.required && <span className="text-[color:var(--color-danger)] ml-1">*</span>}
                  <span className="ml-2 text-[10px] uppercase text-[color:var(--color-muted)]">{f.type}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-[color:var(--color-muted)] text-sm">
              No draft yet. <span className="font-mono">Generate Draft</span> fetches everything and writes it.
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
