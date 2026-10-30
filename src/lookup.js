// Turns a pasted job link into { company, title, location, url } using each
// job board's public API, falling back to the page's own title tags.

const TRACKING = /^(utm_|gh_src$|fbclid$|gclid$|lever-|ref$|source$|src$|embed$|mode$)/i;
const COMPANY_NAMES = {
  scaleai: 'Scale AI', openai: 'OpenAI', sonyinteractiveentertainmentglobal: 'Sony Interactive',
  doordashusa: 'DoorDash', airbnb: 'Airbnb', nvidia: 'NVIDIA', take2: 'Take2',
};

const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const companyName = (slug) => (slug ? COMPANY_NAMES[slug.toLowerCase()] || titleCase(slug) : '');
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

export function cleanUrl(raw) {
  const u = new URL(raw);
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  u.pathname = u.pathname.replace(/\/application\/?$/, '');
  return u.toString();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtlByStatus: { '200-299': 3600, '300-599': 0 } } });
  return res.ok ? res.json() : null;
}

async function lever(org, id) {
  const j = await getJson(`https://api.lever.co/v0/postings/${org}/${id}`);
  return j && { company: companyName(org), title: j.text, location: j.categories?.location, canonical: j.hostedUrl };
}

async function ashby(org, id) {
  const board = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${org}`);
  const j = board?.jobs?.find((x) => x.id === id);
  return j && { company: companyName(org), title: j.title, location: j.location, canonical: j.jobUrl };
}

async function greenhouse(board, id) {
  const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
  return j && { company: j.company_name || companyName(board), title: j.title, location: j.location?.name, canonical: j.absolute_url };
}

async function workday(u) {
  // https://{tenant}.wd5.myworkdayjobs.com/{locale?}/{site}/job/{location}/{slug}
  const parts = u.pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
  const jobIdx = parts.indexOf('job');
  if (jobIdx < 1) return null;
  const tenant = u.hostname.split('.')[0];
  const j = await getJson(`https://${u.hostname}/wday/cxs/${tenant}/${parts[jobIdx - 1]}/${parts.slice(jobIdx).join('/')}`);
  const info = j?.jobPostingInfo;
  return info && { company: companyName(tenant), title: info.title, location: info.location };
}

async function smartrecruiters(company, id) {
  const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`);
  return j && { company: j.company?.name || companyName(company), title: j.name, location: j.location?.city };
}

// "Cursor · Software Engineer" or "Software Engineer | Cursor" -> "Software Engineer"
function stripCompany(title, company) {
  const esc = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '\\s*[·|\\-\u2013\u2014:]\\s*';
  const stripped = title
    .replace(new RegExp(`^${esc}${sep}`, 'i'), '')
    .replace(new RegExp(`${sep}(careers at )?${esc}( careers)?$`, 'i'), '');
  return stripped || title;
}

// Last resort: read og:title / <title> from the page itself.
async function pageTitle(url, fallbackCompany) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; TodayBoard/1.0)' }, redirect: 'follow' });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 200000);
  const meta = (name) => new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, 'i').exec(html)?.[1];
  const title = meta('og:title') || /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  if (!title) return null;
  const decoded = title.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  const company = meta('og:site_name') || companyName(fallbackCompany);
  return { company, title: stripCompany(decoded, company) };
}

export async function lookupJob(link) {
  let raw = link;
  const u = new URL(raw);
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname.split('/').filter(Boolean);
  const q = (k) => u.searchParams.get(k);
  const id36 = /^[0-9a-f-]{36}$/i;

  let job = null;
  let source = 'page';
  if (/(^|\.)lever\.co$/.test(host) && p[1]) { job = await lever(p[0], p[1]); source = 'lever'; }
  else if (/(^|\.)ashbyhq\.com$/.test(host) && id36.test(p[1] || '')) { job = await ashby(p[0], p[1]); source = 'ashby'; }
  else if (q('ashby_jid')) { job = await ashby(host.split('.').slice(-2, -1)[0], q('ashby_jid')); source = 'ashby'; }
  else if (/(^|\.)greenhouse\.io$/.test(host)) {
    const board = p[0] === 'embed' ? q('for') : p[0];
    const id = p[0] === 'embed' ? q('token') : p[2];
    if (board && id) { job = await greenhouse(board, id); source = 'greenhouse'; }
  } else if (q('gh_jid')) { job = await greenhouse(host.split('.').slice(-2, -1)[0], q('gh_jid')); source = 'greenhouse'; }
  else if (/(^|\.)myworkdayjobs\.com$/.test(host) && p.includes('job')) { job = await workday(u); source = 'workday'; }
  else if (/(^|\.)smartrecruiters\.com$/.test(host) && p[1]) { job = await smartrecruiters(p[0], p[1].split('-')[0]); source = 'smartrecruiters'; }

  // Aggregators that embed the original board and id, e.g. engradar.com/jobs/greenhouse:board:id
  const embedded = /(greenhouse|lever|ashby):([\w-]+):([\w-]+)/i.exec(decodeURIComponent(u.pathname));
  if (!job && embedded) {
    const [, kind, org, id] = embedded;
    job = kind.toLowerCase() === 'greenhouse' ? await greenhouse(org, id) : kind.toLowerCase() === 'lever' ? await lever(org, id) : await ashby(org, id);
    source = kind.toLowerCase();
    if (job?.canonical) raw = job.canonical;
  }

  // A known board that no longer lists the id usually means the posting closed.
  const maybeClosed = !job && source !== 'page';
  const siteName = /myworkdayjobs\.com$/.test(host) ? host.split('.')[0] : host.split('.').slice(-2, -1)[0];
  if (!job) { job = await pageTitle(raw, siteName); source = 'page'; }
  if (!job?.title) return { found: false, maybeClosed, url: cleanUrl(raw) };
  return { found: true, maybeClosed, source, company: clean(job.company), title: clean(job.title), location: clean(job.location) || null, url: cleanUrl(raw) };
}
