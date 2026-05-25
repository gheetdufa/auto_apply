import { runIngest } from "../lib/ingest/run";

async function main() {
  const t0 = Date.now();
  console.log("Ingesting…");
  const result = await runIngest();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${dt}s\n`);
  console.log(`Rows seen across sources: ${result.totalRowsSeen}`);
  console.log(`Unique SWE candidates:    ${result.uniqueCandidates}`);
  console.log(`New jobs inserted:        ${result.newJobs}`);
  console.log();
  for (const [k, v] of Object.entries(result.perSource)) {
    const tag = v.error ? `ERROR (${v.error})` : `seen=${v.rowsSeen} kept=${v.rowsKept}`;
    console.log(`  ${k.padEnd(28)} ${tag}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
