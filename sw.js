// オフラインでも本棚を開けるように、アプリ本体だけを保存しておく。
// 通信できるときは常にサーバーに更新を確かめ（no-cache）、だめなときだけ保存分を使う。
const CACHE = 'dokusho-techo-v14';
const SHELL = [
  './', './index.html', './css/app.css', './js/app.js', './js/store.js', './js/ndl.js', './js/genres.js',
  './js/book-details.js', './js/reveal.js', './js/versions.js', './js/covers.js', './js/authors.js', './js/shelf.js', './js/recommend.js', './js/util.js', './js/scan.js', './data/seed.json', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-512-maskable.png', './icons/mark.svg',
];

self.addEventListener('install', (e) => {
  // 1 つ取れなくても登録が止まらないよう、1 件ずつ保存する
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
