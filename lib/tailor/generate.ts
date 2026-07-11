import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { FormField } from "@/db/schema";
import { SYSTEM_PROMPT, buildUserPrompt, loadProfile, loadScreeningAnswers } from "./prompt";
import { FALLBACK_FIELDS } from "@/lib/ats/questions";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

const ResultSchema = z.object({
  coverLetterMd: z.string(),
  qa: z.array(z.object({ question: z.string(), answer: z.string() })),
});

export type TailorResult = z.infer<typeof ResultSchema>;

export function tailoringReady(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY (.env.local)");
  try {
    loadProfile();
  } catch {
    missing.push("data/profile.md");
  }
  return { ok: missing.length === 0, missing };
}

export async function generateDraft(args: {
  company: string;
  title: string;
  locationRaw: string;
  jdText: string;
  formFields?: FormField[] | null;
  formSource?: "greenhouse" | "fallback";
}): Promise<{ result: TailorResult; model: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — create .env.local (see .env.local.example)");
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
    formFields: args.formFields && args.formFields.length > 0 ? args.formFields : FALLBACK_FIELDS,
    formSource: args.formSource ?? "fallback",
  });

  const msg = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    // Stable prefix (instructions + profile) is cached; per-job content comes after.
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: `# Candidate profile\n\n${profile}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userText }],
    output_config: { format: zodOutputFormat(ResultSchema) },
  });

  if (!msg.parsed_output) {
    throw new Error(`Model returned no parseable output (stop_reason: ${msg.stop_reason})`);
  }
  return { result: msg.parsed_output, model: MODEL };
}
