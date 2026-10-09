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

/** one model of the fallback chain (from /api/models) */
export interface ModelQuota {
  model: string;
  available: boolean;
  exhausted: boolean;
  lastUsedAt?: string | null;
}
