/**
 * Batch auto-apply with pacing: applies to drafted, open jobs one at a time,
 * spaced out so 20 applications don't fire in 90 seconds.
 *
 *   pnpm apply:batch                 # up to 5 drafted jobs, ~2 min apart
 *   pnpm apply:batch --limit 10      # raise the cap
 *   pnpm apply:batch --starred       # only starred jobs
 *   pnpm apply:batch --gap 60        # base seconds between submissions
 *
 * Stops the whole batch when a job needs attention (CAPTCHA/validation) so
 * you're never juggling multiple open browser windows.
 */
import "./load-env";
import { db } from "../db";
import { jobs, companies } from "../db/schema";
import { eq, and, isNull, notInArray } from "drizzle-orm";
import { runApplyForJob } from "../lib/apply/run-job";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? "true");
}

async function main() {
  const limit = Number(arg("limit") ?? 5);
  const gapS = Number(arg("gap") ?? 120);
  const starredOnly = process.argv.includes("--starred");

  const where = [
    eq(jobs.status, "drafted" as const),
    isNull(jobs.closedAt),
    notInArray(jobs.atsType, ["workday", "linkedin"]),
    ...(starredOnly ? [eq(jobs.starred, true)] : []),
  ];
  const candidates = await db
    .select({ id: jobs.id, title: jobs.title, company: companies.name })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(and(...where))
    .limit(limit);

  if (candidates.length === 0) {
    console.log("Nothing to apply to — no open drafted jobs" + (starredOnly ? " (starred)" : "") + ".");
    return;
  }
  console.log(`Applying to ${candidates.length} job(s), ~${gapS}s apart. Ctrl-C to stop.\n`);

  let submitted = 0;
  for (const [i, job] of candidates.entries()) {
    console.log(`[${i + 1}/${candidates.length}] ${job.company} — ${job.title} (job ${job.id})`);
    try {
      const result = await runApplyForJob(job.id, { force: false });
      if ("blocked" in result) {
        console.log(`  ⏭  skipped: ${result.blocked}`);
        continue;
      }
      console.log(`  ${result.status === "submitted" ? "✅" : "⚠️ "} ${result.status}: ${result.message}`);
      if (result.status === "submitted") submitted += 1;
      if (result.status === "needs_attention") {
        console.log("\nBatch paused — finish this one in the open browser window, then rerun.");
        break;
      }
    } catch (e) {
      console.log(`  ❌ ${e instanceof Error ? e.message : String(e)}`);
    }
    if (i < candidates.length - 1) {
      const wait = Math.round(gapS + (Math.random() - 0.5) * gapS * 0.5);
      console.log(`  … waiting ${wait}s\n`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  console.log(`\nDone: ${submitted} submitted.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
