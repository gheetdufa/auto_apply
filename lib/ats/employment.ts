/**
 * Greenhouse (and similar) boards sometimes put internship / new-grad status
 * in job metadata rather than the title. Jane Street is the canonical case:
 * title is just "Software Engineer", metadata Employment Type = "Summer Internship".
 */

export type GhMeta = { name?: string; value?: string | null };

const EARLY_EMPLOYMENT_RE =
  /\b(intern(ship)?|co-?op|new\s*grad|university|campus|early\s*career|entry[\s-]?level|graduate)\b/i;

const INTERN_EMPLOYMENT_RE = /\b(intern(ship)?|co-?op)\b/i;

export function greenhouseEmploymentType(metadata?: GhMeta[] | null): string | null {
  if (!metadata?.length) return null;
  const hit = metadata.find((m) => /^employment\s*type$/i.test(m.name ?? ""));
  const v = hit?.value?.trim();
  return v || null;
}

export function isEarlyCareerEmployment(employmentType: string | null | undefined): boolean {
  return !!employmentType && EARLY_EMPLOYMENT_RE.test(employmentType);
}

export function isInternshipEmployment(employmentType: string | null | undefined): boolean {
  return !!employmentType && INTERN_EMPLOYMENT_RE.test(employmentType);
}

/** Title used for filters + inbox — appends employment type when title alone is ambiguous. */
export function titleWithEmployment(title: string, employmentType: string | null | undefined): string {
  const t = title.trim();
  const et = employmentType?.trim();
  if (!et || !isEarlyCareerEmployment(et)) return t;
  if (new RegExp(et.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(t)) return t;
  if (EARLY_EMPLOYMENT_RE.test(t)) return t;
  return `${t} (${et})`;
}

export function kindFromTitleOrEmployment(
  title: string,
  employmentType?: string | null,
): "internship" | "new-grad" {
  if (isInternshipEmployment(employmentType) || /\b(intern(ship)?|co-?op)\b/i.test(title)) {
    return "internship";
  }
  return "new-grad";
}
