// Только меню гостя: node shoot-menu.mjs <port> <prefix>
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs";
const HERE = new URL(".", import.meta.url).pathname;
const [port, prefix] = process.argv.slice(2);
const B = "http://127.0.0.1:" + port;
const jars = JSON.parse(fs.readFileSync(HERE + "jars-8771.json", "utf8"));
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
for (const who of [null, "g2"]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block" });
  if (who) await ctx.addCookies(jars[who].split("; ").map((kv) => { const [name, ...v] = kv.split("="); return { name, value: v.join("="), url: B }; }));
  const p = await ctx.newPage();
  await p.goto(B + "/menu", { waitUntil: "networkidle" }).catch(() => {}); await p.waitForTimeout(1200);
  await p.screenshot({ path: `${HERE}shots/${prefix}-${who ? "menu-guest" : "menu"}.png` });
  if (!who) { await p.evaluate(() => window.scrollTo(0, 760)); await p.waitForTimeout(300); await p.screenshot({ path: `${HERE}shots/${prefix}-menu-scroll.png` }); }
  await ctx.close();
}
await b.close(); console.log("готово", prefix);
