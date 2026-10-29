/** Deadlines / fold verdicts / checklists — the single implementation.
 *
 *  Relocated verbatim from src/daemon.ts (the Phase-4 helpers that replaced the
 *  user-data/*.json files) so three callers share ONE implementation instead of
 *  drifting copies:
 *    - the daemon's /deadlines + /checklists handlers (owner = request owner),
 *    - the platform frontend's trivial-mutation routes (5b-2),
 *    - the ingestion API's deadline batch (upsertIngestDeadlines).
 *
 *  Every read/write takes a trailing `owner: string = curOwner()` and threads it
 *  into SQL, so a request-scoped owner inside ownerALS still resolves exactly as
 *  before while callers outside a request (frontend routes, ingest) can pass the
 *  owner explicitly.
 *
 *  Raw SQL via the shared Pool (pg.ts — drizzle-free so the frontend image can
 *  import this module). Naming/semantics mirror the fs era: `id` fields are
 *  legacy djb2 hashes of course+title (deadlines.legacy_id), item ids of
 *  deadline+text (checklist_items.legacy_key).
 */
import { getPool } from "./pg.ts";
import { curOwner } from "./owner.ts";
import { courseId } from "./writes.ts";

const q = (text: string, params: unknown[] = []) => getPool().query(text, params);

export type Dl = { id: string; course: string; title: string; due: string | null; kind: string; spread: boolean; startBy: string | null; note: string; source: string; confidence: string; done: boolean; doneAt: number | null; userNote?: string; dueManual?: boolean; stale?: number; parts?: { title: string; due: string | null; note: string; done: boolean }[] };
export type CkItem = { id: string; text: string; done: boolean; doneAt: number | null; manual?: boolean };
export type Ck = { deadlineId: string; course: string; title: string; items: CkItem[]; updatedAt: number };
export type FoldSug = { parentId: string; parentTitle: string; childId: string; childTitle: string; childDue: string | null };
export type Verdict = { v: "accepted" | "declined"; parent?: string; parentTitle?: string };
export type Tomb = { child: Dl; parentId: string; parentKey: string; parentTitle: string; addedItemIds: string[]; enriched?: { itemId: string; prevText: string; prevDone: boolean }; partTitles?: string[]; at: number };
export type FoldsFile = { verdicts: Record<string, Verdict>; pending: FoldSug[]; folded: Record<string, Tomb> };

