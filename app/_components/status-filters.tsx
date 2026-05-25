import Link from "next/link";
import { JOB_STATUS, type JobStatus } from "@/db/schema";

const LABELS: Record<JobStatus, string> = {
  discovered: "Discovered",
  triaged: "Triaged",
  drafted: "Drafted",
  applied: "Applied",
  skipped: "Skipped",
  rejected: "Rejected",
  ghost: "Ghosted",
};

export function StatusFilters({ current }: { current: JobStatus }) {
  return (
    <div className="flex gap-1 text-sm">
      {JOB_STATUS.map((s) => (
        <Link
          key={s}
          href={`/?status=${s}`}
          className={`rounded px-3 py-1.5 ${
            current === s
              ? "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
              : "text-[color:var(--color-muted)] hover:bg-white/5"
          }`}
        >
          {LABELS[s]}
        </Link>
      ))}
    </div>
  );
}
