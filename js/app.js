import * as store from './store.js';
import * as ndl from './ndl.js';
import { STATUS, STATUS_ORDER, SOURCES, PRIORITY, GENRES, GENRE_BY_ID, GENRE_GROUPS, GENRE_GROUP_BY_ID, GENRE_GROUP_ORDER, belongsToGenre } from './genres.js';
import { startScanner } from './scan.js';
import { authorReading } from './authors.js';
import { SHELF_MODES, primaryGenre, sortShelfBooks } from './shelf.js';
import { recommendPlan, pickRecommendations, shelfTitleMap } from './recommend.js';
import { coverIsbn, coverCandidates, releaseIdentity, previousCoverIsbns, confirmedRelease, currentReleaseIsbn, confirmedGoogleCover, knownPlaceholder, COVER_LOOKUP_VERSION } from './covers.js';
import {
  esc, normTitle, normName, mainTitle, clothColor, today, monthsAgo, monthLabel, isbn13, authorMatches,
} from './util.js';

import { loadBookDetails, peekBookDetails, prefetchBookDetails, bookDetailsKey, subscribeBookDetails, publicationDate, publicationLabel } from './book-details.js';
import { revealBooks } from './reveal.js';
import { shelfSeries, seriesVolumesFromWorks, describeSeries, isRealSeries, storySeries, seriesWorksOf, NO_SERIES, standaloneWorks, workBase, volInfo, splitVolume, volumeNumber } from './series.js';
import { TIERS, TIER_NAME, TROPHY_GROUPS, trophyProgress, trophyFamilies } from './trophies.js';
import * as sync from './sync.js';
import { VERSION_HISTORY } from './versions.js';
const APP_VERSION = VERSION_HISTORY[0].version;
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
const THIS_YEAR = new Date().getFullYear();

// 下から出る画面を開いている間は、後ろのページを動かさない。iPhone は body の overflow:hidden だけでは
// 指の操作で後ろが動くので、ページを今の位置で固定し、閉じたら元の位置へ戻す
let lockedScrollY = 0;
function lockPage() {
  if (document.body.classList.contains('sheet-locked')) return;
  lockedScrollY = window.scrollY;
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.classList.add('sheet-locked');
}
function unlockPage() {
  if (!document.body.classList.contains('sheet-locked')) return;
  document.body.classList.remove('sheet-locked');
  document.body.style.top = '';
  window.scrollTo(0, lockedScrollY);
}
const showSheet = () => { if (!sheet.open) sheet.showModal(); lockPage(); };

// 下のナビのガラスの面を、選んだタブの位置へすべらせる。最初と画面の幅が変わったときは動かさずに置く
function placeGlider(animate = true) {
  const nav = $('.tabbar');
  const glider = $('.tab-glider');
  const tab = nav?.querySelector('.tab[aria-current=page]');
  if (!glider || !tab || !tab.offsetWidth) return;
  glider.classList.toggle('no-anim', !animate || !nav.classList.contains('has-glider'));
  glider.style.width = `${tab.offsetWidth}px`;
  glider.style.transform = `translateX(${tab.offsetLeft}px)`;
  if (!nav.classList.contains('has-glider')) requestAnimationFrame(() => { nav.classList.add('has-glider'); requestAnimationFrame(() => glider.classList.remove('no-anim')); });
  else if (!animate) requestAnimationFrame(() => glider.classList.remove('no-anim'));
}
window.addEventListener('resize', () => placeGlider(false));

// 文字を入力している間（iPhone ではキーボードが出ている間）は、下のナビを隠す。
// キーボードの上に押し上げられたナビが検索欄にかぶるため
const isTypingField = (el) => el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]), textarea, [contenteditable="true"]');
document.addEventListener('focusin', (e) => { if (isTypingField(e.target)) document.body.classList.add('typing'); });
document.addEventListener('focusout', (e) => {
  if (!isTypingField(e.target)) return;
  // 次の入力欄へ移るときは隠したまま
  setTimeout(() => { if (!isTypingField(document.activeElement)) document.body.classList.remove('typing'); }, 60);
});

// ---------------------------------------------------------------- 画面の状態（この端末だけで覚える）
const UI_KEY = 'dokusho-techo:ui';
const ui = {
  q: '', sort: 'author', genre: '', unreadOnly: true, notOnShelf: false, showOther: false, showAntho: false,
  bookView: 'grid', historyYear: 'all', yearDirection: 'desc', addedDirection: 'desc',
  searchQ: '', searchKind: 'all', recShift: 0,
  authorMode: 'new', calView: 'month', calMonth: '', calWeek: '',
};
delete ui.scanStatus; // v0.7 で「入れる棚」の選択をやめた（登録はすべて本棚へ）
delete ui.addStatus;
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch { /* 既定値で始める */ }
delete ui.status;
ui.searchKind='all';
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
function stopBookPreview() { preview?.controller.abort(); preview=null; daySheet?.controller.abort(); daySheet=null; }
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
let newKeys = new Set();    // 著書タブを開いた時点で未読だった新刊（NEW 表示用）
let lastSearch = null;      // 検索タブの直近の結果 { q, kind, works, error }
let searchSeq = 0;          // 何回目の検索か（最新の結果だけを描くため）
let recState = null;        // おすすめの集まり具合 { sig, plan, results, running, error }
let recSeq = 0;
const recPool=new Map();

// 表紙の近くまでスクロールした本を先読みする。全本棚を一度に外部へ照会しない。
const observedInfo=new WeakSet();
const infoObserver='IntersectionObserver' in window ? new IntersectionObserver(entries=>{
  for(const e of entries) if(e.isIntersecting) {
    infoObserver.unobserve(e.target);
    const el=e.target.matches('[data-id]') ? e.target : e.target.querySelector('[data-id], [data-act="work-detail"], [data-act="release-detail"]');
    let book=el?.dataset.id ? store.get(el.dataset.id) : null;
    if(el?.dataset.act==='work-detail') {
      const w=workCache.get(el.dataset.key), edition=w?.latest;
      if(w) book={title:w.main+(w.volume ? ` ${w.volume}` : ''),author:w.authorLabel.split('、')[0],isbn:edition?.isbn || ''};
    } else if(el?.dataset.act==='release-detail') {
      const r=store.releases().find(r=>r.key===el.dataset.key);
      if(r)book={...r,...confirmedRelease(r)};
    }
    if(book)prefetchBookDetails([book]);
  }
},{rootMargin:'200px 0px'}) : null;
function prepareBooks(root) {
  revealBooks(root);
  if(!root || !infoObserver)return;
  root.querySelectorAll('.book, .series-card').forEach(el=>{if(!observedInfo.has(el)){observedInfo.add(el);infoObserver.observe(el);}});
}

// ---------------------------------------------------------------- 書影
// 版元ドットコム（大きく鮮明）→ Google Books（幅128pxと小さいが収録が多い）の順に探し、
// どちらにも無ければ書名を組んだ表紙を見せる。外部サービスの「画像なし」画像は表示しない。
const COVER_SOURCES = [
  (isbn) => `https://img.hanmoto.com/bd/img/${isbn}.jpg`,
  (isbn) => `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1`,
];
const coverUrl = (isbn, step = 0) => COVER_SOURCES[step](isbn);

// 見つかった表紙をこの起動中は覚えておく（描き直すたびに「画像なし」→次の配信元と探し直して、表紙が一瞬消えるのを防ぐ）
// key：候補の ISBN の並び → { src, isbn, step, candidate } か 'none'（どこにもない）
const coverMemo = new Map();
const rememberCover = (img, found) => { if (img.dataset.memo) coverMemo.set(img.dataset.memo, found ? { src: img.currentSrc || img.src, isbn: img.dataset.isbn || '', step: img.dataset.step, candidate: img.dataset.candidate || '0' } : 'none'); };

// 旧版の候補を順に試す。ISBNは書誌と一致するものだけを使う。
function cover(title,isbn,size='s',alternatives=[],author='') {
  const googleId=confirmedGoogleCover(title,author);
  const candidates=coverCandidates(isbn,alternatives);
  const spine=`<span class="spine" style="--cloth:${clothColor(title)}"><span class="spine-t">${esc(mainTitle(title))}</span></span>`;
  const memoKey=`${candidates.join(',')}|${googleId || ''}`;
  const hit=coverMemo.get(memoKey);
  if (hit==='none') return `<span class="cover ${size}" aria-hidden="true">${spine}</span>`;
  if (hit) return `<span class="cover ${size}" aria-hidden="true">${spine}<img class="ok" alt="" decoding="sync" data-memo="${esc(memoKey)}" data-isbn="${esc(hit.isbn)}" data-original="${coverIsbn(isbn)}" data-candidates="${candidates.join(',')}" data-candidate="${esc(hit.candidate)}" data-step="${esc(hit.step)}"${googleId && !hit.isbn ? ` data-google-id="${googleId}"` : ''} src="${esc(hit.src)}"></span>`;
  const img=candidates.length ? `<img alt="" loading="lazy" decoding="async" data-memo="${esc(memoKey)}" data-isbn="${candidates[0]}" data-original="${coverIsbn(isbn)}" data-candidates="${candidates.join(',')}" data-candidate="0" data-step="0" src="${coverUrl(candidates[0],0)}">` : googleId ? `<img alt="" loading="lazy" decoding="async" data-memo="${esc(memoKey)}" data-google-id="${googleId}" data-step="1" src="https://books.google.com/books/content?id=${googleId}&amp;printsec=frontcover&amp;img=1&amp;zoom=1">` : '';
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
  if (img.dataset.googleId && !img.dataset.isbn) {setCoverCaption(img,true);rememberCover(img,false);img.remove();return;}
  img.classList.remove('ok');
  const step=Number(img.dataset.step)+1;
  if (step<COVER_SOURCES.length) { img.dataset.step=String(step);img.src=coverUrl(img.dataset.isbn,step);return; }
  const candidates=(img.dataset.candidates || '').split(',').filter(Boolean);
  const index=Number(img.dataset.candidate)+1;
  if (index<candidates.length) {
    img.dataset.candidate=String(index);img.dataset.isbn=candidates[index];img.dataset.step='0';img.src=coverUrl(candidates[index],0);
  } else { setCoverCaption(img,true);rememberCover(img,false);img.remove(); }
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
  else { img.classList.add('ok'); setCoverCaption(img); rememberCover(img,true); }
}, true);

const ICONS = {
 search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.5 4.5"/>',
 grid: '<rect x="4" y="4" width="6" height="7" rx="1"/><rect x="14" y="4" width="6" height="7" rx="1"/><rect x="4" y="15" width="6" height="5" rx="1"/><rect x="14" y="15" width="6" height="5" rx="1"/>',
 list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.1M4 12h.1M4 18h.1" stroke-width="3"/>',
 filter: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--paper)"/><circle cx="15" cy="17" r="2" fill="var(--paper)"/>',
 close: '<path d="m6 6 12 12M18 6 6 18"/>',
 calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
 arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
 bookmark: '<path d="M7 4h10v16l-5-3-5 3z"/>',
 book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zM13 7a3 3 0 0 1 3-3h4v14h-3a4 4 0 0 0-4 3"/>',
 cards: '<rect x="9" y="3.5" width="11" height="15" rx="2"/><path d="m9 6.6-3.6 1a2 2 0 0 0-1.4 2.4l2.4 9a2 2 0 0 0 2.4 1.4l5.6-1.5"/>',
 trophy: '<path d="M8 4h8v5.5a4 4 0 0 1-8 0z"/><path d="M8 6.5H5.2a3 3 0 0 0 3.1 4M16 6.5h2.8a3 3 0 0 1-3.1 4M12 13.5V17M8.5 20.5h7M9.5 17h5v3.5h-5z"/>',
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

// action：{ label, run } を渡すと、知らせの右に「元に戻す」などのボタンを出す（少し長めに表示）
function toast(msg, action = null) {
  const t = $('#toast');
  // 詳細などの画面を開いているときは、その上に出す（開いた画面はページより前面にあるため）
  const host = sheet.open ? sheet : document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { t.hidden = true; action.run(); }, { once: true });
    t.append(btn);
  }
  t.classList.toggle('has-action', !!action);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
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
    prepareBooks(books);
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
  if (ui.sort==='series') { renderSeriesShelf(); return; }
  // 本棚は「これから読む本」を並べる場所。読了の本は「記録」に残し、本棚には出さない（本人の希望）
  const all=store.books().filter(b=>b.status!=='done');
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
  // 本棚の本があるジャンルだけ並べる（v0.15 でジャンルを 12 に増やしたので、空のジャンルで埋めない）
  const genreButtons=[['','すべて'],...GENRE_GROUPS.filter(g=>g.id===ui.genre || all.some(b=>belongsToGenre(b,g.id))).map(g=>[g.id,g.name]),...(ui.genre && !GENRE_GROUP_BY_ID[ui.genre] ? [[ui.genre,genreLabel]] : [])];
  view.innerHTML=`<section class="shelf shelf-sort-${ui.sort}">
    ${pageHead('本棚',`${all.length}冊`)}
    <div class="shelf-tabs" role="group" aria-label="本棚の並べ方">
      ${SHELF_MODES.map(([id,label])=>`<button type="button" class="shelf-mode ${ui.sort===id ? 'on' : ''}" data-act="shelf-mode" data-v="${id}" aria-pressed="${ui.sort===id}">${label}</button>`).join('')}
    </div>
    <div class="shelf-pane swipe-pane">
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
    </div>
  </section>`;
  watchShelfEnd(list);
  prepareBooks(view);
}

function emptyShelf(total) {
  if (!total && store.books().length) return `<div class="empty"><p class="empty-title">本棚の本はすべて読み終えました</p><p>読んだ本は「記録」にあります。右上の「本を追加」から、次に読みたい本を入れましょう。</p></div>`;
  if (!total) return `<div class="empty"><p class="empty-title">本棚はまだ空です</p><p>右上の「本を追加」から、次に読みたい本を入れてみましょう。</p></div>`;
  return `<div class="empty"><p class="empty-title">条件に合う本がありません</p><p>ジャンルを切り替えるか、検索の文字を消してください。</p></div>`;
}

// ---------------------------------------------------------------- 本棚：シリーズの続き
const SERIES_TTL = 12 * 3600 * 1000;
const seriesFetched = new Map(); // 巻数のシリーズの key → 国会図書館で確かめた巻（この起動中だけ覚える）
const seriesFailed = new Set();
let seriesLoading = null;
// 名前のあるシリーズ用：著者ごとの作品のうちシリーズの巻に当たる分（seriesWorksOf）。
// 7 日間この端末に小さく覚える（同期しない。著者の作品一覧そのものは保存しない＝保存容量を圧迫しない）
const SERIES_WORKS_KEY = 'dokusho-techo:series-works';
const SERIES_WORKS_TTL = 7 * 24 * 3600 * 1000;
const authorWorks = new Map(); // 著者の比較キー → { t, works }
const authorFailed = new Set();
try {
  const okWork = (w) => w && typeof w.main === 'string' && Array.isArray(w.keys) && Array.isArray(w.editions);
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(SERIES_WORKS_KEY) || '{}'))) {
    if (!v || !Number.isFinite(v.t) || Date.now() - v.t >= SERIES_WORKS_TTL || !Array.isArray(v.works) || !v.works.every(okWork)) continue;
    for (const w of v.works) if (!Array.isArray(w.isbns)) w.isbns = w.editions.map((e) => e.isbn).filter(Boolean); // v0.13 で覚えた分
    authorWorks.set(k, v);
  }
} catch { /* 壊れていれば読み直す */ }
function saveAuthorWorks() {
  try { localStorage.setItem(SERIES_WORKS_KEY, JSON.stringify(Object.fromEntries(authorWorks))); } catch { /* 容量不足なら覚えない（次に開いたとき確かめ直す） */ }
}
const storyCache = new WeakMap();
function seriesStories() {
  const m = new Map();
  for (const [k, v] of authorWorks) {
    if (!storyCache.has(v)) storyCache.set(v, storySeries(v.works));
    m.set(k, storyCache.get(v));
  }
  return m;
}
const currentSeries = () => shelfSeries(store.books(), { stories: seriesStories() });
const fetchedFor = (s) => (s.named ? authorWorks.get(normName(s.author))?.works || null : seriesFetched.get(s.key));
const VOL_STATE = { done: '読了', shelf: '本棚にあり', missing: 'まだ本棚にない', coming: '発売予定' };
const volState = (v) => (v.book ? (v.book.status === 'done' ? 'done' : 'shelf') : v.upcoming ? 'coming' : 'missing');
const releaseDay = (v) => (v.publishedAt ? publicationLabel(v.publishedAt) : monthLabel(v.month));
// 名前のあるシリーズは巻を書名で、巻数のシリーズは「3巻」で呼ぶ
const volName = (d, v) => (d.named ? `「${mainTitle(v.title)}」` : `${v.vol}巻`);
const SERIES_CHIPS = 12; // 名前のあるシリーズの巻はこれより多ければ畳む（ポアロなど）
const expandedSeries = new Set();

function seriesList() {
  const q = normName(ui.q);
  return currentSeries().map((s) => describeSeries(s, fetchedFor(s)))
    .filter(isRealSeries)
    .filter((d) => !q || normName(`${d.base}${d.author}${d.named ? d.vols.map((v) => v.title).join('') : ''}`).includes(q))
    // 読み終えていないシリーズ → 本棚に多くあるシリーズ → 名前順
    .sort((a, b) => Number(!a.next) - Number(!b.next) || ownedCount(b) - ownedCount(a) || a.base.localeCompare(b.base, 'ja'));
}
const ownedCount = (d) => d.vols.filter((v) => v.book).length;

// v0.18 本人「シリーズが長くて下まで行くのが大変」「50巻あったら50巻まで並ぶのはダサい」：
// カードは表紙・書名・読了数と、巻の並びを細い帯（1 巻 1 本・色で状態）で見せるだけにし、巻のボタンは「巻を見る」で開いたときだけ。
// 巻数のシリーズの巻は数字だけの小さなマスで並べる。読み終えたシリーズは下にまとめて畳む
const openSeries = new Set(); // 巻を開いているシリーズ（この起動中だけ）
let showDoneSeries = false;
const seriesStrip = (d) => `<span class="series-strip${d.vols.length > 40 ? ' dense' : ''}" aria-hidden="true">${d.vols.map((v) => `<i class="ss-${volState(v)}"></i>`).join('')}</span>`;
function seriesCard(d) {
  const lead = d.vols[0]; // 表紙は 1 巻目にそろえる（v0.18.1 本人）
  const leadCover = lead.book ? cover(lead.book.title, lead.book.isbn, 's', lead.book.coverIsbns || lead.book.coverIsbn || [], d.author)
    : cover(lead.title, lead.isbn, 's', lead.coverIsbns || [], d.author);
  const open = openSeries.has(d.key);
  const folded = d.named && d.vols.length > SERIES_CHIPS && !expandedSeries.has(d.key);
  const shown = folded ? d.vols.slice(0, SERIES_CHIPS) : d.vols;
  const chips = !open ? '' : shown.map((v) => {
    const st = volState(v);
    const label = d.named ? `${v.vol}. ${v.title}` : `${v.vol}巻`;
    const inner = d.named ? `<span class="vol-number">${v.vol}</span><span class="vol-name">${esc(mainTitle(v.title))}</span>` : `<span class="vol-number">${v.vol}</span>`;
    return `<li><button type="button" class="vol vol-${st}${d.named ? ' vol-named' : ''}" data-act="series-vol" data-key="${esc(d.key)}" data-vol="${v.vol}" aria-label="${esc(label)}：${VOL_STATE[st]}${st==='done' ? '、タップで読了を取り消す' : v.upcoming && !v.book ? '' : '、タップで読了'}" aria-pressed="${st==='done'}" ${v.upcoming && !v.book ? 'disabled' : ''}>${inner}</button></li>`;
  }).join('') + (d.named && d.vols.length > SERIES_CHIPS
    ? `<li><button type="button" class="vol vol-more" data-act="series-more" data-key="${esc(d.key)}" aria-expanded="${!folded}">${folded ? `ほか${d.vols.length - shown.length}冊` : '畳む'}</button></li>` : '');
  const n = d.next;
  let next = '';
  if (!n) next = `<b>${d.named ? 'すべて読了' : '全巻読了'}</b>`;
  else if (n.book) next = `次に読む：<b>${esc(volName(d, n))}</b>（本棚にあり）`;
  else if (n.upcoming) next = `次の巻：<b>${esc(volName(d, n))}</b> ${esc(releaseDay(n))}発売予定`;
  else next = `次に読む：<b>${esc(volName(d, n))}</b>（まだ本棚にない）`;
  const latest = d.coming.find((v) => v !== n);
  const action = n && !n.book && (n.work || d.named) ? `<button type="button" class="add-btn" data-act="series-add" data-key="${esc(d.key)}" data-vol="${n.vol}">＋登録</button>`
    : n?.book ? `<button type="button" class="ghost small" data-act="open" data-id="${esc(n.book.id)}">開く</button>` : '';
  return `<li class="series-card${d.named ? ' named' : ''}${open ? ' open' : ''}" data-reveal-key="${esc(`series:${d.key}`)}">
    <div class="series-head">${leadCover}
      <div class="series-main">
        <h2 class="series-title">${esc(d.base)}</h2>
        <button type="button" class="link series-author" data-act="author" data-name="${esc(d.author)}">${esc(d.author)}</button>
        <div class="series-progress-row"><p class="series-progress">読了 <b>${d.done}</b> / ${d.total}${d.named ? '冊' : '巻'}</p>
          <button type="button" class="series-toggle" data-act="series-open" data-key="${esc(d.key)}" aria-expanded="${open}">${open ? '巻を閉じる' : '巻を見る'}</button></div>
        ${seriesStrip(d)}
      </div>
    </div>
    ${open ? `<ol class="series-vols${d.named ? '' : ' compact'}" aria-label="${esc(d.base)}の${d.named ? '本' : '巻'}">${chips}</ol>` : ''}
    <div class="series-next"><p>${next}${latest ? `<br><span class="muted">最新刊：${esc(volName(d, latest))} ${esc(releaseDay(latest))}発売予定</span>` : ''}</p>${action}</div>
  </li>`;
}