export const dlKey = (c: string, t: string): string => `${c}|${t.toLowerCase().trim()}`;
export const dlId = (c: string, t: string): string => { // stable: same course+title → same id
  let h = 5381;
  for (const ch of dlKey(c, t)) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(16);
};
export const itemId = (dl: string, t: string): string => { // stable: same deadline+text → same id
  let h = 5381;
  for (const ch of `${dl}|${t.toLowerCase().trim()}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(16);
};
/** enforce unique ids IN PLACE (same course+title twice, or a hash collision) */
export const uniqIds = (d: Dl[]): Dl[] => {
  const seen = new Set<string>();
  for (const x of d) {
    if (!x.id || seen.has(x.id)) {
      let n = 1;
      while (seen.has(`${x.id}~${n}`)) n++;
      x.id = `${x.id}~${n}`;
    }
    seen.add(x.id);
  }
  return d;
};

/** deadline row → legacy Dl shape (epoch-ms doneAt/stale, date strings). */
const dlFromRow = (r: Record<string, unknown>): Dl => {
  const d: Dl = {
    id: (r.legacy_id as string) ?? dlId(String(r.course), String(r.title)),
    course: String(r.course), title: String(r.title),
    due: r.due == null ? null : String(r.due),
    kind: String(r.kind ?? ""), spread: Boolean(r.spread),
    startBy: r.start_by == null ? null : String(r.start_by),
    note: String(r.note ?? ""), source: String(r.source ?? ""),
    confidence: String(r.confidence ?? "high"), done: Boolean(r.done),
    doneAt: r.done_at ? new Date(r.done_at as Date).getTime() : null,
  };
  if (r.user_note != null) d.userNote = String(r.user_note);
  if (r.due_manual) d.dueManual = true;
  if (r.stale != null) d.stale = Number(r.stale);
  return d;
};

export async function readDl(owner: string = curOwner()): Promise<Dl[]> {
  const rows = (await q(
    `select d.id, d.legacy_id, c.slug as course, d.title, d.due::text as due, d.due_manual, d.kind,
            d.spread, d.start_by::text as start_by, d.note, d.source, d.confidence, d.done,
            d.done_at, d.user_note, d.stale
     from deadlines d join courses c on c.id = d.course_id
     where d.owner_user_id = $1
       and not exists (select 1 from deadline_folds f where f.child_id = d.id and f.status = 'accepted')
     order by d.id`,
    [owner],
  )).rows as Record<string, unknown>[];
  const parts = (await q(
    `select p.deadline_id::text as deadline_id, p.title, p.due::text as due, p.note, p.done
     from deadline_parts p
     where p.deadline_id in (select id from deadlines where owner_user_id = $1)
     order by p.id`,
    [owner],
  )).rows as Record<string, unknown>[];
  const byId = new Map<string, Dl>();
  for (const r of rows) byId.set(String(r.id), dlFromRow(r));
  for (const p of parts) {
    const dl = byId.get(String(p.deadline_id));
    if (dl) dl.parts = [...(dl.parts ?? []), { title: String(p.title), due: p.due == null ? null : String(p.due), note: String(p.note ?? ""), done: Boolean(p.done) }];
  }
  const out = [...byId.values()];
  uniqIds(out);
  out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.course.localeCompare(b.course));
  return out;
}

export async function upsertDeadlineRow(x: Dl, owner: string = curOwner()): Promise<number> {
  const cid = await courseId(x.course);
  const r = await q(
    `insert into deadlines (legacy_id, course_id, title, due, due_manual, kind, spread, start_by,
        note, source, confidence, done, done_at, user_note, stale, owner_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (course_id, title, legacy_id, owner_user_id) do update set
       due=excluded.due, due_manual=excluded.due_manual, kind=excluded.kind, spread=excluded.spread,
       start_by=excluded.start_by, note=excluded.note, source=excluded.source,
       confidence=excluded.confidence, done=excluded.done, done_at=excluded.done_at,
       user_note=excluded.user_note, stale=excluded.stale, updated_at=now()
     returning id`,
    [x.id, cid, x.title, x.due, x.dueManual ?? false, x.kind, x.spread, x.startBy, x.note, x.source,
      x.confidence, x.done, x.doneAt ? new Date(x.doneAt) : null, x.userNote ?? null, x.stale ?? null, owner],
  );
  const id = Number((r.rows[0] as { id: number | string }).id);
  await q(`delete from deadline_parts where deadline_id = $1`, [id]);
  for (const p of x.parts ?? [])
    await q(`insert into deadline_parts (deadline_id, title, due, note, done) values ($1,$2,$3,$4,$5)`,
      [id, p.title, p.due, p.note, p.done]);
  return id;
}

/** Replace-all deadlines (visible list); tombstoned children are preserved. */
export async function writeDl(d: Dl[], owner: string = curOwner()): Promise<void> {
  uniqIds(d);
  const keep: number[] = [];
  for (const x of d) keep.push(await upsertDeadlineRow(x, owner));
  if (keep.length)
    await q(`delete from deadlines where owner_user_id = $1
      and not (id = any($2::bigint[]))
      and not exists (select 1 from deadline_folds f where f.child_id = deadlines.id and f.status = 'accepted')`,
      [owner, keep]);
  else
    await q(`delete from deadlines where owner_user_id = $1
      and not exists (select 1 from deadline_folds f where f.child_id = deadlines.id and f.status = 'accepted')`, [owner]);
}

/** legacy_id → deadlines.id (rows self-register via courseId on write). */
export async function dbIdOf(legacyId: string, owner: string = curOwner()): Promise<number | null> {
  const r = await q(`select id from deadlines where legacy_id = $1 and owner_user_id = $2 order by id limit 1`, [legacyId, owner]);
  return r.rows[0] ? Number((r.rows[0] as { id: number | string }).id) : null;
}

export async function readFolds(owner: string = curOwner()): Promise<FoldsFile> {
  const rows = (await q(
    `select f.id::text as fid, f.parent_id::text as pid, f.child_id::text as cid, f.status,
            f.added_item_ids, f.enriched, f.child_snapshot, f.folded_at,
            p.legacy_id as p_legacy, p.title as p_title, pc.slug as p_course,
            ch.legacy_id as c_legacy, ch.title as c_title, cc.slug as c_course
     from deadline_folds f
     join deadlines p on p.id = f.parent_id join courses pc on pc.id = p.course_id
     left join deadlines ch on ch.id = f.child_id left join courses cc on cc.id = ch.course_id
     where p.owner_user_id = $1
     order by f.id`,
    [owner],
  )).rows as Record<string, unknown>[];
  const verdicts: Record<string, Verdict> = {};
  const pending: FoldSug[] = [];
  const folded: Record<string, Tomb> = {};
  for (const r of rows) {
    const parentId = (r.p_legacy as string) ?? dlId(String(r.p_course), String(r.p_title));
    const parentKey = dlKey(String(r.p_course), String(r.p_title));
    const snap = (r.child_snapshot && typeof r.child_snapshot === "object" && !Array.isArray(r.child_snapshot)) ? r.child_snapshot as Record<string, unknown> : {};
    if (r.status === "accepted") {
      const child = snap as unknown as Dl;
      const key = dlKey(child.course ?? String(r.c_course ?? ""), child.title ?? String(r.c_title ?? ""));
      folded[key] = {
        child, parentId, parentKey, parentTitle: String(r.p_title),
        addedItemIds: Array.isArray(r.added_item_ids) ? (r.added_item_ids as string[]) : [],
        enriched: (r.enriched ?? undefined) as { itemId: string; prevText: string; prevDone: boolean } | undefined,
        partTitles: Array.isArray(snap.__partTitles) ? (snap.__partTitles as string[]) : (child.parts?.map((x) => x.title) ?? []),
        at: r.folded_at ? new Date(r.folded_at as Date).getTime() : Date.now(),
      };
      verdicts[key] = { v: "accepted", parent: parentKey, parentTitle: String(r.p_title) };
    } else if (r.status === "pending") {
      if (snap.key != null && snap.verdict != null) verdicts[String(snap.key)] = snap.verdict as Verdict;
      else pending.push({
        parentId, parentTitle: String(r.p_title),
        childId: (r.c_legacy as string) ?? dlId(String(r.c_course ?? ""), String(r.c_title ?? "")),
        childTitle: String(snap.childTitle ?? r.c_title ?? ""),
        childDue: snap.childDue == null ? null : String(snap.childDue),
      });
    } else if (r.status === "declined") {
      const key = dlKey(String(r.c_course ?? ""), String(r.c_title ?? ""));
      if (key !== "|") verdicts[key] = { v: "declined" };
    }
  }
  return { verdicts, pending, folded };
}

export async function writeFolds(f: FoldsFile, owner: string = curOwner()): Promise<void> {
  const seen: number[] = [];
  for (const [key, t] of Object.entries(f.folded)) {
    await upsertDeadlineRow(t.child, owner); // tombstone child re-inserted for FK integrity
    const pid = await dbIdOf(t.parentId, owner);
    const cid = await dbIdOf(t.child.id, owner);
    if (pid == null || cid == null) continue;
    const r = await q(
      `insert into deadline_folds (parent_id, child_id, status, chosen_parent_id, added_item_ids, enriched, child_snapshot, folded_at)
       values ($1,$2,'accepted',$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
       on conflict (parent_id, child_id) do update set status='accepted', chosen_parent_id=excluded.chosen_parent_id,
         added_item_ids=excluded.added_item_ids, enriched=excluded.enriched,
         child_snapshot=excluded.child_snapshot, folded_at=excluded.folded_at
       returning id`,
      [pid, cid, pid, JSON.stringify(t.addedItemIds ?? []), t.enriched ? JSON.stringify(t.enriched) : null,
        JSON.stringify({ ...t.child, __partTitles: t.partTitles ?? [] }), t.at ? new Date(t.at) : null],
    );
    seen.push(Number((r.rows[0] as { id: number | string }).id));

  }
  for (const p of f.pending) {
    const pid = await dbIdOf(p.parentId, owner);
    const cid = await dbIdOf(p.childId, owner);
    if (pid == null || cid == null) continue;
    const r = await q(
      `insert into deadline_folds (parent_id, child_id, status, chosen_parent_id, added_item_ids, child_snapshot)
       values ($1,$2,'pending',$1,'[]'::jsonb,$3::jsonb)
       on conflict (parent_id, child_id) do update set status='pending', chosen_parent_id=excluded.chosen_parent_id,
         child_snapshot=excluded.child_snapshot
       returning id`,
      [pid, cid, JSON.stringify({ parentTitle: p.parentTitle, childTitle: p.childTitle, childDue: p.childDue })],
    );
    seen.push(Number((r.rows[0] as { id: number | string }).id));
  }
  for (const [key, v] of Object.entries(f.verdicts)) {
    if (v.v !== "declined" || f.folded[key]) continue;
    const [course, title] = key.split("|");
    const r = await q(
      `select d.id from deadlines d join courses c on c.id = d.course_id
       where c.slug = $1 and lower(trim(d.title)) = $2 and d.owner_user_id = $3
         and not exists (select 1 from deadline_folds f2 where f2.child_id = d.id and f2.status = 'accepted')
       order by d.id limit 1`,
      [course ?? "", title ?? "", owner],
    );
    if (!r.rows[0]) continue;
    const cid = Number((r.rows[0] as { id: number | string }).id);
    const ins = await q(
      `insert into deadline_folds (parent_id, child_id, status, chosen_parent_id, added_item_ids, child_snapshot)
       values ($1,$1,'declined',$1,'[]'::jsonb,$2::jsonb)
       on conflict (parent_id, child_id) do update set status='declined', chosen_parent_id=excluded.chosen_parent_id,
         child_snapshot=excluded.child_snapshot
       returning id`,
      [cid, JSON.stringify({ key })],
    );
    seen.push(Number((ins.rows[0] as { id: number | string }).id));
  }
  if (seen.length) await q(`delete from deadline_folds where parent_id in (select id from deadlines where owner_user_id = $2) and not (id = any($1::bigint[]))`, [seen, owner]);
  else await q(`delete from deadline_folds where parent_id in (select id from deadlines where owner_user_id = $1)`, [owner]);
}

export async function readCk(owner: string = curOwner()): Promise<Ck[]> {
  const rows = (await q(
    `select ci.deadline_id::text as did, d.legacy_id, c.slug as course, d.title,
            ci.legacy_key, ci.text, ci.done, ci.done_at, ci.manual, ci.position, ci.updated_at
     from checklist_items ci join deadlines d on d.id = ci.deadline_id join courses c on c.id = d.course_id
     where d.owner_user_id = $1
     order by ci.deadline_id, ci.position, ci.id`,
    [owner],
  )).rows as Record<string, unknown>[];
  const byDl = new Map<string, Ck>();
  for (const r of rows) {
    const did = (r.legacy_id as string) ?? dlId(String(r.course), String(r.title));
    const upd = new Date(r.updated_at as Date).getTime();
    const ck = byDl.get(String(r.did)) ?? { deadlineId: did, course: String(r.course), title: String(r.title), items: [], updatedAt: upd };
    ck.items.push({ id: String(r.legacy_key), text: String(r.text), done: Boolean(r.done), doneAt: r.done_at ? new Date(r.done_at as Date).getTime() : null, ...(r.manual ? { manual: true } : {}) });
    ck.updatedAt = Math.max(ck.updatedAt, upd);
    byDl.set(String(r.did), ck);
  }
  return [...byDl.values()];
}

export async function writeCk(c: Ck[], owner: string = curOwner()): Promise<void> {
  await q(`delete from checklist_items where deadline_id in (select id from deadlines where owner_user_id = $1)`, [owner]);
  for (const ck of c) {
    const did = await dbIdOf(ck.deadlineId, owner);
    if (did == null) continue;
    for (let i = 0; i < ck.items.length; i++) {
      const it = ck.items[i]!;
      await q(
        `insert into checklist_items (deadline_id, legacy_key, text, done, done_at, manual, position, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (deadline_id, legacy_key) do update set text=excluded.text, done=excluded.done,
           done_at=excluded.done_at, manual=excluded.manual, position=excluded.position, updated_at=excluded.updated_at`,
        [did, it.id, it.text, it.done, it.doneAt ? new Date(it.doneAt) : null, it.manual ?? false, i, new Date(ck.updatedAt)],
      );
    }
  }
}

/** sub-task folding: "A1 Part A" → checklist step of "Assignment 1".
 *  Deterministic so re-folds after checklist regeneration stay stable. */
export const foldChildInto = async (parent: Dl, child: Dl, owner: string = curOwner()): Promise<{ steps: number; addedItemIds: string[]; enriched?: { itemId: string; prevText: string; prevDone: boolean }; partTitles?: string[] }> => {
  const cks = await readCk(owner);
  const childCkIdx = cks.findIndex((c) => c.deadlineId === child.id);
  const childSteps = childCkIdx >= 0 ? cks[childCkIdx]!.items : [];
  const pc = cks.find((c) => c.deadlineId === parent.id);
  const label = (child.title.match(/\b(?:part|phase|section|component|stage)\s+[a-z0-9]+\b/i)?.[0] ?? child.title.split(/[:\u2014-]/)[0] ?? child.title).trim().slice(0, 40);
  const dueTag = child.due && child.due !== parent.due ? ` (due ${child.due})` : "";
  if (!parent.userNote && child.userNote) parent.userNote = child.userNote;
  if (childCkIdx >= 0) cks.splice(childCkIdx, 1); // the child's checklist folds in / goes away
  if (!pc) {
    // no checklist yet — remember the parts; the next generation MUST
    // include them as steps (prompt reads deadline.parts)
    const partTitles = [child.title, ...childSteps.map((s) => s.text)];
    parent.parts = [...(parent.parts ?? []), ...partTitles.map((t, i) => ({ title: t, due: i === 0 ? child.due : null, note: i === 0 ? child.note : "", done: i === 0 ? child.done : childSteps[i - 1]!.done }))];
    await writeCk(cks, owner);
    return { steps: 0, addedItemIds: [], partTitles };
  }
  const toks = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 1));
  const over = (a: Set<string>, b: Set<string>): number => { if (!a.size || !b.size) return 0; let hit = 0; for (const w of a) if (b.has(w)) hit++; return hit / Math.min(a.size, b.size); };
  const ct = toks(child.title);
  const mkItem = (text: string, done: boolean): CkItem => ({ id: itemId(parent.id, text), text: text.slice(0, 200), done, doneAt: done ? (child.doneAt ?? Date.now()) : null });
  // idempotency: same text already folded → nothing to do
  if (pc.items.some((it) => it.text === `${child.title}${dueTag}`.slice(0, 200))) { await writeCk(cks, owner); return { steps: 0, addedItemIds: [] }; }
  let mi = -1, ms = 0;
  pc.items.forEach((it, i) => { const s = over(ct, toks(it.text)); if (s > ms) { ms = s; mi = i; } });
  const addedItemIds: string[] = [];
  let enriched: { itemId: string; prevText: string; prevDone: boolean } | undefined;
  if (mi >= 0 && ms >= 0.5) {
    // existing step covers this part → enrich it, don't duplicate
    const it = pc.items[mi]!;
    enriched = { itemId: it.id, prevText: it.text, prevDone: it.done };
    it.done = it.done || child.done;
    if (dueTag && !/due \d{4}/.test(it.text)) it.text = `${it.text}${dueTag}`.slice(0, 200);
    const added = childSteps.map((s) => mkItem(`${label}: ${s.text}`, s.done));
    addedItemIds.push(...added.map((a) => a.id));
    pc.items.splice(mi + 1, 0, ...added);
  } else {
    const newText = `${child.title}${dueTag}`;
    let at = pc.items.length;
    let last = -1;
    pc.items.forEach((it, i) => { if (over(ct, toks(it.text)) >= 0.25) last = i; });
    if (last >= 0) at = last + 1; // group with sibling steps of this part
    else if (pc.items.length > 1 && /submit|upload|hand in|post\b|verify|review/i.test(pc.items[pc.items.length - 1]!.text)) at = pc.items.length - 1; // before the final submit-ish step
    const fresh = mkItem(newText, child.done);
    const added = [fresh, ...childSteps.map((s) => mkItem(`${label}: ${s.text}`, s.done))];
    addedItemIds.push(...added.map((a) => a.id));
    pc.items.splice(at, 0, ...added);
  }
  pc.updatedAt = Date.now();
  await writeCk(cks, owner);
  return { steps: 1 + childSteps.length, addedItemIds, enriched };
};

// ── trivial mutations (platform frontend routes) ───────────────────────────
// Branch ORDER mirrors the daemon's /deadlines POST handler exactly (dates
// BEFORE the done-toggle: the toggle's userNote guard would otherwise swallow
// {id, due} bodies). Anything else (rebuild, checklist generation) is NOT a
// trivial mutation — callers proxy those to the daemon.

export type MutationBody = Record<string, unknown>;

export type DeadlineMutationResult =
  | { ok: true; deadlines: Dl[]; folded?: number; deleted?: string }
  | { ok: false; status: number; error: string; code?: "unsupported" };

export type ChecklistMutationResult =
  | { ok: true; checklists: Ck[] }
  | { ok: false; status: number; error: string; code?: "unsupported" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Apply one trivial /deadlines POST body (toggle done, manual dates+revert,
 *  delete, fold/unfold/decline-fold, user note). Returns the fresh list so the
 *  caller can respond with the daemon's exact payload shape. */
export async function applyDeadlineMutation(body: MutationBody, owner: string = curOwner()): Promise<DeadlineMutationResult> {
  // ── manual date override: { id, due?, startBy?, revert? } ──
  if (typeof body.id === "string" && ("due" in body || "startBy" in body || body.revert === true)) {
    if ("due" in body && body.due !== null && !DATE_RE.test(String(body.due)))
      return { ok: false, status: 400, error: "due must be YYYY-MM-DD or null" };
    if ("startBy" in body && body.startBy !== null && !DATE_RE.test(String(body.startBy)))
      return { ok: false, status: 400, error: "startBy must be YYYY-MM-DD or null" };
    const dl = await readDl(owner);
    const it = dl.find((d) => d.id === body.id);
    if (!it) return { ok: false, status: 404, error: "no such deadline id" };
    if (body.revert === true) {
      delete it.dueManual;
      it.confidence = "medium"; // until the next rebuild re-extracts
    } else {
      if ("due" in body) it.due = body.due === null ? null : String(body.due);
      if ("startBy" in body) it.startBy = body.startBy === null ? null : String(body.startBy);
      it.dueManual = true;
      it.confidence = "high"; // human-confirmed beats document text
    }
    await writeDl(dl, owner);
    return { ok: true, deadlines: dl };
  }
  // ── remove one entry ──
  if (typeof body.id === "string" && (body.delete === true || body.remove === true)) {
    const dl = await readDl(owner);
    const i = dl.findIndex((d) => d.id === body.id);
    if (i < 0) return { ok: false, status: 404, error: "no such deadline id" };
    const [gone] = dl.splice(i, 1);
    await writeDl(dl, owner);
    return { ok: true, deadlines: dl, deleted: gone?.title ?? "" };
  }
  // ── fold a sub-task into a parent's checklist ──
  if ((body.fold || body.acceptFold) && typeof (body.fold ?? body.acceptFold) === "object") {
    const { parent: pid, child: cid } = (body.fold ?? body.acceptFold) as { parent?: string; child?: string };
    const dl = await readDl(owner);
    const parent = dl.find((d) => d.id === pid);
    const child = dl.find((d) => d.id === cid);
    if (!parent || !child || parent.id === child.id) return { ok: false, status: 404, error: "no such parent/child id" };
    if (parent.course !== child.course) return { ok: false, status: 400, error: "can only fold within the same course" };
    if (parent.done) return { ok: false, status: 400, error: "can't fold into a done deadline" };
    const key = dlKey(child.course, child.title);
    const det = await foldChildInto(parent, child, owner);
    const f = await readFolds(owner);
    f.verdicts[key] = { v: "accepted", parent: dlKey(parent.course, parent.title), parentTitle: parent.title };
    f.folded[key] = { child: { ...child }, parentId: parent.id, parentKey: dlKey(parent.course, parent.title), parentTitle: parent.title, addedItemIds: det.addedItemIds, enriched: det.enriched, partTitles: det.partTitles, at: Date.now() };
    f.pending = f.pending.filter((p) => p.childId !== child.id);
    await writeFolds(f, owner);
    const out = dl.filter((d) => d.id !== child.id);
    await writeDl(out, owner);
    return { ok: true, deadlines: out, folded: det.steps };
  }
  // ── unfold: restore a folded child (tombstone-driven) ──
  if (body.unfold && typeof body.unfold === "object") {
    const key = String((body.unfold as { key?: string }).key ?? "");
    const f = await readFolds(owner);
    const t = f.folded[key];
    if (!t) return { ok: false, status: 404, error: "no such folded entry" };
    const cks = await readCk(owner);
    const pc = cks.find((c) => c.deadlineId === t.parentId);
    if (pc) {
      if (t.addedItemIds.length) pc.items = pc.items.filter((it) => !t.addedItemIds.includes(it.id));
      if (t.enriched) {
        const e = pc.items.find((it) => it.id === t.enriched!.itemId);
        if (e) { e.text = t.enriched.prevText; e.done = t.enriched.prevDone; e.doneAt = e.done ? (e.doneAt ?? Date.now()) : null; }
      }
      pc.updatedAt = Date.now();
      await writeCk(cks, owner);
    }
    const dl = await readDl(owner);
    const parent = dl.find((d) => d.id === t.parentId);
    if (parent && t.partTitles?.length) {
      const rm = new Set(t.partTitles);
      parent.parts = (parent.parts ?? []).filter((p) => !rm.has(p.title));
      if (!parent.parts.length) delete parent.parts;
    }
    dl.push({ ...t.child }); // resurrect — writeDl's uniqIds guards id clashes
    delete f.verdicts[key];
    delete f.folded[key];
    await q(`delete from deadline_folds where child_id = (select id from deadlines where legacy_id = $1 and owner_user_id = $2 order by id limit 1)`, [t.child.id, owner]);
    await writeDl(dl, owner);
    return { ok: true, deadlines: dl };
  }
  // ── decline: never suggest this fold again (by course+title) ──
  if (body.declineFold && typeof body.declineFold === "object") {
    const cid = String((body.declineFold as { child?: string }).child ?? "");
    const dl = await readDl(owner);
    const child = dl.find((d) => d.id === cid);
    const f = await readFolds(owner);
    if (child) f.verdicts[dlKey(child.course, child.title)] = { v: "declined" };
    f.pending = f.pending.filter((p) => p.childId !== cid);
    await writeFolds(f, owner);
    return { ok: true, deadlines: dl };
  }
  // ── toggle done-ness by id ──
  if (typeof body.id === "string" && body.userNote === undefined) {
    const dl = await readDl(owner);
    const it = dl.find((d) => d.id === body.id);
    if (!it) return { ok: false, status: 404, error: "no such deadline id" };
    it.done = body.done !== false; // default true; explicit false un-checks
    it.doneAt = it.done ? Date.now() : null;
    await writeDl(dl, owner);
    return { ok: true, deadlines: dl };
  }
  // ── student context note by id ──
  if (typeof body.id === "string" && typeof body.userNote === "string") {
    const dl = await readDl(owner);
    const it = dl.find((d) => d.id === body.id);
    if (!it) return { ok: false, status: 404, error: "no such deadline id" };
    const v = body.userNote.trim().slice(0, 2000);
    if (v) it.userNote = v; else delete it.userNote; // empty clears
    await writeDl(dl, owner);
    return { ok: true, deadlines: dl };
  }
  return { ok: false, status: 400, error: "unsupported deadline mutation (not a trivial mutation)", code: "unsupported" };
}

/** Apply one trivial /checklists POST body (item toggle, manual add, item
 *  remove). Checklist GENERATION needs the LLM + course tools — callers proxy
 *  that to the daemon. */
export async function applyChecklistMutation(body: MutationBody, owner: string = curOwner()): Promise<ChecklistMutationResult> {
  const ck = await readCk(owner);
  const dlIdStr = String(body.deadlineId ?? "");
  const mine = (): Ck | undefined => ck.find((c) => c.deadlineId === dlIdStr);
  // ── toggle an item ──
  if (typeof body.itemId === "string") {
    const c = mine();
    const it = c?.items.find((x) => x.id === body.itemId);
    if (!c || !it) return { ok: false, status: 404, error: "no such checklist item" };
    it.done = body.done !== false;
    it.doneAt = it.done ? Date.now() : null;
    c.updatedAt = Date.now();
    await writeCk(ck, owner);
    return { ok: true, checklists: ck };
  }
  // ── manual add ──
  if (typeof body.add === "string" && body.add.trim()) {
    const text = body.add.trim().slice(0, 200);
    let c = mine();
    if (!c) {
      const dl = (await readDl(owner)).find((d) => d.id === dlIdStr);
      c = { deadlineId: dlIdStr, course: dl?.course ?? "", title: dl?.title ?? text, items: [], updatedAt: Date.now() };
      ck.push(c);
    }
    const id = itemId(dlIdStr, text);
    if (!c.items.some((x) => x.id === id)) c.items.push({ id, text, done: false, doneAt: null, manual: true });
    c.updatedAt = Date.now();
    await writeCk(ck, owner);
    return { ok: true, checklists: ck };
  }
  // ── remove an item ──
  if (typeof body.removeItemId === "string") {
    const c = mine();
    if (!c) return { ok: false, status: 404, error: "no such checklist" };
    c.items = c.items.filter((x) => x.id !== body.removeItemId);
    c.updatedAt = Date.now();
    await writeCk(ck, owner);
    return { ok: true, checklists: ck };
  }
  return { ok: false, status: 400, error: "unsupported checklist mutation (generation stays on the daemon)", code: "unsupported" };
}

// ── ingestion API: deadline batch ───────────────────────────────────────────
// The recorder submits deadlines alongside transcript/notes. Semantics differ
// from writeDl (a replace-all driven by an LLM rebuild): ingest only touches the
// fields it was given — `undefined` leaves the column alone, `null` clears it,
// and a user's manual due date (due_manual) always wins over a document date.

export interface IngestDeadline {
  title: string;
  due?: string | null;
  startBy?: string | null;
  course?: string;
}

export interface IngestDeadlinesResult {
  upserted: number;
  added: number;
  updated: number;
  skipped: number;
  /** set when the whole batch failed (rolled back) — callers log, never throw */
  error?: string;
}

const INGEST_CAP = 200;

/** Upsert a batch of ingested deadlines for one owner (one transaction).
 *  Natural key: course + case-insensitive title (+ legacy_id for the unique
 *  index, which is owner-scoped — another owner's same-title row is a separate
 *  row, never a conflict target). Never throws: a bad batch rolls back and reports `error`, so it can
 *  never take a committed session/transcript ingest down with it. */
export async function upsertIngestDeadlines(ownerUserId: string, deadlines: IngestDeadline[]): Promise<IngestDeadlinesResult> {
  const out: IngestDeadlinesResult = { upserted: 0, added: 0, updated: 0, skipped: 0 };
  const list = Array.isArray(deadlines) ? deadlines : [];
  const batch = list.slice(0, INGEST_CAP);
  out.skipped += list.length - batch.length; // 200-item cap
  if (!batch.length) return out;

  const norm = (v: unknown): string | null | undefined => {
    if (v === undefined) return undefined;           // leave alone
    if (v === null || v === "") return null;         // clear
    const s = String(v).trim();
    return DATE_RE.test(s) ? s : undefined;          // unparseable → leave alone
  };

  const client = await getPool().connect();
  try {
    await client.query("begin");
    for (const raw of batch) {
      const title = typeof raw?.title === "string" ? raw.title.trim() : "";
      const course = typeof raw?.course === "string" ? raw.course.trim() : "";
      if (!title || !course) { out.skipped++; continue; } // per-item skip, never 400
      const due = norm(raw.due);
      const startBy = norm(raw.startBy);
      const hasDue = due !== undefined;
      const hasStartBy = startBy !== undefined;
      const cid = await courseId(course);
      const upd = await client.query(
        `update deadlines set
           due = case when $4::boolean and not due_manual then $5::date else due end,
           start_by = case when $6::boolean then $7::date else start_by end,
           updated_at = now()
         where course_id = $1 and owner_user_id = $2 and lower(trim(title)) = lower(trim($3))
         returning id`,
        [cid, ownerUserId, title, hasDue, hasDue ? due : null, hasStartBy, hasStartBy ? startBy : null],
      );
      if (upd.rows[0]) { out.updated++; out.upserted++; continue; }
      const ins = await client.query(
        `insert into deadlines (legacy_id, course_id, title, due, due_manual, start_by, owner_user_id)
         values ($1,$2,$3,$4,false,$5,$6)
         on conflict (course_id, title, legacy_id, owner_user_id) do nothing
         returning id`,
        [dlId(course, title), cid, title, hasDue ? due : null, hasStartBy ? startBy : null, ownerUserId],
      );
      if (ins.rows[0]) { out.added++; out.upserted++; continue; }
      // Lost a race with a concurrent insert by THIS owner → update that row instead.
      // Owner-scoped on purpose: the pre-update above already filtered on it, so a
      // conflict here can only be our own row (never another owner's).
      const race = await client.query(
        `update deadlines set
           due = case when $4::boolean and not due_manual then $5::date else due end,
           start_by = case when $6::boolean then $7::date else start_by end,
           updated_at = now()
         where course_id = $1 and owner_user_id = $2 and lower(trim(title)) = lower(trim($3))
           and legacy_id = $8
         returning id`,
        [cid, ownerUserId, title, hasDue, hasDue ? due : null, hasStartBy, hasStartBy ? startBy : null, dlId(course, title)],
      );
      if (race.rows[0]) { out.updated++; out.upserted++; continue; }
      out.skipped++; // row vanished mid-flight (concurrent delete) — never double-count
    }
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* already gone */ }
    return { upserted: 0, added: 0, updated: 0, skipped: batch.length, error: String(e).slice(0, 300) };
  } finally {
    client.release();
  }
}
