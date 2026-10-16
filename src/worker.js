import App, { ensureSchema, guestOrderShortage, acceptGuestOrderWithStock } from "./index.js";
import { getVapid, notifyBar, notifyGuest, saveSubscription, removeSubscription, barPushStatus, barPushTest } from "./push.js";
import { barSession, barAuthApi, barLoginPage, authRequired, needsBarAuth, isBarPage, deviceLabel } from "./barauth.js";

const json = (d, s = 200) => Response.json(d, { status: s, headers: { "cache-control": "no-store" } });
// Уведомление отправляется после ответа: заказ/выдача не ждут push-сервер.
const later = (c, p) => {
  const safe = Promise.resolve()
    .then(p)
    .catch((err) => console.error("push:", err?.message));
  if (c?.waitUntil) c.waitUntil(safe);
};
// Состав заказа для уведомления гостю: кому и что.
const orderInfo = async (e, id) => {
  const { results } = await e.DB.prepare(
    "SELECT o.guest_id,c.name,oi.quantity qty FROM orders o JOIN order_items oi ON oi.order_id=o.id LEFT JOIN cocktails c ON c.id=oi.cocktail_id WHERE o.id=? ORDER BY oi.id",
  )
    .bind(id)
    .all();
  const rows = results || [];
  return { guest_id: rows[0]?.guest_id, items: rows.map((x) => ({ name: x.name || "Коктейль", qty: Number(x.qty) || 1 })) };
};
// Тексты гостю — от лица бара («мы»), по-человечески и без номеров заказов.
// Название коктейля после двоеточия: не нужно согласовывать «готов/готова/готово».
const itemLabel = (x) => "«" + x.name + "»" + (x.qty > 1 ? " × " + x.qty : "");
const guestText = (kind, items) => {
  const one = items.length === 1,
    what = one ? itemLabel(items[0]) : "",
    list = items.map(itemLabel).join(", ") + ". ";
  if (kind === "accepted")
    return one
      ? { title: "Уже готовим: " + what, body: "Напишем, как только будет готово." }
      : { title: "Уже готовим ваш заказ", body: list + "Напишем, как только всё будет готово." };
  if (kind === "served")
    return one
      ? { title: "Готово: " + what, body: "Ждём вас у стойки. Приятного вечера!" }
      : { title: "Готово: ваш заказ", body: list + "Ждём вас у стойки. Приятного вечера!" };
  return one
    ? { title: "Увы, не сегодня: " + what, body: "Простите! Загляните в меню — подберём что-нибудь другое." }
    : { title: "Увы, заказ не получится", body: list + "Простите! Загляните в меню — подберём что-нибудь другое." };
};
const notifyGuestOrder = (e, c, id, kind) =>
  later(c, async () => {
    const o = await orderInfo(e, id);
    if (o.guest_id && o.items.length)
      await notifyGuest(e, Number(o.guest_id), { ...guestText(kind, o.items), url: "/menu#order", tag: "order-" + id });
  });
