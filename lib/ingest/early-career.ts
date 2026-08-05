/**
 * Shared early-career title detection used by board scout, Remotive, Google
 * careers scout, and the mega-tech blocklist exception.
 */
export const EARLY_CAREER_RE =
  /\b(new\s*grad|new\s*college\s*grad|college\s*grad|university\s*grad(uate)?|graduate|campus|early\s*career|entry[\s-]?level|junior|associate|intern(ship)?|co-?op|engineer\s+i\b|swe\s+i\b|sde\s+i\b|amts\b|career\s+catalyst|university\s+hire|recent\s+grad|20(26|27))\b/i;

/** Explicit senior markers — used to keep ambient tier honest. */
export const SENIOR_TITLE_RE =
  /\b(senior|staff|principal|lead|manager|director|head|vp|chief|architect|distinguished|experienced|ph\.?d|sr\.?|iii|iv|[4-9]\+?\s*(years|yrs))\b/i;

export function isEarlyCareerTitle(title: string): boolean {
  return EARLY_CAREER_RE.test(title);
}
