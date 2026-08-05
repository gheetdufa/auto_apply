import "./load-env";
import { db } from "../db";
import { jobs, companies } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { isBlockedCompany } from "../lib/ingest/blocklist";

/**
 * Retroactively apply config/company-blocklist.json: mark still-open jobs
 * (discovered/drafted) from blocked companies as "skipped" so they leave the
 * inbox. Early-career / new-grad titles are kept (blocklist exception).
 * Run after editing the blocklist: pnpm blocklist:sweep
 */
async function main() {
  const rows = await db
    .select({ id: jobs.id, title: jobs.title, company: companies.name, norm: companies.normalizedName })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(and(inArray(jobs.status, ["discovered", "drafted"])));

  const hits = rows.filter((r) => isBlockedCompany(r.company, { title: r.title }));
  if (hits.length === 0) {
    console.log("Nothing to sweep — no open non-early-career jobs from blocklisted companies.");
    return;
  }

  const byCompany = new Map<string, number>();
  for (const h of hits) byCompany.set(h.company, (byCompany.get(h.company) ?? 0) + 1);

  await db
    .update(jobs)
    .set({ status: "skipped", notes: "blocklisted company", updatedAt: new Date() })
    .where(inArray(jobs.id, hits.map((h) => h.id)));

  console.log(`Skipped ${hits.length} open job(s) from ${byCompany.size} blocklisted company(ies):`);
  for (const [company, n] of [...byCompany.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${company.padEnd(30)} ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
