"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowPathIcon,
  EnvelopeIcon,
  IdentificationIcon,
  PencilSquareIcon,
  ShieldCheckIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { Badge, GhostButton, Panel, PanelHeader } from "@/components/ui";
import type { AuthUser } from "@/lib/auth";
import "../profile-ui.css";

/** Client mirror of the server upload rules (AVATAR_MIME_ALLOWLIST /
 *  MAX_AVATAR_BYTES in lib/avatar.ts — server-only, imports pg, so it can't
 *  be imported here). The server re-validates regardless. */
const AVATAR_MIME = ["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp"];
const AVATAR_MAX_BYTES = 256 * 1024;

/** DB-backed avatar (/api/me/avatar — Gap 4), FaceHash/initials fallback */
function ProfileAvatar({ src, fallback }: { src?: string; fallback: string }) {
  const [err, setErr] = useState(false);
  if (!src || err) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin DB-backed avatar route
    <img src={src} alt="" className="profile-avatar-img" onError={() => setErr(true)} />
  );
}

interface AvatarMsg {
  kind: "ok" | "err";
  text: string;
}

/** Profile — identity as seen by the Authentik edge (Phase 0). Read-only
 *  except the avatar (upload / remove — Gap 4); name/password changes
 *  happen in authentik, not here. */
export default function ProfilePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<AvatarMsg | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: AuthUser | null }) => { if (alive) { setUser(d.user); setLoaded(true); } })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
      if (msgTimer.current) clearTimeout(msgTimer.current);
    };
  }, []);

  const flash = (m: AvatarMsg) => {
    setMsg(m);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    // brief success/error state; errors linger a little longer
    msgTimer.current = setTimeout(() => setMsg(null), m.kind === "ok" ? 4000 : 8000);
  };

  const refreshMe = async () => {
    const d = await (await fetch("/api/me")).json();
    if (d.user) setUser(d.user);
    // NOTE: the navbar holds its own /api/me fetch on mount; it keeps the
    // previous avatar until the next navigation — acceptable staleness (Gap 4b).
  };

  const pickAvatar = async (file: File) => {
    if (file.size > AVATAR_MAX_BYTES) return flash({ kind: "err", text: "Avatar must be under 256KB." });
    if (!AVATAR_MIME.includes(file.type)) {
      return flash({ kind: "err", text: "Only PNG, JPEG, GIF, WebP or SVG avatars are allowed." });
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/me/avatar", { method: "POST", body: fd });
      if (!r.ok) {
        const why = r.status === 413 ? "over 256KB" : r.status === 415 ? "unsupported type" : "rejected";
        return flash({ kind: "err", text: `Avatar ${why} — try another file.` });
      }
      await refreshMe();
      flash({ kind: "ok", text: "Avatar updated." });
    } catch {
      flash({ kind: "err", text: "Upload failed — try again." });
    } finally {
      setBusy(false);
    }
  };

  const removeAvatar = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/me/avatar", { method: "DELETE" });
      if (!r.ok) return flash({ kind: "err", text: "Removal failed — try again." });
      await refreshMe();
      flash({ kind: "ok", text: "Avatar removed — using the default identicon." });
    } catch {
      flash({ kind: "err", text: "Removal failed — try again." });
    } finally {
      setBusy(false);
    }
  };

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
              <span className="profile-avatar">
                {/* key on src: a fresh ?v= after upload/reset also clears the img's error state */}
                <ProfileAvatar key={user.avatarUrl} src={user.avatarUrl} fallback={user.username.slice(0, 1).toUpperCase()} />
                <button
                  className="profile-avatar-edit"
                  title="Change avatar"
                  aria-label="Change avatar"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                >
                  <PencilSquareIcon className="heroicon" />
                </button>
              </span>
              <div>
                <h1 className="profile-name">{user.name || user.username}</h1>
                <p className="profile-sub">
                  @{user.username} · <Badge variant={user.role === "admin" ? "emerald" : "neutral"}>{user.role}</Badge>
                </p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={AVATAR_MIME.join(",")}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // allow re-picking the same file
                if (f) void pickAvatar(f);
              }}
            />
            <div className="profile-avatar-actions">
              <GhostButton
                icon={<ArrowPathIcon className="heroicon" />}
                onClick={() => void removeAvatar()}
                disabled={busy}
                title="Remove the uploaded avatar and use the default FaceHash identicon"
              >
                Remove avatar
              </GhostButton>
              {msg && <span className={`profile-avatar-msg ${msg.kind}`}>{msg.text}</span>}
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
