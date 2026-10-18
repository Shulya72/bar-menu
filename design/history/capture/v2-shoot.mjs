// Съёмка экранов версии 2: node shoot.mjs <port> <prefix> <набор>
// набор: final — финальная версия 13.10; early — ранние вехи (только то, что есть в коде).
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
const [port, prefix, set] = process.argv.slice(2);
const B = "http://127.0.0.1:" + port;
fs.mkdirSync(HERE + "shots", { recursive: true });
const jars = fs.existsSync(HERE + "jars-8771.json") ? JSON.parse(fs.readFileSync(HERE + "jars-8771.json", "utf8")) : {};
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
async function ctxFor(who) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block" });
  if (who && jars[who]) await ctx.addCookies(jars[who].split("; ").map((kv) => { const [name, ...v] = kv.split("="); return { name, value: v.join("="), url: B }; }));
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.dismiss());
  return { ctx, p };
}
const go = async (p, path, wait = 1200) => { await p.goto(B + path, { waitUntil: "networkidle" }).catch(() => {}); await p.waitForTimeout(wait); };
const shot = async (p, name) => { await p.screenshot({ path: HERE + "shots/" + prefix + "-" + name + ".png" }); console.log("снято", prefix + "-" + name); };
const tryClick = async (p, sel) => { const el = p.locator(sel).first(); if (await el.count()) { await el.click({ timeout: 3000 }).catch(() => {}); await p.waitForTimeout(700); return true; } return false; };

// ── гость ──
{
  const { ctx, p } = await ctxFor(null);
  await go(p, "/"); await shot(p, "01-root");
  await go(p, "/menu"); await shot(p, "02-menu");
  await p.evaluate(() => window.scrollTo(0, 900)); await p.waitForTimeout(300); await shot(p, "03-menu-scroll");
  await p.evaluate(() => window.scrollTo(0, 0));
  if (await tryClick(p, "text=Войти")) await shot(p, "04-login");
  await ctx.close();
}
{
  const { ctx, p } = await ctxFor("g2");
  await go(p, "/menu");
  const plus = p.locator('button:text-is("+")');
  if (await plus.count()) { await plus.nth(0).click().catch(() => {}); await p.waitForTimeout(400); await plus.nth(1).click().catch(() => {}); await p.waitForTimeout(400); await plus.nth(1).click().catch(() => {}); await p.waitForTimeout(800); }
  await shot(p, "05-menu-order");
  if (await tryClick(p, "#guestOrderPanel button:has-text(\"К заказу\")")) await shot(p, "06-order");
  await go(p, "/menu");
  if (await tryClick(p, "text=Мария")) await shot(p, "07-account");
  await ctx.close();
}
// ── бармен ──
{
  const { ctx, p } = await ctxFor(null);
  for (const [path, name, wait] of [["/bar", "10-bar", 1000], ["/bar/orders", "11-orders", 1500], ["/bar/recipes", "12-recipes", 1500], ["/bar/stock", "13-stock", 1500], ["/bar/shop", "14-shop", 1500], ["/bar/ingredients", "15-ingredients", 1200], ["/bar/statistics", "16-statistics", 3500]]) {
    await go(p, path, wait); await shot(p, name);
  }
  // книга рецептов: раскрытая карточка
  await go(p, "/bar/recipes", 1500);
  const exp = p.locator("button:has-text('⌄'), .expand, .toggle, button[aria-label*='Подробнее']").first();
  if (await exp.count()) { await exp.click().catch(() => {}); await p.waitForTimeout(600); await shot(p, "12b-recipe-open"); }
  await ctx.close();
}
await b.close();
