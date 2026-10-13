import { normTitle, normName, authorMatches, today } from './util.js';

// 実画像の確認で判明した近刊の白い仮表紙。刊行日以降は新しい表紙を再び優先する。
const temporaryCovers = { '9784408560472':'2026-12-04' }; // 白銀ジャック 増補版
export const COVER_LOOKUP_VERSION = 2;
export function coverIsbn(raw) {
  const d=String(raw || '').replace(/[^\dXx]/g,'');
  if (/^\d{13}$/.test(d)) return d;
  if (!/^\d{9}[\dXx]$/.test(d)) return '';
  const core=`978${d.slice(0,9)}`;
  const sum=[...core].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0);
  return core+((10-sum%10)%10);
}
export function coverCandidates(isbn,alternatives=[],day=today()) {
  const primary=coverIsbn(isbn);
  const skip=temporaryCovers[primary] && day<temporaryCovers[primary];
  return [...new Set([...(skip ? [] : [primary]),...[].concat(alternatives).map(coverIsbn)].filter(Boolean))];
}
const editionWords=/[\s　]*[〈（(【]?(新装改訂版|改訂完全版|新装版|増補版|完全版|決定版|改訂版|新版|愛蔵版)[〉）)】]?[\s　]*/g;
export function releaseIdentity(release) {
  const title=String(release.baseTitle || release.title || '').normalize('NFKC');
  const numbered=!release.volume && title.match(/\s+(\d+)$/);
  const volume=String(release.volume ?? numbered?.[1] ?? '').normalize('NFKC').trim();
  const base=(numbered ? title.slice(0,numbered.index) : title).replace(/【電子限定特典付き】/g,'').replace(editionWords,' ').trim();
  return {base,volume};
}
// 出版社の新刊データはISBNが省略される場合がある。書名・著者・発売月が一致するものだけ補う。
// 2026-10-14に書誌と実画像を確認。配信元を増やさず、元のISBNがある場合は書き換えない。
const confirmedBooks = [
  {title:'0秒前の彼女',author:'今村昌弘',month:'2026-10',isbn:'9784575249262',publishedAt:'2026-10-14',source:'https://www.hanmoto.com/bd/isbn/9784575249262'},
  {title:'蒼羽さん事件',author:'呉勝浩',month:'2026-10',isbn:'9784120060694',publishedAt:'2026-10-21',source:'https://www.chuko.co.jp/tanko/2026/10/006069.html'},
];
export function confirmedRelease(release) {
  const match=confirmedBooks.find(b=>normTitle(b.title)===normTitle(release.title)
    && normName(b.author)===normName(release.author) && b.month===release.month);
  return match && !release.isbn ? {isbn:match.isbn,publishedAt:match.publishedAt} : {};
}
const titleKeys=s=>{
  const clean=releaseIdentity({title:s}).base;
  const parts=clean.split(/\s:\s/);
  return [normTitle(clean),normTitle(parts.slice().reverse().join(' '))];
};
function matchingCoverEditions(release,works) {
  const {base,volume}=releaseIdentity(release),keys=titleKeys(base);
  return works.filter(w=>!w.isComic && (!release.author || !w.creators?.length || w.creators.some(c=>authorMatches(c,release.author)))
    && String(w.volume || '').normalize('NFKC').trim()===volume
    && [w.main,w.title,...(w.editions || []).map(e=>e.title)].some(t=>titleKeys(t).some(k=>keys.includes(k))))
    .flatMap(w=>w.editions || []);
}
export function currentReleaseIsbn(release,works) {
  if (release.isbn) return '';
  const editions=matchingCoverEditions(release,works).filter(e=>coverIsbn(e.isbn) && e.month===release.month
    && normName(e.publisher)===normName(release.publisher));
  const isbns=[...new Set(editions.map(e=>coverIsbn(e.isbn)))];
  return isbns.length===1 ? isbns[0] : '';
}
export function previousCoverIsbns(release,works,day=today()) {
  const primary=coverIsbn(release.isbn),month=day.slice(0,7),year=Number(day.slice(0,4));
  const editions=matchingCoverEditions(release,works)
    .filter(e=>coverIsbn(e.isbn) && coverIsbn(e.isbn)!==primary && (!e.month || e.month<=month) && (!e.year || e.year<=year))
    .sort((a,b)=>String(b.month || b.year || '').localeCompare(String(a.month || a.year || '')));
  return [...new Set(editions.map(e=>coverIsbn(e.isbn)))].slice(0,4);
}
// 実画像で確認したGoogleの共通灰色画像。寸法だけで全ISBNを除外しない。
// 発売後は配信元の更新を再確認できるよう、この限定判定を解除する。
const knownGooglePlaceholders={
  '9784488496029':'2026-11-12', // シャドウ 新装版
  '9784575441352':'2026-11-01', // 変な絵5
  '9784065460030':'2026-11-01', // 法廷占拠 爆弾2
  '9784909044747':'2026-11-01', // 放課後ミステリクラブ10
};
export function knownPlaceholder(isbn,source,width,height,day=today()) {
  return source==='google' && width===128 && height===184
    && !!knownGooglePlaceholders[isbn] && day<knownGooglePlaceholders[isbn];
}

// ISBNを持たない電子合本。Google Playの出版社提供ページと実画像で同一作品を確認。
// https://play.google.com/store/books/details?id=t9QMEgAAQBAJ （2026-10-14確認）
export function confirmedGoogleCover(title,author) {
  return normTitle(title)===normTitle('囁きシリーズ 全3冊合本版 〈新装改訂版〉')
    && normName(author)===normName('綾辻行人') ? 't9QMEgAAQBAJ' : '';
}
