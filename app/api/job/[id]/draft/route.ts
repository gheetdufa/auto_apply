import { NextResponse } from "next/server";
import { db } from "@/db";
import { drafts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { draftJobById } from "@/lib/tailor/draft-job";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** Generate a tailored draft (auto-enriches first if the JD is missing). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  try {
    const { draftId } = await draftJobById(id);
    return NextResponse.json({ ok: true, draftId });
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
