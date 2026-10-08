/** Shared client types for the course "Ask" chat tab. */

export interface Msg {
  role: "user" | "assistant";
  content: string;
  at?: string;
}

export interface LexHit {
  course: string;
  path: string;
}

/** one indexed material of a course (from /api/courses/[slug]/materials) */
export interface MaterialEntry {
  path: string;
  filename: string;
  week?: number | null;
  category?: string;
  description?: string;
  uploadedAt?: string;
  size?: number;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  doneAt?: number | null;
  manual?: boolean;
}

export interface Checklist {
  deadlineId: string;
  course: string;
  title: string;
  items: ChecklistItem[];
  updatedAt: number;
}

/** the fields of a deadline entry the chat rail needs (from /api/deadlines) */
export interface DeadEntryLite {
  id: string;
  course: string;
  title: string;
  due: string | null;
  kind?: string;
  note?: string;
  done?: boolean;
}

/** one model of the fallback chain (from /api/models) */
export interface ModelQuota {
  model: string;
  available: boolean;
  exhausted: boolean;
  lastUsedAt?: string | null;
}
