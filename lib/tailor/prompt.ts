import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PROFILE_PATH = process.env.PROFILE_PATH ?? "./data/profile.md";
const SCREENING_PATH = process.env.SCREENING_PATH ?? "./config/screening-answers.json";

export type ScreeningAnswers = Record<string, string>;

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

Given the candidate's profile and a job description, you produce:
1. A cover letter (Markdown, ~250 words, single page) — concrete, references specific things from the JD, no generic platitudes, no hyperbole, no "I am writing to apply for…" openings. Sound like the candidate, not a template.
2. Tailored answers to ~8 standard screening questions a recruiter or application form would ask.

Rules:
- If you don't have a fact, use "prefer not to say" or a brief honest deflection — never fabricate experience, certifications, or claims about the company.
- Cover letter: lead with the most specific connection between the candidate and this role. One concrete project from their profile + one specific reason this company/role.
- Screening answers: 1-3 sentences each. Plug in canonical answers from the candidate's screening config when relevant (work auth, comp, start date).
- Output strict JSON only, no prose around it.

Output schema:
{
  "coverLetterMd": string,
  "qa": [
    { "question": string, "answer": string }
  ]
}

The 8 screening questions to answer:
1. "Why are you interested in {company}?"
2. "Why this role specifically?"
3. "What's your work authorization status?"
4. "When can you start?"
5. "What are your compensation expectations?"
6. "Tell us about a project you're proud of and your specific contribution."
7. "What programming languages and frameworks are you most comfortable with?"
8. "Is there anything else you'd like the hiring team to know?"`;

export function buildUserPrompt(args: {
  company: string;
  title: string;
  locationRaw: string;
  jdText: string;
  screeningAnswers: ScreeningAnswers;
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
    `## Job description`,
    args.jdText.slice(0, 16000),
    ``,
    `Now produce the JSON output. JSON only.`,
  ].join("\n");
}
