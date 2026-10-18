// Версия 1 (февраль): открывает index.html и barmen_list.html на нужном коммите
// и вместо Google-таблиц (opensheet, gviz) подставляет данные нынешнего меню.
// node shoot.mjs  → shots/*.png
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const SP = HERE + "../../";
const GIT = SP + "full.git";
const cocktails = JSON.parse(fs.readFileSync(SP + "club/data/cocktails.json", "utf8"));
const products = JSON.parse(fs.readFileSync(SP + "club/data/products.json", "utf8"));
const purchases = JSON.parse(fs.readFileSync(SP + "club/data/shop_purchases_period_month.json", "utf8"));
fs.mkdirSync(HERE + "shots", { recursive: true });

// ── код версии на коммите ──
const checkout = (commit) => {
  const dir = HERE + "code/" + commit;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("sh", ["-c", `git -C "${GIT}" archive ${commit} | tar -x -C "${dir}"`]);
  }
  return dir;
};
const finalDir = checkout("93057aa");
const imgs = fs.readdirSync(finalDir + "/img");
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z]/g, "");
const photoOf = (name) => {
  const f = imgs.find((x) => norm(x.replace(/\.jpg$/, "")) === norm(name)) ||
    imgs.find((x) => norm(name).slice(0, 6) === norm(x).slice(0, 6));
  return f ? "img/" + f : "";
};

// ── данные таблицы ──
const unitRu = (u) => (u === "g" ? "г" : "мл");
const priceOf = Object.fromEntries(products.map((p) => [p.ingredient_name, p.unit_price]));
const strengthRu = (s) => s.toLowerCase();
const MENU = (withPhoto, rub) => cocktails.map((c) => ({
  Коктейль: c.name, Цена: rub ? c.price_rub + " ₽" : c.price_rub, Крепость: strengthRu(c.strength),
  Состав: c.recipe_items.map((i) => i.ingredient_name).join(", "), Фото: withPhoto ? photoOf(c.name) : "",
}));
const gviz = (rows) => "/*O_o*/\ngoogle.visualization.Query.setResponse(" + JSON.stringify({ version: "0.6", status: "ok", table: { cols: [], rows } }) + ");";
const cell = (v) => (v === undefined || v === null || v === "" ? null : { v });
// техкарты БАР_КУХНЯ: строка коктейля + строки ингредиентов; справа (столбцы 12–16) — лист закупок
const kitchenRows = () => {
  const rows = [];
  cocktails.forEach((c, k) => {
    const tools = String(c.glass || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const cost = Math.round(c.recipe_items.reduce((s, i) => s + i.quantity * (priceOf[i.ingredient_name] || 0), 0));
    c.recipe_items.forEach((i, j) => {
      const r = new Array(17).fill(null);
      if (j === 0) { r[0] = cell(k + 1); r[1] = cell(c.name); r[3] = cell(cost); r[10] = cell(c.method || ""); }
      r[5] = cell(i.ingredient_name); r[6] = cell(i.quantity); r[7] = cell(unitRu(i.unit)); r[8] = cell(1); r[9] = cell(tools[j] || null);
      rows.push({ c: r });
    });
  });
  purchases.slice(0, 14).forEach((p, k) => {
    rows[k] = rows[k] || { c: new Array(17).fill(null) };
    rows[k].c[12] = cell(p.ingredient_name); rows[k].c[13] = cell(p.brand); rows[k].c[14] = cell(p.purchased_qty); rows[k].c[16] = cell(p.price_rub);
  });
  return rows;
};
const stockGviz = () => products.map((p) => ({ c: [cell(p.ingredient_name), cell(p.stock)] }));
const stockSheet = () => products.map((p) => ({ "ID ингредиента": p.ingredient_name, Остаток: String(p.stock) }));
// смены — условный пример за февраль
const SHIFTS = [
  ["13.02.2026 22:40", "Виски - Кола", 3], ["13.02.2026 22:40", "Маргарита", 2], ["13.02.2026 22:40", "Голубая лагуна", 2],
  ["14.02.2026 23:15", "Вишневый фиеро", 4], ["14.02.2026 23:15", "Пина колада", 2], ["14.02.2026 23:15", "Текила санрайз", 3], ["14.02.2026 23:15", "Шот медуза", 6],
  ["17.02.2026 21:50", "Куба либре", 2], ["17.02.2026 21:50", "Изумрудная кровь", 2],
].map(([d, n, q]) => {
  const c = cocktails.find((x) => x.name === n);
  const cost = c.recipe_items.reduce((s, i) => s + i.quantity * (priceOf[i.ingredient_name] || 0), 0);
  return { Дата: d, Коктейль: n, "Кол-во": String(q), Себестоимость: String(Math.round(cost * q)) };
});

// ── браузер ──
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
async function open(commit, file, { photo = true, rub = true } = {}) {
  const dir = checkout(commit);
  if (!fs.existsSync(dir + "/img")) fs.cpSync(finalDir + "/img", dir + "/img", { recursive: true });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route("**/*", (r) => {
    const u = decodeURIComponent(r.request().url());
    const json = (x) => r.fulfill({ contentType: "application/json", body: JSON.stringify(x) });
    const text = (x) => r.fulfill({ contentType: "text/plain", body: x });
    if (u.includes("opensheet") && u.endsWith("/MENU")) return json(MENU(photo, rub));
    if (u.includes("opensheet") && u.endsWith("/СМЕНЫ")) return json(SHIFTS);
    if (u.includes("opensheet") && u.endsWith("/Открытый_склад")) return json(stockSheet());
    if (u.includes("gviz") && u.includes("БАР_КУХНЯ")) return text(gviz(kitchenRows()));
    if (u.includes("gviz") && u.includes("Открытый_склад")) return text(gviz(stockGviz()));
    if (u.startsWith("file://")) return r.continue();
    return r.abort();
  });
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.dismiss());
  await p.goto("file://" + dir + "/" + file);
  await p.waitForTimeout(1200);
  return { p, ctx };
}
const shot = async (p, name, opts = {}) => { await p.screenshot({ path: HERE + "shots/" + name + ".png", ...opts }); console.log("снято", name); };

