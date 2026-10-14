// 図鑑のトロフィー（v0.16 本人：読了数・作家・シリーズ制覇などの実績を集める楽しみ）
// 読了の本と図鑑のシリーズから毎回計算するだけで、保存も同期もしない。達成した日は読了日から求める
import { normName } from './util.js';
import { primaryGenre } from './shelf.js';

export const TROPHY_GROUPS = [['read', '読んだ冊数'], ['author', '作家とジャンル'], ['series', 'シリーズ'], ['pace', 'ペース'], ['keep', '続ける']];
// metric：数える物差し。goal：達成に要る数。unit：「あと 3 冊」の単位。hint：条件の説明
const T = (id, group, tier, name, metric, goal, unit, hint) => ({ id, group, tier, name, metric, goal, unit, hint });
export const TROPHIES = [
  T('read-1', 'read', 'bronze', 'はじめの1冊', 'read', 1, '冊', '最初の1冊を読了'),
  T('read-10', 'read', 'bronze', '10冊読了', 'read', 10, '冊', ''),
  T('read-30', 'read', 'silver', '30冊読了', 'read', 30, '冊', ''),
  T('read-50', 'read', 'silver', '50冊読了', 'read', 50, '冊', ''),
  T('read-100', 'read', 'gold', '100冊読了', 'read', 100, '冊', ''),
  T('read-200', 'read', 'gold', '200冊読了', 'read', 200, '冊', ''),
  T('read-300', 'read', 'platinum', '300冊読了', 'read', 300, '冊', ''),
  T('author-5', 'author', 'bronze', '作家5人', 'author', 5, '人', '5人の作家の本を読了'),
  T('author-10', 'author', 'silver', '作家10人', 'author', 10, '人', '10人の作家の本を読了'),
  T('author-30', 'author', 'gold', '作家30人', 'author', 30, '人', '30人の作家の本を読了'),
  T('author-50', 'author', 'platinum', '作家50人', 'author', 50, '人', '50人の作家の本を読了'),
  T('fan-5', 'author', 'bronze', '推し作家', 'fan', 5, '冊', '同じ作家の本を5冊'),
  T('fan-10', 'author', 'silver', '大ファン', 'fan', 10, '冊', '同じ作家の本を10冊'),
  T('fan-20', 'author', 'gold', '作家マスター', 'fan', 20, '冊', '同じ作家の本を20冊'),
  T('genre-5', 'author', 'silver', '雑食家', 'genre', 5, 'ジャンル', '5つのジャンルの本を読了'),
  T('start-5', 'series', 'bronze', 'シリーズ5つ', 'start', 5, 'シリーズ', '5つのシリーズを読み始める'),
  T('start-10', 'series', 'silver', 'シリーズ10個', 'start', 10, 'シリーズ', '10のシリーズを読み始める'),
  T('complete-1', 'series', 'silver', 'シリーズ制覇', 'complete', 1, 'シリーズ', 'シリーズを全巻読了'),
  T('complete-3', 'series', 'gold', '3シリーズ制覇', 'complete', 3, 'シリーズ', '3つのシリーズを全巻読了'),
  T('complete-10', 'series', 'platinum', '10シリーズ制覇', 'complete', 10, 'シリーズ', '10のシリーズを全巻読了'),
  T('month-5', 'pace', 'bronze', '1か月で5冊', 'month', 5, '冊', '同じ月に5冊を読了'),
  T('month-10', 'pace', 'silver', '1か月で10冊', 'month', 10, '冊', '同じ月に10冊を読了'),
  T('year-30', 'pace', 'silver', '1年で30冊', 'year', 30, '冊', '同じ年に30冊を読了'),
  T('year-50', 'pace', 'gold', '1年で50冊', 'year', 50, '冊', '同じ年に50冊を読了'),
  T('streak-3', 'keep', 'bronze', '3か月連続', 'streak', 3, 'か月', '3か月続けて、毎月1冊以上を読了'),
  T('streak-6', 'keep', 'silver', '半年連続', 'streak', 6, 'か月', '6か月続けて、毎月1冊以上を読了'),
  T('streak-12', 'keep', 'gold', '1年連続', 'streak', 12, 'か月', '12か月続けて、毎月1冊以上を読了'),
  T('years-5', 'keep', 'silver', '読書歴5年', 'years', 5, '年', '最初の読了から5年'),
  T('years-10', 'keep', 'gold', '読書歴10年', 'years', 10, '年', '最初の読了から10年'),
];

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const addYears = (day, n) => `${Number(day.slice(0, 4)) + n}${day.slice(4)}`;

