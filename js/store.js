// 本棚データの保存先。いまはこの端末のブラウザ（localStorage）に保存する。
// 後でクラウド同期にするときは、このファイルの load/save だけを差し替える。
import { uid, today, normName } from './util.js';

const KEY = 'dokusho-techo:v1';
const EMPTY = {
  version: 1, books: [], deletedSeedIds: [], seedVersion: 0, updatedAt: '',
  follows: [],      // フォロー中の作家 { name, addedAt, lastChecked }
  releases: [],     // 見つかった新刊・近刊 { key, title, author, month, publisher, isbn, link, ndc, foundAt, seen }
  dismissed: [],    // 「表示しない」にした新刊の key
  hiddenRecs: [],   // 検索タブのおすすめで「表示しない」にした作品の key
  manualReadDays: [], // 本棚の「今日読んだ」で記録した日。本ごとの記録を取り消しても残す
  readLog: {},      // 読んだ日 { 'YYYY-MM-DD': [本の id ...] }
  goals: {},        // 年間目標 { '2026': 50 }
};
let state = structuredClone(EMPTY);
const listeners = new Set();

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = prepareBackup(JSON.parse(raw));
  } catch {
    /* 読めないときは空の本棚で始める */
  }
  return state;
}

function save(type='change') {
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('保存に失敗しました', e);
    listeners.forEach((fn) => fn({ type: 'save-error' }));
    return;
  }
  listeners.forEach((fn) => fn({ type }));
}

export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const books = () => state.books;
export const get = (id) => state.books.find((b) => b.id === id);
export const snapshot = () => JSON.parse(JSON.stringify(state));

// 写真から作った初期リストを取り込む。消した本は戻さず、新しく増えた本だけ足す。
export async function mergeSeed(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return 0;
    const seed = await res.json();
    if ((seed.version || 0) <= (state.seedVersion || 0) && state.books.length) return 0;
    const have = new Set(state.books.map((b) => b.id));
    const gone = new Set(state.deletedSeedIds);
    const add = seed.books.filter((b) => !have.has(b.id) && !gone.has(b.id));
    state.books.push(...add.map((b) => ({ ...b, updatedAt: b.addedAt })));
    // 初期データの書誌の直し：replacesIsbn は以前配った誤った ISBN の一覧（空文字＝ISBN なし）。
    // 利用者が ISBN を自分で直していない本（まだ以前の ISBN のまま）にだけ新しい書誌を当てる
    const fixes = new Map(seed.books.filter((b) => 'replacesIsbn' in b).map((b) => [b.id, b]));
    for (const b of state.books) {
      const fix = fixes.get(b.id);
      if (!fix || ![].concat(fix.replacesIsbn).includes(b.isbn || '')) continue;
      for (const k of ['isbn', 'publisher', 'year', 'format', 'ndc', 'ndl']) b[k] = fix[k] ?? '';
      b.needsCheck = !!fix.needsCheck;
    }
    state.seedVersion = seed.version || 1;
    save();
    return add.length;
  } catch {
    return 0;
  }
}

export function add(fields) {
  const book = {
    id: uid(), title: '', author: '', status: 'want', priority: 2, genres: [], source: 'manual',
    note: '', photos: [], isbn: '', publisher: '', year: '', format: '', ndc: '', ndl: '',
    rating: 0, memo: '', finishedAt: '', addedAt: today(), registeredAt: new Date().toISOString(), needsCheck: false, ...fields,
  };
  if (book.status === 'done' && !book.finishedAt) book.finishedAt = today();
  book.updatedAt = today();
  state.books.unshift(book);
  save();
  return book;
}

export function update(id, patch) {
  const b = get(id);
  if (!b) return;
  if (patch.status === 'done' && b.status !== 'done' && !b.finishedAt && !('finishedAt' in patch)) {
    patch.finishedAt = today();
  }
  Object.assign(b, patch, { updatedAt: today() });
  save();
}

