import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobs, JOB_STATUS, type JobStatus } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = (await req.json()) as { status: JobStatus };
  if (!JOB_STATUS.includes(body.status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
  await db.update(jobs).set({ status: body.status, updatedAt: new Date() }).where(eq(jobs.id, id));
  return NextResponse.json({ ok: true });
}
