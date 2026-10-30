// Minimal iCalendar reader for Outlook's published calendar links.
// Handles timezones (including Windows zone names), all-day events,
// RRULE (DAILY/WEEKLY/MONTHLY/YEARLY), EXDATE and moved/cancelled instances.

const DAY = 86400000;
const MAX_OCCURRENCES = 20000;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'India Standard Time': 'Asia/Kolkata',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

function resolveTz(tzid, fallback) {
  if (!tzid) return fallback;
  const candidate = WINDOWS_TZ[tzid] || tzid;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return fallback;
  }
}

const formatters = new Map();
function tzOffset(tz, utcMs) {
  let dtf = formatters.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, dtf);
  }
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// "Wall" times are naive local clock readings stored as if they were UTC.
function wallToUtc(wall, tz) {
  if (tz === 'UTC') return wall;
  const guess = wall - tzOffset(tz, wall);
  return wall - tzOffset(tz, guess);
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseProp(line) {
  let inQuote = false;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ':' && !inQuote) break;
  }
  const [name, ...rawParams] = line.slice(0, i).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

function parseEvents(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let current = null;
  let nested = 0;
  for (const line of lines) {
    if (!line) continue;
    const prop = parseProp(line);
    if (prop.name === 'BEGIN') {
      if (prop.value === 'VEVENT') current = {};
      else if (current) nested++;
    } else if (prop.name === 'END') {
      if (prop.value === 'VEVENT' && current) { events.push(current); current = null; }
      else if (current && nested) nested--;
    } else if (current && !nested) {
      (current[prop.name] ||= []).push(prop);
    }
  }
  return events;
}

function parseDateValue(value, params, fallbackTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[4] || params.VALUE === 'DATE') return { wall, allDay: true, tz: fallbackTz };
  return { wall, allDay: false, tz: m[7] ? 'UTC' : resolveTz(params.TZID, fallbackTz) };
}

function parseDateProp(prop, fallbackTz) {
  return prop ? parseDateValue(prop.value, prop.params, fallbackTz) : null;
}

const toUtc = (d) => wallToUtc(d.wall, d.tz);
// Instances are matched by their original start: UTC for timed events, the calendar date for all-day ones.
const instanceKey = (d) => (d.allDay ? `d${d.wall}` : `t${toUtc(d)}`);

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || '');
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRule(value) {
  const rule = Object.fromEntries(value.split(';').map((kv) => kv.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k.toUpperCase(), v]));
  rule.interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
  rule.count = parseInt(rule.COUNT, 10) || null;
  rule.byday = rule.BYDAY
    ? rule.BYDAY.split(',').map((s) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim())).filter(Boolean).map((m) => ({ n: m[1] ? +m[1] : 0, wd: WEEKDAYS[m[2]] }))
    : null;
  rule.bymonthday = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter(Boolean) : null;
  return rule;
}

