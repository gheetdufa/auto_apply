import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { LiveField } from "./extract";
import { loadScreeningAnswers } from "@/lib/tailor/prompt";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

const Result = z.object({
  answers: z.array(z.object({ idx: z.number(), answer: z.string().nullable() })),
});

/**
 * One Claude call to answer live form fields that code couldn't map from the
 * draft — this is what makes auto-apply work on ATSes we've never seen.
 * Returns idx → answer; null answers mean "leave blank".
 */
export async function resolveFieldsWithClaude(args: {
  fields: LiveField[];
  company: string;
  title: string;
  jdText: string;
  coverLetterMd: string;
  qa: Array<{ question: string; answer: string }>;
  contact: Record<string, string>;
}): Promise<Map<number, string>> {
  if (args.fields.length === 0 || !process.env.ANTHROPIC_API_KEY) return new Map();
  const client = new Anthropic();

  const system = `You fill real job-application form fields for a candidate. You get the live form fields (with exact options where applicable) plus the candidate's contact info, canonical screening answers, an already-tailored Q&A draft, and a tailored cover letter.

Rules:
- For select/radio/checkbox/combobox fields: the answer MUST be exactly one of the provided options, character-for-character (for checkbox groups, a comma-separated subset). If options are not provided (combobox), give the most standard short value (e.g. "United States", "Yes", "No").
- A checkbox with a SINGLE option is a boolean toggle: answer "Yes" to tick it (e.g. "are you authorized to work" when the candidate is), null to leave it unticked (e.g. "do you require sponsorship" when they don't).
- Contact/identity fields: use the contact JSON verbatim. Never invent contact info.
- Demographic/EEOC (gender, race, ethnicity, veteran, disability, orientation): ALWAYS pick the decline/prefer-not-to-answer option when one exists. If no decline option exists, answer null (leave it blank) — never assert demographic facts not in the canonical answers.
- Free text: reuse the tailored Q&A draft when a question matches; otherwise write 1-3 grounded sentences in the candidate's voice. A "cover letter" or "additional information" textarea gets the cover letter text.
- Fields that ask for things the candidate doesn't have (e.g. "referral employee name"): answer null.
- Never fabricate credentials, availability, or authorizations beyond the canonical answers.
- NEVER use em dashes (—) in free-text answers. Use a comma, colon, period, or parentheses instead.
Return an answer (or null) for EVERY field idx given.`;

  const user = [
    `# Company: ${args.company}`,
    `# Role: ${args.title}`,
    ``,
    `## Contact (use verbatim)`,
    JSON.stringify(args.contact),
    ``,
    `## Canonical screening answers (use verbatim when relevant)`,
    JSON.stringify(loadScreeningAnswers()),
    ``,
    `## Tailored Q&A draft`,
    JSON.stringify(args.qa),
    ``,
    `## Tailored cover letter`,
    args.coverLetterMd,
    ``,
    `## Job description (context)`,
    args.jdText.slice(0, 6000),
    ``,
    `## Form fields to answer`,
    JSON.stringify(args.fields, null, 1),
  ].join("\n");

  const msg = await client.messages.parse({
    model: MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(Result) },
  });

  const map = new Map<number, string>();
  for (const a of msg.parsed_output?.answers ?? []) {
    if (a.answer !== null && a.answer.trim() !== "") map.set(a.idx, a.answer);
  }
  return map;
}
