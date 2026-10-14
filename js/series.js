// シリーズ：2 通りのまとめ方がある。
// 1) 名前のあるシリーズ（題名が違っても同じシリーズ。v0.13）。次の順で決める
//    ① 本人が本の詳細で付けたシリーズ名（seriesName。NO_SERIES ならまとめない）
//    ② 組み込みのシリーズ一覧（js/series-catalog.js。館シリーズ・ガリレオなど、刊行順つき）
//    ③ 国立国会図書館の書誌のシリーズ名（叢書名の 2 つ目「…文庫 ; 番号. 天久鷹央の事件カルテ」や
//       巻次「3 (密室のパラノイア)」の書名）。同じ著者の 2 作品以上に共通する名前だけ使う
// 2) 書名の終わりの巻数（「変な家2」「invert 2」「R.E.D.… ACT2」「放課後ミステリクラブ １０」）。
//    巻数のない本は、同じ書名・同じ著者の続巻があれば 1 巻目とみなす（「変な家」＋「変な家2」）。
// どちらも国立国会図書館の書誌で、本棚にない巻（と巻数のシリーズの発売予定）を補う。
import { normTitle, normName, nameParts, mainTitle, authorMatches, today } from './util.js';
import { SERIES_CATALOG } from './series-catalog.js';

// 本の seriesName がこれなら、自動でもシリーズにまとめない（本の詳細の「シリーズにしない」）
export const NO_SERIES = '-';

const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN = { Ⅰ: 1, Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5, Ⅵ: 6, Ⅶ: 7, Ⅷ: 8, Ⅸ: 9, Ⅹ: 10 };
// 巻数の手前の本体に、数字以外の文字が 2 文字以上あること（「777」などを巻数と誤らない）
const hasBody = (s) => (s.normalize('NFKC').match(/[^\d\s]/g) || []).length >= 2;

