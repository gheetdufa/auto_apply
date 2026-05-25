import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobs, jobDescriptions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fetchJd } from "@/lib/jd/fetch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const fetched = await fetchJd(job.applyUrl, job.atsType);
    await db
      .insert(jobDescriptions)
      .values({ jobId: id, text: fetched.text })
      .onConflictDoUpdate({ target: jobDescriptions.jobId, set: { text: fetched.text, fetchedAt: new Date() } });
    if (fetched.ats !== job.atsType) {
      await db.update(jobs).set({ atsType: fetched.ats, updatedAt: new Date() }).where(eq(jobs.id, id));
    }
    return NextResponse.json({ ok: true, length: fetched.text.length, ats: fetched.ats });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