// 1. Самая первая страница (12.02, 15:44): список без фото
{ const { p, ctx } = await open("3f29725", "index.html", { photo: false, rub: false }); await shot(p, "01-first"); await ctx.close(); }
// 2. Конец первого дня (12.02, 20:42): фильтр, поиск, «Что выпить?»
{ const { p, ctx } = await open("6013c5e", "index.html", { photo: false }); await shot(p, "02-day1"); await ctx.close(); }
// 3–5. Финальное меню (17.02): с фото; прокрутка; «Что выпить?»
{
  const { p, ctx } = await open("93057aa", "index.html");
  await shot(p, "03-menu");
  await p.evaluate(() => window.scrollTo(0, 1150)); await p.waitForTimeout(200); await shot(p, "04-menu-scroll");
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.selectOption("#strength", { index: 3 }).catch(() => {});
  await p.waitForTimeout(200); await shot(p, "05-filter");
  await p.selectOption("#strength", { index: 0 }).catch(() => {});
  await p.evaluate(() => randomDrink()); await p.waitForTimeout(3600); await shot(p, "06-random");
  await ctx.close();
}
// 7. Первая панель бармена (13.02)
{ const { p, ctx } = await open("6789910", "barmen_list.html"); await p.evaluate(() => { try { plus(0); plus(0); plus(8); } catch (e) {} }); await shot(p, "07-bar-first"); await ctx.close(); }
// 8. Панель PRO (16.02)
{ const { p, ctx } = await open("ce2449b", "barmen_list.html"); await p.evaluate(() => { try { plus(0); plus(0); plus(8); } catch (e) {} }); await shot(p, "08-bar-pro"); await ctx.close(); }
// 9–12. Финальная панель (18.02): Бар, ниже по списку, Магазин, Учёт
{
  const { p, ctx } = await open("93057aa", "barmen_list.html");
  await p.evaluate(() => { plus(0); plus(0); plus(8); plus(3); });
  await shot(p, "09-bar");
  await p.evaluate(() => window.scrollTo(0, 2350)); await p.waitForTimeout(200); await shot(p, "10-bar-miss");
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click("text=🛒 Магазин"); await p.waitForTimeout(700); await shot(p, "11-shop");
  await p.click("text=📊 Учёт"); await p.waitForTimeout(700); await shot(p, "12-account");
  await ctx.close();
}
await b.close();
