// VIA Bar — общая дизайн-система «Слоновая кость и бордо»: светлый премиальный бар
// (слоновая кость, бордо, латунное золото), iOS-каркас (крупные заголовки, панель вкладок,
// шторки) и фирменный приём «Маршрут VIA»: статусы и шаги заказа — станции на линии.

// Линии крепости. Ключ — значение поля cocktails.strength.
export const STRENGTH_LINES = [
  { key: "Безалкогольный", cls: "line-zero", short: "0%" },
  { key: "Лёгкий", cls: "line-light", short: "лёгкий" },
  { key: "Средний", cls: "line-mid", short: "средний" },
  { key: "Крепкий", cls: "line-strong", short: "крепкий" },
];

// Иконки: одна сетка 24×24, линия 1.6, скруглённые концы (в духе SF Symbols).
const ICONS = {
  glass: '<path d="M5 4h14l-7 8z"/><path d="M12 12v7"/><path d="M8 20h8"/><path d="M15.5 4.5 18 2"/>',
  coupe: '<path d="M3.5 5.5h17c0 4.4-3.8 7.6-8.5 7.6S3.5 9.9 3.5 5.5z"/><path d="M12 13.1V20M8 20.2h8"/>',
  chit: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  book: '<path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h11"/><path d="M9.5 8h5"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5"/><path d="M12 12v9"/>',
  bottle: '<path d="M10 2.5h4v4.2c0 1 2.5 2.2 2.5 5v8.3a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5v-8.3c0-2.8 2.5-4 2.5-5z"/><path d="M7.5 13.5h9"/>',
  bag: '<path d="M4.5 8h15l-1 12.5h-13z"/><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z"/><path d="M5 19l8-8"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-4"/><path d="M12 16V7"/><path d="M17 16v-6"/>',
  person: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20.5c1-3.9 3.8-6 7.2-6s6.2 2.1 7.2 6"/>',
  menu: '<path d="M4 6.5h16"/><path d="M4 12h16"/><path d="M4 17.5h10"/>',
  cart: '<path d="M3 4h2.5l2 11h10.5l2-8H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevronDown: '<path d="m5.5 9.5 6.5 6.5 6.5-6.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/>',
  star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 15.9l-4.9 2.7 1.1-5.3-4-3.7 5.4-.6z"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 6.6a4.3 4.3 0 0 1 7.5 2.9c0 5.6-7.5 10-7.5 10z"/>',
  receipt: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  pencil: '<path d="M4 20l1-4.5L15.5 5a2 2 0 0 1 3 3L8 18.5z"/><path d="m13.5 7 3 3"/>',
  lock: '<path d="M6 11h12v9H6z"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  logout: '<path d="M14 4.5H6v15h8"/><path d="M11 12h9M17 9l3 3-3 3"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4.5V8h-3.5"/>',
  repeat: '<path d="M5 11V9.5A3.5 3.5 0 0 1 8.5 6H18"/><path d="M15.5 3.5L18 6l-2.5 2.5"/><path d="M19 13v1.5a3.5 3.5 0 0 1-3.5 3.5H6"/><path d="M8.5 20.5L6 18l2.5-2.5"/>',
  camera: '<path d="M4 8h3.5L9 5.5h6L16.5 8H20v11H4z"/><circle cx="12" cy="13" r="3.2"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  home: '<path d="M5 20v-8.5L12 5l7 6.5V20z"/><path d="M10 20v-5h4v5"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h5.5"/>',
  coin: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
  filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>',
  send: '<path d="M4 12l16-7-6 15-2.5-6.5z"/>',
  phone: '<path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

// Логотип VIA Bar (авторский знак Владимира и Анастасии: кольцо, «VIA BAR» / «VLADIMIR & ANASTASIA»,
// сплетённые VA) — линии в цвет темы, без фона: бордо на слоновой кости, золото на бордовой карте гостя.
export const monogram = (size = 96, tone = "bordeaux") => `<img class="monogram" src="/brand/via-logo-${tone === "gold" ? "gold" : "bordeaux"}.webp?v=3" width="${size}" height="${size}" alt="VIA Bar" decoding="async">`;

// Надпись-знак: крупное разреженное «VIA» и подпись под ним.
export const wordmark = (sub = "bar · by Vladimir &amp; Anastasia") => `<div class="wordmark"><b>VIA</b><span>${sub}</span></div>`;

export const icon = (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(ICONS)
  .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`)
  .join("")}</svg>`;

const FONT = (family, file, weight, style, range) => `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url(/fonts/${file}.woff2) format("woff2");unicode-range:${range}}`;
const CYR = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const LAT = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+20BD,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const FONTS_CSS = [
  ["Cormorant Garamond", "cormorant-garamond", "500", "normal"],
  ["Cormorant Garamond", "cormorant-garamond", "600", "normal"],
  ["Cormorant Garamond", "cormorant-garamond", "500", "italic"],
  ["Manrope", "manrope", "500", "normal"],
  ["Manrope", "manrope", "600", "normal"],
  ["Manrope", "manrope", "700", "normal"],
].map(([fam, f, w, s]) => FONT(fam, `${f}-cyrillic-${w}-${s}`, w, s, CYR) + FONT(fam, `${f}-latin-${w}-${s}`, w, s, LAT)).join("\n");

export const DESIGN_CSS = `
${FONTS_CSS}
:root{
  color-scheme:light;
  /* Слоновая кость, бордо, латунное золото */
  --bg:#F6EFE5;--paint:radial-gradient(120% 420px at 50% -60px,#FFFBF5 0,rgba(255,251,245,0) 70%);
  --bg-raised:#FFFDF9;--bg-raised-2:#F0E6D8;--bg-pressed:#EADDCB;--field:#EFE6DA;
  --label:#2A0E16;--label-2:#5E464B;--label-3:#765C61;
  --sep:rgba(94,26,40,.09);--sep-strong:rgba(94,26,40,.17);
  --accent:#6E1A2B;--brass:#A27C3A;--brass-line:rgba(162,124,58,.55);
  --tint:rgba(110,26,43,.08);--tint-ink:#6E1A2B;
  --btn-fill:linear-gradient(180deg,#7C2335,#5F1626);--btn-ink:#FBF2E4;--btn-solid:#6E1A2B;
  --btn2:#EFE4D5;--btn2-ink:#4A1622;
  /* Старые имена — на новые цвета (страницы панели пишут var(--gold) для акцента) */
  --gold:var(--accent);--gold-hi:#8A2A3E;--gold-lo:#5F1626;--gold-ink:var(--btn-ink);
  --gold-fill:var(--btn-fill);--gold-soft:var(--tint);--gold-ring:rgba(110,26,43,.2);
  --line-zero:#2E7656;--line-light:#A27C3A;--line-mid:#B5651D;--line-strong:#B0263A;
  --ok:#2E7656;--ok-tint:rgba(46,118,86,.12);--warn:#A85B12;--warn-tint:rgba(190,110,30,.13);--danger:#B0263A;--danger-tint:rgba(176,38,58,.1);
  --material:rgba(255,252,247,.86);--material-strong:rgba(255,252,247,.96);
  --shadow:0 14px 32px rgba(84,24,38,.09),0 2px 6px rgba(84,24,38,.05);
  --shadow-lift:0 18px 40px rgba(60,12,24,.22),0 2px 8px rgba(60,12,24,.08);
  --r-xl:22px;--r-lg:18px;--r-md:14px;
  --safe-t:env(safe-area-inset-top,0px);--safe-b:env(safe-area-inset-bottom,0px);
  --tabbar-h:56px;--tabbar-bg:rgba(255,252,247,.9);
  --sans:Manrope,-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,Arial,sans-serif;
  --serif:"Cormorant Garamond","Iowan Old Style",Georgia,serif;
}
*{box-sizing:border-box}
html{font-size:16px;-webkit-text-size-adjust:100%;background:var(--bg)}
body{margin:0;min-height:100dvh;background:var(--paint) no-repeat,var(--bg);color:var(--label);font-family:var(--sans);font-weight:500;font-size:.9375rem;line-height:1.4;font-variant-numeric:lining-nums;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;overscroll-behavior-y:none}
html,body,button,a,input,select,textarea,[role=button]{touch-action:manipulation}
::selection{background:var(--accent);color:var(--bg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
input,textarea{caret-color:var(--accent)}
img{max-width:100%}
b,strong{font-weight:700}
.ic{width:1.3em;height:1.3em;flex:none;display:inline-block;vertical-align:-.27em}
a{color:var(--accent);text-decoration:none}
.num,.tabular{font-variant-numeric:lining-nums tabular-nums}
.serif{font-family:var(--serif);font-weight:600}
.muted,.sub{color:var(--label-2)}
.footnote{font-size:.8125rem;color:var(--label-2)}
.caption{font-size:.75rem;color:var(--label-3)}
.label-caps{font:700 .6875rem/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--label-3)}
.hidden,[hidden]{display:none!important}
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.22s}
/* Свайп между вкладками: содержимое уезжает в сторону пальца, соседняя вкладка въезжает с другой стороны.
   Панель бармена — переход между страницами (data-vt ставит жест), у гостя — смена вкладки на той же странице. */
@keyframes vt-out-next{to{transform:translateX(-22%);opacity:0}}@keyframes vt-in-next{from{transform:translateX(22%);opacity:0}}
@keyframes vt-out-prev{to{transform:translateX(22%);opacity:0}}@keyframes vt-in-prev{from{transform:translateX(-22%);opacity:0}}
html[data-vt] main.screen{view-transition-name:page}
html[data-vt=next]::view-transition-old(page){animation:vt-out-next .26s cubic-bezier(.3,.7,.3,1) both}
html[data-vt=next]::view-transition-new(page){animation:vt-in-next .26s cubic-bezier(.3,.7,.3,1) both}
html[data-vt=prev]::view-transition-old(page){animation:vt-out-prev .26s cubic-bezier(.3,.7,.3,1) both}
html[data-vt=prev]::view-transition-new(page){animation:vt-in-prev .26s cubic-bezier(.3,.7,.3,1) both}
.pane.vt-next{animation:vt-in-next .26s cubic-bezier(.2,.9,.25,1)}.pane.vt-prev{animation:vt-in-prev .26s cubic-bezier(.2,.9,.25,1)}

/* ——— Знак VIA ——— */
.wordmark{text-align:center;line-height:1}
.wordmark b{display:block;font:600 1.875rem/1 var(--serif);letter-spacing:.34em;margin-right:-.34em;color:var(--accent)}
.wordmark span{display:block;margin-top:6px;font:700 .5625rem/1 var(--sans);letter-spacing:.24em;text-transform:uppercase;color:var(--label-3)}
.monogram{display:block}

/* ——— Каркас ——— */
.navbar{position:sticky;top:0;z-index:40;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;min-height:calc(44px + var(--safe-t));padding:var(--safe-t) max(8px,env(safe-area-inset-right)) 0 max(8px,env(safe-area-inset-left));background:transparent;transition:background .2s ease,box-shadow .2s ease}
.navbar.scrolled{background:var(--material);-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);box-shadow:0 1px 0 var(--sep)}
.nav-title{grid-column:2;font-weight:700;font-size:.9375rem;opacity:0;transform:translateY(4px);transition:opacity .2s ease,transform .2s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw}
.navbar.scrolled .nav-title{opacity:1;transform:none}
.nav-left{grid-column:1;justify-self:start;display:flex;align-items:center}
.nav-right{grid-column:3;justify-self:end;display:flex;align-items:center;gap:6px}
.nav-back{display:inline-flex;align-items:center;gap:2px;min-height:44px;padding:0 8px 0 2px;color:var(--accent);font-size:.9375rem;font-weight:600}
.nav-back .ic{width:1.45em;height:1.45em}
.screen{max-width:720px;margin:0 auto;padding:0 max(20px,env(safe-area-inset-left)) calc(28px + var(--safe-b));}
.app .screen{padding-bottom:calc(var(--tabbar-h) + 36px + var(--safe-b))}
.large-title{font:600 2.25rem/1.04 var(--serif);letter-spacing:-.005em;margin:6px 0 4px;text-wrap:balance}
.large-title em,.h-em{font-style:italic;font-weight:500;color:var(--accent)}
.screen-sub{color:var(--label-2);margin:2px 0 18px;font-size:.875rem;line-height:1.45}

/* Нижняя панель вкладок — как в приложениях iPhone: во всю ширину, полупрозрачная слоновая кость,
   активная вкладка — бордо с золотой чертой сверху. */
.tabbar{position:fixed;z-index:50;left:0;right:0;bottom:0;height:calc(var(--tabbar-h) + var(--safe-b));display:flex;align-items:stretch;justify-content:center;padding:0 env(safe-area-inset-right,0px) var(--safe-b) env(safe-area-inset-left,0px);background:var(--tabbar-bg);-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);box-shadow:inset 0 1px 0 var(--sep)}
.tab{position:relative;flex:1;max-width:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding-top:2px;color:var(--label-3);font-size:.65625rem;font-weight:600;letter-spacing:.01em;min-width:44px;transition:color .15s ease}
.tab .ic{width:24px;height:24px}
.tab[aria-current=page]{color:var(--accent)}
.tab[aria-current=page]::before{content:"";position:absolute;top:0;left:50%;width:26px;height:2px;margin-left:-13px;border-radius:2px;background:var(--brass)}
.tab:active{opacity:.6}
.tab-badge{position:absolute;top:5px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--btn-solid);color:var(--btn-ink);font-size:.65625rem;font-weight:700;line-height:18px;text-align:center}
@media (prefers-reduced-transparency:reduce){.navbar.scrolled,.tabbar{background:var(--material-strong);-webkit-backdrop-filter:none;backdrop-filter:none}}

/* ——— Карточки и сгруппированные списки ——— */
.section{margin:26px 0 0}
.section-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 2px 12px;font-size:.78125rem;color:var(--label-3);font-weight:600}
.section-header h2,.section-header h3{margin:0;font:600 1.5625rem/1.1 var(--serif);color:var(--label);letter-spacing:0}
.section-title{font:600 1.5625rem/1.1 var(--serif);margin:0 2px 12px}
.section-footer{margin:8px 4px 0;font-size:.78125rem;color:var(--label-3);line-height:1.45}
.card,.list{display:flow-root;background:var(--bg-raised);border-radius:var(--r-xl);box-shadow:var(--shadow)}
.list{overflow:hidden}
.cell{position:relative;display:flex;align-items:center;gap:13px;min-height:54px;padding:12px 16px;color:var(--label);width:100%;text-align:left;background:none;border:0;font:inherit}
.cell+.cell::before,.cell+.cell-wrap::before,.cell-wrap+.cell::before,.cell-wrap+.cell-wrap::before{content:"";position:absolute;top:0;left:var(--sep-inset,16px);right:16px;height:1px;background:var(--sep)}
.cell-wrap{position:relative}
a.cell:active,button.cell:active,.cell.tappable:active{background:var(--bg-pressed)}
.cell-icon{width:34px;height:34px;flex:none;display:grid;place-items:center;border-radius:10px;color:var(--tint-ink);background:var(--tint)}
.cell-icon .ic{width:19px;height:19px}
.cell-body{flex:1;min-width:0}
.cell-title,.cell-sub{display:block}
.cell-title{font-size:.9375rem;font-weight:700;line-height:1.25;overflow-wrap:anywhere}
.cell-sub{font-size:.78125rem;color:var(--label-3);margin-top:3px;line-height:1.4}
.cell-value{color:var(--label-2);font-size:.875rem;font-weight:600;text-align:right;white-space:nowrap}
.cell-chevron{color:var(--label-3);width:17px;height:17px}
.cell.has-icon{--sep-inset:63px}
.name-serif{font:600 1.1875rem/1.12 var(--serif);letter-spacing:.005em;color:var(--label)}

/* ——— Кнопки ——— */
.btn,button.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:50px;padding:0 22px;border:0;border-radius:16px;font:inherit;font-weight:700;font-size:.9375rem;letter-spacing:.01em;cursor:pointer;transition:transform .12s ease,filter .15s ease,opacity .15s ease;white-space:nowrap;text-decoration:none}
.btn .ic{width:18px;height:18px}
.btn:active{transform:scale(.97)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.45;pointer-events:none}
.btn-primary{background:var(--btn-fill);color:var(--btn-ink);box-shadow:0 10px 22px rgba(80,18,34,.18)}
.btn-tinted{background:var(--tint);color:var(--tint-ink)}
.btn-gray{background:var(--btn2);color:var(--btn2-ink)}
.btn-outline{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1.4px var(--brass-line)}
.btn-plain{background:none;color:var(--accent);padding:0 10px;min-height:44px}
.btn-danger{background:var(--danger-tint);color:var(--danger)}
.btn-block{width:100%}
.btn-sm{min-height:40px;padding:0 16px;border-radius:13px;font-size:.875rem}
.icon-btn{display:inline-grid;place-items:center;width:44px;height:44px;border:0;border-radius:50%;background:none;color:var(--accent);cursor:pointer;padding:0}
.icon-btn.filled{background:var(--bg-raised);box-shadow:var(--shadow);width:42px;height:42px}
.icon-btn:active{transform:scale(.92);background:var(--bg-pressed)}
.button-row{display:flex;gap:10px;flex-wrap:wrap}.button-row>.btn{flex:1}

/* Степпер (− 2 +): тонкий золотой контур */
.stepper{display:inline-flex;align-items:center;justify-content:space-between;border-radius:999px;box-shadow:inset 0 0 0 1.4px var(--brass-line);height:34px;min-width:96px;padding:0 2px;color:var(--accent)}
.stepper button{width:34px;height:34px;border:0;background:none;color:var(--accent);display:grid;place-items:center;cursor:pointer;padding:0;border-radius:999px}
.stepper button .ic{width:16px;height:16px}
.stepper button:disabled{color:var(--label-3);opacity:.5}
/* Зона касания 44pt при визуальной высоте 34 */
.stepper button,.chip{position:relative}
.stepper button::after,.chip::after{content:"";position:absolute;left:0;right:0;top:-5px;bottom:-5px}
.stepper button:active{background:var(--tint)}
.stepper output,.stepper span{min-width:22px;text-align:center;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums}

/* Сегментированный контрол */
.segmented{display:flex;padding:4px;border-radius:14px;background:var(--bg-raised-2)}
.segmented button,.segmented a{flex:1;min-height:36px;border:0;border-radius:10px;background:none;color:var(--label-2);font:inherit;font-size:.875rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 8px;white-space:nowrap}
.segmented [aria-pressed=true],.segmented [aria-selected=true],.segmented .active{background:var(--bg-raised);color:var(--label);box-shadow:0 2px 8px rgba(42,14,22,.08)}
.seg-count{display:inline-block;min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:var(--tint);color:var(--tint-ink);font:700 .6875rem/19px var(--sans);text-align:center}

/* Вкладки-фильтры (крепость): подчёркивание золотом, число рядом */
.chips{display:flex;gap:22px;overflow-x:auto;scrollbar-width:none;margin:0 -20px;padding:0 20px;box-shadow:inset 0 -1px 0 var(--sep)}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;display:inline-flex;align-items:baseline;gap:4px;min-height:42px;padding:11px 0 12px;border:0;background:none;color:var(--label-3);font:inherit;font-size:.90625rem;font-weight:600;cursor:pointer}
.chip small{font-size:.6875rem;font-weight:600;opacity:.75}
.chip[aria-pressed=true]{color:var(--label)}
.chip[aria-pressed=true]::before{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;background:var(--brass)}
.chip .dot{display:none}
.line-zero{--line:var(--line-zero)}.line-light{--line:var(--line-light)}.line-mid{--line:var(--line-mid)}.line-strong{--line:var(--line-strong)}
/* Пилюли статусов */
.badge{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:12px;font-size:.71875rem;font-weight:700;background:var(--tint);color:var(--tint-ink);white-space:nowrap}
.badge .ic{width:13px;height:13px}
.badge.line{background:color-mix(in srgb,var(--line) 14%,transparent);color:var(--line)}
.badge.ok{background:var(--ok-tint);color:var(--ok)}
.badge.warn{background:var(--warn-tint);color:var(--warn)}
.badge.danger{background:var(--danger-tint);color:var(--danger)}
/* Крепость точками: заполненные — золото */
.scale{display:inline-flex;gap:4px;align-items:center}
.scale i{width:7px;height:7px;border-radius:50%;box-shadow:inset 0 0 0 1.3px var(--brass);display:block}
.scale i.f{background:var(--brass)}

/* ——— Фирменный приём: маршрут и станции ——— */
.route{position:relative}:where(.route){--line:var(--brass)}
.route-stop{position:relative;display:flex;gap:12px;align-items:flex-start;padding:0 0 14px}
.route-stop:last-child{padding-bottom:0}
.route-stop::before{content:"";position:absolute;left:9px;top:22px;bottom:2px;width:1.5px;background:var(--sep-strong)}
.route-stop:last-child::before{display:none}
.station{flex:none;width:20px;height:20px;border-radius:50%;background:var(--bg-raised);box-shadow:inset 0 0 0 1.5px var(--sep-strong);position:relative;z-index:1;display:grid;place-items:center;color:var(--bg-raised)}
.station .ic{width:13px;height:13px;stroke-width:2.4}
.route-stop.done .station{background:var(--brass);box-shadow:none}
.route-stop.current .station{box-shadow:inset 0 0 0 1.5px var(--brass),0 0 0 5px var(--tint)}
.route-stop.pending .station{box-shadow:inset 0 0 0 1.5px var(--sep-strong)}
.route-body{flex:1;min-width:0}
/* Состав коктейля: ингредиенты — маленькие золотые станции на одной линии */
.rc-panel .station,.dt-panel .station,.ing-route .station{width:12px;height:12px;margin-top:4px;background:var(--brass);box-shadow:none}
.rc-panel .route-stop::before,.dt-panel .route-stop::before,.ing-route .route-stop::before{left:5px;top:16px}
/* Горизонтальный трекер статуса заказа */
.tracker{display:flex;justify-content:space-between;position:relative;margin:4px 2px}
.tracker::before{content:"";position:absolute;left:10px;right:10px;top:5px;height:1.5px;background:var(--sep-strong)}
.tracker-stop{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;font-size:.6875rem;font-weight:600;color:var(--label-3)}
.tracker-stop:first-child{align-items:flex-start}.tracker-stop:last-child{align-items:flex-end}
.tracker-stop .station{width:12px;height:12px;background:var(--bg-raised);box-shadow:inset 0 0 0 1.5px var(--sep-strong)}
.tracker-stop.done .station{background:var(--brass);box-shadow:none}
.tracker-stop.done{color:var(--label-2)}
.tracker-stop.current .station{box-shadow:inset 0 0 0 3.5px var(--brass),0 0 0 4px var(--tint)}
.tracker-stop.current{color:var(--label)}

/* Раздел меню по крепости */
.line-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:26px 2px 12px}
.line-mark{display:none}
.line-head h2{margin:0;font:600 1.5625rem/1.1 var(--serif)}
.line-head .count{color:var(--label-3);font-size:.78125rem;font-weight:600}

/* ——— Поля ввода ——— */
.field{display:block;padding:9px 16px}
.field>span,.field-label{display:block;font-size:.71875rem;font-weight:600;color:var(--label-3);margin:2px 0 3px}
.field input,.field select,.field textarea,input.input,select.input,textarea.input{display:block;width:100%;min-height:36px;padding:6px 0;border:0;background:transparent;color:var(--label);font:inherit;font-weight:600;font-size:max(16px,1rem);outline:none}
.field textarea{min-height:76px;resize:vertical;font-weight:500}
.field select{appearance:none;-webkit-appearance:none;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23765C61' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") right center/18px no-repeat;padding-right:24px}
.field+.field{border-top:1px solid var(--sep)}
.field-row{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--sep)}
.field-row .field+.field{border-top:0;border-left:1px solid var(--sep)}
.search{display:flex;align-items:center;gap:10px;min-height:46px;padding:0 16px;border-radius:23px;background:var(--field);color:var(--label-3)}
.search .ic{color:var(--label-3);width:19px;height:19px}
.search input{flex:1;min-width:0;border:0;background:none;color:var(--label);font:inherit;font-size:max(16px,1rem);padding:10px 0;outline:none}
.search input::-webkit-search-cancel-button{display:none}
::placeholder{color:var(--label-3);opacity:1;font-weight:500}

/* ——— Шторка (sheet) ——— */
.sheet{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-end;justify-content:center;background:rgba(20,6,10,.42);opacity:0;pointer-events:none;transition:opacity .25s ease}
.sheet.open{opacity:1;pointer-events:auto}
.sheet-panel{position:relative;width:100%;max-width:720px;max-height:92dvh;display:flex;flex-direction:column;background:var(--paint) no-repeat,var(--bg);border-radius:30px 30px 0 0;box-shadow:0 -12px 40px rgba(42,14,22,.22);transform:translateY(100%);transition:transform .34s cubic-bezier(.2,.9,.25,1);padding-bottom:var(--safe-b);overflow:hidden}
.sheet.open .sheet-panel{transform:none}
.sheet-grabber,.sheet-head{touch-action:none}
.sheet-grabber{width:40px;height:5px;border-radius:3px;background:var(--sep-strong);margin:8px auto 0;flex:none}
.sheet-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;min-height:50px;padding:0 10px;flex:none}
.sheet-head h2{grid-column:2;margin:0;font:700 .9375rem/1.2 var(--sans);text-align:center}
.sheet-head .left{grid-column:1;justify-self:start}.sheet-head .right{grid-column:3;justify-self:end}
.sheet-body{overflow-y:auto;overscroll-behavior:none;padding:4px 20px 24px;-webkit-overflow-scrolling:touch}

/* ——— Состояния ——— */
.empty-state{text-align:center;padding:34px 20px;color:var(--label-2);font-size:.875rem;line-height:1.5}
.empty-state .ic{width:40px;height:40px;color:var(--brass);margin-bottom:10px}
.empty-state h3{color:var(--label);margin:0 0 6px;font:600 1.375rem/1.15 var(--serif)}
.skeleton{background:linear-gradient(90deg,var(--bg-raised) 0%,var(--bg-raised-2) 50%,var(--bg-raised) 100%);background-size:200% 100%;animation:sk 1.2s ease-in-out infinite;border-radius:14px;min-height:54px}
@keyframes sk{to{background-position:-200% 0}}
.toast{position:fixed;left:50%;width:max-content;bottom:calc(var(--tabbar-h) + 26px + var(--safe-b));transform:translate(-50%,12px);z-index:90;max-width:min(92vw,420px);padding:12px 18px;border-radius:16px;background:#2A0E16;box-shadow:var(--shadow-lift);color:#FBF2E4;font-size:.875rem;font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s ease,transform .25s ease;text-align:center}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.error{background:#8E1F31}
.offline-pill{display:flex;align-items:center;gap:8px;width:max-content;max-width:100%;margin:4px 0 10px;padding:7px 14px;border-radius:999px;background:var(--warn-tint);color:var(--warn);font-size:.78125rem;font-weight:700;line-height:1.3}
.offline-pill::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--warn)}
.offline-pill[hidden]{display:none}
.thumb{width:54px;height:54px;flex:none;border-radius:14px;object-fit:cover;background:#2A0A14}
.thumb-ph{display:grid;place-items:center;color:var(--brass);background:var(--bg-raised-2)}
.thumb-ph .ic{width:24px;height:24px}
.price{font-variant-numeric:tabular-nums;font-weight:700}

/* ——— Базовые стили элементов без класса (нулевая специфичность) ——— */
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
:where(h2){font:600 1.5625rem/1.1 var(--serif);margin:0 0 8px}:where(h3){font-size:1rem;font-weight:700;margin:0 0 6px}
:where(label){display:block;color:var(--label-3);font-size:.75rem;font-weight:600;margin:12px 0 6px}
:where(input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),select,textarea){width:100%;min-height:48px;padding:10px 14px;border:0;border-radius:14px;background:var(--bg-raised);color:var(--label);font:inherit;font-weight:600;font-size:max(16px,1rem);box-shadow:inset 0 0 0 1px var(--sep-strong);outline:none}
:where(input,select,textarea):focus{box-shadow:inset 0 0 0 1.6px var(--brass)}
.list input,.field input,.list select,.field select,.list textarea,.field textarea,.search input{box-shadow:none!important;border-radius:0!important;background:transparent!important;padding-left:0!important;padding-right:0!important}
:where(button:not([class])){min-height:44px;padding:0 18px;border:0;border-radius:14px;background:var(--btn-fill);color:var(--btn-ink);font:inherit;font-weight:700;cursor:pointer}
:where(button.secondary){min-height:44px;padding:0 18px;border:0;border-radius:14px;background:var(--btn2);color:var(--btn2-ink);font:inherit;font-weight:700;cursor:pointer}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}.sheet-panel{transition:none}}
`;

// Небольшой рантайм каркаса: сворачивание крупного заголовка, шторки, тосты.
export const SHELL_JS = `<script>
(function(){
  // Заголовок в шапке появляется, когда крупный заголовок уехал вверх (у гостя заголовков несколько — берём видимый).
  var nav=document.querySelector(".navbar");
  if(nav){var on=function(){var lt=[].find.call(document.querySelectorAll(".large-title"),function(e){return e.offsetParent});nav.classList.toggle("scrolled",window.scrollY>(lt?lt.offsetTop+lt.offsetHeight-44:4))};on();addEventListener("scroll",on,{passive:true})}
  window.VIA=window.VIA||{};
  VIA.openSheet=function(id){var s=typeof id==="string"?document.getElementById(id):id;if(!s)return;s.hidden=false;requestAnimationFrame(function(){s.classList.add("open")});document.documentElement.style.overflow="hidden";var f=s.querySelector("[autofocus]");if(f)setTimeout(function(){f.focus()},300)};
  VIA.closeSheet=function(id){var s=typeof id==="string"?document.getElementById(id):id;if(!s)return;s.classList.remove("open");document.documentElement.style.overflow="";setTimeout(function(){if(!s.classList.contains("open"))s.hidden=true},320)};
  document.addEventListener("click",function(e){var c=e.target.closest("[data-close-sheet]");if(c){VIA.closeSheet(c.closest(".sheet"));return}var o=e.target.closest("[data-open-sheet]");if(o){VIA.openSheet(o.getAttribute("data-open-sheet"));return}if(e.target.classList&&e.target.classList.contains("sheet"))VIA.closeSheet(e.target)});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){var s=document.querySelector(".sheet.open");if(s)VIA.closeSheet(s)}});
  // Свайп вниз закрывает шторку, только если протянуть на треть экрана (у низкой шторки — на половину
  // её высоты); короче — пружинит обратно, чтобы случайное движение пальцем её не закрывало.
  var pullLim=function(p){return Math.min(innerHeight/3,p.offsetHeight/2)};
  // Свайп вниз по шапке шторки закрывает её
  var drag=null;document.addEventListener("pointerdown",function(e){var h=e.target.closest(".sheet-grabber,.sheet-head");if(!h||e.target.closest("button,a,input"))return;var p=h.closest(".sheet-panel");drag={p:p,y:e.clientY,dy:0};p.style.transition="none";try{h.setPointerCapture(e.pointerId)}catch(_){}});
  document.addEventListener("pointermove",function(e){if(!drag)return;drag.dy=Math.max(0,e.clientY-drag.y);drag.p.style.transform="translateY("+drag.dy+"px)"});
  var end=function(){if(!drag)return;var p=drag.p;p.style.transition="";p.style.transform="";if(drag.dy>pullLim(p))VIA.closeSheet(p.closest(".sheet"));drag=null};
  document.addEventListener("pointerup",end);document.addEventListener("pointercancel",end);
  // Шторку можно смахнуть вниз за любое место, когда её содержимое прокручено к самому верху,
  // как в приложениях iPhone. Иначе iPhone оттягивает только содержимое (фото уезжает вниз),
  // а рамка шторки остаётся на месте. Решаем по первому движению пальца: вниз у верха — тянем
  // шторку, иначе — обычная прокрутка.
  var td=null;
  document.addEventListener("touchstart",function(e){var p=e.target.closest(".sheet.open .sheet-panel");td=null;
    if(!p||e.touches.length!==1||e.target.closest(".sheet-grabber,.sheet-head,input,textarea,select,canvas"))return;
    td={p:p,sc:e.target.closest(".sheet-body")||p,x:e.touches[0].clientX,y:e.touches[0].clientY,dy:0,on:false,first:true}},{passive:true});
  document.addEventListener("touchmove",function(e){if(!td)return;var t=e.touches[0];
    if(td.first){td.first=false;var dx=t.clientX-td.x,dy=t.clientY-td.y;
      if(dy>0&&Math.abs(dy)>=Math.abs(dx)&&td.sc.scrollTop<=0){td.on=true;td.y=t.clientY;td.p.style.transition="none"}else{td=null;return}}
    if(!td.on)return;e.preventDefault();td.dy=Math.max(0,t.clientY-td.y);td.p.style.transform="translateY("+td.dy+"px)"},{passive:false});
  var tend=function(){var d=td;td=null;if(!d||!d.on)return;d.p.style.transition="";d.p.style.transform="";if(d.dy>pullLim(d.p))VIA.closeSheet(d.p.closest(".sheet"))};
  document.addEventListener("touchend",tend);document.addEventListener("touchcancel",tend);
  // Свайп вбок по странице — соседняя нижняя вкладка, как нажатие на неё. Срабатывает только на явное движение
  // вбок на четверть ширины экрана; не мешает прокрутке, жесту iPhone «назад» от края, полосам, которые листаются
  // вбок, полям ввода и открытым шторкам. Содержимое слегка едет за пальцем (полосы заказа и шторки — нет:
  // они «прилипшие»); не дотянули — пружинит обратно. На вложенных страницах («Статистика» и т.п.) свайп
  // вправо — назад, как стрелка в шапке.
  var sw=null;
  var noSwipe=function(el){for(;el&&el.nodeType===1;el=el.parentElement){if(el.matches("input,textarea,select,[contenteditable],.chips,[data-no-swipe]"))return true;var o=getComputedStyle(el).overflowX;if((o==="auto"||o==="scroll")&&el.scrollWidth>el.clientWidth+1)return true}return false};
  document.addEventListener("touchstart",function(e){sw=null;var t=e.touches[0],m=document.querySelector("main.screen");
    if(e.touches.length!==1||!m||document.querySelector(".sheet.open")||t.clientX<24||t.clientX>innerWidth-24||noSwipe(e.target))return;
    var ts=[].slice.call(document.querySelectorAll(".tabbar .tab")),i=ts.findIndex(function(x){return x.getAttribute("aria-current")==="page"}),back=document.querySelector(".nav-back");
    var prev=back||ts[i-1],next=back?null:ts[i+1];if(i<0&&!back||!prev&&!next)return;
    sw={x:t.clientX,y:t.clientY,dx:0,m:m,prev:prev,next:next,first:true,on:false}},{passive:true});
  document.addEventListener("touchmove",function(e){if(!sw)return;var t=e.touches[0],dx=t.clientX-sw.x,dy=t.clientY-sw.y;
    if(sw.first){if(Math.abs(dx)<10&&Math.abs(dy)<10)return;sw.first=false;if(Math.abs(dx)<Math.abs(dy)*1.6){sw=null;return}
      sw.on=true;sw.els=[].filter.call(sw.m.children,function(c){return c.offsetParent!==null&&!c.classList.contains("sheet")&&getComputedStyle(c).position!=="fixed"});
      sw.els.forEach(function(c){c.style.transition="none"})}
    e.preventDefault();sw.dx=dx;var k=(dx>0?sw.prev:sw.next)?.32:.1;sw.els.forEach(function(c){c.style.transform="translateX("+dx*k+"px)"})},{passive:false});
  var swEnd=function(e){var d=sw;sw=null;if(!d||!d.on)return;
    var dir=d.dx<0?"next":"prev",to=d[dir],go=e.type==="touchend"&&to&&Math.abs(d.dx)>=Math.min(innerWidth*.25,140);
    if(go&&to.tagName==="A"){document.documentElement.dataset.vt=dir;try{sessionStorage.setItem("via-vt",dir)}catch(_){}location.href=to.href;return}
    d.els.forEach(function(c){c.style.transition=go?"none":"transform .3s cubic-bezier(.2,.9,.25,1)";c.style.transform=""});
    setTimeout(function(){d.els.forEach(function(c){c.style.transition=""})},320);
    if(!go)return;to.click();var p=document.querySelector(".pane:not([hidden])");
    if(p){p.classList.remove("vt-next","vt-prev");void p.offsetWidth;p.classList.add("vt-"+dir);p.addEventListener("animationend",function(){p.classList.remove("vt-"+dir)},{once:true})}};
  document.addEventListener("touchend",swEnd);document.addEventListener("touchcancel",swEnd);
  // Вернулись на страницу кнопкой «назад» (из памяти браузера) — убираем следы свайпа.
  addEventListener("pageshow",function(e){if(!e.persisted)return;delete document.documentElement.dataset.vt;var m=document.querySelector("main.screen");if(m)[].forEach.call(m.children,function(c){c.style.transform="";c.style.transition=""})});
  // Офлайн-режим: сервис-воркер (/sw.js) хранит копию страниц и данных на устройстве.
  VIA.setOffline=function(on){var p=document.getElementById("viaOffline");if(!p){if(!on)return;p=document.createElement("div");p.id="viaOffline";p.className="offline-pill";p.setAttribute("role","status");p.textContent="Нет интернета — сохранённая версия";var m=document.querySelector("main.screen");if(m)m.prepend(p);else document.body.prepend(p)}p.hidden=!on};
  if(document.documentElement.hasAttribute("data-offline")||navigator.onLine===false)VIA.setOffline(true);
  addEventListener("offline",function(){VIA.setOffline(true)});addEventListener("online",function(){VIA.setOffline(false)});
  if("serviceWorker" in navigator){
    navigator.serviceWorker.addEventListener("message",function(e){var d=e.data||{};if(d.type==="via-net")VIA.setOffline(!!d.offline||navigator.onLine===false)});
    addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").then(function(){return navigator.serviceWorker.ready}).then(function(r){var bar=document.body.classList.contains("app-bar"),app=bar?(document.querySelector(".tabbar")?"bar":""):"guest";if(app&&navigator.onLine!==false&&r.active)r.active.postMessage({type:"via-warm",app:app})}).catch(function(){})});
  }
  // Уведомления на телефон (Web Push). role: "bar" | "guest".
  // state(): "on" | "off" | "denied" | "install" (iPhone: открыть с экрана «Домой») | "unsupported".
  // enable() вызывать прямо из нажатия — iPhone спрашивает разрешение только так.
  VIA.push=(function(){
    var ios=/iPhone|iPad|iPod/.test(navigator.userAgent),standalone=navigator.standalone===true||matchMedia("(display-mode: standalone)").matches;
    var key=function(role){return "via.push."+role};
    var u8=function(s){s=String(s).replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var r=atob(s),u=new Uint8Array(r.length);for(var i=0;i<r.length;i++)u[i]=r.charCodeAt(i);return u};
    var post=function(u,b){return fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok)throw new Error(d.error||"Не удалось сохранить");return d})})};
    // Если помощник офлайн-режима не запустился (приватный режим и т. п.), ready не наступит никогда.
    var ready=function(){return Promise.race([navigator.serviceWorker.ready,new Promise(function(_,no){setTimeout(function(){no(new Error("Приложение ещё загружается — попробуйте через пару секунд"))},8000)})])};
    var api={};
    api.state=function(role){
      if(!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))return Promise.resolve(ios&&!standalone?"install":"unsupported");
      if(Notification.permission==="denied")return Promise.resolve("denied");
      return ready().then(function(reg){return reg.pushManager.getSubscription()}).then(function(sub){var saved="";try{saved=localStorage.getItem(key(role))||""}catch(e){}
        return sub&&saved===sub.endpoint&&Notification.permission==="granted"?"on":"off"}).catch(function(){return "off"});
    };
    api.enable=function(role){
      return Notification.requestPermission().then(function(p){
        if(p!=="granted")throw new Error(p==="denied"?"Уведомления запрещены — включите их в настройках телефона":"Уведомления не включены");
        return Promise.all([ready(),fetch("/api/push/key").then(function(r){return r.json()})]);
      }).then(function(x){var reg=x[0],pk=x[1].publicKey;
        return reg.pushManager.getSubscription().then(function(sub){return sub||reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(pk)})});
      }).then(function(sub){return post("/api/push/subscribe",{role:role,subscription:sub.toJSON()}).then(function(){try{localStorage.setItem(key(role),sub.endpoint)}catch(e){}return true})});
    };
    api.disable=function(role){
      try{localStorage.removeItem(key(role))}catch(e){}
      if(!("serviceWorker" in navigator)||!("PushManager" in window))return Promise.resolve(true);
      return ready().then(function(reg){return reg.pushManager.getSubscription()}).then(function(sub){return sub?post("/api/push/unsubscribe",{role:role,endpoint:sub.endpoint}):true});
    };
    // Сервер мог забыть подписку (сброс при защите панели, «Выйти на всех», смена адреса
    // подписки самим iPhone). Если на этом телефоне уведомления включали — тихо напоминаем.
    api.sync=function(role){
      var saved="";try{saved=localStorage.getItem(key(role))||""}catch(e){}
      if(!saved||!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window)||Notification.permission!=="granted")return Promise.resolve();
      return ready().then(function(reg){return reg.pushManager.getSubscription()}).then(function(sub){if(!sub)return;
        return post("/api/push/subscribe",{role:role,subscription:sub.toJSON()}).then(function(){try{localStorage.setItem(key(role),sub.endpoint)}catch(e){}})}).catch(function(){});
    };
    api.text={on:"Включены на этом телефоне",off:"Выключены",denied:"Запрещены в настройках телефона: Настройки → Уведомления",install:"Работают в приложении с экрана «Домой» — в Safari не приходят",unsupported:"Этот браузер не умеет показывать уведомления"};
    return api;
  })();
  if(document.body.classList.contains("app-bar")&&document.querySelector(".tabbar"))addEventListener("load",function(){VIA.push.sync("bar")});
  // Приписка к «Заказ принят»: на сколько других телефонов бармена ушло уведомление.
  VIA.notifiedNote=function(d){var n=Number(d&&d.notified||0);return n?" · отправили на "+n+" "+(n%10===1&&n%100!==11?"телефон":n%10>=2&&n%10<=4&&(n%100<10||n%100>=20)?"телефона":"телефонов")+" бармена":""};
  VIA.toast=function(msg,isError,ms){var t=document.getElementById("viaToast");if(!t){t=document.createElement("div");t.id="viaToast";t.className="toast";t.setAttribute("role","status");document.body.appendChild(t)}t.textContent=msg;t.classList.toggle("error",!!isError);t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},ms||2600)};
})();
</script>`;

const BAR_TABS = [
  { id: "orders", href: "/bar/orders", label: "Заказы", icon: "bell" },
  { id: "recipes", href: "/bar/recipes", label: "Рецепты", icon: "book" },
  { id: "stock", href: "/bar/stock", label: "Склад", icon: "bottle" },
  { id: "shop", href: "/bar/shop", label: "Закупки", icon: "bag" },
  { id: "more", href: "/bar", label: "Ещё", icon: "more" },
];

const tabbar = (tabs, current) => `<nav class="tabbar" aria-label="Разделы">${tabs
  .map((t) => `<a class="tab" href="${t.href}" data-tab="${t.id}"${t.id === current ? ' aria-current="page"' : ""}>${icon(t.icon)}<span>${t.label}</span>${t.id === "orders" ? '<b class="tab-badge" id="ordersBadge" hidden></b>' : ""}</a>`)
  .join("")}</nav>`;

// Вход закрыли (другой телефон нажал «Выйти на всех устройствах») — перезагрузка покажет экран входа.
const BAR_GUARD_JS = `<script>
(function(){var f=window.fetch,once=false;window.fetch=function(){return f.apply(this,arguments).then(function(r){if(r.status===401&&r.headers.get("x-bar-auth")==="required"&&!once){once=true;location.reload()}return r})}})();
</script>`;

// Значок «новые гостевые заказы» на вкладке «Заказы» (обновляется, пока вкладка видима).
// Пока панель открыта на экране, о новом заказе сообщает и плашка — даже если iPhone
// не покажет уведомление приложения, которое и так открыто.
const BAR_BADGE_JS = `<script>
(function(){var b=document.getElementById("ordersBadge");if(!b)return;
var onOrders=!!document.querySelector('.tab[data-tab="orders"][aria-current]'); // страница заказов сама опрашивает очередь
var get=function(){try{return Number(localStorage.getItem("via.orders.seen")||0)}catch(e){return 0}},set=function(n){try{localStorage.setItem("via.orders.seen",String(n))}catch(e){}};
var load=function(){if(document.hidden)return;fetch("/api/bar/guest-orders").then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;
var all=d.orders||[],pend=all.filter(function(o){return o.status==="pending"}),max=all.reduce(function(m,o){return Math.max(m,Number(o.id)||0)},0),seen=get();
if(!onOrders){b.textContent=pend.length;b.hidden=!pend.length}
var fresh=pend.filter(function(o){return Number(o.id)>seen});
if(seen&&fresh.length&&!onOrders&&window.VIA&&VIA.toast)VIA.toast("Новый заказ от: "+(fresh[0].guest_name||"гостя")+(fresh.length>1?" и ещё "+(fresh.length-1):""),false,6000);
if(max>seen)set(max)}).catch(function(){})};
load();if(!onOrders){setInterval(load,20000);document.addEventListener("visibilitychange",load)}})();
</script>`;

const headTags = (title, app) => `<meta charset="utf-8">
<script>try{var v=sessionStorage.getItem("via-vt");if(v){sessionStorage.removeItem("via-vt");document.documentElement.dataset.vt=v;setTimeout(function(){delete document.documentElement.dataset.vt},700)}}catch(e){}</script>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#F6EFE5">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${app === "bar" ? "VIA Bar" : "VIA with love"}">
<link rel="manifest" href="${app === "bar" ? "/manifest-bar.webmanifest" : "/manifest.webmanifest"}">
<link rel="apple-touch-icon" href="/icons/${app === "bar" ? "bar/" : ""}apple-touch-icon.png?v=3">
<link rel="icon" href="/icons/${app === "bar" ? "bar/" : ""}favicon-64.png?v=3" type="image/png" sizes="64x64">
<link rel="preload" href="/fonts/manrope-cyrillic-500-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/cormorant-garamond-cyrillic-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<title>${title}</title>`;

// Полный HTML-документ приложения.
// app: "bar" | "guest" | null; tab: активная вкладка бармена; back: {href,label}.
export const renderDocument = ({ title, docTitle, app = null, tab = null, back = null, right = "", body, extraCss = "", sub = "", navbar = true, tabs = true, heading = true }) => {
  const nav = !navbar ? "" : `<header class="navbar">${back ? `<div class="nav-left"><a class="nav-back" href="${back.href}">${icon("chevronLeft")}<span>${back.label}</span></a></div>` : ""}<div class="nav-title">${title}</div><div class="nav-right">${right}</div></header>`;
  return `<!doctype html>
<html lang="ru">
<head>
${headTags(docTitle || `${title} · VIA Bar`, app)}
<style>${DESIGN_CSS}${extraCss}</style>
</head>
<body class="${app ? "app app-" + app : ""}">
${app === "bar" && tabs ? BAR_GUARD_JS : ""}
${ICON_SPRITE}
${nav}
<main class="screen">
${heading ? `<h1 class="large-title">${title}</h1>` : ""}
${heading && sub ? `<p class="screen-sub">${sub}</p>` : ""}
${body}
</main>
${app === "bar" && tabs ? tabbar(BAR_TABS, tab) + BAR_BADGE_JS : ""}
${SHELL_JS}
</body>
</html>`;
};

export const htmlResponse = (html) =>
  new Response(html, { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-cache" } });
