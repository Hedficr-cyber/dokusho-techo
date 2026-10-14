// PC と iPhone の本棚をそろえる（同期）。
// データは端末の中で暗号化してから、本人の GitHub の「非公開」リポジトリに 1 つのファイルとして保存する。
//  ・暗号：合言葉から PBKDF2（SHA-256・60 万回）で鍵を作り、AES-GCM（256 ビット）で暗号化。合言葉はどこにも保存しない
//  ・暗号の鍵は「取り出せない形」でこの端末の IndexedDB に置く。GitHub の鍵（トークン）はこの端末の localStorage に置く
//  ・通信先は api.github.com だけ（index.html の CSP でも限っている）。公開リポジトリには保存しない
//  ・まとめ方：本は「最後に変えた時刻」が新しい方。消した本は、消した印より後に変えていなければ消す
import { normName } from './util.js';

const CONFIG_KEY = 'dokusho-techo:sync';
const SNAPSHOT_KEY = 'dokusho-techo:before-sync';
export const SYNC_FILE = 'dokusho-techo.sync.json';
const API = 'https://api.github.com';
const ITERATIONS = 600000;
const AAD = new TextEncoder().encode('dokusho-techo:sync:v1'); // 暗号文をこのアプリの同期ファイルとして結びつける

// ---------------------------------------------------------------- まとめ方（純粋な関数。検証しやすいように分けている）
const stamp = (b) => b.modifiedAt || (b.updatedAt ? `${b.updatedAt}T00:00:00.000Z` : '') || (b.addedAt ? `${b.addedAt}T00:00:00.000Z` : '');
const later = (a, b) => (a > b ? a : b);
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
// 同じ時刻なら中身で決める（どちらの端末で計算しても同じ結果になる）
function newer(a, b) {
  const x = stamp(a);
  const y = stamp(b);
  if (x !== y) return x > y ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}
const KEEP_MARKS_MS = 400 * 24 * 3600 * 1000; // 消した印は 400 日で片づける
function mergeMarks(...sources) {
  const out = {};
  const limit = new Date(Date.now() - KEEP_MARKS_MS).toISOString();
  for (const src of sources) for (const [k, t] of Object.entries(src || {})) if (t > limit) out[k] = later(out[k] || '', t);
  return out;
}

export function mergeSyncData(local, remote) {
  const removed = mergeMarks(remote.removed, local.removed);
  const deletedSeedIds = union(local.deletedSeedIds, remote.deletedSeedIds);
  const gone = new Set(deletedSeedIds);
  const byId = new Map();
  const order = [];
  for (const b of local.books || []) { byId.set(b.id, b); order.push(b.id); }
  for (const b of remote.books || []) {
    const mine = byId.get(b.id);
    if (mine) byId.set(b.id, newer(mine, b));
    else { byId.set(b.id, b); order.push(b.id); }
  }
  const books = order.map((id) => byId.get(id))
    .filter((b) => !gone.has(b.id) && (!removed[b.id] || stamp(b) > removed[b.id]));
  // 自分でフォローした著者：フォローした時刻とやめた時刻の新しい方
  const unfollowed = mergeMarks(remote.unfollowed, local.unfollowed);
  const follows = new Map();
  for (const f of [...(remote.follows || []), ...(local.follows || [])]) {
    if (f.auto) continue;
    const k = normName(f.name);
    const prev = follows.get(k);
    if (!prev || (f.followedAt || '') > (prev.followedAt || '')) follows.set(k, f);
  }
  const followList = [...follows.entries()].filter(([k, f]) => !unfollowed[k] || (f.followedAt || '') > unfollowed[k]).map(([, f]) => f);
  const readLog = {};
  for (const src of [remote.readLog, local.readLog]) for (const [d, ids] of Object.entries(src || {})) readLog[d] = union(readLog[d], ids);
  return {
    books, removed, deletedSeedIds, seedVersion: Math.max(local.seedVersion || 0, remote.seedVersion || 0),
    follows: followList, unfollowed,
    dismissed: union(local.dismissed, remote.dismissed), hiddenRecs: union(local.hiddenRecs, remote.hiddenRecs),
    readLog, manualReadDays: union(local.manualReadDays, remote.manualReadDays), goals: { ...(remote.goals || {}), ...(local.goals || {}) },
  };
}

