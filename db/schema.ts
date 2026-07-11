import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const JOB_STATUS = ["discovered", "drafted", "applied", "skipped", "rejected", "ghost"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const LOCATION_CLASS = ["sf", "nyc", "remote_us", "other"] as const;
export type LocationClass = (typeof LOCATION_CLASS)[number];

export const ATS_TYPE = ["greenhouse", "lever", "ashby", "workday", "wellfound", "linkedin", "custom", "unknown"] as const;
export type AtsType = (typeof ATS_TYPE)[number];

export const JOB_KIND = ["new-grad", "internship"] as const;
export type JobKind = (typeof JOB_KIND)[number];

/** One field of a real ATS application form (or a canonical fallback question). */
export type FormField = {
  label: string;
  type: "text" | "textarea" | "select" | "multiselect" | "attachment" | "boolean";
  required: boolean;
  options?: string[];
};

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    careersUrl: text("careers_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("companies_normalized_name_idx").on(t.normalizedName)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    kind: text("kind", { enum: JOB_KIND }).notNull().default("new-grad"),
    locationRaw: text("location_raw").notNull(),
    locationClass: text("location_class", { enum: LOCATION_CLASS }).notNull().default("other"),
    applyUrl: text("apply_url").notNull(),
    /** applyUrl after following redirects (simplify.jobs etc.) — set by enrichment. */
    finalUrl: text("final_url"),
    atsType: text("ats_type", { enum: ATS_TYPE }).notNull().default("unknown"),
    postedDate: text("posted_date"),
    sourceRepos: text("source_repos", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status", { enum: JOB_STATUS }).notNull().default("discovered"),
    dedupeKey: text("dedupe_key").notNull(),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    /** When this job first appeared in any source — the "release time" we sort/notify on. */
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    /** Last ingest run that still saw this job in some source. */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    /** Set when the job vanished from all sources (or was marked closed) — hidden from the inbox. */
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    /** True for jobs swept up in a backfill run (first ingest) rather than a genuine new release. */
    backfilled: integer("backfilled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_key_idx").on(t.dedupeKey),
    index("jobs_status_idx").on(t.status),
    index("jobs_location_class_idx").on(t.locationClass),
    index("jobs_first_seen_at_idx").on(t.firstSeenAt),
  ],
);

export const jobDescriptions = sqliteTable("job_descriptions", {
  jobId: integer("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

/** The actual application-form questions for a job (from the ATS API when possible). */
export const applicationForms = sqliteTable("application_forms", {
  jobId: integer("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
  fields: text("fields", { mode: "json" }).$type<FormField[]>().notNull(),
  /** Where the fields came from: "greenhouse" = real form, "fallback" = canonical question set. */
  source: text("source", { enum: ["greenhouse", "fallback"] }).notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const drafts = sqliteTable(
  "drafts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    coverLetterMd: text("cover_letter_md").notNull(),
    qaJson: text("qa_json", { mode: "json" }).$type<Array<{ question: string; answer: string }>>().notNull(),
    model: text("model").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("drafts_job_id_idx").on(t.jobId)],
);

/** Exact record of what auto-apply submitted (or attempted) — per field. */
export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    /** submitted | needs_attention | filled_no_submit | error */
    outcome: text("outcome").notNull(),
    /** Every field label → the answer the engine actually put in the form. */
    answersJson: text("answers_json", { mode: "json" }).$type<Array<{ label: string; answer: string }>>().notNull(),
    resumeAttached: integer("resume_attached", { mode: "boolean" }).notNull().default(false),
    screenshot: text("screenshot"),
    message: text("message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("applications_job_id_idx").on(t.jobId)],
);

export const ingestRuns = sqliteTable("ingest_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("running"),
  newJobs: integer("new_jobs").notNull().default(0),
  closedJobs: integer("closed_jobs").notNull().default(0),
  /** True when this run seeded an empty DB (or mass-inserted) — suppresses notify/auto-draft. */
  backfill: integer("backfill", { mode: "boolean" }).notNull().default(false),
  errorMessage: text("error_message"),
});
