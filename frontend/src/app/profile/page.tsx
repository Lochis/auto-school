"use client";

import { useEffect, useState } from "react";
import { EnvelopeIcon, IdentificationIcon, ShieldCheckIcon, UserIcon } from "@heroicons/react/24/outline";
import { Badge, Panel, PanelHeader } from "@/components/ui";
import type { AuthUser } from "@/lib/auth";
import "../profile-ui.css";

/** Profile — identity as seen by the Authentik edge (Phase 0). Read-only;
 *  changes happen in authentik (password, name, groups), not here. */
export default function ProfilePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: AuthUser | null }) => { if (alive) { setUser(d.user); setLoaded(true); } })
      .catch(() => setLoaded(true));
    return () => { alive = false; };
  }, []);

  return (
    <div className="profile-page">
      <Panel className="profile-panel">
        <PanelHeader icon={<UserIcon className="heroicon" />} title="Profile" eyebrow="Account" />
        {!loaded ? (
          <p className="profile-hint">Loading…</p>
        ) : !user ? (
          <p className="profile-hint">
            Not signed in — identity comes from the Authentik edge and is unavailable in local dev
            or when header trust is off.
          </p>
        ) : (
          <>
            <div className="profile-head">
              <span className="profile-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
              <div>
                <h1 className="profile-name">{user.name || user.username}</h1>
                <p className="profile-sub">
                  @{user.username} · <Badge variant={user.role === "admin" ? "emerald" : "neutral"}>{user.role}</Badge>
                </p>
              </div>
            </div>
            <dl className="profile-rows">
              <div className="profile-row">
                <dt><IdentificationIcon className="heroicon" /> Username</dt>
                <dd>{user.username}</dd>
              </div>
              <div className="profile-row">
                <dt><EnvelopeIcon className="heroicon" /> Email</dt>
                <dd>{user.email || "—"}</dd>
              </div>
              <div className="profile-row">
                <dt><ShieldCheckIcon className="heroicon" /> Authentik groups</dt>
                <dd>{user.groups.length ? user.groups.join(", ") : "—"}</dd>
              </div>
              <div className="profile-row">
                <dt><IdentificationIcon className="heroicon" /> Authentik UID</dt>
                <dd><code>{user.uid}</code></dd>
              </div>
            </dl>
          </>
        )}
      </Panel>
    </div>
  );
}
