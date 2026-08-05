import { readFileSync, existsSync } from "node:fs";
import type { FormField, JobKind } from "@/db/schema";
import { formatProjectsForPrompt, rankProjectsForJob } from "@/lib/github/rank";
import { RESUME_PROJECTS, SKILLS } from "@/lib/resume/catalog";
import { delatex } from "@/lib/resume/llm-plan";

const PROFILE_PATH = process.env.PROFILE_PATH ?? "./data/profile.md";
const SCREENING_PATH = process.env.SCREENING_PATH ?? "./config/screening-answers.json";

export type ScreeningAnswers = Record<string, string>;

export function profileExists(): boolean {
  return existsSync(PROFILE_PATH);
}

export function loadProfile(): string {
  if (!existsSync(PROFILE_PATH)) {
    throw new Error(
      `Profile not found at ${PROFILE_PATH}. Copy data/profile.md.template to data/profile.md and fill it in.`,
    );
  }
  return readFileSync(PROFILE_PATH, "utf-8");
}

export function loadScreeningAnswers(): ScreeningAnswers {
  if (!existsSync(SCREENING_PATH)) return {};
  return JSON.parse(readFileSync(SCREENING_PATH, "utf-8")) as ScreeningAnswers;
}

/** Override graduation / start-date fields for internship applications (B.S./M.S. 2028). */
export function screeningAnswersForKind(kind: JobKind | string | null | undefined): ScreeningAnswers {
  const base = loadScreeningAnswers();
  const { _comment, ...rest } = base as ScreeningAnswers & { _comment?: string };
  void _comment;
  if (kind !== "internship") return rest;
  return {
    ...rest,
    graduation_date:
      rest.internship_graduation_date ??
      "May 2028 — B.S./M.S. Computer Science & Math, University of Maryland College Park",
    earliest_start_date:
      rest.internship_earliest_start_date ??
      "Summer 2026 (available for internship; pursuing B.S./M.S., expected May 2028).",
    years_of_experience:
      rest.internship_years_of_experience ??
      "Multiple SWE internships plus founder experience (CEO of Synari); pursuing B.S./M.S., expected May 2028.",
  };
}

export const SYSTEM_PROMPT = `You are a job-application copilot for a new-grad / internship software engineer.

You receive the candidate's profile, a job description, and the ACTUAL fields of the application form (when available). You produce:
1. A cover letter (Markdown, ~250 words, single page) — concrete, references specific things from the JD, no generic platitudes, no hyperbole, no "I am writing to apply for…" openings. Sound like the candidate, not a template.
2. An answer for each application-form field, in the same order the fields are given, using each field's label verbatim as the question.
3. A resume plan (resumePlan): which resume-catalog projects fit THIS job, optionally rewritten bullets, and a JD-ordered skills list.

Resume plan rules (code validates all of this — violations get discarded):
- projects: exactly 2 ids from the "Resume catalog" section, best fit for this job first. First project gets up to 2 bullets, second gets exactly 1.
- Bullets are plain text (no LaTeX). You may rephrase a bullet to mirror the JD's terminology, but NEVER add facts, metrics, technologies, or outcomes that are not in the original bullet — rewording only, no inflation. Keep each bullet under 230 characters. When the original already fits the JD, return it unchanged.
- Bullets stay in resume voice: impersonal past-tense lines ("Built…", "Designed…"). Never address the reader ("you", "your team") and never name the target company in a bullet.
- skills: for each bank, return a reordered subset of the given items — most relevant to this JD first, items copied character-for-character. You may drop up to 3 clearly irrelevant items per bank; never add new ones.

Rules per field type:
- Free-text / textarea: write the answer the candidate would type. 1-3 sentences for short questions; up to a short paragraph for "why us" / project questions. Ground every claim in the profile — never fabricate experience, numbers, or company knowledge.
- "Examples of exceptional ability" / impact / experience bullets: lead with the strongest named industry experience in the profile (e.g. Amazon SDE Intern) when it exists, then complementary research or projects. Do not bury or omit the flagship internship in favor of academic-only examples unless the role is a clear mismatch and the profile says so.
- Select: the answer MUST be exactly one of the provided options, character-for-character. Pick using the candidate's canonical screening answers (work auth, demographics, relocation, etc.). For demographic/EEOC questions choose the option matching the canonical answer (e.g. a "decline to answer" option when the canonical answer is "prefer not to say").
- Multiselect: comma-separated subset of the provided options, verbatim.
- Contact fields (name, email, phone, LinkedIn, website, location): fill from the profile if present; otherwise answer with an empty string — never invent contact info.
- Attachment fields (resume, cover letter upload): answer with a short note like "attach data/resume.pdf" or "paste the cover letter above".
- If you don't have a fact, use "prefer not to say" or a brief honest deflection — never fabricate.

Cover letter: lead with the most specific connection between the candidate and this role. Prefer a GitHub-ranked project when the prompt includes a ranked list and the top project fits this role better than the default profile headline. Otherwise pick the strongest profile project. Always add one specific reason this company/role.

When a "GitHub projects ranked for this role" section is present: treat higher-ranked projects as the preferred evidence for THIS posting. A quant role should cite trading/market/fintech work over a generic SaaS app; an ML role should cite model/CV/LLM work. Do not invent details beyond the listed summaries/bullets and the profile.

Education framing (CRITICAL — follow the Application track section in the user prompt):
- Internship track: present as pursuing a B.S./M.S., expected graduation May 2028. Never say May 2027 or "B.S. only" on internship applications.
- New-grad / full-time track: B.S. Computer Science & Math, expected graduation May 2027.

Style: NEVER use em dashes (—) or double/triple hyphens in any output. Use a comma, colon, period, or parentheses instead. This applies to the cover letter and every free-text answer.`;

