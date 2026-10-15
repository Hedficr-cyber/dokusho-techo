// 図鑑のトロフィー（v0.16 本人：読了数・作家・シリーズ制覇などの実績を集める楽しみ）
// v0.17 本人：同じ系統（10冊・30冊…）は 1 つに重ね、タップで達成した日を見る。重ねた分トロフィーを増やす。
//   レア度はブロンズ〜ゴールドだけでなく、プラチナ・ダイヤ・レジェンド（虹色のキラキラ）まで 6 段階
// 読了の本と図鑑のシリーズから毎回計算するだけで、保存も同期もしない。達成した日は読了日から求める
import { normName } from './util.js';
import { primaryGenre } from './shelf.js';

export const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'legend'];
export const TIER_NAME = { bronze: 'ブロンズ', silver: 'シルバー', gold: 'ゴールド', platinum: 'プラチナ', diamond: 'ダイヤ', legend: 'レジェンド' };
export const TROPHY_GROUPS = [['read', '読書量'], ['author', '作家とジャンル'], ['series', 'シリーズ'], ['keep', '続ける'], ['note', '記録'], ['fun', 'ちょっと変わった']];

const B = 'bronze', S = 'silver', G = 'gold', P = 'platinum', D = 'diamond', L = 'legend';
// 系統：name（系統の名前）・metric（物差し）・unit（「あと 3 冊」の単位）・about（条件の説明）・levels（[達成に要る数, レア度, 名前]）
// 名前を省いた段は title(数) で付ける。id は「系統-数」（v0.16 の read-10 などと同じ）
const F = (id, group, name, metric, unit, about, title, levels) => ({ id, group, name, metric, unit, about, levels: levels.map(([goal, tier, n]) => ({ goal, tier, name: n || title(goal) })) });
export const FAMILIES = [
  F('read', 'read', '読んだ冊数', 'read', '冊', (g) => `${g}冊を読了`, (g) => `${g}冊読了`,
    [[1, B, 'はじめの1冊'], [10, B], [30, S], [50, S], [100, G], [200, P], [300, D], [500, L]]),
  F('year', 'read', '1年の冊数', 'year', '冊', (g) => `同じ年に${g}冊を読了`, (g) => `1年で${g}冊`,
    [[12, B, '月1冊ペース'], [30, S], [50, G], [100, P], [150, L]]),
  F('month', 'read', '1か月の冊数', 'month', '冊', (g) => `同じ月に${g}冊を読了`, (g) => `1か月で${g}冊`,
    [[5, B], [10, S], [15, G], [20, P], [30, L]]),
  F('author', 'author', '作家の数', 'author', '人', (g) => `${g}人の作家の本を読了`, (g) => `作家${g}人`,
    [[5, B], [10, S], [30, G], [50, P], [100, D]]),
  F('fan', 'author', '推し作家', 'fan', '冊', (g) => `同じ作家の本を${g}冊`, (g) => `同じ作家を${g}冊`,
    [[5, B, '推し作家'], [10, S, '大ファン'], [20, G, '作家マスター'], [30, P, '全作読破の勢い'], [50, L, '生涯の作家']]),
  F('regular', 'author', '常連の作家', 'regular', '人', (g) => `3冊以上読んだ作家が${g}人`, (g) => `常連の作家${g}人`,
    [[3, B], [5, S], [10, G], [20, P]]),
  F('genre', 'author', 'ジャンルの数', 'genre', 'ジャンル', (g) => `${g}つのジャンルの本を読了`, (g) => `${g}ジャンル`,
    [[3, B], [5, S, '雑食家'], [8, G], [12, L, '全ジャンル制覇']]),
  F('favgenre', 'author', '得意ジャンル', 'favgenre', '冊', (g) => `同じジャンルの本を${g}冊`, (g) => `同じジャンルを${g}冊`,
    [[10, B], [30, S], [50, G], [100, P], [200, D]]),
  F('publisher', 'author', '出版社めぐり', 'publisher', '社', (g) => `${g}社の本を読了`, (g) => `出版社${g}社`,
    [[5, B], [10, S], [20, G], [30, P]]),
  F('start', 'series', '読み始めたシリーズ', 'start', 'シリーズ', (g) => `${g}のシリーズを読み始める`, (g) => `シリーズ${g}個`,
    [[3, B], [5, S], [10, G], [20, P], [30, D]]),
  F('complete', 'series', 'シリーズ制覇', 'complete', 'シリーズ', (g) => `${g}つのシリーズを全巻読了`, (g) => `${g}シリーズ制覇`,
    [[1, S, 'シリーズ制覇'], [3, G], [5, P], [10, D], [20, L]]),
  F('binge', 'series', '一気読み', 'binge', '冊', (g) => `同じシリーズを同じ月に${g}冊`, (g) => `一気読み${g}冊`,
    [[3, S], [5, G], [10, P]]),
  F('streak', 'keep', '続けて読んだ月', 'streak', 'か月', (g) => `${g}か月続けて、毎月1冊以上を読了`, (g) => `${g}か月連続`,
    [[3, B], [6, S, '半年連続'], [12, G, '1年連続'], [24, P, '2年連続'], [36, D, '3年連続'], [60, L, '5年連続']]),
  F('years', 'keep', '読書歴', 'years', '年', (g) => `最初の読了から${g}年`, (g) => `読書歴${g}年`,
    [[1, B], [3, S], [5, G], [10, P], [20, L]]),
  F('rating5', 'note', '★5の本', 'rating5', '冊', (g) => `★5をつけた本が${g}冊`, (g) => `★5を${g}冊`,
    [[1, B, '心の1冊'], [5, S], [10, G], [30, P]]),
  F('memo', 'note', '感想を書いた本', 'memo', '冊', (g) => `メモを書いた読了の本が${g}冊`, (g) => `感想${g}冊`,
    [[1, B, 'はじめての感想'], [10, S], [30, G], [100, P]]),
  F('fresh', 'fun', '発売すぐ読了', 'fresh', '冊', (g) => `発売から1か月以内に読了した本が${g}冊`, (g) => `発売すぐ${g}冊`,
    [[1, B], [5, S], [10, G], [30, P]]),
  F('classic', 'fun', '時代を超えて', 'classic', '冊', (g) => `刊行から30年以上たった本を${g}冊`, (g) => `名作${g}冊`,
    [[1, B], [5, S], [10, G]]),
  F('newyear', 'fun', 'お正月読書', 'newyear', '冊', (g) => `1月1日〜3日に${g}冊を読了`, (g) => `お正月に${g}冊`,
    [[1, S, '読み初め'], [5, G]]),
];
// 1 段ずつのトロフィー（獲得の知らせ・NEW はこの id で覚える）
export const TROPHIES = FAMILIES.flatMap((f) => f.levels.map((l, i) => ({
  id: `${f.id}-${l.goal}`, family: f.id, level: i + 1, levels: f.levels.length, group: f.group, tier: l.tier, name: l.name,
  metric: f.metric, goal: l.goal, unit: f.unit, hint: f.about(l.goal),
})));

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const addYears = (day, n) => `${Number(day.slice(0, 4)) + n}${day.slice(4)}`;
const pubDay = (b) => (isDay(b.publishedAt) ? b.publishedAt : '');
const pubYear = (b) => Number(String(b.publishedAt || '').slice(0, 4)) || Number(b.year) || 0;
const plus30 = (day) => { const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 30); return t.toISOString().slice(0, 10); };

