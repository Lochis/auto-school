# Planning: Storage backends — whose cloud holds the bytes

Status: PLANNING, **RE-SCOPED 2026-10-20** — kept ON after the hosted-platform pivot, but
the platform never holds blobs: recordings stay user-local, optional sync goes to the USER'S
own cloud (S3/B2/r2), playback via presigned URLs through the media route. See
`hosted-platform.md` §4 for the decision and scope. Original per-user-cloud design below
remains largely applicable with "platform infra" readings replaced by "user's provider".
Storage is **device-local or the user's own cloud, never platform-held**.
Companion docs: `postgres-migration.md` (schema incl. `session_artifacts.storage_uri`, cutover
phases §4.4), `multi-user-architecture.md` (§5 "Storage evolution": per-user scratch → publish
artifacts → metadata in PG) *(historical — pod-per-user, killed 2026-10-20; see
hosted-platform.md §1.5/§6)*,
`future-product-goals.md` (BYOK, compliance stance).

Mission: make the **blob store pluggable per user**. The platform (Postgres) holds text + pointers
only; recording bytes live wherever the user chose — the owner's PVC, a user's own S3/R2 bucket,
or (product form, see §6) their device. This is the product stance `postgres-migration.md`'s
"End-state data planes" table already commits to; this doc turns it into a build plan.

**Product promise:** the platform never persists recordings of identifiable people. One
explicit exception: the `owner` role (lochis) may keep `file:///data` (the homelab PVC) as
their personal backend — a founder privilege, recorded here so it's a decision, not an accident.

---

## 1. What exists today (ground truth)

- Blobs are only ever written by the daemon, under `DATA_DIR`: recorder `segments/*.webm`
  (`src/record/recorder.ts`), consolidated `recordings/<course>/<stem>.mp4|webm`
  (`consolidate.ts`), docindex page caches `courses/<slug>/materials/.index/` (`docindex.ts`).
- `session_artifacts` already has the right columns: `storage_uri` (free-form), `rel_path`,
  `checksum`, `bytes`, `deleted_at`/`retained_until` (recording-kind partial index). **No schema
  change is required by this plan.**
- The frontend media route streams from the ro `/data` mount with Range semantics; notes text is
  inlined in `session_artifacts.content` for md/json kinds.
- Retention today: fs sweep (`retention.ts`) + `retained_until` in DB — DB side is authoritative
  for *when*, fs loop does the *unlink*.

## 2. The abstraction

One interface, implemented per scheme, used by exactly four call sites (publish, media, delete,
export). Scratch space is deliberately **not** abstracted — live capture stays on local disk
(the owner's PVC on the personal pod; the user's device for hosted capture) until consolidation
completes; only final artifacts are published. That keeps local scratch small and keeps the
platform out of the blob path entirely. (The old "per-user PVC in the multi-user form" is dead
with pod-per-user — there is no platform-side per-user volume.)

```ts
// src/storage/backend.ts (sketch)
interface StorageBackend {
  scheme: "file" | "s3";                       // add more later; scheme is the storage_uri prefix
  put(relPath: string, src: string): Promise<{ uri, bytes, checksum }>;   // src = local temp file
  stat(uri: string): Promise<{ bytes, exists }>;
  stream(uri: string, range?: { from, to }): Promise<Readable>;            // HTTP Range passthrough
  delete(uri: string): Promise<void>;                                      // "free up space"
}
// resolution: per-user config (§3) → backend instance; file:// default for owner.
```

- `file://` wraps the fs (`DATA_DIR` today — the owner's own PVC, which is the personal
  deployment's blob store, not "platform storage"). `s3://` via MinIO client (works
  against R2/B2/Wasabi/real S3 — the client is the standard) against the **user's** bucket.
