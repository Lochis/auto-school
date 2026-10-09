"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserIcon } from "@heroicons/react/24/outline";

const NAV = [
  { href: "/", label: "Schedule" },
  { href: "/courses", label: "Courses & Deadlines" },
  { href: "/settings", label: "Settings" },
];

export default function Navbar() {
  const pathname = usePathname() ?? "/";
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="app-header">
      <div className="app-header-inner">
        {/* left: brand + cron status */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-lg)", minWidth: 0 }}>
          <Link href="/" className="brand" aria-label="auto-school home">
            <span className="brand-glyph">
              <span style={{ display: "block", width: 8, height: 8, borderRadius: "50%", background: "var(--primary)" }} />
            </span>
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

        {/* right: avatar */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          <Link href="/settings" className="avatar-btn" title="Account" aria-label="Account">
            <UserIcon className="heroicon" style={{ display: "inline", width: 16, height: 16 }} />
          </Link>
        </div>
      </div>
    </header>
  );
}
