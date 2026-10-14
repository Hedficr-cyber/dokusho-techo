// 文字列の正規化・表示用の小道具。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const EDITION_WORDS = /(新装改訂版|改訂完全版|新装版|完全版|決定版|改訂新版|改訂版|新版|文庫版|愛蔵版|\d{4}年版)/g;

// 「噓」「嘘」のような新旧の字形を同じ字として扱う
const VARIANTS = { '噓': '嘘', '𠮟': '叱', '剝': '剥', '頰': '頬', '塡': '填', '蔣': '蒋', '醬': '醤', '焰': '焔', '蟬': '蝉', '鷗': '鴎', '摑': '掴', '繫': '繋', '惡': '悪' };
const unifyVariants = (s) => s.replace(/[噓𠮟剝頰塡蔣醬焰蟬鷗摑繫惡]/gu, (c) => VARIANTS[c]);

// 書名の比較用キー。全角英数を半角に、記号と空白を除き、版の表記を外す。
export function normTitle(s) {
  return unifyVariants(String(s ?? '')
    .normalize('NFKC'))
    .replace(/\s=\s.*$/, '')
    .replace(EDITION_WORDS, '')
    .replace(/[(（][぀-ヿー・\s]+[)）]/g, '') // 国立国会図書館の読みがな「生命(いのち)の略奪者」「黒猫の小夜曲(セレナーデ)」
    .replace(/[\s・,，、.。:：;；!！?？'"“”「」『』《》〈〉()（）\[\]【】~～\-‐－―ー=＝/／&＆×]/g, '')
    .toLowerCase();
}

// 副題を除いた書名（「A : B」の A）
export function mainTitle(s) {
  return String(s ?? '').replace(/\s=\s.*$/, '').split(/\s:\s/)[0].trim();
}

export function normName(s) {
  return unifyVariants(String(s ?? '').normalize('NFKC')).replace(/[\s・,，.、=＝/／]/g, '').toLowerCase();
}

// 責任表示「Jackson, Holly, 1992-,服部, 京子,ホリー・ジャクソン 著,服部京子 訳」から著者名（著・作）を取り出す
export function respAuthor(resp) {
  const m = String(resp ?? '').split(',').map((p) => p.trim())
    .map((p) => p.match(/^(.+?)\s*(著|作|文|著者|原作)$/)).find(Boolean);
  return m ? m[1].split(/[、，]/)[0].trim() : '';
}

// NDL の著者表記「今村, 昌弘, 1985-」「クリスティー, アガサ, 1890-1976」、近刊情報の「今村／昌弘」を読みやすく直す
export function cleanCreator(raw) {
  const s = String(raw ?? '');
  const parts = (s.includes('／') && !s.includes(',') ? s.split('／') : s.split(/,\s*/)).map((p) => p.trim()).filter((p) => p && !/^\d{3,4}-?\d{0,4}$/.test(p) && !/^[\d-]+$/.test(p));
  if (parts.length < 2) return (parts[0] || '').trim();
  const [family, given] = parts;
  if (/^[\u30A0-\u30FF・=＝\s]+$/.test(family)) return `${given}・${family}`;
  if (/^[A-Za-z.\s-]+$/.test(family + given)) return `${given} ${family}`;
  return `${family}${given}`;
}

// 名前の部分（2文字以上）に分ける。「M・W・クレイヴン」→「クレイヴン」、「ホリー・ジャクソン」→「ホリー」「ジャクソン」
export function nameParts(s) {
  return String(s ?? '').normalize('NFKC').split(/[・\s,，.=＝]+/).map(normName).filter((t) => t.length >= 2);
}

export function authorMatches(creatorRaw, query) {
  const q = normName(query);
  if (!q) return false;
  const c = normName(cleanCreator(creatorRaw));
  const r = normName(creatorRaw);
  if (q.length <= 2) return c === q; // 「梨」「背筋」など短い名前は部分一致だと別人を拾う
  if (c === q || r.includes(q) || c.includes(q)) return true;
  // 海外作家は NDL 側が「姓, 名」の順なので、部分ごとに含まれているかで判定する
  const parts = nameParts(query);
  const splittable = parts.length > 1 || (parts.length === 1 && parts[0] !== q);
  return splittable && parts.every((t) => r.includes(t));
}

export function year(s) {
  const m = String(s ?? '').match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

export function formatFromExtent(extent) {
  const m = String(extent ?? '').match(/(\d+)\s*cm/);
  if (!m) return '';
  const cm = Number(m[1]);
  if (cm <= 16) return '文庫';
  if (cm <= 18) return '新書';
  return '単行本';
}

// NDL の OpenSearch には判型（cm）が無いことが多いので、叢書名から推定する
export function formatFromSeries(series) {
  const s = String(series ?? '');
  if (/文庫|タイガ|nex|ノベルズ文庫/i.test(s)) return '文庫';
  if (/新書|ノベルス/.test(s)) return '新書';
  return '';
}

// 刊行年月を「2026-10」の形にそろえる（dc:date「2026-10」、issued「2026.10」「2026年10月」など）
// dc:date が「2023」、issued が「2023.12」のように片方だけ月があるときは、月まで分かる方を使う
export function pubMonth(...candidates) {
  let yearOnly = '';
  for (const c of candidates) {
    const m = String(c ?? '').normalize('NFKC').match(/(\d{4})\D{0,2}(\d{1,2})?/);
    if (!m) continue;
    if (m[2] && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
    yearOnly ||= m[1];
  }
  return yearOnly;
}

// 新刊として扱ってよい記録：ISBN がある本か、国会図書館の所蔵（R100000002）・出版社の近刊情報（R100000137）。
// サピエ図書館の点字・音声データなど ISBN のない別の形の記録は、古い本でも作成月が新しいので新刊にしない
export const isPrintRecord = (r) => !!r?.isbn || !r?.link || /\/books\/R100000(?:002|137)-/.test(r.link);

// 「2026-10」→「2026年10月」
export const monthLabel = (ym) => (ym ? ym.replace(/^(\d{4})-0?(\d{1,2})$/, '$1年$2月').replace(/^(\d{4})$/, '$1年') : '');

// ISBN-13（978/979 始まり・検査数字が正しいもの）だけを返す
export function isbn13(text) {
  const d = String(text ?? '').replace(/[^\d]/g, '');
  if (!/^97[89]\d{10}$/.test(d)) return '';
  const sum = [...d.slice(0, 12)].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d[12]) ? d : '';
}

export function uid() {
  return 'b-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const today = () => ymd();

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

// n か月前の「YYYY-MM」
export function monthsAgo(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return ymd(d).slice(0, 7);
}

// 書名から背表紙の色を決める（同じ本はいつも同じ色）
const CLOTH = ['#5B3A3A', '#3F4E5E', '#4A5A3F', '#6A5233', '#3E3A5A', '#5E3F52', '#2F5150', '#5A4636', '#44403C', '#6B3F2E'];
export function clothColor(s) {
  let h = 0;
  for (const ch of String(s ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CLOTH[h % CLOTH.length];
}
