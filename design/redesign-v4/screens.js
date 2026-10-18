// Экраны концепции «Слоновая кость и бордо». Данные — тестовая копия бара (window.D).
const $i = (id, cls = "") => `<svg class="i ${cls}"><use href="#${id}"/></svg>`;
const rub = (n) => Number(n).toLocaleString("ru-RU").replace(/ /g, " ") + " ₽";
const M = D.menu, byName = (n) => M.find((c) => c.name === n);
let TH = "light";
// Новые фото из Gemini (бокал на стойке в бордовом баре) есть пока у пяти коктейлей — на экранах показаны они.
const NEW = [2, 4, 5, 7, 10];
const PH = (c) => (NEW.includes(c.id) ? `photos/gemini/${c.id}.jpg` : `photos/bar/${c.id}.jpg`);
const withPhoto = M.filter((c) => NEW.includes(c.id));
byName("Джин Spritz").available = true;
const ings = (c) => c.ings.map((i) => i[0]).join(" · ");
const sb = () => `<div class="sb"><span>9:41</span><span class="r">${$i("sig")}${$i("wifi")}<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.5" y="2.5" width="17" height="8" rx="2" fill="currentColor"/><path d="M25 4.5v4" stroke="currentColor" stroke-width="1.5" opacity=".45"/></svg></span></div><div class="home"></div>`;
const out = [];
const S = (id, t, html) => out.push(`<section class="screen t-${t}" id="${id}-${t[0]}">${html}${sb()}</section>`);
const cart = { "Голубая лагуна": 1, "Вишневый фиеро": 2 }; // 260 + 2 × 210 = 680 ₽
const light = M.filter((c) => c.strength === "Лёгкий"), mid = M.filter((c) => c.strength === "Средний"), strong = M.filter((c) => c.strength === "Крепкий");
const gTabs = (on) => `<nav class="tabbar">${[["menu", "coupe", "Меню"], ["order", "chit", "Заказ", 3], ["profile", "person", "Профиль"]].map(([k, ic, l, b]) => `<div class="t ${on === k ? "on" : ""}">${$i(ic)}${l}${b ? `<span class="badge">${b}</span>` : ""}</div>`).join("")}</nav>`;
const bTabs = (on) => `<nav class="tabbar">${[["orders", "bell", "Заказы", 2], ["recipes", "book", "Рецепты"], ["stock", "bottle", "Склад"], ["shop", "bag", "Закупки"], ["more", "more", "Ещё"]].map(([k, ic, l, b]) => `<div class="t ${on === k ? "on" : ""}">${$i(ic)}${l}${b ? `<span class="badge">${b}</span>` : ""}</div>`).join("")}</nav>`;
const guilloche = (w = 230, h = 214) => {
  let p = "";
  for (let k = 0; k < 18; k++) {
    let d = "";
    for (let x = 0; x <= w; x += 3) d += (x ? "L" : "M") + x + " " + (h / 2 + Math.sin(x / 24 + k * 0.36) * (30 + k * 2.6) * Math.sin(x / 92 + 0.5)).toFixed(1);
    p += `<path d="${d}"/>`;
  }
  return `<svg class="gl" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${p}</svg>`;
};

// ───────── Гость: меню ─────────
const drink = (c) => {
  const q = cart[c.name], no = c.available === false;
  return `<article class="dk ${no ? "no" : ""}"><div class="ph">${`<img src="${PH(c)}" alt="">`}${no ? `<span class="tag">Нет в наличии</span>` : ""}</div>
  <h3 class="nm">${c.name}</h3><p class="ing">${ings(c)}</p>
  <div class="ft"><b>${rub(c.price)}</b>${no ? "" : q ? `<span class="stp">${$i("minus")}<b>${q}</b>${$i("plus")}</span>` : `<span class="add">В заказ</span>`}</div></article>`;
};
const menu = (t) => S("g-menu", t, `<style>
.screen#g-menu-${t[0]} .brand{display:flex;align-items:center;justify-content:space-between;padding-top:56px}
#g-menu-${t[0]} .wm{text-align:center}
#g-menu-${t[0]} .wm b{display:block;font:600 30px/1 "Cormorant Garamond";letter-spacing:.34em;margin-right:-.34em;color:var(--accent)}
#g-menu-${t[0]} .wm span{display:block;margin-top:6px;font:700 9px/1 Manrope;letter-spacing:.24em;color:var(--ink-3);text-transform:uppercase}
#g-menu-${t[0]} .av{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:var(--btn);color:var(--btn-ink);font:600 19px/1 "Cormorant Garamond"}
#g-menu-${t[0]} .sp{width:40px}
#g-menu-${t[0]} .hello{margin-top:26px}
#g-menu-${t[0]} .hello em{font-style:italic;font-weight:500;color:var(--accent)}
#g-menu-${t[0]} .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 14px}
#g-menu-${t[0]} .dk .ph{aspect-ratio:4/5}
#g-menu-${t[0]} .dk .nm{margin-top:12px}
#g-menu-${t[0]} .dk .ing{margin-top:4px;font:500 12px/1.35 Manrope;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#g-menu-${t[0]} .dk .ft{display:flex;align-items:center;justify-content:space-between;margin-top:10px;height:34px}
#g-menu-${t[0]} .dk .ft b{font:700 15px/1 Manrope}
#g-menu-${t[0]} .dk .add{height:34px;border-radius:17px;padding:0 14px;display:flex;align-items:center;font:700 13px/1 Manrope;background:var(--btn);color:var(--btn-ink)}
#g-menu-${t[0]} .dk.no img{filter:grayscale(1);opacity:.5}
#g-menu-${t[0]} .dk.no .ft b{color:var(--ink-3);font-weight:600}
#g-menu-${t[0]} .tag{position:absolute;left:10px;bottom:10px;height:26px;border-radius:13px;padding:0 10px;display:flex;align-items:center;font:700 11.5px/1 Manrope;background:rgba(255,250,242,.92);color:#5A1322}
</style>
<div class="scroll">
 <div class="brand"><span class="sp"></span><div class="wm"><b>VIA</b><span>bar · by Vladimir &amp; Anastasia</span></div><span class="av">М</span></div>
 <h1 class="h1 hello">${t === "light" ? "Добрый день" : "Добрый вечер"}, <em>Мария</em></h1>
 <p class="sub" style="margin-top:6px">Что приготовим сегодня?</p>
 <div class="search">${$i("search")}Коктейль или ингредиент</div>
 <div class="tabs"><span class="on">Все<small>12</small></span><span>Лёгкие<small>7</small></span><span>Средние<small>2</small></span><span>Крепкие<small>3</small></span></div>
 <div class="sec"><span class="h2">Лёгкие</span><span class="sm">7 коктейлей</span></div>
 <div class="grid">${light.filter((c) => NEW.includes(c.id)).map(drink).join("")}</div>
</div>
<div class="cartbar"><span class="q">3 коктейля · 680 ₽<small>Голубая лагуна, Вишневый фиеро × 2</small></span><span class="go">К заказу${$i("arrow")}</span></div>
${gTabs("menu")}`);

