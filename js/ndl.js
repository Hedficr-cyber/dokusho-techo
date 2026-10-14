// 国立国会図書館サーチ OpenSearch API の呼び出し。
// 同時アクセスに厳しいので 1 件ずつ間隔をあけて呼び、結果は 7 日間この端末に保存して使い回す。
import { publicationDate } from './book-details.js';
import {
  normTitle, normName, nameParts, mainTitle, authorMatches, cleanCreator, respAuthor, year,
  formatFromExtent, formatFromSeries, pubMonth, isPrintRecord,
} from './util.js';

const BASE = 'https://ndlsearch.ndl.go.jp/api/opensearch';
const GAP_MS = 1200;
const TTL_MS = 7 * 24 * 3600 * 1000;
// v0.9 で刊行月（「2023.12」）の読み取りを直したので、以前の保存分（ndl:）は使わずに消す
const CACHE_PREFIX = 'ndl2:';
const CACHE_MAX = 150;
try { Object.keys(localStorage).filter((k) => k.startsWith('ndl:')).forEach((k) => localStorage.removeItem(k)); } catch { /* 使えなければ何もしない */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
const jobs=[];let draining=false;
function schedule(task,priority=2) {
  const result=new Promise((resolve,reject)=>jobs.push({task,priority,resolve,reject}));
  drain();return result;
}
async function drain() {
  if(draining)return;draining=true;
  while(jobs.length) {
    const wait=last+GAP_MS-Date.now();if(wait>0)await sleep(wait);
    jobs.sort((a,b)=>b.priority-a.priority);
    const job=jobs.shift();
    try {job.resolve(await job.task());}catch(e){job.reject(e);}finally{last=Date.now();}
  }
  draining=false;
}

function cacheGet(url, ttl) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_PREFIX + url) || 'null');
    if (hit && Date.now() - hit.t < ttl) return hit.items;
  } catch { /* 壊れたキャッシュは無視 */ }
  return null;
}

function cacheSet(url, items) {
  const write = () => localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: Date.now(), items }));
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length >= CACHE_MAX) {
      keys.map((k) => [k, JSON.parse(localStorage.getItem(k) || '{"t":0}').t])
        .sort((a, b) => a[1] - b[1]).slice(0, 30).forEach(([k]) => localStorage.removeItem(k));
    }
    write();
  } catch { /* 容量不足ならキャッシュしない */ }
}

const text = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
const texts = (el, tag) => [...el.getElementsByTagName(tag)].map((n) => n.textContent.trim());

function parse(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('rss').length) throw new Error('書誌データを読み取れませんでした。もう一度試してください。');
  const out = [];
  for (const it of doc.getElementsByTagName('item')) {
    const cats = texts(it, 'category');
    if (!cats.includes('図書')) continue;
    const place = text(it, 'dcndl:publicationPlace');
    if (place && place !== 'JP') continue; // 海外で出た翻訳版などは除く
    let isbn = '';
    let ndc = '';
    for (const id of it.getElementsByTagName('dc:identifier')) {
      if (id.getAttribute('xsi:type') === 'dcndl:ISBN') isbn ||= id.textContent.replace(/-/g, '').trim();
    }
    for (const s of it.getElementsByTagName('dc:subject')) {
      const t = s.getAttribute('xsi:type') || '';
      if (/dcndl:NDC(10|9|8)$/.test(t)) ndc ||= s.textContent.trim();
    }
    const extent = texts(it, 'dc:extent').join(' ');
    const series = text(it, 'dcndl:seriesTitle');
    out.push({
      title: text(it, 'dc:title') || text(it, 'title'),
      volume: text(it, 'dcndl:volume'),
      series,
      creators: texts(it, 'dc:creator'),
      resp: [...it.children].find((n) => n.tagName === 'author')?.textContent.trim() || '', // 責任表示（海外著者のカタカナ名はここだけ）
      publisher: text(it, 'dc:publisher'),
      issued: text(it, 'dcterms:issued'),
      publishedAt: publicationDate(text(it,'dc:date')) || publicationDate(text(it,'dcterms:issued')),
      year: year(text(it, 'dcterms:issued')),
      month: pubMonth(text(it, 'dc:date'), text(it, 'dcterms:issued')), // 「2026-10」。近刊は発売予定月
      format: formatFromSeries(series) || formatFromExtent(extent),
      isbn,
      ndc,
      link: text(it, 'link'),
    });
  }
  return out;
}

