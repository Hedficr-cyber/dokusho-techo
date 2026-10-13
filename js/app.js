import * as store from './store.js';
import * as ndl from './ndl.js';
import { STATUS, STATUS_ORDER, SOURCES, PRIORITY, GENRES, GENRE_BY_ID, GENRE_GROUPS, GENRE_GROUP_BY_ID, belongsToGenre } from './genres.js';
import { startScanner } from './scan.js';
import { authorReading } from './authors.js';
import { SHELF_MODES, primaryGenre, sortShelfBooks } from './shelf.js';
import { recommendPlan, pickRecommendations, shelfTitleMap } from './recommend.js';
import { coverIsbn, coverCandidates, releaseIdentity, previousCoverIsbns, confirmedRelease, currentReleaseIsbn, confirmedGoogleCover, knownPlaceholder, COVER_LOOKUP_VERSION } from './covers.js';
import {
  esc, normTitle, normName, mainTitle, clothColor, today, monthsAgo, monthLabel, isbn13, authorMatches,
} from './util.js';

import { loadBookDetails, publicationDate, publicationLabel } from './book-details.js';
import { revealBooks } from './reveal.js';
import { VERSION_HISTORY } from './versions.js';
const APP_VERSION = VERSION_HISTORY[0].version;
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
const THIS_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------- 画面の状態（この端末だけで覚える）
const UI_KEY = 'dokusho-techo:ui';
const ui = {
  q: '', sort: 'author', genre: '', unreadOnly: true, notOnShelf: false, showOther: false, showAntho: false,
  bookView: 'grid', historyYear: 'all', yearDirection: 'desc', addedDirection: 'desc',
  searchQ: '', searchKind: 'all', recShift: 0,
};
delete ui.scanStatus; // v0.7 で「入れる棚」の選択をやめた（登録はすべて本棚へ）
delete ui.addStatus;
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch { /* 既定値で始める */ }
delete ui.status;
if (!SHELF_MODES.some(([id])=>id===ui.sort)) ui.sort='author';
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* 無視 */ } };

let route = { name: 'shelf', arg: '' };
let shelfLimit = 24;
let shelfObserver = null;
let shelfScrollFallback = null;
let shelfFrame = 0;
function stopShelfLoading() {
  shelfObserver?.disconnect(); shelfObserver=null;
  if (shelfScrollFallback) window.removeEventListener('scroll',shelfScrollFallback);
  shelfScrollFallback=null;
  cancelAnimationFrame(shelfFrame);
}
let preview = null; // 外部の本の情報。閉じたら通信も中止する
function stopBookPreview() { preview?.controller.abort(); preview=null; }
let openId = null;          // 詳細を開いている本
let workCache = new Map();  // 検索結果の作品（key → work）
let lastAuthor = null;      // 直近の著者検索（再描画で読み込み表示を挟まないため）
let renderToken = 0;
let scanController = null; // スキャン画面を離れたら、起動待ちのカメラも止める
let stopScan = null;        // カメラを止める関数
let scanned = [];           // このバーコード画面で読み取った本
const pendingReleaseNames = new Set(); // チェック中に追加したフォローも順に確認する
let checking = null;        // 新刊チェックの進み { done, total }
let checkError = '';
let newKeys = new Set();    // 著者タブを開いた時点で未読だった新刊（NEW 表示用）
let lastSearch = null;      // 検索タブの直近の結果 { q, kind, works, error }
let searchSeq = 0;          // 何回目の検索か（最新の結果だけを描くため）
let recState = null;        // おすすめの集まり具合 { sig, plan, results, running, error }
let recSeq = 0;

// ---------------------------------------------------------------- 書影
// 版元ドットコム（大きく鮮明）→ Google Books（幅128pxと小さいが収録が多い）の順に探し、
// どちらにも無ければ書名を組んだ表紙を見せる。外部サービスの「画像なし」画像は表示しない。
const COVER_SOURCES = [
  (isbn) => `https://img.hanmoto.com/bd/img/${isbn}.jpg`,
  (isbn) => `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1`,
];
const coverUrl = (isbn, step = 0) => COVER_SOURCES[step](isbn);

// 旧版の候補を順に試す。ISBNは書誌と一致するものだけを使う。
function cover(title,isbn,size='s',alternatives=[],author='') {
  const googleId=confirmedGoogleCover(title,author);
  const candidates=coverCandidates(isbn,alternatives);
  const spine=`<span class="spine" style="--cloth:${clothColor(title)}"><span class="spine-t">${esc(mainTitle(title))}</span></span>`;
  const img=candidates.length ? `<img alt="" loading="lazy" decoding="async" data-isbn="${candidates[0]}" data-original="${coverIsbn(isbn)}" data-candidates="${candidates.join(',')}" data-candidate="0" data-step="0" src="${coverUrl(candidates[0],0)}">` : googleId ? `<img alt="" loading="lazy" decoding="async" data-google-id="${googleId}" data-step="1" src="https://books.google.com/books/content?id=${googleId}&amp;printsec=frontcover&amp;img=1&amp;zoom=1">` : '';
  return `<span class="cover ${size}" aria-hidden="true">${spine}${img}</span>`;
}
function setCoverCaption(img,missing=false) {
  const row=img.closest('.book,.detail-head'),caption=row?.querySelector('.cover-caption');
  if (!caption) return;
  const text=missing ? '表紙未取得'
    : img.dataset.googleId ? ''
    : img.dataset.isbn!==img.dataset.original ? (img.dataset.original ? '旧版の表紙を表示' : '別の版の表紙を表示') : '';
  caption.textContent=text;caption.hidden=!text;
}
function nextCover(img) {
  if (img.dataset.googleId) {setCoverCaption(img,true);img.remove();return;}
  img.classList.remove('ok');
  const step=Number(img.dataset.step)+1;
  if (step<COVER_SOURCES.length) { img.dataset.step=String(step);img.src=coverUrl(img.dataset.isbn,step);return; }
  const candidates=img.dataset.candidates.split(',');
  const index=Number(img.dataset.candidate)+1;
  if (index<candidates.length) {
    img.dataset.candidate=String(index);img.dataset.isbn=candidates[index];img.dataset.step='0';img.src=coverUrl(candidates[index],0);
  } else { setCoverCaption(img,true);img.remove(); }
}
// 寸法が判明している「画像なし」と、正方形の刊行前の仮画像を除く。
function isNoCoverImage(img) {
  const w=img.naturalWidth,h=img.naturalHeight;
  return w<60 || h<=w*1.05 || (img.dataset.step!=='0' && w===128 && h===170)
    || knownPlaceholder(img.dataset.isbn,img.dataset.step==='0' ? 'hanmoto' : 'google',w,h);
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && (img.dataset.isbn || img.dataset.googleId)) nextCover(img);
}, true);

document.addEventListener('load', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !(img.dataset.isbn || img.dataset.googleId)) return;
  if (isNoCoverImage(img)) nextCover(img);
  else { img.classList.add('ok'); setCoverCaption(img); }
}, true);

const ICONS = {
 search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.5 4.5"/>',
 grid: '<rect x="4" y="4" width="6" height="7" rx="1"/><rect x="14" y="4" width="6" height="7" rx="1"/><rect x="4" y="15" width="6" height="5" rx="1"/><rect x="14" y="15" width="6" height="5" rx="1"/>',
 list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.1M4 12h.1M4 18h.1" stroke-width="3"/>',
 filter: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--paper)"/><circle cx="15" cy="17" r="2" fill="var(--paper)"/>',
 close: '<path d="m6 6 12 12M18 6 6 18"/>',
 arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
 bookmark: '<path d="M7 4h10v16l-5-3-5 3z"/>',
 book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zM13 7a3 3 0 0 1 3-3h4v14h-3a4 4 0 0 0-4 3"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
const pageHead = (title, detail = '') => `<div class="page-head"><h1>${esc(title)}</h1>${detail ? `<span class="page-detail">${esc(detail)}</span>` : ''}</div>`;

// ---------------------------------------------------------------- 小さな部品
const stamp = (status) => `<span class="stamp st-${status}">${STATUS[status]?.label || ''}</span>`;
const prioDots = (p) => `<span class="prio" title="気になり度：${PRIORITY[p] || ''}">${[1, 2, 3].map((n) => `<i class="${n <= p ? 'on' : ''}"></i>`).join('')}</span>`;
const stars = (r) => '★★★★★'.slice(0, r) + '☆☆☆☆☆'.slice(0, 5 - r);
const metaLine = (b) => [b.publisher, b.year && `${b.year}年`, b.format].filter(Boolean).map(esc).join('・');

function bookRow(b, options = {}) {
  const note = b.memo || b.note;
  return `<li class="book" role="button" tabindex="0" aria-label="${esc(b.title)}の詳細" data-act="open" data-id="${esc(b.id)}">
    ${cover(b.title, b.isbn, 's', b.coverIsbns || b.coverIsbn || [],b.author)}
    <div class="book-main">
      <div class="book-title">${esc(b.title)}</div>
      <div class="book-author">${esc(b.author)}</div>
      <div class="book-meta cover-caption" hidden></div>
      ${metaLine(b) ? `<div class="book-meta">${metaLine(b)}</div>` : ''}
      ${note ? `<div class="book-note">${esc(note)}</div>` : ''}
    </div>
    ${options.hideStatus ? '' : `<div class="book-side">${stamp(b.status)}${b.status === 'done' && b.rating ? `<span class="rating">${stars(b.rating)}</span>` : prioDots(b.priority)}</div>`}
  </li>`;
}