// ───────── Гость: карточка коктейля ─────────
const cardScreen = (t) => {
  const c = byName("Изумрудная кровь");
  S("g-card", t, `<style>
#g-card-${t[0]} .hero{position:absolute;left:0;right:0;top:0;height:392px}
#g-card-${t[0]} .hero img{width:100%;height:100%;object-fit:cover;object-position:50% 42%}
#g-card-${t[0]} .hero img{object-position:50% 50%}
.t-light#g-card-l .sb{color:#F6ECDF}
#g-card-${t[0]} .x{position:absolute;top:56px;right:18px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:rgba(255,250,242,.9);color:#3A0F18;z-index:5}
#g-card-${t[0]} .x svg{width:18px;height:18px}
#g-card-${t[0]} .sheet{position:absolute;left:0;right:0;top:360px;bottom:0;border-radius:30px 30px 0 0;background:var(--paint),var(--bg);padding:16px 22px 0;box-shadow:0 -10px 30px rgba(0,0,0,.12)}
#g-card-${t[0]} .grab{width:40px;height:5px;border-radius:3px;background:var(--line-2);margin:0 auto 18px}
#g-card-${t[0]} .meta{display:flex;align-items:center;justify-content:space-between}
#g-card-${t[0]} .str{display:flex;align-items:center;gap:6px}
#g-card-${t[0]} .str i{width:8px;height:8px;border-radius:50%;box-shadow:inset 0 0 0 1.4px var(--gold)}
#g-card-${t[0]} .str i.f{background:var(--gold)}
#g-card-${t[0]} .str .lbl{margin-left:4px;color:var(--gold)}
#g-card-${t[0]} .price{font:600 28px/1 "Cormorant Garamond";color:var(--accent)}
#g-card-${t[0]} h1{margin-top:12px;font-size:40px}
#g-card-${t[0]} .desc{margin-top:10px;font:500 14.5px/1.55 Manrope;color:var(--ink-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
#g-card-${t[0]} .comp{margin-top:18px}
#g-card-${t[0]} .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
#g-card-${t[0]} .chips span{height:32px;border-radius:16px;padding:0 13px;display:flex;align-items:center;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line-2);font:600 13px/1 Manrope;color:var(--ink-2)}
#g-card-${t[0]} .act{position:absolute;left:0;right:0;bottom:0;padding:14px 22px 34px;display:flex;gap:12px;background:linear-gradient(180deg,rgba(0,0,0,0),var(--bg) 26%)}
#g-card-${t[0]} .act .stp{height:50px;width:122px;border-radius:16px}
#g-card-${t[0]} .act .btn{flex:1}
</style>
<div class="hero"><img src="${PH(c, "photo")}" alt=""></div><div class="x">${$i("close")}</div>
<div class="sheet"><div class="grab"></div>
 <div class="meta"><span class="str"><i class="f"></i><i></i><i></i><span class="lbl">Лёгкий</span></span><span class="price">${rub(c.price)}</span></div>
 <h1 class="h1">${c.name}</h1>
 <p class="desc">${c.desc}</p>
 <div class="comp"><span class="lbl">Состав</span><div class="chips">${c.ings.map((i) => `<span>${i[0]}</span>`).join("")}</div></div>
</div>
<div class="act"><span class="stp">${$i("minus")}<b>1</b>${$i("plus")}</span><div class="btn">Добавить · ${rub(c.price)}</div></div>`);
};

