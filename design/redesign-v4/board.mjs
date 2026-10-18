import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
const dir = new URL(".", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1318, height: 1000 }, deviceScaleFactor: 1.5 });
for (const k of ["gl", "gd", "bd", "bl"]) {
  await p.goto("file://" + dir + "board.html?b=" + k);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: dir + "board-" + k + ".png", fullPage: true });
}
await b.close();