// 中身が同じかどうか（並び順の違いは同じとみなす）
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).sort().join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
export const sameData = (a, b) => canonical(a) === canonical(b);

// ---------------------------------------------------------------- 暗号
const toB64 = (bytes) => {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(String(s).replace(/\s/g, '')), (c) => c.charCodeAt(0));
async function gzip(bytes) {
  if (!('CompressionStream' in window)) return null;
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealData(data, key, salt, device = '') {
  let bytes = new TextEncoder().encode(JSON.stringify(data));
  const zipped = await gzip(bytes);
  if (zipped) bytes = zipped;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, bytes);
  return {
    app: 'dokusho-techo', v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
    cipher: 'AES-GCM', iv: toB64(iv), zip: zipped ? 'gzip' : '', data: toB64(cipher),
    savedAt: new Date().toISOString(), device: String(device).slice(0, 40),
  };
}

// 読み込んだファイルが、このアプリの暗号化ファイルの形かを確かめる（よそのファイルや壊れたファイルは扱わない）
export function checkEnvelope(env) {
  const ok = env && env.app === 'dokusho-techo' && env.v === 1 && env.cipher === 'AES-GCM'
    && env.kdf?.name === 'PBKDF2' && env.kdf?.hash === 'SHA-256'
    && Number.isInteger(env.kdf?.iterations) && env.kdf.iterations >= 100000 && env.kdf.iterations <= 5000000
    && typeof env.kdf?.salt === 'string' && fromB64(env.kdf.salt).length === 16
    && typeof env.iv === 'string' && fromB64(env.iv).length === 12 && typeof env.data === 'string' && ['', 'gzip'].includes(env.zip ?? '');
  if (!ok) throw new SyncError('format', '同期ファイルの形が正しくありません。読書手帖の同期ファイルか確認してください。');
  return env;
}

export async function openData(env, key) {
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: AAD }, key, fromB64(env.data)));
  } catch {
    throw new SyncError('passphrase', '合言葉が違います（または同期ファイルが書き換えられています）。');
  }
  const bytes = env.zip === 'gzip' ? await gunzip(plain) : plain;
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- GitHub（api.github.com だけ）
const repoPath = (cfg) => `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
async function gh(cfg, path, opts = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
    });
  } catch {
    throw new SyncError('offline', 'GitHub に接続できませんでした。通信できる場所でもう一度試してください。');
  }
  if (res.status === 401) throw new SyncError('token', 'アクセス用の鍵が正しくないか、期限が切れています。新しい鍵を作って入れ直してください。');
  if (res.status === 403) throw new SyncError('forbidden', 'GitHub に断られました。鍵の権限（Contents の読み書き）か、時間をおいてもう一度試してください。');
  return res;
}

export async function checkRepo(cfg) {
  const res = await gh(cfg, repoPath(cfg));
  if (res.status === 404) throw new SyncError('repo', 'リポジトリが見つかりません。ユーザー名・リポジトリ名と、鍵がそのリポジトリを使えるか確認してください。');
  if (!res.ok) throw new SyncError('repo', `GitHub がエラーを返しました（${res.status}）。`);
  const repo = await res.json();
  if (repo.private !== true) throw new SyncError('public', 'このリポジトリは公開されています。本棚のデータは非公開（Private）のリポジトリにだけ保存します。');
  return repo;
}

async function getFile(cfg) {
  const res = await gh(cfg, `${repoPath(cfg)}/contents/${SYNC_FILE}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError('read', `同期ファイルを読めませんでした（${res.status}）。`);
  const file = await res.json();
  if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new SyncError('format', '同期ファイルを読めませんでした。');
  let env;
  try { env = JSON.parse(new TextDecoder().decode(fromB64(file.content))); } catch { throw new SyncError('format', '同期ファイルの形が正しくありません。'); }
  return { sha: file.sha, env: checkEnvelope(env) };
}

async function putFile(cfg, env, sha) {
  const content = toB64(new TextEncoder().encode(JSON.stringify(env)));
  const body = JSON.stringify({ message: `読書手帖の同期（${env.device || '端末'}・${env.savedAt}）`, content, ...(sha ? { sha } : {}) });
  const res = await gh(cfg, `${repoPath(cfg)}/contents/${SYNC_FILE}`, { method: 'PUT', body });
  if (res.status === 409 || res.status === 422) return null; // ほかの端末が先に保存した。読み直してやり直す
  if (!res.ok) throw new SyncError('write', `同期ファイルを保存できませんでした（${res.status}）。`);
  return (await res.json()).content?.sha || '';
}

