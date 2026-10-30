import { expandCalendar } from './ics.js';
import { lookupJob } from './lookup.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const STATUSES = new Set(['todo', 'doing', 'done']);
const SETTING_KEYS = { calendars: 'calendars', tags: 'tags' };
// Rows written within this window may be committed after a concurrent reader's
// cursor was taken, so each cursor overlaps the previous one by this much.
const CURSOR_OVERLAP_MS = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /api/ping': return json({ ok: true });
        case 'POST /api/sync': return json(await sync(await request.json(), env));
        case 'GET /api/settings': return json(await getSettings(env));
        case 'PUT /api/settings': return json(await putSettings(await request.json(), env));
        case 'GET /api/calendar': return json(await calendar(url, env));
        case 'GET /api/lookup': return json(await lookup(url));
        case 'GET /api/history': return json(await history(url, env));
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};

function authorized(request, env) {
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.APP_TOKEN || got.length !== env.APP_TOKEN.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(got), enc.encode(env.APP_TOKEN));
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);

function cleanTask(t) {
  if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 64) return null;
  const updatedAt = int(t.updatedAt);
  if (!updatedAt) return null;
  return {
    id: t.id,
    title: str(t.title, 500) ?? '',
    tag: str(t.tag, 40) || 'todo',
    url: str(t.url, 2000),
    notes: str(t.notes, 5000),
    status: STATUSES.has(t.status) ? t.status : 'todo',
    date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
    carried: Math.max(0, int(t.carried) ?? 0),
    createdAt: int(t.createdAt) ?? updatedAt,
    updatedAt,
    doneAt: int(t.doneAt),
    deleted: t.deleted ? 1 : 0,
    checklist: Array.isArray(t.checklist)
      ? JSON.stringify(t.checklist.slice(0, 100).map((i) => ({ text: str(i?.text, 200) ?? '', done: !!i?.done })))
      : null,
    startedAt: int(t.startedAt),
    // Older app versions do not send these fields; keep what the server has instead of wiping it.
    hasExtras: 'checklist' in t || 'startedAt' in t,
  };
}

const fromRow = (r) => ({
  id: r.id, title: r.title, tag: r.tag, url: r.url, notes: r.notes, status: r.status, date: r.date,
  carried: r.carried, createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at, deleted: r.deleted,
  checklist: r.checklist ? JSON.parse(r.checklist) : [], startedAt: r.started_at,
});

async function sync({ since = 0, changes = [] } = {}, env) {
  const rev = Date.now();
  const clean = (Array.isArray(changes) ? changes : []).slice(0, 500).map(cleanTask).filter(Boolean);

  if (clean.length) {
    const events = await diffEvents(clean, env);
    // Last write wins per task, decided by the client's updatedAt.
    const stmt = env.DB.prepare(
      `INSERT INTO tasks (id, title, tag, url, notes, status, date, carried, created_at, updated_at, done_at, deleted, rev, checklist, started_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, tag = excluded.tag, url = excluded.url, notes = excluded.notes,
         status = excluded.status, date = excluded.date, carried = excluded.carried,
         updated_at = excluded.updated_at, done_at = excluded.done_at, deleted = excluded.deleted, rev = excluded.rev,
         checklist = CASE WHEN ?16 THEN excluded.checklist ELSE tasks.checklist END,
         started_at = CASE WHEN ?16 THEN excluded.started_at ELSE tasks.started_at END
       WHERE excluded.updated_at > tasks.updated_at`
    );
    const log = env.DB.prepare('INSERT INTO task_events (task_id, at, kind, detail) VALUES (?1, ?2, ?3, ?4)');
    await env.DB.batch([
      ...clean.map((t) => stmt.bind(
        t.id, t.title, t.tag, t.url, t.notes, t.status, t.date, t.carried,
        t.createdAt, t.updatedAt, t.doneAt, t.deleted, rev, t.checklist, t.startedAt, t.hasExtras ? 1 : 0
      )),
      ...events.map((e) => log.bind(e.taskId, e.at, e.kind, e.detail ? JSON.stringify(e.detail) : null)),
    ]);
  }

  const { results } = await env.DB.prepare('SELECT * FROM tasks WHERE rev > ?1').bind(int(since) ?? 0).all();
  return { cursor: rev - CURSOR_OVERLAP_MS, tasks: results.map(fromRow) };
}