// 本棚の本と検索結果の作品を突き合わせる
function shelfIndex() {
  const byKey = new Map();
  const byIsbn = new Map();
  for (const b of store.books()) {
    const key = normTitle(b.title);
    byKey.set(key, [...(byKey.get(key) || []), b]);
    if (b.isbn) byIsbn.set(b.isbn.replace(/-/g, ''), b);
  }
  return (work) => work.isbns.map((i) => byIsbn.get(i)).find(Boolean)
    || work.keys.flatMap((k) => byKey.get(k + normTitle(work.volume || '')) || [])
      .find((b) => normName(b.author) === normName(work.authorLabel.split('、')[0])) || null;
}

// 本棚にある本の印：読了なら「読了」、それ以外は「本棚」（棚の種類は見せない）
const shelfMark = (b) => (b.status === 'done' ? stamp('done') : '<span class="stamp st-shelf">本棚</span>');
const ownedButton = (b) => `<button type="button" class="ghost" data-act="open" data-id="${esc(b.id)}">${shelfMark(b)}</button>`;

function workRow(w, owned, actLabel = '登録', opts = {}) {
  workCache.set(w.key, w);
  const vol = (w.volume ? ` ${esc(w.volume)}` : '') + (w.partsLabel ? `<span class="parts">${esc(w.partsLabel)}</span>` : '');
  const formats = w.formats.length ? `・${w.formats.join('/')}` : '';
  const right = owned
    ? ownedButton(owned)
    : `<button type="button" class="add-btn" data-act="add-work" data-key="${esc(w.key)}">＋${actLabel}</button>${opts.hideKey ? `<button type="button" class="rec-hide" data-act="rec-hide" data-key="${esc(opts.hideKey)}">表示しない</button>` : ''}`;
  return `<li class="book work" data-reveal-key="${esc(`work:${w.key}|${w.authorLabel}`)}">
    <button type="button" class="work-open" data-act="work-detail" data-key="${esc(w.key)}" aria-label="${esc(w.main + (w.volume ? ` ${w.volume}` : ''))}の本の情報">
      ${cover(w.title, w.latest?.isbn,'s',[...w.editions].reverse().map(e=>e.isbn),w.authorLabel.split('、')[0])}
      <span class="book-main">
        <span class="book-title">${esc(w.main)}${vol}</span>
        <span class="book-author">${esc(w.authorLabel)}</span>
        <span class="book-meta">${w.firstYear ? `${w.firstYear}年` : '刊行年不明'}${esc(formats)}${w.latest?.publisher ? `・${esc(w.latest.publisher)}` : ''}</span>
        ${opts.reason ? `<span class="rec-reason">${esc(opts.reason)}</span>` : ''}
      </span>
    </button>
    <div class="book-side">${right}</div>
  </li>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

const loading = (msg) => `<p class="loading"><span class="dot"></span>${esc(msg)}</p>`;
const errorBox = (msg) => `<p class="error">${esc(msg)}</p>`;



// ---------------------------------------------------------------- 本棚
function shelfRows(list,start,end) {
  const groupFor=b=>ui.sort==='author' ? {id:b.author || 'unknown',name:b.author || '著者未登録'}
    : ui.sort==='genre' && !ui.genre ? primaryGenre(b) : null;
  let current=start ? groupFor(list[start-1])?.id : null,rows='';
  for (const b of list.slice(start,end)) {
    const group=groupFor(b);
    if (group && group.id!==current) {
      current=group.id;
      const count=list.filter(x=>groupFor(x)?.id===group.id).length;
      const label=ui.sort==='author' && b.author ? `<button type="button" class="link" data-act="author" data-name="${esc(b.author)}">${esc(group.name)}</button>` : esc(group.name);
      rows+=`<li class="group-head"><h2>${label}</h2><span>${ui.sort==='author' && !authorReading(b) ? '読み未設定 · ' : ''}${count}冊</span></li>`;
    }
    rows+=bookRow(b,{hideStatus:true});
  }
  return rows;
}
function watchShelfEnd(list) {
  const tail=$('.shelf-end'),books=$('.shelf-books');
  if (!tail || !books || shelfLimit>=list.length) return;
  const append=()=>{
    if (route.name!=='shelf' || !tail.isConnected || sheet.open) return;
    const start=Math.min(shelfLimit,list.length);
    shelfLimit=Math.min(start+24,list.length);
    const fragment=document.createElement('template');
    fragment.innerHTML=shelfRows(list,start,shelfLimit);
    books.append(fragment.content);
    revealBooks(books);
    tail.textContent=`${shelfLimit} / ${list.length}冊`;
    if (shelfLimit>=list.length) { stopShelfLoading(); return; }
    // 大きな画面やキーボードのEndで末尾が表示されたままなら、必要な分だけ続けて足す。
    shelfFrame=requestAnimationFrame(()=>{if (tail.getBoundingClientRect().top<innerHeight+400) append();});
  };
  if ('IntersectionObserver' in window) {
    shelfObserver=new IntersectionObserver(entries=>{if (entries.some(e=>e.isIntersecting)) append();},{rootMargin:'0px 0px 400px 0px'});
    shelfObserver.observe(tail);
  } else {
    shelfScrollFallback=()=>{if (tail.getBoundingClientRect().top<innerHeight+400) append();};
    window.addEventListener('scroll',shelfScrollFallback,{passive:true});
    shelfScrollFallback();
  }
}
function renderShelf() {
  stopShelfLoading();
  const all=store.books();
  const q=normName(ui.q);
  const list=sortShelfBooks(all.filter(b=>(!ui.genre || belongsToGenre(b,ui.genre))
    && (!q || normName(`${b.title}${b.author}${b.note}${b.memo}${b.publisher}`).includes(q))),ui.sort,ui.sort==='year' ? ui.yearDirection : ui.addedDirection);
  const shown=list.slice(0,shelfLimit);
  const rows=shelfRows(list,0,shown.length);
  const mode=SHELF_MODES.find(([id])=>id===ui.sort);
  const caption=ui.sort==='year' ? (ui.yearDirection==='asc' ? '刊行の古い順' : '刊行の新しい順')
    : ui.sort==='added' ? (ui.addedDirection==='asc' ? '古く登録した順' : '新しく登録した順') : mode[2];
  const direction=ui.sort==='year' ? ui.yearDirection : ui.addedDirection;
  const genreLabel=(GENRE_GROUP_BY_ID[ui.genre] || GENRE_BY_ID[ui.genre])?.name || '';
  const genreButtons=[['','すべて'],...GENRE_GROUPS.map(g=>[g.id,g.name]),...(ui.genre && !GENRE_GROUP_BY_ID[ui.genre] ? [[ui.genre,genreLabel]] : [])];
  view.innerHTML=`<section class="shelf shelf-sort-${ui.sort}">
    ${pageHead('本棚',`${all.length}冊`)}
    <div class="shelf-tabs" role="group" aria-label="本棚の並べ方">
      ${SHELF_MODES.map(([id,label])=>`<button type="button" class="shelf-mode ${ui.sort===id ? 'on' : ''}" data-act="shelf-mode" data-v="${id}" aria-pressed="${ui.sort===id}">${label}</button>`).join('')}
    </div>
    <label class="search-wrap shelf-search">${icon('search')}<span class="sr-only">本棚を検索</span><input id="shelf-q" type="search" placeholder="本棚を検索" value="${esc(ui.q)}" autocomplete="off"></label>
    ${ui.sort==='genre' ? `<div class="shelf-genres" role="group" aria-label="本棚のジャンル">${genreButtons.map(([id,label])=>`<button type="button" class="genre-filter ${ui.genre===id ? 'on' : ''}" data-act="shelf-filter-genre" data-v="${id}" aria-pressed="${ui.genre===id}">${esc(label)}</button>`).join('')}</div>` : ''}
    ${['year','added'].includes(ui.sort) ? `<div class="shelf-direction" role="group" aria-label="${ui.sort==='year' ? '刊行日' : '登録日'}の並び順">${[['desc',ui.sort==='year' ? '新しい順' : '新しく登録した順'],['asc',ui.sort==='year' ? '古い順' : '古く登録した順']].map(([id,label])=>`<button type="button" data-act="shelf-direction" data-v="${id}" class="direction-btn ${direction===id ? 'on' : ''}" aria-pressed="${direction===id}">${label}<span class="sr-only">（${id==='asc' ? '昇順' : '降順'}）</span></button>`).join('')}</div>` : ''}
    <div class="shelf-bar">
      <div class="shelf-caption"><span>${caption}</span><p class="count" aria-live="polite">${list.length}冊${genreLabel ? ` · ${esc(genreLabel)}` : ''}</p></div>
      <div class="view-switch" role="group" aria-label="本棚の表示"><button type="button" class="icon-btn ${ui.bookView==='grid' ? 'selected' : ''}" data-act="book-view" data-v="grid" aria-label="表紙で見る" aria-pressed="${ui.bookView==='grid'}">${icon('grid')}</button><button type="button" class="icon-btn ${ui.bookView==='list' ? 'selected' : ''}" data-act="book-view" data-v="list" aria-label="一覧で見る" aria-pressed="${ui.bookView==='list'}">${icon('list')}</button></div>
    </div>
    ${ui.genre && ui.sort!=='genre' ? `<button type="button" class="clear-genre" data-act="shelf-filter-genre" data-v="">${esc(genreLabel)} ${icon('close')}<span class="sr-only">絞り込みを解除</span></button>` : ''}
    ${list.length ? `<ul class="books shelf-books ${ui.bookView==='list' ? 'list-view' : 'grid-view'}">${rows}</ul>` : emptyShelf(all.length)}
    ${list.length ? `<p class="shelf-end" role="status" aria-live="polite">${shown.length} / ${list.length}冊</p>` : ''}
  </section>`;
  watchShelfEnd(list);
  revealBooks(view);
}

function emptyShelf(total) {
  if (!total) return `<div class="empty"><p class="empty-title">本棚はまだ空です</p><p>右上の「本を追加」から、次に読みたい本を入れてみましょう。</p></div>`;
  return `<div class="empty"><p class="empty-title">条件に合う本がありません</p><p>ジャンルを切り替えるか、検索の文字を消してください。</p></div>`;
}

// ---------------------------------------------------------------- 本の詳細
function renderSheetBook(id) {
  stopBookPreview();
  stopScanning();
  flushMemo();
  const b = store.get(id);
  if (!b) { closeSheet(); return; }
  const genresOpen = openId === id && !!$('.genre-select')?.open;
  openId = id;
  const isbn = (b.isbn || '').replace(/[^\dXx]/g, ''); // リンクに埋め込むので数字と X 以外は捨てる
  // 国会図書館のリンクは https://ndlsearch.ndl.go.jp/ のものだけ使う（読み込んだバックアップに別の URL があっても飛ばない）
  const ndlLink = /^https:\/\/ndlsearch\.ndl\.go\.jp\/[^\s"'<>]*$/.test(b.ndl || '') ? b.ndl : ndl.ndlSearchUrl(b.title, b.author);
  const q = encodeURIComponent(`${b.title} ${b.author}`);
  const seg = (act, items, cur) => items.map(([v, l]) => `<button type="button" class="seg-btn ${String(cur) === String(v) ? 'on' : ''}" data-act="${act}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('');
  const photos = b.photos?.length ? `写真 ${b.photos.length > 6 ? `#${b.photos[0]}〜#${b.photos[b.photos.length - 1]}（${b.photos.length}枚）` : b.photos.map((n) => `#${n}`).join(' ')}` : '';
  sheetBody.innerHTML = `
    <div class="detail-head">
      ${cover(b.title, b.isbn, 'm', b.coverIsbns || b.coverIsbn || [],b.author)}
      <div class="detail-title">
        <h2>${esc(b.title)}</h2>
        <p class="book-meta cover-caption" hidden></p>
        <p><button type="button" class="link" data-act="author" data-name="${esc(b.author)}">${esc(b.author)}</button></p>
        ${metaLine(b) ? `<p class="muted">${metaLine(b)}</p>` : ''}
        ${b.needsCheck ? '<p class="warn">書誌データが未確認です。書名・著者が合っているか確かめてください。</p>' : ''}
      </div>
    </div>

    <div class="field"><span class="label">読書状態</span><div class="seg">${seg('set-status', STATUS_ORDER.map((s) => [s, STATUS[s].label]), b.status)}</div></div>
    ${b.status === 'done'
    ? `<div class="field two">
        <div><span class="label">評価</span><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${n <= b.rating ? 'on' : ''}" data-act="set-rating" data-v="${n}" aria-label="${n}点">★</button>`).join('')}</div></div>
        <label><span class="label">読み終えた日</span><input id="f-finished" type="date" value="${esc(b.finishedAt)}"></label>
      </div>`
    : `<div class="field"><span class="label">気になり度</span><div class="seg">${seg('set-prio', [[3, '本命'], [2, '気になる'], [1, '見かけた']], b.priority)}</div></div>`}

    <details class="field genre-select" ${genresOpen ? 'open' : ''}><summary>ジャンル<span>${esc((b.genres || []).map((id) => GENRE_BY_ID[id]?.name || '').filter(Boolean).join('、') || '未設定')}</span></summary><div class="chips wrap">${GENRES.map((g) => `<button type="button" class="chip small ${b.genres?.includes(g.id) ? 'on' : ''}" data-act="toggle-genre" data-v="${g.id}" aria-pressed="${!!b.genres?.includes(g.id)}">${esc(g.name)}</button>`).join('')}</div></details>

    <label class="field"><span class="label">メモ・感想</span><textarea id="f-memo" rows="4" placeholder="読んだ感想、気になった理由、誰に勧められたか など">${esc(b.memo)}</textarea></label>

    <div class="field card">
      <span class="label">どこで知ったか</span>
      <p>${esc(SOURCES[b.source] || '')}${b.note ? `：${esc(b.note)}` : ''}</p>
      ${photos ? `<p class="muted small">${esc(photos)}（カメラロール「本」アルバム）</p>` : ''}
    </div>

    <div class="field">
      <span class="label">調べる・買う・借りる</span>
      <div class="links">
        <a href="${esc(ndlLink)}" target="_blank" rel="noopener">国立国会図書館</a>
        ${isbn ? `<a href="https://www.hanmoto.com/bd/isbn/${isbn}" target="_blank" rel="noopener">版元ドットコム</a>` : ''}
        <a href="https://calil.jp/search?q=${q}" target="_blank" rel="noopener">図書館で探す（カーリル）</a>
        <a href="https://www.amazon.co.jp/s?k=${isbn || q}&i=stripbooks" target="_blank" rel="noopener">Amazon</a>
        <a href="https://books.rakuten.co.jp/search?sitem=${q}" target="_blank" rel="noopener">楽天ブックス</a>
      </div>
    </div>

    <details class="field">
      <summary>書名・著者・ISBNを直す</summary>
      <div class="edit-grid">
        <label><span class="label">書名</span><input id="f-title" value="${esc(b.title)}"></label>
        <label><span class="label">著者</span><input id="f-author" value="${esc(b.author)}"></label>
        <label><span class="label">著者の読み（五十音順）</span><input id="f-author-reading" value="${esc(authorReading(b))}" placeholder="例：アヤツジ ユキト"></label>
        <label><span class="label">ISBN（13桁）</span><input id="f-isbn" inputmode="numeric" value="${esc(isbn)}"></label>
        <button type="button" class="primary" data-act="save-edit">直した内容を保存</button>
      </div>
    </details>

    <div class="sheet-foot">
      <button type="button" class="danger" data-act="delete" data-armed="0">本棚から消す</button>
      <span class="muted small">追加 ${esc(b.addedAt || '')}</span>
    </div>`;
  if (!sheet.open) sheet.showModal();
}



