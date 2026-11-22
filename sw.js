/* G2R2 공정관리 서비스워커 — 홈 화면 앱 설치용.
   같은 주소의 화면·아이콘만 '네트워크 먼저'로 받아 두었다가, 인터넷이 끊기면 마지막 받은 것을 보여 준다.
   Worker(API)·글꼴 등 다른 주소 요청은 건드리지 않는다(항상 최신 데이터). */
const CACHE = 'g2r2-shell-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== self.location.origin) return;
  const nav = req.mode === 'navigate';
  e.respondWith((nav ? fetch(u.href, { cache: 'no-store' }) : fetch(req)).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(nav ? './' : req, c)); }
    return res;
  }).catch(() => caches.match(nav ? './' : req).then(r => r || caches.match('./'))));
});
