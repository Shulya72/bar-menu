// VIA Bar — офлайн-режим.
// Страницы и данные сохраняются на устройстве. С интернетом всегда берётся
// свежая версия (а копия на телефоне обновляется), без интернета — последняя
// сохранённая. Заказы, закупки и правки склада без интернета не отправляются:
// страница покажет «нет связи», как и раньше.
const STATIC = "via-static-3"; // шрифты, иконки, логотип — меняются только с версией
const PAGES = "via-pages";
const DATA = "via-data";
const PHOTOS = "via-photos";
const KEEP = [STATIC, PAGES, DATA, PHOTOS];

const STATIC_FILES = [
  "/fonts/prata-cyrillic-400.woff2",
  "/fonts/prata-latin-400.woff2",
  "/brand/via-logo.webp?v=2",
  "/icons/favicon-64.png?v=2",
  "/icons/apple-touch-icon.png?v=2",
];
// Файлы приложения (*.webmanifest) не кэшируются: iPhone при добавлении на экран
// «Домой» должен получить их свежими.
const STATIC_RE = /^\/(fonts|icons|brand)\//;

// Что сохранить сразу, даже если раздел ещё не открывали (один раз на версию).
const WARM = {
  guest: ["/menu", "/api/cocktails"],
  bar: [
    "/bar/orders", "/bar/recipes", "/bar/stock", "/bar/shop", "/bar", "/bar/ingredients", "/bar/statistics", "/menu",
    "/api/cocktails", "/api/ingredients", "/api/bar/order", "/api/bar/guest-orders", "/api/products",
    "/api/bar/statistics", "/api/bar/shift",
  ],
};
const NO_CACHE_API = new Set(["/api/health", "/api/photo-debug"]);
const PAGE_TIMEOUT = 4000; // плохой интернет: через 4 с показываем сохранённое
const DATA_TIMEOUT = 6000;

const pageKey = (url) => url.origin + url.pathname;
const cacheable = (res) => res && res.ok && res.type === "basic" && !res.redirected;
const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms, null));

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(STATIC)
      .then((c) => Promise.all(STATIC_FILES.map((f) => fetch(f).then((r) => cacheable(r) && c.put(f, r)).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("via-") && !KEEP.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "via-warm" && WARM[d.app]) e.waitUntil(warm(d.app));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") {
    // Вошёл другой гость или вышел — сохранённый профиль больше не его.
    if (/^\/api\/guest\/(login|register|logout)$/.test(url.pathname)) e.waitUntil(forgetGuest());
    return;
  }
  if (url.pathname === "/sw.js") return;
  if (req.mode === "navigate") {
    e.respondWith(page(e, url, fetchAndSave(e, req, PAGES, pageKey(url))));
  } else if (url.pathname.startsWith("/api/cocktail-photo")) {
    e.respondWith(photo(e, req));
  } else if (url.pathname.startsWith("/api/")) {
    if (NO_CACHE_API.has(url.pathname)) return;
    e.respondWith(data(e, req, fetchAndSave(e, req, DATA, req.url, 80)));
  } else if (STATIC_RE.test(url.pathname)) {
    e.respondWith(staticFile(req, url));
  }
});

// Запрос в сеть; свежий ответ сразу копируется на телефон (копия снимается
// раньше, чем ответ уйдёт странице).
function fetchAndSave(e, req, cacheName, key, limit) {
  const net = fetch(req);
  e.waitUntil(
    net
      .then((res) => {
        if (!cacheable(res)) return;
        const copy = res.clone();
        return caches.open(cacheName).then((c) => c.put(key, copy).then(() => limit && trim(c, limit)));
      })
      .catch(() => {}),
  );
  return net;
}

async function trim(c, limit) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - limit; i++) await c.delete(keys[i]);
}

// Сначала сеть, при её отсутствии (или через таймаут) — сохранённая копия.
async function networkFirst(net, ms, fromCache) {
  try {
    const res = await Promise.race([net, timeout(ms)]);
    if (res) return { res, offline: false };
  } catch (_) {}
  const hit = await fromCache();
  if (hit) return { res: hit, offline: true };
  try {
    return { res: await net, offline: false };
  } catch (_) {
    return { res: null, offline: true };
  }
}

async function page(e, url, net) {
  const { res, offline } = await networkFirst(net, PAGE_TIMEOUT, () =>
    caches.open(PAGES).then((c) => c.match(pageKey(url), { ignoreVary: true })),
  );
  if (res && offline) {
    // Пометка для страницы: показать «нет интернета — сохранённая версия».
    const html = (await res.text()).replace("<html lang=\"ru\">", "<html lang=\"ru\" data-offline>");
    return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
  }
  return res || offlinePage(url);
}

