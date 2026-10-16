// Уведомления на телефон (Web Push): бармену — новые заказы и отзывы,
// гостю — «заказ готов» / «заказ отменён». Работает на iPhone в приложении
// с экрана «Домой» (iOS 16.4+) и в браузерах на компьютере/Android.
//
// Без сторонних сервисов: ключи VAPID создаются один раз и хранятся в D1
// (app_kv), сообщения шифруются по RFC 8291 (aes128gcm) средствами WebCrypto
// и отправляются прямо на push-сервер браузера (у iPhone — web.push.apple.com).

const enc = new TextEncoder();
const b64u = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ——— Ключи VAPID: создаются при первом обращении и живут в D1 ———
let vapidCache = null;
export async function getVapid(env) {
  if (vapidCache) return vapidCache;
  const row = await env.DB.prepare("SELECT value FROM app_kv WHERE key='vapid'").first();
  let data = row ? JSON.parse(row.value) : null;
  if (!data) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    data = {
      publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)),
      privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
    };
    // Два одновременных первых запроса: побеждает первый записанный ключ.
    await env.DB.prepare("INSERT OR IGNORE INTO app_kv(key,value) VALUES('vapid',?)").bind(JSON.stringify(data)).run();
    data = JSON.parse((await env.DB.prepare("SELECT value FROM app_kv WHERE key='vapid'").first()).value);
  }
  const privateKey = await crypto.subtle.importKey("jwk", data.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  vapidCache = { publicKey: data.publicKey, privateKey };
  return vapidCache;
}

async function vapidHeader(env, endpoint) {
  const { publicKey, privateKey } = await getVapid(env);
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(
    enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://shulya.party" })),
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(header + "." + payload));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${publicKey}`;
}

const hkdf = async (salt, ikm, info, bytes) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
};

// Шифрование сообщения для одного получателя (RFC 8291, content-encoding aes128gcm).
export async function encryptPayload(p256dhB64, authB64, plaintext) {
  const uaPublic = unb64u(p256dhB64);
  const authSecret = unb64u(authB64);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = concat(typeof plaintext === "string" ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const rs = new Uint8Array([0, 0, 16, 0]); // размер записи 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendOne(env, sub, message) {
  let status = 0,
    error = "";
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(env, sub.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "3600",
        Urgency: "high",
      },
      body,
    });
    status = res.status;
    if (status >= 400) error = (await res.text().catch(() => "")).slice(0, 160);
  } catch (e) {
    error = String(e?.message || e).slice(0, 160);
  }
  // Подписка больше не действует (приложение удалили, уведомления выключили) — забываем её.
  if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(sub.id).run();
  // Иначе запоминаем, чем ответил push-сервер, — это видно в «Ещё → Уведомления».
  else
    await env.DB.prepare("UPDATE push_subscriptions SET last_status=?,last_error=?,last_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(status, error, sub.id)
      .run();
  if (!status) console.error("push:", error);
  return status;
}

async function sendTo(env, sql, binds, message) {
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  await Promise.all((results || []).map((s) => sendOne(env, s, message).catch((e) => console.error("push:", e?.message))));
}

// message: { title, body, url, tag }
// exceptSession: не слать на телефон, с которого действие и сделали (заказ за стойкой).
export const notifyBar = (env, message, exceptSession = null) =>
  sendTo(
    env,
    "SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE role='bar' AND (? IS NULL OR bar_session_id IS NULL OR bar_session_id<>?)",
    [exceptSession, exceptSession],
    message,
  );
export const notifyGuest = (env, guestId, message) =>
  sendTo(env, "SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE role='guest' AND guest_id=?", [guestId], message);

export async function saveSubscription(env, role, guestId, sub, label = "", barSessionId = null) {
  const endpoint = String(sub?.endpoint || ""),
    p256dh = String(sub?.keys?.p256dh || ""),
    auth = String(sub?.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) return false;
  await env.DB.prepare(
    "INSERT INTO push_subscriptions(endpoint,p256dh,auth,role,guest_id,label,bar_session_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(endpoint,role) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,guest_id=excluded.guest_id,label=excluded.label,bar_session_id=excluded.bar_session_id",
  )
    .bind(endpoint, p256dh, auth, role, guestId, String(label || "").slice(0, 40), barSessionId)
    .run();
  return true;
}

export const removeSubscription = (env, role, endpoint) =>
  env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND role=?").bind(String(endpoint || ""), role).run();

// ——— Проверка в панели бармена («Ещё → Уведомления») ———
// Какие телефоны бармена подписаны и чем ответил push-сервер в последний раз.
export async function barPushStatus(env, endpoint) {
  const { results } = await env.DB.prepare(
    "SELECT label,created_at,last_status,last_error,last_at,endpoint=? mine FROM push_subscriptions WHERE role='bar' ORDER BY id",
  )
    .bind(String(endpoint || ""))
    .all();
  return (results || []).map((x) => ({ ...x, mine: !!x.mine }));
}
// Тестовое уведомление на этот телефон через несколько секунд (успеть свернуть приложение).
export async function barPushTest(env, endpoint, delayMs) {
  const sub = await env.DB.prepare("SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE role='bar' AND endpoint=?")
    .bind(String(endpoint || ""))
    .first();
  if (!sub) return null;
  // В объекте: иначе await у вызывающего ждал бы всю задержку.
  return {
    job: new Promise((ok) => setTimeout(ok, delayMs)).then(() =>
      sendOne(env, sub, {
        title: "Проверка уведомлений",
        body: "Всё работает: заказы и отзывы гостей будут приходить на этот телефон.",
        url: "/bar",
        tag: "push-test",
      }),
    ),
  };
}
