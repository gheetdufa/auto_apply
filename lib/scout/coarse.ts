import { db } from "@/db";
import { jobs, companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { coarseKey } from "@/lib/ingest/dedupe";

/** All coarse keys currently in the DB — build once per run, check before every insert. */
export function loadCoarseKeys(): Set<string> {
  const rows = db
    .select({ company: companies.name, title: jobs.title, locationClass: jobs.locationClass })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .all();
  return new Set(rows.map((r) => coarseKey(r.company, r.title, r.locationClass)));
}
