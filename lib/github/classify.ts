import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { ROLE_FAMILIES, type GithubProject } from "./types";
import type { RawGithubRepo } from "./fetch";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

const FitSchema = z.object({
  quant: z.number().min(0).max(100),
  ml_ai: z.number().min(0).max(100),
  fullstack_product: z.number().min(0).max(100),
  backend_infra: z.number().min(0).max(100),
  data: z.number().min(0).max(100),
  systems: z.number().min(0).max(100),
  general_swe: z.number().min(0).max(100),
});

const ClassifiedSchema = z.object({
  projects: z.array(
    z.object({
      name: z.string(),
      skip: z.boolean(),
      skipReason: z.string().optional(),
      summary: z.string(),
      bullets: z.array(z.string()).max(4),
      roleFits: FitSchema,
    }),
  ),
});

const SYSTEM = `You classify a candidate's GitHub repositories for job-application project selection.

For each repo, decide:
1. skip — true for: pure course homework with no signal, empty shells, personal apology/joke repos, forks you did not meaningfully build on, this meta job-tool itself if it adds nothing as a portfolio piece, or repos with no real substance.
2. summary — one grounded sentence of what THEY built (not the upstream fork's marketing copy).
3. bullets — 0–3 resume-style bullets grounded ONLY in the README/description. Never invent metrics, users, or tech not evidenced.
4. roleFits — 0–100 affinity for each family. Be discriminating:
   - quant: trading systems, market data, backtests, execution, signal research, fintech market microstructure, portfolio/risk tooling. A candlestick chart dashboard for a take-home is moderate (~40–60), not 90. An auto-trader / backtester / order book engine would be 85–100.
   - ml_ai: models, training, CV, NLP, LLMs, RAG, distillation — not "used an API once".
   - fullstack_product: shipped product UX + API + users/payments.
   - backend_infra: APIs, databases, cloud, CI/CD, platform.
   - data: analytics, ETL, notebooks with real analysis, viz pipelines.
   - systems: OS, compilers, performance, low-level, embedded.
   - general_swe: competent code that doesn't specialize above.

A repo can score high in multiple families. Most should be low in quant unless they actually touch markets/trading/finance signals.`;

/**
 * Classify raw repos into portfolio projects with role-affinity scores.
 * One Claude call for the whole catalog (cheap enough for occasional sync).
 */
export async function classifyRepos(repos: RawGithubRepo[]): Promise<GithubProject[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY required to classify GitHub projects");
  }
  const client = new Anthropic();

  const catalogText = repos
    .map((r) => {
      const parts = [
        `### ${r.name}${r.fork ? " (fork)" : ""}`,
        `url: ${r.url}`,
        `language: ${r.language ?? "unknown"} · stars: ${r.stars} · pushed: ${r.pushedAt}`,
        r.topics.length ? `topics: ${r.topics.join(", ")}` : null,
        `description: ${r.description ?? "(none)"}`,
        r.readmeExcerpt ? `readme:\n${r.readmeExcerpt}` : "readme: (missing)",
      ];
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");

  const msg = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Classify these ${repos.length} repos. Return one entry per repo name exactly as given.\n\n${catalogText}`,
      },
    ],
    output_config: { format: zodOutputFormat(ClassifiedSchema) },
  });

  if (!msg.parsed_output) {
    throw new Error(`GitHub classify returned no parseable output (stop_reason: ${msg.stop_reason})`);
  }

  const byName = new Map(repos.map((r) => [r.name, r]));
  const out: GithubProject[] = [];

  for (const c of msg.parsed_output.projects) {
    const raw = byName.get(c.name);
    if (!raw) continue;
    const roleFits = { ...emptyFits(), ...c.roleFits };
    // Ensure every family key exists.
    for (const f of ROLE_FAMILIES) {
      if (typeof roleFits[f] !== "number") roleFits[f] = 0;
    }
    out.push({
      name: raw.name,
      url: raw.url,
      description: raw.description,
      language: raw.language,
      topics: raw.topics,
      stars: raw.stars,
      pushedAt: raw.pushedAt,
      readmeExcerpt: raw.readmeExcerpt,
      summary: c.summary,
      bullets: c.bullets,
      roleFits,
      skip: c.skip,
      skipReason: c.skipReason,
    });
  }
  return out;
}

function emptyFits(): Record<(typeof ROLE_FAMILIES)[number], number> {
  return {
    quant: 0,
    ml_ai: 0,
    fullstack_product: 0,
    backend_infra: 0,
    data: 0,
    systems: 0,
    general_swe: 0,
  };
}
