// Версия 3 (нынешний сайт) на локальной копии с тестовыми данными: node shoot.mjs → shots/*.png
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs";
const HERE = new URL(".", import.meta.url).pathname, B = "http://127.0.0.1:8780";
fs.mkdirSync(HERE + "shots", { recursive: true });
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--font-render-hinting=none"] });
const errs = [];
const mk = async () => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU", serviceWorkers: "block", colorScheme: "dark" });
  const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => d.dismiss());
  return { ctx, p };
};
const settle = async (p, t = 700) => { await p.waitForLoadState("networkidle").catch(() => {}); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(t); };
const shot = async (p, n) => { await p.screenshot({ path: HERE + "shots/" + n + ".png" }); console.log("снято", n); };
const click = async (p, sel, t = 900) => { const el = p.locator(sel).first(); if (!(await el.count())) { console.log("нет", sel); return false; } await el.evaluate((e) => e.click()); await p.waitForTimeout(t); return true; };

// ── гость без входа ──
{
  const { ctx, p } = await mk();
  await p.goto(B + "/menu#profile"); await settle(p);
  await p.evaluate(() => window.VIA && VIA.openSheet && VIA.openSheet("authSheet")); await p.waitForTimeout(900);
  await click(p, "#authTabReg", 600);
  await shot(p, "g6-auth");
  await ctx.close();
}
// ── гость Мария ──
{
  const { ctx, p } = await mk();
  await p.goto(B + "/menu");
  await p.evaluate(async () => { await fetch("/api/guest/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+79990000102", pin: "1234" }) }); });
  const cs = await p.evaluate(async () => (await fetch("/api/cocktails")).json()); const id = (n) => cs.find((c) => c.name === n).id;
  await p.evaluate((c) => localStorage.setItem("via.cart", JSON.stringify(c)), { [id("Голубая лагуна")]: 1, [id("Маргарита")]: 2 });
  await p.goto(B + "/menu"); await p.reload(); await p.waitForSelector("#menuList .menu-row"); await settle(p); await shot(p, "g1-menu");
  await p.evaluate(() => { const h = [...document.querySelectorAll(".line-head")]; (h[2] || h[1]).scrollIntoView(); window.scrollBy(0, -70); }); await p.waitForTimeout(400); await shot(p, "g2-menu-strong");
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.locator('#menuList .menu-row:has-text("Голубая лагуна") [data-open]').first().evaluate((e) => e.click()); await p.waitForTimeout(900); await shot(p, "g3-card");
  await p.goto(B + "/menu#order"); await p.reload(); await settle(p, 900); await shot(p, "g4-order");
  await p.goto(B + "/menu#profile"); await p.reload(); await p.waitForSelector(".member-card"); await settle(p); await shot(p, "g5-profile");
  if (await click(p, 'button:has-text("Мои оценки"), [data-open-sheet="reviewsSheet"]', 1300)) await shot(p, "g7-reviews");
  await ctx.close();
}
// ── бармен: экран входа ──
{ const { ctx, p } = await mk(); await p.goto(B + "/bar/orders"); await settle(p); await shot(p, "b0-login"); await ctx.close(); }
// ── бармен ──
{
  const { ctx, p } = await mk();
  await p.goto(B + "/bar");
  await p.evaluate(async () => { await fetch("/api/bar/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "246810" }) }); });
  await p.goto(B + "/bar/orders"); await settle(p, 1000); await shot(p, "b1-orders");
  if (await click(p, '.segmented button:has-text("Стойка"), [role="tab"]:has-text("Стойка"), button:has-text("Стойка")')) await shot(p, "b2-counter");
  await p.goto(B + "/bar/recipes"); await settle(p, 1000); await shot(p, "b3-recipes");
  if (await click(p, '.rb-row:has-text("Голубая лагуна") .rb-open', 1000)) {
    await shot(p, "b4-recipe");
    if (await click(p, '#detailSheet button:has-text("Изменить"), #detailSheet [data-edit], #detailEdit', 1200)) await shot(p, "b5-edit");
  }
  for (const [u, n, t] of [["/bar/stock", "b6-stock", 1000], ["/bar/shop", "b7-shop", 1000], ["/bar", "b8-more", 900], ["/bar/statistics", "b9-statistics", 1200], ["/bar/reviews", "b10-reviews", 900], ["/bar/ingredients", "b11-ingredients", 900]]) {
    await p.goto(B + u); await settle(p, t); await shot(p, n);
  }
  await ctx.close();
}
console.log("ошибки:", errs.length ? errs : "нет");
await b.close();
