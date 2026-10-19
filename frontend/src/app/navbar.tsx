"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRightStartOnRectangleIcon,
  Cog6ToothIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Schedule" },
  { href: "/courses", label: "Courses & Deadlines" },
];

/** Avatar from the DB-backed /api/me/avatar route (Gap 4; served from
 *  users.avatar, synced lazily from the identity provider's picture claim);
 *  falls back to the user icon when absent or 404 (local dev, not yet synced). */
function AvatarImg({ src, size }: { src?: string; size: number }) {
  const [err, setErr] = useState(false);
  if (!src || err) return <UserIcon className="heroicon" style={{ display: "inline", width: size, height: size }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external/data-URI from the identity provider
    <img src={src} alt="" className="avatar-img" onError={() => setErr(true)} />
  );
}

export default function Navbar() {
  const pathname = usePathname() ?? "/";
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Phase 0 identity: resolve the Authentik user via the edge headers
  // (null in local dev / when header trust is off — avatar stays a plain link).
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: AuthUser | null }) => alive && setUser(d.user))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // account dropdown (rendered only when signed in)
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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

        {/* right: account dropdown (identity via Authentik edge headers) */}
        <div className="user-menu" ref={menuRef}>
          {user ? (
            <>
              <button
                type="button"
                className="user-menu-trigger"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={user.email || user.username}
              >
                <span className="avatar-btn" aria-hidden="true">
                  <AvatarImg src={user.avatarUrl} size={16} />
                </span>
                <span className="nav-user">
                  {user.role === "admin" && <span className="nav-user-role" title="admin">admin</span>}
                  {user.username}
                </span>
              </button>
              {menuOpen && (
                <div className="user-menu-list" role="menu" aria-label="Account">
                  <Link role="menuitem" href="/profile" className="user-menu-item" onClick={() => setMenuOpen(false)}>
                    <UserIcon className="heroicon" style={{ width: 16, height: 16 }} />
                    Profile
                  </Link>
                  <Link role="menuitem" href="/settings" className="user-menu-item" onClick={() => setMenuOpen(false)}>
                    <Cog6ToothIcon className="heroicon" style={{ width: 16, height: 16 }} />
                    Settings
                  </Link>
                  <div className="user-menu-divider" role="separator" />
                  {/* full navigation: clears the outpost session cookie via the
                      edge-routed outpost endpoint — NOTE underscore (sign_out):
                      current Rust outpost registers /outpost.goauthentik.io/sign_out;
                      the old /signout spelling 404s (verified live 2026-10) */}
                  <a
                    role="menuitem"
                    href={`${typeof window !== "undefined" ? window.location.origin : ""}/outpost.goauthentik.io/sign_out`}
                    className="user-menu-item user-menu-item--danger"
                  >
                    <ArrowRightStartOnRectangleIcon className="heroicon" style={{ width: 16, height: 16 }} />
                    Logout
                  </a>
                </div>
              )}
            </>
          ) : (
            <Link href="/settings" className="avatar-btn" title="Account" aria-label="Account">
              <UserIcon className="heroicon" style={{ display: "inline", width: 16, height: 16 }} />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