// ───────── Гость: заказ ─────────
const orderBody = (t) => {
  const items = Object.entries(cart).map(([n, q]) => [byName(n), q]);
  const st = { pending: ["Заказан", "p-new"], accepted: ["Принят", "p-warn"], served: ["Выдан", "p-ok"] };
  const [first, ...rest] = D.guest.history;
  return `<style>
#g-order-${t[0]} .it{display:flex;align-items:center;gap:12px;padding:14px 16px;position:relative}
#g-order-${t[0]} .it+.it::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;background:var(--line)}
#g-order-${t[0]} .it .body{flex:1}
#g-order-${t[0]} .tot{display:flex;align-items:baseline;justify-content:space-between;padding:14px 16px 4px;border-top:1px solid var(--line)}
#g-order-${t[0]} .tot b{font:600 30px/1 "Cormorant Garamond"}
#g-order-${t[0]} .send{margin:12px 16px 16px}
#g-order-${t[0]} .note{padding:10px 16px 16px;font:500 12px/1.45 Manrope;color:var(--ink-3)}
#g-order-${t[0]} .live{padding:16px}
#g-order-${t[0]} .live .top{display:flex;align-items:center;justify-content:space-between}
#g-order-${t[0]} .tl{margin-top:14px;position:relative}
#g-order-${t[0]} .tl .s{display:flex;gap:12px;align-items:flex-start;padding-bottom:14px;position:relative}
#g-order-${t[0]} .tl .s::after{content:"";position:absolute;left:9px;top:22px;bottom:2px;width:1.5px;background:var(--line-2)}
#g-order-${t[0]} .tl .s:last-child{padding-bottom:0}#g-order-${t[0]} .tl .s:last-child::after{display:none}
#g-order-${t[0]} .tl .d{width:20px;height:20px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--line-2);flex:none;display:grid;place-items:center}
#g-order-${t[0]} .tl .s.done .d{background:var(--gold);box-shadow:none;color:var(--bg)}
#g-order-${t[0]} .tl .s.done .d svg{width:13px;height:13px;stroke-width:2.4}
#g-order-${t[0]} .tl .s.cur .d{box-shadow:inset 0 0 0 1.5px var(--gold),0 0 0 5px var(--tint)}
#g-order-${t[0]} .tl b{display:block;font:700 14px/1.25 Manrope}
#g-order-${t[0]} .tl .s:not(.done):not(.cur) b{color:var(--ink-3)}
</style>
<div class="scroll">
 <div class="head"><div><h1 class="h1">Ваш заказ</h1><p class="sub">3 коктейля</p></div></div>
 <div class="card rows" style="margin-top:18px">
  ${items.map(([c, q]) => `<div class="it"><span class="th"><img src="${PH(c)}"></span><div class="body"><div class="nm">${c.name}</div><div class="sm">${rub(c.price)}</div></div><span class="stp">${$i("minus")}<b>${q}</b>${$i("plus")}</span></div>`).join("")}
  <div class="tot"><span class="lbl">Итого</span><b>680 ₽</b></div>
  <div class="btn send">${$i("send")}Отправить заказ</div>
 </div>
 <div class="sec"><span class="h2">Мои заказы</span><span class="sm">4 коктейля · 1 050 ₽</span></div>
 <div class="card live"><div class="top"><span class="nm">Заказ №${first.id} · ${first.items}</span><span class="pill p-new">Заказан</span></div>
  <div class="tl"><div class="s done"><span class="d">${$i("check")}</span><div><b>Заказан в 10:05</b><span class="sm">Скоро примем заказ</span></div></div>
  <div class="s cur"><span class="d"></span><div><b>Принят</b><span class="sm">Начнём готовить</span></div></div>
  <div class="s"><span class="d"></span><div><b>Выдан</b></div></div></div></div>
 <div class="card rows" style="margin-top:12px">${rest.map((h) => `<div class="row"><div class="body"><div class="nm" style="font-size:17px">№${h.id} · ${h.items}</div><div class="sm">сегодня в 10:05 · ${rub(h.total_rub)}</div></div><span class="pill ${st[h.status][1]}">${st[h.status][0]}</span></div>`).join("")}</div>
 <div style="height:110px"></div>
</div>`;
};
const order = (t) => S("g-order", t, orderBody(t) + gTabs("order"));

// ───────── Гость: вход — шторка поверх заказа ─────────
const auth = (t) => S("g-auth", t, orderBody(t).replaceAll(`g-order-${t[0]}`, `g-auth-${t[0]}`) + gTabs("order") + `<style>
#g-auth-${t[0]} .dim{position:absolute;inset:0;background:rgba(20,6,10,.45);z-index:45}
#g-auth-${t[0]} .sh{position:absolute;left:0;right:0;bottom:0;z-index:50;border-radius:30px 30px 0 0;background:var(--paint),var(--bg);padding:14px 22px 40px;box-shadow:0 -12px 40px rgba(0,0,0,.25)}
#g-auth-${t[0]} .grab{width:40px;height:5px;border-radius:3px;background:var(--line-2);margin:0 auto 16px}
#g-auth-${t[0]} .f{margin-top:12px;height:56px;border-radius:16px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line-2);padding:9px 16px 0}
#g-auth-${t[0]} .f.on{box-shadow:inset 0 0 0 1.6px var(--gold)}
#g-auth-${t[0]} .f span{display:block;font:600 11.5px/1 Manrope;color:var(--ink-3)}
#g-auth-${t[0]} .f b{display:block;margin-top:6px;font:600 16px/1.2 Manrope}
#g-auth-${t[0]} .f b.hint{color:var(--ink-3);font-weight:500}
#g-auth-${t[0]} .f b i{display:inline-block;width:1.5px;height:18px;background:var(--accent);vertical-align:-3px;margin-left:1px}
#g-auth-${t[0]} .why{margin-top:12px;font:500 12.5px/1.45 Manrope;color:var(--ink-3)}
</style><div class="dim"></div>
<div class="sh"><div class="grab"></div>
 <h2 class="h1" style="font-size:32px">Знакомимся</h2>
 <p class="sub" style="margin-top:4px">Один раз — и мы будем знать, кому нести коктейль.</p>
 <div class="seg"><span>Войти</span><span class="on">Зарегистрироваться</span></div>
 <div class="f"><span>Имя</span><b>Мария</b></div>
 <div class="f"><span>Телефон</span><b>+7 999 000-01-02</b></div>
 <div class="f on"><span>Придумайте PIN-код</span><b class="hint">4–12 цифр<i></i></b></div>
 <div class="btn" style="margin-top:16px">Зарегистрироваться и отправить</div>
 <p class="why">Телефон и PIN нужны, чтобы сохранилась ваша история заказов.</p>
</div>`);

