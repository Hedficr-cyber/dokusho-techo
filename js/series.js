// シリーズ：書名の終わりの巻数（「変な家2」「invert 2」「R.E.D.… ACT2」「放課後ミステリクラブ １０」）で本をまとめる。
// 巻数のない本は、同じ書名・同じ著者の続巻があれば 1 巻目とみなす（「変な家」＋「変な家2」）。
// 国立国会図書館の書誌で、本棚にない巻と発売予定の巻を補う。
import { normTitle, normName, mainTitle, authorMatches, today } from './util.js';

const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN = { Ⅰ: 1, Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5, Ⅵ: 6, Ⅶ: 7, Ⅷ: 8, Ⅸ: 9, Ⅹ: 10 };
// 巻数の手前の本体に、数字以外の文字が 2 文字以上あること（「777」などを巻数と誤らない）
const hasBody = (s) => (s.normalize('NFKC').match(/[^\d\s]/g) || []).length >= 2;

// 「2」「１０」「第3巻」「ACT2」「Vol.2」「Ⅱ」→ 数。上・下や読めない表記は 0
export function volumeNumber(raw) {
  const s = String(raw ?? '').trim();
  if (ROMAN[s]) return ROMAN[s];
  const t = s.normalize('NFKC');
  const d = t.match(/^(?:第\s*)?(?:(?:vol\.?|act|no\.?|part|#)\s*)?(\d{1,3})\s*(?:巻|部)?$/i);
  if (d) return Number(d[1]);
  const k = t.match(/^第?([一二三四五六七八九十])巻$/);
  return k ? KANJI[k[1]] : 0;
}

// 書名（と NDL の巻次）を、シリーズ名と巻数に分ける。巻数がなければ vol: 0
export function splitVolume(title, volume = '') {
  const main = mainTitle(title);
  const fromField = volumeNumber(volume);
  if (fromField) return { base: main, vol: fromField };
  const roman = main.match(/^(.+?)[\s　]*([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])$/);
  if (roman && hasBody(roman[1])) return { base: roman[1].trim(), vol: ROMAN[roman[2]] };
  // 巻数の直前は数字以外（「Another 2001」の「2001」は 4 桁なので巻数にしない）
  const m = main.normalize('NFKC').match(/^(.*?[^\d\s])[\s・:\-]*(?:第\s*)?(?:(?:vol\.?|act|no\.?|part|#)\s*)?(\d{1,3})(?:\s*巻)?$/i);
  if (m && hasBody(m[1]) && Number(m[2]) > 0) return { base: m[1].replace(/[\s・:\-]+$/, '').trim(), vol: Number(m[2]) };
  return { base: main, vol: 0 };
}

export const seriesKey = (base, author) => `${normTitle(base)}|${normName(author)}`;

// 本棚の本からシリーズを作る。巻数のある本が 1 冊でもあればシリーズの候補
export function shelfSeries(books) {
  const groups = new Map();
  for (const b of books) {
    const { base, vol } = splitVolume(b.title);
    if (!vol || !b.author) continue;
    const key = seriesKey(base, b.author);
    if (!groups.has(key)) groups.set(key, { key, base, author: b.author, owned: new Map() });
    const owned = groups.get(key).owned;
    if (!owned.has(vol) || b.status === 'done') owned.set(vol, b); // 同じ巻が 2 冊あれば読了の方
  }
  for (const b of books) {
    if (splitVolume(b.title).vol) continue;
    const g = groups.get(seriesKey(mainTitle(b.title), b.author));
    if (g && !g.owned.has(1)) g.owned.set(1, b);
  }
  return [...groups.values()];
}

// NDL の作品一覧から、このシリーズの巻を拾う。巻数のない同名の本は 1 巻目
export function seriesVolumesFromWorks(series, works) {
  const vols = new Map();
  const base = normTitle(series.base);
  const thisMonth = today().slice(0, 7);
  for (const w of works) {
    if (w.isComic) continue;
    if (series.author && w.creators?.length && !w.creators.some((c) => authorMatches(c, series.author))) continue;
    const split = splitVolume(w.main || w.title, w.volume);
    if (normTitle(split.base) !== base) continue;
    const vol = split.vol || 1;
    const editions = (w.editions || []).filter((e) => e.month || e.year);
    // 最初に出た月（月まで分かる版を優先。年しか分からなければ最も古い年）
    const months = editions.map((e) => e.month).filter(Boolean).sort();
    const years = editions.map((e) => e.year).filter(Boolean).sort();
    const first = months[0] && (!years[0] || months[0].slice(0, 4) <= String(years[0])) ? months[0] : String(years[0] || w.lastMonth || '');
    const day = editions.map((e) => e.publishedAt || '').filter((d) => d.length === 10).sort()[0] || '';
    const info = {
      vol, title: (w.main || w.title) + (w.volume ? ` ${w.volume}` : ''), month: first, publishedAt: day,
      isbn: w.latest?.isbn || '', publisher: w.latest?.publisher || '', link: w.latest?.link || '', ndc: w.ndc || '',
      coverIsbns: [...editions].reverse().map((e) => e.isbn).filter(Boolean), work: w,
      upcoming: day ? day > today() : first > thisMonth,
    };
    const prev = vols.get(vol);
    if (!prev || (info.month && (!prev.month || info.month < prev.month))) vols.set(vol, info);
  }
  return vols;
}

// 本棚の巻と NDL の巻を合わせて、読んだ数・次に読む巻・発売予定の巻を出す
export function describeSeries(series, fetched) {
  const all = new Map();
  for (const [vol, info] of fetched || []) all.set(vol, { ...info, book: null });
  for (const [vol, book] of series.owned) {
    const known = all.get(vol);
    all.set(vol, { ...(known || { vol, title: book.title, month: book.publishedAt?.slice(0, 7) || '', upcoming: false, coverIsbns: [] }), book });
  }
  const vols = [...all.values()].sort((a, b) => a.vol - b.vol);
  const done = vols.filter((v) => v.book?.status === 'done').length;
  const next = vols.find((v) => v.book?.status !== 'done');
  const coming = vols.filter((v) => v.upcoming && !v.book);
  return { ...series, vols, done, total: vols.length, next, coming, maxVol: vols.length ? vols[vols.length - 1].vol : 0, checked: !!fetched };
}

// 一覧に出すシリーズ：知っている巻が 2 冊以上。国会図書館で確かめる前は、2 巻目以降を持っていれば仮に出す
// （確かめても 1 冊しかなければ出さない。例：別々の著者の短編集の「2」）
export const isRealSeries = (d) => d.total >= 2 || (!d.checked && [...d.owned.keys()].some((v) => v >= 2));
