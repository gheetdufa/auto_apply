import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JobKind } from "@/db/schema";
import { pdfPageCount } from "./page-count";
import { assembleLatex, planResume, type TailoredResumePlan } from "./assemble";
import { applyLlmPlan, type LlmResumePlan } from "./llm-plan";

const RESUMES_DIR = process.env.JOB_RESUMES_DIR ?? "./data/resumes";

export type JobResumeArtifacts = {
  pdfPath: string;
  texPath: string;
  metaPath: string;
  plan: TailoredResumePlan;
  pages: number;
};

export function jobResumePdfPath(jobId: number): string {
  return resolve(RESUMES_DIR, `${jobId}.pdf`);
}

export function jobResumeMetaPath(jobId: number): string {
  return resolve(RESUMES_DIR, `${jobId}.meta.json`);
}

export function loadJobResumeMeta(jobId: number): TailoredResumePlan | null {
  const p = jobResumeMetaPath(jobId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TailoredResumePlan;
  } catch {
    return null;
  }
}

/** Compile LaTeX in the job's work dir; returns page count (throws on tectonic failure). */
function compileOnce(work: string, latex: string): number {
  const texName = "resume.tex";
  writeFileSync(join(work, texName), latex);
  execFileSync("tectonic", ["-X", "compile", texName], { cwd: work, stdio: "pipe" });
  const builtPdf = join(work, "resume.pdf");
  if (!existsSync(builtPdf)) throw new Error("no PDF produced");
  return pdfPageCount(builtPdf);
}

/**
 * Build a one-page PDF tailored to this job: education track + ranked projects
 * + JD-matched skill ordering. Writes data/resumes/<jobId>.{tex,pdf,meta.json}.
 *
 * When an LLM plan is provided it is validated against the catalog and tried
 * first; if it fails to compile or overflows one page, the deterministic
 * heuristic plan is used instead — this function never fails because of the LLM.
 */
export function tailorResumeForJob(args: {
  jobId: number;
  kind: JobKind | string | null | undefined;
  title: string;
  jdText: string;
  llmPlan?: LlmResumePlan;
}): JobResumeArtifacts {
  const basePlan = planResume({ kind: args.kind, title: args.title, jdText: args.jdText });

  const candidates: TailoredResumePlan[] = [];
  if (args.llmPlan) {
    try {
      candidates.push(applyLlmPlan(args.llmPlan, basePlan));
    } catch (e) {
      console.warn(`[resume] LLM plan invalid for job ${args.jobId}, using heuristic:`, e);
    }
  }
  candidates.push(basePlan);

  mkdirSync(resolve(RESUMES_DIR), { recursive: true });
  const work = resolve(RESUMES_DIR, `_build_${args.jobId}`);
  mkdirSync(work, { recursive: true });

  let plan: TailoredResumePlan | null = null;
  let latex = "";
  let pages = 0;
  for (const candidate of candidates) {
    const candidateLatex = assembleLatex(candidate);
    try {
      pages = compileOnce(work, candidateLatex);
    } catch (e) {
      if (candidate.source === "llm") {
        console.warn(`[resume] LLM plan failed to compile for job ${args.jobId}, using heuristic`);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`tectonic failed for job ${args.jobId}: ${msg}`);
    }
    if (pages !== 1) {
      if (candidate.source === "llm") {
        console.warn(`[resume] LLM plan is ${pages} pages for job ${args.jobId}, using heuristic`);
        continue;
      }
      throw new Error(`tailored resume for job ${args.jobId} is ${pages} pages — expected 1`);
    }
    plan = candidate;
    latex = candidateLatex;
    break;
  }
  if (!plan) throw new Error(`no compilable resume plan for job ${args.jobId}`);

  const pdfPath = jobResumePdfPath(args.jobId);
  const finalTex = resolve(RESUMES_DIR, `${args.jobId}.tex`);
  const metaPath = jobResumeMetaPath(args.jobId);
  copyFileSync(join(work, "resume.pdf"), pdfPath);
  writeFileSync(finalTex, latex);
  writeFileSync(metaPath, JSON.stringify(plan, null, 2) + "\n");

  return { pdfPath, texPath: finalTex, metaPath, plan, pages };
}