// dpid: null を渡すと国会図書館以外（出版社の近刊情報 JPRO など）も含めて探す
// keep: false は結果をこの端末に保存しない（呼び出し側が必要な分だけ小さく覚える。保存容量を圧迫しないため）
async function query(params, { ttl = TTL_MS, priority=2, keep=true } = {}) {
  const merged = { dpid: 'iss-ndl-opac', mediatype: 'books', ...params };
  Object.keys(merged).forEach((k) => merged[k] == null && delete merged[k]);
  const url = `${BASE}?${new URLSearchParams(merged)}`;
  const cached = cacheGet(url, ttl);
  if (cached) return cached;
  return schedule(async () => {
    let offline = false;
    for (let attempt = 0; attempt < (priority===0?2:3); attempt++) {
      // NDL は時々応答しないまま止まるので、9 秒で打ち切ってやり直す
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), (priority===0?3000:4000)+attempt*2000);
      let res;
      let body;
      try {
        res = await fetch(url, { signal: ctrl.signal });
        body = await res.text();
      } catch {
        offline = !navigator.onLine;
        if (offline) break;
        await sleep(1500);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 || body.includes('<code>429</code>')) {
        await sleep(2500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`国立国会図書館サーチがエラーを返しました（${res.status}）。少し待ってからもう一度試してください。`);
      const items = parse(body);
      if (keep) cacheSet(url, items);
      return items;
    }
    if (offline) throw new Error('インターネットにつながっていません。通信できる場所でもう一度試してください。');
    throw new Error('国立国会図書館サーチが混み合っているか、応答がありません。1分ほど待ってからもう一度試してください。');
  },priority);
}

// 版違い（単行本・文庫・新装版）を 1 作品にまとめる。漫画版と BOX セットは同名でも別物なので先に外す
const isComic = (it) => /^726/.test(it.ndc || '') || /COMICS?|コミック/i.test(it.series || '');
const isBoxSet = (it) => /box|ボックス|セット|全\d+巻/i.test(it.title);

// 上下巻・前後編は 1 作品として扱う。「2」のような巻数は続編のことが多いので別作品のまま
const SAME_WORK_VOL = /^(上|中|下|前編|後編|前|後|上巻|中巻|下巻)$/;
const volKey = (v) => (SAME_WORK_VOL.test(normTitle(v)) ? '' : normTitle(v));

function groupWorks(items, { includeComics = false } = {}) {
  const map = new Map();
  for (const it of items) {
    if ((!includeComics && isComic(it)) || isBoxSet(it)) continue;
    // 副題の有無や表記ゆれで版が分かれないよう、副題を除いた書名でまとめる
    const vk = volKey(it.volume);
    const key = normTitle(mainTitle(it.title)) + '|' + vk;
    if (!key.replace('|', '')) continue;
    let w = map.get(key);
    if (!w) {
      w = { key, title: it.title, volume: vk ? it.volume : '', parts: new Set(), creators: it.creators, resp: it.resp, editions: [], ndc: it.ndc };
      map.set(key, w);
    }
    if (!vk && it.volume) w.parts.add(it.volume);
    w.editions.push(it);
    w.ndc ||= it.ndc;
  }
  const works = [...map.values()];
  for (const w of works) {
    w.editions.sort((a, b) => a.year - b.year || (a.month || '').localeCompare(b.month || ''));
    w.firstYear = w.editions[0]?.year || 0;
    w.lastMonth = w.editions.map((e) => e.month || '').sort().pop() || '';
    w.latest = [...w.editions].reverse().find((e) => e.isbn) || w.editions[w.editions.length - 1];
    w.isbns = w.editions.map((e) => e.isbn).filter(Boolean);
    w.formats = [...new Set(w.editions.map((e) => e.format).filter(Boolean))];
    w.main = mainTitle(w.title);
    w.keys = [...new Set(w.editions.flatMap((e) => [normTitle(e.title), normTitle(mainTitle(e.title))]))];
    const order = ['上', '上巻', '前編', '前', '中', '中巻', '下', '下巻', '後編', '後'];
    w.partsLabel = w.parts.size > 1 ? `（${[...w.parts].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('・')}）` : '';
    // 海外著者は dc:creator がローマ字なので、責任表示のカタカナ名を優先する
    const latin = /^[A-Za-z]/.test(w.creators[0] || '');
    w.authorLabel = (latin && respAuthor(w.resp)) || w.creators.map(cleanCreator).filter(Boolean).slice(0, 2).join('、');
    w.isLit = /^9/.test(w.ndc || '');
    w.isComic = /^726/.test(w.ndc || '');
    w.isAnthology = w.creators.length > 2;
  }
  return works;
}

