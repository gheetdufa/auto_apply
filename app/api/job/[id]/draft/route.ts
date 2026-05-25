import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobs, companies, jobDescriptions, drafts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateDraft } from "@/lib/tailor/generate";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const [row] = await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      locationRaw: jobs.locationRaw,
      company: companies.name,
      jd: jobDescriptions.text,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(jobDescriptions, eq(jobDescriptions.jobId, jobs.id))
    .where(eq(jobs.id, id));

  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!row.jd) return NextResponse.json({ error: "fetch JD first" }, { status: 400 });

  try {
    const { result, model } = await generateDraft({
      company: row.company,
      title: row.title,
      locationRaw: row.locationRaw,
      jdText: row.jd,
    });
    const [inserted] = await db
      .insert(drafts)
      .values({
        jobId: id,
        coverLetterMd: result.coverLetterMd,
        qaJson: result.qa,
        model,
      })
      .returning();
    await db.update(jobs).set({ status: "drafted", updatedAt: new Date() }).where(eq(jobs.id, id));
    return NextResponse.json({ ok: true, draftId: inserted.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = (await req.json()) as { coverLetterMd: string; qa: Array<{ question: string; answer: string }> };
  const [latest] = await db.select().from(drafts).where(eq(drafts.jobId, id)).orderBy(desc(drafts.createdAt)).limit(1);
  if (!latest) return NextResponse.json({ error: "no draft" }, { status: 404 });

  await db
    .insert(drafts)
    .values({ jobId: id, coverLetterMd: body.coverLetterMd, qaJson: body.qa, model: `${latest.model}+edit` });
  return NextResponse.json({ ok: true });
}