function monthDays(year, month, rule, defaultDay) {
  const first = new Date(Date.UTC(year, month, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let days;
  if (rule.byday) {
    days = [];
    for (const { n, wd } of rule.byday) {
      const matches = [];
      for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) matches.push(d);
      if (n === 0) days.push(...matches);
      else if (n > 0 && matches[n - 1]) days.push(matches[n - 1]);
      else if (n < 0 && matches[matches.length + n]) days.push(matches[matches.length + n]);
    }
  } else if (rule.bymonthday) {
    days = rule.bymonthday.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
  } else {
    days = defaultDay <= dim ? [defaultDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b).map((d) => Date.UTC(y, m, d));
}

// Yields wall-clock start times in order, beginning with DTSTART.
function* occurrences(startWall, rule) {
  const timeOfDay = ((startWall % DAY) + DAY) % DAY;
  const startDay = startWall - timeOfDay;
  const sd = new Date(startWall);

  if (rule.FREQ === 'DAILY') {
    const allowed = rule.byday ? new Set(rule.byday.map((b) => b.wd)) : null;
    for (let k = 0; k < MAX_OCCURRENCES; k++) {
      const t = startWall + k * rule.interval * DAY;
      if (!allowed || allowed.has(new Date(t).getUTCDay())) yield t;
    }
  } else if (rule.FREQ === 'WEEKLY') {
    const wkst = WEEKDAYS[rule.WKST] ?? 1;
    const days = rule.byday ? rule.byday.map((b) => b.wd) : [sd.getUTCDay()];
    const offsets = [...new Set(days.map((d) => (d - wkst + 7) % 7))].sort((a, b) => a - b);
    const weekStart = startDay - ((sd.getUTCDay() - wkst + 7) % 7) * DAY;
    for (let w = 0; w < MAX_OCCURRENCES; w += rule.interval) {
      for (const off of offsets) {
        const t = weekStart + (w * 7 + off) * DAY + timeOfDay;
        if (t >= startWall) yield t;
      }
    }
  } else if (rule.FREQ === 'MONTHLY') {
    for (let k = 0; k < MAX_OCCURRENCES / 10; k += rule.interval) {
      for (const day of monthDays(sd.getUTCFullYear(), sd.getUTCMonth() + k, rule, sd.getUTCDate())) {
        const t = day + timeOfDay;
        if (t >= startWall) yield t;
      }
    }
  } else if (rule.FREQ === 'YEARLY') {
    for (let k = 0; k < 500; k += rule.interval) {
      const t = Date.UTC(sd.getUTCFullYear() + k, sd.getUTCMonth(), sd.getUTCDate()) + timeOfDay;
      if (new Date(t).getUTCDate() === sd.getUTCDate()) yield t;
    }
  } else {
    yield startWall;
  }
}

const ymd = (wall) => new Date(wall).toISOString().slice(0, 10);

function firstUrl(...texts) {
  for (const t of texts) {
    const m = /https?:\/\/[^\s<>"')\]]+/i.exec(t || '');
    if (m) return m[0];
  }
  return null;
}

export function expandCalendar(text, { from, to, tz }) {
  const raw = parseEvents(text);
  const first = (ev, name) => ev[name]?.[0];
  const overrides = new Set();
  for (const ev of raw) {
    const rid = parseDateProp(first(ev, 'RECURRENCE-ID'), tz);
    const uid = first(ev, 'UID')?.value;
    if (rid && uid) overrides.add(`${uid}|${instanceKey(rid)}`);
  }

  const out = [];
  for (const ev of raw) {
    if (first(ev, 'STATUS')?.value.toUpperCase() === 'CANCELLED') continue;
    const start = parseDateProp(first(ev, 'DTSTART'), tz);
    if (!start) continue;
    const uid = first(ev, 'UID')?.value || '';
    const end = parseDateProp(first(ev, 'DTEND'), tz);
    let duration = end
      ? (start.allDay ? end.wall - start.wall : toUtc(end) - toUtc(start))
      : parseDuration(first(ev, 'DURATION')?.value) ?? (start.allDay ? DAY : 0);
    if (duration < 0) duration = 0;

    const summary = unescapeText(first(ev, 'SUMMARY')?.value || '(no title)');
    const location = unescapeText(first(ev, 'LOCATION')?.value || '');
    const description = unescapeText(first(ev, 'DESCRIPTION')?.value || '');
    const base = {
      title: summary,
      location: location || null,
      url: first(ev, 'URL')?.value || firstUrl(location, description),
      allDay: start.allDay,
    };

    const emit = (wall) => {
      if (start.allDay) {
        const s = wallToUtc(wall, tz);
        const e = wallToUtc(wall + duration, tz);
        if (s < to && e > from) out.push({ ...base, id: `${uid}|${wall}`, start: ymd(wall), end: ymd(wall + Math.max(duration, DAY)) });
      } else {
        const s = wallToUtc(wall, start.tz);
        if (s < to && s + duration > from) out.push({ ...base, id: `${uid}|${s}`, start: new Date(s).toISOString(), end: new Date(s + duration).toISOString() });
      }
    };

    const rruleProp = first(ev, 'RRULE');
    if (!rruleProp || first(ev, 'RECURRENCE-ID')) { emit(start.wall); continue; }

    const rule = parseRule(rruleProp.value);
    const until = rule.UNTIL ? parseDateValue(rule.UNTIL, {}, start.tz) : null;
    const untilUtc = until ? (until.allDay ? wallToUtc(until.wall + DAY - 1, start.tz) : toUtc(until)) : Infinity;
    const excluded = new Set();
    for (const p of ev.EXDATE || []) {
      for (const v of p.value.split(',')) {
        const d = parseDateValue(v, p.params, tz);
        if (d) excluded.add(instanceKey(d));
      }
    }

    let n = 0;
    for (const wall of occurrences(start.wall, rule)) {
      n++;
      if (rule.count && n > rule.count) break;
      const inst = { wall, allDay: start.allDay, tz: start.tz };
      const sUtc = toUtc(inst);
      if (sUtc > untilUtc || sUtc >= to) break;
      const key = instanceKey(inst);
      if (excluded.has(key) || overrides.has(`${uid}|${key}`)) continue;
      emit(wall);
    }
  }

  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
