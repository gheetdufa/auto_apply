import Link from "next/link";
import { db } from "@/db";
import { jobs, companies } from "@/db/schema";
import { desc, eq, and, isNull, isNotNull, inArray } from "drizzle-orm";
import { RefreshButton } from "./_components/refresh-button";
import { StatusFilters, VIEWS, type ViewKey } from "./_components/status-filters";
import { SetupBanner } from "./_components/setup-banner";

export const dynamic = "force-dynamic";

type Search = { view?: string };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const view: ViewKey = (Object.keys(VIEWS) as ViewKey[]).includes(params.view as ViewKey)
    ? (params.view as ViewKey)
    : "inbox";

  const base = db
    .select({
      id: jobs.id,
      title: jobs.title,
      kind: jobs.kind,
      locationRaw: jobs.locationRaw,
      locationClass: jobs.locationClass,
      atsType: jobs.atsType,
      status: jobs.status,
      firstSeenAt: jobs.firstSeenAt,
      closedAt: jobs.closedAt,
      backfilled: jobs.backfilled,
      company: companies.name,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id));

  const open = inArray(jobs.status, ["discovered", "drafted"]);
  const rows =
    view === "inbox"
      ? await base.where(and(open, isNull(jobs.closedAt))).orderBy(desc(jobs.firstSeenAt)).limit(300)
      : view === "closed"
        ? await base.where(and(open, isNotNull(jobs.closedAt))).orderBy(desc(jobs.closedAt)).limit(300)
        : await base.where(eq(jobs.status, view)).orderBy(desc(jobs.updatedAt)).limit(300);

  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">auto-apply</h1>
          <p className="text-[color:var(--color-muted)] text-sm mt-1">
            New-grad SWE + internships · SF / NYC / Remote-US · sorted by release
          </p>
        </div>
        <RefreshButton />
      </header>

      <SetupBanner />

      <StatusFilters current={view} />

      <div className="mt-6 rounded-lg border bg-[color:var(--color-panel)] overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-[color:var(--color-muted)]">
            Nothing in <span className="font-mono">{VIEWS[view]}</span>. Hit Refresh, or install the
            watcher with <span className="font-mono">pnpm watcher:install</span>.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[color:var(--color-muted)]">
              <tr className="border-b">
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">Released</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ageMs = now - r.firstSeenAt.getTime();
                const isToday = ageMs < dayMs && !r.backfilled;
                return (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <Link href={`/job/${r.id}`} className="hover:text-[color:var(--color-accent)]">
                        {r.company}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {r.title}
                      {r.kind === "internship" && (
                        <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase bg-white/5 text-[color:var(--color-muted)]">
                          intern
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[color:var(--color-muted)]">{r.locationRaw}</span>
                      {r.locationClass !== "other" && (
                        <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase bg-white/5">
                          {r.locationClass.replace("_", " ")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-muted)] text-xs whitespace-nowrap">
                      {isToday ? (
                        <span className="rounded bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 text-[color:var(--color-accent)] font-medium">
                          new today
                        </span>
                      ) : r.backfilled ? (
                        "backfill"
                      ) : (
                        relativeDays(ageMs)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      {r.status === "drafted" && (
                        <span className="rounded bg-[color:var(--color-success)]/10 px-1.5 py-0.5 text-[color:var(--color-success)]">
                          draft ready
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function relativeDays(ageMs: number): string {
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
