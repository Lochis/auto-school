"use client";

/** Single shared poller for backend status — one 8s interval feeds every
 *  consumer (BackendBar, Calendar, future components) instead of each client
 *  component running its own fetch loop against the controller. */
import { useEffect, useState } from "react";

export interface Status {
  online?: boolean;
  state?: string;
  activity?: string;
  detail?: Record<string, string | number>;
  events?: { ts: string; msg: string }[];
  sessions?: { stem: string; title: string; stage: string; stageNote?: string; segCount?: number; mp4?: string; sizeMB?: number; updatedAt: number }[];
  graph?: boolean;
  graphCode?: { code: string; uri: string; at: number } | null;
  attended?: string[];
  degraded?: string[];
  lastScan?: string | null;
}

let cached: Status | null = null;
const listeners = new Set<(s: Status | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function tick(): void {
  fetch("/api/backend")
    .then((r) => r.json())
    .then((s: Status) => {
      cached = s;
      listeners.forEach((fn) => fn(s));
    })
    .catch(() => {
      cached = { online: false, state: "offline" };
      listeners.forEach((fn) => fn(cached));
    });
}

export function useStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(cached);
  useEffect(() => {
    listeners.add(setStatus);
    if (!timer) {
      timer = setInterval(tick, 8_000);
      tick();
    }
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return status;
}