function drawSeries() {
  const box = $('#series-list');
  if (!box) return;
  const list = seriesList();
  const searching = !!normName(ui.q);
  const going = list.filter((d) => d.next);
  const finished = list.filter((d) => !d.next);
  $('#series-count').textContent = list.length ? `続きあり ${going.length}・読み終えた ${finished.length}` : '0シリーズ';
  const progress = ''; // v0.18.1 本人：読み込みの表示は出さない（国立国会図書館で確かめる間も、分かっている分だけ並べる）
  const showDone = searching || showDoneSeries || !going.length;
  // シリーズがすでに並んでいるときは、確かめている途中の表示を下に小さく出す（上の一覧を押し下げない）
  box.innerHTML = `${progress && !list.length ? loading(progress) : ''}
    ${list.length ? `${going.length ? `<ul class="series-list">${going.map(seriesCard).join('')}</ul>` : ''}
      ${finished.length && !searching && going.length ? `<button type="button" class="series-done-toggle" data-act="series-done" aria-expanded="${showDone}">${showDone ? '読み終えたシリーズを畳む' : `読み終えたシリーズ（${finished.length}）を見る`}</button>` : ''}
      ${finished.length && showDone ? `<ul class="series-list series-list-done">${finished.map(seriesCard).join('')}</ul>` : ''}
      <p class="series-legend"><span><i class="ss-done"></i>読了</span><span><i class="ss-shelf"></i>本棚にある</span><span><i class="ss-missing"></i>まだ本棚にない</span><span><i class="ss-coming"></i>発売予定</span></p>`
    : seriesLoading ? '' : `<div class="empty"><p class="empty-title">シリーズの本が見つかりません</p><p>書名に巻数がある本（例：「変な家2」）や、題名が違っても同じシリーズの本（例：館シリーズ、ガリレオシリーズ）をまとめます。本の詳細の「シリーズ」から自分でまとめることもできます。</p></div>`}
    ${progress && list.length ? `<p class="muted small series-checking">${esc(progress)}</p>` : ''}
    ${seriesFailed.size && !seriesLoading ? errorBox('一部のシリーズは国立国会図書館に接続できず、本棚にある巻だけを表示しています。') : ''}
    <p class="source">本棚の本、国立国会図書館サーチの書誌（巻数・シリーズ名）、よく知られたシリーズの一覧から、同じ著者のシリーズをまとめています。違うときは本の詳細の「シリーズ」で直せます。</p>`;
  box.toggleAttribute('data-loading', !!seriesLoading); // 確かめている途中の印（画面には出さない。確認用）
  prepareBooks(box);
}

function renderSeriesShelf() {
  view.innerHTML = `<section class="shelf shelf-sort-series">
    ${pageHead('本棚', `${store.books().filter(b=>b.status!=='done').length}冊`)}
    <div class="shelf-tabs" role="group" aria-label="本棚の並べ方">
      ${SHELF_MODES.map(([id, label]) => `<button type="button" class="shelf-mode ${ui.sort === id ? 'on' : ''}" data-act="shelf-mode" data-v="${id}" aria-pressed="${ui.sort === id}">${label}</button>`).join('')}
    </div>
    <div class="shelf-pane swipe-pane">
    <label class="search-wrap shelf-search">${icon('search')}<span class="sr-only">シリーズを検索</span><input id="shelf-q" type="search" placeholder="シリーズを検索" value="${esc(ui.q)}" autocomplete="off"></label>
    <div class="shelf-bar"><div class="shelf-caption"><span>シリーズの続き</span><p class="count" id="series-count" aria-live="polite"></p></div></div>
    <div id="series-list"></div>
    </div>
  </section>`;
  drawSeries();
  loadSeriesVolumes();
}

// 本棚の各シリーズについて、国会図書館で他の巻と発売予定を 1 件ずつ確かめる（画面を離れたら止める）
// 読み込み中に本棚が変わって描き直しても、読み込みは 1 本だけ動かす（2 本目を始めると数え方が壊れる）
// 名前のあるシリーズを国会図書館で確かめる著者：名前のあるシリーズの著者と、本棚に 2 冊以上ある著者
function seriesAuthorsToCheck(groups) {
  const want = new Map();
  for (const g of groups) if (g.named) want.set(normName(g.author), g.author);
  const counts = new Map();
  for (const b of store.books()) {
    if (!b.author || b.seriesName === NO_SERIES) continue;
    const k = normName(b.author);
    counts.set(k, { n: (counts.get(k)?.n || 0) + 1, name: counts.get(k)?.name || b.author });
  }
  for (const [k, { n, name }] of counts) if (n >= 2 && !want.has(k)) want.set(k, name);
  return [...want].filter(([k]) => !authorWorks.has(k) && !authorFailed.has(k)).map(([, name]) => name);
}

let seriesRun = null;
function loadSeriesVolumes() {
  if (seriesRun) return seriesRun;
  const groups = currentSeries();
  const todo = groups.filter((s) => !s.named && !seriesFetched.has(s.key));
  const authors = seriesAuthorsToCheck(groups);
  if (!todo.length && !authors.length) return Promise.resolve();
  seriesFailed.clear();
  authorFailed.clear();
  const state = { done: 0, total: todo.length + authors.length };
  seriesLoading = state;
  drawSeries();
  seriesRun = (async () => {
    for (const s of todo) {
      if (route.name !== 'shelf' || ui.sort !== 'series') break; // 画面を離れたら止め、戻ったら続きから
      if (!seriesFetched.has(s.key)) {
        try {
          const works = await ndl.searchTitle(s.base, s.author, { allSources: true, ttl: SERIES_TTL });
          seriesFetched.set(s.key, seriesVolumesFromWorks(s, works));
        } catch { seriesFailed.add(s.key); }
      }
      state.done += 1;
      drawSeries();
    }
    for (const name of authors) {
      if (route.name !== 'shelf' || ui.sort !== 'series') break;
      const k = normName(name);
      if (!authorWorks.has(k)) {
        try {
          authorWorks.set(k, { t: Date.now(), works: seriesWorksOf(await ndl.searchAuthor(name, { priority: 1, keep: false })) });
          saveAuthorWorks();
        } catch { authorFailed.add(k); }
      }
      state.done += 1;
      drawSeries();
    }
  })().finally(() => {
    if (seriesLoading === state) seriesLoading = null;
    seriesRun = null;
    drawSeries();
  });
  return seriesRun;
}

function findSeries(key) {
  const s = currentSeries().find((x) => x.key === key);
  return s ? describeSeries(s, fetchedFor(s)) : null;
}
const findSeriesVol = (key, vol) => findSeries(key)?.vols.find((v) => v.vol === Number(vol)) || null;
// シリーズの巻を本棚に入れる。名前のあるシリーズは一覧の書名のまま（同じシリーズとしてまとまるように）
function addSeriesVolume(d, v, status = 'want') {
  const work = v.work || (d.named ? { main: mainTitle(v.title), volume: '', authorLabel: d.author, editions: [], latest: null, firstYear: 0, ndc: '' } : null);
  if (!work) return null;
  return addFromWork(work, { source: 'series', publishedAt: v.publishedAt, author: d.author, status, ...(d.named ? { title: mainTitle(v.title) } : {}) });
}

// シリーズの新しい巻（最後の巻より後に出た・これから出る巻）を、著書タブの新着とカレンダーに出す。12 時間ごと
async function checkSeries() {
  const last = Date.parse(store.seriesCheckedAt() || '');
  if (last && Date.now() - last < SERIES_TTL) return;
  const from = monthsAgo(2);
  const items = [];
  for (const s of currentSeries()) {
    if (s.named) continue; // 名前のあるシリーズの新刊は、著者の新刊（自動フォロー）で知らせる
    let vols;
    try {
      vols = seriesVolumesFromWorks(s, await ndl.searchTitle(s.base, s.author, { allSources: true, ttl: SERIES_TTL }));
    } catch { return; } // 通信できなければ次に開いたとき
    seriesFetched.set(s.key, vols);
    const d = describeSeries(s, vols);
    if (!isRealSeries(d)) continue;
    const fresh = (v) => v.upcoming || (v.month.length > 4 && v.month >= from);
    // 点字版などの古い巻を新刊と誤らないよう、すでに出ている巻のうち最後の巻より後ろだけを知らせる
    const knownMax = Math.max(0, ...d.vols.filter((v) => !fresh(v)).map((v) => v.vol));
    for (const v of d.vols) {
      if (v.book || !v.work || !fresh(v) || v.vol <= knownMax) continue;
      items.push({
        key: `${normTitle(v.work.main + (v.work.volume || ''))}|${normName(s.author)}`,
        title: v.title, baseTitle: s.base, volume: v.work.volume || '', author: s.author, month: v.month,
        publishedAt: v.publishedAt, publisher: v.publisher, isbn: v.isbn, link: v.link, ndc: v.ndc,
        coverIsbns: v.coverIsbns, coverIsbn: v.coverIsbns[0] || '', series: s.base,
      });
    }
  }
  const n = store.addSeriesReleases(items);
  if (n) toast(`本棚のシリーズに新しい巻が${n}冊あります（著書タブ・カレンダー）`);
}

// ---------------------------------------------------------------- 本の詳細
function renderSheetBook(id) {
  datePick=null;
  stopBookPreview();
  stopScanning();
  flushMemo();
  const b = store.get(id);
  if (!b) { closeSheet(); return; }
  const genresOpen = openId === id && !!$('.genre-select')?.open;
  const seriesOpen = openId === id && !!$('.series-select')?.open;
  // 同じ本を描き直すとき（評価・状態などを変えたとき）は、表紙とあらすじの要素をそのまま使う（表紙が一瞬消えない）
  const same = openId === id && sheet.open && sheetBody.dataset.bookKey === `${id}|${b.isbn}|${b.title}|${b.author}|${JSON.stringify(b.coverIsbns || b.coverIsbn || [])}`;
  const keepCover = same ? sheetBody.querySelector('.detail-head > .cover') : null;
  const keepSynopsis = same ? $('#book-synopsis') : null;
  const scrollTop = same ? sheetBody.scrollTop : 0;
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

    <section class="book-synopsis" id="book-synopsis" aria-labelledby="book-synopsis-title" hidden><h3 id="book-synopsis-title" class="label">あらすじ</h3><div class="synopsis-body"></div></section>

    <div class="field"><span class="label">読書状態</span><div class="seg">${seg('set-status', STATUS_ORDER.map((s) => [s, STATUS[s].label]), b.status)}</div></div>
    ${b.status === 'done'
    ? `<div class="field two">
        <div><span class="label">評価</span><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${n <= b.rating ? 'on' : ''}" data-act="set-rating" data-v="${n}" aria-label="${n}点" aria-pressed="${n <= b.rating}">★</button>`).join('')}</div></div>
        <div><span class="label" id="finished-label">読み終えた日</span><button type="button" class="date-btn" data-act="date-open" aria-expanded="false" aria-controls="finished-pop" aria-describedby="finished-label">${b.finishedAt ? esc(publicationLabel(b.finishedAt)) : '<span class="muted">日付を選ぶ</span>'}${icon('calendar')}</button></div>
      </div>
      <div class="date-pop" id="finished-pop" hidden></div>`
    : `<div class="field"><span class="label">気になり度</span><div class="seg">${seg('set-prio', [[3, '本命'], [2, '気になる'], [1, '見かけた']], b.priority)}</div></div>`}

    <details class="field genre-select" ${genresOpen ? 'open' : ''}><summary>ジャンル<span>${esc((b.genres || []).map((id) => GENRE_BY_ID[id]?.name || '').filter(Boolean).join('、') || '未設定')}</span></summary><div class="chips wrap">${GENRES.map((g) => `<button type="button" class="chip small ${b.genres?.includes(g.id) ? 'on' : ''}" data-act="toggle-genre" data-v="${g.id}" aria-pressed="${!!b.genres?.includes(g.id)}">${esc(g.name)}</button>`).join('')}</div></details>

    ${seriesField(b, seriesOpen)}

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
      <button type="button" class="danger" data-act="delete">${b.status === 'done' ? '記録から消す' : '本棚から消す'}</button>
      <span class="muted small">追加 ${esc(b.addedAt || '')}</span>
    </div>`;
  sheetBody.dataset.bookKey = `${id}|${b.isbn}|${b.title}|${b.author}|${JSON.stringify(b.coverIsbns || b.coverIsbn || [])}`;
  if (keepCover) sheetBody.querySelector('.detail-head > .cover')?.replaceWith(keepCover);
  if (keepSynopsis) $('#book-synopsis').replaceWith(keepSynopsis);
  else loadBookSynopsis(b);
  showSheet();
  sheetBody.scrollTop = scrollTop;
}

// 本の詳細の「シリーズ」：自動でまとめた名前を見せ、違うときは本人が名前を付ける・まとめない
function seriesField(b, open) {
  const groups = currentSeries().map((g) => describeSeries(g, fetchedFor(g))).filter(isRealSeries);
  const has = (g) => (g.named ? g.members.some((m) => m.book.id === b.id) : [...g.owned.values()].some((x) => x.id === b.id));
  const current = groups.find(has)?.base || '';
  const state = b.seriesName === NO_SERIES ? 'まとめない' : current ? `${current}${b.seriesName ? '' : '（自動）'}` : 'なし';
  const names = [...new Set(groups.filter((g) => normName(g.author) === normName(b.author)).map((g) => g.base))];
  const reset = b.seriesName === NO_SERIES ? `<button type="button" class="link small" data-act="series-name" data-v="">自動でまとめる</button>`
    : `${b.seriesName ? `<button type="button" class="link small" data-act="series-name" data-v="">自動に戻す</button>` : ''}${current ? `<button type="button" class="link small" data-act="series-name" data-v="${NO_SERIES}">シリーズにしない</button>` : ''}`;
  return `<details class="field series-select" ${open ? 'open' : ''}><summary>シリーズ<span>${esc(state)}</span></summary>
    <div class="series-edit">
      ${names.length ? `<div class="chips wrap">${names.map((n) => { const on = n === current && b.seriesName !== NO_SERIES; return `<button type="button" class="chip small ${on ? 'on' : ''}" data-act="series-name" data-v="${esc(n)}" aria-pressed="${on}">${esc(n)}</button>`; }).join('')}</div>` : ''}
      <div class="series-new"><input id="f-series" maxlength="60" autocomplete="off" placeholder="シリーズ名を入れてまとめる" aria-label="シリーズ名"><button type="button" class="ghost small" data-act="series-name-save">まとめる</button></div>
      ${reset ? `<div class="series-reset">${reset}</div>` : ''}
      <p class="muted small">同じ著者の本を、同じシリーズ名でまとめます（本棚の「シリーズ」）。</p>
    </div></details>`;
}
function setSeriesName(id, name) {
  if (!store.get(id)) return;
  store.update(id, { seriesName: name });
  renderSheetBook(id);
  toast(name === NO_SERIES ? 'シリーズにまとめないようにしました' : name ? `「${name}」にまとめました` : '自動でまとめるように戻しました');
}

// 本棚の本のあらすじ（本の情報と同じく NDL・openBD。24 時間この端末に保存）
let bookSynopsis = null;
function putBookSynopsis(info) {
  const box=$('#book-synopsis');if(!box)return;
  box.hidden=!info?.synopsis;
  if(!info?.synopsis)return;
  $('.synopsis-body',box).innerHTML=`<p class="synopsis-text clamp">${esc(info.synopsis)}</p><button type="button" class="link small more-synopsis" data-act="synopsis-more" hidden>続きを読む</button>`;
  const p=$('.synopsis-text',box);
  requestAnimationFrame(()=>{const more=$('.more-synopsis',box);if(more)more.hidden=!(p.scrollHeight>p.clientHeight+4);});
}
function loadBookSynopsis(b) {
  bookSynopsis?.controller.abort();
  const controller=new AbortController();
  bookSynopsis={controller,id:b.id,key:bookDetailsKey(b)};
  putBookSynopsis(peekBookDetails(b));
  loadBookDetails(b,{signal:controller.signal}).then(info=>{
    if(bookSynopsis?.controller===controller)putBookSynopsis(info);
  }).catch(()=>{});
}
subscribeBookDetails(key=>{
  if(!sheet.open)return;
  if(preview && bookDetailsKey(preview.book)===key){preview.details=peekBookDetails(preview.book);updatePreviewInfo(preview);}
  if(bookSynopsis?.key===key && openId===bookSynopsis.id && store.get(openId))putBookSynopsis(peekBookDetails(store.get(openId)));
});

// 読み終えた日：アプリの見た目に合わせたカレンダー（スマホ標準・ブラウザ標準の日付選択は使わない）
let datePick = null; // { month: 'YYYY-MM' }
function drawDatePicker() {
  const pop = $('#finished-pop');
  const b = store.get(openId);
  if (!pop || !b || !datePick) return;
  const t = today();
  const [y, m] = datePick.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="dp-blank" aria-hidden="true"></span>');
  for (let d = 1; d <= days; d++) {
    const date = `${datePick.month}-${String(d).padStart(2, '0')}`;
    cells.push(`<button type="button" class="dp-day${date === b.finishedAt ? ' on' : ''}${date === t ? ' today' : ''}${new Date(y, m - 1, d).getDay() === 0 ? ' sun' : ''}" data-act="dp-pick" data-date="${date}" aria-pressed="${date === b.finishedAt}" aria-label="${y}年${m}月${d}日">${d}</button>`);
  }
  pop.innerHTML = `<div class="dp-head"><button type="button" class="icon-btn" data-act="dp-move" data-v="-1" aria-label="前の月">‹</button><b>${y}年${m}月</b><button type="button" class="icon-btn" data-act="dp-move" data-v="1" aria-label="次の月">›</button></div>
    <div class="dp-grid">${WEEKDAYS.map((w, i) => `<span class="dp-dow${i === 0 ? ' sun' : ''}" aria-hidden="true">${w}</span>`).join('')}${cells.join('')}</div>
    <div class="dp-foot"><button type="button" class="ghost small" data-act="dp-pick" data-date="${t}">今日</button>${b.finishedAt ? '<button type="button" class="ghost small" data-act="dp-pick" data-date="">日付を消す</button>' : ''}</div>`;
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
  unlockPage(); // close イベントを待たずに戻す（このあと別の画面へ移るときに位置がずれない）
  sheetClosed();
}

