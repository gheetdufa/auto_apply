#!/usr/bin/env tsx
/**
 * Fetch public GitHub repos, classify role affinities with Claude, write
 * data/github-projects.json for the tailor step to rank per job.
 *
 *   pnpm github:sync
 */
import "./load-env";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveGithubUsername, fetchGithubRepos } from "@/lib/github/fetch";
import { classifyRepos } from "@/lib/github/classify";
import type { GithubCatalog } from "@/lib/github/types";

const OUT = resolve(process.env.GITHUB_PROJECTS_PATH ?? "./data/github-projects.json");

async function main() {
  const username = resolveGithubUsername();
  console.log(`Fetching repos for @${username}…`);
  const raw = await fetchGithubRepos(username);
  console.log(`Got ${raw.length} repos. Classifying with Claude…`);

  const projects = await classifyRepos(raw);
  const usable = projects.filter((p) => !p.skip);
  const skipped = projects.filter((p) => p.skip);

  const catalog: GithubCatalog = {
    username,
    syncedAt: new Date().toISOString(),
    projects,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(catalog, null, 2) + "\n");

  console.log(`\nWrote ${OUT}`);
  console.log(`Usable: ${usable.length} · skipped: ${skipped.length}${raw.some((r) => r.private) ? ` · private included: ${raw.filter((r) => r.private).length}` : ""}`);
  console.log("\nTop quant affinities:");
  [...usable]
    .sort((a, b) => b.roleFits.quant - a.roleFits.quant)
    .slice(0, 5)
    .forEach((p) => console.log(`  ${p.roleFits.quant.toString().padStart(3)}  ${p.name} — ${p.summary.slice(0, 70)}`));
  console.log("\nTop ml_ai affinities:");
  [...usable]
    .sort((a, b) => b.roleFits.ml_ai - a.roleFits.ml_ai)
    .slice(0, 5)
    .forEach((p) => console.log(`  ${p.roleFits.ml_ai.toString().padStart(3)}  ${p.name} — ${p.summary.slice(0, 70)}`));

  const auto = projects.find((p) => p.name === "auto-trader");
  if (auto) {
    console.log(`\nauto-trader: skip=${auto.skip} quant=${auto.roleFits.quant} — ${auto.summary}`);
  } else {
    console.log("\nWARN: auto-trader not in catalog (still private without auth?)");
  }

  if (skipped.length) {
    console.log("\nSkipped:");
    skipped.forEach((p) => console.log(`  - ${p.name}: ${p.skipReason ?? "skip"}`));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