- `publish()` is called by `consolidate.ts` (recording kind) and `notes.ts` finalize (text kinds
  keep inlining into `content` — no backend call needed, they're KBs).
- No backend touches: `docindex` page caches (rebuildable from sources, stay fs), timeline
  journal, browser profile.

## 3. Per-user configuration

| Item | Where | Notes |
|---|---|---|
| Backend scheme + endpoint/bucket/prefix | `users` row (low-sensitivity: bucket name/prefix; **keys never in plaintext columns**) | the platform stores only *where* the bytes are, per `session_artifacts.storage_uri` |
| S3 credentials | **not platform-held** — the user's own keychain (Electron client) or the personal pod's Secret for the owner's single account | the old `user_credentials` AEAD blob (`authentik-federation.md` §5) is **dead** — hosting users' provider creds is exactly what was ruled out (`hosted-platform.md` §6) |
| Migration between backends | new subcommand on the exporter: `export --backend s3://…` | DB update is just `storage_uri` rewrite + copy; checksum verify both ends |

Sequencing: **no longer requires Authentik Phase 2 / credential blob storage** (killed). It needs
only username→uid ownership (Phase 1) for `storage_uri` scoping. Until multi-user exists there
is exactly one user; `file://` hardwired is correct and stays.

## 4. Flow-by-flow changes

1. **Capture → consolidate (unchanged):** recorder writes segments to local scratch as today.
   `consolidate.ts` ends with `backend.put()` instead of assuming the destination is the
   recordings tree; `session_artifacts.storage_uri` is whatever the backend returned.
   (`file://` backend makes this a no-op refactor — ship it that way first.)
2. **Transcription (decide early):** today audio segments → Gemini on platform keys. If the
   product promise is real, bytes must reach Gemini under the **user's** key (BYOK,
   `future-product-goals.md` §C) or be transcribed on-device. Platform-key transcription of
   user-S3-hosted bytes re-introduces the exact data flow this plan exists to avoid. Open
   question Q1.
3. **Playback:** media route resolves `storage_uri` → backend stream (S3: presigned redirect or
   proxy; `file://`: unchanged). Sessions whose backend is unreachable get a "storage offline"
   UI state (from `stat()` on list, or a cheap HEAD per open) — not a hang. Device-stored
   sessions (§6) are playable only on that device.
4. **Retention / "free up space":** `retained_until` sweep (DB-authoritative) calls
   `backend.delete(uri)` + sets `deleted_at`. If the user's creds are revoked at delete time:
   tombstone anyway, log the orphan, surface in a reconciliation report (§5).
5. **Export / backup:** exporter (`scripts/export-pg-to-fs.ts`) gains `--backend` so a user can
   take their data to their own store. This is also the GDPR-shaped exit path: all rows with
   `owner_user_id = X` + all blobs their URIs reference.

## 5. Failure modes / reconciliation

| Failure | Detection | Handling |
|---|---|---|
| User creds revoked | `backend.put/delete` 403 | pipeline job fails per-session (job-level failure semantics, `authentik-federation.md` §6 nuance); metadata row created only after successful publish, so no dangling URIs on write |
| Orphaned blob (tombstoned, delete failed) | nightly reconcile job: `stat()` over live `storage_uri`s + retained-until misses | report to user: "N blobs could not be deleted from your storage" |
| Backend offline | `stat()` miss on playback | "storage offline" state; text artifacts still readable from `content` — **transcripts/notes survive backend loss by design** |
| Checksum drift | periodic `stat().bytes` vs `bytes` column (sampled) | flag session; offer re-verify |

## 6. Device-as-backend (product form, parked)

The end-state table's "user's device" option means capture *and* storage happen on-device: an
extension/browser capture uploads to the user's own cloud (or keeps local), platform receives
only text over the API. That is a capture-path rewrite, not a backend — out of scope here, but
the interface above is chosen so it composes (device uploader speaks the same publish contract).

## 7. Sequencing & what this does NOT gate

- **After** Authentik Phase 1; **independent of** postgres cutover Phases 3–4 — do not couple
  them. Phase 3/4 move *metadata* reads/writes; this plan moves *blob* I/O behind one interface.
- Step 1 (ship `file://` backend as a no-op refactor of `consolidate.ts` publish + media route
  resolution) is safe to do any time after Phase 3 reads land; `s3://` + per-user config after
  Authentik Phase 1.
- **Deviation from `postgres-migration.md` §4.4 Phase 4, recorded here:** the PVC is *not*
  archived to cold backup at Phase 4 exit — it remains the owner's live blob backend
  (`storage_uri = file:///data`). Archive happens only if/when the owner migrates to another
  backend via export (§4.5). Everything else about Phase 4 (fs *metadata* writes stop, ro mount
  drops) is unchanged.

## 8. Open questions

1. **BYOK transcription timing** — platform key until GA, or from day one of multi-user?
   (Shapes pipeline: upload-segments vs user-key-direct-to-Gemini.)
2. Presigned-URL redirect vs proxy-through for S3 playback (redirect leaks bucket URL to the
   client; proxy costs cluster egress).
3. Do device-uploaded sessions (§6) get platform transcription at all, or on-device only?
4. Per-user backend quota/cost signals (nice-to-have; `bytes` per `owner_user_id` is one query).
