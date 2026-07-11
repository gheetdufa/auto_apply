import Link from "next/link";

export const VIEWS = {
  inbox: "Inbox",
  applied: "Applied",
  skipped: "Skipped",
  rejected: "Rejected",
  ghost: "Ghosted",
  closed: "Closed",
} as const;

export type ViewKey = keyof typeof VIEWS;

export function StatusFilters({ current }: { current: ViewKey }) {
  return (
    <div className="flex gap-1 text-sm">
      {(Object.entries(VIEWS) as Array<[ViewKey, string]>).map(([key, label]) => (
        <Link
          key={key}
          href={key === "inbox" ? "/" : `/?view=${key}`}
          className={`rounded px-3 py-1.5 ${
            current === key
              ? "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
              : "text-[color:var(--color-muted)] hover:bg-white/5"
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