// ───────── Гость: профиль — карта гостя ─────────
const profile = (t) => {
  const g = D.guest, last = byName("Джин Spritz");
  S("g-profile", t, `<style>
#g-profile-${t[0]} .club{position:relative;margin-top:18px;height:224px;border-radius:24px;overflow:hidden;padding:20px 22px;color:#F6ECDF;
  background:radial-gradient(90% 120% at 100% 0%,rgba(214,120,110,.28),rgba(214,120,110,0) 60%),linear-gradient(145deg,#80243A 0%,#521425 55%,#33091A 100%);
  box-shadow:0 22px 44px rgba(64,12,26,.35),inset 0 0 0 1px rgba(227,195,128,${t === "dark" ? ".45" : ".25"})}
#g-profile-${t[0]} .gl{position:absolute;right:-20px;top:0;width:250px;height:100%;fill:none;stroke:#E3C380;stroke-width:.6;opacity:.32}
#g-profile-${t[0]} .club .top{position:relative;display:flex;justify-content:space-between;align-items:flex-start}
#g-profile-${t[0]} .club .wm b{display:block;font:600 22px/1 "Cormorant Garamond";letter-spacing:.3em;color:#E3C380}
#g-profile-${t[0]} .club .wm span{display:block;margin-top:5px;font:700 9px/1 Manrope;letter-spacing:.22em;text-transform:uppercase;color:rgba(246,236,223,.7)}
#g-profile-${t[0]} .club img{width:46px;height:46px}
#g-profile-${t[0]} .club .who{position:relative;margin-top:22px}
#g-profile-${t[0]} .club .who b{display:block;font:600 34px/1 "Cormorant Garamond"}
#g-profile-${t[0]} .club .who span{display:block;margin-top:5px;font:500 13px/1 Manrope;color:rgba(246,236,223,.72);letter-spacing:.06em}
#g-profile-${t[0]} .club .st{position:absolute;left:22px;right:22px;bottom:18px;display:flex;gap:20px}
#g-profile-${t[0]} .club .st div b{display:block;font:700 17px/1 Manrope;color:#F6ECDF}
#g-profile-${t[0]} .club .st div b.it{font:italic 600 19px/1 "Cormorant Garamond";color:#E3C380}
#g-profile-${t[0]} .club .st div span{display:block;margin-top:5px;font:500 11px/1.2 Manrope;color:rgba(246,236,223,.68)}
#g-profile-${t[0]} .last{padding:16px}
#g-profile-${t[0]} .last .r{display:flex;gap:12px;align-items:center}
#g-profile-${t[0]} .last .btn{margin-top:14px;height:46px}
</style>
<div class="scroll">
 <div class="head"><h1 class="h1">Профиль</h1></div>
 <div class="club">${guilloche()}
  <div class="top"><div class="wm"><b>VIA</b><span>Карта гостя</span></div><img src="via-logo-gold.png" alt=""></div>
  <div class="who"><b>${g.guest.name}</b><span>+7 ••• ••• 01 02</span></div>
  <div class="st"><div><b>${g.visit_cocktails}</b><span>коктейля<br>за визит</span></div><div><b>${rub(g.visit_rub)}</b><span>потрачено<br>за визит</span></div><div><b class="it">${g.favorite_cocktail}</b><span>любимый<br>коктейль</span></div></div>
 </div>
 <div class="sec"><span class="h2">Последний заказ</span><span class="sm">сегодня в 10:05</span></div>
 <div class="card last"><div class="r"><span class="th"><img src="${PH(last)}"></span><div style="flex:1"><div class="nm">Джин Spritz × 2</div><div class="sm">460 ₽ · Заказан</div></div></div><div class="btn btn-o">${$i("repeat")}Повторить заказ</div></div>
 <div class="card rows" style="margin-top:14px">
  <div class="row"><span class="ico">${$i("chit")}</span><div class="body"><div style="font-weight:700">Мои заказы</div><div class="sm">3 заказа · 4 коктейля · 1 050 ₽</div></div>${$i("chev", "chev")}</div>
  <div class="row"><span class="ico">${$i("star")}</span><div class="body"><div style="font-weight:700">Мои оценки</div><div class="sm">Оцените выпитые коктейли</div></div>${$i("chev", "chev")}</div>
  <div class="row"><span class="ico">${$i("logout")}</span><div class="body"><div style="font-weight:700" class="acc">Выйти</div></div></div>
 </div><div style="height:100px"></div>
</div>${gTabs("profile")}`);
};

