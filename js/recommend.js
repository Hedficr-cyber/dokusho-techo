// 本棚の傾向から「おすすめ」を作る（検索タブで、検索する前に表示する）。
// 1) 本棚によく出てくる作家の、まだ本棚にない作品
// 2) 本棚に多いジャンルの、まだ本棚にいない作家（genres.js の代表作家）の作品
// 国会図書館へは作家 1 人につき 1 回だけ問い合わせる。結果は ndl.js が 7 日間保存するので 2 回目からはすぐ出る。
import { GENRE_BY_ID } from './genres.js';
import { normName, normTitle } from './util.js';

// 作家ごとの本棚の書名（正規化済み）。looksOwned で使う
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

// 日ごと・「別のおすすめ」ごとに、選ぶ作家を少しずつ入れ替える
function rotate(list, n, shift) {
  if (list.length <= n) return list;
  const start = ((shift % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)].slice(0, n);
}

// どの作家を調べるかの計画。よく読む作家は上位 2 人を固定し、3〜12 位から 2 人を入れ替え。
// 好きなジャンルの順に、まだ本棚にいない作家を合わせて 3 人（最初に見つかったジャンルから 2 人）。
// 本棚がそのジャンルの代表作家で埋まっていれば、次のジャンルへ進む。
export function recommendPlan(books, shift = 0) {
  const { authors, genres } = tasteProfile(books);
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

// 本棚にある同じ作家の本と、書名が 5 文字以上連続で重なる作品は「持っている本の別訳・別題」とみなす
// （例：「オリエント急行の殺人」と「オリエント急行殺人事件」）
function looksOwned(w, author, shelfTitles) {
  const mine = shelfTitles.get(normName(author)) || [];
  const t = normTitle(w.main);
  return mine.some((s) => commonRun(s, t) >= 5); // 「N」「Q」のような短い書名は対象外（完全一致は owned で判定済み）
}

// 調べた作品から、本棚にない本を作家ごとに新しい順で数冊選び、作家を交互に並べる
export function pickRecommendations(results, { owned, hidden, shelfTitles = new Map(), limit = 20 }) {
  const seen = new Set();
  const perJob = results.filter(Boolean).map(({ job, works }) => {
    const litShare = works.length ? works.filter((w) => w.isLit).length / works.length : 0;
    const list = works
      .filter((w) => !w.isComic && !w.isAnthology && (litShare < 0.6 || w.isLit) && !owned(w) && !hidden.has(w.key)
        && !looksOwned(w, job.name, shelfTitles))
      .sort((a, b) => b.firstYear - a.firstYear)
      .slice(0, job.kind === 'shelf' ? 3 : 2);
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
