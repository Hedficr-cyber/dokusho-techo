// タップした本だけ、許可済みのNDL/OpenBDから書誌と内容紹介を読む。
// 画面に出すときはapp.jsで文字としてエスケープ。ISBNのない本は書名と著者で厳密に照合する。
import { coverIsbn } from './covers.js';
import { normTitle, normName, authorMatches } from './util.js';
const DCT='http://purl.org/dc/terms/',DC='http://purl.org/dc/elements/1.1/';
const NDL='http://ndl.go.jp/dcndl/terms/',RDF='http://www.w3.org/1999/02/22-rdf-syntax-ns#',FOAF='http://xmlns.com/foaf/0.1/';
const PREFIX='book-info:',TTL=24*3600*1000;
const strings=(root,ns,name)=>[...root.getElementsByTagNameNS(ns,name)].map(e=>e.textContent.trim());
const first=(root,ns,name)=>strings(root,ns,name)[0] || '';
const cql=s=>'"'+String(s || '').replace(/[\\"]/g,'\\$&')+'"';
export function plainSynopsis(value) {
  if (typeof value!=='string') return '';
  return value.replace(/<(br|\/p|\/div)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,s)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[s])
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,s)=>{const n=s[0].toLowerCase()==='x' ? parseInt(s.slice(1),16) : Number(s);return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : '';})
    .replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,12000);
}
// 図書館によっては内容紹介の欄に「講談社文庫, [こ-72-2]」のような叢書の注記を入れる。文になっていない短い注記は除く
// v0.17：長い注記（「新潮文庫, 10163, ち-7-2 . 天久鷹央の推理カルテ / 知念実希人著||アメク タカオ…」
// 「メディアワークス文庫, 0247, 0271, …」）も、文の終わり（。！？）がなければあらすじにしない
const SERIES_NOTE=/(文庫|新書|ノベルス|ノベルズ|ブックス|叢書|選書|コミックス)\s*[,，]/;
export const looksLikeSynopsis=s=>!!s && !s.includes('||') && !(SERIES_NOTE.test(s) && !/[。！？!?」]/.test(s)) && (s.length>=40 || /[。！？!?」]/.test(s));
export function publicationDate(raw) {
  let s=String(raw || '').trim();
  if (/^\d{8}$/.test(s)) s=`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6)}`;
  else if (/^\d{6}$/.test(s)) s=`${s.slice(0,4)}-${s.slice(4)}`;
  const match=s.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:$|[T\s])/);
  if (!match) return '';
  const [,y,m,d]=match;
  if (m && (+m<1 || +m>12)) return '';
  if (d && (+d<1 || +d>new Date(+y,+m,0).getDate())) return '';
  return [y,m,d].filter(Boolean).join('-');
}
export function publicationLabel(raw) {
  const d=publicationDate(raw);
  if (!d) return '未確認';
  const [y,m,day]=d.split('-');
  return `${y}年${m ? `${Number(m)}月` : ''}${day ? `${Number(day)}日` : ''}`;
}
export function parseNdlDetails(xml,book) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('書誌情報を読み取れませんでした');
  const isbn=coverIsbn(book.isbn);
  const titleOf=b=>{const title=b.getElementsByTagNameNS(DC,'title')[0];return title ? first(title,RDF,'value') || title.textContent.trim() : first(b,DCT,'title');};
  const matches=[...doc.getElementsByTagNameNS(NDL,'BibResource')].filter(b=>{
    if (isbn) return strings(b,DCT,'identifier').some(s=>coverIsbn(s)===isbn);
    const names=strings(b,FOAF,'name'),title=titleOf(b),volume=first(b,NDL,'volume');
    return normTitle(volume ? `${title} ${volume}` : title)===normTitle(book.title)
      && names.some(n=>authorMatches(n,book.author));
  });
  if (!matches.length) return null;
  const records=matches.map(b=>({synopsis:strings(b,DCT,'abstract').map(plainSynopsis).filter(looksLikeSynopsis).join('\n\n'),publishedAt:publicationDate(first(b,DCT,'issued')),
    source:'国立国会図書館サーチ',sourceUrl:'https://ndlsearch.ndl.go.jp/search?cs=bib&keyword='+encodeURIComponent(isbn || `${book.title} ${book.author}`)}));
  // 同じISBNの記録で、出版社の内容紹介があるものと日付が具体的なものを優先。
  const best=records.slice().sort((a,b)=>Number(!!b.synopsis)-Number(!!a.synopsis) || b.publishedAt.length-a.publishedAt.length)[0];
  best.publishedAt=records.slice().sort((a,b)=>b.publishedAt.length-a.publishedAt.length)[0].publishedAt;
  return best;
}
export function parseOpenBdDetails(data,isbn) {
  const b=Array.isArray(data) ? data[0] : null;
  if (!b || coverIsbn(b.summary?.isbn || b.onix?.RecordReference)!==isbn) return null;
  const raw=b.onix?.CollateralDetail?.TextContent;
  const texts=Array.isArray(raw) ? raw : raw && typeof raw==='object' ? [raw] : [];
  const description=texts.find(t=>String(t.TextType)==='03') || texts.find(t=>String(t.TextType)==='02');
  const dates=b.onix?.PublishingDetail?.PublishingDate;
  const list=Array.isArray(dates) ? dates : dates ? [dates] : [];
  const date=list.find(d=>String(d.PublishingDateRole)==='01')?.Date || b.summary?.pubdate || b.hanmoto?.dateshuppan;
  return {synopsis:plainSynopsis(description?.Text),publishedAt:publicationDate(date),source:'openBD（出版社の内容紹介）',sourceUrl:'https://www.hanmoto.com/bd/isbn/'+isbn};
}
async function readOnce(url,signal,kind,wait) {
  const ctrl=new AbortController();
  const abort=()=>ctrl.abort(); signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,wait);
  try {
    if (signal?.aborted) throw new DOMException('Aborted','AbortError');
    const res=await fetch(url,{signal:ctrl.signal,credentials:'omit',referrerPolicy:'no-referrer'});
    if (!res.ok) throw new Error('書誌情報を取得できませんでした');
    return kind==='json' ? await res.json() : await res.text();
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
// NDL は最初の問い合わせが 20 秒以上返らないことがよくあり、やり直すと 1 秒かからず返る。短めに打ち切って再試行する
async function read(url,signal,kind,{attempts=3,wait=4000}={}) {
  for (let i=1;;i++) {
    try {return await readOnce(url,signal,kind,wait+(i-1)*2000);} // 4秒→6秒→8秒
    catch(e) {if (signal?.aborted || i>=attempts) throw e;await new Promise(r=>setTimeout(r,300*i));}
  }
}
async function fetchBookDetails(book,{background=false}={}) {
  const isbn=coverIsbn(book.isbn),key=PREFIX+(isbn || `${normTitle(book.title)}|${normName(book.author)}`);
  const signal=undefined;
  const hit=cached(book);if(hit && Date.now()-hit.at<(hit.data.failed ? 60000 : TTL)) return hit.data;
  const query=isbn ? `isbn=${cql(isbn)}` : `title=${cql(book.title)} AND creator=${cql(book.author)}`;
  const params=new URLSearchParams({operation:'searchRetrieve',version:'1.2',recordSchema:'dcndl',recordPacking:'xml',onlyBib:'true',maximumRecords:'8',query});
  // NDL と openBD を同時に聞き、あらすじのある方を使う。刊行日は細かい方（日付まで分かる方）を使う
  const publish=data=>{
    memory.set(key,{at:Date.now(),data});
    if(data.synopsis)try{localStorage.setItem(key,JSON.stringify({at:Date.now(),data}));}catch{}
    listeners.forEach(fn=>fn(key));
  };
  const early=data=>{if(data?.synopsis)publish(data);return data;};
  const [ndl,openBd]=await Promise.allSettled([
    read('https://ndlsearch.ndl.go.jp/api/sru?'+params,signal,'xml',{attempts:background?2:3,wait:background?3000:4000}).then(x=>early(parseNdlDetails(x,book))),
    isbn ? read('https://api.openbd.jp/v1/get?isbn='+isbn,signal,'json',{attempts:2}).then(x=>early(parseOpenBdDetails(x,isbn))) : Promise.resolve(null),
  ]);
  if (signal?.aborted) throw new DOMException('Aborted','AbortError');
  const found=[ndl,openBd].map(r=>r.status==='fulfilled' ? r.value : null);
  const failed=[ndl,openBd].some(r=>r.status==='rejected');
  const base=found.find(r=>r?.synopsis) || found.find(Boolean);
  const result=base && {...base,publishedAt:found.map(r=>r?.publishedAt || '').sort((a,b)=>b.length-a.length)[0]};
  const data=result?.synopsis ? result : (hit?.data.synopsis ? hit.data : result || {synopsis:'',publishedAt:'',source:'',sourceUrl:''});
  data.failed=failed && !data.synopsis;
  if (!data.failed) {
    try {const keys=Object.keys(localStorage).filter(k=>k.startsWith(PREFIX));if(keys.length>=400)keys.slice(0,40).forEach(k=>localStorage.removeItem(k));localStorage.setItem(key,JSON.stringify({at:Date.now(),data}));} catch {}
  }
  memory.set(key,{at:Date.now(),data});
  listeners.forEach(fn=>fn(key));
  return data;
}

const memory=new Map(),pending=new Map(),jobs=[],listeners=new Set();
let working=0,dispatching=false,lastRequest=0;
export const bookDetailsKey=book=>PREFIX+(coverIsbn(book.isbn) || `${normTitle(book.title)}|${normName(book.author)}`);
function cached(book) {
  const key=bookDetailsKey(book);
  if (memory.has(key)) return memory.get(key);
  try {const hit=JSON.parse(localStorage.getItem(key) || 'null');if(hit?.data && typeof hit.data.synopsis==='string'){
    if(hit.data.synopsis && !looksLikeSynopsis(hit.data.synopsis))hit.data.synopsis=''; // 前の版で覚えた叢書の注記は出さない
    memory.set(key,hit);return hit;}} catch {}
  return null;
}
export const peekBookDetails=book=>cached(book)?.data || null;
export const subscribeBookDetails=fn=>(listeners.add(fn),()=>listeners.delete(fn));
async function drain() {
  if(dispatching)return;dispatching=true;
  while(jobs.length && working<2) {
    const wait=lastRequest+1000-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
    jobs.sort((a,b)=>b.priority-a.priority);
    const job=jobs.shift();working++;lastRequest=Date.now();
    fetchBookDetails(job.book,{background:job.priority===0}).then(job.resolve,job.reject).finally(()=>{
      working--;pending.delete(job.key);drain();
    });
  }
  dispatching=false;
}
export function loadBookDetails(book,{signal,background=false}={}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted','AbortError'));
  const hit=cached(book);
  const cooldown=hit?.data.failed ? 60000 : TTL;
  if (hit && Date.now()-hit.at<cooldown) return Promise.resolve(hit.data);
  const key=bookDetailsKey(book);
  let job=pending.get(key);
  if (!job) {
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    job={key,book:{isbn:book.isbn || '',title:book.title || '',author:book.author || ''},priority:background?0:2,promise,resolve,reject};
    pending.set(key,job);jobs.push(job);drain();
  } else if (!background) job.priority=2;
  if (!signal) return job.promise;
  // 詳細を閉じても先読みは続け、閉じた画面への描画だけを取り消す。
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Aborted','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    job.promise.then(data=>{if(signal.aborted)abort();else resolve(data);},reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function prefetchBookDetails(books) {
  for (const book of books) if (book?.title) loadBookDetails(book,{background:true}).catch(()=>{});
}
