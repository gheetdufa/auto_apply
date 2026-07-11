import { readFileSync, existsSync } from "node:fs";
import type { FormField } from "@/db/schema";

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

export const SYSTEM_PROMPT = `You are a job-application copilot for a new-grad software engineer.

You receive the candidate's profile, a job description, and the ACTUAL fields of the application form (when available). You produce:
1. A cover letter (Markdown, ~250 words, single page) — concrete, references specific things from the JD, no generic platitudes, no hyperbole, no "I am writing to apply for…" openings. Sound like the candidate, not a template.
2. An answer for each application-form field, in the same order the fields are given, using each field's label verbatim as the question.

Rules per field type:
- Free-text / textarea: write the answer the candidate would type. 1-3 sentences for short questions; up to a short paragraph for "why us" / project questions. Ground every claim in the profile — never fabricate experience, numbers, or company knowledge.
- Select: the answer MUST be exactly one of the provided options, character-for-character. Pick using the candidate's canonical screening answers (work auth, demographics, relocation, etc.). For demographic/EEOC questions choose the option matching the canonical answer (e.g. a "decline to answer" option when the canonical answer is "prefer not to say").
- Multiselect: comma-separated subset of the provided options, verbatim.
- Contact fields (name, email, phone, LinkedIn, website, location): fill from the profile if present; otherwise answer with an empty string — never invent contact info.
- Attachment fields (resume, cover letter upload): answer with a short note like "attach data/resume.pdf" or "paste the cover letter above".
- If you don't have a fact, use "prefer not to say" or a brief honest deflection — never fabricate.

Cover letter: lead with the most specific connection between the candidate and this role. One concrete project from their profile + one specific reason this company/role.

Style: NEVER use em dashes (—) or double/triple hyphens in any output. Use a comma, colon, period, or parentheses instead. This applies to the cover letter and every free-text answer.`;

export function buildUserPrompt(args: {
  company: string;
  title: string;
  locationRaw: string;
  jdText: string;
  screeningAnswers: ScreeningAnswers;
  formFields: FormField[];
  formSource: "greenhouse" | "fallback";
}): string {
  return [
    `# Company: ${args.company}`,
    `# Role: ${args.title}`,
    `# Location: ${args.locationRaw}`,
    ``,
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
    ``,
    `## Job description`,
    args.jdText.slice(0, 16000),
  ].join("\n");
}