// シリーズを全巻読み終えたか（図鑑の「コンプリート」と同じ。巻数のシリーズは国会図書館で巻を確かめたものだけ）
export const isComplete = (d) => !d.others && d.total >= 2 && d.done === d.total && (d.named || d.checked);

// books：本棚の本（読了の本だけ数える）。series：図鑑のシリーズ（describeSeries の結果。単発作品は除く）
// → TROPHIES のそれぞれに { value：いまの数, earned, at：達成した日（読了日のない本で達成したときは ''） }
export function trophyProgress(books, series = []) {
  const done = books.filter((b) => b.status === 'done');
  const order = [...done.filter((b) => isDay(b.finishedAt)).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)), ...done.filter((b) => !isDay(b.finishedAt))];
  // 物差しごとに、本を読了の順に 1 冊ずつ足していったときの数の移り変わり（[数, 日]）
  const steps = { read: [], author: [], fan: [], genre: [], month: [], year: [], streak: [], years: [] };
  const authors = new Map();
  const genres = new Set();
  const months = new Map();
  const years = new Map();
  let maxFan = 0, maxMonth = 0, maxYear = 0, run = 0, maxRun = 0, lastMonth = '', first = '', span = 0;
  order.forEach((b, i) => {
    const at = isDay(b.finishedAt) ? b.finishedAt : '';
    const a = normName(b.author || '');
    if (a) { authors.set(a, (authors.get(a) || 0) + 1); maxFan = Math.max(maxFan, authors.get(a)); }
    const g = primaryGenre(b).id;
    if (g !== 'unclassified') genres.add(g);
    if (at) {
      const m = at.slice(0, 7);
      months.set(m, (months.get(m) || 0) + 1); maxMonth = Math.max(maxMonth, months.get(m));
      years.set(m.slice(0, 4), (years.get(m.slice(0, 4)) || 0) + 1); maxYear = Math.max(maxYear, years.get(m.slice(0, 4)));
      if (m !== lastMonth) { run = lastMonth && nextMonth(lastMonth) === m ? run + 1 : 1; lastMonth = m; maxRun = Math.max(maxRun, run); }
      first ||= at;
      while (addYears(first, span + 1) <= at) span += 1;
    }
    steps.read.push([i + 1, at]); steps.author.push([authors.size, at]); steps.fan.push([maxFan, at]); steps.genre.push([genres.size, at]);
    steps.month.push([maxMonth, at]); steps.year.push([maxYear, at]); steps.streak.push([maxRun, at]); steps.years.push([span, at]);
  });
  // シリーズ：読み始めた日（最初の読了）と、全巻を読み終えた日（最後の読了）
  const dates = (d) => d.vols.filter((v) => v.book?.status === 'done').map((v) => (isDay(v.book.finishedAt) ? v.book.finishedAt : '')).sort();
  const started = series.filter((d) => !d.others && d.done > 0).map((d) => dates(d).find(Boolean) || '').sort((x, y) => (x || '9999').localeCompare(y || '9999'));
  const completed = series.filter(isComplete).map((d) => (dates(d).includes('') ? '' : dates(d).at(-1) || '')).sort((x, y) => (x || '9999').localeCompare(y || '9999'));
  steps.start = started.map((at, i) => [i + 1, at]);
  steps.complete = completed.map((at, i) => [i + 1, at]);
  return TROPHIES.map((t) => {
    const list = steps[t.metric];
    const value = list.length ? list[list.length - 1][0] : 0;
    const hit = list.find(([v]) => v >= t.goal);
    return { ...t, value, earned: !!hit, at: hit ? hit[1] : '' };
  });
}
