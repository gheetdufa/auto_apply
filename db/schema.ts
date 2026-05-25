import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const JOB_STATUS = ["discovered", "triaged", "drafted", "applied", "skipped", "rejected", "ghost"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const LOCATION_CLASS = ["sf", "nyc", "remote_us", "other"] as const;
export type LocationClass = (typeof LOCATION_CLASS)[number];

export const ATS_TYPE = ["greenhouse", "lever", "ashby", "workday", "wellfound", "linkedin", "custom", "unknown"] as const;
export type AtsType = (typeof ATS_TYPE)[number];

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
    locationRaw: text("location_raw").notNull(),
    locationClass: text("location_class", { enum: LOCATION_CLASS }).notNull().default("other"),
    applyUrl: text("apply_url").notNull(),
    atsType: text("ats_type", { enum: ATS_TYPE }).notNull().default("unknown"),
    postedDate: text("posted_date"),
    sourceRepos: text("source_repos", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status", { enum: JOB_STATUS }).notNull().default("discovered"),
    dedupeKey: text("dedupe_key").notNull(),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_key_idx").on(t.dedupeKey),
    index("jobs_status_idx").on(t.status),
    index("jobs_location_class_idx").on(t.locationClass),
  ],
);

export const jobDescriptions = sqliteTable("job_descriptions", {
  jobId: integer("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
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

export const ingestRuns = sqliteTable("ingest_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("running"),
  newJobs: integer("new_jobs").notNull().default(0),
  triagedJobs: integer("triaged_jobs").notNull().default(0),
  errorMessage: text("error_message"),
});
