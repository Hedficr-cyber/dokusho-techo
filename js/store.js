// 本棚データの保存先。いまはこの端末のブラウザ（localStorage）に保存する。
// 後でクラウド同期にするときは、このファイルの load/save だけを差し替える。
import { GENRE_GROUP_BY_ID } from './genres.js';
import { uid, today, normName, isPrintRecord } from './util.js';

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
  seriesCheckedAt: '', // 本棚のシリーズの新しい巻を最後に確かめた時刻
  favoriteGenres: [], onboardingDone: false, preferencesAt: '',
  removed: {},      // 同期用：消した本 { 本の id: 消した時刻 }
  unfollowed: {},   // 同期用：フォローをやめた著者 { 著者名の比較キー: やめた時刻 }
};
let state = structuredClone(EMPTY);
const listeners = new Set();
let diskRaw=null;
function refreshStoredState() {
  try {
    const raw=localStorage.getItem(KEY);
    if (!raw || raw===diskRaw) return false;
    state=prepareBackup(JSON.parse(raw)); diskRaw=raw;
    return true;
  } catch {return false;}
}
window.addEventListener('storage',e=>{
  if (e.key===KEY && refreshStoredState()) listeners.forEach(fn=>fn({type:'external'}));
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = prepareBackup(JSON.parse(raw));
    diskRaw=raw;
    // v0.7 までに点字版などの記録から新刊として拾ったもの（例：恋のゴンドラ）を外す
    // 本棚のシリーズの巻は、点字版の記録しかなくても続巻として残す（シリーズ側で古い巻を除いている）
    state.releases = state.releases.filter((r) => r.series || isPrintRecord(r));
  } catch {
    /* 読めないときは空の本棚で始める */
  }
  return state;
}

