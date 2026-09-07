"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-render the server components on an interval so the course list,
 *  sessions and calendar stay current while the page is open — without
 *  any coupling to the backend (which runs whether or not this UI exists). */
export default function AutoRefresh({ interval = 30_000 }: { interval?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), interval);
    return () => clearInterval(t);
  }, [router, interval]);
  return null;
}
