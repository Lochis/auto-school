"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import type { AuthUser } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Schedule" },
  { href: "/courses", label: "Courses & Deadlines" },
];

export default function Navbar() {
  const pathname = usePathname() ?? "/";
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Phase 0 identity: resolve the Authentik user via the edge headers
  // (null in local dev / when header trust is off — avatar stays plain).
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: AuthUser | null }) => alive && setUser(d.user))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <header className="app-header">
      <div className="app-header-inner">
        {/* left: brand + cron status */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-lg)", minWidth: 0 }}>
          <Link href="/" className="brand" aria-label="auto-school home">
            <span className="brand-word">
              auto<em>school</em>
            </span>
          </Link>
        </div>

        {/* center: pill nav */}
        <nav className="segmented-tabs" aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`segmented-tab ${isActive(item.href) ? "segmented-tab--active" : ""}`.trim()}
              aria-current={isActive(item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* right: avatar + identity */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          {user && (
            <span className="nav-user" title={user.email || user.username}>
              {user.role === "admin" && <span className="nav-user-role" title="admin">admin</span>}
              {user.username}
            </span>
          )}
          <Link href="/settings" className="avatar-btn" title={user ? `Account — ${user.username}` : "Account"} aria-label="Account">
            <UserIcon className="heroicon" style={{ display: "inline", width: 16, height: 16 }} />
          </Link>
        </div>
      </div>
    </header>
  );
}
