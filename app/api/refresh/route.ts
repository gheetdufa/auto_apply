import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    // No macOS notification from the button — you're already looking at the inbox.
    const result = await runPipeline({ notify: false });
    return NextResponse.json({
      backfill: result.ingest.backfill,
      newJobs: result.ingest.newJobs,
      closedJobs: result.ingest.closedJobs,
      enriched: result.enriched,
      drafted: result.drafted,
      perSource: result.ingest.perSource,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
