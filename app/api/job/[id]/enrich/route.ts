import { NextResponse } from "next/server";
import { enrichJob } from "@/lib/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Resolve final URL + ATS, fetch JD, fetch real application-form questions. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const result = await enrichJob(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, jdLength: result.jdLength, formSource: result.formSource });
}
