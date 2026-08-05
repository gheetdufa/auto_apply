import { existsSync, readFileSync } from "node:fs";
import { jobResumePdfPath } from "@/lib/resume/compile-job";
import { resumePathForKind } from "@/lib/resume/paths";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Serve the per-job tailored resume, or the track default if not built yet. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return new Response("bad id", { status: 400 });

  const tailored = jobResumePdfPath(id);
  if (existsSync(tailored)) {
    return new Response(readFileSync(tailored), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="resume-job-${id}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const [row] = await db.select({ kind: jobs.kind }).from(jobs).where(eq(jobs.id, id));
  const fallback = resumePathForKind(row?.kind);
  if (!existsSync(fallback)) return new Response("resume not built — run pnpm resume:build", { status: 404 });
  return new Response(readFileSync(fallback), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="resume-${row?.kind ?? "new-grad"}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
