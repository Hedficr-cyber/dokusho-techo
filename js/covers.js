import { normTitle, today } from './util.js';

// 実画像の確認で判明した近刊の白い仮表紙。刊行日以降は新しい表紙を再び優先する。
const temporaryCovers = { '9784408560472':'2026-12-04' }; // 白銀ジャック 増補版
export const COVER_LOOKUP_VERSION = 1;
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
  const numbered=release.volume==null && title.match(/\s+(\d+)$/);
  const volume=String(release.volume ?? numbered?.[1] ?? '').normalize('NFKC').trim();
  const base=(numbered ? title.slice(0,numbered.index) : title).replace(editionWords,' ').trim();
  return {base,volume};
}
export function previousCoverIsbns(release,works,day=today()) {
  const {base,volume}=releaseIdentity(release);
  const primary=coverIsbn(release.isbn);
  const month=day.slice(0,7),year=Number(day.slice(0,4));
  const editions=works.filter(w=>!w.isComic && normTitle(w.main || w.title)===normTitle(base)
    && String(w.volume || '').normalize('NFKC').trim()===volume).flatMap(w=>w.editions || [])
    .filter(e=>coverIsbn(e.isbn) && coverIsbn(e.isbn)!==primary && (!e.month || e.month<=month) && (!e.year || e.year<=year))
    .sort((a,b)=>String(b.month || b.year || '').localeCompare(String(a.month || a.year || '')));
  return [...new Set(editions.map(e=>coverIsbn(e.isbn)))].slice(0,4);
}
