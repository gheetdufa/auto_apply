import { existsSync, readFileSync } from "node:fs";
import { ROLE_FAMILIES, type GithubCatalog, type RankedProject, type RoleFamily } from "./types";

const CATALOG_PATH = process.env.GITHUB_PROJECTS_PATH ?? "./data/github-projects.json";

/** Keyword cues → role-family weights (unnormalized). */
const FAMILY_CUES: Record<RoleFamily, RegExp[]> = {
  quant: [
    /\bquant\b/i,
    /trading/i,
    /market.?mak/i,
    /hedge.?fund/i,
    /prop(?:rietary)?.?trad/i,
    /\bhft\b/i,
    /systematic/i,
    /fintech/i,
    /portfolio/i,
    /\balpha\b/i,
    /execution/i,
    /order.?book/i,
    /backtest/i,
    /market.?data/i,
    /risk.?manag/i,
    /bloomberg/i,
    /options? pricing/i,
  ],
  ml_ai: [
    /machine learning/i,
    /\bml engineer/i,
    /\bai engineer/i,
    /deep learning/i,
    /\bllm\b/i,
    /computer vision/i,
    /\bnlp\b/i,
    /pytorch/i,
    /tensorflow/i,
    /foundation model/i,
    /inference/i,
    /retrieval.?augment/i,
    /\brag\b/i,
  ],
  fullstack_product: [
    /full.?stack/i,
    /product engineer/i,
    /frontend/i,
    /react/i,
    /next\.?js/i,
    /saas/i,
    /startup/i,
  ],
  backend_infra: [
    /backend/i,
    /platform engineer/i,
    /infrastructure/i,
    /devops/i,
    /sre\b/i,
    /kubernetes/i,
    /distributed system/i,
    /api engineer/i,
  ],
  data: [/data engineer/i, /analytics/i, /etl\b/i, /data scien/i, /warehouse/i, /spark\b/i],
  systems: [/systems engineer/i, /embedded/i, /operating system/i, /compiler/i, /performance engineer/i, /\bc\+\+\b/i],
  general_swe: [/software engineer/i, /swe\b/i, /new grad/i, /university grad/i],
};

export function loadGithubCatalog(): GithubCatalog | null {
  if (!existsSync(CATALOG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as GithubCatalog;
  } catch {
    return null;
  }
}

/** Infer soft weights over role families from title + JD text. */
export function detectRoleWeights(title: string, jdText: string): Record<RoleFamily, number> {
  const text = `${title}\n${jdText.slice(0, 8000)}`;
  const raw: Record<RoleFamily, number> = {
    quant: 0,
    ml_ai: 0,
    fullstack_product: 0,
    backend_infra: 0,
    data: 0,
    systems: 0,
    general_swe: 0.2, // small baseline so pure SWE roles still rank something
  };

  for (const family of ROLE_FAMILIES) {
    for (const re of FAMILY_CUES[family]) {
      if (re.test(text)) raw[family] += 1;
    }
  }

  // Title hits count extra — "Quant Researcher" should dominate over a JD that casually mentions React.
  for (const family of ROLE_FAMILIES) {
    for (const re of FAMILY_CUES[family]) {
      if (re.test(title)) raw[family] += 2;
    }
  }

  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const weights = { ...raw };
  for (const f of ROLE_FAMILIES) weights[f] = raw[f] / sum;
  return weights;
}

function whyFit(project: GithubCatalog["projects"][number], weights: Record<RoleFamily, number>): string {
  const top = [...ROLE_FAMILIES]
    .map((f) => ({ f, w: weights[f], score: project.roleFits[f] }))
    .filter((x) => x.w > 0.05 && x.score >= 40)
    .sort((a, b) => b.w * b.score - a.w * a.score)
    .slice(0, 2);
  if (top.length === 0) return "general portfolio signal";
  return top.map((t) => `${t.f.replace("_", "/")} ${t.score}`).join(", ");
}

/**
 * Rank non-skipped catalog projects for a job. Returns top N with fit scores.
 */
export function rankProjectsForJob(args: {
  title: string;
  jdText: string;
  limit?: number;
  catalog?: GithubCatalog | null;
}): RankedProject[] {
  const catalog = args.catalog === undefined ? loadGithubCatalog() : args.catalog;
  if (!catalog) return [];

  const weights = detectRoleWeights(args.title, args.jdText);
  const limit = args.limit ?? 5;

  const ranked: RankedProject[] = catalog.projects
    .filter((p) => !p.skip)
    .map((p) => {
      let fitScore = 0;
      for (const f of ROLE_FAMILIES) fitScore += weights[f] * (p.roleFits[f] ?? 0);
      return { ...p, fitScore, why: whyFit(p, weights) };
    })
    .sort((a, b) => b.fitScore - a.fitScore || b.stars - a.stars)
    .slice(0, limit);

  return ranked;
}

/** Compact markdown block for the tailor prompt (empty string if no catalog). */
export function formatProjectsForPrompt(ranked: RankedProject[]): string {
  if (ranked.length === 0) return "";
  const lines = [
    `## GitHub projects ranked for this role`,
    `Prefer the top 1–2 in the cover letter and any "project you're proud of" answers when they beat what's already emphasized in the profile for THIS role.`,
    `Example: a quant/trading JD should lean on market/trading/fintech repos over a generic web app, even if the web app is more polished.`,
    `Ground every claim in the bullets/summary below — never invent.`,
    ``,
  ];
  ranked.forEach((p, i) => {
    lines.push(
      `${i + 1}. **${p.name}** (fit ${Math.round(p.fitScore)}, ${p.why}) — ${p.url}`,
      `   ${p.summary}`,
    );
    for (const b of p.bullets) lines.push(`   - ${b}`);
    lines.push("");
  });
  return lines.join("\n");
}