// 「2」「１０」「第3巻」「ACT2」「Vol.2」「Ⅱ」→ 数。上・下や読めない表記は 0
export function volumeNumber(raw) {
  const s = String(raw ?? '').trim();
  if (ROMAN[s]) return ROMAN[s];
  const t = s.normalize('NFKC');
  // NDL の巻次「3 (密室のパラノイア)」は巻数と書名
  const d = t.match(/^(?:第\s*)?(?:(?:vol\.?|act|no\.?|part|#)\s*)?(\d{1,3})\s*(?:巻|部)?(?:\s*\(.+\))?$/i);
  if (d) return Number(d[1]);
  const k = t.match(/^第?([一二三四五六七八九十])巻$/);
  return k ? KANJI[k[1]] : 0;
}

// 半角のローマ数字（「ACT II」「invert II」）。I・V・X の 1 文字は「ACT」などが前にあるときだけ巻数とみなす
const ASCII_ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

// 書名（と NDL の巻次）を、シリーズ名と巻数に分ける。巻数がなければ vol: 0
export function splitVolume(title, volume = '') {
  const main = mainTitle(title);
  const fromField = volumeNumber(volume);
  if (fromField) return { base: main, vol: fromField };
  const roman = main.match(/^(.+?)[\s　]*([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])$/);
  if (roman && hasBody(roman[1])) return { base: roman[1].trim(), vol: ROMAN[roman[2]] };
  const t = main.normalize('NFKC');
  const ar = t.match(/^(.+?[^\s])\s+(act|vol\.?|part)?\s*(II|III|IV|VI|VII|VIII|IX|I|V|X)$/i);
  if (ar && hasBody(ar[1]) && (ar[2] || ar[3].length > 1) && ASCII_ROMAN[ar[3].toUpperCase()]) return { base: ar[1].trim(), vol: ASCII_ROMAN[ar[3].toUpperCase()] };
  // 巻数の直前は数字以外（「Another 2001」の「2001」は 4 桁なので巻数にしない）
  const m = t.match(/^(.*?[^\d\s])[\s・:\-]*(?:第\s*)?(?:(?:vol\.?|act|no\.?|part|#)\s*)?(\d{1,3})(?:\s*巻)?$/i);
  if (m && hasBody(m[1]) && Number(m[2]) > 0) return { base: m[1].replace(/[\s・:\-]+$/, '').trim(), vol: Number(m[2]) };
  // 「5分後に意外な結末 1 赤い悪夢」のように、巻数のあとに副題（「3 日」「2 人」のような数え方は除く）
  const s = t.match(/^(.*?[^\d\s])\s+(\d{1,3})\s+(?![日年月人つ分回歳度冊巻番話章個本時秒%])(\S.+)$/);
  if (s && hasBody(s[1]) && Number(s[2]) > 0) return { base: s[1].trim(), vol: Number(s[2]) };
  return { base: main, vol: 0 };
}

export const seriesKey = (base, author) => `${normTitle(base)}|${normName(author)}`;

// ---------------------------------------------------------------- 組み込みのシリーズ一覧
const CATALOG = SERIES_CATALOG.map((s) => ({
  ...s,
  authorKeys: s.authors.map(normName),
  authorParts: s.authors.map((a) => nameParts(a)),
  vols: s.titles.map((t, i) => { const names = [].concat(t); return { pos: i + 1, title: names[0], keys: names.map(normTitle) }; }),
}));
// 著者の表記ゆれ：「アガサ・クリスティー」「クリスティー」「アガサ・クリスティ」、「M・W・クレイヴン」「M.W.クレイヴン」
function catalogAuthor(entry, authorKey) {
  if (!authorKey) return false;
  return entry.authorKeys.some((k, i) => k === authorKey || (authorKey.length >= 3 && k.includes(authorKey))
    || (entry.authorParts[i].length > 0 && entry.authorParts[i].every((p) => authorKey.includes(p))));
}
// 本棚の本 → 組み込みの一覧の巻。書名が一致（副題・版の表記は除く）を優先し、なければ 3 文字以上の前方一致で一番長いもの
// （「invert 2」は「invert」ではなく「invert 2」の巻に当てる）
export function catalogMatch(book) {
  const a = normName(book.author);
  const t = normTitle(book.title);
  const m = normTitle(mainTitle(book.title));
  let best = null;
  for (const entry of CATALOG) {
    if (!catalogAuthor(entry, a)) continue;
    for (const v of entry.vols) {
      for (const k of v.keys) {
        // 一致 ＞ 末尾が一致（「天久鷹央の推理カルテ 2 ファントムの病棟」）＞ 先頭が一致（「medium 霊媒探偵城塚翡翠」）
        const score = k === t || k === m ? 1000 + k.length : k.length >= 4 && t.endsWith(k) ? 500 + k.length
          : k.length >= 3 && (t.startsWith(k) || m.startsWith(k)) ? k.length : 0;
        if (score && (!best || score > best.score)) best = { entry, vol: v, score };
      }
    }
  }
  return best;
}
const catalogByName = (name, author) => {
  const n = normTitle(name);
  const a = normName(author);
  return CATALOG.find((e) => normTitle(e.name) === n && catalogAuthor(e, a)) || null;
};

// ---------------------------------------------------------------- 国立国会図書館のシリーズ名
// 叢書名の 2 つ目以降のうち、出版社のレーベル・叢書（文庫・ノベルス・nex など）や
// 種類の表示（光文社の「長編推理小説」「文庫書下ろし」など）ではないもの
const LABEL = /文庫|新書|ノベルス|ノベルズ|ノベル$|ブックス|books?$|novels?|叢書|選書|全集|著作集|作品集|コレクション|セレクション|ライブラリ|ポケット|ミステリー?$|^ミステリー?|ホラー|ファンタジー|ジュニア|クラシック|傑作|名作|大賞|受賞|アンソロジー|コバルト|ハーレクイン|ホワイトハート|^(長編|短編|連作|本格)|小説$|書下ろし|書き下ろし|^推理|サスペンス$|ハード・?ボイルド/i;
function storyName(seg) {
  const s = String(seg ?? '').replace(/\s*;.*$/, '').replace(/^[\s.]+|[\s.]+$/g, '').trim();
  if (!s || LABEL.test(s.normalize('NFKC'))) return '';
  return (s.match(/[぀-ヿ㐀-鿿]/g) || []).length >= 3 ? s : '';
}
// 読みがな「生命(いのち)の略奪者」は表示しない
const plain = (s) => String(s ?? '').replace(/[(（][\u3040-\u30ffー・\s]+[)）]/g, '').trim();
// 1 作品のシリーズ名の候補と、その作品の書名（巻次「3 (密室のパラノイア)」の本は括弧の中）。
// names：叢書名に書かれたシリーズ名（これだけでシリーズを作れる）
// extra：巻次「3 (…)」の書名・副題「… : 天久鷹央の事件カルテ」（叢書名で作ったシリーズに足すだけ。
//        これだけで作ると「京都寺町三条のホームズ 2 (真贋事件簿)」のような巻数のシリーズを書名違いと取り違える）
export function workStory(w) {
  const names = new Set();
  const extra = new Set();
  let volTitle = '';
  for (const e of w.editions || []) {
    for (const seg of String(e.series || '').split(/\.\s+/).slice(1)) { const n = storyName(seg); if (n) names.add(n); }
    const vm = String(e.volume || '').normalize('NFKC').match(/^\s*\d{1,3}\s*\((.+)\)\s*$/);
    if (vm) { const n = storyName(mainTitle(e.title)); if (n) { extra.add(n); volTitle ||= vm[1].trim(); } }
    const sub = String(e.title || '').split(/\s:\s/)[1];
    if (sub) { const n = storyName(sub); if (n) extra.add(n); }
  }
  return { names: [...names], extra: [...extra], title: plain(volTitle || w.main || mainTitle(w.title)) };
}
// 著者の作品一覧から、題名の違う 2 作品以上をまとめるシリーズ名を見つける
export function storySeries(works) {
  const byName = new Map();
  const all = [];
  for (const w of works || []) {
    if (w.isComic || w.isAnthology) continue;
    const story = workStory(w);
    all.push([w, story]);
    for (const n of story.names) {
      const k = normTitle(n);
      if (!byName.has(k)) byName.set(k, { name: n, works: [] });
      byName.get(k).works.push({ work: w, title: story.title });
    }
  }
  // 巻次・副題のシリーズ名は、叢書名で見つかったシリーズにだけ足す（同じ作品は 1 回）
  for (const [w, story] of all) {
    for (const n of story.extra) {
      const g = byName.get(normTitle(n));
      if (g && !g.works.some((x) => x.work === w)) g.works.push({ work: w, title: story.title });
    }
  }
  return [...byName.values()].filter((g) => new Set(g.works.map((x) => normTitle(x.title))).size >= 2);
}
// 本の書名がシリーズの巻の書名に当たるか。一致 3 点 ＞ 末尾が一致 2 点（「天久鷹央の推理カルテII ファントムの病棟」）
// ＞ 先頭が一致 1 点（「スフィアの死天使 天久鷹央の事件カルテ」）。部分の一致は 4 文字以上
function titleScore(book, k) {
  const t = normTitle(book.title);
  const m = normTitle(mainTitle(book.title));
  if (!k) return 0;
  if (k === t || k === m) return 3;
  if (k.length >= 4 && t.endsWith(k)) return 2;
  if (k.length >= 4 && (t.startsWith(k) || m.startsWith(k))) return 1;
  return 0;
}
const bookStory = (book, stories) => {
  let best = null;
  for (const g of stories) for (const x of g.works) {
    const score = titleScore(book, normTitle(x.title));
    if (score && (!best || score > best.score)) best = { g, score };
  }
  return best?.g || null;
};

// 端末に覚えておく分：著者の作品一覧のうち、シリーズの巻に当たる作品だけを、必要な項目だけで
export function seriesWorksOf(works) {
  const keep = new Set();
  for (const g of storySeries(works)) g.works.forEach((x) => keep.add(x.work));
  for (const w of works || []) {
    if (!w.isComic && CATALOG.some((e) => e.vols.some((v) => v.keys.some((k) => w.keys?.includes(k))))) keep.add(w);
  }
  return (works || []).filter((w) => keep.has(w)).map((w) => ({
    key: w.key, title: w.title, main: w.main, volume: w.volume || '', keys: w.keys || [], isbns: (w.isbns || []).filter(Boolean), ndc: w.ndc || '', creators: w.creators || [],
    authorLabel: w.authorLabel || '', firstYear: w.firstYear || 0, lastMonth: w.lastMonth || '', isComic: !!w.isComic, isAnthology: !!w.isAnthology,
    latest: w.latest ? { isbn: w.latest.isbn || '', publisher: w.latest.publisher || '', link: w.latest.link || '', publishedAt: w.latest.publishedAt || '', issued: w.latest.issued || '', format: w.latest.format || '' } : null,
    editions: (w.editions || []).map((e) => ({ title: e.title || '', volume: e.volume || '', series: e.series || '', isbn: e.isbn || '', month: e.month || '', year: e.year || 0, publishedAt: e.publishedAt || '' })),
  }));
}

// ---------------------------------------------------------------- 本棚のシリーズ
// stories：著者の比較キー（normName）→ storySeries の結果（国会図書館で確かめた分。まだなら空）
export function shelfSeries(books, { stories = new Map() } = {}) {
  const groups = new Map();
  const claimed = new Set();
  const named = (name, book, extra) => {
    const key = `n:${normTitle(name)}|${normName(extra.catalog ? extra.catalog.authors[0] : book.author)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, base: name, author: book.author, named: true, catalog: null, story: null, manual: false, members: [], owned: new Map() });
    g.catalog ||= extra.catalog || null;
    g.story ||= extra.story || null;
    return g;
  };
  for (const b of books) {
    if (!b.author) continue;
    if (b.seriesName === NO_SERIES) { claimed.add(b.id); continue; }
    const list = stories.get(normName(b.author)) || [];
    let g = null;
    let pos = 0;
    if (b.seriesName) {
      const catalog = catalogByName(b.seriesName, b.author);
      const story = list.find((s) => normTitle(s.name) === normTitle(b.seriesName)) || null;
      g = named(catalog ? catalog.name : b.seriesName.trim(), b, { catalog, story });
      g.manual = true;
      const hit = catalog && catalogMatch(b);
      if (hit?.entry === catalog) pos = hit.vol.pos;
    } else {
      const hit = catalogMatch(b);
      if (hit) { g = named(hit.entry.name, b, { catalog: hit.entry }); pos = hit.vol.pos; } else {
        const story = bookStory(b, list);
        if (story) g = named(story.name, b, { story });
      }
    }
    if (!g) continue;
    g.members.push({ book: b, pos });
    claimed.add(b.id);
  }
  // 巻数のシリーズ（名前のあるシリーズに入った本は除く）
  const rest = books.filter((b) => !claimed.has(b.id));
  for (const b of rest) {
    const { base, vol } = splitVolume(b.title);
    if (!vol || !b.author) continue;
    const key = seriesKey(base, b.author);
    if (!groups.has(key)) groups.set(key, { key, base, author: b.author, owned: new Map() });
    const owned = groups.get(key).owned;
    if (!owned.has(vol) || b.status === 'done') owned.set(vol, b); // 同じ巻が 2 冊あれば読了の方
  }
  for (const b of rest) {
    if (splitVolume(b.title).vol) continue;
    const g = groups.get(seriesKey(mainTitle(b.title), b.author));
    if (g && !g.named && !g.owned.has(1)) g.owned.set(1, b);
  }
  // 本人が巻数のシリーズと同じ名前を付けた本（例：「変な絵」を「変な家」に）は、そのシリーズに合わせる
  for (const [key, g] of [...groups]) {
    const n = groups.get(`n:${key}`);
    if (g.named || !n) continue;
    for (const [, b] of [...g.owned].sort((x, y) => x[0] - y[0])) n.members.push({ book: b, pos: 0 });
    groups.delete(key);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- 巻の情報
// 作品の最初に出た月（月まで分かる版を優先。年しか分からなければ最も古い年）・発売日・表紙の ISBN
function volInfo(w) {
  if (!w) return { month: '', publishedAt: '', isbn: '', publisher: '', link: '', ndc: '', coverIsbns: [], work: null, upcoming: false };
  const thisMonth = today().slice(0, 7);
  const editions = (w.editions || []).filter((e) => e.month || e.year);
  const months = editions.map((e) => e.month).filter(Boolean).sort();
  const years = editions.map((e) => e.year).filter(Boolean).sort();
  const first = months[0] && (!years[0] || months[0].slice(0, 4) <= String(years[0])) ? months[0] : String(years[0] || w.lastMonth || '');
  const day = editions.map((e) => e.publishedAt || '').filter((d) => d.length === 10).sort()[0] || '';
  return {
    month: first, publishedAt: day,
    isbn: w.latest?.isbn || '', publisher: w.latest?.publisher || '', link: w.latest?.link || '', ndc: w.ndc || '',
    coverIsbns: [...editions].reverse().map((e) => e.isbn).filter(Boolean), work: w,
    upcoming: day ? day > today() : first > thisMonth,
  };
}

// NDL の作品一覧から、巻数のシリーズの巻を拾う。巻数のない同名の本は 1 巻目
export function seriesVolumesFromWorks(series, works) {
  const vols = new Map();
  const base = normTitle(series.base);
  for (const w of works) {
    if (w.isComic) continue;
    if (series.author && w.creators?.length && !w.creators.some((c) => authorMatches(c, series.author))) continue;
    const split = splitVolume(w.main || w.title, w.volume);
    if (normTitle(split.base) !== base) continue;
    const vol = split.vol || 1;
    const info = { ...volInfo(w), vol, title: plain((w.main || w.title) + (w.volume ? ` ${w.volume}` : '')) };
    const prev = vols.get(vol);
    if (!prev || (info.month && (!prev.month || info.month < prev.month))) vols.set(vol, info);
  }
  return vols;
}

// 名前のあるシリーズの巻：組み込みの一覧の順 → それ以外（国会図書館・本人の指定）は最初に出た月の順
// works：その著者の作品一覧（まだなら null。組み込みの一覧と本棚の本だけで数える）
function describeNamed(series, works) {
  const items = [];
  const has = (k) => items.find((it) => it.keys.has(k));
  if (series.catalog) {
    for (const cv of series.catalog.vols) {
      const w = works?.find((x) => !x.isComic && cv.keys.some((k) => x.keys?.includes(k)));
      items.push({ title: cv.title, keys: new Set(cv.keys), info: volInfo(w), pos: cv.pos, book: null });
    }
  }
  if (series.story && works) {
    for (const x of series.story.works) {
      const k = normTitle(x.title);
      const info = volInfo(x.work);
      const same = has(k);
      if (!same) items.push({ title: x.title, keys: new Set([k]), info, pos: 0, book: null });
      else if (info.month && (!same.info.month || info.month < same.info.month)) same.info = { ...info, coverIsbns: [...new Set([...info.coverIsbns, ...same.info.coverIsbns])] };
    }
  }
  for (const { book, pos } of series.members) {
    const t = normTitle(book.title);
    const m = normTitle(mainTitle(book.title));
    let it = (pos && items.find((i) => i.pos === pos)) || has(t) || has(m);
    if (!it) { // 書名の書き方が違う巻（副題つき・シリーズ名つき）は、いちばんよく当たる巻に
      let best = 0;
      for (const i of items) for (const k of i.keys) { const sc = titleScore(book, k); if (sc > best) { best = sc; it = i; } }
    }
    if (!it) {
      items.push(it = { title: mainTitle(book.title), keys: new Set([t, m]), pos: 0, book: null,
        info: { ...volInfo(null), month: (book.publishedAt || '').slice(0, 7) || String(book.year || '') } });
    }
    if (!it.book || (book.status === 'done' && it.book.status !== 'done')) it.book = book; // 同じ巻が 2 冊あれば読了の方
  }
  const fixed = items.filter((i) => i.pos).sort((a, b) => a.pos - b.pos);
  const rest = items.filter((i) => !i.pos)
    .sort((a, b) => (a.info.month || '9999').localeCompare(b.info.month || '9999') || a.title.localeCompare(b.title, 'ja'));
  return [...fixed, ...rest].map((it, i) => ({ ...it.info, vol: i + 1, title: it.title, book: it.book }));
}

// 本棚の巻と NDL の巻を合わせて、読んだ数・次に読む巻・発売予定の巻を出す
// fetched：巻数のシリーズは seriesVolumesFromWorks の結果、名前のあるシリーズは著者の作品一覧
export function describeSeries(series, fetched) {
  let vols;
  if (series.named) vols = describeNamed(series, fetched || null);
  else {
    const all = new Map();
    for (const [vol, info] of fetched || []) all.set(vol, { ...info, book: null });
    for (const [vol, book] of series.owned) {
      const known = all.get(vol);
      all.set(vol, { ...(known || { vol, title: book.title, month: book.publishedAt?.slice(0, 7) || '', upcoming: false, coverIsbns: [] }), book });
    }
    vols = [...all.values()].sort((a, b) => a.vol - b.vol);
  }
  const done = vols.filter((v) => v.book?.status === 'done').length;
  const next = vols.find((v) => v.book?.status !== 'done');
  const coming = vols.filter((v) => v.upcoming && !v.book);
  return { ...series, vols, done, total: vols.length, next, coming, maxVol: vols.length ? vols[vols.length - 1].vol : 0, checked: !!fetched };
}

// 一覧に出すシリーズ：知っている巻が 2 冊以上。巻数のシリーズは、国会図書館で確かめる前は 2 巻目以降を持っていれば仮に出す
// （確かめても 1 冊しかなければ出さない。例：別々の著者の短編集の「2」）。本人がまとめたシリーズは 1 冊でも出す
export const isRealSeries = (d) => (d.named ? d.total >= 2 || (d.manual && d.total >= 1)
  : d.total >= 2 || (!d.checked && [...d.owned.keys()].some((v) => v >= 2)));
