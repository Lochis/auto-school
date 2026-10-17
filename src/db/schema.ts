/** Drizzle schema — typed mirror of src/db/ddl.sql (the authoritative DDL,
 *  applied via psql; see docs/planning/postgres-migration.md §2). Table,
 *  column, CHECK, UNIQUE and index names follow the DDL. Constraint names for
 *  FKs are drizzle-generated (DDL authority is ddl.sql). */
import { sql } from "drizzle-orm";
import {
  pgTable, text, uuid, integer, bigint, bigserial, boolean, date, time, timestamp,
  numeric, jsonb, index, unique, check, customType,
} from "drizzle-orm/pg-core";

/** pgvector column — drizzle-orm has no native vector type (as of 0.45.x).
 *  Values cross the driver as strings ('[0.1,0.2,…]'); pgvector parses/prints
 *  that form itself. */
const vector768 = customType<{ data: string; driverData: string }>({
  dataType() { return "vector(768)"; },
});

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// ── users (stub; full design in authentik-federation.md) ──────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  authentikSub: text("authentik_sub").unique("users_authentik_sub_key"),
  username: text("username").unique("users_username_key"),
  email: text("email").unique("users_email_key"),
  displayName: text("display_name").notNull().default(""),
  role: text("role").notNull().default("owner"),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  check("users_role_check", sql`${t.role} IN ('owner','member','viewer')`),
]);

// ── courses (replaces folder-union + course.json) ─────────────────────────
export const courses = pgTable("courses", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  slug: text("slug").notNull().unique("courses_slug_key"),
  name: text("name").notNull(),
  code: text("code").notNull().default("GEN"),
  icon: text("icon"),
  semesterStart: date("semester_start"),
  ownerUserId: uuid("owner_user_id").notNull()
    .default("00000000-0000-0000-0000-000000000001").references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

// ── meeting mappings (replaces mapping.json) ──────────────────────────────
export const meetingMappings = pgTable("meeting_mappings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  matchTitle: text("match_title").notNull().unique("meeting_mappings_match_title_key"),
  normTitle: text("norm_title").notNull(),
  courseId: bigint("course_id", { mode: "number" }).notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("manual"),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  check("meeting_mappings_source_check", sql`${t.source} IN ('manual','auto')`),
  index("meeting_mappings_norm_idx").on(t.normTitle.op("text_pattern_ops")),
]);

// ── sessions (replaces out/sessions.json + note/recording stems as identity) ──
export const sessions = pgTable("sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  courseId: bigint("course_id", { mode: "number" }).notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  stem: text("stem").notNull(),
  sessionDate: date("session_date").notNull(),
  startTime: time("start_time"),
  title: text("title"),
  joinUrl: text("join_url"),
  stage: text("stage").notNull().default("recording"),
  stageNote: text("stage_note"),
  segCount: integer("seg_count"),
  durationSec: numeric("duration_sec", { precision: 10, scale: 2 }),
  sizeMb: numeric("size_mb", { precision: 10, scale: 2 }),
  startedAt: tstz("started_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
}, (t) => [
  check("sessions_stage_check",
    sql`${t.stage} IN ('recording','remuxing','transcribing','noting','consolidating','done','failed')`),
  unique("sessions_course_id_stem_key").on(t.courseId, t.stem),
  index("sessions_course_date_idx")
    .on(t.courseId, sql`${t.sessionDate} DESC`, sql`${t.startTime} DESC NULLS LAST`),
]);

// ── session artifacts (recordings / notes / transcripts / timelines as rows) ──
export const sessionArtifacts = pgTable("session_artifacts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: bigint("session_id", { mode: "number" }).notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  storageUri: text("storage_uri"),
  relPath: text("rel_path").notNull(),
  mimeType: text("mime_type"),
  bytes: bigint("bytes", { mode: "number" }),
  checksum: text("checksum"),
  content: text("content"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  deletedAt: tstz("deleted_at"),
  retainedUntil: tstz("retained_until"),
}, (t) => [
  check("session_artifacts_kind_check",
    sql`${t.kind} IN ('recording','notes','running_notes','transcript','timeline','audio_ogg')`),
  unique("session_artifacts_session_id_kind_rel_path_key").on(t.sessionId, t.kind, t.relPath),
  index("session_artifacts_retention_idx").on(t.retainedUntil)
    .where(sql`${t.deletedAt} IS NULL AND ${t.kind} = 'recording'`),
]);

// ── transcript segments (replaces __timeline.json / out/timeline.jsonl rows) ──
export const transcriptSegments = pgTable("transcript_segments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: bigint("session_id", { mode: "number" }).notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  segIndex: integer("seg_index").notNull(),
  offsetSec: integer("offset_sec").notNull(),
  file: text("file"),
  transcript: text("transcript").notNull().default(""),
  visualNotes: jsonb("visual_notes").$type<Array<{ t: number; note: string }>>()
    .notNull().default([]),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  unique("transcript_segments_session_id_offset_sec_key").on(t.sessionId, t.offsetSec),
]);

// ── documents (materials + ingested notes/transcripts as searchable docs) ──
export const documents = pgTable("documents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  courseId: bigint("course_id", { mode: "number" }).notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("material"),
  sessionId: bigint("session_id", { mode: "number" }).references(() => sessions.id, { onDelete: "cascade" }),
  relPath: text("rel_path").notNull(),
  filename: text("filename").notNull(),
  week: integer("week"),
  category: text("category").notNull().default("other"),
  description: text("description").notNull().default(""),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  checksum: text("checksum"),
  pageCount: integer("page_count"),
  uploadedAt: tstz("uploaded_at"),
  indexedAt: tstz("indexed_at"),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
}, (t) => [
  check("documents_kind_check", sql`${t.kind} IN ('material','notes','transcript','timeline')`),
  check("documents_week_check", sql`${t.week} BETWEEN 1 AND 15`),
  check("documents_category_check",
    sql`${t.category} IN ('syllabus','assignment','lecture-notes','reference','rubric','transcript','other')`),
  unique("documents_course_id_kind_rel_path_key").on(t.courseId, t.kind, t.relPath),
  index("documents_course_week_idx").on(t.courseId, sql`${t.week} NULLS LAST`),
]);

