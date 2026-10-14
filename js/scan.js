// ISBNを連続で読み取る。対応ブラウザはBarcodeDetector、それ以外（iPhone など）はZXingを使う。
import { isbn13 } from './util.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
// 配信元で中身が書き換えられていたら読み込まない（サブリソース完全性）。版を上げるときはこの値も取り直す
const ZXING_SRI = 'sha384-BzBxP10ZE72aitqj5UMmUsbKFliP/DZqA8Wq+BNNhlIJDGoEd1tpkMYXOg9+n6sB';
let zxingLoading = null;

export function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ZXING_URL;
    script.integrity = ZXING_SRI;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.async = true;
    script.onload = () => resolve(window.ZXing);
    script.onerror = () => {
      zxingLoading = null;
      script.remove();
      reject(new Error('読み取り用の部品を読み込めませんでした。通信状態を確認してください。'));
    };
    document.head.append(script);
  });
  return zxingLoading;
}

// EAN-13 だけを探す ZXing の読み取り器（1 枚ずつ読む）
async function zxingReader() {
  const ZXing = await loadZxing();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return { ZXing, reader };
}

// 映像の 1 枚を切り出して読む。枠のある中央の帯 → 映像全体 → 中央の帯（別の二値化）を順に試す。
// 切り出した画像は幅 960px までに縮めて、iPhone でも 1 回を短い時間で終える
const CROPS = [
  { x: 0.08, y: 0.25, w: 0.84, h: 0.5, binarizer: 'HybridBinarizer' },
  { x: 0, y: 0, w: 1, h: 1, binarizer: 'HybridBinarizer' },
  { x: 0.08, y: 0.25, w: 0.84, h: 0.5, binarizer: 'GlobalHistogramBinarizer' },
];
export function decodeFrame({ ZXing, reader }, video, canvas, frame = 0) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return '';
  const crop = CROPS[frame % CROPS.length];
  const sw = Math.round(vw * crop.w);
  const sh = Math.round(vh * crop.h);
  const scale = Math.min(1, 960 / sw);
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, Math.round(vw * crop.x), Math.round(vh * crop.y), sw, sh, 0, 0, canvas.width, canvas.height);
  try {
    const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    return reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing[crop.binarizer](source))).getText();
  } catch {
    return ''; // この 1 枚には見つからなかった
  } finally {
    reader.reset();
  }
}

function cameraError(e) {
  if (e?.name === 'AbortError') return e;
  if (['NotAllowedError', 'SecurityError'].includes(e?.name)) return new Error('カメラの使用が許可されていません。ブラウザのカメラ設定で許可してから、もう一度開いてください。ISBNの手入力でも追加できます。');
  if (['NotFoundError', 'OverconstrainedError'].includes(e?.name)) return new Error('カメラが見つかりません。下の欄にISBNを入力して追加できます。');
  if (e?.name === 'NotReadableError') return new Error('カメラを他のアプリが使っています。閉じてからもう一度試してください。');
  return new Error(e?.message || 'カメラを起動できませんでした。');
}

// signalで起動待ちも中止できる。画面を離れた後にカメラ許可が返ってきた場合も即座に止める。
export async function startScanner(video, onIsbn, { signal } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('この画面ではカメラを使えません（httpsで開く必要があります）。下の欄にISBNを入力して追加できます。');
  let stopped = false;
  let stream;
  let zxing = null;
  let zxingPending = false;
  let timer;
  let lastIsbn = '';
  let lastAt = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    signal?.removeEventListener('abort', stop);
  };
  const checkActive = () => {
    if (stopped || signal?.aborted) {
      stop();
      throw new DOMException('読み取りを終了しました', 'AbortError');
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  const emit = (raw) => {
    const isbn = isbn13(raw); // 下段の192…価格コードや検査数字の誤りは無視
    if (!isbn || stopped || signal?.aborted) return;
    const now = Date.now();
    if (isbn === lastIsbn && now - lastAt < 4000) return;
    lastIsbn = isbn;
    lastAt = now;
    onIsbn(isbn);
  };
  const constraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };
  try {
    checkActive();
    let detector;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('ean_13')) detector = new window.BarcodeDetector({ formats: ['ean_13'] });
      } catch { /* ZXingへ切り替える */ }
    }
    checkActive();
    // ZXing の連続読み取り（decodeFromStream）は、映像の大きさが決まる前に始まると読み取り用の画像の大きさを
    // 誤ったまま固定し、iPhone で「映像は映るのに何も読めない」状態になる。映像が出てから 1 枚ずつ自分で読む
    if (!detector) zxing = await zxingReader();
    checkActive();
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    checkActive();
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play().catch(() => {});
    checkActive();
    const startedAt = Date.now();
    const canvas = document.createElement('canvas');
    let frame = 0;
    const tick = async () => {
      if (stopped) return;
      let found = false;
      if (detector) {
        try {
          const codes = await detector.detect(video);
          codes.forEach((code) => emit(code.rawValue));
          found = codes.some((code) => isbn13(code.rawValue));
        } catch { /* フレームの準備中は次を試す */ }
        // BarcodeDetector があっても 3 秒読めなければ ZXing も使う（端末によって EAN-13 を読めないことがある）
        if (!found && !zxing && !zxingPending && Date.now() - startedAt > 3000) {
          zxingPending = true;
          zxingReader().then((z) => { zxing ||= z; }).catch(() => { zxingPending = false; });
        }
      }
      if (!found && zxing && !stopped) {
        const text = decodeFrame(zxing, video, canvas, frame++);
        if (text) emit(text);
      }
      if (!stopped) timer = setTimeout(tick, 120);
    };
    tick();
    return stop;
  } catch (e) {
    stop();
    throw cameraError(e);
  }
}
