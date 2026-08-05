import { existsSync, readFileSync } from "node:fs";
import { resumePaths } from "@/lib/resume/paths";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  const paths = resumePaths();
  const path =
    variant === "new-grad" ? paths.newGrad : variant === "internship" ? paths.internship : null;
  if (!path) return new Response("unknown variant", { status: 404 });
  if (!existsSync(path)) return new Response("not built — run pnpm resume:build", { status: 404 });

  return new Response(readFileSync(path), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${variant}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