/** Fixed resume building blocks the model may select/reorder/rephrase — never extend. */
function resumeCatalogBlock(): string {
  const projects = RESUME_PROJECTS.map((p) => ({
    id: p.id,
    name: p.heading,
    role: p.role,
    bullets: p.bullets.map(delatex),
  }));
  return [
    `## Resume catalog (source of truth for resumePlan)`,
    `Projects — pick the 2 that best fit this job:`,
    "```json",
    JSON.stringify(projects, null, 2),
    "```",
    `Skills banks — reorder each for this JD (verbatim subset, drop ≤3 per bank):`,
    "```json",
    JSON.stringify(SKILLS, null, 2),
    "```",
  ].join("\n");
}

export function buildUserPrompt(args: {
  company: string;
  title: string;
  locationRaw: string;
  jdText: string;
  kind?: JobKind | string | null;
  screeningAnswers: ScreeningAnswers;
  formFields: FormField[];
  formSource: "greenhouse" | "fallback";
}): string {
  const ranked = rankProjectsForJob({ title: args.title, jdText: args.jdText, limit: 5 });
  const projectsBlock = formatProjectsForPrompt(ranked);
  const internship = args.kind === "internship";
  const trackBlock = internship
    ? [
        `## Application track: INTERNSHIP`,
        `Education to use everywhere in this draft (cover letter + form answers):`,
        `- Degree: B.S./M.S. in Computer Science & Math (combined), University of Maryland College Park`,
        `- Expected graduation: May 2028`,
        `- Do NOT mention May 2027 or a bachelor's-only timeline on this application.`,
        ``,
      ].join("\n")
    : [
        `## Application track: NEW-GRAD / FULL-TIME`,
        `Education to use: B.S. in Computer Science & Math, expected graduation May 2027.`,
        ``,
      ].join("\n");

  return [
    `# Company: ${args.company}`,
    `# Role: ${args.title}`,
    `# Location: ${args.locationRaw}`,
    `# Kind: ${args.kind ?? "new-grad"}`,
    ``,
    trackBlock,
    `## Candidate's canonical screening answers (use these verbatim when relevant)`,
    "```json",
    JSON.stringify(args.screeningAnswers, null, 2),
    "```",
    ``,
    args.formSource === "greenhouse"
      ? `## Application form fields (the REAL form for this job — answer each one, in order)`
      : `## Application form fields (standard questions — the real form wasn't retrievable)`,
    "```json",
    JSON.stringify(args.formFields, null, 2),
    "```",
    projectsBlock ? `\n${projectsBlock}` : "",
    `\n${resumeCatalogBlock()}`,
    ``,
    `## Job description`,
    args.jdText.slice(0, 16000),
  ]
    .filter((s) => s !== "")
    .join("\n");
}
