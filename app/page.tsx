import Link from "next/link";
import { db } from "@/db";
import { jobs, companies, type JobStatus } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { RefreshButton } from "./_components/refresh-button";
import { StatusFilters } from "./_components/status-filters";

export const dynamic = "force-dynamic";

type Search = { status?: string; loc?: string };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const statusFilter = (params.status ?? "discovered") as JobStatus;

  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      locationRaw: jobs.locationRaw,
      locationClass: jobs.locationClass,
      atsType: jobs.atsType,
      status: jobs.status,
      starred: jobs.starred,
      sourceRepos: jobs.sourceRepos,
      postedDate: jobs.postedDate,
      company: companies.name,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.status, statusFilter))
    .orderBy(desc(jobs.createdAt))
    .limit(200);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">auto-apply</h1>
          <p className="text-[color:var(--color-muted)] text-sm mt-1">New-grad SWE inbox · SF / NYC / Remote-US</p>
        </div>
        <RefreshButton />
      </header>

      <StatusFilters current={statusFilter} />

      <div className="mt-6 rounded-lg border bg-[color:var(--color-panel)] overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-[color:var(--color-muted)]">
            No jobs in <span className="font-mono">{statusFilter}</span> yet. Hit Refresh to ingest.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[color:var(--color-muted)]">
              <tr className="border-b">
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">ATS</th>
                <th className="px-4 py-3 font-medium">Sources</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <Link href={`/job/${r.id}`} className="hover:text-[color:var(--color-accent)]">
                      {r.company}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{r.title}</td>
                  <td className="px-4 py-3">
                    <span className="text-[color:var(--color-muted)]">{r.locationRaw}</span>
                    {r.locationClass !== "other" && (
                      <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase bg-white/5">
                        {r.locationClass.replace("_", " ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-muted)]">{r.atsType}</td>
                  <td className="px-4 py-3 text-[color:var(--color-muted)] text-xs">
                    {(r.sourceRepos as string[]).length} repo{(r.sourceRepos as string[]).length === 1 ? "" : "s"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
