'use strict';

/* ---------- Storage ---------- */

const KEYS = {
  tasks: 'tb.tasks', cursor: 'tb.cursor', token: 'tb.token', cal: 'tb.calendar',
  tags: 'tb.customTags', lastOpen: 'tb.lastOpen', view: 'tb.view', lastSync: 'tb.lastSync', history: 'tb.history',
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

let tasks = load(KEYS.tasks, {});
let cursor = load(KEYS.cursor, 0);
let calendarCache = load(KEYS.cal, null);
let customTags = load(KEYS.tags, []);
let view = load(KEYS.view, 'today');
let tagFilter = null;
let lastSync = load(KEYS.lastSync, 0);
let historyCache = load(KEYS.history, { events: [], more: false, fetchedAt: 0 });
let historyQuery = '';

const saveTasks = () => store(KEYS.tasks, tasks);

/* ---------- Dates ---------- */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function friendlyDate(s) {
  if (!s) return 'Backlog';
  const t = todayStr();
  if (s === t) return 'Today';
  if (s === addDays(t, 1)) return 'Tomorrow';
  if (s === addDays(t, -1)) return 'Yesterday';
  const d = parseYmd(s);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
const timeLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ---------- Tags ---------- */

const DEFAULT_TAGS = {
  apply: { label: 'Apply', color: '#2563eb' },
  'linkedin-dm': { label: 'LinkedIn DM', color: '#0f766e' },
  'linkedin-post': { label: 'LinkedIn post', color: '#db2777' },
  buy: { label: 'Buy', color: '#c2410c' },
  book: { label: 'Book', color: '#7c3aed' },
  prep: { label: 'Prep', color: '#15803d' },
  todo: { label: 'To do', color: '#57534e' },
};
const EXTRA_COLORS = ['#0891b2', '#65a30d', '#ca8a04', '#9333ea', '#e11d48', '#0d9488', '#4f46e5'];

function tagInfo(tag) {
  if (DEFAULT_TAGS[tag]) return DEFAULT_TAGS[tag];
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const label = tag.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return { label, color: EXTRA_COLORS[h % EXTRA_COLORS.length] };
}
function allTags() {
  const set = new Set([...Object.keys(DEFAULT_TAGS), ...customTags]);
  for (const t of liveTasks()) set.add(t.tag);
  return [...set];
}
const chipHtml = (tag) => { const i = tagInfo(tag); return `<span class="chip" style="--c:${i.color}">${esc(i.label)}</span>`; };

/* ---------- Link and quick-add parsing ---------- */

function titleCase(s) {
  if (!s) return '';
  let out = s;
  try { out = decodeURIComponent(s); } catch { /* keep raw */ }
  return out.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

const ATS = [
  [/(^|\.)greenhouse\.io$/, (u, p) => (p[0] === 'embed' ? u.searchParams.get('for') : p[0])],
  [/(^|\.)lever\.co$/, (u, p) => p[0]],
  [/(^|\.)ashbyhq\.com$/, (u, p) => p[0]],
  [/(^|\.)myworkdayjobs\.com$/, (u) => u.hostname.split('.')[0]],
  [/(^|\.)smartrecruiters\.com$/, (u, p) => p[0]],
  [/(^|\.)workable\.com$/, (u, p) => p[0]],
  [/(^|\.)icims\.com$/, (u) => u.hostname.split('.')[0].replace(/^(careers|jobs)-/, '')],
  [/(^|\.)jobvite\.com$/, (u, p) => p[0]],
  [/(^|\.)rippling\.com$/, (u, p) => p[0]],
  [/(^|\.)wellfound\.com$/, (u, p) => (p[0] === 'company' ? p[1] : '')],
];
const SHOPS = /(^|\.)(amazon|a\.co|bestbuy|target|walmart|ebay|costco|etsy|ikea|homedepot|newegg)\.(com|co)$/;
const BOOKINGS = /(^|\.)(opentable|resy|booking|airbnb|expedia|kayak|delta|united|aa|southwest|calendly|zocdoc|hotels|amtrak|ticketmaster)\.com$/;

function guessFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return {}; }
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname.split('/').filter(Boolean);
  const site = titleCase(host.split('.').slice(-2, -1)[0]);

  if (/(^|\.)linkedin\.com$/.test(host)) {
    if (p[0] === 'in' && p[1]) return { tag: 'linkedin-dm', title: `DM ${titleCase(p[1].replace(/-[a-z0-9]*\d[a-z0-9]*$/i, ''))}` };
    if (p[0] === 'jobs') return { tag: 'apply', title: 'Apply: LinkedIn job' };
    if (['posts', 'feed', 'pulse'].includes(p[0])) return { tag: 'linkedin-post', title: 'LinkedIn post' };
    if (p[0] === 'company' && p[1]) return { tag: 'linkedin-dm', title: `Reach out at ${titleCase(p[1])}` };
    return { tag: 'linkedin-dm', title: 'LinkedIn' };
  }
  for (const [re, pick] of ATS) {
    if (re.test(host)) return { tag: 'apply', title: `Apply: ${titleCase(pick(u, p)) || site}` };
  }
  if (/^(careers|jobs)\./.test(host) || p.some((s) => /^(careers?|jobs?)$/i.test(s))) {
    return { tag: 'apply', title: `Apply: ${titleCase(host.replace(/^(careers|jobs)\./, '').split('.')[0])}` };
  }
  if (SHOPS.test(host)) {
    const product = p[1] === 'dp' ? titleCase(p[0]).slice(0, 60) : '';
    return { tag: 'buy', title: product ? `Buy ${product}` : `Buy from ${site}` };
  }
  if (BOOKINGS.test(host)) return { tag: 'book', title: `Book via ${site}` };
  return { title: host };
}

function parseQuick(text) {
  let url = null;
  let tag = null;
  let date = todayStr();
  let s = ` ${text} `;
  s = s.replace(/https?:\/\/\S+/i, (m) => { url = m; return ' '; });
  s = s.replace(/\s#([\w-]+)/g, (_, t) => { tag = t.toLowerCase(); return ' '; });
  s = s.replace(/\s(today|tomorrow|tmrw|backlog|someday|later|mon|tue|wed|thu|fri|sat|sun)(?=\s)/i, (_, w) => {
    w = w.toLowerCase();
    if (w === 'tomorrow' || w === 'tmrw') date = addDays(todayStr(), 1);
    else if (['backlog', 'someday', 'later'].includes(w)) date = null;
    else if (w !== 'today') {
      const diff = (WEEKDAY_NAMES.indexOf(w) - new Date().getDay() + 7) % 7 || 7;
      date = addDays(todayStr(), diff);
    }
    return ' ';
  });
  let title = s.replace(/\s+/g, ' ').trim();
  let checklist = [];
  const list = !url && /^([^:]+):(.+,.+)$/.exec(title);
  if (list) {
    title = list[1].trim();
    checklist = list[2].split(',').map((x) => x.trim()).filter(Boolean).map((text) => ({ text, done: false }));
  }
  if (url) {
    const g = guessFromUrl(url);
    tag ||= g.tag;
    if (!title) title = g.title;
  }
  if (!tag && checklist.length && /grocer|shopping|costco|trader|walmart|target/i.test(title)) tag = 'buy';
  return { title: title || url || 'Untitled', tag: tag || 'todo', url, date, checklist };
}

/* ---------- Task model ---------- */

const liveTasks = () => Object.values(tasks).filter((t) => !t.deleted);

function createTask(fields) {
  const now = Date.now();
  const t = {
    id: crypto.randomUUID(), title: '', tag: 'todo', url: null, notes: null, status: 'todo',
    date: todayStr(), carried: 0, checklist: [], startedAt: null, createdAt: now, updatedAt: now, doneAt: null, deleted: 0, ...fields, _dirty: true,
  };
  tasks[t.id] = t;
  commit();
  return t;
}

function updateTask(id, patch, { quiet = false } = {}) {
  const prev = tasks[id];
  if (!prev) return;
  if ('date' in patch && !('carried' in patch) && isOverdue(prev)) patch = { ...patch, carried: carriedDays(prev) };
  const next = { ...prev, ...patch, updatedAt: Math.max(Date.now(), prev.updatedAt + 1), _dirty: true };
  if (patch.status === 'done' && prev.status !== 'done') next.doneAt = Date.now();
  if (patch.status === 'doing' && !prev.startedAt) next.startedAt = Date.now();
  if (patch.status && patch.status !== 'done') next.doneAt = null;
  tasks[id] = next;
  if (!quiet) commit();
}

function commit() {
  saveTasks();
  render();
  scheduleSync();
}

// Unfinished work from an earlier day is shown under today. This is computed when drawing, never
// written back: an automatic write from a device with stale data would win last-write-wins sync and
// undo newer edits (like ticking Done) made on another device.
const isOverdue = (t) => t.status !== 'done' && !!t.date && t.date < todayStr();
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);

// Days a task has slipped: what was recorded when its date was last rewritten, plus days overdue since.
// Work already in progress moves forward without counting as a slip.
function carriedDays(t) {
  if (t.status === 'done') return t.carried || 0;
  return (t.carried || 0) + (isOverdue(t) && t.status !== 'doing' ? daysBetween(t.date, todayStr()) : 0);
}

/* ---------- Sync ---------- */

const getToken = () => load(KEYS.token, '');
let syncTimer = null;
let syncing = false;
let syncAgain = false;
let syncState = 'local';

function scheduleSync(delay = 700) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

function setSyncState(state) {
  syncState = state;
  const pill = document.getElementById('syncBtn');
  pill.dataset.state = state;
  const pending = Object.values(tasks).filter((t) => t._dirty).length;
  const labels = {
    local: 'Not connected', syncing: 'Syncing', ok: pending ? `${pending} pending` : 'Synced',
    offline: pending ? `Offline, ${pending} pending` : 'Offline', auth: 'Check token',
  };
  document.getElementById('syncText').textContent = labels[state];
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) { const e = new Error('unauthorized'); e.auth = true; throw e; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function sync() {
  if (!getToken()) return setSyncState('local');
  if (!navigator.onLine) return setSyncState('offline');
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncState('syncing');

  const changes = Object.values(tasks).filter((t) => t._dirty).map(({ _dirty, ...t }) => t);
  try {
    const data = await api('/api/sync', { method: 'POST', body: JSON.stringify({ since: cursor, changes }) });
    const sent = new Map(changes.map((c) => [c.id, c.updatedAt]));
    for (const t of Object.values(tasks)) {
      if (t._dirty && sent.get(t.id) === t.updatedAt) delete t._dirty;
    }
    for (const incoming of data.tasks) {
      const local = tasks[incoming.id];
      if (!local || !local._dirty || incoming.updatedAt > local.updatedAt) tasks[incoming.id] = incoming;
    }
    cursor = data.cursor;
    lastSync = Date.now();
    store(KEYS.cursor, cursor);
    store(KEYS.lastSync, lastSync);
    saveTasks();
    render();
    setSyncState('ok');
    if (view === 'history' && changes.length) refreshHistory();
  } catch (err) {
    setSyncState(err.auth ? 'auth' : 'offline');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

/* ---------- Calendar ---------- */

let calendarLoading = false;

async function refreshCalendar(force = false) {
  if (!getToken() || !navigator.onLine || calendarLoading) return;
  const fresh = calendarCache && calendarCache.day === todayStr() && Date.now() - calendarCache.fetchedAt < 10 * 60 * 1000;
  if (fresh && !force) return;
  calendarLoading = true;
  try {
    const start = parseYmd(todayStr());
    const end = parseYmd(addDays(todayStr(), 14));
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const params = new URLSearchParams({ from: start.toISOString(), to: end.toISOString(), tz });
    const data = await api(`/api/calendar?${params}`);
    calendarCache = { ...data, day: todayStr(), fetchedAt: Date.now(), error: null };
  } catch (err) {
    calendarCache = { ...(calendarCache || { configured: true, events: [] }), error: err.message };
  } finally {
    calendarLoading = false;
  }
  store(KEYS.cal, calendarCache);
  render();
}

// Returns events grouped by local day, spreading multi-day all-day events across each day they cover.
function eventsByDay() {
  const byDay = new Map();
  const push = (day, ev) => { if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(ev); };
  for (const ev of calendarCache?.events || []) {
    if (ev.allDay) {
      for (let d = ev.start; d < ev.end; d = addDays(d, 1)) push(d, ev);
    } else {
      push(ymd(new Date(ev.start)), ev);
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : 1) : a.allDay ? -1 : 1));
  return byDay;
}

/* ---------- History ---------- */

let historyLoading = false;

// Fetches the newest page and merges it into what is cached; `older` pages further back instead.
async function refreshHistory({ older = false } = {}) {
  if (!getToken() || !navigator.onLine || historyLoading) return;
  historyLoading = true;
  try {
    const params = new URLSearchParams({ limit: '200' });
    const last = historyCache.events[historyCache.events.length - 1];
    if (older && last) { params.set('before', last.at); params.set('beforeId', last.id); }
    const data = await api(`/api/history?${params}`);
    const byId = new Map((older || historyCache.events.length ? historyCache.events : []).map((e) => [e.id, e]));
    for (const e of data.events) byId.set(e.id, e);
    const events = [...byId.values()].sort((a, b) => b.at - a.at || b.id - a.id);
    historyCache = { events, more: older || !historyCache.fetchedAt ? data.more : historyCache.more, fetchedAt: Date.now() };
    // Keep the device copy small; older pages can always be fetched again.
    store(KEYS.history, { ...historyCache, events: events.slice(0, 1000), more: historyCache.more || events.length > 1000 });
  } catch (err) {
    historyCache.error = err.message;
  } finally {
    historyLoading = false;
  }
  if (view === 'history') render();
}

async function openTaskLog(taskId) {
  const t = tasks[taskId];
  sheet.innerHTML = `<form method="dialog"><h2>${esc(t?.title || 'Task history')}</h2>
    <div id="taskLog"><p class="hint">Loading...</p></div>
    <div class="sheet-actions">
      ${t && !t.deleted ? '<button type="button" class="btn" data-act="open-task" style="margin-right:auto">Open task</button>' : ''}
      <button type="button" class="btn-primary" data-act="close">Close</button>
    </div></form>`;
  sheet.querySelector('[data-act="close"]').addEventListener('click', () => sheet.close());
  sheet.querySelector('[data-act="open-task"]')?.addEventListener('click', () => { sheet.close(); openTaskSheet(taskId); });
  sheet.showModal();
  const local = historyCache.events.filter((e) => e.taskId === taskId);
  const draw = (events) => { $('#taskLog', sheet).innerHTML = events.length ? `<div class="log">${events.map((e) => commitHtml(e, { subject: false })).join('')}</div>` : '<p class="hint">No history yet.</p>'; };
  if (local.length) draw(local);
  try {
    const data = await api(`/api/history?${new URLSearchParams({ task: taskId, limit: '500' })}`);
    if (sheet.open) draw(data.events);
  } catch {
    if (!local.length) $('#taskLog', sheet).innerHTML = '<p class="hint">Connect to the internet to load this task\'s history.</p>';
  }
}

const KIND_INFO = {
  created: { icon: '+', color: 'var(--accent)' },
  done: { icon: '&#10003;', color: 'var(--ok)' },
  started: { icon: '&#9654;', color: 'var(--accent)' },
  reopened: { icon: '&#8634;', color: 'var(--carry)' },
  paused: { icon: '&#8214;', color: 'var(--muted)' },
  moved: { icon: '&#8594;', color: 'var(--carry)' },
  renamed: { icon: '&#9998;', color: 'var(--muted)' },
  retagged: { icon: '#', color: 'var(--muted)' },
  link: { icon: '&#128279;', color: 'var(--muted)' },
  notes: { icon: '&#9998;', color: 'var(--muted)' },
  checklist: { icon: '&#9745;', color: 'var(--ok)' },
  deleted: { icon: '&#10005;', color: 'var(--danger)' },
  restored: { icon: '&#8634;', color: 'var(--ok)' },
};

function commitMessage(e) {
  const d = e.detail || {};
  switch (e.kind) {
    case 'created': return `Created ${d.date ? `for ${esc(friendlyDate(d.date))}` : 'in Backlog'}`;
    case 'done': return 'Completed';
    case 'started': return 'Started';
    case 'reopened': return 'Reopened';
    case 'paused': return 'Moved back to To do';
    case 'moved': return `Moved ${esc(friendlyDate(d.from))} &#8594; ${esc(friendlyDate(d.to))}${d.carried ? ` <span class="carry-badge">slipped ${d.carried}d</span>` : ''}`;
    case 'renamed': return `Renamed from <q>${esc(d.from)}</q>`;
    case 'retagged': return `Retagged ${esc(tagInfo(d.from || 'todo').label)} &#8594; ${esc(tagInfo(d.to || 'todo').label)}`;
    case 'link': return d.to ? 'Link updated' : 'Link removed';
    case 'notes': return 'Notes edited';
    case 'checklist': return `Checklist ${d.done}/${d.total}`;
    case 'deleted': return 'Deleted';
    case 'restored': return 'Restored';
  }
  return esc(e.kind);
}

// A short, stable git-style hash for each event.
function shortHash(e) {
  let h = 0x811c9dc5;
  for (const ch of `${e.id}:${e.taskId}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

function commitHtml(e, { subject = true } = {}) {
  const k = KIND_INFO[e.kind] || KIND_INFO.notes;
  const title = tasks[e.taskId]?.title ?? e.title ?? e.detail?.title ?? 'Untitled';
  const tag = tasks[e.taskId]?.tag ?? e.tag;
  const when = subject ? timeLabel(e.at) : new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<button type="button" class="commit" data-act="task-log" data-task="${esc(e.taskId)}" style="--k:${k.color}">
    <span class="node">${k.icon}</span>
    <span class="c-body">
      ${subject ? `<span class="c-subject">${esc(title)}</span>` : ''}
      <span class="c-msg">${commitMessage(e)}</span>
    </span>
    <span class="c-side">${subject && tag ? chipHtml(tag) : ''}<code>${shortHash(e)}</code><span>${esc(when)}</span></span>
  </button>`;
}

// Monday-based week start for a local date string.
const weekStart = (s) => addDays(s, -((parseYmd(s).getDay() + 6) % 7));

function heatmapHtml() {
  const WEEKS = 18;
  const counts = new Map();
  for (const t of liveTasks()) if (t.doneAt) { const d = ymd(new Date(t.doneAt)); counts.set(d, (counts.get(d) || 0) + 1); }
  const start = addDays(weekStart(todayStr()), -7 * (WEEKS - 1));
  const max = Math.max(1, ...counts.values());
  let total = 0;
  const cols = [];
  for (let w = 0; w < WEEKS; w++) {
    const cells = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, w * 7 + d);
      if (day > todayStr()) { cells.push('<i class="future"></i>'); continue; }
      const n = counts.get(day) || 0;
      total += n;
      const level = n ? Math.min(4, Math.ceil((n / max) * 4)) : 0;
      cells.push(`<i data-l="${level}" title="${esc(friendlyDate(day))}: ${n} done"></i>`);
    }
    cols.push(`<span class="hm-col">${cells.join('')}</span>`);
  }
  return `<div class="heatmap"><div class="hm-grid">${cols.join('')}</div>
    <div class="hm-foot"><span>${total} tasks done in the last ${WEEKS} weeks</span>
    <span class="hm-legend">Less <i data-l="0"></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i> More</span></div></div>`;
}

function weekStatsHtml() {
  const ws = parseYmd(weekStart(todayStr())).getTime();
  const live = liveTasks();
  const added = live.filter((t) => t.createdAt >= ws).length;
  const done = live.filter((t) => t.doneAt && t.doneAt >= ws).length;
  const open = live.filter((t) => t.status !== 'done' && t.date && t.date <= todayStr()).length;
  return `<div class="stats">
    <div><strong>${added}</strong><span>added this week</span></div>
    <div><strong>${done}</strong><span>done this week</span></div>
    <div><strong>${open}</strong><span>open now</span></div>
  </div>`;
}

function historyLogHtml() {
  const q = historyQuery.trim().toLowerCase();
  const events = historyCache.events.filter((e) => {
    const title = tasks[e.taskId]?.title ?? e.title ?? '';
    const tag = tasks[e.taskId]?.tag ?? e.tag;
    return (!tagFilter || tag === tagFilter) && (!q || title.toLowerCase().includes(q) || e.kind.includes(q));
  });
  if (!events.length) {
    if (!historyCache.fetchedAt) return `<div class="empty">${historyLoading ? 'Loading history...' : 'History loads when you are online.'}</div>`;
    return `<div class="empty">${q || tagFilter ? 'No changes match.' : 'No history yet. Every change you make from now on shows up here.'}</div>`;
  }
  const weeks = new Map();
  for (const e of events) {
    const day = ymd(new Date(e.at));
    const wk = weekStart(day);
    if (!weeks.has(wk)) weeks.set(wk, new Map());
    const days = weeks.get(wk);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(e);
  }
  const thisWeek = weekStart(todayStr());
  return [...weeks].map(([wk, days]) => {
    const all = [...days.values()].flat();
    const done = all.filter((e) => e.kind === 'done').length;
    const label = wk === thisWeek ? 'This week' : wk === addDays(thisWeek, -7) ? 'Last week' : `Week of ${parseYmd(wk).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    return `<section class="section">
      <div class="section-head"><h2>${esc(label)}</h2><span class="count">${all.length} change${all.length > 1 ? 's' : ''}${done ? ` · ${done} done` : ''}</span></div>
      ${[...days].map(([day, list]) => `<div class="log-day">${esc(friendlyDate(day))}</div><div class="log">${list.map((e) => commitHtml(e)).join('')}</div>`).join('')}
    </section>`;
  }).join('') + (historyCache.more ? `<p><button type="button" class="btn" data-act="history-more">${historyLoading ? 'Loading...' : 'Load older'}</button></p>` : '');
}

function renderHistory() {
  if (!getToken()) return `<div class="notice"><strong>Connect sync first.</strong> History is kept on the server, so open Settings and paste your access token.</div>`;
  const err = historyCache.error ? `<p class="hint">Showing saved history. Last refresh failed: ${esc(historyCache.error)}</p>` : '';
  return `${heatmapHtml()}${weekStatsHtml()}
    <input id="historySearch" class="search" type="search" placeholder="Search history" value="${esc(historyQuery)}" autocomplete="off">
    ${err}<div id="historyLog">${historyLogHtml()}</div>`;
}

/* ---------- Rendering ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

const LINK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

const INLINE_ITEMS = 12;

// Checklist shown right under the task: tap an item to tick it, done items sink to the bottom.
function inlineChecklist(t, compact) {
  const items = (t.checklist || []).map((item, n) => ({ ...item, n }));
  if (!items.length || t.status === 'done') return '';
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  const bar = `<div class="ck-progress"><div class="ck-bar"><i style="width:${pct}%"></i></div><span>${done}/${items.length}</span></div>`;
  if (compact) return bar;
  const ordered = [...items.filter((i) => !i.done), ...items.filter((i) => i.done)];
  const shown = ordered.slice(0, INLINE_ITEMS);
  const more = ordered.length - shown.length;
  return `${bar}<div class="ick-list">${shown.map((i) => `<button type="button" class="ick ${i.done ? 'done' : ''}" data-act="ck" data-n="${i.n}" aria-pressed="${i.done}"><span class="box"></span><span class="ick-text">${esc(i.text)}</span></button>`).join('')}${more > 0 ? `<button type="button" class="ick more" data-act="edit">+${more} more</button>` : ''}</div>`;
}

function taskHtml(t, { showDate = false, compact = false } = {}) {
  const url = safeUrl(t.url);
  const meta = [chipHtml(t.tag)];
  if (t.status === 'doing') meta.push('<span class="doing-badge">In progress</span>');
  const slipped = carriedDays(t);
  if (slipped && t.status !== 'done') meta.push(`<span class="carry-badge" title="Carried over ${slipped} day(s)">&#8635; ${slipped} day${slipped > 1 ? 's' : ''}</span>`);
  if (showDate) meta.push(`<span>${esc(friendlyDate(t.date))}</span>`);
  const items = t.checklist || [];
  if (items.length && t.status === 'done') meta.push(`<span title="Checklist">&#9745; ${items.filter((i) => i.done).length}/${items.length}</span>`);
  if (t.status === 'doing' && t.startedAt) meta.push(`<span>Started ${esc(startedLabel(t.startedAt))}</span>`);
  if (t.notes) meta.push('<span title="Has notes">&#9998;</span>');
  return `<div class="task ${t.status}" data-id="${esc(t.id)}">
    <button class="check" type="button" data-act="toggle" aria-label="${t.status === 'done' ? 'Mark not done' : 'Mark done'}"></button>
    <div class="body" data-act="edit"><div class="t-title">${esc(t.title)}</div><div class="meta">${meta.join('')}</div>${inlineChecklist(t, compact)}</div>
    ${url ? `<a class="open-link" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Open link">${LINK_ICON}</a>` : ''}
  </div>`;
}

function startedLabel(ms) {
  const days = Math.round((parseYmd(todayStr()) - parseYmd(ymd(new Date(ms)))) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function sectionHtml(title, items, { cls = '', empty = '', showDate = false } = {}) {
  if (!items.length && !empty) return '';
  return `<section class="section ${cls}">
    <div class="section-head"><h2>${esc(title)}</h2><span class="count">${items.length || ''}</span></div>
    <div class="list">${items.length ? items.map((t) => taskHtml(t, { showDate })).join('') : `<div class="empty">${empty}</div>`}</div>
  </section>`;
}

const CAL_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];

function eventHtml(ev, day) {
  const url = safeUrl(ev.url);
  const past = !ev.allDay && new Date(ev.end) < new Date();
  const time = ev.allDay ? 'All day' : `${timeLabel(ev.start)}`;
  const calNames = calendarCache?.calendars || [];
  const source = calNames.length > 1 ? calNames[ev.cal] : '';
  const sub = [ev.allDay ? '' : `until ${timeLabel(ev.end)}`, ev.location || '', source].filter(Boolean).join(' · ');
  return `<div class="event ${past ? 'past' : ''}" style="--cal:${CAL_COLORS[(ev.cal || 0) % CAL_COLORS.length]}">
    <div class="time">${esc(time)}</div>
    <div class="e-body"><div class="e-title">${esc(ev.title)}</div>${sub ? `<div class="e-sub">${esc(sub)}</div>` : ''}</div>
    ${url ? `<a class="open-link" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Open event link">${LINK_ICON}</a>` : ''}
    <button class="mini-btn" type="button" data-act="event-task" data-day="${day}" data-event="${esc(ev.id)}">+ Task</button>
  </div>`;
}

const byOrder = (a, b) => (a.status === 'doing') - (b.status === 'doing') || carriedDays(b) - carriedDays(a) || a.createdAt - b.createdAt;
const matchesFilter = (t) => !tagFilter || t.tag === tagFilter;

function renderToday() {
  const t = todayStr();
  const visible = liveTasks().filter(matchesFilter);
  const due = visible.filter((x) => x.status !== 'done' && x.date && x.date <= t);
  const carried = due.filter((x) => carriedDays(x) > 0).sort(byOrder);
  const fresh = due.filter((x) => !carriedDays(x)).sort((a, b) => (b.status === 'doing') - (a.status === 'doing') || a.createdAt - b.createdAt);
  const doneToday = visible.filter((x) => x.status === 'done' && x.doneAt && ymd(new Date(x.doneAt)) === t).sort((a, b) => b.doneAt - a.doneAt);
  const upcoming = visible.filter((x) => x.status !== 'done' && x.date && x.date > t && x.date <= addDays(t, 7))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));

  const todayEvents = eventsByDay().get(t) || [];
  let calendarBlock = '';
  if (calendarCache?.configured) {
    calendarBlock = `<section class="section">
      <div class="section-head"><h2>Calendar</h2><span class="count">${todayEvents.length || ''}</span></div>
      <div class="list">${todayEvents.length ? todayEvents.map((e) => eventHtml(e, t)).join('') : '<div class="empty">No events today.</div>'}</div>
    </section>`;
  }

  const doneBlock = doneToday.length ? `<details class="section done-block">
      <summary class="section-head"><h2>Done today</h2><span class="count">${doneToday.length}</span></summary>
      <div class="list">${doneToday.map((x) => taskHtml(x)).join('')}</div>
    </details>` : '';

  const emptyMsg = carried.length ? 'Nothing new for today.' : 'Nothing due today. Add something above, or pull a task from the Backlog on the Board.';
  return `<div class="today-grid">
    <div>
      ${sectionHtml(`Carried over`, carried, { cls: 'carried' })}
      ${sectionHtml('Today', fresh, { empty: emptyMsg })}
      ${doneBlock}
    </div>
    <div>
      ${calendarBlock}
      ${sectionHtml('Coming up', upcoming, { showDate: true })}
    </div>
  </div>`;
}

const COLUMNS = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'upcoming', title: 'Upcoming' },
  { id: 'today', title: 'Today' },
  { id: 'doing', title: 'In progress' },
  { id: 'done', title: 'Done' },
];

function columnOf(task) {
  const t = todayStr();
  if (task.status === 'done') return 'done';
  if (task.status === 'doing') return 'doing';
  if (!task.date) return 'backlog';
  return task.date > t ? 'upcoming' : 'today';
}

function moveToColumn(id, col) {
  const task = tasks[id];
  if (!task || columnOf(task) === col) return;
  const t = todayStr();
  const patches = {
    backlog: { status: 'todo', date: null },
    upcoming: { status: 'todo', date: task.date && task.date > t ? task.date : addDays(t, 1) },
    today: { status: 'todo', date: t },
    doing: { status: 'doing', date: task.date && task.date <= t ? task.date : t },
    done: { status: 'done' },
  };
  updateTask(id, patches[col]);
}

function renderPrep() {
  const live = liveTasks().filter(matchesFilter);
  const doing = live.filter((t) => t.status === 'doing').sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const notStarted = live.filter((t) => t.tag === 'prep' && t.status === 'todo')
    .sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);
  const monthAgo = Date.now() - 30 * 86400000;
  const finished = live.filter((t) => t.tag === 'prep' && t.status === 'done' && (t.doneAt || 0) > monthAgo).sort((a, b) => b.doneAt - a.doneAt);
  return `<p class="hint" style="margin:0 2px 14px">What you have started, plus your prep list. Tag anything <strong>#prep</strong>, and set a task to In progress when you begin it.</p>
    ${sectionHtml('In progress', doing, { empty: 'Nothing started yet. Open a task and set it to In progress.', showDate: false })}
    ${sectionHtml('Prep, not started', notStarted, { showDate: true, empty: 'No prep tasks waiting. Try: "System design basics #prep backlog".' })}
    ${finished.length ? `<details class="section done-block"><summary class="section-head"><h2>Finished (30 days)</h2><span class="count">${finished.length}</span></summary><div class="list">${finished.map((x) => taskHtml(x)).join('')}</div></details>` : ''}`;
}

function renderBoard() {
  const weekAgo = Date.now() - 7 * 86400000;
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const task of liveTasks().filter(matchesFilter)) {
    const col = columnOf(task);
    if (col === 'done' && (task.doneAt || 0) < weekAgo) continue;
    groups[col].push(task);
  }
  groups.upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  groups.done.sort((a, b) => b.doneAt - a.doneAt);
  groups.today.sort(byOrder);
  return `<div class="board">${COLUMNS.map((c) => `
    <div class="column" data-col="${c.id}">
      <h3><span>${c.title}</span><span>${groups[c.id].length || ''}</span></h3>
      ${groups[c.id].map((task) => `<div class="card" draggable="true" data-id="${esc(task.id)}">${taskHtml(task, { showDate: c.id === 'upcoming', compact: true })}</div>`).join('')}
    </div>`).join('')}
  </div>
  <p class="hint">Drag cards between columns on the Mac, or tap a card to move it. Done shows the last 7 days.</p>`;
}

function renderCalendar() {
  if (!getToken()) {
    return `<div class="notice"><strong>Connect sync first.</strong> Open Settings and paste your access token, then add your calendar links.</div>`;
  }
  if (!calendarCache?.configured) {
    return `<div class="notice">
      <p><strong>Add your calendars.</strong> Outlook and Apple Calendar both work.</p>
      <ol class="hint">
        <li>Open Outlook on the web, then Settings, Calendar, Shared calendars.</li>
        <li>Under "Publish a calendar", pick your calendar and "Can view all details", then Publish.</li>
        <li>Copy the ICS link and paste it in Settings here.</li>
        <li>Apple Calendar: in the Calendar app, right-click (or tap the i next to) a calendar, turn on Public Calendar, copy the link.</li>
      </ol>
      <p><button class="btn" type="button" data-act="settings">Open Settings</button></p>
    </div>`;
  }
  const byDay = eventsByDay();
  const days = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(todayStr(), i);
    const evs = byDay.get(day) || [];
    if (!evs.length && i > 1) continue;
    days.push(`<section class="section">
      <div class="section-head"><h2>${esc(friendlyDate(day))}</h2><span class="count">${evs.length || ''}</span></div>
      <div class="list">${evs.length ? evs.map((e) => eventHtml(e, day)).join('') : '<div class="empty">No events.</div>'}</div>
    </section>`);
  }
  const err = calendarCache.error ? `<p class="hint">Showing saved events. Last refresh failed: ${esc(calendarCache.error)}</p>` : '';
  const updated = calendarCache.fetchedAt ? `<p class="hint">Updated ${new Date(calendarCache.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>` : '';
  return err + days.join('') + updated;
}

function renderHeader() {
  const t = todayStr();
  const d = parseYmd(t);
  $('#title').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const due = liveTasks().filter((x) => x.status !== 'done' && x.date && x.date <= t);
  const carried = due.filter((x) => carriedDays(x)).length;
  const doneCount = liveTasks().filter((x) => x.status === 'done' && x.doneAt && ymd(new Date(x.doneAt)) === t).length;
  const bits = [`${due.length} to do`];
  if (carried) bits.push(`${carried} carried over`);
  if (doneCount) bits.push(`${doneCount} done`);
  $('#subtitle').textContent = bits.join(' · ');

  for (const btn of document.querySelectorAll('.tabs button')) btn.setAttribute('aria-selected', String(btn.dataset.view === view));

  const tags = allTags();
  $('#tagFilter').innerHTML = `<button type="button" class="chip all" data-filter="" aria-pressed="${!tagFilter}">All</button>` +
    tags.map((tag) => { const i = tagInfo(tag); return `<button type="button" class="chip" style="--c:${i.color}" data-filter="${esc(tag)}" aria-pressed="${tagFilter === tag}">${esc(i.label)}</button>`; }).join('');
}

function render() {
  renderHeader();
  const main = $('#view');
  const local = liveTasks().length;
  $('#banner').innerHTML = !getToken() && local
    ? `<button type="button" class="banner" data-act="settings">Not syncing: ${local} task${local > 1 ? 's are' : ' is'} only on this device. Tap to add your token.</button>`
    : syncState === 'auth' ? '<button type="button" class="banner" data-act="settings">Token not accepted. Tap to fix it in Settings.</button>' : '';
  const views = { board: renderBoard, prep: renderPrep, calendar: renderCalendar, history: renderHistory };
  main.innerHTML = (views[view] || renderToday)();
  setSyncState(syncState);
}

/* ---------- Sheets ---------- */

const sheet = $('#sheet');

function openTaskSheet(id) {
  const t = tasks[id];
  if (!t) return;
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  // An overdue task is shown under today, so the sheet shows it that way too.
  const shownDate = isOverdue(t) ? today : t.date;
  sheet.innerHTML = `<form method="dialog" id="taskForm">
    <h2>Edit task</h2>
    <label class="field"><span>Title</span><input name="title" value="${esc(t.title)}" required></label>
    <div class="field"><span>Checklist <em id="ckCount"></em></span>
      <div class="ck-bar big" id="ckBar"><i></i></div>
      <div class="checklist" id="checklist"></div>
      <div class="add-item"><input id="newItem" placeholder="Add items: milk, eggs" enterkeyhint="enter"><button type="button" class="btn" data-act="add-item">Add</button></div>
    </div>
    <div class="field"><span>Tag</span><div class="chips" id="tagPick">
      ${allTags().map((tag) => { const i = tagInfo(tag); return `<button type="button" class="chip" style="--c:${i.color}" data-tag="${esc(tag)}" aria-pressed="${t.tag === tag}">${esc(i.label)}</button>`; }).join('')}
    </div></div>
    <label class="field"><span>Link</span><input name="url" type="url" inputmode="url" value="${esc(t.url || '')}" placeholder="https://"></label>
    <div class="field"><span>When</span>
      <div class="row">
        <div class="seg" id="datePick">
          <button type="button" data-date="${today}" aria-pressed="${shownDate === today}">Today</button>
          <button type="button" data-date="${tomorrow}" aria-pressed="${shownDate === tomorrow}">Tomorrow</button>
          <button type="button" data-date="" aria-pressed="${!shownDate}">Backlog</button>
        </div>
        <input name="date" type="date" value="${esc(shownDate || '')}">
      </div>
    </div>
    <div class="field"><span>Status</span>
      <div class="seg" id="statusPick">
        ${[['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']].map(([v, l]) => `<button type="button" data-status="${v}" aria-pressed="${t.status === v}">${l}</button>`).join('')}
      </div>
    </div>
    <label class="field"><span>Notes</span><textarea name="notes" placeholder="Anything to remember">${esc(t.notes || '')}</textarea></label>
    ${carriedDays(t) ? `<p class="hint">Carried over ${carriedDays(t)} day${carriedDays(t) > 1 ? 's' : ''}.</p>` : ''}
    <div class="sheet-actions">
      <button type="button" class="btn btn-danger" data-act="delete">Delete</button>
      <button type="button" class="btn" data-act="close">Cancel</button>
      <button type="submit" class="btn-primary">Save</button>
    </div>
  </form>`;

  const form = $('#taskForm', sheet);
  let checklist = (t.checklist || []).map((i) => ({ ...i }));
  const drawChecklist = () => {
    const done = checklist.filter((i) => i.done).length;
    $('#ckCount', sheet).textContent = checklist.length ? `${done} of ${checklist.length}` : '';
    $('#ckBar', sheet).hidden = !checklist.length;
    $('#ckBar i', sheet).style.width = `${checklist.length ? (done / checklist.length) * 100 : 0}%`;
    $('#checklist', sheet).innerHTML = checklist.map((i, n) => `<div class="ck-item ${i.done ? 'done' : ''}">
      <button type="button" class="ick ${i.done ? 'done' : ''}" data-n="${n}" aria-pressed="${i.done}"><span class="box"></span><span class="ick-text">${esc(i.text)}</span></button>
      <button type="button" class="ck-remove" data-remove-item="${n}" aria-label="Remove ${esc(i.text)}">&times;</button></div>`).join('');
  };
  drawChecklist();
  const addItem = () => {
    const input = $('#newItem', sheet);
    for (const text of input.value.split(',').map((x) => x.trim()).filter(Boolean)) checklist.push({ text, done: false });
    input.value = '';
    drawChecklist();
    input.focus();
  };
  sheet.querySelector('[data-act="add-item"]').addEventListener('click', addItem);
  $('#newItem', sheet).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
  $('#checklist', sheet).addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-item]');
    if (rm) { checklist.splice(+rm.dataset.removeItem, 1); drawChecklist(); return; }
    const tick = e.target.closest('.ick[data-n]');
    if (tick) { checklist[+tick.dataset.n].done = !checklist[+tick.dataset.n].done; drawChecklist(); }
  });
  let tag = t.tag;
  let status = t.status;
  const press = (group, attr, value) => {
    for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  };

  $('#tagPick', sheet).addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (b) { tag = b.dataset.tag; press($('#tagPick', sheet), 'tag', tag); }
  });
  $('#statusPick', sheet).addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) { status = b.dataset.status; press($('#statusPick', sheet), 'status', status); }
  });
  $('#datePick', sheet).addEventListener('click', (e) => {
    const b = e.target.closest('[data-date]');
    if (b) { form.date.value = b.dataset.date; press($('#datePick', sheet), 'date', b.dataset.date); }
  });
  form.date.addEventListener('change', () => press($('#datePick', sheet), 'date', form.date.value));
  form.url.addEventListener('change', () => {
    const g = guessFromUrl(form.url.value.trim());
    if (g.tag && tag === 'todo') { tag = g.tag; press($('#tagPick', sheet), 'tag', tag); }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const date = form.date.value || null;
    // Choosing a new day by hand resets the slip counter.
    const carried = date && date > todayStr() ? 0 : date === shownDate ? t.carried : carriedDays(t);
    updateTask(id, {
      title: form.title.value.trim() || t.title, tag, status, checklist,
      // Leave an overdue task's stored date alone unless the user actually picked a different day.
      ...(date === shownDate ? {} : { date, carried }),
      url: form.url.value.trim() || null, notes: form.notes.value.trim() || null,
    });
    sheet.close();
  });
  sheet.querySelector('[data-act="close"]').addEventListener('click', () => sheet.close());
  sheet.querySelector('[data-act="delete"]').addEventListener('click', () => {
    updateTask(id, { deleted: 1 });
    sheet.close();
    toast('Task deleted', 'Undo', () => updateTask(id, { deleted: 0 }));
  });
  sheet.showModal();
}

function openSettings() {
  const token = getToken();
  sheet.innerHTML = `<form method="dialog" id="settingsForm">
    <h2>Settings</h2>
    <label class="field"><span>Access token</span>
      <input name="token" type="password" autocomplete="off" value="${esc(token)}" placeholder="Paste the token from your setup">
    </label>
    <p class="hint" id="syncInfo">${token ? (lastSync ? `Last synced ${new Date(lastSync).toLocaleString()}.` : 'Not synced yet.') : 'Without a token, tasks stay on this device only.'}</p>
    <hr>
    <div class="field"><span>Calendars</span>
      <div id="calList" class="cal-list">${token ? '<p class="hint">Loading...</p>' : '<p class="hint">Add your token first.</p>'}</div>
      ${token ? '<div class="row"><button type="button" class="btn" data-act="add-cal">+ Add calendar</button></div>' : ''}
    </div>
    <div class="hint">
      <strong>Outlook:</strong> outlook.office.com, Settings, Calendar, Shared calendars, Publish a calendar, copy the ICS link.<br>
      <strong>Apple Calendar:</strong> Mac Calendar app, right-click an iCloud calendar, Share Calendar, tick Public Calendar, copy the link. On iPhone: Calendar, Calendars, tap the i, turn on Public Calendar, Share Link.
    </div>
    <hr>
    <div class="field"><span>Your tags</span>
      <div class="chips" id="customTagList">${customTags.map((tag) => `<button type="button" class="chip" style="--c:${tagInfo(tag).color}" data-remove="${esc(tag)}" title="Remove">${esc(tagInfo(tag).label)} &times;</button>`).join('') || '<span class="hint">Built-in: Apply, LinkedIn DM, LinkedIn post, Buy, Book, To do.</span>'}</div>
      <div class="row"><input name="newTag" placeholder="New tag, e.g. call" style="flex:1"><button type="button" class="btn" data-act="add-tag">Add tag</button></div>
    </div>
    <hr>
    <div class="hint">
      <strong>Install as an app</strong>
      <ol>
        <li>iPhone: open this page in Safari, tap Share, then Add to Home Screen.</li>
        <li>Mac: in Safari choose File, Add to Dock.</li>
      </ol>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-act="export" style="margin-right:auto">Export backup</button>
      <button type="button" class="btn" data-act="close">Close</button>
      <button type="submit" class="btn-primary">Save</button>
    </div>
  </form>`;

  const form = $('#settingsForm', sheet);
  // Only write calendars back if we managed to load them, so an offline save never wipes the list.
  let calendarsLoaded = false;
  const calRow = (c = { name: '', url: '' }) => `<div class="cal-row">
      <input class="cal-name" placeholder="Name" value="${esc(c.name)}">
      <input class="cal-url" type="url" inputmode="url" placeholder="https:// or webcal:// link" value="${esc(c.url)}">
      <button type="button" class="ck-remove" data-remove-cal aria-label="Remove calendar">&times;</button>
    </div>`;
  const calList = $('#calList', sheet);
  if (token) {
    api('/api/settings').then((s) => {
      calendarsLoaded = true;
      calList.innerHTML = (s.calendars.length ? s.calendars : [{ name: 'Outlook', url: '' }]).map(calRow).join('');
    }).catch(() => { calList.innerHTML = '<p class="hint">Connect to the internet to edit calendars.</p>'; });
    sheet.querySelector('[data-act="add-cal"]').addEventListener('click', () => {
      if (!calendarsLoaded) return;
      calList.insertAdjacentHTML('beforeend', calRow({ name: calList.children.length ? 'Apple' : 'Outlook', url: '' }));
    });
    calList.addEventListener('click', (e) => { if (e.target.closest('[data-remove-cal]')) e.target.closest('.cal-row').remove(); });
  }

  sheet.querySelector('[data-act="close"]').addEventListener('click', () => sheet.close());
  sheet.querySelector('[data-act="add-tag"]').addEventListener('click', () => {
    const tag = form.newTag.value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (tag && !customTags.includes(tag) && !DEFAULT_TAGS[tag]) {
      customTags.push(tag);
      store(KEYS.tags, customTags);
      render();
      openSettings();
    }
  });
  $('#customTagList', sheet).addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    customTags = customTags.filter((t) => t !== b.dataset.remove);
    store(KEYS.tags, customTags);
    render();
    openSettings();
  });
  sheet.querySelector('[data-act="export"]').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(liveTasks(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `today-board-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newToken = form.token.value.trim();
    const tokenChanged = newToken !== token;
    store(KEYS.token, newToken);
    if (tokenChanged) {
      cursor = 0;
      store(KEYS.cursor, 0);
      // Push everything this device has so a fresh connection loses nothing.
      for (const t of Object.values(tasks)) t._dirty = true;
      saveTasks();
    }
    try {
      if (newToken) {
        await api('/api/ping');
        if (calendarsLoaded && !tokenChanged) {
          const calendars = [...calList.querySelectorAll('.cal-row')].map((r) => ({
            name: r.querySelector('.cal-name').value.trim(), url: r.querySelector('.cal-url').value.trim(),
          })).filter((c) => c.url);
          await api('/api/settings', { method: 'PUT', body: JSON.stringify({ calendars }) });
          await refreshCalendar(true);
        }
        toast('Saved and connected');
      }
      sheet.close();
      sync();
    } catch (err) {
      $('#syncInfo', sheet).textContent = err.auth ? 'That token was not accepted.' : `Could not save: ${err.message}`;
      if (err.auth) setSyncState('auth');
    }
  });
  sheet.showModal();
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(message, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = esc(message) + (actionLabel ? ` <button type="button" class="mini-btn" style="margin-left:8px;pointer-events:auto">${esc(actionLabel)}</button>` : '');
  el.classList.add('show');
  if (actionLabel) {
    el.querySelector('button').addEventListener('click', () => { action(); el.classList.remove('show'); }, { once: true });
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 5000 : 2600);
}

/* ---------- Events ---------- */

$('#quickAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#quickInput');
  const text = input.value.trim();
  if (!text) return;
  const fields = parseQuick(text);
  const task = createTask(fields);
  input.value = '';
  toast(`Added to ${friendlyDate(fields.date)} · ${tagInfo(fields.tag).label}`);
  if (task.url && task.tag === 'apply') enrichJob(task.id);
});

// Swaps the guessed "Apply: Company" title for the real posting title once the server looks it up.
async function enrichJob(id) {
  const guessed = tasks[id]?.title;
  if (!getToken() || !navigator.onLine || !guessed) return;
  try {
    const job = await api(`/api/lookup?url=${encodeURIComponent(tasks[id].url)}`);
    const t = tasks[id];
    if (!t || t.deleted) return;
    const patch = { url: job.url };
    if (job.found && t.title === guessed) patch.title = job.company ? `${job.company}: ${job.title}` : job.title;
    const notes = [job.location, job.maybeClosed ? 'Posting may be closed: the job board no longer lists it.' : ''].filter(Boolean).join('. ');
    if (notes && !t.notes) patch.notes = notes;
    updateTask(id, patch);
    if (job.maybeClosed) toast('Heads up: that posting may be closed');
  } catch {
    // Offline or lookup failed: the guessed title stays.
  }
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  view = b.dataset.view;
  store(KEYS.view, view);
  render();
  if (view === 'calendar') refreshCalendar();
  if (view === 'history') refreshHistory();
});

$('#tagFilter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  tagFilter = b.dataset.filter || null;
  render();
});

$('#settingsBtn').addEventListener('click', openSettings);
$('#syncBtn').addEventListener('click', () => (getToken() ? (sync(), refreshCalendar(true)) : openSettings()));

$('#view').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.closest('[data-id]')?.dataset.id;
  switch (el.dataset.act) {
    case 'toggle': {
      const t = tasks[id];
      updateTask(id, { status: t.status === 'done' ? 'todo' : 'done', ...(t.status === 'done' ? { date: todayStr() } : {}) });
      break;
    }
    case 'edit': openTaskSheet(id); break;
    case 'ck': {
      const checklist = (tasks[id].checklist || []).map((i) => ({ ...i }));
      const item = checklist[+el.dataset.n];
      if (!item) break;
      item.done = !item.done;
      updateTask(id, { checklist });
      if (checklist.every((i) => i.done)) toast('All items ticked. Tap the circle to finish the task.');
      break;
    }
    case 'settings': openSettings(); break;
    case 'task-log': openTaskLog(el.dataset.task); break;
    case 'history-more': refreshHistory({ older: true }); break;
    case 'event-task': {
      const ev = (calendarCache?.events || []).find((x) => x.id === el.dataset.event);
      if (!ev) break;
      const g = ev.url ? guessFromUrl(ev.url) : {};
      createTask({ title: ev.title, url: ev.url || null, date: el.dataset.day, tag: g.tag && g.tag !== 'book' ? g.tag : 'todo' });
      toast(`Task added for ${friendlyDate(el.dataset.day)}`);
      break;
    }
  }
});

