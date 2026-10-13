import { compareAuthors } from './authors.js';
import { GENRE_GROUPS, GENRE_GROUP_BY_ID } from './genres.js';
export const SHELF_MODES = [
  ['author','著者順','著者の五十音順'], ['added','登録順','新しく登録した順'],
  ['year','刊行順','刊行の新しい順'], ['genre','ジャンル','ジャンル別'],
];
export function primaryGenre(book) {
  for (const id of book.genres || []) {
    const group=GENRE_GROUPS.find(g=>g.children.includes(id));
    if (group) return group;
    if (id==='donden') return GENRE_GROUP_BY_ID.fiction;
  }
  return {id:'unclassified', name:'未分類'};
}
const titleCompare=(a,b)=>(a.title || '').localeCompare(b.title || '','ja');
// 日付が不明な本は昇順・降順とも最後。同じ登録時刻の初期データは元の並びを保つ。
const dateCompare=(a,b,key,direction='desc')=>{
  const x=String(key(a) || ''),y=String(key(b) || '');
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return (direction==='asc' ? 1 : -1)*x.localeCompare(y);
};
const publicationCompare=(a,b,direction='desc')=>dateCompare(a,b,x=>x.publishedAt || x.year,direction);
export function sortShelfBooks(books,mode,direction='desc') {
  const genreIndex=b=>{const i=GENRE_GROUPS.findIndex(g=>g.id===primaryGenre(b).id);return i<0?GENRE_GROUPS.length:i;};
  const byAuthor=(a,b)=>compareAuthors(a,b) || publicationCompare(a,b) || titleCompare(a,b);
  const sorter=mode==='added' ? (a,b)=>dateCompare(a,b,x=>x.registeredAt || x.addedAt,direction)
    : mode==='year' ? (a,b)=>publicationCompare(a,b,direction) || byAuthor(a,b)
    : mode==='genre' ? (a,b)=>genreIndex(a)-genreIndex(b) || byAuthor(a,b) : byAuthor;
  return [...books].sort(sorter);
}
