// node shoot-ids.mjs <page.html> <out-prefix> id1 id2 …
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
const dir = new URL(".", import.meta.url).pathname;
const [page, prefix, ...ids] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 2 });
await p.goto("file://" + dir + page); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
for (const id of ids) await p.locator("#" + id).screenshot({ path: dir + "shots/" + prefix + id + ".png" });
await b.close(); console.log("готово");
