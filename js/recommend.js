// 本棚の傾向から「おすすめ」を作る（検索タブで、検索する前に表示する）。
// 1) 本棚によく出てくる著者の、まだ本棚にない作品
// 2) 本棚に多いジャンルの、まだ本棚にいない著者（genres.js の代表著者）の作品
// 国会図書館へは著者 1 人につき 1 回だけ問い合わせる。結果は ndl.js が 7 日間保存するので 2 回目からはすぐ出る。
import { GENRE_BY_ID, GENRE_GROUP_BY_ID } from './genres.js';
import { normName, normTitle } from './util.js';

// 著者ごとの本棚の書名（正規化済み）。looksOwned で使う
export function shelfTitleMap(books) {
  const m = new Map();
  for (const b of books) {
    const k = normName(b.author);
    m.set(k, [...(m.get(k) || []), normTitle(b.title)]);
  }
  return m;
}

// 1 冊の重み：読了して評価が高いほど強く、読みたい本は気になり度で少しずつ
export function bookWeight(b) {
  if (b.status === 'done') return 2 + (Number(b.rating) || 0) * 0.6;
  if (b.status === 'reading') return 2.5;
  return { 3: 1.6, 2: 1, 1: 0.6 }[b.priority] ?? 1;
}

export function tasteProfile(books) {
  const authors = new Map();
  const genres = new Map();
  for (const b of books) {
    const w = bookWeight(b);
    if (b.author && !/ほか|編集部/.test(b.author)) authors.set(b.author, (authors.get(b.author) || 0) + w);
    for (const g of b.genres || []) if (GENRE_BY_ID[g]) genres.set(g, (genres.get(g) || 0) + w);
  }
  const byWeight = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { authors: byWeight(authors), genres: byWeight(genres) };
}

// 日ごと・「別のおすすめ」ごとに、選ぶ著者を少しずつ入れ替える
function rotate(list, n, shift) {
  if (list.length <= n) return list;
  const start = ((shift % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)].slice(0, n);
}

// どの著者を調べるかの計画。よく読む著者は上位 2 人を固定し、3〜12 位から 2 人を入れ替え。
// 好きなジャンルの順に、まだ本棚にいない著者を合わせて 3 人（最初に見つかったジャンルから 2 人）。
// 本棚がそのジャンルの代表著者で埋まっていれば、次のジャンルへ進む。
export function recommendPlan(books, shift = 0, preferences = []) {
  const { authors, genres } = tasteProfile(books);
  const selected=preferences.filter(id=>GENRE_GROUP_BY_ID[id]);
  if (!authors.length && !genres.length) {
    const groups=selected.length ? selected : ['mystery','fiction','horror'];
    const defaults={money:['山崎元','橘玲','竹川美奈子','水瀬ケンイチ'],business:['山口周','安宅和人','樺沢紫苑'],nonfic:['沢木耕太郎','柳田邦男','門田隆将']};
    const jobs=[];
    for (const [i,id] of groups.entries()) {
      const g=GENRE_GROUP_BY_ID[id];
      const names=[...new Set(g.children.flatMap(child=>GENRE_BY_ID[child]?.authors || defaults[child] || []))];
      rotate(names,groups.length===1 ? 4 : 2,shift+i).forEach(name=>jobs.push({name,kind:'genre',reason:`${g.name}が好きなあなたに`}));
    }
    return {jobs:jobs.slice(0,8),taste:groups.map(id=>GENRE_GROUP_BY_ID[id].name),fromPreferences:true};
  }
  const onShelf = new Set(books.map((b) => normName(b.author)));
  const favorites = [...authors.slice(0, 2), ...rotate(authors.slice(2, 12), 2, shift)];
  const jobs = favorites.map(([name]) => ({ name, kind: 'shelf', reason: `${name}をよく読んでいるから` }));
  const genresWithAuthors = genres.filter(([id]) => GENRE_BY_ID[id].authors?.length);
  let need = 3;
  for (const [i, [id]] of genresWithAuthors.entries()) {
    if (need <= 0) break;
    const g = GENRE_BY_ID[id];
    const fresh = g.authors.filter((a) => !onShelf.has(normName(a)) && !jobs.some((j) => j.name === a));
    const picked = rotate(fresh, Math.min(need === 3 ? 2 : 1, need), shift + i);
    picked.forEach((name) => jobs.push({ name, kind: 'genre', reason: `${g.name}が多いあなたに` }));
    need -= picked.length;
  }
  return {
    jobs,
    taste: [...authors.slice(0, 3).map(([n]) => n), ...genresWithAuthors.slice(0, 2).map(([id]) => GENRE_BY_ID[id].name)],
  };
}

// いちばん長く連続して共通する文字数（書名の言い換え・別訳の判定用）
function commonRun(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = keep;
    }
  }
  return best;
}

// 本棚にある同じ著者の本と、書名が 5 文字以上連続で重なる作品は「持っている本の別訳・別題」とみなす
// （例：「オリエント急行の殺人」と「オリエント急行殺人事件」）
function looksOwned(w, author, shelfTitles) {
  const mine = shelfTitles.get(normName(author)) || [];
  const t = normTitle(w.main);
  return mine.some((s) => commonRun(s, t) >= 5); // 「N」「Q」のような短い書名は対象外（完全一致は owned で判定済み）
}

// 調べた作品から、本棚にない本を著者ごとに新しい順で数冊選び、著者を交互に並べる
export function pickRecommendations(results, { owned, hidden, shelfTitles = new Map(), limit = 20, shift = 0 }) {
  const seen = new Set();
  const perJob = results.filter(Boolean).map(({ job, works }) => {
    const litShare = works.length ? works.filter((w) => w.isLit).length / works.length : 0;
    const eligible = works
      .filter((w) => !w.isComic && !w.isAnthology && (litShare < 0.6 || w.isLit) && !owned(w) && !hidden.has(w.key)
        && !looksOwned(w, job.name, shelfTitles))
      .sort((a, b) => b.firstYear - a.firstYear);
    const list=rotate(eligible,job.kind==='shelf' ? 3 : 2,shift);
    return { job, list };
  });
  const out = [];
  for (let round = 0; out.length < limit && perJob.some((p) => p.list[round]); round++) {
    for (const p of perJob) {
      const w = p.list[round];
      if (!w || seen.has(w.key) || out.length >= limit) continue;
      seen.add(w.key);
      out.push({ w, reason: p.job.reason });
    }
  }
  return out;
}
