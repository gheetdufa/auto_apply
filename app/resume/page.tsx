import { existsSync, statSync } from "node:fs";
import Link from "next/link";
import { pdfPageCount } from "@/lib/resume/page-count";
import { resumePaths } from "@/lib/resume/paths";

export const dynamic = "force-dynamic";

const VARIANTS = [
  { slug: "new-grad", label: "New grad", detail: "B.S., May 2027 — full-time applications" },
  { slug: "internship", label: "Internship", detail: "B.S./M.S., May 2028 — internship applications" },
] as const;

export default function ResumePage() {
  const paths = resumePaths();

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">
          <Link href="/" className="text-[color:var(--color-muted)] hover:text-[color:var(--color-accent)]">
            auto-apply
          </Link>{" "}
          / resume
        </h1>
        <p className="text-[color:var(--color-muted)] text-sm mt-1">
          These exact PDFs get attached to applications. Edit{" "}
          <span className="font-mono text-[13px]">resume/resume.tex</span>, then{" "}
          <span className="font-mono text-[13px]">pnpm resume:build</span> and refresh.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {VARIANTS.map((v) => {
          const path = v.slug === "new-grad" ? paths.newGrad : paths.internship;
          const built = existsSync(path);
          const pages = built ? pdfPageCount(path) : 0;
          const mtime = built ? statSync(path).mtime : null;
          return (
            <section key={v.slug} className="rounded-lg border bg-[color:var(--color-panel)] overflow-hidden">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div>
                  <h2 className="text-sm font-medium">{v.label}</h2>
                  <p className="text-xs text-[color:var(--color-muted)]">{v.detail}</p>
                </div>
                {built ? (
                  <div className="text-right">
                    {pages === 1 ? (
                      <span className="rounded bg-[color:var(--color-success)]/10 px-2 py-1 text-xs text-[color:var(--color-success)]">
                        1 page ✓
                      </span>
                    ) : (
                      <span className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
                        {pages || "?"} pages — trim it
                      </span>
                    )}
                    {mtime && (
                      <p className="mt-1 text-[10px] text-[color:var(--color-muted)]">
                        built {mtime.toLocaleString()}
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-400">not built</span>
                )}
              </div>
              {built ? (
                <iframe
                  src={`/api/resume/${v.slug}#toolbar=0&navpanes=0`}
                  title={`${v.label} resume`}
                  className="h-[75vh] w-full bg-white"
                />
              ) : (
                <div className="px-6 py-12 text-center text-sm text-[color:var(--color-muted)]">
                  Run <span className="font-mono text-[13px]">pnpm resume:build</span> to generate this PDF.
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
