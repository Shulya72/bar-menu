// Наполняет локальную копию ВЕРСИИ 2 (порт из аргумента) живым меню через её собственное API.
// node seed.mjs <port> [--no-guests]
import fs from "node:fs";
const S = "/tmp/claude-0/-home-user-bar-menu/aa42c056-ddf6-5d12-ad1a-75969d517483/scratchpad";
const B = "http://127.0.0.1:" + process.argv[2], L = S + "/redesign/live/";
const live = JSON.parse(fs.readFileSync(L + "cocktails.json", "utf8")), photos = JSON.parse(fs.readFileSync(L + "photos.json", "utf8"));
const jars = {};
const call = async (who, path, method = "GET", body, raw) => {
  const h = { ...(jars[who] ? { cookie: jars[who] } : {}) }; let b;
  if (raw) b = raw; else if (body) { h["content-type"] = "application/json"; b = JSON.stringify(body); }
  const r = await fetch(B + path, { method, headers: h, body: b });
  for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(";")[0]; if (!/=$/.test(kv)) { const n = kv.split("=")[0]; jars[who] = ((jars[who] || "").split("; ").filter((x) => x && !x.startsWith(n + "=")).concat(kv)).join("; "); } }
  let d = null; try { d = await r.json(); } catch {}
  if (!r.ok && r.status !== 409) console.log("!", method, path, r.status, JSON.stringify(d).slice(0, 160));
  return d;
};
const ing = {};
for (const c of live) for (const i of c.recipe_items || []) ing[i.ingredient_name] = { unit: i.unit, strength: Number(i.strength_percent || 0) };
const ids = {};
for (const [name, v] of Object.entries(ing)) { const d = await call("bar", "/api/ingredients", "POST", { name, unit: v.unit, strength_percent: v.strength }); ids[name] = d?.id; }
const all = await call("bar", "/api/ingredients"); for (const x of Array.isArray(all) ? all : all?.ingredients || []) ids[x.name] = x.id;
console.log("ингредиентов:", Object.keys(ids).length);
// закупки: в версии 2 — количество и общая цена
const P = [
  ["2026-10-04", "Водка", "Белуга Noble", 1400, 3180, "Ароматный мир"], ["2026-10-04", "Ром белый", "Bacardi Carta Blanca", 700, 1690, "Ароматный мир"], ["2026-10-04", "Ром темный", "Captain Morgan Dark", 700, 1790, "Ароматный мир"],
  ["2026-10-04", "Текила Silver", "Olmeca Silver", 700, 2190, "Ароматный мир"], ["2026-10-04", "Виски", "Jameson", 700, 2390, "Ароматный мир"], ["2026-10-04", "Абсент", "Xenta", 500, 2490, "Ароматный мир"],
  ["2026-10-10", "Ликер Blue Curacao", "Bols Blue", 700, 1290, "Красное&Белое"], ["2026-10-10", "Ликер Triple Sec", "De Kuyper", 700, 1190, "Красное&Белое"], ["2026-10-10", "Ликер Jagermeister", "Jägermeister", 700, 1990, "Красное&Белое"],
  ["2026-10-10", "MARTINI Fiero", "Martini Fiero", 1000, 1390, "Красное&Белое"], ["2026-10-10", "Джин Апельсиновый", "Gordon's Orange", 700, 1590, "Красное&Белое"],
  ["2026-10-12", "Coca-Cola", "Coca-Cola", 3000, 318, "Перекрёсток"], ["2026-10-12", "Sprite", "Sprite", 3000, 298, "Перекрёсток"], ["2026-10-12", "Тоник Апероль", "Schweppes Aperitivo", 1000, 139, "Перекрёсток"],
  ["2026-10-12", "Энергетик", "Adrenaline Rush", 898, 258, "Перекрёсток"], ["2026-10-12", "Тархун", "Черноголовка Тархун", 500, 89, "Перекрёсток"], ["2026-10-12", "Сок вишневый", "Rich вишня", 1000, 199, "Перекрёсток"],
  ["2026-10-12", "Сок апельсиновый", "Rich апельсин", 1000, 189, "Перекрёсток"], ["2026-10-12", "Сок лимона", "Сицилия", 400, 338, "Перекрёсток"], ["2026-10-12", "Сок лайма", "Сицилия", 400, 358, "Перекрёсток"],
  ["2026-10-12", "Сироп Кокосовый", "Monin", 700, 890, "Перекрёсток"], ["2026-10-12", "Сироп Гренадин", "Monin", 700, 890, "Перекрёсток"], ["2026-10-12", "Сироп Blue Curacao", "Monin", 700, 890, "Перекрёсток"],
  ["2026-10-12", "Ананас", "Ананас в кусочках", 565, 229, "Перекрёсток"], ["2026-10-12", "Взбитые сливки", "Простоквашино", 250, 269, "Перекрёсток"], ["2026-10-12", "Сливки", "Простоквашино 33%", 500, 239, "Перекрёсток"],
  ["2026-10-13", "Лед", "Лёд пищевой", 6000, 447, "ВкусВилл"], ["2026-10-13", "Соль", "Соль морская", 500, 79, "ВкусВилл"],
];
for (const [date, name, brand, qty, price, store] of P) { if (!ids[name]) { console.log("нет ингредиента", name); continue; }
  await call("bar", "/api/shop/purchase", "POST", { ingredient_id: ids[name], quantity: qty, price_rub: price, brand, store, purchased_at: date }); }