export async function searchAuthor(name, { from, priority=2, keep=true } = {}) {
  const params = { creator: name, cnt: 200 };
  if (from) params.from = String(from);
  const mine = (items) => items.filter((it) => it.creators.some((c) => authorMatches(c, name))
    || (normName(name).length > 2 && normName(respAuthor(it.resp)) === normName(name)));
  let own = mine(await query(params,{priority,keep}));
  // 「ホリー・ジャクソン」のように NDL と表記順が違う名前は、いちばん長い部分（姓）で探し直す
  const longest = [...nameParts(name)].sort((a, b) => b.length - a.length)[0];
  if (!own.length && longest && longest !== normName(name)) {
    own = mine(await query({ ...params, creator: longest },{priority,keep}));
  }
  return groupWorks(own).sort((a, b) => b.firstYear - a.firstYear);
}

export async function searchIsbn(isbn) {
  const items = await query({ isbn, dpid: null, cnt: 10 });
  return groupWorks(items.filter((it) => it.isbn === isbn), { includeComics: true })[0] || null;
}

// フォロー中の著者の新刊・近刊（出版社の近刊情報も含む）。新刊チェックは 6 時間だけ結果を使い回す
export async function searchReleases(name, fromMonth) {
  const items = await query({ creator: name, from: fromMonth, cnt: 60, dpid: null }, { ttl: 6 * 3600 * 1000, priority:0 });
  const own = items.filter((it) => isPrintRecord(it) && (it.creators.some((c) => authorMatches(c, name))
    || (normName(name).length > 2 && normName(respAuthor(it.resp)) === normName(name))));
  return groupWorks(own)
    .filter((w) => w.creators.length <= 3 && w.lastMonth >= fromMonth)
    .sort((a, b) => b.lastMonth.localeCompare(a.lastMonth));
}

export async function searchTitle(title, author = '', {allSources=false, ttl=TTL_MS, cnt=40, priority=2}={}) {
  const params = { title, cnt, ...(allSources ? {dpid:null} : {}) };
  if (author) params.creator = author;
  const items = await query(params, { ttl, priority });
  const q = normTitle(title);
  const exact = (w) => (w.keys.includes(q) ? 0 : 1);
  return groupWorks(items).sort((a, b) => exact(a) - exact(b) || b.firstYear - a.firstYear);
}

// 書名・著者・出版社などすべての項目から探す。NDL は書名の五十音順で返すので、
// 書名が一致する本 → 書名に含む本 → 著者が一致する本 → その他 の順に並べ直す
export async function searchAny(q) {
  const items = await query({ any: q, cnt: 60 });
  const tq = normTitle(q);
  const nq = normName(q);
  const score = (w) => {
    if (w.keys.includes(tq)) return 0;
    if (w.keys.some((k) => k.includes(tq))) return 1;
    if (normName(w.authorLabel).includes(nq) || w.creators.some((c) => authorMatches(c, q))) return 2;
    return 3;
  };
  return groupWorks(items).sort((a, b) => score(a) - score(b) || b.firstYear - a.firstYear);
}

export async function searchNdc(ndc, from) {
  const items = await query({ ndc, from: String(from), cnt: 200 });
  return groupWorks(items).sort((a, b) => b.firstYear - a.firstYear);
}

export function ndlSearchUrl(title, author) {
  return `https://ndlsearch.ndl.go.jp/search?cs=bib&keyword=${encodeURIComponent([title, author].filter(Boolean).join(' '))}`;
}

