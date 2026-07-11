import { NextResponse } from "next/server";
import { runApplyForJob } from "@/lib/apply/run-job";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-click apply: ensure draft exists, guard against double-applying to the
 * same company, drive the browser, and record exactly what was submitted.
 * Pass ?force=1 to override the double-apply guard.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const force = new URL(req.url).searchParams.get("force") === "1";

  try {
    const result = await runApplyForJob(id, { force });
    if ("blocked" in result) return NextResponse.json({ blocked: result.blocked }, { status: 409 });
    return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
