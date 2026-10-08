import App from "./index.js";

const GUEST_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

const normalizePhone = value => {
  let s = String(value || "").trim();
  if (!s) return "";
  const plus = s.startsWith("+") ? "+" : "";
  s = s.replace(/\\D/g, "");
  return plus + s;
};

const bytesToBase64Url = bytes => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
};

const hashPin = async pin => {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return {
    salt: bytesToBase64Url(salt),
    hash: bytesToBase64Url(new Uint8Array(bits))
  };
};

const ensureGuestsTable = async env => {
  await env.DB.prepare(GUEST_TABLE_SQL).run();
};

const registerGuest = async (request, env) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Некорректные данные формы" }, 400);
  }

  const name = String(body?.name || "").trim();
  const phone = normalizePhone(body?.phone);
  const pin = String(body?.pin || "");

  if (name.length < 2 || name.length > 80)
    return json({ error: "Имя должно быть от 2 до 80 символов" }, 400);

  if (!/^\\+?\\d{7,15}$/.test(phone))
    return json({ error: "Введите корректный номер телефона" }, 400);

  if (!/^\\d{4,12}$/.test(pin))
    return json({ error: "PIN должен содержать от 4 до 12 цифр" }, 400);

  await ensureGuestsTable(env);

  const existing = await env.DB.prepare(
    "SELECT id FROM guests WHERE phone=? LIMIT 1"
  ).bind(phone).first();

  if (existing)
    return json({ error: "Этот номер уже зарегистрирован" }, 409);

  const { salt, hash } = await hashPin(pin);

  try {
    const result = await env.DB.prepare(
      "INSERT INTO guests(name,phone,pin_salt,pin_hash) VALUES(?,?,?,?)"
    ).bind(name, phone, salt, hash).run();

    return json({
      ok: true,
      guest_id: Number(result.meta.last_row_id),
      message: "Регистрация успешно сохранена"
    });
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique"))
      return json({ error: "Этот номер уже зарегистрирован" }, 409);
    throw error;
  }
};

const injectRegistrationHandler = async response => {
  if (!response || !response.ok) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  const oldHandler = `guestRegisterForm.onsubmit=e=>{
  e.preventDefault();
  guestRegisterMessage.textContent="Форма готова. Подключение сохранения регистрации — следующим шагом.";
};`;

  if (!html.includes(oldHandler)) return new Response(html, {
    status: response.status,
    headers: response.headers
  });

  const newHandler = `guestRegisterForm.onsubmit=async e=>{
  e.preventDefault();
  guestRegisterMessage.textContent="Сохраняем…";
  const form=new FormData(e.target);
  try{
    const r=await fetch("/api/guest/register",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        name:String(form.get("name")||"").trim(),
        phone:String(form.get("phone")||"").trim(),
        pin:String(form.get("pin")||"")
      })
    });
    const d=await r.json();
    if(!r.ok){
      guestRegisterMessage.textContent=d.error||"Не удалось зарегистрироваться";
      return;
    }
    guestRegisterMessage.textContent=d.message||"Регистрация успешно сохранена ✅";
    e.target.reset();
  }catch(error){
    guestRegisterMessage.textContent="Не удалось связаться с сервером";
  }
};`;

  return new Response(html.replace(oldHandler, newHandler), {
    status: response.status,
    headers: response.headers
  });
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/guest/register" && request.method === "POST") {
      try {
        return await registerGuest(request, env);
      } catch (error) {
        console.error("guest registration", error);
        return json({ error: "Ошибка сервера при регистрации" }, 500);
      }
    }

    const response = await App.fetch(request, env, ctx);

    if (url.pathname === "/menu" && request.method === "GET") {
      return await injectRegistrationHandler(response);
    }

    return response;
  }
};
