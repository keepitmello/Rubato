// A fragment of the world for Segno's own time: Roo's random-world.sh, ported.
//
// One item from outside — half the time AI news (three feeds, merged), otherwise the Hacker News
// front page or a random Wikipedia article — so a tick can look at something that is not the user
// and not Segno's own memory. A title given out stays out for seven days (when the candidates are
// fewer, at least the last three are skipped). Every failure is an empty answer, never an error:
// a fragment is a nice-to-have.
//
// This file is staged beside home.mjs into the runtime build (pi-runtime/features/companion-home),
// so './home.mjs' is the only local import it may have.
import { readFileSync } from 'node:fs';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { segnoPaths } from './home.mjs';

export const WORLD = Object.freeze({ timeoutMs: 4000, cooldownDays: 7, recentFloor: 3, wikiAttempts: 4 });
export const WORLD_FEEDS = Object.freeze({
  ai: Object.freeze([
    Object.freeze({ name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' }),
    Object.freeze({ name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/' }),
    Object.freeze({ name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' }),
  ]),
  connected: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50',
  random: 'https://en.wikipedia.org/api/rest_v1/page/random/summary',
});
// Wikimedia rate-limits anonymous clients hard (Roo measured 5/10 without a contact, 10/10 with).
const USER_AGENT = 'rubato-segno-world/1.0 (local companion runtime; contact: segno@rubato.local)';

const clean = (value, limit) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim().slice(0, limit).trim();

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(WORLD.timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function rssItems(xml, source) {
  const items = [];
  for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const field = (name) => { const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(match[0]); return found ? found[1].replace(/^<!\[CDATA\[|\]\]>$/g, '') : ''; };
    const title = clean(field('title'), 160);
    if (!title) continue;
    const detail = clean(field('description'), 260) || [source, clean(field('pubDate'), 80)].filter(Boolean).join(' — ');
    items.push({ title, detail, url: clean(field('link') || field('guid'), 400), source });
  }
  return items;
}

const layers = {
  async ai(fetchImpl) {
    const all = await Promise.all(WORLD_FEEDS.ai.map(({ name, url }) => fetchText(fetchImpl, url).then((xml) => rssItems(xml, name)).catch(() => [])));
    return all.flat();
  },
  async connected(fetchImpl) {
    const data = JSON.parse(await fetchText(fetchImpl, WORLD_FEEDS.connected));
    return (data?.hits ?? []).map((hit) => {
      const title = clean(hit.title ?? hit.story_title, 220);
      const bits = [Number.isInteger(hit.points) ? `${hit.points} points` : '', Number.isInteger(hit.num_comments) ? `${hit.num_comments} comments` : '',
        hit.author ? `by ${clean(hit.author, 80)}` : ''].filter(Boolean);
      const url = clean(hit.url ?? hit.story_url, 400) || (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : 'https://news.ycombinator.com/');
      return { title, detail: `HN front page${bits.length ? ` — ${bits.join(', ')}` : ''}`, url, source: 'Hacker News' };
    }).filter((item) => item.title);
  },
  async random(fetchImpl) {
    for (let attempt = 0; attempt < WORLD.wikiAttempts; attempt += 1) {
      try {
        const data = JSON.parse(await fetchText(fetchImpl, WORLD_FEEDS.random));
        const title = clean(data?.title, 160);
        const line = clean(data?.extract, 260);
        if (title && line) return [{ title, detail: line, url: clean(data?.content_urls?.desktop?.page ?? data?.content_urls?.mobile?.page, 300), source: 'Wikipedia' }];
      } catch {}
    }
    return [];
  },
};

const historyFile = (env) => path.join(segnoPaths(env).home, 'world-history.json');
function readHistory(env) {
  try { const value = JSON.parse(readFileSync(historyFile(env), 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; }
}
function writeHistory(env, rows) {
  const file = historyFile(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(rows) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * One fragment `{ layer, source, title, detail, url }`, or undefined when nothing could be fetched.
 * `layer` forces one (ai, connected, random); otherwise ai half the time and the other two a quarter each.
 */
export async function worldFragment({ layer, env = process.env, now = Date.now(), random = Math.random, fetchImpl = globalThis.fetch } = {}) {
  try {
    const roll = Math.floor(random() * 4);
    const chosen = layer ?? (roll <= 1 ? 'ai' : roll === 2 ? 'connected' : 'random');
    if (!Object.hasOwn(layers, chosen)) return undefined;
    const candidates = await layers[chosen](fetchImpl).catch(() => []);
    if (!candidates.length) return undefined;
    const history = readHistory(env);
    const since = now - WORLD.cooldownDays * 24 * 60 * 60_000;
    const recent = new Set(history.filter((row) => row.at >= since).map((row) => row.key));
    const lastFew = new Set(history.slice(-WORLD.recentFloor).map((row) => row.key));
    let pool = candidates.filter((item) => !recent.has(item.title));
    if (!pool.length) pool = candidates.filter((item) => !lastFew.has(item.title));
    if (!pool.length) pool = candidates;
    const item = pool[Math.floor(random() * pool.length)];
    writeHistory(env, [...history.filter((row) => row.at >= since), { key: item.title, at: now }].slice(-500));
    return { layer: chosen, ...item };
  } catch { return undefined; }
}

/** Roo's block: `세계 조각 layer=… source=…`, then 제목, 한줄 and 링크. */
export function worldText(fragment) {
  if (!fragment) return '(세계 조각 없음 — 이번엔 빈손)';
  return [`세계 조각 layer=${fragment.layer} source=${fragment.source}`, `제목: ${fragment.title}`, `한줄: ${fragment.detail}`,
    ...(fragment.url ? [`링크: ${fragment.url}`] : [])].join('\n');
}
