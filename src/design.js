// VIA Bar — общая дизайн-система: тёмный «ночной» мир с металлическим золотом,
// iOS-каркас (крупные заголовки, стеклянная панель вкладок, шторки) и фирменный
// приём «Маршрут VIA»: крепость коктейля = цвет линии, статусы и шаги = станции.

// Линии крепости. Ключ — значение поля cocktails.strength.
export const STRENGTH_LINES = [
  { key: "Безалкогольный", cls: "line-zero", short: "0%" },
  { key: "Лёгкий", cls: "line-light", short: "лёгкий" },
  { key: "Средний", cls: "line-mid", short: "средний" },
  { key: "Крепкий", cls: "line-strong", short: "крепкий" },
];

// Иконки: одна сетка 24×24, линия 1.75, скруглённые концы (в духе SF Symbols).
const ICONS = {
  glass: '<path d="M5 4h14l-7 8z"/><path d="M12 12v7"/><path d="M8 20h8"/><path d="M15.5 4.5 18 2"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 7.5h6"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5"/><path d="M12 12v9"/>',
  bag: '<path d="M5 8h14l-1 12.5H6z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  more: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="12" r=".6" fill="currentColor"/><circle cx="12" cy="12" r=".6" fill="currentColor"/><circle cx="16" cy="12" r=".6" fill="currentColor"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 13 11"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-4"/><path d="M12 16V7"/><path d="M17 16v-6"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  menu: '<path d="M4 6.5h16"/><path d="M4 12h16"/><path d="M4 17.5h10"/>',
  cart: '<path d="M3 4h2.5l2 11h10.5l2-8H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevronRight: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevronDown: '<path d="m5.5 9.5 6.5 6.5 6.5-6.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="m12 3.8 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 6.6a4.3 4.3 0 0 1 7.5 2.9c0 5.6-7.5 10-7.5 10z"/>',
  receipt: '<path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21 6 19.5z"/><path d="M9 8h6"/><path d="M9 12h6"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  pencil: '<path d="M4 20l1-4.5L15.5 5a2 2 0 0 1 3 3L8 18.5z"/><path d="m13.5 7 3 3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/>',
  logout: '<path d="M14 4.5H6v15h8"/><path d="M10.5 12H20"/><path d="m16.5 8.5 3.5 3.5-3.5 3.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13.4 4.6"/><path d="M4.5 12a7.5 7.5 0 0 1 13.4-4.6"/><path d="M18 3.5v4h-4"/><path d="M6 20.5v-4h4"/>',
  camera: '<path d="M4 8h3.5l1.5-2.5h6L16.5 8H20v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  warning: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6.5 9.5V20h11V9.5"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h5.5"/>',
  bottle: '<path d="M10 3h4v4l2 3v10.5H8V10l2-3z"/><path d="M8 14h8"/>',
  coin: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
  filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>',
};

// Логотип VIA Bar (авторский знак Владимира и Анастасии: кольцо, «VIA BAR» / «VLADIMIR & ANASTASIA», сплетённые VA).
// Растровый файл вырезан из их макета: public/brand/via-logo.webp (512×512, прозрачный фон вокруг круга).
export const monogram = (size = 96) => `<img class="monogram" src="/brand/via-logo.webp?v=2" width="${size}" height="${size}" alt="VIA Bar" decoding="async">`;