// ───────── Бармен: заказы гостей ─────────
const bOrders = (t) => {
  const o = D.guestOrders;
  const steps = (k) => `<div class="pr">${["Заказан", "Принят", "Выдан"].map((l, i) => `<span class="${i < k ? "done" : i === k ? "cur" : ""}"><i></i>${l}</span>`).join("")}</div>`;
  const card = (x, ini, ago, phone, k) => `<div class="card oc"><div class="top"><span class="av">${ini}</span><div class="body"><div class="nm" style="font-size:21px">${x.guest_name}</div><div class="sm">№${x.id} · 10:05 · ${ago}</div><div class="tel">${$i("phone")}${phone}</div></div><span class="pill ${k ? "p-warn" : "p-new"}">${k ? "Принят" : "Новый"}</span></div>
   ${steps(k)}
   <div class="items">${x.items.map((i) => `<div class="li"><span>${i.cocktail_name}</span><b>× ${i.quantity}</b>${$i("chev", "chev")}</div>`).join("")}</div>
   <div class="ft"><div><b>${rub(x.total_rub)}</b><span class="sm">${x.items.reduce((s, i) => s + i.quantity, 0)} ${x.items.reduce((s, i) => s + i.quantity, 0) === 1 ? "коктейль" : "коктейля"}</span></div>${k ? `<div class="btn s">${$i("check")}Выдать</div>` : `<div class="btn s btn-2">Отклонить</div><div class="btn s">${$i("check")}Принять</div>`}</div></div>`;
  S("b-orders", t, `<style>
#b-orders-${t[0]} .oc{margin-top:14px;padding:16px}
#b-orders-${t[0]} .oc .top{display:flex;gap:12px;align-items:flex-start}
#b-orders-${t[0]} .oc .body{flex:1}
#b-orders-${t[0]} .av{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:var(--btn);color:var(--btn-ink);font:600 21px/1 "Cormorant Garamond";flex:none}
#b-orders-${t[0]} .tel{display:flex;align-items:center;gap:5px;margin-top:3px;font:600 12.5px/1.3 Manrope;color:var(--accent)}
#b-orders-${t[0]} .tel svg{width:13px;height:13px}
#b-orders-${t[0]} .pr{display:flex;justify-content:space-between;position:relative;margin:16px 2px 4px}
#b-orders-${t[0]} .pr::before{content:"";position:absolute;left:10px;right:10px;top:5px;height:1.5px;background:var(--line-2)}
#b-orders-${t[0]} .pr span{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;font:600 11px/1 Manrope;color:var(--ink-3)}
#b-orders-${t[0]} .pr span:first-child{align-items:flex-start}#b-orders-${t[0]} .pr span:last-child{align-items:flex-end}
#b-orders-${t[0]} .pr i{width:12px;height:12px;border-radius:50%;background:var(--surface);box-shadow:inset 0 0 0 1.5px var(--line-2)}
#b-orders-${t[0]} .pr .done i{background:var(--gold);box-shadow:none}#b-orders-${t[0]} .pr .done{color:var(--ink-2)}
#b-orders-${t[0]} .pr .cur i{background:var(--surface);box-shadow:inset 0 0 0 3.5px var(--gold),0 0 0 4px var(--tint)}#b-orders-${t[0]} .pr .cur{color:var(--ink)}
#b-orders-${t[0]} .items{margin-top:12px;border-top:1px solid var(--line)}
#b-orders-${t[0]} .li{display:flex;align-items:center;gap:8px;padding:11px 0;border-bottom:1px solid var(--line);font:600 15px/1 Manrope}
#b-orders-${t[0]} .li span{flex:1;font:600 18px/1 "Cormorant Garamond"}
#b-orders-${t[0]} .ft{display:flex;align-items:center;gap:10px;margin-top:14px}
#b-orders-${t[0]} .ft>div:first-child{flex:1;white-space:nowrap}
#b-orders-${t[0]} .ft>div:first-child b{display:block;font:700 19px/1.1 Manrope}
</style>
<div class="scroll">
 <div class="head"><h1 class="h1">Заказы</h1><span class="rbtn">${$i("refresh")}</span></div>
 <div class="seg"><span class="on">Гости <i>3</i></span><span>Стойка <i>3</i></span></div>
 ${card(o[0], "М", "1 мин назад", "+7 999 000-01-02", 0)}
 ${card(o[1], "А", "3 мин назад", "+7 999 000-01-03", 0)}
 ${card(o[2], "М", "8 мин назад", "+7 999 000-01-02", 1)}
</div>${bTabs("orders")}`);
};

// ───────── Бармен: рецепты + заказ за стойкой ─────────
const bRecipes = (t) => {
  const inOrder = { "Голубая лагуна": 2 };
  const short = { "Пина колада": "Взбитые сливки" };
  S("b-recipes", t, `<style>
#b-recipes-${t[0]} .rows .row{align-items:center;padding:12px 14px}
#b-recipes-${t[0]} .rows .th{width:50px;height:50px;border-radius:13px}
#b-recipes-${t[0]} .rows .ln{display:flex;align-items:baseline;gap:8px}
#b-recipes-${t[0]} .rows .ln .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#b-recipes-${t[0]} .rows .ln b{font:700 13.5px/1 Manrope;color:var(--accent)}
#b-recipes-${t[0]} .rows .one{margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#b-recipes-${t[0]} .rows .pill{margin-top:7px}
#b-recipes-${t[0]} .rows .pill svg{width:13px;height:13px}
#b-recipes-${t[0]} .pl{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;box-shadow:inset 0 0 0 1.4px var(--gold-line);color:var(--accent);flex:none}
#b-recipes-${t[0]} .pl.dim{opacity:.35}
#b-recipes-${t[0]} .pl svg{width:18px;height:18px}
#b-recipes-${t[0]} .stp{width:92px}
#b-recipes-${t[0]} .counter{position:absolute;left:12px;right:12px;bottom:98px;z-index:31;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;border-radius:20px;background:var(--surface);box-shadow:0 18px 40px rgba(40,8,16,.28),inset 0 0 0 1px var(--line-2)}
#b-recipes-${t[0]} .counter .body{flex:1;min-width:0}
#b-recipes-${t[0]} .counter .q{font:700 15px/1.2 Manrope;white-space:nowrap}
#b-recipes-${t[0]} .counter .sm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#b-recipes-${t[0]} .counter .btn{height:44px;border-radius:14px;padding:0 13px;font-size:13.5px;flex:none}
</style>
<div class="scroll">
 <div class="head"><div><h1 class="h1">Рецепты</h1><p class="sub">Книга бара: из неё собирается гостевое меню</p></div><span class="rbtn">${$i("plus")}</span></div>
 <div class="search">${$i("search")}Коктейль или ингредиент</div>
 <div class="tabs"><span class="on">Все<small>12</small></span><span>Лёгкие<small>7</small></span><span>Средние<small>2</small></span><span>Крепкие<small>3</small></span></div>
 <div class="card rows" style="margin-top:16px">${withPhoto.map((c) => `<div class="row"><span class="th"><img src="${PH(c)}"></span><div class="body"><div class="ln"><span class="nm">${c.name}</span><b>${rub(c.price)}</b></div><div class="sm one">${ings(c)}</div>${short[c.name] ? `<span class="pill p-warn">${$i("warn")}Не хватает: ${short[c.name]}</span>` : ""}</div>${inOrder[c.name] ? `<span class="stp">${$i("minus")}<b>${inOrder[c.name]}</b>${$i("plus")}</span>` : `<span class="pl ${short[c.name] ? "dim" : ""}">${$i("plus")}</span>`}</div>`).join("")}</div>
</div>
<div class="counter"><div class="body"><div class="q">3 коктейля · 790 ₽</div><div class="sm">Стойка: Голубая лагуна × 2, Изумрудная кровь</div></div><div class="btn btn-2">Очистить</div><div class="btn">Принять</div></div>
${bTabs("recipes")}`);
};

