// VIA Bar — офлайн-режим.
// Страницы и данные сохраняются на устройстве. С интернетом всегда берётся
// свежая версия (а копия на телефоне обновляется), без интернета — последняя
// сохранённая. Заказы, закупки и правки склада без интернета не отправляются:
// страница покажет «нет связи», как и раньше.
const STATIC = "via-static-4"; // шрифты, иконки, логотип — меняются только с версией (-4: «Слоновая кость и бордо»)
// -2: после защиты панели входом старые копии барменских страниц стираются со всех устройств.
// -4: вкладки бармена открываются из копии сразу — копии прежней версии (без снимков и «Обновляем…») стираем.
const PAGES = "via-pages-4"; // -3: новый дизайн — старые копии страниц не показываем
const DATA = "via-data-2";
const PHOTOS = "via-photos";
const KEEP = [STATIC, PAGES, DATA, PHOTOS];

const STATIC_FILES = [
  "/fonts/manrope-cyrillic-500-normal.woff2",
  "/fonts/manrope-cyrillic-700-normal.woff2",
  "/fonts/cormorant-garamond-cyrillic-600-normal.woff2",
  "/brand/via-logo-bordeaux.webp?v=3",
  "/icons/favicon-64.png?v=3",
  "/icons/apple-touch-icon.png?v=3",
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
// Вкладки панели бармена открываются сразу из копии на телефоне, а свежая копия страницы грузится
// в фоне — для следующего раза. Данные на экране всё равно свежие: страница сама запрашивает их у
// сервера, а то, что вписано в саму страницу («Ещё», склад), подтягивает по отметке data-cached.
const FAST_PAGES = new Set(["/bar/orders", "/bar/recipes", "/bar/stock", "/bar/shop", "/bar"]);
const PAGE_TIMEOUT = 6000; // плохой интернет: через 6 с показываем сохранённое
const DATA_TIMEOUT = 8000;
// Сохранённой копии нет: ждём сеть ещё, но не бесконечно — оператор может «заморозить»
// соединение (так в России ограничивают сайты на Cloudflare), и страница висела бы вечно.
const LAST_WAIT = 20000;
// Страница только что открылась из копии — связь, скорее всего, «заморожена»: данные
// тоже берём из копии быстрее, а не через полные 8 секунд.
const DATA_TIMEOUT_OFFLINE = 2500;
let offlineUntil = 0;

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

// ——— Уведомления: новый заказ (бармену), «заказ готов» (гостю) и т. п. ———
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (_) {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "VIA Bar", {
      body: d.body || "",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
      icon: "/icons/apple-touch-icon.png?v=3",
      badge: "/icons/favicon-64.png?v=3",
    }),
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const same = list.find((c) => new URL(c.url).pathname === url.pathname);
      if (same)
        return (same.navigate ? same.navigate(url.href).catch(() => same) : Promise.resolve(same)).then((c) =>
          (c || same).focus(),
        );
      return self.clients.openWindow(url.href);
    }),
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
    if (/^\/api\/guest\/(login|register|logout|delete)$/.test(url.pathname)) e.waitUntil(forgetGuest());
    return;
  }
  if (url.pathname === "/sw.js") return;
  if (req.mode === "navigate") {
    e.respondWith(FAST_PAGES.has(url.pathname) ? fastPage(e, req, url) : page(e, url, complete(fetchAndSave(e, req, PAGES, pageKey(url)))));
  } else if (url.pathname.startsWith("/api/cocktail-photo")) {
    e.respondWith(photo(e, req));
  } else if (url.pathname.startsWith("/api/")) {
    if (NO_CACHE_API.has(url.pathname)) return;
    e.respondWith(data(e, req, complete(fetchAndSave(e, req, DATA, req.url, 80))));
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

// Ответ засчитывается, только когда пришёл целиком. При «заморозке» (оператор пропускает
// первые ~16 КБ соединения) начало ответа приходит сразу, а остальное — никогда: без этого
// страница висела бы недогруженной вместо сохранённой копии.
function complete(net) {
  return net.then(async (res) => {
    if (!res || res.redirected || res.type !== "basic") return res;
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
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
    const res = await Promise.race([net, timeout(LAST_WAIT)]);
    return { res, offline: !res };
  } catch (_) {
    return { res: null, offline: true };
  }
}

async function page(e, url, net) {
  const { res, offline } = await networkFirst(net, PAGE_TIMEOUT, () =>
    caches.open(PAGES).then((c) => c.match(pageKey(url), { ignoreVary: true })),
  );
  offlineUntil = offline ? Date.now() + 30000 : 0;
  if (res && offline) {
    // Пометка для страницы: показать «нет интернета — сохранённая версия».
    const html = (await res.text()).replace("<html lang=\"ru\">", "<html lang=\"ru\" data-offline>");
    return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
  }
  return res || offlinePage(url);
}

async function fastPage(e, req, url) {
  const hit = await caches.open(PAGES).then((c) => c.match(pageKey(url), { ignoreVary: true })).catch(() => null);
  const net = fetchAndSave(e, req, PAGES, pageKey(url)); // свежая копия сохранится в фоне
  if (!hit) return page(e, url, complete(net));
  net.catch(() => {});
  const html = (await hit.text()).replace("<html lang=\"ru\">", "<html lang=\"ru\" data-cached>");
  return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
}

async function data(e, req, net) {
  const { res, offline } = await networkFirst(net, Date.now() < offlineUntil ? DATA_TIMEOUT_OFFLINE : DATA_TIMEOUT, () =>
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
  // Отметка привязана к версии хранилища: сменили PAGES — всё сохраняется заново.
  const mark = "/__via-warm-" + app + "-" + PAGES;
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
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><meta name="theme-color" content="#F6EFE5">
<title>Нет связи · VIA Bar</title><style>
@font-face{font-family:"Cormorant Garamond";font-weight:600;src:url(/fonts/cormorant-garamond-cyrillic-600-normal.woff2) format("woff2");unicode-range:U+0400-04FF}
@font-face{font-family:Manrope;font-weight:500;src:url(/fonts/manrope-cyrillic-500-normal.woff2) format("woff2");unicode-range:U+0400-04FF}
@font-face{font-family:Manrope;font-weight:700;src:url(/fonts/manrope-cyrillic-700-normal.woff2) format("woff2");unicode-range:U+0400-04FF}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:radial-gradient(120% 420px at 50% -60px,#FFFBF5 0,rgba(255,251,245,0) 70%) no-repeat,#F6EFE5;color:#2A0E16;font:500 16px/1.45 Manrope,-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;display:grid;place-items:center;padding:calc(24px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom))}
main{width:min(100%,420px);text-align:center}img{width:112px;height:112px;display:block;margin:0 auto 18px}
h1{font:600 2.25rem/1.04 "Cormorant Garamond",Georgia,serif;margin:0 0 10px}p{color:#5E464B;margin:0 0 22px}
nav{display:flex;flex-direction:column;gap:10px}a{display:flex;align-items:center;justify-content:center;min-height:50px;border-radius:16px;background:rgba(110,26,43,.08);color:#6E1A2B;font-weight:700;text-decoration:none}
button{margin-top:14px;min-height:50px;width:100%;border:0;border-radius:16px;background:linear-gradient(180deg,#7C2335,#5F1626);color:#FBF2E4;font:inherit;font-weight:700;box-shadow:0 10px 22px rgba(80,18,34,.18)}
</style></head><body><main>
<img src="/brand/via-logo-bordeaux.webp?v=3" alt="VIA Bar" width="112" height="112">
<h1>Нет связи с сайтом</h1>
<p>Эта страница ещё не сохранена на телефоне. Если интернет есть, а сайт не открывается, — возможно, оператор ограничивает доступ: попробуйте с VPN.${links ? " Без связи доступно:" : ""}</p>
${links ? `<nav aria-label="Сохранённые страницы">${links}</nav>` : ""}
<button type="button" onclick="location.reload()">Попробовать снова</button>
</main></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
}
