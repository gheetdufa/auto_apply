import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SYSTEM_PROMPT, buildUserPrompt, loadProfile, loadScreeningAnswers } from "./prompt";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

const QASchema = z.object({ question: z.string(), answer: z.string() });
const ResultSchema = z.object({
  coverLetterMd: z.string(),
  qa: z.array(QASchema),
});

export type TailorResult = z.infer<typeof ResultSchema>;

export async function generateDraft(args: {
  company: string;
  title: string;
  locationRaw: string;
  jdText: string;
}): Promise<{ result: TailorResult; model: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set in environment");
  }
  const client = new Anthropic();
  const profile = loadProfile();
  const screening = loadScreeningAnswers();

  const userText = buildUserPrompt({
    company: args.company,
    title: args.title,
    locationRaw: args.locationRaw,
    jdText: args.jdText,
    screeningAnswers: screening,
  });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: `# Candidate profile\n\n${profile}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userText }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const parsed = ResultSchema.parse(extractJson(text));
  return { result: parsed, model: MODEL };
}

function extractJson(s: string): unknown {
  const trimmed = s.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`Could not parse JSON from model output: ${s.slice(0, 200)}…`);
  }
}
