// Вход в панель бармена.
//
// Один общий код хозяев (6–12 цифр). В базе — только его PBKDF2-хеш с солью (app_kv 'bar_pin').
// Телефон входит один раз: кука via_bar живёт год, в базе — только SHA-256 её токена
// (bar_sessions), поэтому «Выйти на всех устройствах» действительно закрывает доступ.
// Ключ восстановления выдаётся хозяевам один раз: им задают код при первой настройке
// и если код забыт. В коде — только SHA-256 ключа; 26 случайных символов (≈128 бит)
// перебором не подобрать, поэтому отпечаток можно держать в открытом репозитории.
// Неверные попытки ограничены: 5 с одного адреса и 20 всего за 15 минут.
import { renderDocument, icon, monogram } from "./design.js";

const RECOVERY_SHA256 = "161c1548df1c57f400db21607b6bd621588b988f05bc9a1eb5b4a7225c747b60";
const COOKIE = "via_bar";
const YEAR = 31536000;
const enc = new TextEncoder();

const json = (d, s = 200, h = {}) => Response.json(d, { status: s, headers: { "cache-control": "no-store", ...h } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sameStr = (a, b) => {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
};
const pinOk = (p) => /^\d{6,12}$/.test(p);
const normKey = (k) => String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ——— Код ———
const pinHash = async (pin, salt) => {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
};
const getPin = async (e) => {
  const r = await e.DB.prepare("SELECT value FROM app_kv WHERE key='bar_pin'").first();
  return r ? JSON.parse(r.value) : null;
};
const setPin = async (e, pin) => {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const value = JSON.stringify({ salt, hash: await pinHash(pin, salt) });
  await e.DB.prepare("INSERT INTO app_kv(key,value) VALUES('bar_pin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(value)
    .run();
};
const checkPin = async (e, pin) => {
  const p = await getPin(e);
  return !!p && pinOk(pin) && sameStr(await pinHash(pin, p.salt), p.hash);
};

// ——— Сессии ———
const tokenOf = (r) => /(?:^|;\s*)via_bar=([A-Za-z0-9_-]+)/.exec(r.headers.get("cookie") || "")?.[1] || "";
const deviceLabel = (r) => {
  const ua = r.headers.get("user-agent") || "";
  return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Устройство";
};
export async function barSession(r, e) {
  const t = tokenOf(r);
  if (t.length < 40) return null;
  const s = await e.DB.prepare(
    "SELECT id,last_seen_at < datetime('now','-1 day') stale FROM bar_sessions WHERE token_hash=? AND last_seen_at > datetime('now','-365 days')",
  )
    .bind(await sha256(t))
    .first();
  if (s?.stale) await e.DB.prepare("UPDATE bar_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?").bind(s.id).run();
  return s || null;
}
const newSession = async (r, e) => {
  const t = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await e.DB.prepare("INSERT INTO bar_sessions(token_hash,label) VALUES(?,?)").bind(await sha256(t), deviceLabel(r)).run();
  return `${COOKIE}=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${YEAR}`;
};
const CLEAR_COOKIE = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

// ——— Ограничение попыток ———
const ipOf = (r) => r.headers.get("cf-connecting-ip") || "local";
const tooMany = async (e, ip) => {
  const x = await e.DB.prepare(
    "SELECT COALESCE(SUM(ip=?),0) mine,COUNT(*) total FROM bar_login_failures WHERE at > datetime('now','-15 minutes')",
  )
    .bind(ip)
    .first();
  return Number(x?.mine) >= 5 || Number(x?.total) >= 20;
};
const failed = (e, ip) =>
  e.DB.batch([
    e.DB.prepare("INSERT INTO bar_login_failures(ip) VALUES(?)").bind(ip),
    e.DB.prepare("DELETE FROM bar_login_failures WHERE at < datetime('now','-1 day')"),
  ]);
const tooManyResponse = () => json({ error: "Слишком много неверных попыток. Подождите 15 минут." }, 429);
export const authRequired = () => json({ error: "Нужен вход в панель бармена" }, 401, { "x-bar-auth": "required" });

// ——— Что открыто без входа ———
// Всё остальное (страницы /bar…, склад, закупки, рецепты, статистика, заказы гостей
// с их телефонами) — только после входа. Новые адреса закрыты по умолчанию.
const isPublicApi = (p, m) =>
  p === "/api/health" ||
  ((m === "GET" || m === "HEAD") && (p === "/api/cocktails" || p === "/api/cocktail-photo" || p.startsWith("/api/cocktail-photo/"))) ||
  p.startsWith("/api/guest/") ||
  p.startsWith("/api/push/") || // роль «бармен» проверяется в самой подписке
  p === "/api/bar/auth" ||
  p.startsWith("/api/bar/auth/");
export const isBarPage = (p) => p === "/bar" || p.startsWith("/bar/");
export const needsBarAuth = (p, m) => isBarPage(p) || (p.startsWith("/api/") && !isPublicApi(p, m));

// ——— API входа ———
export async function barAuthApi(r, e, u) {
  const p = u.pathname,
    ip = ipOf(r);
  if (p === "/api/bar/auth" && r.method === "GET") {
    const s = await barSession(r, e);
    const devices = s ? Number((await e.DB.prepare("SELECT COUNT(*) n FROM bar_sessions").first())?.n || 0) : undefined;
    return json({ configured: !!(await getPin(e)), authed: !!s, devices });
  }
  if (r.method !== "POST" || !p.startsWith("/api/bar/auth/")) return null;
  let b = {};
  try {
    b = (await r.json()) || {};
  } catch {}
  if (p === "/api/bar/auth/login") {
    if (await tooMany(e, ip)) return tooManyResponse();
    if (!(await getPin(e))) return json({ error: "Код ещё не задан — нужен ключ восстановления" }, 409);
    if (!(await checkPin(e, String(b.pin || "")))) {
      await failed(e, ip);
      return json({ error: "Неверный код" }, 401);
    }
    await e.DB.prepare("DELETE FROM bar_login_failures WHERE ip=?").bind(ip).run();
    return json({ ok: true }, 200, { "Set-Cookie": await newSession(r, e) });
  }
  // Первая настройка и «Забыли код?»: новый код по ключу восстановления.
  if (p === "/api/bar/auth/setup") {
    if (await tooMany(e, ip)) return tooManyResponse();
    const pin = String(b.pin || "");
    if (!pinOk(pin)) return json({ error: "Код — от 6 до 12 цифр" }, 400);
    if (!sameStr(await sha256(normKey(b.key)), RECOVERY_SHA256)) {
      await failed(e, ip);
      return json({ error: "Неверный ключ восстановления" }, 401);
    }
    await setPin(e, pin);
    // Код сменили по ключу — все остальные устройства входят заново.
    await e.DB.batch([e.DB.prepare("DELETE FROM bar_sessions"), e.DB.prepare("DELETE FROM bar_login_failures WHERE ip=?").bind(ip)]);
    return json({ ok: true }, 200, { "Set-Cookie": await newSession(r, e) });
  }
  const s = await barSession(r, e);
  if (!s) return authRequired();
  if (p === "/api/bar/auth/change") {
    if (await tooMany(e, ip)) return tooManyResponse();
    const pin = String(b.pin || "");
    if (!pinOk(pin)) return json({ error: "Новый код — от 6 до 12 цифр" }, 400);
    if (!(await checkPin(e, String(b.current || "")))) {
      await failed(e, ip);
      return json({ error: "Текущий код неверный" }, 401);
    }
    await setPin(e, pin);
    return json({ ok: true });
  }
  if (p === "/api/bar/auth/logout") {
    // «На всех устройствах»: закрываем все сессии и уведомления бармена (с чужого
    // телефона больше не придут заказы с именами гостей).
    await (b.all
      ? e.DB.batch([e.DB.prepare("DELETE FROM bar_sessions"), e.DB.prepare("DELETE FROM push_subscriptions WHERE role='bar'")])
      : e.DB.prepare("DELETE FROM bar_sessions WHERE id=?").bind(s.id).run());
    return json({ ok: true }, 200, { "Set-Cookie": CLEAR_COOKIE });
  }
  return null;
}

// ——— Экран входа ———
const LOGIN_CSS = `.screen{padding-top:calc(44px + var(--safe-t))}
.auth{display:flex;flex-direction:column;gap:14px;max-width:420px;margin:0 auto}
.auth .monogram{width:96px;height:96px;margin:4px auto 2px}
.auth-sub{margin:0 4px;color:var(--label-2);text-align:center}
.auth form{display:flex;flex-direction:column;gap:12px}
.auth .list{margin:0}
.auth .form-msg{margin:0 4px;color:var(--danger);font-size:.9375rem}
.auth .form-msg:empty{display:none}
.auth .section-footer{margin:0 4px}
.auth .guest-link{margin-top:6px;color:var(--label-2)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}`;

const pinInput = (name, auto, label, extra = "") =>
  `<label class="field"><span>${label}</span><input name="${name}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="${auto}" required placeholder="6–12 цифр"${extra}></label>`;
// Скрытое «имя пользователя» — чтобы iPhone предложил сохранить код в «Паролях».
const userField = `<input class="sr-only" name="username" autocomplete="username" value="VIA Bar" tabindex="-1" aria-hidden="true" readonly>`;

const LOGIN_JS = `(function(){
var $=function(s){return document.querySelector(s)},title=$(".large-title"),sub=$("#authSub"),login=$("#loginForm"),keyf=$("#keyForm");
var TEXT={login:["Панель бармена","Заказы, рецепты и склад открываются по коду бармена. На этом устройстве его нужно ввести один раз."],
setup:["Защита панели","Придумайте код из 6–12 цифр. Его нужно ввести один раз на каждом телефоне, где стоит панель. Для первой настройки нужен ключ восстановления."],
reset:["Новый код","Введите ключ восстановления и придумайте новый код. Остальные устройства выйдут из панели — на них войдите с новым кодом."]};
function mode(m){title.textContent=TEXT[m][0];sub.textContent=TEXT[m][1];login.hidden=m!=="login";keyf.hidden=m==="login";
var back=$("#authBack");if(back)back.hidden=m!=="reset";var f=(m==="login"?login:keyf).querySelector("input:not([readonly])");if(f)setTimeout(function(){f.focus()},50)}
function post(u,b){return fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok)throw new Error(d.error||"Не получилось — проверьте интернет");return d})})}
function run(form,msg,body,url){var btn=form.querySelector("[type=submit]");msg.textContent="";btn.disabled=true;
post(url,body).then(function(){location.reload()}).catch(function(e){msg.textContent=e.message;btn.disabled=false})}
login.addEventListener("submit",function(e){e.preventDefault();var pin=login.pin.value.trim(),msg=$("#loginMsg");
if(!/^\\d{6,12}$/.test(pin)){msg.textContent="Код — от 6 до 12 цифр";return}run(login,msg,{pin:pin},"/api/bar/auth/login")});
keyf.addEventListener("submit",function(e){e.preventDefault();var msg=$("#keyMsg"),key=keyf.key.value,pin=keyf.pin.value.trim();
if(!key.replace(/[^A-Za-z0-9]/g,"")){msg.textContent="Введите ключ восстановления";return}
if(!/^\\d{6,12}$/.test(pin)){msg.textContent="Код — от 6 до 12 цифр";return}
if(pin!==keyf.pin2.value.trim()){msg.textContent="Коды не совпадают";return}run(keyf,msg,{key:key,pin:pin},"/api/bar/auth/setup")});
var forgot=$("#forgot");if(forgot)forgot.addEventListener("click",function(){mode("reset")});
var back=$("#authBack");if(back)back.addEventListener("click",function(){mode("login")});
mode(login.dataset.configured==="1"?"login":"setup");
})();`;

export async function barLoginPage(r, e) {
  const configured = !!(await getPin(e));
  const body = `<div class="auth">
${monogram(96)}
<p class="auth-sub" id="authSub"></p>
<form id="loginForm" novalidate data-configured="${configured ? 1 : 0}"${configured ? "" : " hidden"}>${userField}
<div class="list">${pinInput("pin", "current-password", "Код")}</div>
<p class="form-msg" id="loginMsg" role="alert"></p>
<button class="btn btn-primary btn-block" type="submit">${icon("check")}Войти</button>
<button class="btn btn-plain btn-block" type="button" id="forgot">Забыли код?</button>
</form>
<form id="keyForm" novalidate${configured ? " hidden" : ""}>${userField}
<div class="list"><label class="field"><span>Ключ восстановления</span><input name="key" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" required placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"></label></div>
<div class="list">${pinInput("pin", "new-password", "Новый код")}${pinInput("pin2", "new-password", "Повторите код")}</div>
<p class="form-msg" id="keyMsg" role="alert"></p>
<button class="btn btn-primary btn-block" type="submit">${icon("check")}Сохранить и войти</button>
${configured ? `<button class="btn btn-plain btn-block" type="button" id="authBack" hidden>Я помню код</button>` : ""}
</form>
<a class="btn btn-plain btn-block guest-link" href="/menu">Я гость — открыть меню</a>
</div>`;
  const html = renderDocument({
    title: configured ? "Панель бармена" : "Защита панели",
    docTitle: "Вход · VIA Bar",
    app: "bar",
    tabs: false,
    navbar: false,
    extraCss: LOGIN_CSS,
    body,
  }).replace("</main>", () => `</main><script>${LOGIN_JS}</script>`);
  // 401: офлайн-режим не сохранит экран входа вместо страницы панели.
  return new Response(html, { status: 401, headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store" } });
}