// シリーズを全巻読み終えたか（図鑑の「コンプリート」と同じ。巻数のシリーズは国会図書館で巻を確かめたものだけ）
export const isComplete = (d) => !d.others && d.total >= 2 && d.done === d.total && (d.named || d.checked);

// books：本棚の本（読了の本だけ数える）。series：図鑑のシリーズ（describeSeries の結果。単発作品は除く）
// → TROPHIES のそれぞれに { value：いまの数, earned, at：達成した日（読了日のない本で達成したときは ''） }
export function trophyProgress(books, series = []) {
  const done = books.filter((b) => b.status === 'done');
  const order = [...done.filter((b) => isDay(b.finishedAt)).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)), ...done.filter((b) => !isDay(b.finishedAt))];
  // 本の id → その本のシリーズ（一気読みを数える）
  const seriesOf = new Map();
  for (const d of series) if (!d.others) for (const v of d.vols) if (v.book?.status === 'done') seriesOf.set(v.book.id, d.key);
  // 物差しごとに、本を読了の順に 1 冊ずつ足していったときの数の移り変わり（[数, 日]）
  const keys = ['read', 'author', 'fan', 'regular', 'genre', 'favgenre', 'publisher', 'month', 'year', 'streak', 'years', 'binge', 'rating5', 'memo', 'fresh', 'classic', 'newyear'];
  const steps = Object.fromEntries(keys.map((k) => [k, []]));
  const count = new Map(); // 物差しの数え（著者・ジャンル・出版社・月・年・シリーズの月）
  const bump = (k) => { count.set(k, (count.get(k) || 0) + 1); return count.get(k); };
  const v = { read: 0, author: 0, fan: 0, regular: 0, genre: 0, favgenre: 0, publisher: 0, month: 0, year: 0, streak: 0, years: 0, binge: 0, rating5: 0, memo: 0, fresh: 0, classic: 0, newyear: 0 };
  let run = 0, lastMonth = '', first = '';
  for (const b of order) {
    const at = isDay(b.finishedAt) ? b.finishedAt : '';
    v.read += 1;
    const a = normName(b.author || '');
    if (a) { const n = bump(`a:${a}`); if (n === 1) v.author += 1; if (n === 3) v.regular += 1; v.fan = Math.max(v.fan, n); }
    const g = primaryGenre(b).id;
    if (g !== 'unclassified') { const n = bump(`g:${g}`); if (n === 1) v.genre += 1; v.favgenre = Math.max(v.favgenre, n); }
    const pub = String(b.publisher || '').normalize('NFKC').replace(/\s+/g, '').replace(/^株式会社|株式会社$/g, '');
    if (pub && bump(`p:${pub}`) === 1) v.publisher += 1;
    if (b.rating === 5) v.rating5 += 1;
    if (String(b.memo || '').trim()) v.memo += 1;
    if (at) {
      const m = at.slice(0, 7);
      v.month = Math.max(v.month, bump(`m:${m}`));
      v.year = Math.max(v.year, bump(`y:${m.slice(0, 4)}`));
      if (m !== lastMonth) { run = lastMonth && nextMonth(lastMonth) === m ? run + 1 : 1; lastMonth = m; v.streak = Math.max(v.streak, run); }
      first ||= at;
      while (addYears(first, v.years + 1) <= at) v.years += 1;
      const s = seriesOf.get(b.id);
      if (s) v.binge = Math.max(v.binge, bump(`s:${s}:${m}`));
      if (pubDay(b) && pubDay(b) <= at && at <= plus30(pubDay(b))) v.fresh += 1;
      if (pubYear(b) && Number(at.slice(0, 4)) - pubYear(b) >= 30) v.classic += 1;
      if (/-01-0[123]$/.test(at)) v.newyear += 1;
    }
    for (const k of keys) steps[k].push([v[k], at]);
  }
  // シリーズ：読み始めた日（最初の読了）と、全巻を読み終えた日（最後の読了）
  const dates = (d) => d.vols.filter((x) => x.book?.status === 'done').map((x) => (isDay(x.book.finishedAt) ? x.book.finishedAt : '')).sort();
  const byDate = (x, y) => (x || '9999').localeCompare(y || '9999');
  steps.start = series.filter((d) => !d.others && d.done > 0).map((d) => dates(d).find(Boolean) || '').sort(byDate).map((at, i) => [i + 1, at]);
  steps.complete = series.filter(isComplete).map((d) => (dates(d).includes('') ? '' : dates(d).at(-1) || '')).sort(byDate).map((at, i) => [i + 1, at]);
  return TROPHIES.map((t) => {
    const list = steps[t.metric];
    const value = list.length ? list[list.length - 1][0] : 0;
    const hit = list.find(([n]) => n >= t.goal);
    return { ...t, value, earned: !!hit, at: hit ? hit[1] : '' };
  });
}

// 系統ごとにまとめる：いちばん上の獲得段（top）と次の段（next）
export function trophyFamilies(list) {
  return FAMILIES.map((f) => {
    const levels = list.filter((t) => t.family === f.id);
    const got = levels.filter((t) => t.earned);
    return { ...f, levels, got: got.length, top: got.at(-1) || null, next: levels.find((t) => !t.earned) || null };
  });
}
