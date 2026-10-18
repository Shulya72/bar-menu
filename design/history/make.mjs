// Печать единой книги: node make.mjs → VIA-Family-Bar-история-создания.pdf
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
const dir = new URL(".", import.meta.url).pathname, out = "VIA-Family-Bar-история-создания.pdf";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 600, height: 1180 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("requestfailed", (r) => errs.push("не загрузилось: " + r.url()));
await p.goto("file://" + dir + "kniga.html", { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
// что вылезает за низ страницы (выше подвала)
const over = await p.$$eval(".pg", (pgs) => pgs.map((pg, i) => {
  const top = pg.getBoundingClientRect().top; let max = 0;
  for (const el of pg.querySelectorAll("*")) { if (el.closest(".foot,.eras") || el.classList.contains("num")) continue; max = Math.max(max, el.getBoundingClientRect().bottom - top); }
  return [i + 1, Math.round(max)];
}).filter(([, m]) => m > 1140));
// правильные названия закладок: Chromium теряет пробел там, где заголовок переносится на новую строку
const heads = await p.$$eval("h1,h2", (hs) => hs.map((h) => {
  const t = h.textContent.replace(/\s+/g, " ").trim(), v = h.closest(".cover")?.querySelector(".v");
  return v ? `Вариация ${v.textContent.match(/\d/)[0]}. ${t}` : t;
}));
fs.writeFileSync(dir + "heads.json", JSON.stringify(heads));
await p.pdf({ path: dir + out, width: "600px", height: "1180px", printBackground: true, preferCSSPageSize: true, outline: true, tagged: true });
console.log(out, "| страниц:", await p.$$eval(".pg", (a) => a.length), "| вылезает:", over.length ? JSON.stringify(over) : "нет", "| ошибки:", errs.length ? errs : "нет");
await b.close();
execFileSync("python3", ["-I", dir + "fix_outline.py", dir + out, dir + "heads.json"], { stdio: "inherit" });