async function data(e, req, net) {
  const { res, offline } = await networkFirst(net, DATA_TIMEOUT, () =>
    caches.open(DATA).then((c) => c.match(req.url, { ignoreVary: true })),
  );
  notify(e.clientId, offline);
  if (res) return res;
  return new Response(JSON.stringify({ error: "Нет интернета — эти данные ещё не сохранены на телефоне" }), {
    status: 503,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });
}

// Фото коктейля по уникальному ключу не меняется — берём из копии, если она есть.
async function photo(e, req) {
  const c = await caches.open(PHOTOS);
  const hit = await c.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) e.waitUntil(c.put(req.url, res.clone()).then(() => trim(c, 120)).catch(() => {}));
  return res;
}

async function staticFile(req, url) {
  const c = await caches.open(STATIC);
  const key = url.pathname + url.search; // ?v=N — новая версия картинки
  const hit = await c.match(key, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) c.put(key, res.clone()).catch(() => {});
  return res;
}

async function notify(clientId, offline) {
  if (!clientId) return;
  const client = await self.clients.get(clientId);
  if (client) client.postMessage({ type: "via-net", offline });
}

async function forgetGuest() {
  const c = await caches.open(DATA);
  for (const k of await c.keys()) if (new URL(k.url).pathname.startsWith("/api/guest/")) await c.delete(k);
}

async function warm(app) {
  const st = await caches.open(STATIC);
  const mark = "/__via-warm-" + app;
  if (await st.match(mark)) return;
  const pages = await caches.open(PAGES);
  const data = await caches.open(DATA);
  let ok = 0;
  await Promise.all(
    WARM[app].map(async (path) => {
      try {
        const res = await fetch(path, { credentials: "same-origin" });
        if (!cacheable(res)) return;
        const href = new URL(path, self.location.origin).href;
        await (path.startsWith("/api/") ? data : pages).put(href, res);
        ok++;
      } catch (_) {}
    }),
  );
  if (ok === WARM[app].length) await st.put(mark, new Response("1"));
}

const NAMES = {
  "/menu": "Меню",
  "/bar/orders": "Заказы",
  "/bar/recipes": "Рецепты",
  "/bar/stock": "Склад",
  "/bar/shop": "Закупки",
  "/bar/ingredients": "Ингредиенты",
  "/bar/statistics": "Статистика",
  "/bar": "Ещё",
  "/": "Главная",
};

// Страницу ещё ни разу не открывали с интернетом — объясняем и даём перейти к сохранённым.
async function offlinePage(url) {
  const keys = await caches.open(PAGES).then((c) => c.keys()).catch(() => []);
  const saved = keys.map((k) => new URL(k.url).pathname).filter((p) => NAMES[p] && p !== url.pathname);
  const order = Object.keys(NAMES);
  saved.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const links = saved.map((p) => `<a href="${p}">${NAMES[p]}</a>`).join("");
  const html = `<!doctype html><html lang="ru" data-offline><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0A0908">
<title>Нет интернета · VIA Bar</title><style>
@font-face{font-family:Prata;src:url(/fonts/prata-cyrillic-400.woff2) format("woff2");unicode-range:U+0400-04FF}
@font-face{font-family:Prata;src:url(/fonts/prata-latin-400.woff2) format("woff2");unicode-range:U+0000-00FF}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#0A0908;color:#F5EFE3;font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;display:grid;place-items:center;padding:calc(24px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom))}
main{width:min(100%,420px);text-align:center}img{width:112px;height:112px;display:block;margin:0 auto 18px}
h1{font-family:Prata,Georgia,serif;font-weight:400;font-size:2rem;line-height:1.15;margin:0 0 10px}p{color:#B9B0A0;margin:0 0 22px}
nav{display:flex;flex-direction:column;gap:10px}a{display:flex;align-items:center;justify-content:center;min-height:50px;border-radius:999px;background:rgba(230,193,115,.14);color:#E6C173;font-weight:600;text-decoration:none;box-shadow:inset 0 0 0 .75px rgba(230,193,115,.35)}
button{margin-top:14px;min-height:50px;width:100%;border:0;border-radius:999px;background:linear-gradient(180deg,#F0CF86,#C99A4B);color:#1A1307;font:inherit;font-weight:700}
</style></head><body><main>
<img src="/brand/via-logo.webp?v=2" alt="VIA Bar" width="112" height="112">
<h1>Нет интернета</h1>
<p>Эта страница ещё не сохранена на телефоне — откройте её один раз с интернетом, и дальше она будет открываться и без него.${links ? " Без интернета доступно:" : ""}</p>
${links ? `<nav aria-label="Сохранённые страницы">${links}</nav>` : ""}
<button type="button" onclick="location.reload()">Попробовать снова</button>
</main></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
}
