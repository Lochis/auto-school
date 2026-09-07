/** Pure calendar helpers — safe for client components (no node: imports). */
export interface CalEvent {
  start: string | Date;
  end: string | Date;
  online: boolean;
  joinable: boolean;
  title: string;
}

export type EvState = "past" | "live" | "upcoming";

export function evState(ev: CalEvent, now = new Date()): EvState {
  if (now >= new Date(ev.end)) return "past";
  if (now >= new Date(ev.start)) return "live";
  return "upcoming";
}

/** position on a 6:00–24:00 horizontal day strip, in % */
export function stripPos(ev: CalEvent): { left: number; width: number } {
  const stripStart = 6 * 60, stripEnd = 24 * 60;
  const d = (x: string | Date) => new Date(x);
  const clamp = (m: number) => Math.min(Math.max(m, stripStart), stripEnd);
  const s = clamp(d(ev.start).getHours() * 60 + d(ev.start).getMinutes());
  const e = clamp(d(ev.end).getHours() * 60 + d(ev.end).getMinutes());
  return { left: ((s - stripStart) / (stripEnd - stripStart)) * 100, width: Math.max(((e - s) / (stripEnd - stripStart)) * 100, 1.2) };
}