export const documentChunks = pgTable("document_chunks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  documentId: bigint("document_id", { mode: "number" }).notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  page: integer("page").notNull().default(1),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  tokenCount: integer("token_count"),
  embedding: vector768("embedding"),
  embeddingModel: text("embedding_model").notNull().default("text-embedding-004"),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  unique("document_chunks_document_id_page_chunk_index_key").on(t.documentId, t.page, t.chunkIndex),
  index("document_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  index("document_chunks_model_idx").on(t.embeddingModel),
]);

// ── deadlines / folds / checklists (user-data JSON files) ─────────────────
export const deadlines = pgTable("deadlines", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  legacyId: text("legacy_id"),
  courseId: bigint("course_id", { mode: "number" }).notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  due: date("due"),
  dueManual: boolean("due_manual").notNull().default(false),
  kind: text("kind").notNull().default(""),
  spread: boolean("spread").notNull().default(false),
  startBy: date("start_by"),
  note: text("note").notNull().default(""),
  source: text("source").notNull().default(""),
  confidence: text("confidence").notNull().default("high"),
  done: boolean("done").notNull().default(false),
  doneAt: tstz("done_at"),
  userNote: text("user_note"),
  stale: bigint("stale", { mode: "number" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
}, (t) => [
  check("deadlines_confidence_check", sql`${t.confidence} IN ('high','medium','low')`),
  unique("deadlines_course_id_title_key").on(t.courseId, t.title, t.legacyId),
]);

export const deadlineParts = pgTable("deadline_parts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  deadlineId: bigint("deadline_id", { mode: "number" }).notNull()
    .references(() => deadlines.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  due: date("due"),
  note: text("note").notNull().default(""),
  done: boolean("done").notNull().default(false),
});

export const deadlineFolds = pgTable("deadline_folds", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  parentId: bigint("parent_id", { mode: "number" }).notNull()
    .references(() => deadlines.id, { onDelete: "cascade" }),
  childId: bigint("child_id", { mode: "number" }).notNull()
    .references(() => deadlines.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  chosenParentId: bigint("chosen_parent_id", { mode: "number" }).references(() => deadlines.id),
  addedItemIds: jsonb("added_item_ids").$type<string[]>().notNull().default([]),
  enriched: jsonb("enriched").$type<{ itemId: string; prevText: string; prevDone: boolean } | null>(),
  childSnapshot: jsonb("child_snapshot").$type<Record<string, unknown>>().notNull(),
  foldedAt: tstz("folded_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  check("deadline_folds_status_check", sql`${t.status} IN ('pending','accepted','declined')`),
  unique("deadline_folds_parent_id_child_id_key").on(t.parentId, t.childId),
]);

export const checklistItems = pgTable("checklist_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  deadlineId: bigint("deadline_id", { mode: "number" }).notNull()
    .references(() => deadlines.id, { onDelete: "cascade" }),
  legacyKey: text("legacy_key").notNull(),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  doneAt: tstz("done_at"),
  manual: boolean("manual").notNull().default(false),
  position: integer("position").notNull().default(0),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("checklist_items_deadline_id_legacy_key_key").on(t.deadlineId, t.legacyKey),
]);

// ── operational tables ────────────────────────────────────────────────────
export const activityEvents = pgTable("activity_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: tstz("ts").notNull().defaultNow(),
  msg: text("msg").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
}, (t) => [
  index("activity_events_ts_idx").on(sql`${t.ts} DESC`),
]);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

// ── chat / attendance / left-meetings / deadlines-meta (Phase 4 completion) ──
export const chatMessages = pgTable("chat_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  scope: text("scope").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  at: tstz("at").notNull(),
  ownerUserId: uuid("owner_user_id").notNull()
    .default("00000000-0000-0000-0000-000000000001").references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  check("chat_messages_role_check", sql`${t.role} IN ('user','assistant')`),
  index("chat_messages_scope_idx").on(t.ownerUserId, t.scope, t.id),
]);

export const attendance = pgTable("attendance", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  date: text("date").notNull(),
  title: text("title").notNull(),
  joinedAt: bigint("joined_at", { mode: "number" }).notNull(),
  leftAt: bigint("left_at", { mode: "number" }),
  ownerUserId: uuid("owner_user_id").notNull()
    .default("00000000-0000-0000-0000-000000000001").references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  unique("attendance_owner_date_title_joined_key").on(t.ownerUserId, t.date, t.title, t.joinedAt),
  index("attendance_date_idx").on(t.ownerUserId, t.date),
]);

export const leftMeetings = pgTable("left_meetings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  day: text("day").notNull(),
  title: text("title").notNull(),
  ownerUserId: uuid("owner_user_id").notNull()
    .default("00000000-0000-0000-0000-000000000001").references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  unique("left_meetings_owner_day_title_key").on(t.ownerUserId, t.day, t.title),
]);

export const deadlinesMeta = pgTable("deadlines_meta", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  docKey: text("doc_key").notNull(),
  mtime: bigint("mtime", { mode: "number" }).notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  course: text("course").notNull(),
  ownerUserId: uuid("owner_user_id").notNull()
    .default("00000000-0000-0000-0000-000000000001").references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [
  unique("deadlines_meta_owner_doc_key_key").on(t.ownerUserId, t.docKey),
]);