// ───────── Бармен: склад ─────────
const P = D.products, pBy = (n) => P.find((p) => p.name === n);
const fill = (p) => (p && p.vol ? Math.max(0, Math.min(1, p.stock / p.vol)) : 0);
const qty = (p) => (p.stock >= 1000 ? (p.stock / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/ /g, " ") + (p.unit === "g" ? " кг" : " л") : p.stock + (p.unit === "g" ? " г" : " мл"));
const bStock = (t) => {
  const restock = [["Ликер Дынный", "Нужен для: Зеленая фея", "out"], ["Сок апельсиновый", "700 мл — хватит на 2 порции", "low"], ["Тархун", "500 мл — хватит на 1 порцию", "low"], ["Тоник Апероль", "0 мл — меньше чем на порцию", "low"], ["Энергетик", "898 мл — хватит на 3 порции", "low"]];
  const bar = (f, k) => `<span class="lv"><i style="width:${Math.round(f * 100)}%;background:${k === "out" || f <= 0 ? "var(--danger)" : f < 0.35 ? "var(--warn)" : "var(--gold)"}"></i></span>`;
  S("b-stock", t, `<style>
#b-stock-${t[0]} .rows .row{padding:12px 16px}
#b-stock-${t[0]} .lv{display:block;height:4px;border-radius:2px;background:var(--surface-2);margin-top:8px;overflow:hidden}
#b-stock-${t[0]} .lv i{display:block;height:100%;border-radius:2px}
#b-stock-${t[0]} .amt{text-align:right;flex:none}
#b-stock-${t[0]} .amt b{display:block;font:700 14px/1.2 Manrope}
#b-stock-${t[0]} .rows .nm{font-size:18px}
</style>
<div class="scroll">
 <div class="head"><div><h1 class="h1">Склад</h1><p class="sub">28 ингредиентов на 27 411 ₽</p></div><span class="rbtn">${$i("plus")}</span></div>
 <div class="search">${$i("search")}Ингредиент или бренд</div>
 <div class="sec"><span class="h2">Пора докупить</span><span class="sm">мало — до 3 порций</span></div>
 <div class="card rows">${restock.map(([n, s, k]) => { const p = pBy(n); return `<div class="row"><div class="body"><div class="nm">${n}</div><div class="sm">${s}</div></div><span class="pill ${k === "out" ? "p-out" : "p-warn"}">${k === "out" ? "Нет" : "Мало"}</span>${$i("chev", "chev")}</div>`; }).join("")}</div>
 <div class="sec"><span class="h2">В шкафу</span><span class="sm">28</span></div>
 <div class="card rows">${["Coca-Cola", "MARTINI Fiero", "Sprite", "Абсент"].map((n) => { const p = pBy(n); return `<div class="row"><div class="body"><div class="nm">${n}</div><div class="sm">${p.n > 1 ? p.n + " бутылки · " : ""}в среднем ${p.price.toFixed(p.price < 1 ? 3 : 2).replace(".", ",")} ₽/мл</div>${bar(fill(p))}</div><div class="amt"><b>${qty(p)}</b></div>${$i("chev", "chev")}</div>`; }).join("")}</div>
 <div style="height:100px"></div>
</div>${bTabs("stock")}`);
};