export function remove(id) {
  const i = state.books.findIndex((b) => b.id === id);
  if (i < 0) return;
  if (id.startsWith('seed-')) state.deletedSeedIds.push(id);
  state.books.splice(i, 1);
  save();
}

// 入力を検証してから置き換える。古いバックアップには新しい項目を補う。
export function prepareBackup(data) {
  const invalid = () => { throw new Error('読書手帖のバックアップファイルではありません'); };
  if (!data || !Array.isArray(data.books)) invalid();
  const arrayFields = ['deletedSeedIds', 'follows', 'releases', 'dismissed', 'hiddenRecs', 'manualReadDays'];
  for (const k of arrayFields) if (k in data && !Array.isArray(data[k])) invalid();
  for (const k of ['readLog', 'goals']) if (k in data && (!data[k] || typeof data[k] !== 'object' || Array.isArray(data[k]))) invalid();
  if (data.books.some((b) => !b || typeof b.id !== 'string' || typeof b.title !== 'string'
    || typeof b.author !== 'string' || !['want', 'tsundoku', 'reading', 'done'].includes(b.status)
    || (b.genres && !Array.isArray(b.genres)))) invalid();
  if (new Set(data.books.map((b) => b.id)).size !== data.books.length) invalid();
  if ((data.follows || []).some((f) => !f || typeof f.name !== 'string' || typeof f.lastChecked !== 'string')) invalid();
  if ((data.releases || []).some((r) => !r || ['key', 'title', 'author', 'month'].some((k) => typeof r[k] !== 'string'))) invalid();
  // バックアップの任意項目も型を確認。文字列の代わりにオブジェクトが来ると表示を壊す。
  const optionalStrings=(obj,keys)=>keys.every(k=>obj[k]==null || typeof obj[k]==='string');
  const optionalNumbers=(obj,keys)=>keys.every(k=>obj[k]==null || (typeof obj[k]==='number' && Number.isFinite(obj[k])));
  const stringArray=(obj,key)=>obj[key]==null || (Array.isArray(obj[key]) && obj[key].every(x=>typeof x==='string'));
  const bookStrings=['isbn','publisher','publishedAt','registeredAt','addedAt','updatedAt','finishedAt','memo','note','format','ndc','ndl','source','coverIsbn','authorReading'];
  if (data.books.some(b=>!optionalStrings(b,bookStrings) || !optionalNumbers(b,['rating','priority'])
    || !stringArray(b,'genres') || !stringArray(b,'coverIsbns')
    || (b.photos!=null && (!Array.isArray(b.photos) || b.photos.some(x=>!Number.isInteger(x)))))) invalid();
  if ((data.releases || []).some(r=>!optionalStrings(r,['isbn','publisher','link','ndc','volume','baseTitle','publishedAt','coverIsbn','coverCheckedAt']) || !stringArray(r,'coverIsbns'))) invalid();
  if ((data.follows || []).some(f=>!optionalStrings(f,['addedAt']))) invalid();
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  if (Object.entries(data.readLog || {}).some(([d, ids]) => !isDate(d) || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) invalid();
  if ((data.manualReadDays || []).some((d) => !isDate(d))) invalid();
  if (data.books.some(b=>b.year!=null && !['string','number'].includes(typeof b.year))) invalid();
  const next = { ...structuredClone(EMPTY), ...structuredClone(data) };
  // v0.2.0 の空配列は「本を指定せずに読んだ日」の印。
  if (!('manualReadDays' in data)) next.manualReadDays = Object.keys(next.readLog).filter((d) => !next.readLog[d].length);
  return next;
}

export function replaceAll(data) {
  const next = prepareBackup(data);
  state = { ...next, updatedAt: '' };
  save();
}

// ---------------------------------------------------------------- 作家のフォローと新刊
export const follows = () => state.follows;
export const isFollowing = (name) => state.follows.some((f) => normName(f.name) === normName(name));

export function follow(name) {
  if (!name || isFollowing(name)) return;
  state.follows.push({ name, addedAt: today(), lastChecked: '' });
  save();
}

export function unfollow(name) {
  state.follows = state.follows.filter((f) => normName(f.name) !== normName(name));
  state.releases = state.releases.filter((r) => normName(r.author) !== normName(name));
  save();
}

export const releases = () => state.releases;

// 新刊チェックの結果を足す。もう知っている本・「表示しない」にした本は足さない。新しく見つかった件数を返す
export function addReleases(name, items) {
  if (!isFollowing(name)) return 0;
  const have = new Set(state.releases.map((r) => r.key));
  const gone = new Set(state.dismissed);
  const fresh = items.filter((r) => !have.has(r.key) && !gone.has(r.key));
  state.releases.push(...fresh.map((r) => ({ ...r, foundAt: today(), seen: false })));
  // 前に見つけた本も、あとから ISBN が登録されたり別の版の表紙が見つかったりしたら書き足す
  for (const it of items) {
    const old = state.releases.find((r) => r.key === it.key);
    if (!old || fresh.includes(it)) continue;
    if (!old.isbn && it.isbn) old.isbn = it.isbn;
    if (it.coverLookupVersion) Object.assign(old,{coverIsbns:it.coverIsbns,coverIsbn:it.coverIsbn,coverCheckedAt:it.coverCheckedAt,coverLookupVersion:it.coverLookupVersion});
    else if (!old.coverIsbn && it.coverIsbn) old.coverIsbn = it.coverIsbn;
  }
  const f = state.follows.find((x) => normName(x.name) === normName(name));
  if (f) f.lastChecked = new Date().toISOString();
  save();
  return fresh.length;
}

// 表紙の補充だけを保存。既読状態/新刊件数/フォローの確認時刻は変えない。
export function updateReleaseCovers(key,patch) {
  const item=state.releases.find(r=>r.key===key);
  if (!item) return;
  if (!item.isbn && patch.isbn) item.isbn=patch.isbn;
  if (!item.publishedAt && patch.publishedAt) item.publishedAt=patch.publishedAt;
  Object.assign(item,{coverIsbns:patch.coverIsbns,coverIsbn:patch.coverIsbn,coverCheckedAt:patch.coverCheckedAt,coverLookupVersion:patch.coverLookupVersion});
  save('release-covers');
}

export function markReleasesSeen() {
  if (!state.releases.some((r) => !r.seen)) return;
  state.releases.forEach((r) => { r.seen = true; });
  save();
}

export function dismissRelease(key) {
  state.releases = state.releases.filter((r) => r.key !== key);
  if (!state.dismissed.includes(key)) state.dismissed.push(key);
  save();
}

// ---------------------------------------------------------------- おすすめ
export const hiddenRecs = () => state.hiddenRecs;
export function hideRec(key) {
  if (!key || state.hiddenRecs.includes(key)) return;
  state.hiddenRecs.push(key);
  save();
}

// ---------------------------------------------------------------- 読書日数と目標
export const readLog = () => state.readLog;

export function setReadDay(date, on, bookId = '') {
  const ids = new Set(state.readLog[date] || []);
  if (on) {
    if (bookId) ids.add(bookId);
    else if (!state.manualReadDays.includes(date)) state.manualReadDays.push(date);
    state.readLog[date] = [...ids];
  } else if (bookId) {
    ids.delete(bookId);
    if (ids.size || state.manualReadDays.includes(date)) state.readLog[date] = [...ids];
    else delete state.readLog[date];
  } else {
    delete state.readLog[date];
    state.manualReadDays = state.manualReadDays.filter((d) => d !== date);
  }
  save();
}

export const goal = (y) => Number(state.goals[y] || 0);
export function setGoal(y, n) {
  if (n > 0) state.goals[y] = n;
  else delete state.goals[y];
  save();
}