// Телефон в едином виде. Российский номер можно ввести как 8…, +7…, 7… или
// 10 цифр с 9… — всё это один и тот же номер, хранится как +7XXXXXXXXXX.
const norm = (v) => {
  const s = String(v || "").trim();
  const plus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!plus && d.length === 11 && (d[0] === "8" || d[0] === "7")) return "+7" + d.slice(1);
  if (!plus && d.length === 10 && d[0] === "9") return "+7" + d;
  return (plus ? "+" : "") + d;
};
// Как этот номер мог быть сохранён раньше (до единого вида): для входа и проверки дублей.
const phoneVariants = (v) => {
  const s = String(v || "").trim();
  const c = norm(s);
  const out = new Set([c, (s.startsWith("+") ? "+" : "") + s.replace(/\D/g, "")]);
  if (/^\+7\d{10}$/.test(c)) {
    const rest = c.slice(2);
    out.add("8" + rest);
    out.add("7" + rest);
    out.add(rest);
  }
  return [...out];
};
const inList = (n) => Array.from({ length: n }, () => "?").join(",");
const b64 = (b) => {
  let x = "";
  for (const n of b) x += String.fromCharCode(n);
  return btoa(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const session = async (e, id) => {
  const t = b64(crypto.getRandomValues(new Uint8Array(32)));
  await e.DB.prepare("INSERT INTO guest_sessions(token,guest_id,expires_at) VALUES(?,?,datetime('now','+30 days'))")
    .bind(t, id)
    .run();
  return t;
};
const register = async (r, e) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные формы" }, 400);
  }
  const name = String(b?.name || "").trim(),
    phone = norm(b?.phone),
    pin = String(b?.pin || "");
  if (name.length < 2 || name.length > 80) return json({ error: "Имя должно быть от 2 до 80 символов" }, 400);
  if (!/^\+?\d{7,15}$/.test(phone)) return json({ error: "Введите корректный номер телефона" }, 400);
  if (!/^\d{4,12}$/.test(pin)) return json({ error: "PIN должен содержать от 4 до 12 цифр" }, 400);
  const variants = phoneVariants(b?.phone);
  if (await e.DB.prepare(`SELECT id FROM guests WHERE phone IN (${inList(variants.length)})`).bind(...variants).first())
    return json({ error: "Этот номер уже зарегистрирован — войдите по нему" }, 409);
  const enc = new TextEncoder(),
    salt = crypto.getRandomValues(new Uint8Array(16)),
    key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]),
    bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256),
    q = await e.DB.prepare("INSERT INTO guests(name,phone,pin_salt,pin_hash) VALUES(?,?,?,?)")
      .bind(name, phone, b64(salt), b64(new Uint8Array(bits)))
      .run(),
    t = await session(e, Number(q.meta.last_row_id)),
    o = json({ ok: true, message: "Регистрация успешно сохранена" });
  o.headers.set("Set-Cookie", "bar_guest_session=" + t + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
  return o;
};
const login = async (r, e) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные формы" }, 400);
  }
  const pin = String(b?.pin || "");
  // Номер ищем во всех видах (8…, +7…): старые аккаунты могли сохраниться как угодно.
  const variants = phoneVariants(b?.phone);
  const { results } = await e.DB.prepare(
    `SELECT id,name,pin_salt,pin_hash FROM guests WHERE phone IN (${inList(variants.length)}) ORDER BY id`,
  )
    .bind(...variants)
    .all();
  if (!results?.length) return json({ error: "Неверный телефон или PIN" }, 401);
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  let g = null;
  for (const row of results) {
    let z = String(row.pin_salt).replace(/-/g, "+").replace(/_/g, "/");
    while (z.length % 4) z += "=";
    const salt = Uint8Array.from(atob(z), (c) => c.charCodeAt(0)),
      bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
    if (b64(new Uint8Array(bits)) === row.pin_hash) {
      g = row;
      break;
    }
  }
  if (!g) return json({ error: "Неверный телефон или PIN" }, 401);
  const t = await session(e, Number(g.id)),
    o = json({ ok: true, name: g.name });
  o.headers.set("Set-Cookie", "bar_guest_session=" + t + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
  return o;
};
const me = async (r, e) => {
  const m = (r.headers.get("Cookie") || "").match(/(?:^|;\s*)bar_guest_session=([^;]+)/);
  if (!m) return null;
  return await e.DB.prepare(
    "SELECT g.id,g.name,g.phone FROM guest_sessions s JOIN guests g ON g.id=s.guest_id WHERE s.token=? AND s.expires_at>datetime('now')",
  )
    .bind(m[1])
    .first();
};
const guestReviews = async (r, e) => {
  const g = await me(r, e);
  if (!g) return json({ error: "Войдите в аккаунт" }, 401);
  const q = await e.DB.prepare(
    "SELECT oi.id order_item_id,o.id order_id,oi.cocktail_id,c.name cocktail_name,oi.quantity,gr.rating,gr.comment,gr.created_at review_created_at FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN cocktails c ON c.id=oi.cocktail_id LEFT JOIN guest_reviews gr ON gr.order_item_id=oi.id AND gr.guest_id=o.guest_id WHERE o.guest_id=? AND o.status='served' ORDER BY o.id DESC,oi.id DESC LIMIT 100",
  )
    .bind(g.id)
    .all();
  return json({ items: q.results || [] });
};
const saveGuestReview = async (r, e, c) => {
  const g = await me(r, e);
  if (!g) return json({ error: "Войдите в аккаунт" }, 401);
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные формы" }, 400);
  }
  const itemId = Number(b?.order_item_id),
    rating = Number(b?.rating),
    comment = String(b?.comment || "").trim();
  if (!Number.isInteger(itemId) || itemId < 1) return json({ error: "Не найден коктейль для отзыва" }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: "Выберите оценку от 1 до 5" }, 400);
  if (comment.length > 500) return json({ error: "Комментарий не должен превышать 500 символов" }, 400);
  const item = await e.DB.prepare(
    "SELECT oi.id,oi.order_id,oi.cocktail_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=? AND o.guest_id=? AND o.status='served'",
  )
    .bind(itemId, g.id)
    .first();
  if (!item) return json({ error: "Оставить отзыв можно только на коктейль из выданного барменом заказа" }, 403);
  const exists = await e.DB.prepare("SELECT id FROM guest_reviews WHERE order_item_id=?").bind(itemId).first();
  if (exists) return json({ error: "На этот коктейль вы уже оставили отзыв" }, 409);
  try {
    await e.DB.prepare(
      "INSERT INTO guest_reviews(guest_id,order_item_id,order_id,cocktail_id,rating,comment) VALUES(?,?,?,?,?,?)",
    )
      .bind(g.id, itemId, Number(item.order_id), Number(item.cocktail_id), rating, comment)
      .run();
  } catch (err) {
    return json(
      {
        error:
          "Не удалось сохранить отзыв. Возможно, отзыв уже отправлен. Обновите кабинет и проверьте список отзывов.",
      },
      409,
    );
  }
  later(c, async () => {
    const ck = await e.DB.prepare("SELECT name FROM cocktails WHERE id=?").bind(Number(item.cocktail_id)).first();
    await notifyBar(e, {
      title: "Новый отзыв от: " + g.name,
      body: "★".repeat(rating) + "☆".repeat(5 - rating) + " " + (ck?.name || "Коктейль") + (comment ? " — «" + comment.slice(0, 90) + (comment.length > 90 ? "…" : "") + "»" : ""),
      url: "/bar/reviews",
      tag: "review-" + itemId,
    });
  });
  return json({ ok: true, message: "Отзыв сохранён" });
};
const serveGuestOrder = async (r, e, c) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные" }, 400);
  }
  const id = Number(b?.order_id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Неверный номер заказа" }, 400);
  const o = await e.DB.prepare("SELECT id,status FROM orders WHERE id=?").bind(id).first();
  if (!o) return json({ error: "Заказ не найден" }, 404);
  if (o.status !== "accepted") return json({ error: "Выдать можно только подтверждённый заказ" }, 409);
  await e.DB.prepare("UPDATE orders SET status='served',served_at=CURRENT_TIMESTAMP WHERE id=? AND status='accepted'")
    .bind(id)
    .run();
  notifyGuestOrder(e, c, id, "served");
  return json({ ok: true, order_id: id, status: "served" });
};
const guestOrder = async (r, e, c) => {
  const g = await me(r, e);
  if (!g) return json({ error: "Войдите в аккаунт" }, 401);
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные" }, 400);
  }
  const items = Array.isArray(b?.items) ? b.items : [];
  if (!items.length) return json({ error: "Заказ пуст" }, 400);
  const clean = [];
  let total = 0;
  for (const x of items) {
    const id = Number(x?.cocktail_id),
      qty = Number(x?.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 50) continue;
    const c = await e.DB.prepare("SELECT id,name,price_rub FROM cocktails WHERE id=? AND is_active=1").bind(id).first();
    if (!c) continue;
    clean.push({ id, qty, price: Number(c.price_rub || 0), name: c.name });
    total += qty * Number(c.price_rub || 0);
  }
  if (!clean.length) return json({ error: "В заказе нет доступных коктейлей" }, 400);
  // Заказать можно только то, на что сейчас хватает ингредиентов (с учётом других заказов).
  const shortage = await guestOrderShortage(e, clean);
  if (shortage) return json({ error: shortage }, 409);
  const q = await e.DB.prepare("INSERT INTO orders(guest_id,status,total_rub) VALUES(?,'pending',?)")
    .bind(g.id, total)
    .run();
  const oid = Number(q.meta.last_row_id);
  for (const x of clean)
    await e.DB.prepare("INSERT INTO order_items(order_id,cocktail_id,quantity,unit_price_rub) VALUES(?,?,?,?)")
      .bind(oid, x.id, x.qty, x.price)
      .run();
  later(c, () =>
    notifyBar(e, {
      title: "Новый заказ от: " + g.name,
      body: clean.map((x) => x.name + (x.qty > 1 ? " × " + x.qty : "")).join(", "),
      url: "/bar/orders",
      tag: "order-" + oid,
    }),
  );
  return json({ ok: true, order_id: oid, total_rub: total });
};
const stats = async (r, e) => {
  const g = await me(r, e);
  if (!g) return json({ guest: null });
  const a = await e.DB.prepare(
    "SELECT COUNT(*) orders_count,COALESCE(SUM(total_rub),0) spent_rub FROM orders WHERE guest_id=? AND status IN ('pending','accepted','served')",
  )
    .bind(g.id)
    .first();
  const c = await e.DB.prepare(
    "SELECT COALESCE(SUM(oi.quantity),0) cocktails_count FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.guest_id=? AND o.status IN ('pending','accepted','served')",
  )
    .bind(g.id)
    .first();
  // «За визит»: заказы после закрытия последней смены — счётчик обнуляется,
  // когда бармен закрывает смену (днём, вечером — неважно).
  const ses = await e.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(oi.quantity),0) FROM orders o JOIN order_items oi ON oi.order_id=o.id
       WHERE o.guest_id=?1 AND o.status IN ('pending','accepted','served') AND o.created_at>t.since) cocktails,
     (SELECT COALESCE(SUM(total_rub),0) FROM orders WHERE guest_id=?1 AND status IN ('pending','accepted','served') AND created_at>t.since) rub
     FROM (SELECT COALESCE(MAX(closed_at),'') since FROM bar_shifts WHERE status='closed') t`,
  )
    .bind(g.id)
    .first();
  const h = await e.DB.prepare(
    "SELECT o.id,o.status,o.total_rub,o.created_at,COALESCE(GROUP_CONCAT(c.name || ' × ' || oi.quantity, ', '),'') items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN cocktails c ON c.id=oi.cocktail_id WHERE o.guest_id=? GROUP BY o.id ORDER BY o.id DESC LIMIT 20",
  )
    .bind(g.id)
    .all();
  const latest = h.results?.[0] || null;
  let latestItems = [];
  if (latest) {
    const li = await e.DB.prepare(
      "SELECT oi.cocktail_id,oi.quantity,c.name cocktail_name,COALESCE(NULLIF(c.avatar_url,''),c.photo_url) photo_url FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN cocktails c ON c.id=oi.cocktail_id WHERE o.id=? AND o.guest_id=? ORDER BY oi.id",
    )
      .bind(latest.id, g.id)
      .all();
    latestItems = li.results || [];
    for (const item of latestItems) {
      if (item.photo_url) {
        try {
          const u = new URL(item.photo_url, "https://bar-menu.invalid");
          const key =
            u.searchParams.get("key") ||
            (u.pathname.startsWith("/api/cocktail-photo/")
              ? decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length))
              : "");
          if (key && key.startsWith("cocktails/"))
            item.photo_url = "/api/cocktail-photo?key=" + encodeURIComponent(key);
        } catch {}
      }
    }
  }
  const fav = await e.DB.prepare(
    "SELECT c.name FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN cocktails c ON c.id=oi.cocktail_id WHERE o.guest_id=? AND o.status IN ('pending','accepted','served') GROUP BY c.id,c.name ORDER BY SUM(oi.quantity) DESC,c.name LIMIT 1",
  )
    .bind(g.id)
    .first();
  return json({
    guest: g,
    orders_count: Number(a?.orders_count || 0),
    cocktails_count: Number(c?.cocktails_count || 0),
    spent_rub: Number(a?.spent_rub || 0),
    visit_cocktails: Number(ses?.cocktails || 0),
    visit_rub: Number(ses?.rub || 0),
    history: h.results || [],
    latest_order_items: latestItems,
    favorite_cocktail: fav?.name || null,
  });
};
const logout = async (r, e) => {
  const m = (r.headers.get("Cookie") || "").match(/(?:^|;\s*)bar_guest_session=([^;]+)/);
  if (m) await e.DB.prepare("DELETE FROM guest_sessions WHERE token=?").bind(m[1]).run();
  const o = json({ ok: true });
  o.headers.set("Set-Cookie", "bar_guest_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return o;
};
const guestOrders = async (r, e) => {
  const q = await e.DB.prepare(
    "SELECT o.id,o.guest_id,g.name guest_name,g.phone guest_phone,o.status,o.total_rub,o.created_at FROM orders o LEFT JOIN guests g ON g.id=o.guest_id WHERE o.status IN ('pending','accepted') ORDER BY o.id DESC LIMIT 50",
  ).all();
  const orders = [];
  for (const o of q.results || []) {
    const z = await e.DB.prepare(
      "SELECT oi.cocktail_id,c.name cocktail_name,oi.quantity FROM order_items oi JOIN cocktails c ON c.id=oi.cocktail_id WHERE oi.order_id=? ORDER BY oi.id",
    )
      .bind(o.id)
      .all();
    orders.push({ ...o, items: z.results || [] });
  }
  return json({ orders });
};
const acceptGuestOrder = async (r, e, c) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные" }, 400);
  }
  const id = Number(b?.order_id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Неверный номер заказа" }, 400);
  // Списание ингредиентов со склада — в момент «Принять».
  const [body, status] = await acceptGuestOrderWithStock(e, id);
  if (status === 200) notifyGuestOrder(e, c, id, "accepted");
  return json(body, status);
};
const rejectGuestOrder = async (r, e, c) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные" }, 400);
  }
  const id = Number(b?.order_id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Неверный номер заказа" }, 400);
  // Отклонить можно только ещё не принятый заказ: со склада он ничего не списывал, бронь снимается.
  const q = await e.DB.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").bind(id).run();
  if (!Number(q.meta?.changes)) return json({ error: "Заказ уже обработан" }, 409);
  notifyGuestOrder(e, c, id, "cancelled");
  return json({ ok: true, order_id: id, status: "cancelled" });
};
// ——— Подписка на уведомления ———
const pushKey = async (r, e) => json({ publicKey: (await getVapid(e)).publicKey });
const pushSubscribe = async (r, e) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные" }, 400);
  }
  const role = b?.role === "guest" ? "guest" : b?.role === "bar" ? "bar" : "";
  if (!role) return json({ error: "Неизвестная роль" }, 400);
  const bs = role === "bar" ? await barSession(r, e) : null;
  if (role === "bar" && !bs) return authRequired();
  let guestId = null;
  if (role === "guest") {
    const g = await me(r, e);
    if (!g) return json({ error: "Войдите в аккаунт" }, 401);
    guestId = g.id;
  }
  if (!(await saveSubscription(e, role, guestId, b?.subscription, deviceLabel(r), bs?.id ?? null))) return json({ error: "Некорректная подписка" }, 400);
  return json({ ok: true });
};
const pushUnsubscribe = async (r, e) => {
  let b;
  try {
    b = await r.json();
  } catch {
    return json({ error: "Некорректные данные" }, 400);
  }
  await removeSubscription(e, b?.role === "guest" ? "guest" : "bar", b?.endpoint);
  return json({ ok: true });
};
// Заказ за стойкой принят — сообщаем остальным телефонам бармена (не тому, с которого приняли).
const acceptBarOrder = async (r, e, c) => {
  const res = await App.fetch(r, e, c);
  if (!res.ok) return res;
  const d = await res.json();
  const s = await barSession(r, e);
  const sid = s?.id ?? -1;
  const [items, cnt] = await e.DB.batch([
    e.DB.prepare("SELECT c.name,oi.quantity qty FROM bar_order_items oi JOIN cocktails c ON c.id=oi.cocktail_id WHERE oi.order_id=? ORDER BY oi.id").bind(Number(d.order_id)),
    e.DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE role='bar' AND (bar_session_id IS NULL OR bar_session_id<>?)").bind(sid),
  ]);
  const list = items.results || [],
    notified = list.length ? Number(cnt.results?.[0]?.n || 0) : 0;
  if (notified)
    later(c, () =>
      notifyBar(e, { title: "Заказ за стойкой", body: list.map((x) => x.name + (x.qty > 1 ? " × " + x.qty : "")).join(", "), url: "/bar/orders", tag: "bar-order-" + d.order_id }, sid),
    );
  return json({ ...d, notified });
};
// «Ещё → Уведомления»: состояние подписок бармена и тестовое уведомление (только после входа).
const pushBarStatus = async (r, e) => {
  const b = await r.json().catch(() => ({}));
  return json({ devices: await barPushStatus(e, b?.endpoint) });
};
const pushBarTest = async (r, e, c) => {
  const b = await r.json().catch(() => ({}));
  const t = await barPushTest(e, b?.endpoint, 5000);
  if (!t) return json({ error: "Этот телефон не подписан на уведомления — нажмите «Включить»" }, 404);
  c.waitUntil(t.job.catch((err) => console.error("push test:", err?.message)));
  return json({ ok: true });
};
const needsDb = (p) => (p.startsWith("/api/") && p !== "/api/health" && !p.startsWith("/api/cocktail-photo")) || isBarPage(p);
// Посетителю без входа список коктейлей отдаётся без остатков склада (меню они не нужны).
const withoutStock = async (res) => {
  if (!res.ok) return res;
  const list = await res.json();
  for (const c of Array.isArray(list) ? list : []) for (const i of c.recipe_items || []) delete i.stock_available;
  return json(list);
};
export default {
  async fetch(r, e, c) {
    const u = new URL(r.url);
    const gated = needsBarAuth(u.pathname, r.method);
    if (gated || needsDb(u.pathname)) await ensureSchema(e);
    if (u.pathname === "/api/bar/auth" || u.pathname.startsWith("/api/bar/auth/"))
      return (await barAuthApi(r, e, u)) || json({ error: "Не найдено" }, 404);
    // Панель бармена: страницы и данные — только после входа по коду.
    if (gated && !(await barSession(r, e))) return isBarPage(u.pathname) ? barLoginPage(r, e) : authRequired();
    if (u.pathname === "/api/cocktails" && r.method === "GET" && !(await barSession(r, e)))
      return withoutStock(await App.fetch(r, e, c));
    if (u.pathname === "/api/guest/register" && r.method === "POST") return register(r, e);
    if (u.pathname === "/api/guest/login" && r.method === "POST") return login(r, e);
    if (u.pathname === "/api/guest/me" && r.method === "GET") return json({ guest: await me(r, e) });
    if (u.pathname === "/api/guest/logout" && r.method === "POST") return logout(r, e);
    if (u.pathname === "/api/guest/order" && r.method === "POST") return guestOrder(r, e, c);
    if (u.pathname === "/api/guest/stats" && r.method === "GET") return stats(r, e);
    if (u.pathname === "/api/guest/reviews" && r.method === "GET") return guestReviews(r, e);
    if (u.pathname === "/api/guest/reviews" && r.method === "POST") return saveGuestReview(r, e, c);
    if (u.pathname === "/api/bar/guest-order/serve" && r.method === "POST") return serveGuestOrder(r, e, c);
    if (u.pathname === "/api/bar/guest-orders" && r.method === "GET") return guestOrders(r, e);
    if (u.pathname === "/api/bar/guest-order/accept" && r.method === "POST") return acceptGuestOrder(r, e, c);
    if (u.pathname === "/api/bar/guest-order/reject" && r.method === "POST") return rejectGuestOrder(r, e, c);
    if (u.pathname === "/api/bar/order/accept" && r.method === "POST") return acceptBarOrder(r, e, c);
    if (u.pathname === "/api/bar/push/status" && r.method === "POST") return pushBarStatus(r, e);
    if (u.pathname === "/api/bar/push/test" && r.method === "POST") return pushBarTest(r, e, c);
    if (u.pathname === "/api/push/key" && r.method === "GET") return pushKey(r, e);
    if (u.pathname === "/api/push/subscribe" && r.method === "POST") return pushSubscribe(r, e);
    if (u.pathname === "/api/push/unsubscribe" && r.method === "POST") return pushUnsubscribe(r, e);
    // /menu и /bar/orders целиком рендерятся в index.js (без подмены HTML строками).
    return App.fetch(r, e, c);
  },
};