function save(type='change') {
  state.updatedAt = new Date().toISOString();
  try {
    const raw=JSON.stringify(state);
    localStorage.setItem(KEY, raw); diskRaw=raw;
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
    refreshStoredState();
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
  refreshStoredState();
  const book = {
    id: uid(), title: '', author: '', status: 'want', priority: 2, genres: [], source: 'manual',
    note: '', photos: [], isbn: '', publisher: '', year: '', format: '', ndc: '', ndl: '',
    rating: 0, memo: '', finishedAt: '', addedAt: today(), registeredAt: new Date().toISOString(), needsCheck: false, ...fields,
  };
  if (book.status === 'done' && !book.finishedAt) book.finishedAt = today();
  book.updatedAt = today();
  book.modifiedAt = new Date().toISOString(); // 同期で新しい方を選ぶための時刻
  state.books.unshift(book);
  save();
  return book;
}

export function update(id, patch) {
  refreshStoredState();
  const b = get(id);
  if (!b) return;
  if (patch.status === 'done' && b.status !== 'done' && !b.finishedAt && !('finishedAt' in patch)) {
    patch.finishedAt = today();
  }
  Object.assign(b, patch, { updatedAt: today(), modifiedAt: new Date().toISOString() });
  save();
}

export function remove(id) {
  refreshStoredState();
  const i = state.books.findIndex((b) => b.id === id);
  if (i < 0) return;
  if (id.startsWith('seed-')) state.deletedSeedIds.push(id);
  state.removed[id] = new Date().toISOString(); // 消した印（同期で、ほかの端末からも消す）
  state.books.splice(i, 1);
  save();
}

// 「元に戻す」：消した本を同じ位置に戻し、消した印も外す
export function restore(book, index = 0) {
  refreshStoredState();
  if (!book?.id || get(book.id)) return;
  const removedAt=Date.parse(state.removed[book.id] || '') || 0;
  const restoredAt=new Date(Math.max(Date.now(),removedAt+1)).toISOString();
  delete state.removed[book.id];
  state.deletedSeedIds = state.deletedSeedIds.filter((x) => x !== book.id);
  state.books.splice(Math.min(Math.max(index, 0), state.books.length), 0, { ...book, modifiedAt: restoredAt });
  save();
}
export const indexOf = (id) => state.books.findIndex((b) => b.id === id);

// 入力を検証してから置き換える。古いバックアップには新しい項目を補う。
export function prepareBackup(data) {
  const invalid = () => { throw new Error('読書手帖のバックアップファイルではありません'); };
  if (!data || !Array.isArray(data.books)) invalid();
  const arrayFields = ['favoriteGenres','deletedSeedIds', 'follows', 'releases', 'dismissed', 'hiddenRecs', 'manualReadDays'];
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
  const bookStrings=['isbn','publisher','publishedAt','registeredAt','addedAt','updatedAt','modifiedAt','finishedAt','memo','note','format','ndc','ndl','source','coverIsbn','authorReading','seriesPreviousStatus'];
  // 同期用の印：{ キー: 時刻の文字列 }
  const stampMap=(v)=>v==null || (typeof v==='object' && !Array.isArray(v) && Object.values(v).every(x=>typeof x==='string'));
  if (!stampMap(data.removed) || !stampMap(data.unfollowed)) invalid();
  if (data.books.some(b=>!optionalStrings(b,bookStrings) || !optionalNumbers(b,['rating','priority'])
    || !stringArray(b,'genres') || !stringArray(b,'coverIsbns')
    || (b.photos!=null && (!Array.isArray(b.photos) || b.photos.some(x=>!Number.isInteger(x)))))) invalid();
  if ((data.releases || []).some(r=>!optionalStrings(r,['isbn','publisher','link','ndc','volume','baseTitle','publishedAt','coverIsbn','coverCheckedAt','series']) || !stringArray(r,'coverIsbns'))) invalid();
  if ((data.follows || []).some(f=>!optionalStrings(f,['addedAt','followedAt']) || (f.auto!=null && typeof f.auto!=='boolean'))) invalid();
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  if (Object.entries(data.readLog || {}).some(([d, ids]) => !isDate(d) || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) invalid();
  if ((data.manualReadDays || []).some((d) => !isDate(d))) invalid();
  if (data.books.some(b=>b.year!=null && !['string','number'].includes(typeof b.year))) invalid();
  if (data.onboardingDone!=null && typeof data.onboardingDone!=='boolean') invalid();
  if (!stringArray(data,'favoriteGenres') || !optionalStrings(data,['preferencesAt'])) invalid();
  const next = { ...structuredClone(EMPTY), ...structuredClone(data) };
  // 以前の本棚・空に整理した既存端末も、新しい人向けの初期画面で遮らない。
  if (!Object.hasOwn(data,'onboardingDone') || next.books.length) next.onboardingDone=true;
  // v0.2.0 の空配列は「本を指定せずに読んだ日」の印。
  if (!('manualReadDays' in data)) next.manualReadDays = Object.keys(next.readLog).filter((d) => !next.readLog[d].length);
  // 古いタブの保存で本の配列だけ戻っても、保存済みの削除印を優先する。
  // 「元に戻す」は削除より新しい modifiedAt を持つので維持する（同期と同じ判定）。
  next.removed ||= {};
  next.unfollowed ||= {};
  const gone=new Set(next.deletedSeedIds);
  const stamp=b=>b.modifiedAt || (b.updatedAt ? `${b.updatedAt}T00:00:00.000Z` : '') || (b.addedAt ? `${b.addedAt}T00:00:00.000Z` : '');
  next.books=next.books.filter(b=>next.removed[b.id] ? stamp(b)>next.removed[b.id] : !gone.has(b.id));
  const present=new Set(next.books.map(b=>b.id));
  next.deletedSeedIds=[...gone].filter(id=>!present.has(id));
  return next;
}

// ---------------------------------------------------------------- 同期（js/sync.js）
// 端末の間でそろえる項目。新刊の一覧・表紙の照合・自動フォローは各端末で作り直すので送らない
const SYNC_FIELDS = ['books', 'removed', 'deletedSeedIds', 'seedVersion', 'favoriteGenres', 'preferencesAt', 'onboardingDone', 'follows', 'unfollowed', 'dismissed', 'hiddenRecs', 'readLog', 'manualReadDays', 'goals'];
export function syncPayload() {
  refreshStoredState();
  const data = {};
  for (const k of SYNC_FIELDS) data[k] = structuredClone(state[k]);
  data.follows = data.follows.filter((f) => !f.auto).map(({ name, addedAt, followedAt }) => ({ name, addedAt: addedAt || '', lastChecked: '', ...(followedAt ? { followedAt } : {}) }));
  return data;
}
// 同期でそろえた内容を当てる（検証してから）。この端末の新刊の一覧・自動フォローの確認時刻は残す
export function applySync(data) {
  const next = prepareBackup({ ...syncPayload(), ...data });
  const keepChecks = new Map(state.follows.map((f) => [normName(f.name), f.lastChecked]));
  const autos = state.follows.filter((f) => f.auto); // 自動フォローはこの端末の分を残す（本棚に合わせて syncShelfFollows が直す）
  for (const k of SYNC_FIELDS) state[k] = next[k];
  const explicit = next.follows.map((f) => ({ ...f, lastChecked: keepChecks.get(normName(f.name)) || '' }));
  const names = new Set(explicit.map((f) => normName(f.name)));
  state.follows = [...explicit, ...autos.filter((f) => !names.has(normName(f.name)))];
  save('sync');
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
  refreshStoredState();
  if (!name) return;
  const f = state.follows.find((x) => normName(x.name) === normName(name));
  if (f?.auto) { delete f.auto; save(); return; } // 本棚から外れてもフォローを残す
  if (f) return;
  state.follows.push({ name, addedAt: today(), lastChecked: '', followedAt: new Date().toISOString() });
  delete state.unfollowed[normName(name)];
  save();
}

// 本棚の著者は自動でフォローする（auto: true）。本棚から著者の本がなくなったら、自動の分だけ外す。
// 自分でフォローした著者（auto なし）はそのまま。変わったら true
export function syncShelfFollows(names) {
  refreshStoredState();
  const want = new Map(names.filter(Boolean).map((n) => [normName(n), n]));
  const before = JSON.stringify(state.follows);
  for (const [key, name] of want) {
    if (!state.follows.some((f) => normName(f.name) === key)) state.follows.push({ name, addedAt: today(), lastChecked: '', auto: true });
  }
  state.follows = state.follows.filter((f) => !f.auto || want.has(normName(f.name)));
  if (JSON.stringify(state.follows) === before) return false;
  state.releases = state.releases.filter((r) => r.series || state.follows.some((f) => normName(f.name) === normName(r.author)));
  save('follows');
  return true;
}

export function unfollow(name) {
  refreshStoredState();
  state.follows = state.follows.filter((f) => normName(f.name) !== normName(name));
  state.unfollowed[normName(name)] = new Date().toISOString();
  // 本棚のシリーズの新しい巻は、フォローをやめても残す
  state.releases = state.releases.filter((r) => normName(r.author) !== normName(name) || r.series);
  save();
}

export const releases = () => state.releases;

function mergeReleases(items) {
  const have = new Set(state.releases.map((r) => r.key));
  const gone = new Set(state.dismissed);
  const fresh = items.filter((r) => !have.has(r.key) && !gone.has(r.key));
  state.releases.push(...fresh.map((r) => ({ ...r, foundAt: today(), seen: false })));
  // 前に見つけた本も、あとから ISBN・発売日が登録されたり別の版の表紙が見つかったりしたら書き足す
  for (const it of items) {
    const old = state.releases.find((r) => r.key === it.key);
    if (!old || fresh.includes(it)) continue;
    if (!old.isbn && it.isbn) old.isbn = it.isbn;
    if (!old.publishedAt && it.publishedAt) old.publishedAt = it.publishedAt;
    if (!old.series && it.series) old.series = it.series;
    if (it.coverLookupVersion) Object.assign(old,{coverIsbns:it.coverIsbns,coverIsbn:it.coverIsbn,coverCheckedAt:it.coverCheckedAt,coverLookupVersion:it.coverLookupVersion});
    else if (!old.coverIsbn && it.coverIsbn) old.coverIsbn = it.coverIsbn;
  }
  return fresh.length;
}

// 新刊チェックの結果を足す。もう知っている本・「表示しない」にした本は足さない。新しく見つかった件数を返す
export function addReleases(name, items) {
  refreshStoredState();
  if (!isFollowing(name)) return 0;
  const n = mergeReleases(items);
  const f = state.follows.find((x) => normName(x.name) === normName(name));
  if (f) f.lastChecked = new Date().toISOString();
  save('releases'); // 裏の新刊確認。本棚の画面は描き直さない
  return n;
}

// 本棚のシリーズの、まだ持っていない新しい巻・発売予定の巻（フォローしていない著者でも出す）
export const seriesCheckedAt = () => state.seriesCheckedAt || '';
export function addSeriesReleases(items) {
  refreshStoredState();
  const n = mergeReleases(items.map((r) => ({ ...r, series: r.series || r.baseTitle || r.title })));
  state.seriesCheckedAt = new Date().toISOString();
  save('releases');
  return n;
}

// 表紙の補充だけを保存。既読状態/新刊件数/フォローの確認時刻は変えない。
export function updateReleaseCovers(key,patch) {
  refreshStoredState();
  const item=state.releases.find(r=>r.key===key);
  if (!item) return;
  if (!item.isbn && patch.isbn) item.isbn=patch.isbn;
  if (!item.publishedAt && patch.publishedAt) item.publishedAt=patch.publishedAt;
  Object.assign(item,{coverIsbns:patch.coverIsbns,coverIsbn:patch.coverIsbn,coverCheckedAt:patch.coverCheckedAt,coverLookupVersion:patch.coverLookupVersion});
  save('release-covers');
}

export function markReleasesSeen() {
  refreshStoredState();
  if (!state.releases.some((r) => !r.seen)) return;
  state.releases.forEach((r) => { r.seen = true; });
  save('releases');
}

export function dismissRelease(key) {
  refreshStoredState();
  state.releases = state.releases.filter((r) => r.key !== key);
  if (!state.dismissed.includes(key)) state.dismissed.push(key);
  save();
}

// ---------------------------------------------------------------- おすすめ
export const hiddenRecs = () => state.hiddenRecs;
export function hideRec(key) {
  refreshStoredState();
  if (!key || state.hiddenRecs.includes(key)) return;
  state.hiddenRecs.push(key);
  save();
}

// ---------------------------------------------------------------- 読書日数と目標
export const readLog = () => state.readLog;

export function setReadDay(date, on, bookId = '') {
  refreshStoredState();
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
  refreshStoredState();
  if (n > 0) state.goals[y] = n;
  else delete state.goals[y];
  save();
}

// 新しい利用者の好み（本棚が空でもおすすめを出す）。後から変更できる。
export function setFavoriteGenres(ids) {
  refreshStoredState();
  state.favoriteGenres=[...new Set(ids.filter(id=>GENRE_GROUP_BY_ID[id]))];
  state.onboardingDone=true; state.preferencesAt=new Date().toISOString();
  save('preferences');
}
