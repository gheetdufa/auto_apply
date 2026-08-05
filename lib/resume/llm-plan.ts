import { z } from "zod";
import { RESUME_PROJECTS, SKILLS, type ResumeProject } from "./catalog";
import { escapeLatex, type BulletDiff, type SkillsBanks, type TailoredResumePlan } from "./assemble";

/**
 * The LLM proposes, this module disposes: everything here is validated against
 * the fixed catalog so a model can reorder/rephrase but never invent. Anything
 * that fails validation degrades to the heuristic base plan, never to garbage.
 */

export const ResumePlanSchema = z.object({
  projects: z
    .array(
      z.object({
        id: z.string(),
        bullets: z.array(z.string()),
      }),
    )
    .describe("Exactly 2 catalog project ids, best fit for this job first"),
  skills: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    cloud: z.array(z.string()),
    databases: z.array(z.string()),
  }),
});

export type LlmResumePlan = z.infer<typeof ResumePlanSchema>;

/** Longest acceptable rewritten bullet — beyond this it risks wrapping to a 3rd line. */
const MAX_BULLET_CHARS = 240;
/** At most this many items may be dropped from each skills bank. */
const MAX_BANK_DROPS = 3;

/** Strip the LaTeX escapes catalog bullets carry so the model sees plain text. */
export function delatex(s: string): string {
  return s
    .replace(/\$\\sim\$/g, "~")
    .replace(/\\([{}$&#_%])/g, "$1")
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\textasciitilde\{\}/g, "~")
    .replace(/\\textasciicircum\{\}/g, "^");
}

/** Style rule: no em dashes anywhere in generated text. */
function stripEmDashes(s: string): string {
  return s.replace(/\s*—\s*/g, ", ").replace(/\s*--+\s*/g, ", ");
}

function sanitizeBullet(raw: string): string | null {
  const b = stripEmDashes(raw.replace(/\s+/g, " ").trim());
  if (!b || b.length > MAX_BULLET_CHARS) return null;
  return b;
}

/**
 * Validate a bank against its catalog source: keep only verbatim members in the
 * LLM's order, then top back up (in base-plan order) so at most MAX_BANK_DROPS
 * items go missing. The model can prioritize and prune, never add.
 */
function validateBank(proposed: string[], bank: readonly string[], baseOrder: string[]): string[] {
  const allowed = new Set(bank);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const item of proposed) {
    if (allowed.has(item) && !seen.has(item)) {
      seen.add(item);
      kept.push(item);
    }
  }
  const floor = bank.length - MAX_BANK_DROPS;
  for (const item of baseOrder) {
    if (kept.length >= floor) break;
    if (!seen.has(item)) {
      seen.add(item);
      kept.push(item);
    }
  }
  return kept;
}

/**
 * Merge an LLM-proposed plan into the heuristic base plan. Invalid parts fall
 * back to the base plan piecewise; the result is always assemblable.
 */
export function applyLlmPlan(llm: LlmResumePlan, base: TailoredResumePlan): TailoredResumePlan {
  const rationale: string[] = [base.rationale[0] ?? ""];
  const diffs: BulletDiff[] = [];

  // --- Projects: first 2 valid unique catalog ids, else keep heuristic picks.
  const picked: ResumeProject[] = [];
  for (const prop of llm.projects) {
    const cat = RESUME_PROJECTS.find((p) => p.id === prop.id);
    if (!cat || picked.some((p) => p.id === cat.id)) continue;
    picked.push(cat);
    if (picked.length === 2) break;
  }

  let projects: ResumeProject[];
  if (picked.length === 2) {
    projects = picked.map((cat, i) => {
      // Page budget (matches heuristic): lead project 2 bullets, runner-up 1.
      const budget = i === 0 ? 2 : 1;
      const proposed = (llm.projects.find((p) => p.id === cat.id)?.bullets ?? [])
        .map(sanitizeBullet)
        .filter((b): b is string => b !== null)
        .slice(0, budget);

      const bullets = cat.bullets.slice(0, budget).map((orig, j) => {
        const rewritten = proposed[j];
        if (!rewritten || rewritten === delatex(orig)) return orig;
        diffs.push({ project: cat.heading, original: delatex(orig), rewritten });
        return escapeLatex(rewritten);
      });
      return { ...cat, bullets };
    });
    rationale.push(`Projects (LLM pick): ${projects.map((p) => p.heading).join(" + ")}`);
    rationale.push(
      diffs.length > 0
        ? `${diffs.length} bullet${diffs.length === 1 ? "" : "s"} rewritten to mirror the JD`
        : "Bullets kept verbatim from the catalog",
    );
  } else {
    projects = base.projects;
    rationale.push(`Projects: heuristic picks kept (LLM proposed unknown ids)`);
  }

  // --- Skills: verbatim subset per bank, topped up from the heuristic order.
  const skills: SkillsBanks = {
    languages: validateBank(llm.skills.languages, SKILLS.languages, base.skills.languages),
    frameworks: validateBank(llm.skills.frameworks, SKILLS.frameworks, base.skills.frameworks),
    cloud: validateBank(llm.skills.cloud, SKILLS.cloud, base.skills.cloud),
    databases: validateBank(llm.skills.databases, SKILLS.databases, base.skills.databases),
  };
  const dropped =
    Object.values(SKILLS).reduce((n, bank) => n + bank.length, 0) -
    Object.values(skills).reduce((n, bank) => n + bank.length, 0);
  rationale.push(dropped > 0 ? `Skills reordered for JD, ${dropped} dropped` : "Skills reordered for JD");

  return {
    internship: base.internship,
    projects,
    skills,
    rationale,
    source: "llm",
    bulletDiffs: diffs,
  };
}