const up = async (file, type) => { const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(L + file)], { type }), type.includes("webp") ? "a.webp" : "p.jpg"); const d = await call("bar", "/api/cocktail-photo", "POST", null, fd); return d?.url || ""; };
for (const [k, c] of live.entries()) {
  const p = photos[k];
  const photo_url = await up(p.photo_url[0], "image/jpeg"), avatar_url = await up(p.avatar_url[0], "image/webp");
  await call("bar", "/api/cocktails", "POST", { name: c.name, description: c.description, category: c.category || "", strength: c.strength, glass: c.glass, inventory: c.glass, method: c.method, garnish: c.garnish, photo_url, avatar_url,
    recipe_items: (c.recipe_items || []).map((i) => ({ ingredient_id: ids[i.ingredient_name], quantity: i.quantity })) });
}
console.log("коктейлей:", (await call("bar", "/api/cocktails")).length);
if (!process.argv.includes("--no-guests")) {
  const cs = await call("bar", "/api/cocktails"); const C = (n) => cs.find((c) => c.name === n)?.id;
  const guest = (who, name, phone) => call(who, "/api/guest/register", "POST", { name, phone, pin: "1234" });
  await guest("g1", "Олег", "+79990000101"); await guest("g2", "Мария", "+79990000102"); await guest("g3", "Анна", "+79990000103");
  await call("bar", "/api/bar/shift", "POST");
  const order = (who, items) => call(who, "/api/guest/order", "POST", { items: items.map(([n, q]) => ({ cocktail_id: C(n), quantity: q })) });
  let o = await order("g1", [["Куба либре", 1]]); await call("bar", "/api/bar/guest-order/accept", "POST", { order_id: o?.order_id }); await call("bar", "/api/bar/guest-order/serve", "POST", { order_id: o?.order_id });
  let rv = await call("g1", "/api/guest/reviews"); if (rv?.items?.[0]) await call("g1", "/api/guest/reviews", "POST", { order_item_id: rv.items[0].order_item_id, rating: 5, comment: "Лучшая куба либре в городе!" });
  o = await order("g2", [["Пина колада", 1]]); await call("bar", "/api/bar/guest-order/accept", "POST", { order_id: o?.order_id }); await call("bar", "/api/bar/guest-order/serve", "POST", { order_id: o?.order_id });
  o = await order("g2", [["Текила санрайз", 1]]); await call("bar", "/api/bar/guest-order/accept", "POST", { order_id: o?.order_id });
  await order("g3", [["Голубая лагуна", 1], ["Маргарита", 1]]);
  await order("g2", [["Джин Spritz", 2]]);
  await call("bar", "/api/bar/order", "POST", { cocktail_id: C("Виски - Кола"), delta: 1 });
  await call("bar", "/api/bar/order", "POST", { cocktail_id: C("Виски - Кола"), delta: 1 });
  await call("bar", "/api/bar/order", "POST", { cocktail_id: C("Маргарита"), delta: 1 });
}
const fin = await call("bar", "/api/cocktails");
console.log(fin.map((c) => `${c.name}: ${c.price_rub} ₽`).join(" | "));
fs.writeFileSync(new URL(".", import.meta.url).pathname + "jars-" + process.argv[2] + ".json", JSON.stringify(jars));