// ---------------------------------------------------------------- 鍵の置き場所（IndexedDB）
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dokusho-techo-sync', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function keyStore(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('keys', mode);
    const req = fn(tx.objectStore('keys'));
    tx.oncomplete = () => { conn.close(); resolve(req?.result); };
    tx.onerror = () => { conn.close(); reject(tx.error); };
  });
}
let memoryKey = null; // IndexedDB に置けない端末では、開いている間だけ覚える
async function saveKey(salt, key) {
  memoryKey = { salt, key };
  try { await keyStore('readwrite', (s) => s.put({ salt, key }, 'main')); return true; } catch { return false; }
}
async function loadKey(salt) {
  if (memoryKey?.salt === salt) return memoryKey.key;
  try {
    const hit = await keyStore('readonly', (s) => s.get('main'));
    if (hit?.salt === salt && hit.key) { memoryKey = hit; return hit.key; }
  } catch { /* 読めなければ合言葉を聞き直す */ }
  return null;
}
async function clearKey() {
  memoryKey = null;
  try { await keyStore('readwrite', (s) => s.delete('main')); } catch { /* なければよい */ }
}

// ---------------------------------------------------------------- 設定と状態
export function syncConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); } catch { return null; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* 容量不足 */ }
  listeners.forEach((fn) => fn(status()));
}
const listeners = new Set();
export const onSyncStatus = (fn) => (listeners.add(fn), () => listeners.delete(fn));
let running = null;
let again = false;
export function status() {
  const cfg = syncConfig();
  return cfg ? { on: true, owner: cfg.owner, repo: cfg.repo, device: cfg.device, lastSyncAt: cfg.lastSyncAt || '', lastError: cfg.lastError || '', needPassphrase: !!cfg.needPassphrase, running: !!running }
    : { on: false, running: false };
}
export function guessDevice() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'PC';
}

// ---------------------------------------------------------------- つなぐ・同期する・やめる
// store：{ syncPayload, applySync, bookCount }。choose：既存のデータがあるとき、置き換えるか合わせるかを本人に聞く
export async function connect({ owner, repo, token, passphrase, device }, { store, choose }) {
  const cfg = { owner: String(owner).trim(), repo: String(repo).trim(), token: String(token).trim(), device: String(device || guessDevice()).trim().slice(0, 40) };
  if (!/^[A-Za-z0-9-]{1,39}$/.test(cfg.owner)) throw new SyncError('input', 'GitHub のユーザー名を確認してください。');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(cfg.repo)) throw new SyncError('input', 'リポジトリ名を確認してください（英数字と - _ . だけ）。');
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(cfg.token)) throw new SyncError('input', 'アクセス用の鍵（github_pat_ で始まる文字）を確認してください。');
  if (String(passphrase).length < 8) throw new SyncError('input', '合言葉は 8 文字以上にしてください。');
  await checkRepo(cfg);
  const file = await getFile(cfg);
  if (!file) {
    // 最初の端末：この端末の本棚を最初のデータとして保存する
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    const data = store.syncPayload();
    const sha = await putFile(cfg, await sealData(data, key, salt, cfg.device), null);
    if (sha === null) throw new SyncError('conflict', 'ほかの端末が同時に保存しました。もう一度「接続する」を押してください。');
    const saltText = toB64(salt);
    const kept = await saveKey(saltText, key);
    saveConfig({ ...cfg, salt: saltText, sha, lastSyncAt: new Date().toISOString(), lastError: '', keyInMemoryOnly: !kept });
    return { mode: 'first', books: data.books.length };
  }
  const salt = fromB64(file.env.kdf.salt);
  const key = await deriveKey(passphrase, salt, file.env.kdf.iterations);
  const remote = await openData(file.env, key); // 合言葉が違えばここで止まる
  const local = store.syncPayload();
  const mode = await choose({ localBooks: local.books.length, remoteBooks: (remote.books || []).length, savedAt: file.env.savedAt, device: file.env.device || '' });
  if (!mode) return { mode: 'cancel' };
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: new Date().toISOString(), data: local })); } catch { /* 容量不足なら残さない */ }
  const data = mode === 'replace' ? remote : mergeSyncData(local, remote);
  store.applySync(data); // ここで形を検証する（不正なら例外で止まり、この端末は変えない）
  let sha = file.sha;
  if (!sameData(data, remote)) {
    sha = await putFile(cfg, await sealData(store.syncPayload(), key, salt, cfg.device), file.sha);
    if (sha === null) sha = file.sha; // 次の同期で合わせ直す
  }
  const kept = await saveKey(file.env.kdf.salt, key);
  saveConfig({ ...cfg, salt: file.env.kdf.salt, sha, lastSyncAt: new Date().toISOString(), lastError: '', keyInMemoryOnly: !kept });
  return { mode, books: store.bookCount() };
}

