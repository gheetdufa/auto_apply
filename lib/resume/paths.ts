import { existsSync } from "node:fs";
import type { JobKind } from "@/db/schema";
import { jobResumePdfPath } from "./compile-job";

const NEW_GRAD_PATH = process.env.RESUME_PATH ?? "./data/resume.pdf";
const INTERNSHIP_PATH = process.env.RESUME_INTERNSHIP_PATH ?? "./data/resume-internship.pdf";
const TRANSCRIPT_PATH = process.env.TRANSCRIPT_PATH ?? "./data/transcript.pdf";

/** Official undergrad transcript PDF for applications that require it. */
export function transcriptPath(): string | null {
  return existsSync(TRANSCRIPT_PATH) ? TRANSCRIPT_PATH : null;
}

/**
 * Prefer a per-job tailored PDF when present; else the track default
 * (internship → B.S./M.S. 2028, new-grad → B.S. 2027).
 */
export function resumePathForJob(
  jobId: number | null | undefined,
  kind: JobKind | string | null | undefined,
): string {
  if (jobId != null) {
    const tailored = jobResumePdfPath(jobId);
    if (existsSync(tailored)) return tailored;
  }
  return resumePathForKind(kind);
}

export function resumePathForKind(kind: JobKind | string | null | undefined): string {
  if (kind === "internship" && existsSync(INTERNSHIP_PATH)) return INTERNSHIP_PATH;
  return NEW_GRAD_PATH;
}

export function resumePaths(): { newGrad: string; internship: string } {
  return { newGrad: NEW_GRAD_PATH, internship: INTERNSHIP_PATH };
}

/** Contact.json overrides used when filling internship applications. */
export function contactOverridesForKind(kind: JobKind | string | null | undefined): Record<string, string> {
  if (kind !== "internship") return {};
  return {
    degree: "Bachelor's/Master's (B.S./M.S.)",
    graduation: "May 2028",
    discipline: "Computer Science & Math",
  };
}