// ───────── Бармен: закупки ─────────
const bShop = (t) => {
  const U = D.purchases, by = {};
  U.forEach((u) => (by[u.purchased_at] = by[u.purchased_at] || []).push(u));
  const lab = { "2026-10-16": "Вчера", "2026-10-14": "14 октября", "2026-10-10": "10 октября", "2026-10-04": "4 октября" };
  const q = (u) => (u.bottles > 1 ? u.bottles + " × " + (u.purchased_qty / u.bottles).toLocaleString("ru-RU").replace(/ /g, " ") : u.purchased_qty.toLocaleString("ru-RU").replace(/ /g, " ")) + (u.unit === "g" ? " г" : " мл");
  const per = (u) => (u.price_rub / u.purchased_qty).toFixed(2).replace(".", ",") + " ₽/" + (u.unit === "g" ? "г" : "мл");
  S("b-shop", t, `<style>
#b-shop-${t[0]} .sum{margin-top:16px;padding:18px 18px 16px;display:flex;align-items:flex-end;justify-content:space-between}
#b-shop-${t[0]} .sum b{display:block;font:600 34px/1 "Cormorant Garamond";color:var(--accent);margin-top:8px}
#b-shop-${t[0]} .sum .r{text-align:right}
#b-shop-${t[0]} .rows .row{padding:12px 16px}
#b-shop-${t[0]} .rows .nm{font-size:18px}
#b-shop-${t[0]} .pr{text-align:right;flex:none}
#b-shop-${t[0]} .pr b{display:block;font:700 14.5px/1.2 Manrope}
#b-shop-${t[0]} .seg span{font-size:13px}
</style>
<div class="scroll">
 <div class="head"><div><h1 class="h1">Закупки</h1><p class="sub">Новая закупка сразу пополняет склад</p></div><span class="rbtn">${$i("plus")}</span></div>
 <div class="seg"><span>Сегодня</span><span>Неделя</span><span class="on">Месяц</span><span>Всё</span></div>
 <div class="card sum"><div><span class="lbl">Потрачено</span><b>27 299 ₽</b></div><div class="r sm">18 сентября — 17 октября<br>28 закупок</div></div>
 ${["2026-10-16", "2026-10-14"].map((d) => `<div class="sec"><span class="h2">${lab[d]}</span><span class="sm num">${rub(by[d].reduce((s, u) => s + u.price_rub, 0))}</span></div>
 <div class="card rows">${by[d].slice(0, 3).map((u) => `<div class="row"><div class="body"><div class="nm">${u.ingredient_name}</div><div class="sm">${q(u)} · ${u.brand} · ${u.store}</div></div><div class="pr"><b>${rub(u.price_rub)}</b><span class="sm">${per(u)}</span></div></div>`).join("")}</div>`).join("")}
 <div style="height:100px"></div>
</div>${bTabs("shop")}`);
};

// ───────── Бармен: статистика и смена ─────────
const bShift = (t) => {
  // Прошлые смены — пример для макета; текущая — из тестовой копии.
  const past = [["16 октября", "19:30 — 01:10", 6, 11, 3240], ["11 октября", "20:00 — 23:40", 4, 7, 1980], ["4 октября", "18:45 — 00:20", 8, 15, 4310]];
  S("b-shift", t, `<style>
#b-shift-${t[0]} .cur{margin-top:18px;padding:18px}
#b-shift-${t[0]} .cur .top{display:flex;align-items:center;justify-content:space-between}
#b-shift-${t[0]} .live{display:inline-flex;align-items:center;gap:7px;font:700 13px/1 Manrope;color:var(--ok)}
#b-shift-${t[0]} .live i{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px var(--ok-tint)}
#b-shift-${t[0]} .kp{display:grid;grid-template-columns:1fr 1fr 1.3fr;margin-top:18px;border-top:1px solid var(--line);padding-top:16px}
#b-shift-${t[0]} .kp div+div{border-left:1px solid var(--line);padding-left:14px}
#b-shift-${t[0]} .kp b{display:block;font:600 30px/1 "Cormorant Garamond";color:var(--accent)}
#b-shift-${t[0]} .kp span{display:block;margin-top:5px;font:600 12px/1 Manrope;color:var(--ink-3)}
#b-shift-${t[0]} .cur .btn{margin-top:18px}
#b-shift-${t[0]} .cur .note{margin-top:10px}
#b-shift-${t[0]} .rows .row{padding:13px 16px}
#b-shift-${t[0]} .rv{text-align:right;flex:none}
#b-shift-${t[0]} .rv b{display:block;font:700 15px/1.2 Manrope}
</style>
<div class="scroll">
 <div class="head"><div><h1 class="h1">Статистика</h1><p class="sub">Смены за стойкой: заказы, коктейли и выручка</p></div></div>
 <div class="card cur"><div class="top"><span class="h2">Текущая смена</span><span class="live"><i></i>идёт с 10:05</span></div>
  <div class="kp"><div><b>3</b><span>заказа</span></div><div><b>3</b><span>коктейля</span></div><div><b>810 ₽</b><span>выручка</span></div></div>
  <div class="btn btn-o">Закрыть смену</div>
  <p class="sm note">После закрытия у гостей обнулятся счётчики «за визит».</p></div>
 <div class="sec"><span class="h2">Все смены</span><span class="sm">4</span></div>
 <div class="card rows">${past.map(([d, h, o, c, r]) => `<div class="row"><div class="body"><div class="nm" style="font-size:18px">${d}</div><div class="sm">${h} · ${o} заказов · ${c} коктейлей</div></div><div class="rv"><b>${rub(r)}</b></div></div>`).join("")}</div>
 <div style="height:100px"></div>
</div>${bTabs("more")}`);
};

