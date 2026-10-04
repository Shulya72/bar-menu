const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

const page = (body, title = "Карты Бара") => new Response(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0b0b">
<title>${title}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#090909;color:#f5f5f5;font:15px system-ui,-apple-system,sans-serif}
header{padding:18px 16px;border-bottom:1px solid #242424;position:sticky;top:0;background:#090909ee;backdrop-filter:blur(10px);z-index:3}
h1{margin:0;font-size:22px}h2{margin:0 0 8px}h3{margin:0 0 6px}.sub{color:#999;margin-top:4px}
.wrap{max-width:980px;margin:auto;padding:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}
.card{border:1px solid #292929;border-radius:18px;padding:18px;background:#111}
label{display:block;color:#aaa;font-size:13px;margin:12px 0 6px}
input,textarea,select{width:100%;padding:12px;border:1px solid #333;border-radius:12px;background:#181818;color:#fff;font:inherit}
textarea{min-height:80px;resize:vertical}
button{border:0;border-radius:12px;padding:12px 16px;background:#c8ff3d;color:#000;font-weight:800;cursor:pointer}
button.secondary{background:#252525;color:#fff}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
a{color:#c8ff3d;text-decoration:none}.muted{color:#999}.pill{display:inline-block;padding:5px 9px;border-radius:99px;background:#202020;color:#bbb;margin:3px 3px 0 0}
.recipe-row{display:grid;grid-template-columns:1fr 100px 80px;gap:8px;align-items:end;margin-bottom:8px}
.recipe-row button{padding:10px}.empty{padding:24px;text-align:center;color:#888}
@media(max-width:600px){.recipe-row{grid-template-columns:1fr 90px 58px}}
</style>
</head><body>${body}</body></html>`, {headers:{"content-type":"text/html;charset=UTF-8"}});

const refreshCocktailPrice = async (env, cocktailId) => {
  const { results } = await env.DB.prepare(`
    SELECT ri.quantity,
      COALESCE((SELECT pb.price_rub / NULLIF(pb.purchased_qty,0)
        FROM purchase_batches pb
        WHERE pb.product_id=ri.product_id AND pb.remaining_qty>0
        ORDER BY pb.purchased_at DESC, pb.id DESC LIMIT 1),0) unit_cost
    FROM recipe_items ri WHERE ri.cocktail_id=?
  `).bind(cocktailId).all();
  const cost = results.reduce((sum,x)=>sum+Number(x.quantity)*Number(x.unit_cost),0);
  const price = Math.max(0,Math.round((cost*3)/10)*10);
  await env.DB.prepare("UPDATE cocktails SET price_rub=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(price,cocktailId).run();
  return {cost,price};
};

const getCocktails = async (env) => {
  const { results } = await env.DB.prepare(
    "SELECT id,name,description,category,strength,price_rub,photo_url,glass,ice,method,garnish,is_active,created_at,updated_at FROM cocktails WHERE is_active=1 ORDER BY name"
  ).all();
  return results;
};

const getProducts = async (env) => {
  const { results } = await env.DB.prepare(
    "SELECT p.id,p.name,p.brand,p.category,p.unit,p.min_stock,COALESCE(SUM(b.remaining_qty),0) stock FROM products p LEFT JOIN purchase_batches b ON b.product_id=p.id WHERE p.is_active=1 GROUP BY p.id ORDER BY p.name"
  ).all();
  return results;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") return json({ok:true,service:"bar-menu",database:"bar-menu-db"});

      if (url.pathname === "/api/cocktails" && request.method === "GET") {
        return json(await getCocktails(env));
      }

      if (url.pathname === "/api/cocktails" && request.method === "POST") {
        const data = await request.json();
        const name = String(data.name || "").trim();
        if (!name) return json({error:"Название коктейля обязательно"},400);

        const result = await env.DB.prepare(
          `INSERT INTO cocktails
          (name,description,category,strength,price_rub,photo_url,glass,ice,method,garnish)
          VALUES (?,?,?,?,0,?,?,?,?,?)`
        ).bind(
          name,
          String(data.description || ""),
          String(data.category || ""),
          String(data.strength || ""),
          String(data.photo_url || ""),
          String(data.glass || ""),
          String(data.ice || ""),
          String(data.method || ""),
          String(data.garnish || "")
        ).run();

        const cocktailId = result.meta.last_row_id;
        const items = Array.isArray(data.recipe_items) ? data.recipe_items : [];
        for (const item of items) {
          const productId = Number(item.product_id);
          const quantity = Number(item.quantity);
          if (Number.isInteger(productId) && quantity > 0) {
            await env.DB.prepare(
              "INSERT INTO recipe_items (cocktail_id,product_id,quantity) VALUES (?,?,?)"
            ).bind(cocktailId,productId,quantity).run();
          }
        }
        const pricing=await refreshCocktailPrice(env,cocktailId);\n        return json({ok:true,id:cocktailId,pricing},201);
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return json(await getProducts(env));
      }

      if (url.pathname === "/api/products" && request.method === "POST") {
        const data = await request.json();
        const name = String(data.name || "").trim();
        const unit = String(data.unit || "");
        if (!name || !["ml","g","pcs"].includes(unit)) {
          return json({error:"Укажите название и единицу: ml, g или pcs"},400);
        }
        const result = await env.DB.prepare(
          "INSERT INTO products (name,brand,category,unit,min_stock) VALUES (?,?,?,?,?)"
        ).bind(
          name,
          String(data.brand || ""),
          String(data.category || ""),
          unit,
          Number(data.min_stock || 0)
        ).run();
        return json({ok:true,id:result.meta.last_row_id},201);
      }

      if (url.pathname === "/api/cocktail" && request.method === "GET") {
        const id = Number(url.searchParams.get("id"));
        if (!Number.isInteger(id)) return json({error:"Некорректный id"},400);
        const cocktail = await env.DB.prepare("SELECT * FROM cocktails WHERE id=?").bind(id).first();
        if (!cocktail) return json({error:"Коктейль не найден"},404);
        const {results} = await env.DB.prepare(
          `SELECT ri.product_id,ri.quantity,p.name,p.brand,p.unit
           FROM recipe_items ri JOIN products p ON p.id=ri.product_id
           WHERE ri.cocktail_id=? ORDER BY ri.id`
        ).bind(id).all();
        return json({...cocktail,recipe_items:results});
      }

      if (url.pathname === "/") return page(`
<header><h1>🍸 Карты Бара</h1><div class="sub">Cloudflare + D1</div></header>
<div class="wrap">
  <div class="card">
    <h2>Система запущена</h2>
    <p class="muted">База данных подключена. Теперь приложение можно наполнять реальными данными.</p>
    <div class="row">
      <a href="/bar">👨‍🍳 Меню бармена</a>
      <a href="/menu">🥂 Карта бара</a>
    </div>
  </div>
</div>`);

      if (url.pathname === "/bar") return page(`
<header><h1>👨‍🍳 Меню бармена</h1><div class="sub">Рабочая часть</div></header>
<div class="wrap"><div class="grid">
<a class="card" href="/bar/recipes"><h2>🍸 Книга рецептов</h2><p class="muted">Создание коктейлей и рецептур</p></a>
<a class="card" href="/bar/stock"><h2>📦 Склад</h2><p class="muted">Товары и остатки</p></a>
<a class="card" href="/bar/shop"><h2>🛒 Магазин</h2><p class="muted">Закупки и партии</p></a>
<a class="card" href="/bar/orders"><h2>🔔 Заказы</h2><p class="muted">Заказы гостей</p></a>
</div></div>`);

      if (url.pathname === "/bar/recipes") return page(`
<header><h1>🍸 Книга рецептов</h1><div class="sub">Рецепт здесь — источник для гостевой «Карты бара»</div></header>
<div class="wrap">
  <div class="card">
    <h2>Новый коктейль</h2>
    <form id="cocktailForm">
      <label>Название *</label><input name="name" required placeholder="Например, Negroni">
      <label>Описание для гостя</label><textarea name="description" placeholder="Короткое описание вкуса"></textarea>
      <div class="grid">
        <div><div><label>Категория</label><input name="category" placeholder="Классика"></div></div>
        <div><div><label>Крепость</label><input name="strength" placeholder="Крепкий"></div></div>
                <div><div><label>Бокал</label><input name="glass" placeholder="Rocks"></div></div>
      </div>
      <label>Лёд</label><input name="ice" placeholder="Крупный куб">
      <label>Метод приготовления</label><textarea name="method" placeholder="Stir / Shake / Build..."></textarea>
      <label>Гарнир</label><input name="garnish" placeholder="Апельсиновая цедра">
      <label>Фото URL (пока временно)</label><input name="photo_url" placeholder="Позже подключим загрузку в R2">

      <h3 style="margin-top:22px">Состав</h3>
      <div id="recipeItems"></div>
      <button type="button" class="secondary" id="addIngredient">＋ Добавить ингредиент</button>

      <div style="margin-top:18px"><button type="submit">💾 Сохранить коктейль</button></div>
      <p id="msg" class="muted"></p>
    </form>
  </div>

  <div style="height:16px"></div>
  <div class="card"><h2>Коктейли</h2><div id="list">Загрузка...</div></div>
</div>

<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let products=[];
const load=async()=>{
  const [cr,pr]=await Promise.all([fetch("/api/cocktails"),fetch("/api/products")]);
  const cocktails=await cr.json(); products=await pr.json();
  document.querySelector("#list").innerHTML=cocktails.length
    ? cocktails.map(c=>'<div style="padding:14px 0;border-bottom:1px solid #292929"><h3>'+esc(c.name)+'</h3><div class="muted">'+esc(c.description||"Без описания")+'</div><span class="pill">'+esc(c.category||"Без категории")+'</span><span class="pill">'+esc(c.strength||"")+'</span><span class="pill">'+Number(c.price_rub||0)+' ₽</span></div>').join("")
    : '<div class="empty">Пока коктейлей нет. Создай первый 👇</div>';
};
const addRow=()=>{
  const wrap=document.createElement("div"); wrap.className="recipe-row";
  wrap.innerHTML='<select class="prod"><option value="">Ингредиент...</option>'+products.map(p=>'<option value="'+p.id+'">'+esc(p.name)+(p.brand?' — '+esc(p.brand):"")+' ('+p.unit+')</option>').join("")+'</select><input class="qty" type="number" min="0.01" step="0.01" placeholder="Количество"><button type="button" class="secondary remove">×</button>';
  wrap.querySelector(".remove").onclick=()=>wrap.remove();
  document.querySelector("#recipeItems").appendChild(wrap);
};
document.querySelector("#addIngredient").onclick=addRow;
document.querySelector("#cocktailForm").onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const recipe_items=[...document.querySelectorAll(".recipe-row")].map(r=>({product_id:Number(r.querySelector(".prod").value),quantity:Number(r.querySelector(".qty").value)})).filter(x=>x.product_id&&x.quantity>0);
  const body=Object.fromEntries(f.entries()); body.recipe_items=recipe_items;
  const r=await fetch("/api/cocktails",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data=await r.json();
  document.querySelector("#msg").textContent=r.ok?"Сохранено ✅":"Ошибка: "+(data.error||"не удалось сохранить");
  if(r.ok){e.target.reset();document.querySelector("#recipeItems").innerHTML="";await load();}
};
load(); addRow();
</script>`, "Книга рецептов");

      if (url.pathname === "/bar/stock") return page(`
<header><h1>📦 Склад</h1><div class="sub">Справочник товаров и текущие остатки</div></header>
<div class="wrap">
<div class="card">
<h2>Новый товар</h2>
<form id="productForm">
<label>Название *</label><input name="name" required placeholder="Gin">
<label>Бренд</label><input name="brand" placeholder="Beefeater">
<label>Категория</label><input name="category" placeholder="Джин">
<label>Единица хранения *</label><select name="unit"><option value="ml">мл</option><option value="g">г</option><option value="pcs">шт.</option></select>
<label>Минимальный остаток</label><input name="min_stock" type="number" min="0" step="0.01" value="0">
<div style="margin-top:16px"><button>＋ Добавить товар</button></div>
<p id="msg" class="muted"></p>
</form>
</div>
<div style="height:16px"></div>
<div class="card"><h2>Товары</h2><div id="stock">Загрузка...</div></div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function load(){const r=await fetch("/api/products");const x=await r.json();document.querySelector("#stock").innerHTML=x.length?x.map(p=>'<div style="padding:12px 0;border-bottom:1px solid #292929"><b>'+esc(p.name)+'</b> '+esc(p.brand||"")+'<div class="muted">'+esc(p.category||"")+' · '+p.stock+' '+p.unit+'</div></div>').join(""):'<div class="empty">Товаров пока нет.</div>'}
document.querySelector("#productForm").onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));body.min_stock=Number(body.min_stock||0);const r=await fetch("/api/products",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json();document.querySelector("#msg").textContent=r.ok?"Товар добавлен ✅":"Ошибка: "+(d.error||"");if(r.ok){e.target.reset();await load()}};
load();
</script>`, "Склад");

      if (url.pathname === "/menu") return page(`
<header><h1>🥂 Карта бара</h1><div class="sub">Гостевое меню · без рецептур</div></header>
<div class="wrap"><div id="menu" class="grid"><div class="card">Загрузка...</div></div></div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
fetch("/api/cocktails").then(r=>r.json()).then(x=>{document.querySelector("#menu").innerHTML=x.length?x.map(c=>'<div class="card">'+(c.photo_url?'<img src="'+esc(c.photo_url)+'" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;margin-bottom:12px">':"")+'<h2>'+esc(c.name)+'</h2><p class="muted">'+esc(c.description)+'</p><span class="pill">'+esc(c.strength||"")+'</span><span class="pill">'+Number(c.price_rub||0)+' ₽</span></div>').join(""):'<div class="card">Пока коктейлей нет.</div>'});
</script>`);

      if (url.pathname === "/bar/shop") return page(`
<header><h1>🛒 Магазин</h1><div class="sub">Закупки — следующий модуль</div></header>
<div class="wrap"><div class="card"><h2>Здесь будет учёт закупок</h2><p class="muted">Партии товара, цена закупки, остаток партии и журнал движений.</p><a href="/bar">← Назад</a></div></div>`);

      if (url.pathname === "/bar/orders") return page(`
<header><h1>🔔 Заказы</h1><div class="sub">Заказы гостей — следующий модуль</div></header>
<div class="wrap"><div class="card"><h2>Здесь будут заказы</h2><p class="muted">Гость → заказ → принят барменом → приготовлен → выдан.</p><a href="/bar">← Назад</a></div></div>`);

      return new Response("Не найдено",{status:404});
    } catch (error) {
      console.error(error);
      return json({error:"Ошибка сервера",details:String(error?.message||error)},500);
    }
  }
};
