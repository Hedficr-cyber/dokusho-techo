import { compareAuthors } from './authors.js';
import { GENRE_GROUPS, GENRE_GROUP_BY_ID } from './genres.js';
export const SHELF_MODES = [
  ['author','作者順','作者の五十音順'], ['added','登録順','新しく登録した順'],
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
const publicationCompare=(a,b)=>String(b.publishedAt || b.year || '').localeCompare(String(a.publishedAt || a.year || ''));
export function sortShelfBooks(books,mode) {
  const genreIndex=b=>{const i=GENRE_GROUPS.findIndex(g=>g.id===primaryGenre(b).id);return i<0?GENRE_GROUPS.length:i;};
  const byAuthor=(a,b)=>compareAuthors(a,b) || publicationCompare(a,b) || titleCompare(a,b);
  const sorter=mode==='added' ? (a,b)=>String(b.registeredAt || b.addedAt || '').localeCompare(String(a.registeredAt || a.addedAt || ''))
    : mode==='year' ? (a,b)=>publicationCompare(a,b) || byAuthor(a,b)
    : mode==='genre' ? (a,b)=>genreIndex(a)-genreIndex(b) || byAuthor(a,b) : byAuthor;
  return [...books].sort(sorter);
}
