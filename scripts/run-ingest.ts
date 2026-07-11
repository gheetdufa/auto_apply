import "./load-env";
import { runPipeline } from "../lib/pipeline";

async function main() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] pipeline start`);
  const { ingest, scout, enriched, drafted, draftErrors, notified } = await runPipeline({ notify: true });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`done in ${dt}s${ingest.backfill ? " (BACKFILL — no notify/draft)" : ""}`);
  console.log(`  rows seen:   ${ingest.totalRowsSeen}`);
  console.log(`  candidates:  ${ingest.uniqueCandidates}`);
  console.log(`  new (lists): ${ingest.newJobs}${ingest.seededFromNewSources ? ` · +${ingest.seededFromNewSources} seeded (new sources)` : ""}`);
  if (scout.boards) {
    console.log(
      `  scout ATS:   ${scout.boards.boards} boards · ${scout.boards.postingsSeen} postings · +${scout.boards.newJobIds.length} new${scout.boards.backfill ? " (backfill)" : ""} · +${scout.boards.seeded} seeded · +${scout.boards.ambientNew} ambient`,
    );
    if (scout.boards.discovery) {
      const d = scout.boards.discovery;
      console.log(`  discovery:   probed ${d.probed} YC cos · ${d.hits} boards found · ${d.queueRemaining} queued`);
    }
  }
  if (scout.hn && !scout.hn.skipped) {
    console.log(`  scout HN:    ${scout.hn.commentsScanned} comments · ${scout.hn.matched} matched · +${scout.hn.newJobIds.length} new`);
  }
  if (scout.remote && !scout.remote.skipped) {
    console.log(`  scout remote: ${scout.remote.seen} postings · +${scout.remote.newJobIds.length} new · +${scout.remote.seeded} seeded`);
  }
  if (scout.error) console.log(`  scout error: ${scout.error}`);
  console.log(`  closed:      ${ingest.closedJobs}`);
  console.log(`  enriched:    ${enriched} · drafted: ${drafted} · notified: ${notified}`);
  for (const err of draftErrors) console.log(`  draft error: ${err}`);
  for (const [k, v] of Object.entries(ingest.perSource)) {
    const tag = v.error ? `ERROR (${v.error})` : `seen=${v.rowsSeen} kept=${v.rowsKept}`;
    console.log(`  ${k.padEnd(28)} ${tag}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
