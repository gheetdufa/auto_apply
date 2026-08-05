"use client";

import { useMemo, useState } from "react";
import { discoveryCatalog, type DiscoverySource } from "@/lib/discovery/catalog";

const KIND_LABEL: Record<DiscoverySource["kind"], string> = {
  "github-list": "GitHub lists",
  "ats-board": "ATS boards",
  "careers-site": "Career sites",
  aggregator: "Aggregators",
  forum: "Forums",
};

export function SourcesPanel() {
  const [open, setOpen] = useState(false);
  const sources = useMemo(() => discoveryCatalog(), []);
  const grouped = useMemo(() => {
    const map = new Map<DiscoverySource["kind"], DiscoverySource[]>();
    for (const s of sources) {
      const list = map.get(s.kind) ?? [];
      list.push(s);
      map.set(s.kind, list);
    }
    return map;
  }, [sources]);

  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-[color:var(--color-panel)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm"
      >
        <span>
          Fetch sources <span className="text-[color:var(--color-muted)]">({sources.length})</span>
        </span>
        <span className="text-[color:var(--color-muted)]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-white/10 px-4 py-3 text-sm">
          <p className="text-[color:var(--color-muted)] text-xs">
            Everything Refresh polls. Point me at more career sites / GitHub lists / board tokens and
            I&apos;ll wire them in.
          </p>
          {([...grouped.entries()] as Array<[DiscoverySource["kind"], DiscoverySource[]]>).map(
            ([kind, items]) => (
              <div key={kind}>
                <h3 className="mb-1.5 text-xs uppercase tracking-wide text-[color:var(--color-muted)]">
                  {KIND_LABEL[kind]}
                </h3>
                <ul className="space-y-2">
                  {items.map((s) => (
                    <li key={s.key} className="leading-snug">
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[color:var(--color-accent)] hover:underline"
                        >
                          {s.label}
                        </a>
                      ) : (
                        <span>{s.label}</span>
                      )}
                      <div className="text-xs text-[color:var(--color-muted)]">{s.detail}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