// Compares each incoming task with the stored row and returns one event per meaningful change,
// like commits in a log. Only writes that will win last-write-wins are recorded.
async function diffEvents(clean, env) {
  const existing = new Map();
  for (let i = 0; i < clean.length; i += 90) {
    const ids = clean.slice(i, i + 90).map((t) => t.id);
    const { results } = await env.DB.prepare(`SELECT * FROM tasks WHERE id IN (${ids.map((_, n) => `?${n + 1}`).join(',')})`).bind(...ids).all();
    for (const r of results) existing.set(r.id, r);
  }

  const events = [];
  for (const t of clean) {
    const old = existing.get(t.id);
    const push = (kind, detail = null, at = t.updatedAt) => events.push({ taskId: t.id, at, kind, detail });
    if (!old) {
      push('created', { title: t.title, tag: t.tag, date: t.date }, t.createdAt);
      if (t.startedAt) push('started', null, t.startedAt);
      if (t.status === 'done') push('done', null, t.doneAt || t.updatedAt);
      if (t.deleted) push('deleted');
      continue;
    }
    if (t.updatedAt <= old.updated_at) continue;

    if (t.deleted !== old.deleted) { push(t.deleted ? 'deleted' : 'restored'); if (t.deleted) continue; }
    if (t.title !== old.title) push('renamed', { from: old.title, to: t.title });
    if (t.tag !== old.tag) push('retagged', { from: old.tag, to: t.tag });
    if (t.status !== old.status) {
      if (t.status === 'done') push('done', null, t.doneAt || t.updatedAt);
      else if (t.status === 'doing') push('started');
      else push(old.status === 'done' ? 'reopened' : 'paused');
    }
    if (t.date !== old.date) push('moved', { from: old.date, to: t.date, carried: t.carried || 0 });
    if ((t.url || null) !== (old.url || null)) push('link', { to: t.url });
    if ((t.notes || null) !== (old.notes || null)) push('notes');
    if (t.hasExtras && t.checklist !== old.checklist) {
      const items = t.checklist ? JSON.parse(t.checklist) : [];
      push('checklist', { done: items.filter((i) => i.done).length, total: items.length });
    }
  }
  return events;
}

// Newest first, paged by time. Pass ?task= for one task's log, like `git log -- file`.
async function history(url, env) {
  const limit = Math.min(int(Number(url.searchParams.get('limit'))) || 200, 500);
  const before = int(Number(url.searchParams.get('before'))) || Number.MAX_SAFE_INTEGER;
  const beforeId = int(Number(url.searchParams.get('beforeId'))) || Number.MAX_SAFE_INTEGER;
  const task = url.searchParams.get('task');
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.task_id, e.at, e.kind, e.detail, t.title, t.tag, t.status, t.deleted
     FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id
     WHERE (e.at < ?1 OR (e.at = ?1 AND e.id < ?4)) AND (?2 IS NULL OR e.task_id = ?2)
     ORDER BY e.at DESC, e.id DESC LIMIT ?3`
  ).bind(before, task, limit + 1, beforeId).all();
  const more = results.length > limit;
  const events = results.slice(0, limit).map((r) => ({
    id: r.id, taskId: r.task_id, at: r.at, kind: r.kind, detail: r.detail ? JSON.parse(r.detail) : null,
    title: r.title, tag: r.tag, status: r.status, deleted: r.deleted,
  }));
  return { events, more };
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const raw = Object.fromEntries(results.map((r) => [r.key, r.value]));
  let calendars = raw.calendars ? JSON.parse(raw.calendars) : [];
  if (!raw.calendars && raw.ics_url) calendars = [{ name: 'Outlook', url: raw.ics_url }];
  return { calendars, tags: raw.tags ? JSON.parse(raw.tags) : [] };
}

async function putSettings(body, env) {
  const writes = [];
  if (Array.isArray(body.calendars)) {
    const calendars = body.calendars
      .map((c) => ({ name: str(c?.name, 40)?.trim() || 'Calendar', url: str(c?.url, 2000)?.trim() || '' }))
      .filter((c) => c.url)
      .slice(0, 10);
    for (const c of calendars) {
      if (!/^(https?|webcal):\/\//i.test(c.url)) throw new Error(`"${c.name}" link must start with https:// or webcal://`);
    }
    writes.push([SETTING_KEYS.calendars, JSON.stringify(calendars)]);
  }
  if (Array.isArray(body.tags)) {
    const tags = body.tags.filter((t) => typeof t === 'string').map((t) => t.slice(0, 40)).slice(0, 50);
    writes.push([SETTING_KEYS.tags, JSON.stringify(tags)]);
  }
  if (writes.length) {
    const stmt = env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    await env.DB.batch(writes.map(([k, v]) => stmt.bind(k, v)));
  }
  return getSettings(env);
}

async function calendar(url, env) {
  const { calendars } = await getSettings(env);
  if (!calendars.length) return { configured: false, calendars: [], events: [] };

  const from = Date.parse(url.searchParams.get('from')) || Date.now();
  const to = Date.parse(url.searchParams.get('to')) || from + 14 * 86400000;
  const tz = url.searchParams.get('tz') || 'UTC';

  // One broken link should not hide the other calendars.
  const results = await Promise.all(calendars.map(async (c, i) => {
    try {
      const res = await fetch(c.url.replace(/^webcal:/i, 'https:'), {
        cf: { cacheTtlByStatus: { '200-299': 300, '300-599': 0 } },
      });
      if (!res.ok) throw new Error(`link returned ${res.status}`);
      const events = expandCalendar(await res.text(), { from, to, tz }).map((e) => ({ ...e, id: `${i}|${e.id}`, cal: i }));
      return { events };
    } catch (err) {
      return { events: [], error: `${c.name}: ${err.message}` };
    }
  }));
  const events = results.flatMap((r) => r.events).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const errors = results.map((r) => r.error).filter(Boolean);
  return { configured: true, calendars: calendars.map((c) => c.name), events, error: errors.join('; ') || null };
}

async function lookup(url) {
  const target = url.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) throw new Error('Pass a full job link as ?url=');
  return lookupJob(target);
}