function stopScanning() {
  scanController?.abort();
  scanController = null;
  stopScan?.();
  stopScan = null;
}

let memoTimer;
function flushMemo() {
  clearTimeout(memoTimer);
  const memo = $('#f-memo');
  if (memo && openId && store.get(openId)?.memo !== memo.value) store.update(openId, { memo: memo.value });
}

function closeSheet() {
  stopBookPreview();
  flushMemo();
  stopScanning();
  if (sheet.open) sheet.close();
  openId = null;
}

// ---------------------------------------------------------------- 本を登録
function addFromWork(w, extra = {}) {
  const status = extra.status || 'want';
  const sameAuthor = store.books().filter((b) => normName(b.author) === normName(w.authorLabel.split('、')[0]));
  const genres = extra.genres || [...new Set(sameAuthor.flatMap((b) => b.genres || []))].slice(0, 2);
  const b = store.add({
    title: w.main + (w.volume ? ` ${w.volume}` : ''),
    author: extra.author || w.authorLabel.split('、')[0] || '',
    status, priority: 2, genres,
    source: extra.source || 'search', note: extra.note || '',
    coverIsbns:[...w.editions].reverse().map(e=>coverIsbn(e.isbn)).filter(Boolean),
    publishedAt: extra.publishedAt || w.latest?.publishedAt || publicationDate(w.latest?.issued) || '',
    isbn: w.latest?.isbn || '', publisher: w.latest?.publisher || '',
    year: w.firstYear ? String(w.firstYear) : '', format: w.latest?.format || '',
    ndc: w.ndc || '', ndl: w.latest?.link || '',
  });
  toast(`「${mainTitle(b.title)}」を本棚に追加しました`);
  return b;
}

function addFromRelease(raw,publishedAt='') {
    const r={...raw,...confirmedRelease(raw)};
    const existing=store.books().find((b) => normTitle(b.title) === normTitle(r.title) && normName(b.author) === normName(r.author));
    if (existing) {
      store.dismissRelease(r.key);
      toast('すでに本棚にあります');
      return existing;
    }
    const genres = [...new Set(store.books().filter((b) => normName(b.author) === normName(r.author)).flatMap((b) => b.genres || []))].slice(0, 2);
    const soon = r.publishedAt ? r.publishedAt>today() : r.month > today().slice(0, 7);
    const b=store.add({
      title: r.title, author: r.author, status: 'want', priority: 3, genres, source: 'release',
      note: `${monthLabel(r.month)}${soon ? '発売予定' : '発売'}`, publishedAt:publishedAt || r.publishedAt || '', isbn: r.isbn, publisher: r.publisher,
      coverIsbns:r.coverIsbns || [].concat(r.coverIsbn || []).filter(Boolean), coverIsbn:r.coverIsbn || '',

      year: r.month.slice(0, 4), ndc: r.ndc, ndl: r.link, needsCheck: !r.isbn,
    });
    store.dismissRelease(r.key);
    toast(`「${r.title}」を本棚に追加しました`);
    return b;
}

