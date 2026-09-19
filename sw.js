/* sw.js — 孤独领域资源缓存。
 * 对大体量资源（场景 GLB / Draco 解码器 / 构建产物）做 cache-first：
 * 首次访问下载后，再次访问即时加载。更新游戏时把 CACHE 版本号 +1 即可。 */
const CACHE = 'solitude-realm-v8';
const CACHEABLE = /arena\.glb|character\/|draco\/|assets\/|fonts\/|sfx\//;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (!CACHEABLE.test(url.pathname)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    })
  );
});