// ───────── Бармен: ещё ─────────
const bMore = (t) => {
  const r = (ic, title, sub, right = $i("chev", "chev"), cls = "") => `<div class="row ${cls}"><span class="ico">${$i(ic)}</span><div class="body"><div style="font-weight:700">${title}</div>${sub ? `<div class="sm">${sub}</div>` : ""}</div>${right}</div>`;
  S("b-more", t, `<style>
#b-more-${t[0]} .rows .row{padding:11px 16px}
#b-more-${t[0]} .g{margin:22px 4px 8px}
#b-more-${t[0]} .tg{width:48px;height:29px;border-radius:15px;background:var(--btn-solid);position:relative;flex:none}
#b-more-${t[0]} .tg::after{content:"";position:absolute;right:3px;top:3px;width:23px;height:23px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.25)}
#b-more-${t[0]} .red .ico{background:var(--danger-tint);color:var(--danger)}#b-more-${t[0]} .red .body>div:first-child{color:var(--danger)}
</style>
<div class="scroll">
 <div class="head"><h1 class="h1">Ещё</h1></div>
 <div class="lbl g">Бар</div>
 <div class="card rows">${r("leaf", "Ингредиенты", "Справочник для рецептов и склада")}${r("chart", "Статистика и смены", "Текущая смена идёт с 10:05")}${r("camera", "Фото коктейлей", "Лишних нет, в хранилище 24 файла", "")}</div>
 <div class="lbl g">Гости</div>
 <div class="card rows">${r("star", "Отзывы гостей", "2 отзыва · средняя 4,5", `<span class="pill p-new">2 новых</span>${$i("chev", "chev")}`)}${r("coupe", "Гостевое меню", "Так видят бар гости")}${r("home", "Главная", "")}</div>
 <div class="lbl g">Уведомления</div>
 <div class="card rows">${r("bell", "Новые заказы и отзывы", "Включены на этом телефоне", `<span class="tg"></span>`)}${r("send", "Проверить уведомление", "Придёт через 5 секунд")}</div>
 <div class="lbl g">Безопасность</div>
 <div class="card rows">${r("lock", "Сменить код", "Панель открыта на 3 устройствах")}${r("logout", "Выйти на этом телефоне", "", "")}${r("close", "Выйти на всех устройствах", "Если телефон потерялся", "", "red")}</div>
 <div style="height:100px"></div>
</div>${bTabs("more")}`);
};

// ───────── Плитка «стиль» ─────────
const style = (t) => S("style", t, `<style>
#style-${t[0]} .sb,#style-${t[0]} .home{display:none}
#style-${t[0]} .scroll{padding:46px 26px}
#style-${t[0]} .lg{display:flex;align-items:center;gap:18px}
#style-${t[0]} .lg img{width:96px;height:96px}
#style-${t[0]} .wm b{display:block;font:600 46px/1 "Cormorant Garamond";letter-spacing:.32em;color:var(--accent)}
#style-${t[0]} .wm span{display:block;margin-top:10px;font:700 10px/1 Manrope;letter-spacing:.24em;text-transform:uppercase;color:var(--ink-3)}
#style-${t[0]} .sw{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:28px}
#style-${t[0]} .sw div{height:84px;border-radius:18px;padding:10px 11px;display:flex;flex-direction:column;justify-content:flex-end;font:700 10.5px/1.35 Manrope;box-shadow:inset 0 0 0 1px var(--line-2)}
#style-${t[0]} .ty{margin-top:26px}
#style-${t[0]} .ty>div{padding:13px 0;border-top:1px solid var(--line);display:flex;align-items:baseline;justify-content:space-between;gap:10px}
#style-${t[0]} .ty small{font:600 11px/1.3 Manrope;color:var(--ink-3);text-align:right}
#style-${t[0]} .bt{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
#style-${t[0]} .bt .btn{height:44px;padding:0 18px;font-size:14px}
</style>
<div class="scroll"><div class="lg"><img src="via-logo-${t === "light" ? "bordeaux" : "gold"}.png" alt=""><div class="wm"><b>VIA</b><span>bar · by Vladimir &amp; Anastasia</span></div></div>
<p class="sub" style="margin-top:18px">${t === "light" ? "День: слоновая кость, бордо и золото. Много воздуха, мягкие тени. Фото коктейлей — снимки в бордовом баре." : "Вечер: глубокое бордо, золото и крем. Та же разметка, золотые кнопки, те же фото."}</p>
<div class="sw">${(t === "light" ? [["#F6EFE5", "#2A0E16", "Слоновая кость"], ["#FFFDF9", "#2A0E16", "Карточки"], ["#F0E6D8", "#2A0E16", "Поля"], ["#6E1A2B", "#FBF2E4", "Бордо"], ["#A27C3A", "#FFF", "Золото"], ["#2A0E16", "#F6ECDF", "Чернила"]] : [["#1A090F", "#F6ECDF", "Ночь"], ["#27101A", "#F6ECDF", "Карточки"], ["#351620", "#F6ECDF", "Поля"], ["#6E1A2B", "#F6ECDF", "Бордо"], ["#E3C380", "#2A0E16", "Золото"], ["#F6ECDF", "#2A0E16", "Крем"]]).map(([b, f, n]) => `<div style="background:${b};color:${f}">${n}<br>${b}</div>`).join("")}</div>
<div class="ty">
 <div><span class="h1" style="font-size:34px">Заголовки</span><small>Cormorant<br>Garamond</small></div>
 <div><span style="font:700 17px/1 Manrope">Текст и кнопки</span><small>Manrope</small></div>
</div>
<div class="bt"><div class="btn">Отправить заказ</div><div class="btn btn-2">Очистить</div><div class="btn btn-o">Повторить</div></div>
<div class="bt" style="margin-top:14px"><span class="pill p-new">Новый</span><span class="pill p-warn">Принят</span><span class="pill p-ok">Выдан</span><span class="pill p-out">Нет</span></div>
</div>`);

for (const t of ["light", "dark"]) { TH = t; menu(t); cardScreen(t); order(t); auth(t); profile(t); style(t); }
for (const t of ["dark", "light"]) { TH = t; bOrders(t); bRecipes(t); bStock(t); bShop(t); bShift(t); bMore(t); }
document.getElementById("root").outerHTML = out.join("");
