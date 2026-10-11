"use client";

/** Shared playback sync between the AudioPlayer HUD and the transcript
 *  timeline on the session page: the player reports its playhead position and
 *  registers a seek function; timeline rows highlight + seek through it. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface SessionSyncApi {
  /** current playhead seconds (updated by the player) */
  t: number;
  setTime: (seconds: number) => void;
  seek: (seconds: number) => void;
  registerSeek: (fn: ((seconds: number) => void) | null) => void;
}

const SessionSyncCtx = createContext<SessionSyncApi | null>(null);

/** Nullable on purpose: AudioPlayer is also mounted on the course page where
 *  no provider exists — it just runs standalone there. */
export function useSessionSync(): SessionSyncApi | null {
  return useContext(SessionSyncCtx);
}

export function SessionSyncProvider({ children }: { children: React.ReactNode }) {
  const [t, setT] = useState(0);
  const seekRef = useRef<((seconds: number) => void) | null>(null);
  const setTime = useCallback((seconds: number) => setT(seconds), []);
  const seek = useCallback((seconds: number) => seekRef.current?.(seconds), []);
  const registerSeek = useCallback((fn: ((seconds: number) => void) | null) => {
    seekRef.current = fn;
  }, []);
  const value = useMemo(() => ({ t, setTime, seek, registerSeek }), [t, setTime, seek, registerSeek]);
  return <SessionSyncCtx.Provider value={value}>{children}</SessionSyncCtx.Provider>;
}