// 詳細を開いている間に本棚が変わったら、閉じたあとで本棚を描き直す（開いている間に後ろの表紙が点滅しない）
let pendingRender = false;
function sheetClosed() {
  openId = null;
  datePick = null;
  bookSynopsis?.controller.abort();
  bookSynopsis = null;
  if (!pendingRender) return;
  pendingRender = false;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

// ---------------------------------------------------------------- 本を登録
function addFromWork(w, extra = {}) {
  const status = extra.status || 'want';
  const sameAuthor = store.books().filter((b) => normName(b.author) === normName(w.authorLabel.split('、')[0]));
  const genres = extra.genres || [...new Set(sameAuthor.flatMap((b) => b.genres || []))].slice(0, 2);
  const b = store.add({
    title: extra.title || w.main + (w.volume ? ` ${w.volume}` : ''),
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
  if(preview!==state || !sheet.open)return;
  const info=state.details,section=$('#preview-summary');
  $('#preview-date').textContent=publicationLabel(info?.publishedAt || state.book.publishedAt);
  section.hidden=!info?.synopsis;
  $('#preview-synopsis').innerHTML=info?.synopsis ? `<p class="synopsis-text">${esc(info.synopsis)}</p>` : '';
  const url=info?.sourceUrl || '';
  $('#preview-source').innerHTML=info?.synopsis && /^https:\/\/(?:ndlsearch\.ndl\.go\.jp|www\.hanmoto\.com)\/[^\s"'<>]*$/.test(url)
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
    state.loading=false; updatePreviewInfo(state);
  }
}
function renderBookPreview(book,origin) {
  flushMemo(); stopScanning(); stopBookPreview(); openId=null;
  const state={book,...origin,controller:new AbortController(),details:peekBookDetails(book),loading:false};
  preview=state;
  sheetBody.innerHTML=`<article class="book-preview">
    <div class="detail-head${origin?.zukan ? ' unowned' : ''}">${cover(book.title,book.isbn,'m',book.coverIsbns || [],book.author)}<div class="detail-title"><p class="preview-eyebrow">${origin?.zukan ? 'まだ持っていない本' : '本の情報'}</p><h2>${esc(book.title)}</h2><p class="book-meta cover-caption" hidden></p>${book.publisher ? `<p class="muted">${esc(book.publisher)}</p>` : ''}</div></div>
    <dl class="preview-facts"><div><dt>著者</dt><dd>${book.author ? `<button type="button" class="link" data-act="author" data-name="${esc(book.author)}">${esc(book.author)}</button>` : '未確認'}</dd></div><div><dt>刊行日</dt><dd><span id="preview-date">${esc(publicationLabel(book.publishedAt))}</span>${book.firstYear ? `<span class="first-pub">最初の刊行は${esc(String(book.firstYear))}年</span>` : ''}</dd></div></dl>
    <section id="preview-summary" class="preview-summary" aria-labelledby="preview-summary-title" hidden><h3 id="preview-summary-title">あらすじ</h3><div id="preview-synopsis" aria-live="polite"></div></section>
    <p id="preview-source" class="preview-source"></p><div id="preview-action" class="preview-action"></div>
  </article>`;
  showSheet();
  sheetBody.scrollTop=0;
  drawPreviewAction(state);
  updatePreviewInfo(state);
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
// 読み取った本を本棚に入れるか、本屋さんモード（入れずに持っているかを確かめる）か。最後に選んだ方をこの端末で覚える
// v0.18 本人「読み込んだ本がすぐ本棚に登録されるのをやめて」：読み取った本は本棚に入れず、持っているか・何巻目かを出し、
// 入れたい本だけ「本棚に追加」（v0.16 の本屋さんモードと同じ。モードの切り替えはなくした）
function renderSheetScan() {
  stopBookPreview();
  flushMemo();
  stopScanning();
  const controller = new AbortController();
  scanController = controller;
  openId = null;
  scanned = [];
  sheetBody.innerHTML = `
    <h2 class="sheet-title">バーコード</h2>
    <p class="scan-mode-note">読み取った本は、まだ本棚に入りません。持っているか・読んだか・シリーズの何巻目かを確かめて、入れたい本だけ「本棚に追加」を押してください。</p>
    <div class="scan-box">
      <video id="scan-video" playsinline muted autoplay></video>
      <div class="scan-guide" aria-hidden="true"></div>
    </div>
    <p id="scan-msg" class="scan-msg">カメラを起動しています…</p>
    <form id="isbn-form" class="search-bar" autocomplete="off">
      <input id="isbn-input" inputmode="numeric" placeholder="ISBNを手入力（978から始まる13桁）" enterkeyhint="done">
      <button type="submit" class="primary">調べる</button>
    </form>
    <button type="button" class="link scan-search-link" data-act="scan-to-search">バーコードがない本は、書名・著者で探す</button>
    <h3 class="sub">読み取った本 <span class="muted" id="scan-count">0冊</span></h3>
    <div id="scan-bulk"></div>
    <ul class="books" id="scan-list"></ul>`;
  showSheet();
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
  $('#scan-count').textContent = `${scanned.filter((s) => s.state !== 'undone').length}冊`;
  const addable = scanned.filter((s) => s.check && s.state === 'new');
  const bulk = $('#scan-bulk');
  if (bulk) bulk.innerHTML = addable.length >= 2 ? `<button type="button" class="ghost small scan-add-all" data-act="scan-add-all">持っていない${addable.length}冊をまとめて本棚に追加</button>` : '';
  list.innerHTML = scanned.map((s) => {
    if (s.check && s.state !== 'added' && s.state !== 'undone') return checkRow(s);
    const b = s.bookId ? store.get(s.bookId) : null;
    let right = '';
    let sub = '';
    // 調べている間も文言は出さない（v0.15 本人：ローディングの表示はいらない。たいていすぐ書名が出る）
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

// 読み取った本（手入力の ISBN も）：v0.18 から本棚には入れず、持っているか・何巻目かを確かめるだけ（checkIsbn）
function handleIsbn(isbn) {
  if (scanned.some((s) => s.isbn === isbn && !['undone', 'error'].includes(s.state))) return;
  navigator.vibrate?.(40);
  checkIsbn(isbn);
}

// ---------------------------------------------------------------- 本屋さんモード（v0.16 本人の⑥：本屋でバーコードを読むと、本棚に入れずに「持ってるか」を確かめる）
// 持っている（同じ ISBN・別の版・シリーズの同じ巻）→ 読了済み／読書中／本棚にある。持っていない → シリーズの何巻目か・前の巻を読んだか
const cleanIsbn = (s) => String(s || '').replace(/-/g, '');
const ownsIsbn = (b, isbn) => cleanIsbn(b.isbn) === isbn || cleanIsbn(b.coverIsbn) === isbn || (b.coverIsbns || []).map(cleanIsbn).includes(isbn);
async function checkIsbn(isbn) {
  const session = scanController;
  const entry = { isbn, check: true, state: 'loading' };
  scanned = [entry, ...scanned.filter((s) => s.isbn !== isbn)];
  const direct = store.books().find((b) => ownsIsbn(b, isbn));
  if (direct) { Object.assign(entry, { state: 'owned', bookId: direct.id }); drawScanned(); return; }
  drawScanned();
  try {
    let title = '', author = '', work = null, extra = {};
    const quick = await ndl.openBdSummary(isbn, { signal: session?.signal });
    if (session?.signal.aborted || session !== scanController) return;
    if (quick) {
      title = quick.title + (quick.volume && !quick.title.includes(quick.volume) ? ` ${quick.volume}` : '');
      author = quick.author;
      extra = { publisher: quick.publisher, year: quick.year, publishedAt: quick.publishedAt };
    } else {
      work = await ndl.searchIsbn(isbn);
      if (session?.signal.aborted || session !== scanController) return;
      if (work) { title = work.main + (work.volume ? ` ${work.volume}` : ''); author = work.authorLabel.split('、')[0] || ''; extra = { publisher: work.latest?.publisher || '', year: work.firstYear ? String(work.firstYear) : '' }; }
    }
    if (!title) { entry.state = 'notfound'; drawScanned(); return; }
    Object.assign(entry, { title, author, extra });
    const same = store.books().find((b) => normName(b.author) === normName(author) && (normTitle(b.title) === normTitle(title) || normTitle(mainTitle(b.title)) === normTitle(mainTitle(title))))
      || (work && shelfIndex()(work));
    const hint = scanSeriesHint({ title, author, isbn });
    if (same || hint.owned) Object.assign(entry, { state: 'owned', bookId: (same || hint.owned).id, otherEdition: true });
    else Object.assign(entry, { state: 'new', hint });
  } catch (e) {
    Object.assign(entry, { state: 'error', msg: e.message });
  }
  drawScanned();
}

// 読み取った本がシリーズのどの巻か。本棚の本と同じシリーズにまとまるかで確かめる（図鑑・本棚のシリーズと同じ決め方）
function scanSeriesHint({ title, author, isbn }) {
  const probe = { id: '__scan__', title, author, isbn, status: 'scan' };
  const withProbe = shelfSeries([...store.books(), probe], { stories: seriesStories() });
  const g = withProbe.find((x) => (x.named ? x.members.some((m) => m.book === probe) : [...x.owned.values()].includes(probe)));
  const readByAuthor = store.books().filter((b) => b.status === 'done' && normName(b.author) === normName(author)).length;
  if (!g) return { readByAuthor };
  // 本棚にこのシリーズの本がないときは、名前のあるシリーズ（組み込みの一覧・国会図書館のシリーズ名）だけ何作目かを出す
  const mine = currentSeries().find((x) => x.key === g.key);
  if (!mine && !g.named) return { readByAuthor };
  const d = describeSeries(mine || g, fetchedFor(mine || g));
  const t = normTitle(title), m = normTitle(mainTitle(title));
  const sv = splitVolume(title).vol || 1;
  const sameTitle = (x) => [normTitle(x.title), normTitle(mainTitle(x.title))].some((k) => k.length >= 2 && (k === t || k === m || (k.length >= 4 && (t.endsWith(k) || t.startsWith(k)))));
  const v = mine
    ? d.vols.find((x) => (x.isbn && cleanIsbn(x.isbn) === isbn) || (x.coverIsbns || []).map(cleanIsbn).includes(isbn)) || d.vols.find((x) => (d.named ? sameTitle(x) : x.vol === sv))
    : d.vols.find((x) => x.book === probe);
  if (v?.book && v.book !== probe) return { readByAuthor, owned: v.book }; // 別の版で同じ巻を持っている
  // 巻数のシリーズで、国会図書館で確かめる前（本棚にない巻は分からない）でも、書名の巻数で何巻目かを出す
  const vol = v?.vol || (d.named ? 0 : sv);
  const before = vol ? d.vols.filter((x) => x.vol < vol && !(x.upcoming && !x.book)) : [];
  return { readByAuthor, d, series: d.base, named: d.named, vol, done: mine ? d.done : 0, unreadBefore: before.filter((x) => x.book?.status !== 'done') };
}

// 読み取った本を、読みたい本として本棚へ（本人が「本棚に追加」を押したときだけ）
function addScanned(s) {
  if (!s || s.state !== 'new') return;
  const b = store.add({ title: s.title, author: s.author, status: 'want', priority: 2, source: 'scan', isbn: s.isbn, ...(s.extra || {}) });
  Object.assign(s, { state: 'added', bookId: b.id });
  enrichScanned(b.id, s.isbn);
}
function checkRow(s) {
  const b = s.bookId ? store.get(s.bookId) : null;
  const title = b?.title || s.title || `ISBN ${s.isbn}`;
  let verdict = '', tone = 'wait', right = '';
  const lines = [];
  if (s.state === 'owned' && b) {
    tone = b.status === 'done' ? 'done' : 'have';
    verdict = b.status === 'done' ? '読了済み' : b.status === 'reading' ? '読書中' : '本棚にある';
    if (b.status === 'done') lines.push(b.finishedAt ? `${monthLabel(b.finishedAt.slice(0, 7))}に読了` : '読み終えた本です');
    if (b.status === 'want') lines.push('読みたい本として本棚にあります');
    if (s.otherEdition) lines.push('別の版を持っています');
  } else if (s.state === 'new') {
    tone = 'new';
    verdict = '持っていない';
    const h = s.hint || {};
    if (h.series) {
      const where = h.vol ? `の${h.named ? `${h.vol}作目` : `${h.vol}巻`}` : '';
      lines.push(`「${h.series}」${where}`);
      if (!h.done) lines.push('このシリーズはまだ読んでいません');
      else if (!h.vol) lines.push(`このシリーズは${h.done}冊読了`);
      else if (h.unreadBefore.length) lines.push(`前の巻でまだ読んでいない：${h.unreadBefore.slice(0, 2).map((x) => volName(h.d, x)).join('・')}${h.unreadBefore.length > 2 ? ` ほか${h.unreadBefore.length - 2}冊` : ''}`);
      else lines.push('前の巻はすべて読了。次に読む巻です');
    } else if (h.readByAuthor) lines.push(`${s.author}の本は${h.readByAuthor}冊読了`);
    right = `<button type="button" class="add-btn" data-act="scan-check-add" data-isbn="${esc(s.isbn)}">本棚に追加</button>`;
  } else if (s.state === 'notfound') { tone = 'none'; verdict = '見つからない'; lines.push('書誌が見つかりませんでした'); right = `<button type="button" class="add-btn" data-act="scan-add-raw" data-isbn="${esc(s.isbn)}">ISBNだけで追加</button>`; }
  else if (s.state === 'error') { tone = 'none'; verdict = '確かめられない'; lines.push(s.msg || '通信できませんでした'); }
  return `<li class="book work check-row check-${tone}">${cover(title, s.isbn)}
    <div class="book-main">${verdict ? `<span class="check-verdict">${esc(verdict)}</span>` : ''}<div class="book-title">${esc(title)}</div>
      <div class="book-author">${esc(b?.author || s.author || '')}</div>
      ${lines.map((l) => `<div class="check-line">${esc(l)}</div>`).join('')}</div>
    ${right ? `<div class="book-side">${right}</div>` : ''}</li>`;
}

// openBD で登録した本に、国立国会図書館の書誌（分類・判型・最初の年・NDL のリンク）を裏で足す（画面には何も出さない）
async function enrichScanned(id, isbn) {
  try {
    const w = await ndl.searchIsbn(isbn);
    const b = store.get(id);
    if (!w || !b) return;
    const patch = {};
    if (!b.ndc && w.ndc) patch.ndc = w.ndc;
    if (!b.format && w.latest?.format) patch.format = w.latest.format;
    if (!b.ndl && w.latest?.link) patch.ndl = w.latest.link;
    if (w.firstYear && String(w.firstYear) < String(b.year || '9999')) patch.year = String(w.firstYear);
    if (Object.keys(patch).length) store.update(id, patch);
  } catch { /* 書誌が足りなくても本棚の本はそのまま */ }
}

// ---------------------------------------------------------------- 著書：本棚の著者の新刊・持っていない本・発売日カレンダー
// 本棚にある本の著者は自動でフォローする（store.syncShelfFollows）。著者を名前で探すのは「検索」タブの役目
function authorCounts() {
  const m = new Map();
  for (const b of store.books()) if (b.author) m.set(b.author, (m.get(b.author) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
}
const isShelfAuthor = (name) => store.books().some((b) => normName(b.author) === normName(name));

// ISO の時刻（世界標準時）を端末の時刻で「10/13 19:50」と表示する
const localTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const AUTHOR_MODES = [['unowned', '持っていない本'], ['new', '新刊'], ['calendar', 'カレンダー']]; // v0.18 本人：持っていない本を先に
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const releaseDate = (r) => (r.publishedAt?.length === 10 ? r.publishedAt : '');
const isUpcoming = (r) => { const d = releaseDate(r); return d ? d > today() : r.month > today().slice(0, 7); };
const releaseWhen = (r) => (releaseDate(r) ? publicationLabel(releaseDate(r)) : monthLabel(r.month));

function relRow(raw) {
  const r = { ...raw, ...confirmedRelease(raw) };
  const soon = isUpcoming(r);
  return `<li class="book work" data-reveal-key="${esc(`release:${r.key}`)}">
      <button type="button" class="work-open" data-act="release-detail" data-key="${esc(r.key)}" aria-label="${esc(r.title)}の本の情報">
        ${cover(r.title, r.isbn, 's', r.coverIsbns || r.coverIsbn || [], r.author)}
        <span class="book-main">
          <span class="book-title">${newKeys.has(r.key) ? '<span class="new">NEW</span>' : ''}${esc(r.title)}</span>
          <span class="book-author">${esc(r.author)}</span>
          <span class="book-meta"><b class="${soon ? 'soon' : ''}">${esc(releaseWhen(r))}${soon ? '発売予定' : '発売'}</b>${r.publisher ? `・${esc(r.publisher)}` : ''}</span>
          ${r.series ? `<span class="book-meta series-note">本棚のシリーズ「${esc(r.series)}」の新しい巻</span>` : ''}
          <span class="book-meta cover-caption" ${coverCandidates(r.isbn, r.coverIsbns || r.coverIsbn || []).length || !soon ? 'hidden' : ''}>表紙未取得</span>
        </span>
      </button>
      <div class="book-side">
        <button type="button" class="add-btn" data-act="release-add" data-key="${esc(r.key)}">＋登録</button>
        <button type="button" class="ghost small" data-act="release-dismiss" data-key="${esc(r.key)}" aria-label="この本を一覧から消す">表示しない</button>
      </div>
    </li>`;
}

function renderAuthorHome() {
  const mode = AUTHOR_MODES.some(([id]) => id === ui.authorMode) ? ui.authorMode : 'new';
  const authors = authorCounts().length;
  view.innerHTML = `<section class="works-page works-${mode}">
    ${pageHead('著書', authors ? `本棚の著者 ${authors}人` : '')}
    <div class="shelf-tabs" role="group" aria-label="著書の表示">${AUTHOR_MODES.map(([id, label]) => `<button type="button" class="shelf-mode ${mode === id ? 'on' : ''}" data-act="author-mode" data-v="${id}" aria-pressed="${mode === id}">${label}</button>`).join('')}</div>
    <div id="works-body" class="swipe-pane"></div>
  </section>`;
  if (mode === 'unowned') drawUnowned();
  else if (mode === 'calendar') drawCalendar();
  else drawNewReleases();
}

// 新刊：これから出る本を発売の早い順（月ごと）、そのあとに最近出た本
function drawNewReleases() {
  const box = $('#works-body');
  if (!box) return;
  const follows = store.follows();
  const last = follows.map((f) => f.lastChecked).filter(Boolean).sort().pop();
  const rel = store.releases().map((r) => ({ ...r, ...confirmedRelease(r) }));
  const when = (r) => releaseDate(r) || `${r.month}-99`;
  const coming = rel.filter(isUpcoming).sort((a, b) => when(a).localeCompare(when(b)));
  const out = rel.filter((r) => !isUpcoming(r)).sort((a, b) => when(b).localeCompare(when(a)));
  let rows = '';
  let month = '';
  for (const r of coming) {
    if (r.month !== month) { month = r.month; rows += `<li class="group-head"><h2>${esc(monthLabel(month))}</h2><span>発売予定</span></li>`; }
    rows += relRow(r);
  }
  if (out.length) rows += `<li class="group-head"><h2>発売済み</h2><span>ここ2か月</span></li>${out.map(relRow).join('')}`;
  const status=last ? `<p class="muted small">更新 ${esc(localTime(last))}</p>` : '';
  box.innerHTML=`${status}${rel.length ? `<ul class="books release-list">${rows}</ul>`
    : `<div class="empty"><p>${follows.length ? '新刊が見つかると、ここに並びます。' : '本棚に本を登録すると、著者の新刊がここに並びます。'}</p></div>`}
    <details class="source"><summary>新刊のお知らせについて</summary><p>本棚の著者の出版情報を自動で確かめます。出典：国立国会図書館サーチ。スマホのプッシュ通知は未対応です。</p></details>`;

  prepareBooks(box);
}

// 持っていない本：本の多い著者から順に、国会図書館で著作を調べて本棚にないものを出す（スクロールで続き）
const UNOWNED_STEP = 4;
const unowned = { works: new Map(), failed: new Set(), shown: UNOWNED_STEP, running: null, open: new Set() }; // open：「ほかの n 冊も見る」で広げた著者
let unownedObserver = null;
const unownedHideKey = (w, name) => `${w.key}|${normName(name)}`;
function unownedWorks(name, works) {
  const owned = shelfIndex();
  const hidden = new Set(store.hiddenRecs());
  const litShare = works.length ? works.filter((w) => w.isLit).length / works.length : 0;
  return works.filter((w) => !w.isComic && !w.isAnthology && (litShare < 0.6 || w.isLit)
    && !owned(w) && !hidden.has(unownedHideKey(w, name)));
}
function drawUnowned() {
  const box = $('#works-body');
  if (!box) return;
  unownedObserver?.disconnect();
  const authors = authorCounts();
  const shown = authors.slice(0, unowned.shown);
  const sections = shown.map(([name, count]) => {
    const works = unowned.works.get(name);
    const head = `<div class="unowned-head"><button type="button" class="link unowned-name" data-act="author" data-name="${esc(name)}">${esc(name)}</button>`;
    if (!works) {
      return `<section class="unowned-author">${head}<span>本棚 ${count}冊</span></div>
        </section>`;
    }
    const rows = unownedWorks(name, works);
    rows.forEach((w) => workCache.set(w.key, w));
    return `<section class="unowned-author">${head}<span>本棚 ${count}冊・持っていない本 ${rows.length}冊</span></div>
      ${rows.length ? `<ul class="books">${(unowned.open.has(name) ? rows : rows.slice(0, 4)).map((w) => workRow(w, null, '登録', { hideKey: unownedHideKey(w, name) })).join('')}</ul>
        ${rows.length > 4 && !unowned.open.has(name) ? `<button type="button" class="ghost small more-works" data-act="unowned-more" data-name="${esc(name)}">ほかの${rows.length - 4}冊も見る</button>` : ''}`
      : '<p class="muted small">持っていない本は見つかりませんでした。</p>'}
    </section>`;
  }).join('');
  const allLoaded = shown.every(([name]) => unowned.works.has(name) || unowned.failed.has(name));
  box.innerHTML = `<p class="muted small">本棚の著者の本で、まだ本棚にないもの（本棚に多い著者から）。漫画・アンソロジーは除いています。</p>
    ${sections || '<p class="muted">本棚に本が入ると、その著者の持っていない本をここに出します。</p>'}
    ${unowned.shown < authors.length ? `<p class="unowned-more muted small" role="status">${allLoaded ? '下へスクロールすると続きを読み込みます' : ''}</p>` : ''}
    <p class="source">出典：国立国会図書館サーチ（国立国会図書館の所蔵資料）</p>`;
  prepareBooks(box);
  loadUnowned();
  const more = $('.unowned-more');
  if (more && allLoaded && 'IntersectionObserver' in window) {
    unownedObserver = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || unowned.running) return;
      unownedObserver.disconnect();
      unowned.shown += UNOWNED_STEP;
      drawUnowned();
    }, { rootMargin: '0px 0px 300px 0px' });
    unownedObserver.observe(more);
  }
}
function loadUnowned() {
  if (unowned.running) return;
  const todo = authorCounts().slice(0, unowned.shown).map(([n]) => n).filter((n) => !unowned.works.has(n) && !unowned.failed.has(n));
  if (!todo.length) return;
  unowned.running = (async () => {
    for (const name of todo) {
      if (route.name !== 'author' || route.arg || ui.authorMode !== 'unowned') break; // 画面を離れたら止め、戻ったら続きから
      try { unowned.works.set(name, await ndl.searchAuthor(name)); } catch { unowned.failed.add(name); }
      drawUnowned();
    }
  })().finally(() => {
    unowned.running = null;
    if (route.name === 'author' && !route.arg && ui.authorMode === 'unowned') drawUnowned();
  });
}

// カレンダー：フォロー中の著者の新刊・シリーズの新しい巻・本棚に登録した発売予定の本
function calendarItems() {
  const items = [];
  const seen = new Set();
  for (const raw of store.releases()) {
    const r = { ...raw, ...confirmedRelease(raw) };
    seen.add(`${normTitle(r.title)}|${normName(r.author)}`);
    items.push({ kind: 'release', key: r.key, title: r.title, author: r.author, date: releaseDate(r), month: r.month,
      isbn: r.isbn, coverIsbns: r.coverIsbns || [].concat(r.coverIsbn || []), publisher: r.publisher, series: r.series || '' });
  }
  const from = monthsAgo(2);
  for (const b of store.books()) {
    const d = b.publishedAt || '';
    if (d.length < 7 || d.slice(0, 7) < from || seen.has(`${normTitle(b.title)}|${normName(b.author)}`)) continue;
    items.push({ kind: 'book', id: b.id, title: b.title, author: b.author, date: d.length === 10 ? d : '', month: d.slice(0, 7),
      isbn: b.isbn, coverIsbns: b.coverIsbns || [].concat(b.coverIsbn || []), publisher: b.publisher, series: '' });
  }
  return items;
}
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (s) => new Date(`${s}T00:00:00`);
const weekStart = (s) => { const d = dateOf(s); d.setDate(d.getDate() - d.getDay()); return ymdOf(d); };
const dayLabel = (s) => { const d = dateOf(s); return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`; };

function calendarBookLine(it) {
  return `<button type="button" class="cal-line" data-act="cal-day" data-date="${esc(it.date)}">
    ${cover(it.title, it.isbn, 'xs', it.coverIsbns, it.author)}
    <span class="cal-line-main"><span class="cal-line-title">${esc(it.title)}</span><span class="cal-line-author">${esc(it.author)}${it.kind === 'book' ? '・本棚' : ''}</span></span>
  </button>`;
}
function undatedList(items, month) {
  const list = items.filter((it) => !it.date && it.month === month);
  if (!list.length) return '';
  return `<section class="cal-undated"><h3>日付未定（${esc(monthLabel(month))}発売予定）</h3>
    <ul>${list.map((it) => `<li><button type="button" class="cal-line" data-act="${it.kind === 'release' ? 'release-detail' : 'open'}" ${it.kind === 'release' ? `data-key="${esc(it.key)}"` : `data-id="${esc(it.id)}"`}>
      ${cover(it.title, it.isbn, 'xs', it.coverIsbns, it.author)}<span class="cal-line-main"><span class="cal-line-title">${esc(it.title)}</span><span class="cal-line-author">${esc(it.author)}</span></span></button></li>`).join('')}</ul></section>`;
}

// 日付のマス（月表示・週表示で同じ見た目）。本がある日は表紙と冊数、タップでその日の本
function calCell(date, list, t, label) {
  const cls = `cal-cell${date === t ? ' today' : ''}${list.length ? ' has' : ''}${dateOf(date).getDay() === 0 ? ' sun' : ''}`;
  return list.length
    ? `<div class="${cls}"><button type="button" class="cal-day" data-act="cal-day" data-date="${date}" aria-label="${esc(dayLabel(date))} ${list.length}冊"><span class="cal-num">${label}</span>${cover(list[0].title, list[0].isbn, 'xs', list[0].coverIsbns, list[0].author)}${list.length > 1 ? `<span class="cal-count">+${list.length - 1}</span>` : ''}</button></div>`
    : `<div class="${cls}"><span class="cal-num">${label}</span></div>`;
}
const calHead = () => WEEKDAYS.map((w, i) => `<div class="cal-dow${i === 0 ? ' sun' : ''}" aria-hidden="true">${w}</div>`).join('');
// 月・週の下に出す発売の一覧（日付の早い順）
function calDayList(list, heading, emptyText) {
  return list.length ? `<section class="cal-month-list"><h3>${heading}</h3><ul>${list.map((it) => `<li><span class="cal-date">${Number(it.date.slice(8))}日<small>${WEEKDAYS[dateOf(it.date).getDay()]}</small></span>${calendarBookLine(it)}</li>`).join('')}</ul></section>`
    : `<p class="muted cal-empty">${emptyText}</p>`;
}

function drawCalendar() {
  const box = $('#works-body');
  if (!box) return;
  const mode = ui.calView === 'week' ? 'week' : 'month';
  const items = calendarItems();
  const byDate = new Map();
  for (const it of items) if (it.date) byDate.set(it.date, [...(byDate.get(it.date) || []), it]);
  const t = today();
  const switcher = `<div class="cal-bar">
      <div class="cal-switch" role="group" aria-label="カレンダーの表示">${[['month', '月'], ['week', '週']].map(([id, label]) => `<button type="button" class="${mode === id ? 'on' : ''}" data-act="cal-view" data-v="${id}" aria-pressed="${mode === id}">${label}</button>`).join('')}</div>
      <button type="button" class="ghost small" data-act="cal-today">今日</button>
    </div>`;
  let body = '';
  if (mode === 'month') {
    const ym = /^\d{4}-\d{2}$/.test(ui.calMonth || '') ? ui.calMonth : t.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<div class="cal-cell blank" aria-hidden="true"></div>');
    for (let d = 1; d <= days; d++) {
      const date = `${ym}-${String(d).padStart(2, '0')}`;
      cells.push(calCell(date, byDate.get(date) || [], t, d));
    }
    const monthItems = items.filter((it) => it.date && it.date.startsWith(ym)).sort((a, b) => a.date.localeCompare(b.date));
    body = `<div class="cal-nav"><button type="button" class="icon-btn" data-act="cal-move" data-v="-1" aria-label="前の月">‹</button><h2>${y}年${m}月</h2><button type="button" class="icon-btn" data-act="cal-move" data-v="1" aria-label="次の月">›</button></div>
      <div class="cal-grid" role="grid" aria-label="${y}年${m}月の発売日">${calHead()}${cells.join('')}</div>
      ${calDayList(monthItems, 'この月の発売', 'この月に発売日が分かっている本はありません。')}
      ${undatedList(items, ym)}`;
  } else {
    // 1 週間を月表示と同じマスで横一列に。月をまたぐ週は 1 日に「11/1」のように月も添える
    const start = /^\d{4}-\d{2}-\d{2}$/.test(ui.calWeek || '') ? weekStart(ui.calWeek) : weekStart(t);
    const dates = Array.from({ length: 7 }, (_, i) => { const d = dateOf(start); d.setDate(d.getDate() + i); return ymdOf(d); });
    const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
    const md = (s) => { const d = dateOf(s); return `${d.getMonth() + 1}月${d.getDate()}日`; };
    const label = (s) => { const d = dateOf(s); return d.getDate() === 1 && months.length > 1 ? `${d.getMonth() + 1}/1` : d.getDate(); };
    const weekItems = items.filter((it) => it.date && it.date >= dates[0] && it.date <= dates[6]).sort((a, b) => a.date.localeCompare(b.date));
    body = `<div class="cal-nav"><button type="button" class="icon-btn" data-act="cal-move" data-v="-1" aria-label="前の週">‹</button><h2>${md(dates[0])}〜${md(dates[6])}</h2><button type="button" class="icon-btn" data-act="cal-move" data-v="1" aria-label="次の週">›</button></div>
      <div class="cal-grid week" role="grid" aria-label="${esc(`${md(dates[0])}から${md(dates[6])}の発売日`)}">${calHead()}${dates.map((date) => calCell(date, byDate.get(date) || [], t, label(date))).join('')}</div>
      ${calDayList(weekItems, 'この週の発売', 'この週に発売日が分かっている本はありません。')}
      ${months.map((mo) => undatedList(items, mo)).join('')}`;
  }
  // 新刊を集めている途中の表示は出さない（v0.18.1 本人：読み込みは裏で。集まったら描き直す）
  box.innerHTML = `${switcher}${body}
    <p class="source">フォロー中の著者（本棚の著者）の新刊、本棚のシリーズの新しい巻、本棚に登録した発売予定の本。日付は出版社の近刊情報（国立国会図書館サーチ）です。</p>`;
}

// 日付をタップ：その日に出る本を、表紙と短い内容紹介で
let daySheet = null;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trim()}…` : s);
function renderCalendarDay(date) {
  stopBookPreview(); flushMemo(); stopScanning(); openId = null;
  const items = calendarItems().filter((it) => it.date === date);
  const controller = new AbortController();
  daySheet = { controller, date };
  sheetBody.innerHTML = `<h2 class="sheet-title">${esc(dayLabel(date))}${date > today() ? '発売予定' : '発売'}</h2>
    ${items.length ? `<ul class="day-books">${items.map((it, i) => `<li class="day-book">
      ${cover(it.title, it.isbn, 'm', it.coverIsbns, it.author)}
      <div class="day-book-main">
        <h3>${esc(it.title)}</h3>
        <p class="book-author">${esc(it.author)}${it.publisher ? `・${esc(it.publisher)}` : ''}</p>
        ${it.series ? `<p class="book-meta series-note">本棚のシリーズ「${esc(it.series)}」の新しい巻</p>` : ''}
        <div class="day-synopsis" id="day-syn-${i}" ${peekBookDetails(it)?.synopsis ? '' : 'hidden'}>${esc(clip(peekBookDetails(it)?.synopsis || '',120))}</div>
        <div class="row">${it.kind === 'release'
          ? `<button type="button" class="ghost small" data-act="release-detail" data-key="${esc(it.key)}">詳しく見る</button><button type="button" class="add-btn" data-act="release-add" data-key="${esc(it.key)}">＋登録</button>`
          : `<button type="button" class="ghost small" data-act="open" data-id="${esc(it.id)}">本棚の記録を開く</button>`}</div>
      </div>
    </li>`).join('')}</ul>` : '<p class="muted">この日に出る本はありません。</p>'}`;
  showSheet();
  sheetBody.scrollTop = 0;
  items.forEach(async (it, i) => {
    const put = (text) => { if (daySheet?.controller === controller) { const el = $(`#day-syn-${i}`); if (el) { el.textContent = text; el.hidden=!text; } } };
    try {
      const info = await loadBookDetails({ isbn: it.isbn, title: it.title, author: it.author }, { signal: controller.signal });
      put(info.synopsis ? clip(info.synopsis,120) : '');
    } catch {}
  });
}

// 著者のページ（著書の名前や本の詳細から開く）。名前で探すのは「検索」タブ
function renderAuthor(name) {
  const token = ++renderToken;
  // 著書を開いたら、確かめてから時間のたった著者をすべて確かめる（起動時は一部だけ。端末ごとに新刊・カレンダーの冊数がずれないように）
  if (!name) { renderAuthorHome(); hydrateReleaseCovers().finally(() => { if (route.name === 'author' && !route.arg) checkReleases(staleFollows()); }); return; }
  // v0.18.1 本人：読み込みの表示で待たせない。著書の「持っていない本」などで読み込み済みの作品はすぐ出し、裏で確かめ直す
  const cached = (lastAuthor?.name === name && lastAuthor.works) || unowned.works.get(name) || null;
  view.innerHTML = `
    <section>
      <a class="back-link" href="#author">‹ 著書</a>
      <div id="author-result">${cached ? '' : `<div class="result-head"><div class="result-title"><h2 class="result-name">${esc(name)}</h2></div></div>`}</div>
    </section>`;
  if (cached) drawAuthorResult(name, cached);
  ndl.searchAuthor(name).then((works) => {
    if (token !== renderToken) return;
    lastAuthor = { name, works };
    if (!cached || works.length !== cached.length) drawAuthorResult(name, works);
  }).catch((e) => {
    if (token !== renderToken || cached) return;
    $('#author-result').insertAdjacentHTML('beforeend', errorBox(e.message));
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
  const follow = isShelfAuthor(name)
    ? '<span class="follow-btn on auto">本棚の著者・新刊を確認中</span>'
    : `<button type="button" class="follow-btn ${store.isFollowing(name) ? 'on' : ''}" data-act="toggle-follow" data-name="${esc(name)}" aria-pressed="${store.isFollowing(name)}">${store.isFollowing(name) ? 'フォロー中' : '新刊をフォロー'}</button>`;
  $('#author-result').innerHTML = `
    <div class="result-head">
      <div class="result-title">
        <h2 class="result-name">${esc(name)}</h2>
        ${follow}
      </div>
      <p class="tally"><b>${visible.length}</b>作品 ・ 読了 <b>${done}</b> ・ 本棚で未読 <b>${onShelf}</b> ・ まだ登録していない <b class="accent">${unknown}</b></p>
      <div class="chips wrap">${toggle('unreadOnly', '未読だけ')}${toggle('notOnShelf', '本棚にない本だけ')}${litShare >= 0.6 ? toggle('showOther', '小説以外も') : ''}${toggle('showAntho', 'アンソロジー・共著も')}</div>
    </div>
    ${shown.length ? `<ul class="books">${shown.map((r) => workRow(r.w, r.o)).join('')}</ul>`
    : `<div class="empty"><p class="empty-title">${works.length ? '未読の作品はありません' : '作品が見つかりませんでした'}</p><p>${works.length ? '「未読だけ」を外すと読了の作品も表示します。' : '著者名の漢字や表記（姓と名の間の・など）を確認してください。'}</p></div>`}
    <p class="source">出典：国立国会図書館サーチ（国立国会図書館の所蔵資料）。刊行直後の新刊は載るまで数週間かかることがあります。</p>`;
  prepareBooks($('#author-result'));
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
        // 出版社の近刊情報には発売日まであることが多い（カレンダーで使う）
        publishedAt: w.editions.map((e) => e.publishedAt || '').filter((d) => d.length === 10 && d.startsWith(w.lastMonth)).sort().pop() || '',
        publisher: w.latest?.publisher || '', isbn: w.latest?.isbn || '', link: w.latest?.link || '', ndc: w.ndc || '',
      }));
      for (const it of items.filter(x=>!x.isbn || x.month>=today().slice(0,7))) {
        if (!store.isFollowing(name)) break;
        try { Object.assign(it,await resolveReleaseCovers(it)); } catch { /* 書誌の新刊確認は続ける */ }
      }
      found += store.addReleases(name, items, { window: from, complete: !!works.complete });
    } catch (e) {
      checkError = e.message;
    }
    checking.done += 1;
    checking.total = checking.done + pendingReleaseNames.size;
    refreshReleaseUI();
  }
  checking = null;
  refreshReleaseUI();
  if (found) toast(`本棚の著者などの新刊・近刊が${found}冊見つかりました（著書タブ）`);
}

async function resolveReleaseCovers(item) {
  const confirmed=confirmedRelease(item);
  const release={...item,...confirmed};
  const identity=releaseIdentity(release);
  const works=await ndl.searchTitle(identity.base,item.author,{allSources:true,priority:0});
  const isbn=currentReleaseIsbn(release,works);
  if (isbn) release.isbn=isbn;
  let coverIsbns=previousCoverIsbns(release,works);
  // 旧版の副題が「爆弾 2」、新刊が「爆弾2」のように異なり、NDLの書名検索で漏れる場合。
  const broader=identity.base.match(/^(.{2,})\s+[^\s]*\d+$/)?.[1];
  if (!coverIsbns.length && broader && broader!==identity.base) {
    const editions=await ndl.searchTitle(broader,item.author,{allSources:true,priority:0});
    coverIsbns=previousCoverIsbns(release,editions); // 候補を広げても書名・巻・著者の一致は保つ
  }
  return {...confirmed,...(isbn ? {isbn} : {}),coverIsbns,coverIsbn:coverIsbns[0] || '',coverCheckedAt:new Date().toISOString(),coverLookupVersion:COVER_LOOKUP_VERSION};
}
let hydratingReleaseCovers=null;
function hydrateReleaseCovers() {
  if (hydratingReleaseCovers) return hydratingReleaseCovers;
  const items=store.releases().filter(r=>(store.isFollowing(r.author) || r.series)
    && (r.coverLookupVersion!==COVER_LOOKUP_VERSION || !r.coverCheckedAt || Date.now()-Date.parse(r.coverCheckedAt)>7*24*3600*1000));
  hydratingReleaseCovers=(async()=>{
    for (const item of items) {
      if ((route.name==='search' && ui.searchQ) || sheet.open) break; // 手入力/検索を待たせず、著者画面へ戻ったとき再開する
      const keep=()=>store.isFollowing(item.author) || item.series;
      if (!keep() || !store.releases().some(r=>r.key===item.key)) continue;
      try {
        const patch=await resolveReleaseCovers(item);
        if (keep()) store.updateReleaseCovers(item.key,patch);
      } catch { /* 一時的な通信エラーでは更新済み扱いにせず、次回に試す */ }
    }
  })().finally(()=>{hydratingReleaseCovers=null;});
  return hydratingReleaseCovers;
}

// 12 時間たった著者を、自分でフォローした著者 → 本棚に多い著者 → 確認の古い順に並べる
function staleFollows() {
  const count = new Map(authorCounts().map(([n, c]) => [normName(n), c]));
  return store.follows()
    .filter((f) => !f.lastChecked || Date.now() - Date.parse(f.lastChecked) > 12 * 3600 * 1000)
    .sort((a, b) => Number(!!a.auto) - Number(!!b.auto) || (count.get(normName(b.name)) || 0) - (count.get(normName(a.name)) || 0)
      || (a.lastChecked || '').localeCompare(b.lastChecked || ''))
    .map((f) => f.name);
}
const AUTO_CHECK_LIMIT = 8; // 起動時に調べる著者の数（国会図書館への問い合わせを重くしすぎない）

// 本棚の著者を自動でフォローし、新しく加わった著者の新刊はすぐ調べる
function syncShelfAuthors() {
  const before = new Set(store.follows().map((f) => normName(f.name)));
  if (!store.syncShelfFollows(authorCounts().map(([n]) => n))) return;
  const added = store.follows().filter((f) => !before.has(normName(f.name))).map((f) => f.name);
  if (added.length && added.length <= 5) checkReleases(added);
}

// ---------------------------------------------------------------- 検索：書名・著者・ISBN で探して本棚に登録する

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
  view.innerHTML=`<section class="search-page">
    ${pageHead('検索','')}
    <button type="button" class="scan-btn search-scan" data-act="open-scan">${SCAN_ICON}<span>バーコードで読み取る</span></button>
    <form id="book-search-form" class="search-bar book-search" role="search" autocomplete="off">
      <label class="search-wrap">${icon('search')}<span class="sr-only">書名・著者・ISBN</span><input id="book-q" type="search" placeholder="書名・著者・ISBN" value="${esc(ui.searchQ)}" enterkeyhint="search"></label>
      <button type="submit" class="primary">検索</button>
    </form><div id="search-result"></div></section>`;
  if(ui.searchQ)runBookSearch();else loadRecommendations();
}

// ---------------------------------------------------------------- おすすめ（検索する前に表示）
const dayIndex = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);

// 著者を 1 人ずつ調べ、届いた分から表示する。検索を始めたり別の画面へ移ったら止め、戻ったら続きから。
async function loadRecommendations() {
  const books = store.books();
  const shift = dayIndex() + (ui.recShift || 0);
  const plan = recommendPlan(books, shift, store.snapshot().favoriteGenres);
  const sig = `${shift}|${plan.jobs.map((j) => j.name).join(',')}`;
  if (!recState || recState.sig !== sig) recState = { sig, plan, results: plan.jobs.map(job=>recPool.has(job.name)?{job,works:recPool.get(job.name)}:null), running: false, error: '' };
  const state = recState;
  const seq = ++recSeq;
  state.running = state.results.filter(Boolean).length < plan.jobs.length;
  drawRecommendations();
  for (const [i, job] of plan.jobs.entries()) {
    if (state.results[i]) continue;
    if (seq !== recSeq || route.name !== 'search' || ui.searchQ) { state.running = false; return; }
    try {
      const works=await ndl.searchAuthor(job.name,{priority:1});
      recPool.set(job.name,works);
      state.results[i] = { job, works };
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

  const done = results.filter(Boolean).length;
  const items = pickRecommendations(results, { owned: shelfIndex(), hidden: new Set(store.hiddenRecs()), shelfTitles: shelfTitleMap(store.books()), shift: ui.recShift || 0 });
  box.innerHTML = `<section class="recs" aria-labelledby="recs-title">
      <div class="recs-head"><h2 id="recs-title">あなたへのおすすめ</h2><button type="button" class="kuji-btn" data-act="kuji">${icon('cards')}<span>次の1冊</span></button></div>
      <p class="recs-taste">${plan.fromPreferences ? '好きなジャンル' : '本棚の傾向'}：${plan.taste.map(esc).join('・')}</p>

      ${items.length ? `<ul class="books">${items.map(({ w, reason }) => workRow(w, null, '登録', { reason, hideKey: w.key })).join('')}</ul>`
    : (running ? '' : `<div class="empty"><p>見つかったおすすめが、ここに並びます。</p></div>`)}
      <p class="source">好きなジャンルや本棚の傾向から選んでいます。出典：国立国会図書館サーチ</p>
    </section>${manualAdd()}`;
  prepareBooks(box);
}

async function runBookSearch() {
  const q = ui.searchQ.trim();
  const kind = 'all';
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
    : `<div class="empty"><p class="empty-title">見つかりませんでした</p><p>書名や著者名を短くして検索してみてください。</p></div>${manualAdd(q)}`;
  prepareBooks(box);
}

// ---------------------------------------------------------------- 読書の記録：本と読了日を履歴として並べる。
function renderStats() {
  if (zukanPath()) { renderZukan(); return; }
  const linkCode = location.hash.match(/^#stats\/import\/([^/?#]+)$/)?.[1];
  if (linkCode) {
    history.replaceState(null, '', '#stats');
    setTimeout(() => importByCode(decodeURIComponent(linkCode)), 0);
  }
  const all = store.books();
  const done = all.filter((b) => b.status === 'done').sort((a,b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
  const years = [...new Set(done.map((b) => (b.finishedAt || '').slice(0,4)).filter(Boolean))].sort().reverse();
  const year = years.includes(ui.historyYear) ? ui.historyYear : 'all'; // 選んでいた年の本がなくなったら、すべてを出す
  const shown = year === 'all' ? done : done.filter((b) => (b.finishedAt || '').startsWith(year));
  let lastMonth = '';
  const rows = shown.map((b) => {
    const month = b.finishedAt ? b.finishedAt.slice(0,7) : 'unknown';
    let heading = '';
    if (month !== lastMonth) { lastMonth = month; heading = `<li class="history-month">${month === 'unknown' ? '読了日未登録' : esc(monthLabel(month))}</li>`; }
    // 読了日のない本は日付の欄を置かない（v0.15 本人：本の横の小さい横線はいらない）。右端の矢印も置かない（v0.15.3）
    return `${heading}<li class="book history-book" role="button" tabindex="0" data-act="open" data-id="${esc(b.id)}" aria-label="${esc(b.title)}の読書記録">
      ${b.finishedAt ? `<span class="finished-day">${Number(b.finishedAt.slice(8,10))}<small>日</small></span>` : ''}
      ${cover(b.title,b.isbn,'s',b.coverIsbns || b.coverIsbn || [],b.author)}<div class="book-main"><div class="book-title">${esc(b.title)}</div><div class="book-author">${esc(b.author)}</div>
        ${b.memo ? `<p class="history-memo">${esc(b.memo)}</p>` : ''}${b.rating ? `<span class="rating">${stars(b.rating)}</span>` : ''}</div>
    </li>`;
  }).join('');
  view.innerHTML = `<section class="history">
    ${pageHead('読書の記録', `${done.length}冊を読了`)}
    ${zukanEntry()}
    <div class="history-intro"><p>読み終えた本と、その日の記録。</p>${yearChart(done, years, year)}</div>
    ${rows ? `<ul class="books history-list">${rows}</ul>` : '<div class="empty"><span class="empty-icon">'+icon('book')+'</span><h2>まだ読了の記録がありません</h2><p>本の詳細で「読了」を選ぶと、<br>読み終えた日と一緒にここへ並びます。</p><a href="#shelf" class="primary">本棚を開く</a></div>'}
    <details id="sync-panel" class="backup-panel sync-panel"><summary><span>同期設定</span><span id="sync-label" class="muted">${sync.status().on ? 'オン' : '未設定'}</span></summary><section id="sync-card" class="sync-card">${syncCard()}</section></details>
    <details class="backup-panel"><summary><span>データのバックアップ</span><span class="muted">${all.length}冊</span></summary>
      <p>本棚はこのブラウザに保存されています。別のブラウザやURLへは、バックアップを書き出して移せます。</p>
      <div class="row"><button type="button" class="primary" data-act="export">バックアップを書き出す</button><label class="ghost file-btn">バックアップから戻す<input id="import-file" type="file" accept="application/json,.json"></label></div>
      <p class="muted small">ほかのブラウザのバックアップや本の一覧のファイルを、いまの本棚に足すこともできます（置き換えません）。</p>
      <div class="row"><label class="ghost file-btn">本を追加で読み込む<input id="merge-file" type="file" accept="application/json,.json"></label></div>
      <form id="import-code-form" class="import-code" autocomplete="off"><label><span class="label">取り込みコードで追加</span><input id="import-code" inputmode="url" spellcheck="false" autocapitalize="off" placeholder="コードを貼り付け"></label><button type="submit" class="ghost small">追加する本を見る</button></form>
      <p class="muted small">更新 ${esc(localTime(store.snapshot().updatedAt))}</p><button type="button" class="link small" data-act="backup-preview">バックアップの内容を確認</button>
    </details><p class="app-footer">読書手帖 <span>${APP_VERSION}</span><button type="button" class="link" data-act="versions">バージョン履歴</button></p>
  </section>`;
  // 年が多くて横に収まらないときは、選んだ年（すべてなら新しい年）が見える位置へ
  const bars = $('.yc-bars');
  if (bars && bars.scrollWidth > bars.clientWidth) {
    const on = bars.querySelector('.yc-bar.on');
    bars.scrollLeft = on ? on.offsetLeft - (bars.clientWidth - on.offsetWidth) / 2 : bars.scrollWidth;
  }
}

// 読了した年：年ごとの冊数を 1 行の棒グラフで見せ、棒に触れるとその年の本だけ、「すべて」で全部
// （v0.15.2 本人：すべて〜2015年のボタンが多すぎる。読了日はそのまま、見せ方だけ変える）
// 年は '25、冊数は「7冊」と書き分け、どちらが年か冊数か迷わないように（v0.15.3）
function yearChart(done, years, year) {
  if (!years.length) return '';
  const count = new Map();
  for (const b of done) { const y = (b.finishedAt || '').slice(0, 4); if (y) count.set(y, (count.get(y) || 0) + 1); }
  const span = [];
  for (let y = Number(years.at(-1)); y <= Number(years[0]); y++) span.push(String(y)); // 読まなかった年も、間を空けて並べる
  const max = Math.max(...count.values());
  const all = year === 'all';
  const label = all ? `${years.length > 1 ? `${years.at(-1)}〜${years[0]}` : years[0]}年` : `${year}年`;
  return `<div class="year-chart">
    <div class="yc-head"><span class="yc-label">${esc(label)}<b>${all ? done.length : count.get(year)}</b>冊</span>
      <button type="button" class="yc-all ${all ? 'on' : ''}" data-act="history-year" data-v="all" aria-pressed="${all}">すべて</button></div>
    <div class="yc-bars" role="group" aria-label="読了した年">${span.map((y) => {
      const n = count.get(y) || 0;
      const inner = `<span class="yc-plot">${n ? `<span class="yc-n">${n}<small>冊</small></span>` : ''}<i style="height:${n ? 4 + Math.round((n / max) * 34) : 2}px"></i></span><span class="yc-y">'${y.slice(2)}</span>`;
      return n
        ? `<button type="button" class="yc-bar ${y === year ? 'on' : ''}" data-act="history-year" data-v="${y}" aria-pressed="${y === year}" aria-label="${y}年 ${n}冊">${inner}</button>`
        : `<span class="yc-bar none" aria-hidden="true">${inner}</span>`;
    }).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- 読書図鑑（記録タブ）
// 読んだ本が 1 冊でもあるシリーズを、著者のフォルダ → シリーズ → トレカのバインダーで見せる。
// 読んだ本は濃く、まだ読んでいない巻（本棚にある・持っていない・発売予定）は薄いカードで先に入れておく。
// 場所：#stats/zukan（著者の一覧）・#stats/zukan/著者・#stats/zukan/著者/シリーズの key
function zukanPath() {
  const parts = location.hash.replace(/^#/, '').split('/');
  if (parts[0] !== 'stats' || parts[1] !== 'zukan') return null;
  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch { return ''; } };
  return { author: dec(parts[2]), key: dec(parts[3]) };
}
const zukanHref = (author = '', key = '') => `#stats/zukan${author ? `/${encodeURIComponent(author)}` : ''}${author && key ? `/${encodeURIComponent(key)}` : ''}`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const zbar = (a, b) => `<span class="zbar" aria-hidden="true"><i style="width:${pct(a, b)}%"></i></span>`;
const ZUKAN_STATE = { read: '読了', shelf: '本棚にある・まだ読んでいない', missing: 'まだ読んでいない', coming: '発売予定' };
const cardState = (v) => (v.book?.status === 'done' ? 'read' : v.book ? 'shelf' : v.upcoming ? 'coming' : 'missing');

// 読んだ本はすべて図鑑に入る：シリーズの本はシリーズのバインダーに、シリーズでない本は著者ごとの「単発作品」に。
// 何冊も読んでいる著者（ZUKAN_FULL_MIN 冊以上）の単発作品は、まだ持っていない作品も薄いカードで並べる
// （本人：単発の作品は 1 つの図鑑に。何冊も読んでいる作者なら本棚にない単発作品も入れて、手に取るきっかけに）
const OTHERS = '単発作品';
const ZUKAN_FULL_MIN = 3;
const readCountOf = (key) => store.books().filter((b) => b.status === 'done' && normName(b.author) === key).length;
function zukanAuthors() {
  const by = new Map();
  const inSeries = new Set();
  const groups = currentSeries();
  const author = (name) => {
    const k = normName(name);
    if (!by.has(k)) by.set(k, { key: k, name, series: [], read: 0, total: 0 });
    return by.get(k);
  };
  for (const s of groups) {
    const d = describeSeries(s, fetchedFor(s));
    if (!isRealSeries(d)) continue;
    for (const v of d.vols) if (v.book) inSeries.add(v.book.id);
    if (s.named) s.members.forEach((m) => inSeries.add(m.book.id)); else s.owned.forEach((b) => inSeries.add(b.id));
    if (!d.done) continue;
    const a = author(d.author);
    a.series.push(d); a.read += d.done; a.total += d.total;
  }
  // 単発作品：シリーズに入らない本（読了の本がある著者だけ）。上・下は 1 枚
  const others = new Map();
  for (const b of store.books()) {
    if (!b.author || inSeries.has(b.id)) continue;
    const k = normName(b.author);
    if (!others.has(k)) others.set(k, { name: b.author, books: [] });
    others.get(k).books.push(b);
  }
  for (const [k, o] of others) {
    if (!o.books.some((b) => b.status === 'done')) continue;
    const items = [];
    const find = (b) => items.find((it) => it.keys.has(normTitle(workBase(b.title))) || (b.isbn && it.isbns.has(b.isbn)));
    const full = authorWorks.get(k);
    if (full?.full && readCountOf(k) >= ZUKAN_FULL_MIN) {
      for (const w of standaloneWorks(full.works, o.name, groups)) {
        items.push({ title: workBase(w.main), keys: new Set([normTitle(workBase(w.main)), ...(w.keys || [])]), isbns: new Set(w.isbns || []), info: volInfo(w), book: null });
      }
    }
    for (const b of o.books) {
      if (b.status !== 'done' && !find(b)) continue; // 持っていない作品の一覧にない本棚の本は出さない（読了の本だけ足す）
      let it = find(b);
      if (!it) items.push(it = { title: workBase(b.title), keys: new Set([normTitle(workBase(b.title))]), isbns: new Set([b.isbn].filter(Boolean)), info: { ...volInfo(null), month: (b.publishedAt || '').slice(0, 7) || String(b.year || '') }, book: null });
      if (!it.book || (b.status === 'done' && it.book.status !== 'done')) it.book = b;
    }
    // 刊行の古い順に番号を振る（わからない本は最後）
    const vols = items.sort((x, y) => (x.info.month || '9999').localeCompare(y.info.month || '9999') || x.title.localeCompare(y.title, 'ja'))
      .map((it, i) => ({ ...it.info, vol: i + 1, title: it.title, book: it.book }));
    const done = vols.filter((v) => v.book?.status === 'done').length;
    const a = author(by.get(k)?.name || o.name);
    a.series.push({ key: `o:${k}`, base: OTHERS, author: a.name, named: true, others: true, vols, done, total: vols.length,
      next: vols.find((v) => v.book?.status !== 'done' && !v.upcoming) || null, coming: vols.filter((v) => v.upcoming && !v.book) });
    a.read += done; a.total += vols.length;
  }
  const list = [...by.values()];
  for (const a of list) a.series.sort((x, y) => Number(!!x.others) - Number(!!y.others) || y.done - x.done || x.base.localeCompare(y.base, 'ja'));
  return list.sort((x, y) => y.read - x.read || x.name.localeCompare(y.name, 'ja'));
}
// 図鑑のカード・バインダーのシリーズ（「そのほかの作品」も含む）
const zukanSeries = (key) => zukanAuthors().flatMap((a) => a.series).find((d) => d.key === key) || null;
const readCovers = (vols, n) => vols.filter((v) => v.book?.status === 'done').slice(-n).map((v) => cover(v.book.title, v.book.isbn, 'xs', v.book.coverIsbns || v.book.coverIsbn || [], v.book.author));

// 記録の画面の入口（データのバックアップの上）
function zukanEntry() {
  const authors = zukanAuthors();
  const read = authors.reduce((n, a) => n + a.read, 0);
  const total = authors.reduce((n, a) => n + a.total, 0);
  const peek = authors.flatMap((a) => a.series.map((d) => readCovers(d.vols, 1)[0])).filter(Boolean).slice(0, 3);
  return `<a class="zukan-entry" href="${zukanHref()}">
    <span class="zukan-entry-art" aria-hidden="true">${peek.length ? peek.join('') : '<span class="cover xs"></span><span class="cover xs"></span><span class="cover xs"></span>'}</span>
    <span class="zukan-entry-main"><span class="zukan-entry-title">読書図鑑</span>
      <span class="zukan-entry-sub">${authors.length ? `${authors.length}人の著者・${authors.reduce((n, a) => n + a.series.filter((x) => !x.others).length, 0)}シリーズ` : '本を読了にすると、ここに集まります'}</span>
      ${total ? `<span class="zukan-entry-count">集めた <b>${read}</b> / ${total}冊</span>${zbar(read, total)}` : ''}</span></a>`;
}

// トレカ 1 枚。読了は濃く、それ以外は薄い（本棚にある・発売予定は小さな印つき）
function tradingCard(d, v) {
  const st = cardState(v);
  const title = mainTitle(v.title);
  // 巻数のシリーズは同じ書名が並ぶので、副題（なければ「第 n 巻」）を見せる。持っている巻は本棚の書名から
  let name = title;
  if (!d.named) {
    const own = mainTitle(v.book?.title || v.title);
    name = (normTitle(own).startsWith(normTitle(d.base)) ? own.slice(d.base.length) : own)
      .replace(/^[\s　・:：]*(?:第\s*)?(?:act\s*|vol\.?\s*)?(?:\d{1,3}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[IVX]{1,4})(?:\s*巻)?(?=[\s(（]|$)[\s　]*/i, '')
      .replace(/^[(（](.+)[)）]$/, '$1').trim() || `第${v.vol}巻`;
  }
  const c = v.book ? cover(v.book.title, v.book.isbn, 'card', v.book.coverIsbns || v.book.coverIsbn || [], d.author) : cover(v.title, v.isbn, 'card', v.coverIsbns || [], d.author);
  const tag = st === 'shelf' ? '<span class="tcard-tag">本棚</span>' : st === 'coming' ? `<span class="tcard-tag">${esc(releaseDay(v))}</span>` : '';
  return `<li class="pocket"><button type="button" class="tcard tcard-${st}" data-act="zukan-card" data-key="${esc(d.key)}" data-vol="${v.vol}" aria-label="${esc(`${v.vol}. ${title}：${ZUKAN_STATE[st]}`)}">
    <span class="tcard-no">No.${v.vol}</span>${c}${tag}<span class="tcard-title">${esc(name)}</span></button></li>`;
}

// 著者のページのシリーズ：バインダーの中身を小さなカードで先に見せる（読了は濃く、まだ読んでいない巻は薄い）
const MINI_CARDS = 6;
function miniCard(d, v) {
  const c = v.book ? cover(v.book.title, v.book.isbn, 'xs', v.book.coverIsbns || v.book.coverIsbn || [], d.author) : cover(v.title, v.isbn, 'xs', v.coverIsbns || [], d.author);
  return `<span class="zmini${cardState(v) === 'read' ? ' on' : ''}">${c}<i>${v.vol}</i></span>`;
}

let zukanLoading = null;
let zukanDrawTimer = 0;
function renderZukan() {
  view.innerHTML = '<section class="zukan" id="zukan"></section>';
  drawZukan();
  loadZukanData();
}
function drawZukan() {
  clearTimeout(zukanDrawTimer); zukanDrawTimer = 0;
  const box = $('#zukan');
  const path = zukanPath();
  if (!box || !path) return;
  const authors = zukanAuthors();
  const author = path.author ? authors.find((a) => normName(a.name) === normName(path.author)) : null;
  const d = author && path.key ? author.series.find((x) => x.key === path.key) : null;
  const checking = ''; // v0.18.1 本人：読み込みの表示は出さない（確かめた分から増えていく）
  let html;
  if (d) {
    const pages = [];
    for (let i = 0; i < d.vols.length; i += 9) pages.push(d.vols.slice(i, i + 9));
    const n = d.next;
    html = `<a class="back-link" href="${esc(zukanHref(author.name))}">‹ ${esc(author.name)}</a>
      ${pageHead(d.base, `${d.done} / ${d.total}冊`)}
      <div class="binder-head">${zbar(d.done, d.total)}${d.done === d.total && !d.others ? '<span class="zcomplete">コンプリート</span>' : ''}</div>
      ${d.others ? `<p class="binder-next">${d.total > d.done ? `シリーズではない作品です。薄いカードは、まだ読んでいない作品です。` : 'シリーズではない、読み終えた作品です。'}</p>` : n ? `<p class="binder-next">次に読む：<b>${esc(volName(d, n))}</b>${n.book ? '（本棚にあり）' : n.upcoming ? `（${esc(releaseDay(n))}発売予定）` : ''}</p>` : '<p class="binder-next"><b>すべて読み終えました</b></p>'}
      <div class="binder">${pages.map((p, i) => `<section class="binder-page" aria-label="${i + 1}ページ目"><ol class="pockets">${p.map((v) => tradingCard(d, v)).join('')}</ol>${pages.length > 1 ? `<span class="binder-no">${i + 1} / ${pages.length}</span>` : ''}</section>`).join('')}</div>
      <p class="zukan-legend"><span><i class="lg lg-read"></i>読了</span><span><i class="lg lg-unread"></i>まだ読んでいない</span><span><i class="tcard-tag">本棚</i>本棚にある</span></p>
      ${checking}<p class="source">カードをタップすると本の詳細。まだ持っていない本は本棚に登録できます。</p>`;
  } else if (author) {
    html = `<a class="back-link" href="${esc(zukanHref())}">‹ 読書図鑑</a>
      ${pageHead(author.name, `${author.read} / ${author.total}冊`)}
      <ul class="zseries-list">${author.series.map((x) => `<li><a class="zseries" href="${esc(zukanHref(author.name, x.key))}">
        <span class="zseries-strip" aria-hidden="true">${(x.vols.length > MINI_CARDS ? x.vols.slice(0, MINI_CARDS - 1) : x.vols).map((v) => miniCard(x, v)).join('')}${x.vols.length > MINI_CARDS ? `<span class="zmini zmini-more">+${x.vols.length - MINI_CARDS + 1}</span>` : ''}</span>
        <span class="zseries-main"><span class="zseries-name">${esc(x.base)}</span>
          <span class="zseries-meta"><span class="zseries-count">${x.others && x.done === x.total ? `読了 <b>${x.done}</b>冊` : `読了 <b>${x.done}</b> / ${x.total}冊`}</span>${x.done === x.total && !x.others ? '<span class="zcomplete">コンプリート</span>' : ''}</span>${zbar(x.done, x.total)}</span>
        <span class="zseries-open">バインダーを開く</span></a></li>`).join('')}</ul>${checking}`;
  } else {
    const read = authors.reduce((s, a) => s + a.read, 0);
    const total = authors.reduce((s, a) => s + a.total, 0);
    html = `<a class="back-link" href="#stats">‹ 読書の記録</a>
      ${pageHead('読書図鑑', total ? `${read} / ${total}冊` : '')}
      <p class="zukan-intro">読んだ本を、著者ごとに集めています。シリーズは、まだ読んでいない巻も薄いカードで並びます。</p>
      ${authors.length ? trophyStrip() : ''}
      ${authors.length ? `<ul class="zfolders">${authors.map((a) => `<li><a class="zfolder" href="${esc(zukanHref(a.name))}">
          <span class="zfolder-cards" aria-hidden="true">${a.series.flatMap((x) => readCovers(x.vols, 3)).slice(0, 3).join('')}</span>
          <span class="zfolder-face"><span class="zfolder-name">${esc(a.name)}</span><span class="zfolder-meta">${[a.series.filter((x) => !x.others).length ? `${a.series.filter((x) => !x.others).length}シリーズ` : '', a.series.find((x) => x.others) ? '単発作品' : ''].filter(Boolean).join('・')}</span>
            <span class="zfolder-count"><b>${a.read}</b> / ${a.total}冊</span>${zbar(a.read, a.total)}</span></a></li>`).join('')}</ul>`
      : (zukanLoading ? '' : `<div class="empty"><p class="empty-title">まだ図鑑に入る本がありません</p><p>本を読了にすると、その著者のフォルダができます。シリーズの本は、ほかの巻も薄いカードで並びます。</p></div>`)}
      ${checking}`;
  }
  box.innerHTML = html;
  box.toggleAttribute('data-loading', !!zukanLoading); // 確かめている途中の印（画面には出さない。確認用）
  revealBooks(box);
}
const drawZukanSoon = () => { if (!zukanDrawTimer) zukanDrawTimer = setTimeout(drawZukan, 700); };

// 図鑑に要る国立国会図書館の書誌（読んだ本のある著者の作品・巻数のシリーズの巻）を、画面を開いている間に 1 件ずつ
let zukanRun = null;
function loadZukanData() {
  if (zukanRun) return zukanRun;
  authorFailed.clear(); seriesFailed.clear(); // つながらなかった分は、開き直したときにもう一度
  const counts = new Map();
  for (const b of store.books()) {
    if (b.status !== 'done' || !b.author || b.seriesName === NO_SERIES) continue;
    const k = normName(b.author);
    counts.set(k, { n: (counts.get(k)?.n || 0) + 1, name: counts.get(k)?.name || b.author });
  }
  const here = normName(zukanPath()?.author || '');
  const needs = (k, n) => !authorWorks.has(k) || (n >= ZUKAN_FULL_MIN && !authorWorks.get(k).full);
  const authors = [...counts].filter(([k, x]) => needs(k, x.n) && !authorFailed.has(k))
    .sort((a, b) => Number(b[0] === here) - Number(a[0] === here) || b[1].n - a[1].n).map(([, x]) => x.name);
  const groups = currentSeries().filter((g) => !g.named && !seriesFetched.has(g.key) && !seriesFailed.has(g.key) && [...g.owned.values()].some((b) => b.status === 'done'));
  if (!authors.length && !groups.length) return null;
  const state = { done: 0, total: authors.length + groups.length };
  zukanLoading = state;
  drawZukan(); // 「確かめています」をすぐ出す（まだ数が変わることが分かるように）
  const onZukan = () => route.name === 'stats' && !!zukanPath();
  zukanRun = (async () => {
    for (const s of groups) {
      if (!onZukan()) break; // 画面を離れたら止め、戻ったら続きから
      try { seriesFetched.set(s.key, seriesVolumesFromWorks(s, await ndl.searchTitle(s.base, s.author, { allSources: true, ttl: SERIES_TTL }))); } catch { seriesFailed.add(s.key); }
      state.done += 1; drawZukanSoon();
    }
    for (const name of authors) {
      if (!onZukan()) break;
      const k = normName(name);
      const full = readCountOf(k) >= ZUKAN_FULL_MIN;
      if (!authorWorks.has(k) || (full && !authorWorks.get(k).full)) {
        try { authorWorks.set(k, { t: Date.now(), full, works: seriesWorksOf(await ndl.searchAuthor(name, { priority: 1, keep: false }), { full }) }); saveAuthorWorks(); } catch { authorFailed.add(k); }
      }
      state.done += 1; drawZukanSoon();
    }
  })().finally(() => { zukanRun = null; if (zukanLoading === state) zukanLoading = null; drawZukan(); });
  return zukanRun;
}

// ---------------------------------------------------------------- 次の1冊くじ（v0.16 本人の⑦：読む本に迷ったら、カードを 1 枚引く）
// カード：図鑑のシリーズの続きの巻（読んだ巻のあるシリーズの、次に読む発売済みの巻）と、本棚の読みたい本（発売前の本は除く）
let kuji = null; // { cands, drawn, pick, busy }
function kujiCandidates() {
  const list = [];
  const taken = new Set();
  for (const s of currentSeries()) {
    const d = describeSeries(s, fetchedFor(s));
    const n = d.next;
    if (!isRealSeries(d) || !d.done || !n || (n.upcoming && !n.book)) continue;
    if (n.book) { if (n.book.status === 'want') { list.push({ key: n.book.id, book: n.book, d, v: n }); taken.add(n.book.id); } continue; }
    if (n.work || d.named) list.push({ key: `${d.key}#${n.vol}`, book: null, d, v: n });
  }
  for (const b of store.books()) {
    if (b.status !== 'want' || taken.has(b.id)) continue;
    if ((b.publishedAt || '').length === 10 && b.publishedAt > today()) continue;
    list.push({ key: b.id, book: b });
  }
  return list;
}
function renderKuji() {
  stopBookPreview(); flushMemo(); stopScanning(); openId = null;
  const cands = kujiCandidates();
  kuji = { cands, drawn: new Set(), pick: null, busy: false };
  sheetBody.innerHTML = `<h2 class="sheet-title">次の1冊</h2>
    ${cands.length ? `<p class="kuji-lead">読みたい本と、図鑑のシリーズの続きから1枚引きます。<span>全${cands.length}枚</span></p>
      <div class="kuji-stage">
        <span class="kuji-deck" aria-hidden="true"><i></i><i></i></span>
        <div class="kcard" id="kcard" role="button" tabindex="0" data-act="kuji-draw" aria-label="カードを引く">
          <span class="kcard-face kcard-back" aria-hidden="true"><span class="kcard-mark">${icon('book')}</span><b>読書手帖</b></span>
          <span class="kcard-face kcard-front" id="kcard-front"></span>
        </div>
      </div>
      <div class="kuji-result" id="kuji-result" aria-live="polite"><p class="kuji-hint">カードをタップして引く</p></div>`
    : `<div class="empty"><p class="empty-title">引けるカードがありません</p><p>読みたい本を本棚に入れるか、シリーズの本を読了にすると、続きの巻がカードになります。</p></div>`}`;
  showSheet();
  sheetBody.scrollTop = 0;
}
function drawKuji() {
  const k = kuji;
  const card = $('#kcard');
  if (!k || k.busy || !k.cands.length || !card) return;
  k.busy = true;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wasOpen = card.classList.contains('flip');
  card.classList.remove('flip');
  $('#kuji-result').innerHTML = '';
  const alive = () => kuji === k && card.isConnected;
  setTimeout(() => {
    if (!alive()) return;
    // 引いたカードは、全部引き終えるまで出さない
    let pool = k.cands.filter((c) => !k.drawn.has(c.key));
    if (!pool.length) { k.drawn.clear(); pool = k.cands.filter((c) => c.key !== k.pick?.key); if (!pool.length) pool = k.cands; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    k.pick = pick; k.drawn.add(pick.key);
    $('#kcard-front').innerHTML = kujiFront(pick);
    card.classList.add('shuffle');
    setTimeout(() => {
      if (!alive()) return;
      card.classList.remove('shuffle');
      card.classList.add('flip');
      card.setAttribute('aria-label', 'もう1枚引く');
      navigator.vibrate?.(25);
      setTimeout(() => { if (!alive()) return; k.busy = false; showKujiResult(); }, still ? 0 : 700);
    }, still ? 0 : 420);
  }, wasOpen && !still ? 420 : 0);
}
function kujiFront(c) {
  const b = c.book;
  const title = mainTitle(b ? b.title : c.v.title);
  const cv = b ? cover(b.title, b.isbn, 'card', b.coverIsbns || b.coverIsbn || [], b.author) : cover(c.v.title, c.v.isbn, 'card', c.v.coverIsbns || [], c.d.author);
  const no = c.d ? (c.d.named ? `No.${c.v.vol}` : `${c.v.vol}巻`) : '読みたい本';
  return `<span class="kcard-no">${esc(no)}</span>${cv}<span class="kcard-title">${esc(title)}</span>`;
}
function showKujiResult() {
  const c = kuji?.pick;
  const box = $('#kuji-result');
  if (!c || !box) return;
  const b = c.book ? store.get(c.book.id) : null;
  const title = b ? b.title : c.d.named ? mainTitle(c.v.title) : c.v.title;
  const author = b?.author || c.d?.author || '';
  const why = c.d ? `「${c.d.base}」の続き（${volName(c.d, c.v)}）${b ? '・本棚にあり' : '・まだ持っていない'}`
    : `本棚の読みたい本${/^\d{4}-\d{2}/.test(b?.addedAt || '') ? `・${monthLabel(b.addedAt.slice(0, 7))}に登録` : ''}`;
  box.innerHTML = `<p class="kuji-eyebrow">次はこれ！</p><h3 class="kuji-title">${esc(title)}</h3><p class="kuji-author">${esc(author)}</p><p class="kuji-why">${esc(why)}</p>
    <div class="kuji-actions">${b ? `<button type="button" class="primary" data-act="kuji-read" data-id="${esc(b.id)}">この本を読む</button><button type="button" class="ghost" data-act="open" data-id="${esc(b.id)}">詳細を見る</button>`
      : '<button type="button" class="primary" data-act="kuji-add">読みたいに追加</button>'}</div>
    <button type="button" class="ghost kuji-again" data-act="kuji-draw">${icon('cards')}もう1枚引く</button>`;
}

// ---------------------------------------------------------------- 図鑑のトロフィー（v0.16 本人の⑧：実績を集める）
// 数え方は js/trophies.js。v0.17：同じ系統（10冊・30冊…）は 1 枚に重ね、タップで各段の達成日。レア度は 6 段階（最高はレジェンド＝虹色）
// 獲得した段はこの端末だけで覚え、新しく獲得したものに NEW を付ける（トロフィーの一覧を開くと消える）
const trophyList = () => trophyProgress(store.books(), zukanAuthors().flatMap((a) => a.series).filter((d) => !d.others));
const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i + 1]));
const medal = (t, locked = !t?.earned) => `<span class="medal medal-${locked ? 'locked' : t.tier}" aria-hidden="true"><i class="medal-fx"></i>${icon('trophy')}</span>`;
const trophyWhen = (t) => (t.at ? `${monthLabel(t.at.slice(0, 7))}に達成` : '達成');
const trophyLeft = (t) => `あと${Math.max(1, t.goal - t.value)}${t.unit}`;
const pips = (f) => `<span class="trophy-pips" aria-label="${f.got} / ${f.levels.length}段">${f.levels.map((t) => `<i class="pip pip-${t.tier}${t.earned ? ' on' : ''}"></i>`).join('')}</span>`;
let trophyFreshShown = new Set(); // 一覧を開いたときの NEW（開くと覚えから消すが、系統を開いたときにも見せる）
// 最初の 1 回は、いま獲得している分を覚えるだけ（印を付けない）。戻り値：新しく獲得したトロフィー
function noteTrophies(list = trophyList()) {
  const got = list.filter((t) => t.earned).map((t) => t.id);
  if (!Array.isArray(ui.trophiesKnown)) { ui.trophiesKnown = got; ui.trophiesNew = []; saveUi(); return []; }
  const known = new Set(ui.trophiesKnown);
  const fresh = list.filter((t) => t.earned && !known.has(t.id));
  if (fresh.length || got.length !== known.size || got.some((id) => !known.has(id))) {
    ui.trophiesKnown = got;
    ui.trophiesNew = [...new Set([...(ui.trophiesNew || []), ...fresh.map((t) => t.id)])].filter((id) => got.includes(id));
    saveUi();
  }
  return fresh;
}
const wonText = (won) => `トロフィー「${won.map((t) => t.name).join('」「')}」を獲得！`;
// 図鑑の最初のページ：系統ごとのいちばん上のメダル（新しく獲得した順）と、次に近いトロフィー
function trophyStrip() {
  const list = trophyList();
  noteTrophies(list);
  const fresh = new Set(ui.trophiesNew || []);
  const fams = trophyFamilies(list);
  const isNew = (f) => f.levels.some((t) => fresh.has(t.id));
  const shown = fams.filter((f) => f.top).sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || TIER_RANK[b.top.tier] - TIER_RANK[a.top.tier] || (b.top.at || '').localeCompare(a.top.at || ''));
  const near = fams.map((f) => f.next).filter(Boolean).sort((a, b) => b.value / b.goal - a.value / a.goal || a.goal - b.goal)[0];
  const got = list.filter((t) => t.earned).length;
  return `<button type="button" class="trophy-strip" data-act="trophies" aria-label="トロフィー ${got} / ${list.length}。一覧を開く">
    <span class="trophy-strip-head"><span class="trophy-strip-title">トロフィー</span><span class="trophy-strip-count"><b>${got}</b> / ${list.length}</span></span>
    <span class="trophy-strip-row">${shown.length ? shown.map((f) => `<span class="trophy-mini${isNew(f) ? ' new' : ''}">${medal(f.top)}<span class="trophy-mini-name">${esc(f.top.name)}</span></span>`).join('') : '<span class="trophy-empty">本を読了にすると、トロフィーが集まります</span>'}</span>
    ${near ? `<span class="trophy-strip-next">次は「${esc(near.name)}」：${esc(trophyLeft(near))}</span>` : ''}
  </button>`;
}
// 一覧：系統ごとに 1 枚（獲得した段が 2 つ以上なら重ねて見せる）。レア度の早見表つき
function renderTrophies() {
  stopBookPreview(); flushMemo(); stopScanning(); openId = null;
  const list = trophyList();
  noteTrophies(list);
  const fresh = new Set(ui.trophiesNew || []);
  if (fresh.size) { trophyFreshShown = new Set([...trophyFreshShown, ...fresh]); ui.trophiesNew = []; saveUi(); pendingRender = true; } // 閉じたら図鑑の NEW を消す
  const fams = trophyFamilies(list);
  const got = list.filter((t) => t.earned).length;
  sheetBody.innerHTML = `<h2 class="sheet-title">トロフィー</h2>
    <div class="trophy-lead"><span><b>${got}</b> / ${list.length}</span>${zbar(got, list.length)}</div>
    <ol class="tier-ladder" aria-label="レア度（低い順）">${TIERS.map((t) => `<li>${medal({ tier: t, earned: true })}<span class="tier-name tier-${t}">${esc(TIER_NAME[t])}</span></li>`).join('')}</ol>
    ${TROPHY_GROUPS.map(([g, name]) => `<section class="trophy-group"><h3>${esc(name)}</h3><ul class="trophy-grid">${fams.filter((f) => f.group === g).map((f) => {
      const face = f.top || f.levels[0];
      const isNew = f.levels.some((t) => trophyFreshShown.has(t.id));
      return `<li><button type="button" class="trophy ${f.top ? 'on' : 'off'}${f.got >= 2 ? ` stacked stack-${Math.min(f.got - 1, 2)}` : ''}${isNew ? ' new' : ''}" data-act="trophy-family" data-f="${esc(f.id)}">
        ${medal(face, !f.top)}<span class="trophy-name">${esc(f.top ? f.top.name : f.name)}</span><span class="trophy-hint">${esc(f.top ? f.name : f.about(f.levels[0].goal))}</span>
        ${pips(f)}<span class="trophy-when">${esc(f.next ? `次：${f.next.name}（${trophyLeft(f.next)}）` : 'すべて達成')}</span>${isNew ? '<span class="trophy-new">NEW</span>' : ''}</button></li>`;
    }).join('')}</ul></section>`).join('')}
    <p class="source">読了日と、読書図鑑のシリーズから数えています。同じ系統のトロフィーは重ねてあり、タップすると段ごとの達成日が見られます。</p>`;
  showSheet();
  sheetBody.scrollTop = 0;
}
// 系統を開く：段ごとのメダル・レア度・達成した日（まだなら残りの数とゲージ）
function renderTrophyFamily(id) {
  const f = trophyFamilies(trophyList()).find((x) => x.id === id);
  if (!f) { renderTrophies(); return; }
  sheetBody.innerHTML = `<button type="button" class="link trophy-back" data-act="trophies">‹ トロフィー</button>
    <div class="trophy-hero">${medal(f.top || f.levels[0], !f.top)}<h2 class="sheet-title">${esc(f.name)}</h2><p>${f.got} / ${f.levels.length}段${f.top ? `・いまは<b class="tier-name tier-${f.top.tier}">${esc(TIER_NAME[f.top.tier])}</b>` : ''}</p></div>
    <ol class="trophy-levels">${[...f.levels].reverse().map((t) => `<li class="${t.earned ? 'on' : 'off'}${trophyFreshShown.has(t.id) ? ' new' : ''}">${medal(t, false)}
      <span class="tl-main"><span class="tl-name">${esc(t.name)}</span><span class="tl-sub"><span class="tier-name tier-${t.tier}">${esc(TIER_NAME[t.tier])}</span>${esc(t.hint)}</span>
        ${t.earned ? `<span class="tl-when">${esc(trophyWhen(t))}</span>` : `<span class="tl-left">${esc(trophyLeft(t))}</span>${zbar(t.value, t.goal)}`}</span>${trophyFreshShown.has(t.id) ? '<span class="trophy-new">NEW</span>' : ''}</li>`).join('')}</ol>`;
  sheetBody.scrollTop = 0;
}

function renderVersionHistory() {
  stopBookPreview();
  stopScanning(); flushMemo(); openId=null;
  sheetBody.innerHTML=`<h2 class="sheet-title">バージョン履歴</h2><ol class="version-history">${VERSION_HISTORY.map(v=>`<li><div class="version-heading"><h3>${esc(v.version)}</h3><time datetime="${esc(v.date)}">${esc(v.date)}</time></div><ul>${v.changes.map(c=>`<li>${esc(c)}</li>`).join('')}</ul></li>`).join('')}</ol><a class="link" href="https://github.com/Hedficr-cyber/dokusho-techo/commits/main/" target="_blank" rel="noopener noreferrer">GitHubの変更履歴を見る</a>`;
  showSheet();
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

function showBackupPreview() {
  stopBookPreview();flushMemo();stopScanning();openId=null;
  const data=store.snapshot();
  const removed=[...new Set([...Object.keys(data.removed || {}),...(data.deletedSeedIds || [])])];
  sheetBody.innerHTML=`<h2 class="sheet-title">本棚のバックアップ</h2><p>${data.books.length}冊 ・ 削除の記録 ${removed.length}冊</p><p class="muted small">このブラウザに保存された内容です。書き出したファイルを別のブラウザへ戻すと、本棚と削除の記録を引き継げます。</p><label class="field"><span class="label">バックアップの内容</span><textarea id="backup-preview" rows="10" readonly spellcheck="false">${esc(JSON.stringify(data,null,1))}</textarea></label><button type="button" class="primary" data-act="export">ファイルに書き出す</button>`;
  showSheet();sheetBody.scrollTop=0;
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
    showSheet();
  } catch {
    toast('読み込めませんでした。読書手帖で書き出したファイルを選んでください');
  }
}

// 本を追加で読み込む：いまの本棚はそのままで、ファイルの本を足す（同じ本は重ねない）
async function mergeFile(file) {
  try {
    if (file.size>10*1024*1024) throw new Error('大きすぎます');
    showMergePlan(JSON.parse(await file.text()), `「${file.name}」`);
  } catch {
    toast('読み込めませんでした。読書手帖のバックアップか本の一覧のファイルを選んでください');
  } finally {
    const input = $('#merge-file'); if (input) input.value = ''; // 同じファイルをもう一度選べるように
  }
}
// 取り込みコード「<id>.<鍵>」：公開サイトの data/imports/<id>.json（鍵がないと読めない形）を、この端末で開いて足す。
// 鍵はコードにだけあり、サイトには置かない（本の一覧を他人に読まれない）。リンク #stats/import/<コード> でも開ける
const IMPORT_CODE = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;
async function openImportCode(code) {
  const m = String(code || '').trim().match(IMPORT_CODE);
  if (!m) throw new Error('コードの形が違います');
  const res = await fetch(`./data/imports/${m[1]}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error('見つかりません');
  const env = await res.json();
  if (env?.kind !== 'dokusho-techo:import' || typeof env.iv !== 'string' || typeof env.data !== 'string') throw new Error('形が違います');
  const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', bytes(m[2]), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(env.iv), additionalData: new TextEncoder().encode('dokusho-techo:import:v1') }, key, bytes(env.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function importByCode(code) {
  try {
    showMergePlan(await openImportCode(code), '取り込みコードの本');
  } catch {
    toast('取り込めませんでした。コードを確かめて、通信できる場所でもう一度試してください');
  }
}
// 追加する前に、何冊増えるか・読了になるか・すでにあるかを見せる（ファイルでもコードでも同じ）
function showMergePlan(data, source) {
  const plan = store.planMerge(data);
  stopBookPreview(); flushMemo(); stopScanning(); openId=null;
  const doneAdd = plan.add.filter((b) => b.status === 'done').length;
  // 読了の本は本棚には並ばず、記録と読書図鑑に入る（本人：写真の読了本は図鑑に入れたい、本棚には入れなくていい）
  const allDone = doneAdd === plan.add.length && !plan.add.some((b) => b.status !== 'done');
  sheetBody.innerHTML = `<h2 class="sheet-title">${allDone && plan.add.length ? '読んだ本を図鑑に入れる' : '本を追加で読み込む'}</h2>
    <p>${esc(source)}を、この端末の読書手帖に足します。消える本はありません。${doneAdd ? '<br>読了の本は本棚には並ばず、「記録」と「読書図鑑」に入ります。' : ''}</p>
    <ul class="merge-summary">${allDone ? `<li>読了として追加 <b>${plan.add.length}</b>冊（記録・図鑑へ）</li>` : `<li>新しく追加 <b>${plan.add.length}</b>冊${doneAdd ? `（うち読了 ${doneAdd}冊は記録・図鑑へ）` : ''}</li>`}<li>本棚の本を読了にする <b>${plan.read.length}</b>冊</li><li>すでにある本 <b>${plan.same}</b>冊（そのまま）</li></ul>
    ${plan.add.length ? `<details class="merge-list"><summary>追加する本を見る</summary><ol>${plan.add.map((b) => `<li>${esc(b.title)}<span class="muted">　${esc(b.author)}${b.status === 'done' ? '・読了' : ''}</span></li>`).join('')}</ol></details>` : ''}
    ${plan.read.length ? `<details class="merge-list"><summary>読了にする本を見る</summary><ol>${plan.read.map((b) => `<li>${esc(b.title)}<span class="muted">　${esc(b.author)}</span></li>`).join('')}</ol></details>` : ''}
    <div class="row">${plan.add.length || plan.read.length ? `<button type="button" class="primary" data-act="confirm-merge">${allDone ? '図鑑に入れる' : '追加する'}</button>` : ''}<button type="button" class="ghost" data-act="close">${plan.add.length || plan.read.length ? 'やめる' : '閉じる'}</button></div>`;
  mergeFile.pending = data;
  showSheet(); sheetBody.scrollTop = 0;
}

// ---------------------------------------------------------------- PC と iPhone の同期（記録タブ）。仕組みは js/sync.js
const syncStore = { syncPayload: store.syncPayload, applySync: store.applySync, bookCount: () => store.books().length };
let syncTimer = 0;
let syncBusy = '';   // 接続中などの表示
const guessOwner = () => location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i)?.[1] || '';
const runSync = () => { clearTimeout(syncTimer); syncTimer = 0; return sync.syncNow({ store: syncStore }); };
// 本棚を変えたら、少し待ってから同期（続けて変えたときはまとめて 1 回）
function scheduleSync() {
  if (!sync.syncConfig()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 4000);
}

function syncCard() {
  const st = sync.status();
  if (syncBusy) return `<h2>PCとiPhoneの同期</h2>${loading(syncBusy)}`;
  if (st.on) {
    return `<h2>PCとiPhoneの同期 <span class="sync-on">オン</span></h2>
      <p class="muted small">この端末：${esc(st.device || '')} ・ 保存先：${esc(st.owner)}/${esc(st.repo)}（非公開・暗号化）</p>
      <p class="sync-state">${st.running ? loading('同期しています…') : st.lastSyncAt ? `最後に同期：${esc(localTime(st.lastSyncAt))}` : 'まだ同期していません'}</p>
      ${st.lastError ? `<p class="error">${esc(st.lastError)}</p>` : ''}
      ${st.needPassphrase ? `<form id="sync-unlock" class="add-form" autocomplete="off"><label><span class="label">合言葉</span><input id="sync-pass-again" type="password" autocomplete="current-password" required></label><button type="submit" class="primary">合言葉を入れる</button></form>` : ''}
      <div class="row"><button type="button" class="primary" data-act="sync-now" ${st.running ? 'disabled' : ''}>今すぐ同期</button><button type="button" class="ghost" data-act="sync-off">この端末の同期をやめる</button></div>
      ${sync.beforeSyncSnapshot() ? '<button type="button" class="link small" data-act="sync-snapshot">接続する前の本棚をファイルに書き出す</button>' : ''}`;
  }
  return `<h2>PCとiPhoneの同期</h2>
    <p>本棚を、あなたの GitHub の<b>非公開リポジトリ</b>に<b>暗号化して</b>保存し、PC と iPhone でそろえます。合言葉を知らない人（GitHub を含む）には中身が読めません。</p>
    <details class="sync-steps"><summary>はじめに準備すること（1回だけ）</summary>
      <ol>
        <li><a href="https://github.com/new" target="_blank" rel="noopener noreferrer">GitHub で新しいリポジトリを作る</a>：名前は「dokusho-techo-data」、<b>Private</b> を選ぶ。</li>
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">アクセス用の鍵を作る</a>（Fine-grained token）：Repository access は「Only select repositories」で dokusho-techo-data だけ、Permissions の「Contents」を <b>Read and write</b>。期限は1年。できた鍵（github_pat_ で始まる文字）をコピー。</li>
        <li>下に入れて「接続する」。<b>本棚を整理した端末から先に</b>接続してください。</li>
        <li>もう1台でも同じ鍵と合言葉で接続し、「クラウドの本棚に置き換える」を選ぶ。</li>
      </ol>
      <p class="muted small">合言葉は忘れないでください（忘れるとクラウドのデータは読めません。各端末の本棚は残ります）。鍵はこの端末の中だけに保存し、GitHub 以外には送りません。</p>
    </details>
    <form id="sync-form" class="add-form sync-form" autocomplete="off">
      <label><span class="label">GitHub のユーザー名</span><input id="sync-owner" value="${esc(guessOwner())}" autocapitalize="off" spellcheck="false" required></label>
      <label><span class="label">リポジトリ名</span><input id="sync-repo" value="dokusho-techo-data" autocapitalize="off" spellcheck="false" required></label>
      <label><span class="label">アクセス用の鍵</span><input id="sync-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" required></label>
      <label><span class="label">合言葉（8文字以上）</span><input id="sync-pass" type="password" autocomplete="new-password" minlength="8" required></label>
      <label><span class="label">合言葉（確認）</span><input id="sync-pass2" type="password" autocomplete="new-password" minlength="8" required></label>
      <label><span class="label">この端末の名前</span><input id="sync-device" value="${esc(sync.guessDevice())}" maxlength="40"></label>
      <button type="submit" class="primary">接続する</button>
    </form>`;
}
function drawSyncCard() {
  const box = $('#sync-card');
  if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement.matches('input')) return; // 入力中は描き直さない
  box.innerHTML = syncCard();
  const label=$('#sync-label');if(label)label.textContent=sync.status().on?'オン':'未設定';
}
sync.onSyncStatus(() => drawSyncCard());

// すでにクラウドに本棚があるとき、置き換えるか合わせるかを聞く
let syncChoice = null;
function askSyncMode(info) {
  return new Promise((resolve) => {
    syncChoice = resolve;
    stopBookPreview(); flushMemo(); stopScanning(); openId = null;
    sheetBody.innerHTML = `<h2 class="sheet-title">同期のしかた</h2>
      <p>GitHub には ${esc(info.device || 'ほかの端末')} で保存した本棚（${info.remoteBooks}冊・${esc(localTime(info.savedAt))}）があります。この端末の本棚は ${info.localBooks}冊です。</p>
      <div class="sync-choices">
        <button type="button" class="primary" data-act="sync-choose" data-v="replace">クラウドの本棚に置き換える</button>
        <p class="muted small">この端末の本棚を、クラウドの内容にそろえます（2台目の端末はこちら）。</p>
        <button type="button" class="ghost" data-act="sync-choose" data-v="merge">両方を合わせる</button>
        <p class="muted small">両方の本を残します。同じ本は新しく変えた方、消した本は消したままにします。</p>
        <button type="button" class="ghost" data-act="sync-choose" data-v="">やめる</button>
      </div>`;
    showSheet();
  });
}
function chooseSync(mode) {
  const done = syncChoice;
  syncChoice = null;
  if (sheet.open) closeSheet();
  done?.(mode || null);
}
sheet.addEventListener('close', () => { if (syncChoice) chooseSync(null); });

async function submitSync() {
  const pass = $('#sync-pass').value;
  if (pass !== $('#sync-pass2').value) { toast('確認用の合言葉が一致しません'); return; }
  const input = { owner: $('#sync-owner').value, repo: $('#sync-repo').value, token: $('#sync-token').value, passphrase: pass, device: $('#sync-device').value };
  document.activeElement?.blur();
  syncBusy = 'GitHub に接続して、暗号化しています…';
  drawSyncCard();
  try {
    const r = await sync.connect(input, { store: syncStore, choose: askSyncMode });
    syncBusy = '';
    if (r.mode === 'cancel') { drawSyncCard(); return; }
    toast(r.mode === 'first' ? `この端末の本棚（${r.books}冊）を暗号化して保存しました。もう1台でも接続してください` : `同期をオンにしました（${r.books}冊）`);
  } catch (e) {
    syncBusy = '';
    drawSyncCard();
    toast(e.message || '接続できませんでした');
    return;
  }
  render();
}
async function submitUnlock() {
  const pass = $('#sync-pass-again').value;
  document.activeElement?.blur();
  syncBusy = '合言葉を確かめています…';
  drawSyncCard();
  try { await sync.unlock(pass, { store: syncStore }); toast('同期を再開しました'); } catch (e) { toast(e.message || '合言葉を確かめられませんでした'); }
  syncBusy = '';
  drawSyncCard();
}
function exportSnapshot() {
  const snap = sync.beforeSyncSnapshot();
  if (!snap) return;
  const blob = new Blob([JSON.stringify(snap.data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `読書手帖_同期前の本棚_${snap.at.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// 開いたとき・戻ってきたとき・通信が戻ったときに同期。閉じる前に、待っている同期を済ませる
document.addEventListener('visibilitychange', () => {
  if (!sync.syncConfig()) return;
  if (document.visibilityState === 'hidden') { if (syncTimer) runSync(); return; }
  const last = Date.parse(sync.status().lastSyncAt || '') || 0;
  if (Date.now() - last > 60 * 1000) runSync();
});
window.addEventListener('online', () => { if (sync.syncConfig()) runSync(); });

// 初めての端末は空の本棚で始める。既存の端末の本や読書記録には触れない。
let preferred=new Set();
// 初めて開いたときの画面（v0.15 で作り直し）：大まかなジャンル 12 を、名前＋ひとこと＋チェックのカードで。
// 「本を探す」は下のナビの上に固定（本人：矢印が大きすぎた。矢印はつけない）
function genreChoices() {
  const groups=GENRE_GROUP_ORDER.map(id=>GENRE_GROUP_BY_ID[id]).filter(Boolean);
  return `<div class="preference-genres" role="group" aria-label="好きなジャンル（複数選択）">${groups.map(g=>`<button type="button" class="preference-genre ${preferred.has(g.id)?'on':''}" data-act="preference-toggle" data-v="${g.id}" aria-pressed="${preferred.has(g.id)}"><span class="pg-text"><span class="pg-name">${esc(g.name)}</span><span class="pg-desc">${esc(g.desc)}</span></span><span class="pg-check" aria-hidden="true"></span></button>`).join('')}</div>`;
}
const onboardingLabel=()=>preferred.size ? `${preferred.size}つのジャンルで本を探す` : '本を探す';
function renderOnboarding() {
  preferred=new Set(store.snapshot().favoriteGenres);
  view.innerHTML=`<section class="onboarding"><p class="onboarding-kicker">あなたの読書手帖</p><h1>どんな本を<br>読みたい？</h1><p class="onboarding-lead">好きなジャンルを選ぶと、おすすめの本が届きます。いくつでも選べます。</p><div id="preference-choices">${genreChoices()}</div><div class="onboarding-foot"><button type="button" class="primary onboarding-next" data-act="preferences-save">${onboardingLabel()}</button><p class="onboarding-note">本棚は、あなたが登録した本から始まります。</p></div></section>`;
  $('#fab').hidden=true;
}

// ---------------------------------------------------------------- 画面切り替え
const TITLES = { shelf: '本棚', author: '著書', search: '検索', stats: '読書の記録' };

function render() {
  stopShelfLoading();
  ++renderToken; // 別タブへ移動したら、前の画面の検索結果は描画しない
  workCache = new Map();
  infoObserver?.disconnect();
  const { name, arg } = route;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.tab === name ? 'page' : 'false'));
  placeGlider();
  $('#view-title').textContent = TITLES[name] || '';
  $('#fab').hidden = false;
  document.body.dataset.page = name;
  if(!store.snapshot().onboardingDone){renderOnboarding();return;}
  if (name === 'author') {
    if (!arg) newKeys = new Set(store.releases().filter((r) => !r.seen).map((r) => r.key));
    renderAuthor(arg);
    if (!arg) store.markReleasesSeen();
  }
  else if (name === 'search') renderSearch();
  else if (name === 'stats') renderStats();
  else renderShelf();
  // 入力中に画面を描き直して入力欄が入れ替わると、閉じた合図が来ずに下のナビが隠れたままになる（v0.18.1）
  setTimeout(() => { if (!isTypingField(document.activeElement)) document.body.classList.remove('typing'); }, 80);
}

function onHash() {
  if (preview) closeSheet();
  let [name, ...rest] = location.hash.replace(/^#/, '').split('/');
  if (name === 'genre') { name = 'search'; rest = []; } // ジャンル画面は検索に置き換えた
  let arg='';
  try { arg=decodeURIComponent(rest.join('/') || ''); } catch { /* 壊れたURLは空の画面引数に戻す */ }
  const next=TITLES[name] ? name : 'shelf';
  if(next==='search' && route.name!=='search'){ui.recShift=(ui.recShift || 0)+1;ui.searchQ='';saveUi();}
  route = { name: next, arg };
  render();
  window.scrollTo(0, 0);
}

// 本棚が変わったとき、入力中でなければ今の画面を描き直す
store.subscribe((ev) => {
  if(ev.type==='external' && openId && !store.get(openId))closeSheet();
  if (ev.type === 'save-error') { toast('保存できませんでした。端末の空き容量を確認してください'); return; }
  if (['change','sync','external'].includes(ev.type)) syncShelfAuthors(); // 本が増減したら、本棚の著者のフォローをそろえる
  if (ev.type === 'change' || ev.type === 'preferences') scheduleSync(); // 自分で変えたときだけ同期する（同期で届いた変更は送り返さない）
  updateBadge();
  // 左右に払っている最中・切り替えの途中は描き直さず、終わってから（v0.18：著書の画面が裏で描き直されて、払った指が外れていた）
  if ((shelfSwipe || shelfSliding || paneAnimating) && ['shelf', 'author'].includes(route.name)) { swipeDeferred = true; return; } // 指が触れている間も（払い始めで外れないように）
  // 裏の新刊確認・表紙の補充・自動フォローは、著書の画面だけ描き直す（本棚を見ている最中に一覧を作り直さない）
  if (['release-covers', 'releases', 'follows'].includes(ev.type)) { if (route.name==='author' && !route.arg) renderAuthorHome(); return; }
  if (route.name === 'author' && !route.arg) { renderAuthorHome(); return; }
  if (route.name === 'shelf' || route.name === 'stats') {
    if (sheet.open && openId) { pendingRender = true; return; } // 詳細を閉じたら描き直す
    const focused = document.activeElement?.id;
    render();
    if (focused === 'shelf-q') { const el = $('#shelf-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  } else if (route.name === 'author' && lastAuthor?.name === route.arg && $('#author-result')) {
    drawAuthorResult(lastAuthor.name, lastAuthor.works);
  } else if (route.name === 'search') (ui.searchQ ? drawSearchResult() : drawRecommendations()); // 登録した本を印に替える・おすすめから外す
});

// ---------------------------------------------------------------- 操作
const actions = {
  'backup-preview':showBackupPreview,
  'preference-toggle':el=>{const id=el.dataset.v;preferred.has(id)?preferred.delete(id):preferred.add(id);$('#preference-choices').innerHTML=genreChoices();const next=$('.onboarding-next');if(next)next.textContent=onboardingLabel();$('#preference-choices [data-v="'+id+'"]')?.focus({preventScroll:true});},
  // おすすめは検索タブを開くたびに入れ替わるので、好みを後から変える画面は置かない（v0.15 本人：「好みを変更」はいらない）
  'preferences-save':()=>{store.setFavoriteGenres([...preferred]);recState=null;ui.searchQ='';ui.recShift=(ui.recShift || 0)+1;saveUi();if(location.hash!=='#search')location.hash='#search';else render();},
  'versions': renderVersionHistory,
  'work-detail': el=>previewWork(workCache.get(el.dataset.key)),
  'series-vol': (el) => {
    const key=el.dataset.key,vol=Number(el.dataset.vol);
    const d=findSeries(key);
    const v=d?.vols.find(x=>x.vol===vol);
    if(!v || (v.upcoming && !v.book))return;
    const y=window.scrollY;
    let b=v.book;
    if(!b) b=addSeriesVolume(d,v,'done');
    else if(b.status==='done')store.update(b.id,{status:['want','reading'].includes(b.seriesPreviousStatus) ? b.seriesPreviousStatus : 'want',finishedAt:'',seriesPreviousStatus:''});
    else store.update(b.id,{seriesPreviousStatus:b.status,status:'done'});
    if(!b)return;
    window.scrollTo(0,y);
    const btn=[...document.querySelectorAll('[data-act="series-vol"]')].find(e=>e.dataset.key===key && Number(e.dataset.vol)===vol);
    btn?.focus({preventScroll:true});
    const name=volName(d,v);
    const won=noteTrophies();
    toast(store.get(b.id)?.status==='done' ? `${name}を読了にしました${won.length ? `。${wonText(won)}` : ''}` : `${name}の読了を取り消しました`);
  },
  'series-add': (el) => {
    const d = findSeries(el.dataset.key);
    const v = d?.vols.find((x) => x.vol === Number(el.dataset.vol));
    if (!v || v.book) return;
    addSeriesVolume(d, v); // 著者名は本棚の表記にそろえる（同じシリーズとしてまとまるように）
  },
  'series-name': (el) => setSeriesName(openId, el.dataset.v || ''),
  'series-name-save': () => {
    const name = ($('#f-series')?.value || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || name === NO_SERIES) { toast('シリーズ名を入れてください'); $('#f-series')?.focus(); return; }
    setSeriesName(openId, name);
  },
  'series-open': (el) => { // 巻を見る／閉じる（位置はそのまま）
    const k = el.dataset.key;
    if (openSeries.has(k)) openSeries.delete(k); else openSeries.add(k);
    const y = window.scrollY; drawSeries(); window.scrollTo(0, y);
  },
  'series-done': () => { showDoneSeries = !showDoneSeries; const y = window.scrollY; drawSeries(); window.scrollTo(0, y); },
  'series-more': (el) => {
    const key = el.dataset.key;
    expandedSeries.has(key) ? expandedSeries.delete(key) : expandedSeries.add(key);
    drawSeries();
    [...document.querySelectorAll('[data-act="series-more"]')].find((e) => e.dataset.key === key)?.focus({ preventScroll: true });
  },
  'release-detail': el=>previewRelease(store.releases().find(r=>r.key===el.dataset.key)),
  'preview-add': ()=>{
    const state=preview;
    if (!state || previewOwned(state)) return;
    const publishedAt=state.details?.publishedAt || state.book.publishedAt;
    if (state.release) addFromRelease(state.release,publishedAt);
    else if (state.zukan) { // 図鑑のカード：シリーズの巻として（名前のあるシリーズは一覧の書名のまま）
      const d=zukanSeries(state.zukan.key),v=d?.vols.find(x=>x.vol===state.zukan.vol);
      if (d && v && !v.book) addSeriesVolume(d,v);
    }
    else addFromWork(state.work,{source:'search',publishedAt});
    drawPreviewAction(state);
  },
  'zukan-card': (el) => {
    const d = zukanSeries(el.dataset.key);
    const v = d?.vols.find((x) => x.vol === Number(el.dataset.vol));
    if (!v) return;
    if (v.book) { renderSheetBook(v.book.id); return; }
    renderBookPreview({ title: mainTitle(v.title), author: d.author, isbn: v.isbn || '', publisher: v.publisher || '', publishedAt: v.publishedAt || v.month || '', coverIsbns: v.coverIsbns || [] }, { zukan: { key: d.key, vol: v.vol } });
  },
  'shelf-mode': (el) => { ui.sort=el.dataset.v; shelfLimit=24; saveUi(); renderShelf(); },
  'shelf-filter-genre': (el) => { ui.genre=el.dataset.v; shelfLimit=24; saveUi(); renderShelf(); },
  'book-view': (el) => { ui.bookView = el.dataset.v; saveUi(); renderShelf(); },
  'shelf-direction': (el) => { ui[ui.sort==='year' ? 'yearDirection' : 'addedDirection']=el.dataset.v; shelfLimit=24; saveUi(); renderShelf(); },
  open: (el) => renderSheetBook(el.dataset.id),
  close: () => closeSheet(),
  author: (el) => { closeSheet(); location.hash = `#author/${encodeURIComponent(el.dataset.name)}`; },
  'set-status': (el) => {
    const was = store.get(openId)?.status;
    store.update(openId, { status: el.dataset.v });
    renderSheetBook(openId);
    const won = noteTrophies();
    if (el.dataset.v === 'done' && was !== 'done') toast(won.length ? `読了にしました。${wonText(won)}` : '読了にしました。本棚から外れて、「記録」に残ります');
    if (el.dataset.v !== 'done' && was === 'done') toast('本棚に戻しました');
  },
  'date-open': (el) => {
    const pop = $('#finished-pop');
    if (!pop) return;
    if (datePick) { datePick = null; pop.hidden = true; el.setAttribute('aria-expanded', 'false'); return; }
    datePick = { month: (publicationDate(store.get(openId)?.finishedAt) || today()).slice(0, 7) };
    if (datePick.month.length!==7) datePick.month=today().slice(0,7);
    pop.hidden = false;
    el.setAttribute('aria-expanded', 'true');
    drawDatePicker();
  },
  'dp-move': (el) => {
    if (!datePick) return;
    const [y, m] = datePick.month.split('-').map(Number);
    datePick.month = ymdOf(new Date(y, m - 1 + Number(el.dataset.v), 1)).slice(0, 7);
    drawDatePicker();
  },
  'dp-pick': (el) => {
    datePick = null;
    store.update(openId, { finishedAt: el.dataset.date });
    renderSheetBook(openId);
  },
  'synopsis-more': (el) => {
    const p = $('#book-synopsis .synopsis-text');
    if (!p) return;
    p.classList.toggle('clamp');
    el.textContent = p.classList.contains('clamp') ? '続きを読む' : '閉じる';
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
  // 1 回で消す（本人の希望）。間違えたときのために、知らせに「元に戻す」を 6 秒出す
  delete: () => {
    const b = store.get(openId);
    if (!b) return;
    const index = store.indexOf(b.id);
    const copy = structuredClone(b);
    store.remove(b.id);
    closeSheet();
    toast(`「${mainTitle(b.title)}」を${b.status === 'done' ? '記録' : '本棚'}から消しました`, { label: '元に戻す', run: () => { store.restore(copy, index); toast('元に戻しました'); } });
  },
  'add-work': (el) => {
    const w = workCache.get(el.dataset.key);
    if (!w) return;
    const onSearch = route.name === 'search';
    const author = route.name === 'author' ? route.arg : (onSearch && ui.searchKind === 'author' ? ui.searchQ.trim() : undefined);
    const b = addFromWork(w, { author, source: 'search', status: 'want' });
    if (el.isConnected) el.closest('.book-side').innerHTML = ownedButton(b);
  },

  'rec-hide': (el) => { store.hideRec(el.dataset.key); },
  'history-year': (el) => { ui.historyYear = el.dataset.v === ui.historyYear ? 'all' : el.dataset.v; saveUi(); renderStats(); }, // 選んでいる年にもう一度触れると、すべてに戻る
  'toggle-ui': (el) => {
    ui[el.dataset.v] = !ui[el.dataset.v];
    saveUi();
    if (route.name === 'author' && lastAuthor?.name === route.arg) drawAuthorResult(lastAuthor.name, lastAuthor.works);
  },
  'pick-random': () => {
    const pool = store.books().filter((b) => b.status === 'want');
    if (!pool.length) { toast('読みたい本がありません'); return; }
    const weighted = pool.flatMap((b) => Array(b.priority || 1).fill(b));
    renderSheetBook(weighted[Math.floor(Math.random() * weighted.length)].id);
  },
  export: () => exportBackup(),
  'confirm-merge': () => {
    if (!mergeFile.pending) return;
    try {
      const r = store.mergeBooks(mergeFile.pending);
      mergeFile.pending = null;
      closeSheet();
      toast(r.addedDone === r.added && r.added ? `${r.added}冊を読了として記録・図鑑に入れました${r.read ? `（${r.read}冊を読了に）` : ''}` : `${r.added}冊を追加${r.read ? `、${r.read}冊を読了に` : ''}しました`);
    } catch { toast('読み込めませんでした'); }
  },
  'confirm-import': () => {
    try {
      store.replaceAll(importBackup.pending);
      toast('バックアップから戻しました');
    } catch (e) {
      toast(e.message);
    }
    closeSheet();
  },
  add: () => renderSheetScan(), // v0.18 本人：検索へ移らず、すぐバーコードを読む画面に（書名で探すのは画面の下から）
  'scan-to-search': () => {
    closeSheet();
    if (route.name !== 'search') location.hash = '#search';
    setTimeout(() => $('#book-q')?.focus(), 80);
  },



  // バーコード
  'open-scan': () => renderSheetScan(),
  'scan-check-add': (el) => { addScanned(scanned.find((x) => x.isbn === el.dataset.isbn && x.check)); drawScanned(); },
  'scan-add-all': () => { const list = scanned.filter((s) => s.check && s.state === 'new'); list.forEach(addScanned); drawScanned(); toast(`${list.length}冊を本棚に追加しました`); },
  kuji: () => renderKuji(),
  'kuji-draw': () => drawKuji(),
  'kuji-add': () => {
    const c = kuji?.pick;
    if (!c || c.book || !c.d) return;
    const b = addSeriesVolume(c.d, c.v, 'want');
    if (b) { c.book = b; c.key = b.id; showKujiResult(); }
  },
  'kuji-read': (el) => {
    const b = store.get(el.dataset.id);
    if (!b) return;
    store.update(b.id, { status: 'reading' });
    closeSheet();
    render();
    toast(`「${mainTitle(b.title)}」を読書中にしました`);
  },
  trophies: () => renderTrophies(),
  'trophy-family': (el) => renderTrophyFamily(el.dataset.f),
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
  'check-releases': () => checkReleases(staleFollows().length ? staleFollows() : store.follows().map((f) => f.name)),
  'release-add': (el) => {
    const r=store.releases().find(x=>x.key===el.dataset.key);
    if (r) addFromRelease(r);
    if (daySheet && sheet.open) renderCalendarDay(daySheet.date); // カレンダーの日付の画面は「本棚の記録を開く」に替える
  },
  'unowned-more': (el) => { unowned.open.add(el.dataset.name); const y = window.scrollY; drawUnowned(); window.scrollTo(0, y); },
  'author-mode': (el) => { ui.authorMode = el.dataset.v; saveUi(); renderAuthorHome(); window.scrollTo(0, 0); },
  'cal-view': (el) => { ui.calView = el.dataset.v; saveUi(); drawCalendar(); },
  'cal-today': () => { ui.calMonth = ''; ui.calWeek = ''; saveUi(); drawCalendar(); },
  'cal-move': (el) => {
    const step = Number(el.dataset.v) || 0;
    if (ui.calView === 'week') {
      const d = dateOf(/^\d{4}-\d{2}-\d{2}$/.test(ui.calWeek || '') ? weekStart(ui.calWeek) : weekStart(today()));
      d.setDate(d.getDate() + step * 7);
      ui.calWeek = ymdOf(d);
    } else {
      const [y, m] = (/^\d{4}-\d{2}$/.test(ui.calMonth || '') ? ui.calMonth : today().slice(0, 7)).split('-').map(Number);
      ui.calMonth = ymdOf(new Date(y, m - 1 + step, 1)).slice(0, 7);
    }
    saveUi();
    drawCalendar();
  },
  'cal-day': (el) => renderCalendarDay(el.dataset.date),
  'unowned-retry': () => { unowned.failed.clear(); drawUnowned(); },
  'sync-now': () => runSync(),
  'sync-choose': (el) => chooseSync(el.dataset.v),
  'sync-snapshot': exportSnapshot,
  'sync-off': async () => {
    if (!window.confirm('この端末の同期をやめますか？（GitHub のデータと、ほかの端末の本棚はそのままです）')) return;
    await sync.disconnect();
    toast('この端末の同期をやめました');
    drawSyncCard();
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
  if (e.key === 'Enter' && e.target.id === 'f-series' && !e.isComposing) { e.preventDefault(); actions['series-name-save'](); }
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
  if (t.id === 'merge-file' && t.files?.[0]) mergeFile(t.files[0]);
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'import-code-form') { e.preventDefault(); importByCode($('#import-code')?.value); return; }
  if (e.target.id === 'sync-form') { e.preventDefault(); submitSync(); return; }
  if (e.target.id === 'sync-unlock') { e.preventDefault(); submitUnlock(); return; }
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

// ---------------------------------------------------------------- 表紙の拡大
// 本の詳細の表紙に触れると、その位置から画面の中央へ大きく広がる（v0.15.3 本人：表紙がブワンと大きくなって見やすく）。
// どこかに触れるか Esc で元の位置へ戻る。表紙の画像がない本（書名を組んだ表紙）は広げない
let coverZoom = null;
// 拡大用の大きい表紙（同じ配信元の同じ本）。版元ドットコムは幅 600px の版、Google は高さ 1200px で頼む
// （v0.15.5 本人：広げた表紙の画質が荒すぎる。Google の表紙は幅 128px のままだった）
function hiResCover(img) {
  const isbn = /^\d{13}$/.test(img.dataset.isbn || '') ? img.dataset.isbn : '';
  if (img.dataset.step === '0' && isbn) return `https://img.hanmoto.com/bd/img/${isbn}_600.jpg`;
  if (img.dataset.step === '1' && isbn) return `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1&fife=h1200`;
  if (/^[\w-]+$/.test(img.dataset.googleId || '')) return `https://books.google.com/books/content?id=${img.dataset.googleId}&printsec=frontcover&img=1&zoom=1&fife=h1200`;
  return '';
}
// 大きい表紙を読んでおく（詳細を開いて表紙が出たとき・表紙に触れたとき）。元より大きく、縦横の比が同じ（別の画像でない）ときだけ使う
const hiResMemo = new Map();
function loadHiRes(img) {
  const url = hiResCover(img);
  if (!url || !img.naturalWidth) return Promise.resolve(null);
  if (!hiResMemo.has(url)) {
    const ratio = img.naturalHeight / img.naturalWidth;
    const hi = new Image();
    hi.src = url;
    hiResMemo.set(url, hi.decode().then(() => {
      const r = hi.naturalHeight / hi.naturalWidth;
      return hi.naturalWidth > img.naturalWidth && Math.abs(r - ratio) / ratio < 0.08 ? hi : null;
    }).catch(() => null));
  }
  return hiResMemo.get(url);
}
document.addEventListener('load', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('ok') && img.closest('#sheet .detail-head')) loadHiRes(img);
}, true);
function zoomCover(img) {
  if (coverZoom || !img.naturalWidth) return;
  let box = $('#cover-zoom');
  if (!box) {
    box = document.createElement('dialog');
    box.id = 'cover-zoom'; box.className = 'cover-zoom'; box.setAttribute('aria-label', '表紙');
    box.innerHTML = '<div class="cz-shade"></div><img class="cz-img" alt="">';
    box.addEventListener('click', () => unzoomCover());
    box.addEventListener('cancel', (e) => { e.preventDefault(); unzoomCover(); });
    document.body.append(box);
  }
  const big = box.querySelector('.cz-img');
  const ratio = img.naturalHeight / img.naturalWidth;
  const w = Math.min(innerWidth * 0.84, 420, (innerHeight * 0.78) / ratio);
  const to = { left: (innerWidth - w) / 2, top: (innerHeight - w * ratio) / 2, width: w, height: w * ratio };
  Object.assign(big.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
  big.src = img.currentSrc || img.src;
  // 大きい表紙が届いていればすぐ、まだなら届いた時点で差し替える（小さい表紙を引き伸ばした荒さをなくす）
  loadHiRes(img).then((hi) => { if (hi && coverZoom?.big === big && !coverZoom.closing) big.src = hi.src; });
  const from = img.getBoundingClientRect();
  const holder = img.closest('.cover') || img; // 広げている間は元の表紙の場所を空ける（下の書名の表紙も見せない）
  coverZoom = { img, holder, box, big, to };
  box.showModal();
  holder.style.visibility = 'hidden';
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.querySelector('.cz-shade').animate([{ opacity: 0 }, { opacity: 1 }], { duration: still ? 120 : 260, easing: 'ease-out' });
  if (still) big.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
  else big.animate([{ transform: zoomFrom(from, to), borderRadius: '3px' }, { transform: 'none', borderRadius: '8px' }], { duration: 460, easing: 'cubic-bezier(.2,1.32,.36,1)' });
}
// 小さい表紙の位置・大きさから広げるための変形
const zoomFrom = (r, to) => `translate(${r.left - to.left}px, ${r.top - to.top}px) scale(${r.width / to.width}, ${r.height / to.height})`;
function unzoomCover() {
  const z = coverZoom;
  if (!z || z.closing) return;
  z.closing = true;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const r = z.img.isConnected ? z.img.getBoundingClientRect() : null;
  z.big.getAnimations().forEach((a) => a.cancel()); // 広がる途中で触れたときも、いまの大きさから戻す
  z.box.querySelector('.cz-shade').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
  const back = still || !r?.width ? z.big.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })
    : z.big.animate([{ transform: 'none', borderRadius: '8px' }, { transform: zoomFrom(r, z.to), borderRadius: '3px' }], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
  back.finished.catch(() => {}).finally(() => {
    z.holder.style.visibility = '';
    if (z.box.open) z.box.close();
    z.big.getAnimations().forEach((a) => a.cancel());
    z.box.querySelector('.cz-shade').getAnimations().forEach((a) => a.cancel());
    z.big.removeAttribute('src');
    if (coverZoom === z) coverZoom = null;
  });
}
sheet.addEventListener('click', (e) => {
  const img = e.target.closest?.('.detail-head > .cover')?.querySelector('img.ok');
  if (img) zoomCover(img);
});
sheet.addEventListener('pointerdown', (e) => {
  const img = e.target.closest?.('.detail-head > .cover')?.querySelector('img.ok');
  if (img) loadHiRes(img);
});
sheet.addEventListener('close', () => {
  if (coverZoom) unzoomCover();
  stopBookPreview();
  stopScanning();
  flushMemo();
  unlockPage();
  sheetClosed();
});

// ---------------------------------------------------------------- 本棚の並べ方を左右のスワイプで切り替える（v0.17 本人の①：タップだけでなくスライドでも）
// v0.17.2 本人「カクつく・残像が残る」：動かすのは並べ方のボタンより下の 1 枚（.shelf-pane）だけにし、指の動きは 1 コマに 1 回だけ反映する。
// 透明度は変えない（iPhone で画像の多い面の透明度を変えると残像が出る）。横に払っている間は縦にスクロールさせない。
// 切り替えるときは、今の並びを払った向きへ送り出してから、新しい並びを反対側から入れる（入れる間は本の浮かび上がりを止める）
// v0.18 本人：著書（持っていない本・新刊・カレンダー）も同じように左右に払って切り替える
let shelfSwipe = null;
let shelfSliding = false;
let swipeDeferred = false; // 払っている間に届いた本棚の変更（終わってから描き直す）
let paneAnimating = false; // 新しい並びが入ってくる途中（描き直すと動きが途切れる）
const flushSwipeRender = () => { if (!swipeDeferred || shelfSwipe || shelfSliding || paneAnimating) return; swipeDeferred = false; if (route.name === 'author' && !route.arg) renderAuthorHome(); else if (route.name === 'shelf') render(); };
const shelfPane = () => document.querySelector('.swipe-pane');
const SWIPERS = {
  shelf: { modes: () => SHELF_MODES, get: () => ui.sort, set: (v) => { ui.sort = v; shelfLimit = 24; saveUi(); renderShelf(); } },
  author: { modes: () => AUTHOR_MODES, get: () => (AUTHOR_MODES.some(([id]) => id === ui.authorMode) ? ui.authorMode : AUTHOR_MODES[0][0]), set: (v) => { ui.authorMode = v; saveUi(); renderAuthorHome(); } },
};
const swiper = () => (route.name === 'shelf' ? SWIPERS.shelf : route.name === 'author' && !route.arg ? SWIPERS.author : null);
const PANE_EASE = 'cubic-bezier(.22,.8,.3,1)';
function setPane(x, transition = 'none') {
  const el = shelfPane();
  if (!el) return;
  el.style.transition = transition;
  el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
}
view.addEventListener('touchstart', (e) => {
  shelfSwipe = null;
  if (!swiper() || e.touches.length !== 1 || sheet.open || shelfSliding) return;
  // 並べ方のボタンより下なら、中身の短い画面の空いたところでも払える（v0.18）
  if (!e.target.closest('#view') || e.target.closest('.page-head, .shelf-tabs, input, textarea, select, .shelf-genres, .series-vols, .cal-switch, .dp-grid')) return;
  const t = e.touches[0];
  // 動き・離したことは、指を置いた要素で受け取る（裏で一覧が描き直されて要素が外れても、払う動きが途切れない）
  const target = e.target;
  shelfSwipe = { x: t.clientX, y: t.clientY, dx: 0, on: false, raf: 0, target };
  target.addEventListener('touchmove', onSwipeMove, { passive: false });
  target.addEventListener('touchend', endShelfSwipe);
  target.addEventListener('touchcancel', cancelShelfSwipe);
}, { passive: true });
const releaseSwipeTarget = (s) => { s?.target?.removeEventListener('touchmove', onSwipeMove); s?.target?.removeEventListener('touchend', endShelfSwipe); s?.target?.removeEventListener('touchcancel', cancelShelfSwipe); };
function onSwipeMove(e) {
  const s = shelfSwipe;
  if (!s) return;
  const t = e.touches[0];
  s.dx = t.clientX - s.x;
  const dy = t.clientY - s.y;
  if (!s.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(s.dx)) { releaseSwipeTarget(s); shelfSwipe = null; flushSwipeRender(); return; } // 縦のスクロール
    if (Math.abs(s.dx) < 12 || Math.abs(s.dx) < Math.abs(dy) * 1.4) return;
    s.on = true;
    s.sw = swiper();
    s.modes = s.sw.modes();
    s.idx = s.modes.findIndex(([id]) => id === s.sw.get());
    s.w = shelfPane()?.offsetWidth || innerWidth;
    s.x += s.dx > 0 ? 12 : -12; // 動き出した位置から指につける（最初の 12px で跳ねない）
    s.dx = t.clientX - s.x;
    shelfPane()?.classList.add('swiping');
  }
  if (e.cancelable) e.preventDefault();
  if (!s.raf) s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    if (shelfSwipe !== s) return;
    const edge = (s.dx > 0 && s.idx === 0) || (s.dx < 0 && s.idx === s.modes.length - 1);
    setPane(edge ? s.dx * 0.18 : s.dx); // 端の並べ方は少しだけ（それ以上はない合図）
  });
}
function endShelfSwipe() {
  const s = shelfSwipe;
  releaseSwipeTarget(s);
  shelfSwipe = null;
  if (!s?.on) { flushSwipeRender(); return; }
  cancelAnimationFrame(s.raf);
  const dir = s.dx < 0 ? 1 : -1;
  const next = s.idx + dir;
  if (Math.abs(s.dx) < Math.min(70, s.w * 0.18) || next < 0 || next >= s.modes.length || swiper() !== s.sw) {
    setPane(0, `transform .3s ${PANE_EASE}`);
    setTimeout(() => { shelfPane()?.classList.remove('swiping'); flushSwipeRender(); }, 320);
    return;
  }
  shelfSliding = true;
  paneAnimating = true;
  swipeDeferred = false; // 新しい並びを描くので、待たせていた描き直しはいらない
  setPane(-dir * s.w, 'transform .17s cubic-bezier(.45,0,.9,.55)'); // 今の並びを送り出す
  setTimeout(() => {
    s.sw.set(s.modes[next][0]);
    const fresh = shelfPane();
    if (!fresh) { shelfSliding = false; paneAnimating = false; return; }
    fresh.classList.add('swiping', 'no-reveal');
    setPane(dir * s.w * 0.4);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setPane(0, `transform .32s ${PANE_EASE}`);
      shelfSliding = false; // 入り始めたら、続けて次のスワイプを受け付ける（連続で払っても止まらない）
      setTimeout(() => { fresh.classList.remove('no-reveal'); paneAnimating = false; if (!shelfSwipe?.on) { fresh.classList.remove('swiping'); if (!fresh.style.transform) fresh.style.transition = ''; } flushSwipeRender(); }, 340);
    }));
  }, 170);
}
function cancelShelfSwipe() {
  const s = shelfSwipe;
  releaseSwipeTarget(s);
  if (s?.on) { cancelAnimationFrame(s.raf); setPane(0, `transform .3s ${PANE_EASE}`); }
  shelfSwipe = null;
  setTimeout(flushSwipeRender, 320);
}

// ---------------------------------------------------------------- 下のナビ：ガラスの面を持って左右に動かし、離したタブへ（v0.17 本人の②）
// 押さえたまま横に動かすと、ガラスの面が指について大きくなり、離したところのタブを開く。そのまま触れて離したときは普通のタップ
const tabbar = $('.tabbar');
let navDrag = null;
let navSuppressClick = false;
const navTabs = () => [...tabbar.querySelectorAll('.tab')];
function navNearest(x) {
  const tabs = navTabs();
  let best = 0, dist = Infinity;
  tabs.forEach((t, i) => { const r = t.getBoundingClientRect(); const d = Math.abs(r.left + r.width / 2 - x); if (d < dist) { dist = d; best = i; } });
  return best;
}
tabbar.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || !tabbar.classList.contains('has-glider')) return;
  navDrag = { id: e.pointerId, x0: e.clientX, on: false };
});
tabbar.addEventListener('pointermove', (e) => {
  const d = navDrag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.on) {
    if (Math.abs(e.clientX - d.x0) < 10) return;
    d.on = true;
    try { tabbar.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
    tabbar.classList.add('dragging');
  }
  d.cx = e.clientX;
  if (d.raf) return;
  // 指の動きは 1 コマに 1 回だけ反映する（v0.17.2 カクつき）
  d.raf = requestAnimationFrame(() => {
    d.raf = 0;
    if (navDrag !== d) return;
    const glider = $('.tab-glider');
    const box = tabbar.getBoundingClientRect();
    const w = glider.offsetWidth;
    const left = Math.max(4, Math.min(box.width - w - 4, d.cx - box.left - w / 2));
    glider.style.transform = `translate3d(${left}px,0,0) scale(1.12)`;
    const at = navNearest(d.cx);
    navTabs().forEach((t, i) => t.classList.toggle('drag-over', i === at));
  });
});
const navDrop = (e) => {
  const d = navDrag;
  navDrag = null;
  if (!d?.on) return;
  cancelAnimationFrame(d.raf);
  tabbar.classList.remove('dragging');
  navTabs().forEach((t) => t.classList.remove('drag-over'));
  navSuppressClick = true; // 離したあとに来るタップは無視（ドラッグの開始位置のタブを開かない）
  setTimeout(() => { navSuppressClick = false; }, 400);
  const tab = navTabs()[navNearest(e.clientX)];
  if (e.type === 'pointercancel' || tab.getAttribute('aria-current') === 'page') { placeGlider(true); return; }
  location.hash = tab.getAttribute('href');
};
tabbar.addEventListener('pointerup', navDrop);
tabbar.addEventListener('pointercancel', navDrop);
tabbar.addEventListener('click', (e) => { if (navSuppressClick) { e.preventDefault(); e.stopPropagation(); navSuppressClick = false; } }, true);
// v0.18.1 本人：一番下まで来たときに、いまの画面のタブ（本棚・著書など）を押すと一番上へ戻る
tabbar.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || route.name !== tab.dataset.tab || route.arg) return;
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