// Drag and drop between board columns (mouse and trackpad).
let dragId = null;
// Search only redraws the log so the input keeps focus while typing.
$('#view').addEventListener('input', (e) => {
  if (e.target.id !== 'historySearch') return;
  historyQuery = e.target.value;
  $('#historyLog').innerHTML = historyLogHtml();
});

$('#view').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  dragId = card.dataset.id;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
$('#view').addEventListener('dragend', (e) => {
  e.target.closest('.card')?.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
});
$('#view').addEventListener('dragover', (e) => {
  const col = e.target.closest('.column');
  if (!col || !dragId) return;
  e.preventDefault();
  document.querySelectorAll('.drag-over').forEach((c) => c !== col && c.classList.remove('drag-over'));
  col.classList.add('drag-over');
});
$('#view').addEventListener('drop', (e) => {
  const col = e.target.closest('.column');
  if (!col || !dragId) return;
  e.preventDefault();
  moveToColumn(dragId, col.dataset.col);
  dragId = null;
});

/* ---------- Lifecycle ---------- */

function onOpen() {
  const t = todayStr();
  const firstOpenToday = load(KEYS.lastOpen, '') !== t;
  store(KEYS.lastOpen, t);
  render();
  if (firstOpenToday) {
    const carried = liveTasks().filter((x) => isOverdue(x) && x.status !== 'doing').length;
    if (carried) toast(`${carried} unfinished task${carried > 1 ? 's' : ''} carried into today`);
  }
  sync();
  refreshCalendar();
  if (view === 'history') refreshHistory();
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onOpen(); });
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => setSyncState('offline'));
let renderedDay = todayStr();
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (todayStr() !== renderedDay) { renderedDay = todayStr(); render(); }
  sync();
}, 60 * 1000);

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
}

onOpen();
$('#banner').addEventListener('click', (e) => { if (e.target.closest('[data-act="settings"]')) openSettings(); });
