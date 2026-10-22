"use client";

/** Recorder attachment state (recorder-split.md §4) — one shared context fed
 *  by /api/me's `recorder.attached` so live-control surfaces can degrade when
 *  the owner has no recorder (daemon-less platform). `attached` is
 *  null = unknown (before the first /api/me resolves), then boolean. */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface RecorderState {
  attached: boolean | null;
  mode: string | null;
}

const RecorderContext = createContext<RecorderState>({ attached: null, mode: null });

export function RecorderProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RecorderState>({ attached: null, mode: null });

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/me")
        .then((r) => r.json())
        .then((d: { recorder?: { attached?: boolean; mode?: string | null } }) => {
          if (!alive) return;
          setState({
            attached: d.recorder?.attached === true,
            mode: d.recorder?.mode ?? null,
          });
        })
        .catch(() => {});
    load();
    // recorder last_seen staleness is 60s — poll twice as often so a dying
    // recorder flips `attached` off without a full page reload.
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return <RecorderContext.Provider value={state}>{children}</RecorderContext.Provider>;
}

export function useRecorder(): RecorderState {
  return useContext(RecorderContext);
}
