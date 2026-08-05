#!/usr/bin/env tsx
/**
 * Re-open early-career / new-grad jobs that were skipped solely because of the
 * mega-tech blocklist, now that those titles are excepted.
 *
 *   pnpm exec tsx scripts/unsweep-early-career.ts
 */
import "./load-env";
import { db } from "../db";
import { jobs, companies } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { blockedCompanies } from "../lib/ingest/blocklist";
import { isEarlyCareerTitle } from "../lib/ingest/early-career";

async function main() {
  const blocked = blockedCompanies();
  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      company: companies.name,
      norm: companies.normalizedName,
      notes: jobs.notes,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(and(eq(jobs.status, "skipped")));

  const hits = rows.filter(
    (r) =>
      blocked.has(r.norm) &&
      isEarlyCareerTitle(r.title) &&
      (!r.notes || /blocklist/i.test(r.notes)),
  );

  if (hits.length === 0) {
    console.log("Nothing to unsweep.");
    return;
  }

  const byCompany = new Map<string, number>();
  for (const h of hits) byCompany.set(h.company, (byCompany.get(h.company) ?? 0) + 1);

  for (const h of hits) {
    await db
      .update(jobs)
      .set({ status: "discovered", notes: null, updatedAt: new Date() })
      .where(eq(jobs.id, h.id));
  }

  console.log(`Reopened ${hits.length} early-career job(s) from blocklisted companies:`);
  for (const [company, n] of [...byCompany.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${company.padEnd(30)} ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