// 書誌プレビュー：読書メモには触れず、タップした本だけを照会する。
function previewOwned(state) {
  return state.work ? shelfIndex()(state.work) : store.books().find(b=>normTitle(b.title)===normTitle(state.book.title) && normName(b.author)===normName(state.book.author));
}
function drawPreviewAction(state) {
  const box=$('#preview-action');
  if (!box || preview!==state) return;
  const owned=previewOwned(state);
  box.innerHTML=owned ? `<button type="button" class="primary" data-act="open" data-id="${esc(owned.id)}">本棚の記録を開く</button>` : '<button type="button" class="primary" data-act="preview-add">本棚に登録</button>';
}
function updatePreviewInfo(state) {
  if (preview!==state || !sheet.open) return;
  const info=state.details,section=$('#preview-summary');
  $('#preview-date').textContent=publicationLabel(info?.publishedAt || state.book.publishedAt);
  section.setAttribute('aria-busy',String(state.loading));
  $('#preview-synopsis').innerHTML=state.loading ? loading('あらすじを読み込んでいます…')
    : info?.synopsis ? `<p class="synopsis-text">${esc(info.synopsis)}</p>`
    : info?.failed ? '<p class="muted">あらすじを取得できませんでした。</p><button type="button" class="ghost small" data-act="preview-retry">もう一度読み込む</button>'
    : '<p class="muted">この本のあらすじは、まだ提供されていません。</p>';
  const url=info?.sourceUrl || '';
  // 出典はあらすじを出せたときだけ（「取得できませんでした」と並ぶと紛らわしい）
  $('#preview-source').innerHTML=!state.loading && info?.synopsis && /^https:\/\/(?:ndlsearch\.ndl\.go\.jp|www\.hanmoto\.com)\/[^\s"'<>]*$/.test(url)
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">出典：${esc(info.source)}</a>` : '';
}
async function requestPreviewInfo(state) {
  state.loading=true; updatePreviewInfo(state);
  try {
    const info=await loadBookDetails(state.book,{signal:state.controller.signal});
    if (preview!==state || state.controller.signal.aborted) return;
    state.details=info; state.loading=false; updatePreviewInfo(state);
  } catch {
    if (preview!==state || state.controller.signal.aborted) return;
    state.details={failed:true}; state.loading=false; updatePreviewInfo(state);
  }
}
function renderBookPreview(book,origin) {
  flushMemo(); stopScanning(); stopBookPreview(); openId=null;
  const state={book,...origin,controller:new AbortController(),details:null,loading:true};
  preview=state;
  sheetBody.innerHTML=`<article class="book-preview">
    <div class="detail-head">${cover(book.title,book.isbn,'m',book.coverIsbns || [],book.author)}<div class="detail-title"><p class="preview-eyebrow">本の情報</p><h2>${esc(book.title)}</h2><p class="book-meta cover-caption" hidden></p>${book.publisher ? `<p class="muted">${esc(book.publisher)}</p>` : ''}</div></div>
    <dl class="preview-facts"><div><dt>著者</dt><dd>${book.author ? `<button type="button" class="link" data-act="author" data-name="${esc(book.author)}">${esc(book.author)}</button>` : '未確認'}</dd></div><div><dt>刊行日</dt><dd><span id="preview-date">${esc(publicationLabel(book.publishedAt))}</span>${book.firstYear ? `<span class="first-pub">最初の刊行は${esc(String(book.firstYear))}年</span>` : ''}</dd></div></dl>
    <section id="preview-summary" class="preview-summary" aria-labelledby="preview-summary-title" aria-busy="true"><h3 id="preview-summary-title">あらすじ</h3><div id="preview-synopsis" aria-live="polite"></div></section>
    <p id="preview-source" class="preview-source"></p><div id="preview-action" class="preview-action"></div>
  </article>`;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop=0;
  drawPreviewAction(state);
  requestPreviewInfo(state);
}
function previewWork(w) {
  if (!w) return;
  const e=w.latest || {};
  const author=w.authorLabel.split('、')[0];
  // 文庫化・新装版などで手元の版が新しいときは、作品が最初に出た年も添える（同じ書名の別の著者の本は数えない）
  const years=w.editions.filter(x=>x.year && (x.creators || []).some(c=>authorMatches(c,author))).map(x=>x.year);
  const firstYear=years.length && e.year > Math.min(...years) ? Math.min(...years) : 0;
  renderBookPreview({title:w.main + (w.volume ? ` ${w.volume}` : ''),author,isbn:e.isbn || '',publisher:e.publisher || '',publishedAt:e.publishedAt || publicationDate(e.issued) || e.month || String(e.year || ''),firstYear,coverIsbns:[...w.editions].reverse().map(x=>x.isbn)},{work:w});
}
function previewRelease(raw) {
  if (!raw) return;
  const book={...raw,...confirmedRelease(raw)};
  book.publishedAt=book.publishedAt || book.month;
  renderBookPreview(book,{release:book});
}

// ---------------------------------------------------------------- バーコードで追加
function renderSheetScan() {
  stopBookPreview();
  flushMemo();
  stopScanning();
  const controller = new AbortController();
  scanController = controller;
  openId = null;
  scanned = [];
  sheetBody.innerHTML = `
    <h2 class="sheet-title">バーコードで追加</h2>
    <div class="scan-box">
      <video id="scan-video" playsinline muted autoplay></video>
      <div class="scan-guide" aria-hidden="true"></div>
    </div>
    <p id="scan-msg" class="scan-msg">カメラを起動しています…</p>
    <form id="isbn-form" class="search-bar" autocomplete="off">
      <input id="isbn-input" inputmode="numeric" placeholder="ISBNを手入力（978から始まる13桁）" enterkeyhint="done">
      <button type="submit" class="primary">追加</button>
    </form>
    <h3 class="sub">読み取った本 <span class="muted" id="scan-count">0冊</span></h3>
    <ul class="books" id="scan-list"></ul>`;
  if (!sheet.open) sheet.showModal();
  const video = $('#scan-video');
  startScanner(video, (isbn) => handleIsbn(isbn), { signal: controller.signal })
    .then((stop) => {
      if (controller.signal.aborted || !sheet.open || $('#scan-video') !== video) { stop(); return; }
      stopScan = stop;
      $('#scan-msg').textContent = '本の裏のバーコード（978で始まる上の段）を枠に入れてください。続けて何冊でも読み取れます。';
    })
    .catch((e) => {
      if (controller.signal.aborted || $('#scan-video') !== video) return;
      const msg = $('#scan-msg');
      if (msg) { msg.textContent = e.message; msg.classList.add('warn'); }
      $('.scan-box')?.classList.add('off');
    });
}

function drawScanned() {
  const list = $('#scan-list');
  if (!list) return;
  $('#scan-count').textContent = `${scanned.filter((s) => s.state === 'added').length}冊`;
  list.innerHTML = scanned.map((s) => {
    const b = s.bookId ? store.get(s.bookId) : null;
    let right = '';
    let sub = '';
    if (s.state === 'loading') sub = '国立国会図書館で調べています…';
    if (s.state === 'added' && b) {
      sub = '本棚に追加しました';
      right = `<button type="button" class="ghost small" data-act="scan-undo" data-isbn="${s.isbn}">取り消す</button>`;
    }
    if (s.state === 'owned' && b) {
      sub = 'すでに本棚にあります';
      right = `<button type="button" class="ghost" data-act="open" data-id="${esc(b.id)}">${stamp(b.status)}</button>`;
    }
    if (s.state === 'notfound') {
      sub = '書誌が見つかりませんでした';
      right = `<button type="button" class="add-btn" data-act="scan-add-raw" data-isbn="${s.isbn}">ISBNだけで追加</button>`;
    }
    if (s.state === 'undone') sub = '取り消しました';
    if (s.state === 'error') sub = s.msg;
    const title = b?.title || s.title || `ISBN ${s.isbn}`;
    return `<li class="book work">${cover(title, s.isbn)}
      <div class="book-main"><div class="book-title">${esc(title)}</div>
        <div class="book-author">${esc(b?.author || s.author || '')}</div>
        <div class="book-meta">${esc(sub)}</div></div>
      <div class="book-side">${right}</div></li>`;
  }).join('');
}

async function handleIsbn(isbn) {
  if (scanned.some((s) => s.isbn === isbn && !['undone', 'error'].includes(s.state))) return;
  navigator.vibrate?.(40);
  const owned = store.books().find((b) => (b.isbn || '').replace(/-/g, '') === isbn);
  const status = 'want'; // 読み取った本はすべて本棚へ（読了などは本の詳細で変える）
  const session = scanController;
  const entry = { isbn, state: owned ? 'owned' : 'loading', bookId: owned?.id || '' };
  scanned = [entry, ...scanned.filter((s) => s.isbn !== isbn)];
  drawScanned();
  if (owned) return;
  try {
    const w = await ndl.searchIsbn(isbn);
    if (session?.signal.aborted || session !== scanController) return;
    const sameWork = w && shelfIndex()(w); // 単行本と文庫のように ISBN が違っても同じ作品なら足さない
    if (!w) {
      entry.state = 'notfound';
    } else if (sameWork) {
      entry.state = 'owned';
      entry.bookId = sameWork.id;
    } else {
      const b = store.add({
        title: w.main + (w.volume ? ` ${w.volume}` : ''), author: w.authorLabel.split('、')[0] || '',
        status, priority: 2, source: 'scan', isbn,
        publisher: w.latest?.publisher || '', year: w.firstYear ? String(w.firstYear) : '',
        format: w.latest?.format || '', ndc: w.ndc || '', ndl: w.latest?.link || '',
      });
      entry.state = 'added';
      entry.bookId = b.id;
    }
  } catch (e) {
    entry.state = 'error';
    entry.msg = e.message;
  }
  drawScanned();
}

// ---------------------------------------------------------------- 著者で探す
function authorCounts() {
  const m = new Map();
  for (const b of store.books()) if (b.author) m.set(b.author, (m.get(b.author) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
}

// ISO の時刻（世界標準時）を端末の時刻で「10/13 19:50」と表示する
const localTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const searchBar = (name) => `<form id="author-form" class="search-bar author-search" autocomplete="off">
    <label class="search-wrap">${icon('search')}<span class="sr-only">著者名</span><input id="author-q" type="search" placeholder="著者の名前で探す" value="${esc(name)}" enterkeyhint="search"></label>
    <button type="submit" class="primary">探す</button>
  </form>`;

// 著者タブのはじめの画面：フォロー中の著者の新刊・近刊と、本棚の著者
function renderAuthorHome() {
  const follows = store.follows();
  const thisMonth = today().slice(0, 7);
  const rel = [...store.releases()].sort((a, b) => b.month.localeCompare(a.month));
  const shelfAuthors = authorCounts();
  const candidates = shelfAuthors.filter(([n, c]) => c >= 2 && !store.isFollowing(n));
  const last = follows.map((f) => f.lastChecked).filter(Boolean).sort().pop();
  const relRow = (raw) => { const r={...raw,...confirmedRelease(raw)}; const soon=r.publishedAt ? r.publishedAt>today() : r.month>thisMonth; return `<li class="book work" data-reveal-key="${esc(`release:${r.key}`)}">
      <button type="button" class="work-open" data-act="release-detail" data-key="${esc(r.key)}" aria-label="${esc(r.title)}の本の情報">
        ${cover(r.title, r.isbn, 's', r.coverIsbns || r.coverIsbn || [],r.author)}
        <span class="book-main">
          <span class="book-title">${newKeys.has(r.key) ? '<span class="new">NEW</span>' : ''}${esc(r.title)}</span>
          <span class="book-author">${esc(r.author)}</span>
          <span class="book-meta"><b class="${soon ? 'soon' : ''}">${esc(monthLabel(r.month))}${soon ? '発売予定' : '発売'}</b>${r.publisher ? `・${esc(r.publisher)}` : ''}</span>
          <span class="book-meta cover-caption" ${coverCandidates(r.isbn,r.coverIsbns || r.coverIsbn || []).length || r.month<=thisMonth ? 'hidden' : ''}>表紙未取得</span>
        </span>
      </button>
      <div class="book-side">
        <button type="button" class="add-btn" data-act="release-add" data-key="${esc(r.key)}">＋登録</button>
        <button type="button" class="ghost small" data-act="release-dismiss" data-key="${esc(r.key)}" aria-label="この本を一覧から消す">表示しない</button>
      </div>
    </li>`; };
  const status = checking
    ? loading(`フォロー中の著者の新刊を調べています（${checking.total}人中${checking.done}人）…`)
    : `<p class="muted small">フォロー中 ${follows.length}人${last ? ` ・ 最終チェック ${esc(localTime(last))}` : ''}</p>`;
  view.innerHTML = `
    <section>
      ${pageHead('著者')}
      ${searchBar('')}
      <h2 class="sub">新着・発売予定 <span class="muted">フォロー中の著者</span></h2>
      ${follows.length ? `${status}${checkError && !checking ? errorBox(checkError) : ''}
        ${rel.length ? `<ul class="books">${rel.map(relRow).join('')}</ul>`
    : `<p class="muted">${checking ? '' : 'ここ2か月以内に出た本と、これから出る本はまだ見つかっていません。'}</p>`}
        <div class="row"><button type="button" class="ghost small" data-act="check-releases" ${checking ? 'disabled' : ''}>今すぐ新刊をチェック</button></div>`
    : `<p class="lead">好きな著者をフォローして、新刊をこの場所に。著者の検索結果からフォローできます。</p>`}
      ${candidates.length ? `<div class="card follow-suggest">
          <h3>本棚でよく読む著者</h3><p>${candidates.length}人の新刊をまとめてチェックできます。</p>
          <p class="muted small">${candidates.slice(0, 12).map(([n]) => esc(n)).join('、')}${candidates.length > 12 ? ' ほか' : ''}</p>
          <button type="button" class="primary" data-act="follow-shelf-authors">${candidates.length}人をフォローする</button>
        </div>` : ''}
      ${follows.length ? `<h3 class="sub">フォロー中の著者</h3><div class="chips wrap">${follows.map((f) => `<button type="button" class="chip following" data-act="author" data-name="${esc(f.name)}">${esc(f.name)}</button>`).join('')}</div>` : ''}
      <h3 class="sub">本棚の著者</h3>
      <div class="chips wrap author-chips">${shelfAuthors.slice(0, 40).map(([n, c]) => `<button type="button" class="chip" data-act="author" data-name="${esc(n)}">${esc(n)}<span class="n">${c}</span></button>`).join('') || '<p class="muted">本棚に本が入ると、ここに著者が並びます。</p>'}</div>
      <details class="source"><summary>新刊のお知らせについて</summary><p>アプリを開いたときに新刊を確認します。書誌データは国立国会図書館サーチの出版情報を使用しています。スマホのプッシュ通知は未対応です。</p></details>
    </section>`;
  revealBooks(view);
}

function renderAuthor(name) {
  const token = ++renderToken;
  if (!name) { renderAuthorHome(); hydrateReleaseCovers(); return; }
  view.innerHTML = `
    <section>
      ${searchBar(name)}
      <div id="author-result">${loading(`${name} の作品を国立国会図書館サーチで調べています…`)}</div>
    </section>`;
  ndl.searchAuthor(name).then((works) => {
    if (token !== renderToken) return;
    lastAuthor = { name, works };
    drawAuthorResult(name, works);
  }).catch((e) => {
    if (token !== renderToken) return;
    $('#author-result').innerHTML = errorBox(e.message);
  });
}

function drawAuthorResult(name, works) {
  const owned = shelfIndex();
  const litShare = works.length ? works.filter((w) => w.isLit).length / works.length : 0;
  const visible = works.filter((w) => !w.isComic
    && (ui.showAntho || !w.isAnthology)
    && (ui.showOther || litShare < 0.6 || w.isLit));
  const rows = visible.map((w) => ({ w, o: owned(w) }));
  const done = rows.filter((r) => r.o?.status === 'done').length;
  const onShelf = rows.filter((r) => r.o && r.o.status !== 'done').length;
  const unknown = rows.filter((r) => !r.o).length;
  const shown = ui.notOnShelf ? rows.filter((r) => !r.o)
    : ui.unreadOnly ? rows.filter((r) => r.o?.status !== 'done') : rows;
  const toggle = (key, label) => `<button type="button" class="chip small ${ui[key] ? 'on' : ''}" data-act="toggle-ui" data-v="${key}" aria-pressed="${ui[key]}">${label}</button>`;
  $('#author-result').innerHTML = `
    <div class="result-head">
      <div class="result-title">
        <h2 class="result-name">${esc(name)}</h2>
        <button type="button" class="follow-btn ${store.isFollowing(name) ? 'on' : ''}" data-act="toggle-follow" data-name="${esc(name)}" aria-pressed="${store.isFollowing(name)}">${store.isFollowing(name) ? 'フォロー中' : '新刊をフォロー'}</button>
      </div>
      <p class="tally"><b>${visible.length}</b>作品 ・ 読了 <b>${done}</b> ・ 本棚で未読 <b>${onShelf}</b> ・ まだ登録していない <b class="accent">${unknown}</b></p>
      <div class="chips wrap">${toggle('unreadOnly', '未読だけ')}${toggle('notOnShelf', '本棚にない本だけ')}${litShare >= 0.6 ? toggle('showOther', '小説以外も') : ''}${toggle('showAntho', 'アンソロジー・共著も')}</div>
    </div>
    ${shown.length ? `<ul class="books">${shown.map((r) => workRow(r.w, r.o)).join('')}</ul>`
    : `<div class="empty"><p class="empty-title">${works.length ? '未読の作品はありません' : '作品が見つかりませんでした'}</p><p>${works.length ? '「未読だけ」を外すと読了の作品も表示します。' : '著者名の漢字や表記（姓と名の間の・など）を確認してください。'}</p></div>`}
    <p class="source">出典：国立国会図書館サーチ（国立国会図書館の所蔵資料）。刊行直後の新刊は載るまで数週間かかることがあります。</p>`;
  revealBooks($('#author-result'));
}

// ---------------------------------------------------------------- 新刊チェック
function updateBadge() {
  const n = store.releases().filter((r) => !r.seen).length;
  const b = $('#badge-author');
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = !n;
}

function refreshReleaseUI() {
  if (route.name === 'author' && !route.arg) {
    store.releases().filter((r) => !r.seen).forEach((r) => newKeys.add(r.key));
    store.markReleasesSeen();
    renderAuthorHome();
  }
  updateBadge();
}

// フォロー中の著者を 1 人ずつ調べ、ここ 2 か月に出た本と発売予定の本で、本棚に無いものを新刊として残す
async function checkReleases(names) {
  names.forEach((name) => pendingReleaseNames.add(name));
  if (checking || !pendingReleaseNames.size) return;
  checking = { done: 0, total: pendingReleaseNames.size };
  checkError = '';
  refreshReleaseUI();
  const from = monthsAgo(2);
  let found = 0;
  while (pendingReleaseNames.size) {
    const name = pendingReleaseNames.values().next().value;
    pendingReleaseNames.delete(name);
    if (!store.isFollowing(name)) continue;
    try {
      const works = await ndl.searchReleases(name, from);
      if (!store.isFollowing(name)) continue;
      const owned = shelfIndex();
      const items = works.filter((w) => !owned(w)).map((w) => ({
        key: `${normTitle(w.main + (w.volume || ''))}|${normName(name)}`,
        title: w.main + (w.volume ? ` ${w.volume}` : ''), baseTitle:w.main, volume:w.volume || '', author: name, month: w.lastMonth,
        publisher: w.latest?.publisher || '', isbn: w.latest?.isbn || '', link: w.latest?.link || '', ndc: w.ndc || '',
      }));
      for (const it of items.filter(x=>!x.isbn || x.month>=today().slice(0,7))) {
        if (!store.isFollowing(name)) break;
        try { Object.assign(it,await resolveReleaseCovers(it)); } catch { /* 書誌の新刊確認は続ける */ }
      }
      found += store.addReleases(name, items);
    } catch (e) {
      checkError = e.message;
    }
    checking.done += 1;
    checking.total = checking.done + pendingReleaseNames.size;
    refreshReleaseUI();
  }
  checking = null;
  refreshReleaseUI();
  if (found) toast(`フォロー中の著者の新刊・近刊が${found}冊見つかりました（著者タブ）`);
}

async function resolveReleaseCovers(item) {
  const confirmed=confirmedRelease(item);
  const release={...item,...confirmed};
  const identity=releaseIdentity(release);
  const works=await ndl.searchTitle(identity.base,item.author,{allSources:true});
  const isbn=currentReleaseIsbn(release,works);
  if (isbn) release.isbn=isbn;
  let coverIsbns=previousCoverIsbns(release,works);
  // 旧版の副題が「爆弾 2」、新刊が「爆弾2」のように異なり、NDLの書名検索で漏れる場合。
  const broader=identity.base.match(/^(.{2,})\s+[^\s]*\d+$/)?.[1];
  if (!coverIsbns.length && broader && broader!==identity.base) {
    const editions=await ndl.searchTitle(broader,item.author,{allSources:true});
    coverIsbns=previousCoverIsbns(release,editions); // 候補を広げても書名・巻・著者の一致は保つ
  }
  return {...confirmed,...(isbn ? {isbn} : {}),coverIsbns,coverIsbn:coverIsbns[0] || '',coverCheckedAt:new Date().toISOString(),coverLookupVersion:COVER_LOOKUP_VERSION};
}
let hydratingReleaseCovers=null;
function hydrateReleaseCovers() {
  if (hydratingReleaseCovers) return hydratingReleaseCovers;
  const items=store.releases().filter(r=>store.isFollowing(r.author)
    && (r.coverLookupVersion!==COVER_LOOKUP_VERSION || !r.coverCheckedAt || Date.now()-Date.parse(r.coverCheckedAt)>7*24*3600*1000));
  hydratingReleaseCovers=(async()=>{
    for (const item of items) {
      if ((route.name==='search' && ui.searchQ) || sheet.open) break; // 手入力/検索を待たせず、著者画面へ戻ったとき再開する
      if (!store.isFollowing(item.author) || !store.releases().some(r=>r.key===item.key)) continue;
      try {
        const patch=await resolveReleaseCovers(item);
        if (store.isFollowing(item.author)) store.updateReleaseCovers(item.key,patch);
      } catch { /* 一時的な通信エラーでは更新済み扱いにせず、次回に試す */ }
    }
  })().finally(()=>{hydratingReleaseCovers=null;});
  return hydratingReleaseCovers;
}

const staleFollows = () => store.follows()
  .filter((f) => !f.lastChecked || Date.now() - Date.parse(f.lastChecked) > 12 * 3600 * 1000).map((f) => f.name);

// ---------------------------------------------------------------- 検索：書名・著者・ISBN で探して本棚に登録する
const SEARCH_KINDS = [['all', 'すべて'], ['title', '書名'], ['author', '著者'], ['isbn', 'ISBN']];
const SEARCH_PLACEHOLDER = { all: '書名・著者・ISBN', title: '書名', author: '著者の名前', isbn: '978から始まる13桁' };
const SCAN_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 8v8M9.5 8v8M12 8v8M15 8v8M17 8v8" stroke="currentColor" stroke-width="1.6"/></svg>';

const manualAdd = (q = '') => `<details class="manual-add">
    <summary>見つからない本を手入力で登録</summary>
    <form id="manual-form" class="add-form" autocomplete="off">
      <label><span class="label">書名</span><input id="m-title" required value="${esc(isbn13(q) ? '' : q)}"></label>
      <label><span class="label">著者</span><input id="m-author"></label>
      <button type="submit" class="primary">登録する</button>
    </form>
  </details>`;

function renderSearch() {
  const kinds = SEARCH_KINDS.map(([id, label]) => `<button type="button" class="shelf-mode ${ui.searchKind === id ? 'on' : ''}" data-act="search-kind" data-v="${id}" aria-pressed="${ui.searchKind === id}">${label}</button>`).join('');
  view.innerHTML = `<section class="search-page">
    ${pageHead('検索', '書名・著者・ISBN')}
    <div class="shelf-tabs search-kinds" role="group" aria-label="検索する項目">${kinds}</div>
    <form id="book-search-form" class="search-bar book-search" role="search" autocomplete="off">
      <label class="search-wrap">${icon('search')}<span class="sr-only">${SEARCH_PLACEHOLDER[ui.searchKind]}</span><input id="book-q" type="search" placeholder="${SEARCH_PLACEHOLDER[ui.searchKind]}" value="${esc(ui.searchQ)}" enterkeyhint="search" ${ui.searchKind === 'isbn' ? 'inputmode="numeric"' : ''}></label>
      <button type="submit" class="primary">検索</button>
    </form>
    <button type="button" class="scan-btn" data-act="open-scan">${SCAN_ICON}バーコードで読み取る</button>
    <div id="search-result"></div>
  </section>`;
  if (ui.searchQ) runBookSearch();
  else loadRecommendations();
}

// ---------------------------------------------------------------- おすすめ（検索する前に表示）
const dayIndex = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);

// 著者を 1 人ずつ調べ、届いた分から表示する。検索を始めたり別の画面へ移ったら止め、戻ったら続きから。
async function loadRecommendations() {
  const books = store.books();
  const shift = dayIndex() + (ui.recShift || 0);
  const plan = recommendPlan(books, shift);
  const sig = `${shift}|${plan.jobs.map((j) => j.name).join(',')}`;
  if (!recState || recState.sig !== sig) recState = { sig, plan, results: [], running: false, error: '' };
  const state = recState;
  const seq = ++recSeq;
  state.running = state.results.filter(Boolean).length < plan.jobs.length;
  drawRecommendations();
  for (const [i, job] of plan.jobs.entries()) {
    if (state.results[i]) continue;
    if (seq !== recSeq || route.name !== 'search' || ui.searchQ) { state.running = false; return; }
    try {
      state.results[i] = { job, works: await ndl.searchAuthor(job.name) };
    } catch (e) {
      state.error = e.message;
      state.results[i] = { job, works: [] };
    }
    if (seq === recSeq) drawRecommendations();
  }
  state.running = false;
  if (seq === recSeq) drawRecommendations();
}

function drawRecommendations() {
  const box = $('#search-result');
  if (!box || ui.searchQ || route.name !== 'search' || !recState) return;
  const { plan, results, running, error } = recState;
  if (!store.books().length) {
    box.innerHTML = `<div class="empty"><p class="empty-title">本棚に本が入ると、おすすめが出ます</p><p>上の検索やバーコードで、まず何冊か登録してみてください。</p></div>${manualAdd()}`;
    return;
  }
  const done = results.filter(Boolean).length;
  const items = pickRecommendations(results, { owned: shelfIndex(), hidden: new Set(store.hiddenRecs()), shelfTitles: shelfTitleMap(store.books()) });
  box.innerHTML = `<section class="recs" aria-labelledby="recs-title">
      <div class="recs-head"><h2 id="recs-title">あなたへのおすすめ</h2><button type="button" class="ghost small" data-act="rec-more" ${running ? 'disabled' : ''}>別のおすすめ</button></div>
      <p class="recs-taste">本棚の傾向：${plan.taste.map(esc).join('・')}</p>
      ${running ? loading(`本棚の傾向からおすすめを集めています（${plan.jobs.length}人中${done}人）…`) : ''}
      ${items.length ? `<ul class="books">${items.map(({ w, reason }) => workRow(w, null, '登録', { reason, hideKey: w.key })).join('')}</ul>`
    : (running ? '' : `${error ? errorBox(error) : ''}<div class="empty"><p class="empty-title">いまはおすすめがありません</p><p>「別のおすすめ」で、ほかの著者の本から探します。</p></div>`)}
      <p class="source">よく読む著者と、本棚に多いジャンルの著者から、まだ本棚にない本を選んでいます。出典：国立国会図書館サーチ</p>
    </section>${manualAdd()}`;
  revealBooks(box);
}

async function runBookSearch() {
  const q = ui.searchQ.trim();
  const kind = ui.searchKind;
  const box = $('#search-result');
  if (!q || !box) return;
  const seq = ++searchSeq; // 続けて検索したとき、遅れて届いた前の結果で上書きしない
  if (lastSearch && lastSearch.q === q && lastSearch.kind === kind && !lastSearch.error) { drawSearchResult(); return; }
  const token = renderToken;
  box.innerHTML = loading('国立国会図書館サーチで探しています…');
  let result;
  try {
    const isbn = isbn13(q);
    let works;
    if (kind === 'isbn' || (kind === 'all' && isbn)) {
      if (!isbn) throw new Error('978か979から始まる13桁のISBNを入力してください。');
      const w = await ndl.searchIsbn(isbn);
      works = w ? [w] : [];
    } else if (kind === 'author') works = await ndl.searchAuthor(q);
    else if (kind === 'title') works = await ndl.searchTitle(q);
    else works = await ndl.searchAny(q);
    result = { q, kind, works: works.filter((w) => !w.isComic).slice(0, 60) };
  } catch (e) {
    result = { q, kind, works: [], error: e.message };
  }
  if (token !== renderToken || seq !== searchSeq) return; // 別の画面へ移った・新しい検索をした後の結果は描かない
  lastSearch = result;
  drawSearchResult();
}

function drawSearchResult() {
  const box = $('#search-result');
  if (!box || !lastSearch) return;
  const { q, kind, works, error } = lastSearch;
  if (error) { box.innerHTML = errorBox(error) + manualAdd(q); return; }
  const owned = shelfIndex();
  const authorLink = kind === 'author' ? `<a class="author-link" href="#author/${encodeURIComponent(q)}">${esc(q)}の著者ページ（フォロー・未読だけの表示）${icon('arrow')}</a>` : '';
  box.innerHTML = works.length
    ? `<p class="count">${works.length}件${works.length >= 60 ? '（上位60件）' : ''}</p>${authorLink}
      <ul class="books">${works.map((w) => workRow(w, owned(w), '登録')).join('')}</ul>${manualAdd(q)}
      <p class="source">出典：国立国会図書館サーチ</p>`
    : `<div class="empty"><p class="empty-title">見つかりませんでした</p><p>言葉を短くするか、上の「書名・著者・ISBN」を切り替えてください。</p></div>${manualAdd(q)}`;
  revealBooks(box);
}

// ---------------------------------------------------------------- 読書の記録：本と読了日を履歴として並べる。
function renderStats() {
  const all = store.books();
  const done = all.filter((b) => b.status === 'done').sort((a,b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
  const years = [...new Set(done.map((b) => (b.finishedAt || '').slice(0,4)).filter(Boolean))].sort().reverse();
  const shown = ui.historyYear === 'all' ? done : done.filter((b) => (b.finishedAt || '').startsWith(ui.historyYear));
  let lastMonth = '';
  const rows = shown.map((b) => {
    const month = b.finishedAt ? b.finishedAt.slice(0,7) : 'unknown';
    let heading = '';
    if (month !== lastMonth) { lastMonth = month; heading = `<li class="history-month">${month === 'unknown' ? '読了日未登録' : esc(monthLabel(month))}</li>`; }
    return `${heading}<li class="book history-book" role="button" tabindex="0" data-act="open" data-id="${esc(b.id)}" aria-label="${esc(b.title)}の読書記録">
      <span class="finished-day">${b.finishedAt ? Number(b.finishedAt.slice(8,10)) : '—'}<small>${b.finishedAt ? '日' : ''}</small></span>
      ${cover(b.title,b.isbn,'s',b.coverIsbns || b.coverIsbn || [],b.author)}<div class="book-main"><div class="book-title">${esc(b.title)}</div><div class="book-author">${esc(b.author)}</div>
        ${b.memo ? `<p class="history-memo">${esc(b.memo)}</p>` : ''}${b.rating ? `<span class="rating">${stars(b.rating)}</span>` : ''}</div>${icon('arrow')}
    </li>`;
  }).join('');
  view.innerHTML = `<section class="history">
    ${pageHead('読書の記録', `${done.length}冊を読了`)}
    <div class="history-intro"><p>読み終えた本と、その日の記録。</p>${years.length ? `<div class="shelf-genres history-years" role="group" aria-label="記録する年">${[['all', 'すべて'], ...years.map((y) => [y, `${y}年`])].map(([v, l]) => `<button type="button" class="genre-filter ${ui.historyYear === v ? 'on' : ''}" data-act="history-year" data-v="${esc(v)}" aria-pressed="${ui.historyYear === v}">${esc(l)}</button>`).join('')}</div>` : ''}</div>
    ${rows ? `<ul class="books history-list">${rows}</ul>` : '<div class="empty"><span class="empty-icon">'+icon('book')+'</span><h2>まだ読了の記録がありません</h2><p>本の詳細で「読了」を選ぶと、<br>読み終えた日と一緒にここへ並びます。</p><a href="#shelf" class="primary">本棚を開く</a></div>'}
    <details class="backup-panel"><summary><span>データのバックアップ</span><span class="muted">${all.length}冊</span></summary>
      <p>本棚はこのブラウザに保存されています。機種変更の前に、バックアップを書き出しておけます。</p>
      <div class="row"><button type="button" class="primary" data-act="export">バックアップを書き出す</button><label class="ghost file-btn">バックアップから戻す<input id="import-file" type="file" accept="application/json,.json"></label></div>
      <p class="muted small">更新 ${esc(localTime(store.snapshot().updatedAt))}</p>
    </details><p class="app-footer">読書手帖 <span>${APP_VERSION}</span><button type="button" class="link" data-act="versions">バージョン履歴</button></p>
  </section>`;
}

function renderVersionHistory() {
  stopBookPreview();
  stopScanning(); flushMemo(); openId=null;
  sheetBody.innerHTML=`<h2 class="sheet-title">バージョン履歴</h2><ol class="version-history">${VERSION_HISTORY.map(v=>`<li><div class="version-heading"><h3>${esc(v.version)}</h3><time datetime="${esc(v.date)}">${esc(v.date)}</time></div><ul>${v.changes.map(c=>`<li>${esc(c)}</li>`).join('')}</ul></li>`).join('')}</ol><a class="link" href="https://github.com/Hedficr-cyber/dokusho-techo/commits/main/" target="_blank" rel="noopener noreferrer">GitHubの変更履歴を見る</a>`;
  if (!sheet.open) sheet.showModal();
}

function exportBackup() {
  const data = store.snapshot();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `読書手帖_バックアップ_${today()}.json`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('バックアップを書き出しました');
}

async function importBackup(file) {
  try {
    if (file.size>10*1024*1024) throw new Error('バックアップが大きすぎます');
    const data = store.prepareBackup(JSON.parse(await file.text()));
    const n = data.books?.length ?? 0;
    stopBookPreview(); flushMemo(); stopScanning(); openId=null;
    sheetBody.innerHTML = `<h2 class="sheet-title">バックアップから戻す</h2>
      <p>「${esc(file.name)}」の${n}冊で、いまの本棚（${store.books().length}冊）を置き換えます。いまの本棚は元に戻せません。</p>
      <div class="row"><button type="button" class="danger" data-act="confirm-import">置き換える</button><button type="button" class="ghost" data-act="close">やめる</button></div>`;
    importBackup.pending = data;
    sheet.showModal();
  } catch {
    toast('読み込めませんでした。読書手帖で書き出したファイルを選んでください');
  }
}

// ---------------------------------------------------------------- 画面切り替え
const TITLES = { shelf: '本棚', author: '著者', search: '検索', stats: '読書の記録' };

function render() {
  stopShelfLoading();
  ++renderToken; // 別タブへ移動したら、前の画面の検索結果は描画しない
  workCache = new Map();
  const { name, arg } = route;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.tab === name ? 'page' : 'false'));
  $('#view-title').textContent = TITLES[name] || '';
  $('#fab').hidden = false;
  document.body.dataset.page = name;
  if (name === 'author') {
    if (!arg) newKeys = new Set(store.releases().filter((r) => !r.seen).map((r) => r.key));
    renderAuthor(arg);
    if (!arg) store.markReleasesSeen();
  }
  else if (name === 'search') renderSearch();
  else if (name === 'stats') renderStats();
  else renderShelf();
}

function onHash() {
  if (preview) closeSheet();
  let [name, ...rest] = location.hash.replace(/^#/, '').split('/');
  if (name === 'genre') { name = 'search'; rest = []; } // ジャンル画面は検索に置き換えた
  let arg='';
  try { arg=decodeURIComponent(rest.join('/') || ''); } catch { /* 壊れたURLは空の画面引数に戻す */ }
  route = { name: TITLES[name] ? name : 'shelf', arg };
  render();
  window.scrollTo(0, 0);
}

// 本棚が変わったとき、入力中でなければ今の画面を描き直す
store.subscribe((ev) => {
  if (ev.type === 'save-error') { toast('保存できませんでした。端末の空き容量を確認してください'); return; }
  updateBadge();
  if (ev.type==='release-covers') {if (route.name==='author' && !route.arg) renderAuthorHome();return;}
  if (route.name === 'author' && !route.arg) { renderAuthorHome(); return; }
  if (route.name === 'shelf' || route.name === 'stats') {
    const focused = document.activeElement?.id;
    render();
    if (focused === 'shelf-q') { const el = $('#shelf-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  } else if (route.name === 'author' && lastAuthor?.name === route.arg && $('#author-result')) {
    drawAuthorResult(lastAuthor.name, lastAuthor.works);
  } else if (route.name === 'search') (ui.searchQ ? drawSearchResult() : drawRecommendations()); // 登録した本を印に替える・おすすめから外す
});

// ---------------------------------------------------------------- 操作
const actions = {
  'versions': renderVersionHistory,
  'work-detail': el=>previewWork(workCache.get(el.dataset.key)),
  'release-detail': el=>previewRelease(store.releases().find(r=>r.key===el.dataset.key)),
  'preview-retry': ()=>{if (preview && !preview.loading) requestPreviewInfo(preview);},
  'preview-add': ()=>{
    const state=preview;
    if (!state || previewOwned(state)) return;
    const publishedAt=state.details?.publishedAt || state.book.publishedAt;
    if (state.release) addFromRelease(state.release,publishedAt);
    else addFromWork(state.work,{source:'search',publishedAt});
    drawPreviewAction(state);
  },
  'shelf-mode': (el) => { ui.sort=el.dataset.v; shelfLimit=24; saveUi(); renderShelf(); },
  'shelf-filter-genre': (el) => { ui.genre=el.dataset.v; shelfLimit=24; saveUi(); renderShelf(); },
  'book-view': (el) => { ui.bookView = el.dataset.v; saveUi(); renderShelf(); },
  'shelf-direction': (el) => { ui[ui.sort==='year' ? 'yearDirection' : 'addedDirection']=el.dataset.v; shelfLimit=24; saveUi(); renderShelf(); },
  open: (el) => renderSheetBook(el.dataset.id),
  close: () => closeSheet(),
  author: (el) => { closeSheet(); location.hash = `#author/${encodeURIComponent(el.dataset.name)}`; },
  'set-status': (el) => {
    store.update(openId, { status: el.dataset.v });
    renderSheetBook(openId);
  },
  'set-prio': (el) => { store.update(openId, { priority: Number(el.dataset.v) }); renderSheetBook(openId); },
  'set-rating': (el) => {
    const b = store.get(openId);
    const v = Number(el.dataset.v);
    store.update(openId, { rating: b.rating === v ? 0 : v });
    renderSheetBook(openId);
  },
  'toggle-genre': (el) => {
    const b = store.get(openId);
    const set = new Set(b.genres || []);
    set.has(el.dataset.v) ? set.delete(el.dataset.v) : set.add(el.dataset.v);
    store.update(openId, { genres: [...set] });
    renderSheetBook(openId);
  },
  'save-edit': () => {
    const isbn = $('#f-isbn').value.replace(/[^\dXx]/g, '');
    store.update(openId, { title: $('#f-title').value.trim(), author: $('#f-author').value.trim(), authorReading: $('#f-author-reading').value.trim(), isbn, needsCheck: false });
    renderSheetBook(openId);
    toast('保存しました');
  },
  delete: (el) => {
    if (el.dataset.armed !== '1') {
      el.dataset.armed = '1';
      el.textContent = 'もう一度押すと消します';
      setTimeout(() => { if (el.isConnected) { el.dataset.armed = '0'; el.textContent = '本棚から消す'; } }, 4000);
      return;
    }
    const b = store.get(openId);
    store.remove(openId);
    closeSheet();
    toast(`「${mainTitle(b.title)}」を本棚から消しました`);
  },
  'add-work': (el) => {
    const w = workCache.get(el.dataset.key);
    if (!w) return;
    const onSearch = route.name === 'search';
    const author = route.name === 'author' ? route.arg : (onSearch && ui.searchKind === 'author' ? ui.searchQ.trim() : undefined);
    const b = addFromWork(w, { author, source: 'search', status: 'want' });
    if (el.isConnected) el.closest('.book-side').innerHTML = ownedButton(b);
  },
  'search-kind': (el) => {
    ui.searchKind = el.dataset.v;
    saveUi();
    const q = $('#book-q')?.value ?? ui.searchQ;
    ui.searchQ = q;
    renderSearch();
  },
  'rec-more': () => { ui.recShift = (ui.recShift || 0) + 1; saveUi(); loadRecommendations(); },
  'rec-hide': (el) => { store.hideRec(el.dataset.key); },
  'history-year': (el) => { ui.historyYear = el.dataset.v; saveUi(); renderStats(); },
  'toggle-ui': (el) => {
    ui[el.dataset.v] = !ui[el.dataset.v];
    saveUi();
    if (route.name === 'author' && lastAuthor?.name === route.arg) drawAuthorResult(lastAuthor.name, lastAuthor.works);
  },
  'pick-random': () => {
    const pool = store.books().filter((b) => b.status === 'want' || b.status === 'tsundoku');
    if (!pool.length) { toast('読みたい本・積読がありません'); return; }
    const weighted = pool.flatMap((b) => Array(b.status === 'tsundoku' ? 4 : b.priority || 1).fill(b));
    renderSheetBook(weighted[Math.floor(Math.random() * weighted.length)].id);
  },
  export: () => exportBackup(),
  'confirm-import': () => {
    try {
      store.replaceAll(importBackup.pending);
      toast('バックアップから戻しました');
    } catch (e) {
      toast(e.message);
    }
    closeSheet();
  },
  add: () => {
    closeSheet();
    if (route.name !== 'search') location.hash = '#search';
    setTimeout(() => $('#book-q')?.focus(), 80);
  },



  // バーコード
  'open-scan': () => renderSheetScan(),
  'scan-undo': (el) => {
    const s = scanned.find((x) => x.isbn === el.dataset.isbn);
    if (s?.bookId) store.remove(s.bookId);
    if (s) s.state = 'undone';
    drawScanned();
  },
  'scan-add-raw': (el) => {
    const s = scanned.find((x) => x.isbn === el.dataset.isbn);
    const b = store.add({ title: `ISBN ${el.dataset.isbn}`, isbn: el.dataset.isbn, status: 'want', source: 'scan', needsCheck: true });
    if (s) { s.state = 'added'; s.bookId = b.id; }
    drawScanned();
  },

  // 著者のフォローと新刊
  'toggle-follow': (el) => {
    const name = el.dataset.name;
    if (store.isFollowing(name)) {
      store.unfollow(name);
      toast(`${name}のフォローをやめました`);
    } else {
      store.follow(name);
      toast(`${name}をフォローしました。新刊を調べます`);
      checkReleases([name]);
    }
  },
  'follow-shelf-authors': () => {
    const names = authorCounts().filter(([n, c]) => c >= 2 && !store.isFollowing(n)).map(([n]) => n);
    names.forEach((n) => store.follow(n));
    toast(`${names.length}人をフォローしました。新刊を順に調べます`);
    checkReleases(names);
  },
  'check-releases': () => checkReleases(store.follows().map((f) => f.name)),
  'release-add': (el) => {
    const r=store.releases().find(x=>x.key===el.dataset.key);
    if (r) addFromRelease(r);
  },
  'release-dismiss': (el) => store.dismissRelease(el.dataset.key),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-act]')) {
    e.preventDefault();
    e.target.click();
  }
});

let typing;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'shelf-q') {
    clearTimeout(typing);
    typing = setTimeout(() => { ui.q = t.value; shelfLimit = 24; saveUi(); renderShelf(); const el = $('#shelf-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 200);
  }
  if (t.id === 'book-q' && !t.value.trim() && ui.searchQ) {
    ui.searchQ = '';
    saveUi();
    ++searchSeq; // 途中の検索結果は描かない
    loadRecommendations();
  }
  if (t.id === 'f-memo') {
    clearTimeout(memoTimer);
    const id = openId;
    const memo = t.value;
    memoTimer = setTimeout(() => store.update(id, { memo }), 400);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'f-finished') store.update(openId, { finishedAt: t.value });
  if (t.id === 'f-memo') store.update(openId, { memo: t.value });
  if (t.id === 'import-file' && t.files?.[0]) importBackup(t.files[0]);
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'author-form') {
    e.preventDefault();
    const name = $('#author-q').value.trim();
    if (name) location.hash = `#author/${encodeURIComponent(name)}`;
  }
  if (e.target.id === 'book-search-form') {
    e.preventDefault();
    ui.searchQ = $('#book-q').value.trim();
    saveUi();
    $('#book-q').blur(); // スマホのキーボードを閉じて結果を見せる
    runBookSearch();
  }
  if (e.target.id === 'manual-form') {
    e.preventDefault();
    const title = $('#m-title').value.trim();
    if (!title) { $('#m-title').focus(); return; }
    store.add({ title, author: $('#m-author').value.trim(), status: 'want', source: 'manual', needsCheck: true });
    toast(`「${title}」を本棚に登録しました`);
    $('#manual-form').reset();
  }
  if (e.target.id === 'isbn-form') {
    e.preventDefault();
    const input = $('#isbn-input');
    const isbn = isbn13(input.value);
    if (!isbn) { toast('978か979から始まる13桁のISBNを入力してください'); return; }
    input.value = '';
    handleIsbn(isbn);
  }
});

sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => {
  stopBookPreview();
  stopScanning();
  flushMemo();
  openId = null;
});

// ---------------------------------------------------------------- 起動
store.load();
window.addEventListener('hashchange', onHash);
onHash();
store.mergeSeed('data/seed.json').then((n) => {
  if (n) toast(`写真から読み取った${n}冊を本棚に入れました`);
  // 初めて開いた端末で検索タブから入ると、おすすめを空の本棚で作ってしまう。取り込み後に作り直す
  if (n && route.name === 'search' && !ui.searchQ) loadRecommendations();
  updateBadge();
  const stale = staleFollows(); // 前回のチェックから 12 時間たった著者だけ調べ直す
  hydrateReleaseCovers().finally(()=>{ if (stale.length) checkReleases(stale); });
});
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}