// 合言葉を入れ直す（鍵を置けない端末で開き直したとき、ほかの端末が合言葉を変えたとき）
export async function unlock(passphrase, { store }) {
  const cfg = syncConfig();
  if (!cfg) return;
  const file = await getFile(cfg);
  if (!file) throw new SyncError('missing', '同期ファイルが見つかりません。');
  const key = await deriveKey(passphrase, fromB64(file.env.kdf.salt), file.env.kdf.iterations);
  await openData(file.env, key);
  await saveKey(file.env.kdf.salt, key);
  saveConfig({ ...cfg, salt: file.env.kdf.salt, needPassphrase: false, lastError: '' });
  return syncNow({ store });
}

export function syncNow({ store }) {
  if (!syncConfig()) return Promise.resolve(null);
  if (running) { again = true; return running; }
  running = (async () => {
    let cfg = syncConfig();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const file = await getFile(cfg);
        if (!file) {
          // 同期ファイルが消えていたら、この端末の内容で作り直す（鍵はそのまま）
          const key = await loadKey(cfg.salt);
          if (!key) { saveConfig({ ...cfg, needPassphrase: true, lastError: '合言葉を入れてください。' }); return null; }
          const sha = await putFile(cfg, await sealData(store.syncPayload(), key, fromB64(cfg.salt), cfg.device), null);
          if (sha === null) continue;
          cfg = { ...cfg, sha, lastSyncAt: new Date().toISOString(), lastError: '' };
          saveConfig(cfg);
          return 'uploaded';
        }
        const key = await loadKey(file.env.kdf.salt);
        if (!key) { saveConfig({ ...cfg, needPassphrase: true, lastError: '合言葉を入れてください。' }); return null; }
        const remote = await openData(file.env, key);
        const local = store.syncPayload();
        const merged = mergeSyncData(local, remote);
        if (!sameData(merged, local)) store.applySync(merged);
        if (!sameData(merged, remote)) {
          const sha = await putFile(cfg, await sealData(store.syncPayload(), key, fromB64(file.env.kdf.salt), cfg.device), file.sha);
          if (sha === null) continue; // 先に保存された。読み直してまとめ直す
          cfg = { ...cfg, sha, lastSyncAt: new Date().toISOString(), lastError: '', needPassphrase: false };
        } else cfg = { ...cfg, sha: file.sha, lastSyncAt: new Date().toISOString(), lastError: '', needPassphrase: false };
        saveConfig(cfg);
        return 'synced';
      }
      throw new SyncError('conflict', 'ほかの端末の保存が続いたため、同期を後回しにしました。');
    } catch (e) {
      saveConfig({ ...syncConfig(), lastError: e.message || '同期できませんでした。', ...(e.code === 'passphrase' ? { needPassphrase: true } : {}) });
      return null;
    }
  })().finally(() => {
    running = null;
    listeners.forEach((fn) => fn(status()));
    if (again) { again = false; syncNow({ store }); }
  });
  listeners.forEach((fn) => fn(status()));
  return running;
}

// この端末の同期をやめる（GitHub のファイルと、ほかの端末はそのまま）
export async function disconnect() {
  await clearKey();
  try { localStorage.removeItem(CONFIG_KEY); } catch { /* なければよい */ }
  listeners.forEach((fn) => fn(status()));
}

export function beforeSyncSnapshot() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null'); } catch { return null; }
}