// ---------------------------------------------------------------- 別の巻の ISBN を直す（v0.17.1 本人：invert の表紙・年が invert 2 のものだった）
// 最初に作った本棚の表で「invert」に「invert 2」（国立国会図書館では書名「invert」巻次「2」）の ISBN が入っていた。
// 同じ ISBN を書名の違う本が持っているとき、国立国会図書館でその ISBN の巻を確かめ、巻が合わない本を自分の巻の版（ISBN・表紙・刊行年）に直す。
// 端末ごとに 1 回（ui.isbnRepair）。直した本は同期でもう一方の端末へ。つながらなかったときは次に開いたときにもう一度
const ISBN_REPAIR = 1;
const workVol = (w) => volumeNumber(w.volume) || splitVolume(w.main || w.title).vol || 0;
const sameVol = (a, b) => a === b || (!a && b === 1) || (a === 1 && !b); // 巻数のない本は 1 巻目
async function repairSharedIsbns() {
  if ((ui.isbnRepair || 0) >= ISBN_REPAIR) return;
  const by = new Map();
  for (const b of store.books()) {
    const i = cleanIsbn(b.isbn);
    if (!/^97[89]\d{10}$/.test(i)) continue;
    if (!by.has(i)) by.set(i, []);
    by.get(i).push(b);
  }
  let failed = false;
  for (const [isbn, list] of by) {
    if (new Set(list.map((b) => normTitle(b.title))).size < 2) continue;
    try {
      const w = await ndl.searchIsbn(isbn);
      if (!w) continue;
      const vol = workVol(w);
      for (const b of list) {
        const { base, vol: own } = splitVolume(b.title);
        if (sameVol(own, vol)) continue; // この本の ISBN
        const works = await ndl.searchTitle(base, b.author);
        const right = works.filter((x) => !x.isComic && x.latest?.isbn && x.latest.isbn !== isbn
          && normTitle(splitVolume(x.main || x.title).base) === normTitle(base) && sameVol(own, workVol(x)))
          .sort((x, y) => (y.latest.publishedAt || '').localeCompare(x.latest.publishedAt || ''))[0];
        if (!right) continue;
        store.update(b.id, {
          isbn: right.latest.isbn, coverIsbns: [...right.editions].reverse().map((e) => coverIsbn(e.isbn)).filter(Boolean), coverIsbn: '',
          year: right.firstYear ? String(right.firstYear) : b.year, publishedAt: right.latest.publishedAt || publicationDate(right.latest.issued) || '',
          publisher: right.latest.publisher || b.publisher, format: right.latest.format || b.format,
        });
      }
    } catch { failed = true; }
  }
  if (!failed) { ui.isbnRepair = ISBN_REPAIR; saveUi(); }
}