export const icon = (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(ICONS)
  .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`)
  .join("")}</svg>`;

export const DESIGN_CSS = `
@font-face{font-family:Prata;font-display:swap;src:url(/fonts/prata-cyrillic-400.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Prata;font-display:swap;src:url(/fonts/prata-latin-400.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+20BD,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
:root{
  color-scheme:dark;
  --bg:#0A0908;--bg-raised:#16130F;--bg-raised-2:#201C16;--bg-pressed:#2A251C;
  --label:#F5EFE3;--label-2:#B9B0A0;--label-3:#938A79;
  --sep:rgba(233,201,128,.13);--sep-strong:rgba(233,201,128,.26);
  --gold:#E6C173;--gold-hi:#F6DE9C;--gold-lo:#B07F2E;--gold-ink:#1C1408;
  --gold-fill:linear-gradient(160deg,#F4D88F 0%,#D9AC55 52%,#B98535 100%);
  --gold-soft:rgba(230,193,115,.13);--gold-ring:rgba(230,193,115,.42);
  --line-zero:#72D4B2;--line-light:#EED37E;--line-mid:#EC9A52;--line-strong:#EE6F72;
  --ok:#72D4B2;--warn:#EC9A52;--danger:#FF6B6B;
  --material:rgba(22,19,15,.72);--material-strong:rgba(14,12,10,.86);
  --shadow:0 10px 30px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.35);
  --r-xl:22px;--r-lg:16px;--r-md:12px;
  --safe-t:env(safe-area-inset-top,0px);--safe-b:env(safe-area-inset-bottom,0px);
  --tabbar-h:50px;--tabbar-bg:var(--bg); /* = фон страницы: если iOS 26 «обрежет» низ экрана, под панелью тот же цвет */
  --sans:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:Prata,"Iowan Old Style",Georgia,serif;
}
*{box-sizing:border-box}
html{font-size:17px;font:-apple-system-body;-webkit-text-size-adjust:100%;background:var(--bg)}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--label);font-family:var(--sans);font-size:1rem;line-height:1.35;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;overscroll-behavior-y:none}
html,body,button,a,input,select,textarea,[role=button]{touch-action:manipulation}
::selection{background:var(--gold-ring);color:var(--label)}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px;border-radius:8px}
input,textarea{caret-color:var(--gold)}
img{max-width:100%}
.ic{width:1.3em;height:1.3em;flex:none;display:inline-block;vertical-align:-.27em}
a{color:var(--gold);text-decoration:none}
.num,.tabular{font-variant-numeric:tabular-nums}
.serif{font-family:var(--serif);font-weight:400}
.muted,.sub{color:var(--label-2)}
.footnote{font-size:.8125rem;color:var(--label-2)}
.caption{font-size:.75rem;color:var(--label-3)}
.hidden,[hidden]{display:none!important}
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.22s}

/* ——— Каркас ——— */
.navbar{position:sticky;top:0;z-index:40;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;min-height:calc(44px + var(--safe-t));padding:var(--safe-t) max(8px,env(safe-area-inset-right)) 0 max(8px,env(safe-area-inset-left));background:transparent;transition:background .2s ease,box-shadow .2s ease}
.navbar.scrolled{background:var(--material);-webkit-backdrop-filter:blur(22px) saturate(170%);backdrop-filter:blur(22px) saturate(170%);box-shadow:0 .5px 0 var(--sep-strong)}
.nav-title{grid-column:2;font-weight:600;font-size:1rem;opacity:0;transform:translateY(4px);transition:opacity .2s ease,transform .2s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw}
.navbar.scrolled .nav-title{opacity:1;transform:none}
.nav-left{grid-column:1;justify-self:start;display:flex;align-items:center}
.nav-right{grid-column:3;justify-self:end;display:flex;align-items:center;gap:4px}
.nav-back{display:inline-flex;align-items:center;gap:2px;min-height:44px;padding:0 8px 0 2px;color:var(--gold);font-size:1rem}
.nav-back .ic{width:1.45em;height:1.45em}
.screen{max-width:720px;margin:0 auto;padding:0 max(16px,env(safe-area-inset-left)) calc(28px + var(--safe-b));}
.app .screen{padding-bottom:calc(var(--tabbar-h) + 36px + var(--safe-b))}
.large-title{font-family:var(--serif);font-weight:400;font-size:2.1rem;line-height:1.12;letter-spacing:-.01em;margin:4px 0 6px;text-wrap:balance}
.screen-sub{color:var(--label-2);margin:0 0 18px;font-size:.9375rem}

/* Стеклянная панель вкладок */
/* Нижняя панель вкладок — как в приложениях iPhone: во всю ширину, прижата к низу,
   сплошная (страница под ней не просвечивает), под ней — зона полоски «Домой». */
.tabbar{position:fixed;z-index:50;left:0;right:0;bottom:0;height:calc(var(--tabbar-h) + var(--safe-b));display:flex;align-items:stretch;justify-content:center;padding:0 env(safe-area-inset-right,0px) var(--safe-b) env(safe-area-inset-left,0px);background:var(--tabbar-bg);border-top:.5px solid var(--sep-strong)}
.tab{position:relative;flex:1;max-width:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding-top:2px;color:var(--label-2);font-size:.6875rem;font-weight:600;letter-spacing:.01em;min-width:44px;transition:color .15s ease,background .2s ease}
.tab .ic{width:24px;height:24px}
.tab[aria-current=page]{color:var(--gold)}
.tab:active{opacity:.6}
.tab-badge{position:absolute;top:3px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#C8283A;color:#fff;font-size:.6875rem;font-weight:700;line-height:18px;text-align:center}
@media (prefers-reduced-transparency:reduce){.navbar.scrolled,.sheet-panel{background:var(--material-strong);-webkit-backdrop-filter:none;backdrop-filter:none}}

/* ——— Сгруппированные списки (iOS inset grouped) ——— */
.section{margin:22px 0 0}
.section-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 4px 7px;font-size:.8125rem;color:var(--label-2);text-transform:uppercase;letter-spacing:.04em}
.section-header h2,.section-header h3{margin:0;font:inherit}
.section-title{font-size:1.25rem;font-weight:700;margin:0 4px 10px;letter-spacing:-.01em}
.section-footer{margin:7px 4px 0;font-size:.8125rem;color:var(--label-2)}
.list{background:var(--bg-raised);border-radius:var(--r-lg);overflow:hidden;box-shadow:inset 0 0 0 .5px var(--sep)}
.cell{position:relative;display:flex;align-items:center;gap:12px;min-height:52px;padding:10px 14px;color:var(--label);width:100%;text-align:left;background:none;border:0;font:inherit}
.cell+.cell::before,.cell+.cell-wrap::before,.cell-wrap+.cell::before,.cell-wrap+.cell-wrap::before{content:"";position:absolute;top:0;left:var(--sep-inset,14px);right:0;height:.5px;background:var(--sep-strong)}
.cell-wrap{position:relative}
a.cell:active,button.cell:active,.cell.tappable:active{background:var(--bg-pressed)}
.cell-icon{width:34px;height:34px;flex:none;display:grid;place-items:center;border-radius:50%;color:var(--gold);box-shadow:inset 0 0 0 1.25px var(--gold-ring);background:var(--gold-soft)}
.cell-icon .ic{width:19px;height:19px}
.cell-body{flex:1;min-width:0}
.cell-title,.cell-sub{display:block}
.cell-title{font-size:1rem;font-weight:500;line-height:1.25;overflow-wrap:anywhere}
.cell-sub{font-size:.8125rem;color:var(--label-2);margin-top:2px;line-height:1.3}
.cell-value{color:var(--label-2);font-size:.9375rem;text-align:right;white-space:nowrap}
.cell-chevron{color:var(--label-3);width:18px;height:18px}
.cell.has-icon{--sep-inset:60px}

/* ——— Кнопки ——— */
.btn,button.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:50px;padding:0 22px;border:0;border-radius:999px;font:inherit;font-weight:600;font-size:1rem;cursor:pointer;transition:transform .12s ease,filter .15s ease,opacity .15s ease;white-space:nowrap;text-decoration:none}
.btn:active{transform:scale(.97)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.45;pointer-events:none}
.btn-primary{background:var(--gold-fill);color:var(--gold-ink);box-shadow:0 6px 18px rgba(185,133,53,.22),inset 0 1px 0 rgba(255,255,255,.35)}
.btn-tinted{background:var(--gold-soft);color:var(--gold);box-shadow:inset 0 0 0 .75px var(--gold-ring)}
.btn-gray{background:var(--bg-raised-2);color:var(--label);box-shadow:inset 0 0 0 .5px var(--sep-strong)}
.btn-plain{background:none;color:var(--gold);padding:0 10px;min-height:44px}
.btn-danger{background:rgba(255,107,107,.12);color:var(--danger)}
.btn-block{width:100%}
.btn-sm{min-height:36px;padding:0 14px;font-size:.9375rem}
.icon-btn{display:inline-grid;place-items:center;width:44px;height:44px;border:0;border-radius:50%;background:none;color:var(--gold);cursor:pointer;padding:0}
.icon-btn.filled{background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep-strong);width:36px;height:36px}
.icon-btn:active{transform:scale(.92);background:var(--bg-pressed)}
.button-row{display:flex;gap:10px;flex-wrap:wrap}.button-row>.btn{flex:1}

/* Степпер (− 2 +) */
.stepper{display:inline-flex;align-items:center;border-radius:999px;background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep-strong);height:36px}
.stepper button{width:44px;height:36px;border:0;background:none;color:var(--gold);display:grid;place-items:center;cursor:pointer;padding:0;border-radius:999px}
.stepper button:disabled{color:var(--label-3)}
/* Зона касания 44pt при визуальной высоте 36 */
.stepper button,.chip{position:relative}
.stepper button::after,.chip::after{content:"";position:absolute;left:0;right:0;top:-4px;bottom:-4px}
.stepper button:active{background:var(--bg-pressed)}
.stepper output,.stepper span{min-width:26px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}

/* Сегментированный контрол */
.segmented{display:flex;padding:2px;border-radius:10px;background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep)}
.segmented button,.segmented a{flex:1;min-height:34px;border:0;border-radius:8px;background:none;color:var(--label);font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;display:grid;place-items:center;padding:0 8px;white-space:nowrap}
.segmented [aria-pressed=true],.segmented [aria-selected=true],.segmented .active{background:var(--bg-raised);color:var(--label);font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,.25),inset 0 0 0 .5px var(--sep-strong)}

/* Чипы-фильтры по линиям */
.chips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:2px 16px 4px}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 14px;border-radius:999px;border:0;background:var(--bg-raised-2);color:var(--label);font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;box-shadow:inset 0 0 0 .5px var(--sep-strong)}
.chip[aria-pressed=true]{background:var(--label);color:var(--bg)}
.chip .dot{width:10px;height:10px;border-radius:50%;background:var(--line,var(--gold));box-shadow:0 0 0 2px var(--bg-raised-2)}
.line-zero{--line:var(--line-zero)}.line-light{--line:var(--line-light)}.line-mid{--line:var(--line-mid)}.line-strong{--line:var(--line-strong)}
.badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;font-size:.75rem;font-weight:600;background:var(--gold-soft);color:var(--gold);white-space:nowrap}
.badge.line{background:color-mix(in srgb,var(--line) 16%,transparent);color:var(--line)}
.badge.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.badge.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.badge.danger{background:color-mix(in srgb,var(--danger) 16%,transparent);color:var(--danger)}

/* ——— Фирменный приём: маршрут и станции ——— */
.route{position:relative}:where(.route){--line:var(--gold)}
.route-stop{position:relative;display:flex;gap:14px;align-items:flex-start;padding:0 0 18px}
.route-stop:last-child{padding-bottom:0}
.route-stop::before{content:"";position:absolute;left:8px;top:16px;bottom:-2px;width:3px;border-radius:2px;background:var(--line)}
.route-stop:last-child::before{display:none}
.station{flex:none;width:19px;height:19px;border-radius:50%;background:var(--bg);box-shadow:inset 0 0 0 4px var(--line);margin-top:1px;position:relative;z-index:1}
.route-stop.done .station{background:var(--line);box-shadow:inset 0 0 0 4px var(--line),inset 0 0 0 6px var(--bg)}
.route-stop.pending::before{background:repeating-linear-gradient(var(--line) 0 5px,transparent 5px 9px);opacity:.55}
.route-stop.pending .station{box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--line) 55%,transparent)}
.route-body{flex:1;min-width:0}
/* Горизонтальный трекер статуса заказа */
.tracker{display:flex;align-items:flex-start;--line:var(--gold)}
.tracker-stop{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;font-size:.75rem;color:var(--label-3);text-align:center}
.tracker-stop::before{content:"";position:absolute;top:8px;right:50%;width:100%;height:3px;background:var(--sep-strong)}
.tracker-stop:first-child::before{display:none}
.tracker-stop.done::before,.tracker-stop.current::before{background:var(--line)}
.tracker-stop .station{width:19px;height:19px;box-shadow:inset 0 0 0 3px var(--sep-strong)}
.tracker-stop.done .station{background:var(--line);box-shadow:none}
.tracker-stop.current .station{box-shadow:inset 0 0 0 4px var(--line),0 0 0 5px color-mix(in srgb,var(--line) 22%,transparent)}
.tracker-stop.done,.tracker-stop.current{color:var(--label)}
.tracker-stop.current{font-weight:600}

/* Линия-раздел меню: «ветка» с цветной меткой */
.line-head{display:flex;align-items:center;gap:10px;margin:26px 2px 10px}
.line-mark{width:26px;height:26px;border-radius:50%;background:var(--line);display:grid;place-items:center;color:var(--bg);font-size:.75rem;font-weight:800}
.line-head h2{margin:0;font-size:1.25rem;font-weight:700;letter-spacing:-.01em}
.line-head .count{margin-left:auto;color:var(--label-3);font-size:.875rem}

/* ——— Поля ввода ——— */
.field{display:block;padding:8px 14px}
.field>span,.field-label{display:block;font-size:.8125rem;color:var(--label-2);margin:2px 0 4px}
.field input,.field select,.field textarea,input.input,select.input,textarea.input{display:block;width:100%;min-height:40px;padding:8px 0;border:0;background:transparent;color:var(--label);font:inherit;font-size:max(16px,1rem);outline:none}
.field textarea{min-height:76px;resize:vertical}
.field select{appearance:none;-webkit-appearance:none;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23B9B0A0' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") right center/18px no-repeat;padding-right:24px}
.field+.field{border-top:.5px solid var(--sep-strong)}
.field-row{display:grid;grid-template-columns:1fr 1fr;border-top:.5px solid var(--sep-strong)}
.field-row .field+.field{border-top:0;border-left:.5px solid var(--sep-strong)}
.search{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 10px;border-radius:12px;background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep)}
.search .ic{color:var(--label-3);width:18px;height:18px}
.search input{flex:1;min-width:0;border:0;background:none;color:var(--label);font:inherit;font-size:max(16px,1rem);padding:8px 0;outline:none}
.search input::-webkit-search-cancel-button{display:none}
::placeholder{color:var(--label-3);opacity:1}

/* ——— Шторка (sheet) ——— */
.sheet{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .25s ease}
.sheet.open{opacity:1;pointer-events:auto}
.sheet-panel{position:relative;width:100%;max-width:720px;max-height:92dvh;display:flex;flex-direction:column;background:var(--material-strong);-webkit-backdrop-filter:blur(30px) saturate(170%);backdrop-filter:blur(30px) saturate(170%);border-radius:var(--r-xl) var(--r-xl) 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.4),inset 0 .5px 0 rgba(255,255,255,.12);transform:translateY(100%);transition:transform .34s cubic-bezier(.2,.9,.25,1);padding-bottom:var(--safe-b)}
.sheet.open .sheet-panel{transform:none}
.sheet-grabber,.sheet-head{touch-action:none}
.sheet-grabber{width:38px;height:5px;border-radius:3px;background:var(--label-3);opacity:.6;margin:7px auto 0;flex:none}
.sheet-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;min-height:48px;padding:0 8px;flex:none}
.sheet-head h2{grid-column:2;margin:0;font-size:1rem;font-weight:600;text-align:center}
.sheet-head .left{grid-column:1;justify-self:start}.sheet-head .right{grid-column:3;justify-self:end}
.sheet-body{overflow-y:auto;overscroll-behavior:contain;padding:4px 16px 22px;-webkit-overflow-scrolling:touch}

/* ——— Состояния ——— */
.empty-state{text-align:center;padding:34px 20px;color:var(--label-2)}
.empty-state .ic{width:40px;height:40px;color:var(--label-3);margin-bottom:10px}
.empty-state h3{color:var(--label);margin:0 0 6px;font-size:1.0625rem}
.skeleton{background:linear-gradient(90deg,var(--bg-raised) 0%,var(--bg-raised-2) 50%,var(--bg-raised) 100%);background-size:200% 100%;animation:sk 1.2s ease-in-out infinite;border-radius:10px;min-height:52px}
@keyframes sk{to{background-position:-200% 0}}
.toast{position:fixed;left:50%;width:max-content;bottom:calc(var(--tabbar-h) + 26px + var(--safe-b));transform:translate(-50%,12px);z-index:90;max-width:min(92vw,420px);padding:12px 18px;border-radius:999px;background:var(--material-strong);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);box-shadow:var(--shadow),inset 0 0 0 .5px var(--sep-strong);color:var(--label);font-size:.9375rem;font-weight:500;opacity:0;pointer-events:none;transition:opacity .2s ease,transform .25s ease;text-align:center}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.error{color:var(--danger)}
.offline-pill{display:flex;align-items:center;gap:8px;width:max-content;max-width:100%;margin:2px 0 10px;padding:7px 14px;border-radius:999px;background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep-strong);color:var(--label-2);font-size:.8125rem;font-weight:600;line-height:1.3}
.offline-pill::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--warn)}
.offline-pill[hidden]{display:none}
.thumb{width:56px;height:56px;flex:none;border-radius:12px;object-fit:cover;background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep)}
.thumb-ph{display:grid;place-items:center;color:var(--label-3)}
.thumb-ph .ic{width:24px;height:24px}
.price{font-variant-numeric:tabular-nums;font-weight:600}

/* ——— Базовые стили элементов без класса (нулевая специфичность) ——— */
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
:where(h2){font-size:1.25rem;margin:0 0 8px}:where(h3){font-size:1.0625rem;margin:0 0 6px}
:where(label){display:block;color:var(--label-2);font-size:.8125rem;margin:12px 0 6px}
:where(input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),select,textarea){width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:12px;background:var(--bg-raised-2);color:var(--label);font:inherit;font-size:max(16px,1rem);box-shadow:inset 0 0 0 .5px var(--sep-strong);outline:none}
.list input,.field input,.list select,.field select,.list textarea,.field textarea,.search input{box-shadow:none!important;border-radius:0!important;background:transparent!important;padding-left:0!important;padding-right:0!important}
:where(button:not([class])){min-height:44px;padding:0 18px;border:0;border-radius:999px;background:var(--gold-fill);color:var(--gold-ink);font:inherit;font-weight:600;cursor:pointer}
:where(button.secondary){min-height:44px;padding:0 18px;border:0;border-radius:999px;background:var(--bg-raised-2);color:var(--label);font:inherit;font-weight:600;cursor:pointer;box-shadow:inset 0 0 0 .5px var(--sep-strong)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}.sheet-panel{transition:none}}
`;

// Небольшой рантайм каркаса: сворачивание крупного заголовка, шторки, тосты.
export const SHELL_JS = `<script>
(function(){
  var nav=document.querySelector(".navbar"),lt=document.querySelector(".large-title");
  if(nav){var on=function(){nav.classList.toggle("scrolled",window.scrollY>(lt?lt.offsetTop+lt.offsetHeight-44:4))};on();addEventListener("scroll",on,{passive:true})}
  window.VIA=window.VIA||{};
  VIA.openSheet=function(id){var s=typeof id==="string"?document.getElementById(id):id;if(!s)return;s.hidden=false;requestAnimationFrame(function(){s.classList.add("open")});document.documentElement.style.overflow="hidden";var f=s.querySelector("[autofocus]");if(f)setTimeout(function(){f.focus()},300)};
  VIA.closeSheet=function(id){var s=typeof id==="string"?document.getElementById(id):id;if(!s)return;s.classList.remove("open");document.documentElement.style.overflow="";setTimeout(function(){if(!s.classList.contains("open"))s.hidden=true},320)};
  document.addEventListener("click",function(e){var c=e.target.closest("[data-close-sheet]");if(c){VIA.closeSheet(c.closest(".sheet"));return}var o=e.target.closest("[data-open-sheet]");if(o){VIA.openSheet(o.getAttribute("data-open-sheet"));return}if(e.target.classList&&e.target.classList.contains("sheet"))VIA.closeSheet(e.target)});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){var s=document.querySelector(".sheet.open");if(s)VIA.closeSheet(s)}});
  // Свайп вниз по шапке шторки закрывает её
  var drag=null;document.addEventListener("pointerdown",function(e){var h=e.target.closest(".sheet-grabber,.sheet-head");if(!h||e.target.closest("button,a,input"))return;var p=h.closest(".sheet-panel");drag={p:p,y:e.clientY,dy:0};p.style.transition="none";try{h.setPointerCapture(e.pointerId)}catch(_){}});
  document.addEventListener("pointermove",function(e){if(!drag)return;drag.dy=Math.max(0,e.clientY-drag.y);drag.p.style.transform="translateY("+drag.dy+"px)"});
  var end=function(){if(!drag)return;var p=drag.p;p.style.transition="";p.style.transform="";if(drag.dy>110)VIA.closeSheet(p.closest(".sheet"));drag=null};
  document.addEventListener("pointerup",end);document.addEventListener("pointercancel",end);
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
  VIA.toast=function(msg,isError,ms){var t=document.getElementById("viaToast");if(!t){t=document.createElement("div");t.id="viaToast";t.className="toast";t.setAttribute("role","status");document.body.appendChild(t)}t.textContent=msg;t.classList.toggle("error",!!isError);t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},ms||2600)};
})();
</script>`;

const BAR_TABS = [
  { id: "orders", href: "/bar/orders", label: "Заказы", icon: "bell" },
  { id: "recipes", href: "/bar/recipes", label: "Рецепты", icon: "book" },
  { id: "stock", href: "/bar/stock", label: "Склад", icon: "box" },
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
const BAR_BADGE_JS = `<script>
(function(){var b=document.getElementById("ordersBadge");if(!b)return;
if(document.querySelector('.tab[data-tab="orders"][aria-current]'))return; // страница заказов сама опрашивает очередь
var load=function(){if(document.hidden)return;fetch("/api/bar/guest-orders").then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;var n=(d.orders||[]).filter(function(o){return o.status==="pending"}).length;b.textContent=n;b.hidden=!n}).catch(function(){})};
load();setInterval(load,20000);document.addEventListener("visibilitychange",load)})();
</script>`;

const headTags = (title, app) => `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0A0908">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${app === "bar" ? "VIA Bar" : "VIA with love"}">
<link rel="manifest" href="${app === "bar" ? "/manifest-bar.webmanifest" : "/manifest.webmanifest"}">
<link rel="apple-touch-icon" href="/icons/${app === "bar" ? "bar/" : ""}apple-touch-icon.png?v=2">
<link rel="icon" href="/icons/${app === "bar" ? "bar/" : ""}favicon-64.png?v=2" type="image/png" sizes="64x64">
<link rel="preload" href="/fonts/prata-cyrillic-400.woff2" as="font" type="font/woff2" crossorigin>
<title>${title}</title>`;

// Полный HTML-документ приложения.
// app: "bar" | "guest" | null; tab: активная вкладка бармена; back: {href,label}.
export const renderDocument = ({ title, docTitle, app = null, tab = null, back = null, right = "", body, extraCss = "", sub = "", navbar = true, tabs = true }) => {
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
<h1 class="large-title">${title}</h1>
${sub ? `<p class="screen-sub">${sub}</p>` : ""}
${body}
</main>
${app === "bar" && tabs ? tabbar(BAR_TABS, tab) + BAR_BADGE_JS : ""}
${SHELL_JS}
</body>
</html>`;
};

export const htmlResponse = (html) =>
  new Response(html, { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-cache" } });
