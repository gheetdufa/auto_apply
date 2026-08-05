#!/usr/bin/env tsx
/**
 * Discovery coverage smoke test — verifies filters + Google Careers parsing
 * against the known Career Catalyst role and counts mega-tech early-career
 * rows the blocklist used to drop.
 *
 *   pnpm exec tsx scripts/test-discovery.ts
 */
import "./load-env";
import { isBlockedCompany } from "@/lib/ingest/blocklist";
import { isEarlyCareerTitle } from "@/lib/ingest/early-career";
import { classify, isTarget } from "@/lib/ingest/location";
import { SWE_TITLE_RE } from "@/lib/ingest/run";
import { parseGoogleCareersHtml, scoutGoogleCareers } from "@/lib/scout/google";
import { SOURCES, rawUrl } from "@/lib/ingest/sources";
import { parseTables, parseHtmlTables } from "@/lib/ingest/markdown-table";
import { normalizeRow } from "@/lib/ingest/row-normalizer";
import { loadState, saveState } from "@/lib/scout/discover";
import { db } from "@/db";
import { jobs, companies } from "@/db/schema";
import { eq } from "drizzle-orm";

const CATALYST_ID = "138156162599002822";
const CATALYST_TITLE =
  "Software Engineer II, Early Career, Google Cloud AI Career Catalyst Program";

async function main() {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed += 1;
  };

  // 1. Filter unit checks for the reported role
  check("early-career title", isEarlyCareerTitle(CATALYST_TITLE));
  check("SWE title", SWE_TITLE_RE.test(CATALYST_TITLE));
  check("Sunnyvale is target", isTarget(classify("Sunnyvale, CA, USA")));
  check(
    "Google early-career not blocked",
    !isBlockedCompany("Google", { title: CATALYST_TITLE }),
  );
  check(
    "Google senior still blocked",
    isBlockedCompany("Google", { title: "Staff Software Engineer, Cloud" }),
  );

  // 2. Live Google Careers HTML parse
  const url =
    "https://www.google.com/about/careers/applications/jobs/results/?target_level=EARLY&location=California,%20USA&q=Software%20Engineer";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(20_000),
  });
  check("Google careers HTTP", res.ok, `status ${res.status}`);
  const html = await res.text();
  const parsed = parseGoogleCareersHtml(html);
  const catalyst = parsed.find((p) => p.jobId === CATALYST_ID || /career catalyst/i.test(p.title));
  check(
    "Career Catalyst in Google HTML",
    !!catalyst,
    catalyst ? `${catalyst.title} @ ${catalyst.locationRaw}` : `parsed ${parsed.length} cards`,
  );
  if (catalyst) {
    check("Catalyst location target", isTarget(classify(catalyst.locationRaw)), catalyst.locationRaw);
  }

  // 3. How many mega-tech early-career rows GitHub lists now admit
  let admitted = 0;
  let stillBlocked = 0;
  const samples: string[] = [];
  for (const src of SOURCES) {
    if (src.key.startsWith("nuft-")) continue;
    const md = await (await fetch(rawUrl(src), { signal: AbortSignal.timeout(20_000) })).text();
    for (const table of [...parseTables(md), ...parseHtmlTables(md)]) {
      let last = "";
      for (const cells of table.rows) {
        const row = normalizeRow(table.headers, cells);
        if (!row) continue;
        if (/↳|⤷|^&nbsp;|^\s*$/i.test(cells[0] ?? "") && last) row.company = last;
        else last = row.company;
        if (!SWE_TITLE_RE.test(row.title)) continue;
        if (!isTarget(classify(row.locationRaw))) continue;
        if (isBlockedCompany(row.company)) {
          if (isEarlyCareerTitle(row.title)) {
            admitted += 1;
            if (samples.length < 8) samples.push(`${row.company} — ${row.title}`);
          } else {
            stillBlocked += 1;
          }
        }
      }
    }
  }
  check("mega-tech early-career admitted from lists", admitted > 50, `${admitted} admitted, ${stillBlocked} senior still blocked`);
  for (const s of samples) console.log(`         · ${s}`);

  // 4. Force a Google scout run (clear gate) and confirm DB insert
  const state = loadState();
  delete state.lastGoogleScanAt;
  saveState(state);
  const google = await scoutGoogleCareers();
  check("Google scout ran", !google.skipped, `seen=${google.seen} seeded=${google.seeded} new=${google.newJobIds.length}`);

  const rows = db
    .select({ id: jobs.id, title: jobs.title, locationRaw: jobs.locationRaw, applyUrl: jobs.applyUrl })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(companies.normalizedName, "google"))
    .all()
    .filter((r) => /catalyst/i.test(r.title) || r.applyUrl.includes(CATALYST_ID));

  check(
    "Catalyst role in DB",
    rows.length > 0,
    rows[0] ? `#${rows[0].id} ${rows[0].title}` : "not found — check filters",
  );

  // also show other Google early-career jobs we picked up
  const googleJobs = db
    .select({ title: jobs.title, locationRaw: jobs.locationRaw })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(companies.normalizedName, "google"))
    .all();
  console.log(`\nGoogle jobs in DB: ${googleJobs.length}`);
  for (const g of googleJobs.slice(0, 12)) {
    console.log(`  · ${g.title} (${g.locationRaw})`);
  }

  console.log(failed === 0 ? "\nAll discovery checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