// ---------------------------------------------------------------- 起動
store.load();
// v0.18 本人：ホーム画面のアプリを閉じて（消して）開き直したときは、前の画面ではなく本棚の著者順から。
// 裏に回して戻ったとき・iPhone が裏で読み直したときは同じセッション（sessionStorage が残る）なので前の画面のまま。
// ブラウザで開いたリンク（#stats/zukan など）や取り込みコードのリンクはそのまま開く
(() => {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let resumed = false;
  try { resumed = sessionStorage.getItem('dokusho-techo:open') === '1'; sessionStorage.setItem('dokusho-techo:open', '1'); } catch { resumed = true; }
  if (!standalone || resumed || /^#stats\/import\//.test(location.hash)) return;
  Object.assign(ui, { sort: 'author', q: '', genre: '' });
  saveUi();
  if (location.hash !== '#shelf') history.replaceState(null, '', '#shelf');
})();
window.addEventListener('hashchange', onHash);
onHash();
try { noteTrophies(); } catch { /* 数えられなくても動く */ }
setTimeout(() => { repairSharedIsbns().catch(() => {}); }, 2500); // v0.17.1：別の巻の ISBN を持つ本を直す（端末ごとに 1 回）
store.fillMissingReadDates(); // v0.15.1：写真から取り込んだ読了の本などに、だいたいの読了日を振る（端末ごとに 1 回。同期でもう一方へ）
store.syncShelfFollows(authorCounts().map(([a])=>a));
updateBadge();
runSync();
if(store.snapshot().onboardingDone && store.books().length) {
  const stale=staleFollows().slice(0,AUTO_CHECK_LIMIT);
  hydrateReleaseCovers().finally(async()=>{if(stale.length)await checkReleases(stale);checkSeries();});
}

navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}


