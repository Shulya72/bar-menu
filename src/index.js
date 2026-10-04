
const ensureIngredientSystem=async env=>{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL CHECK(unit IN ('ml','g','pcs')), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS recipe_ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, cocktail_id INTEGER NOT NULL REFERENCES cocktails(id) ON DELETE CASCADE, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL CHECK(quantity > 0), UNIQUE(cocktail_id, ingredient_id))").run();
  try{await env.DB.prepare("ALTER TABLE products ADD COLUMN ingredient_id INTEGER").run()}catch(e){}
  const {results: ps}=await env.DB.prepare("SELECT id,name,ingredient_id FROM products WHERE is_active=1").all();
  for(const p of ps){
    if(p.ingredient_id) continue;
    const ing=await env.DB.prepare("SELECT id FROM ingredients WHERE name=? LIMIT 1").bind(p.name).first();
    if(ing) await env.DB.prepare("UPDATE products SET ingredient_id=? WHERE id=?").bind(ing.id,p.id).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) SELECT ri.cocktail_id,p.ingredient_id,ri.quantity FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE p.ingredient_id IS NOT NULL").run();
};

const resolveIngredient=async(env,name)=>{
  await ensureIngredientSystem(env);
  const n=String(name||"").trim();
  if(!n) return null;
  const hit=await env.DB.prepare("SELECT id FROM ingredients WHERE lower(replace(name,'ё','е'))=lower(replace(?,'ё','е')) AND is_active=1 LIMIT 1").bind(n).first();
  if(hit)return Number(hit.id);
  const r=await env.DB.prepare("INSERT INTO ingredients(name,unit) VALUES(?,?)").bind(n,"ml").run();
  return Number(r.meta.last_row_id);
};

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
  await ensureIngredientSystem(env);
  const { results } = await env.DB.prepare(`
    SELECT ri.quantity,
      COALESCE((SELECT pb.price_rub / NULLIF(pb.purchased_qty,0)
        FROM purchase_batches pb JOIN products pp ON pp.id=pb.product_id
        WHERE pp.ingredient_id=ri.ingredient_id AND pb.remaining_qty>0
        ORDER BY pb.purchased_at DESC, pb.id DESC LIMIT 1),0) unit_cost
    FROM recipe_ingredients ri WHERE ri.cocktail_id=?
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
  await ensureIngredientSystem(env);
  const { results } = await env.DB.prepare(
    "SELECT p.id,p.ingredient_id,i.name ingredient_name,p.brand,p.category,p.unit,p.min_stock,COALESCE(SUM(b.remaining_qty),0) stock FROM products p JOIN ingredients i ON i.id=p.ingredient_id LEFT JOIN purchase_batches b ON b.product_id=p.id WHERE p.is_active=1 GROUP BY p.id ORDER BY i.name,p.brand"
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
        const data=await request.json(), name=String(data.name||"").trim();
        if(!name)return json({error:"Название коктейля обязательно"},400);
        const r=await env.DB.prepare(`INSERT INTO cocktails(name,description,category,strength,price_rub,photo_url,glass,ice,method,garnish) VALUES(?,?,?,?,0,?,?,?,?,?)`).bind(name,String(data.description||""),String(data.category||""),String(data.strength||""),String(data.photo_url||""),String(data.glass||""),String(data.ice||""),String(data.method||""),String(data.garnish||"")).run();
        const id=r.meta.last_row_id;
        await ensureIngredientSystem(env);
        for(const item of (Array.isArray(data.recipe_items)?data.recipe_items:[])){let iid=Number(item.ingredient_id);if(!Number.isInteger(iid)&&item.name)iid=await resolveIngredient(env,item.name);const q=Number(item.quantity);if(Number.isInteger(iid)&&q>0)await env.DB.prepare("INSERT OR REPLACE INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) VALUES(?,?,?)").bind(id,iid,q).run();}
        const pricing=await refreshCocktailPrice(env,id); return json({ok:true,id,pricing},201);
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return json(await getProducts(env));
      }

      if (url.pathname === "/api/products" && request.method === "POST") {
        const data=await request.json(), name=String(data.name||"").trim(), unit=String(data.unit||"");
        await ensureIngredientSystem(env);
        let id=Number(data.ingredient_id);
        if(Number.isInteger(id)&&id>0){
          const found=await env.DB.prepare("SELECT id FROM ingredients WHERE id=? AND is_active=1").bind(id).first();
          if(!found)return json({error:"Ингредиент не найден"},404);
          const existing=await env.DB.prepare("SELECT id FROM products WHERE ingredient_id=? AND brand=? AND is_active=1 LIMIT 1").bind(id,String(data.brand||"")).first();
          if(existing) id=Number(existing.id);
          else { const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id) VALUES(?,?,?,?,0,?)").bind((await env.DB.prepare("SELECT name FROM ingredients WHERE id=?").bind(id).first()).name,String(data.brand||""),String(data.category||""),unit||"ml",id).run(); id=Number(pr.meta.last_row_id); }
        } else {
          if(!name||!["ml","g","pcs"].includes(unit))return json({error:"Выберите ингредиент"},400);
          const iid=await resolveIngredient(env,name);
          const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id) VALUES(?,?,?,?,0,?)").bind(name,String(data.brand||""),String(data.category||""),unit,iid).run();
          id=Number(pr.meta.last_row_id);
        }
        if(data.brand)await env.DB.prepare("UPDATE products SET brand=? WHERE id=?").bind(String(data.brand),id).run();
        if(Number(data.purchase_qty)>0&&Number(data.purchase_price)>=0)await env.DB.prepare("INSERT INTO purchase_batches(product_id,purchased_qty,remaining_qty,price_rub) VALUES(?,?,?,?)").bind(id,Number(data.purchase_qty),Number(data.purchase_qty),Number(data.purchase_price)).run();
        return json({ok:true,id,existing:true},201);
      }

      if (url.pathname === "/api/ingredients" && request.method === "GET") {
        await ensureIngredientSystem(env);
        const {results}=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE is_active=1 ORDER BY name").all();
        return json(results);
      }
      if (url.pathname === "/api/ingredients" && request.method === "POST") {
        await ensureIngredientSystem(env);
        const data=await request.json(), name=String(data.name||"").trim(), unit=String(data.unit||"ml");
        if(!name||!["ml","g","pcs"].includes(unit)) return json({error:"Укажите название и единицу"},400);
        const r=await env.DB.prepare("INSERT INTO ingredients(name,unit) VALUES(?,?)").bind(name,unit).run();
        return json({ok:true,id:r.meta.last_row_id},201);
      }
      if (url.pathname === "/api/ingredients" && request.method === "PUT") {
        await ensureIngredientSystem(env);
        const data=await request.json(), id=Number(data.id), name=String(data.name||"").trim(), unit=String(data.unit||"ml");
        if(!id||!name||!["ml","g","pcs"].includes(unit)) return json({error:"Некорректные данные"},400);
        await env.DB.prepare("UPDATE ingredients SET name=?,unit=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(name,unit,id).run();
        return json({ok:true});
      }
      if (url.pathname === "/api/ingredients" && request.method === "DELETE") {
        await ensureIngredientSystem(env);
        const id=Number(url.searchParams.get("id"));
        const used=await env.DB.prepare("SELECT COUNT(*) n FROM recipe_ingredients WHERE ingredient_id=?").bind(id).first();
        if(Number(used?.n)>0)return json({error:"Ингредиент уже используется в рецептах"},409);
        await env.DB.prepare("UPDATE ingredients SET is_active=0 WHERE id=?").bind(id).run();
        return json({ok:true});
      }

      if (url.pathname === "/api/cocktail" && request.method === "GET") {
        const id = Number(url.searchParams.get("id"));
        if (!Number.isInteger(id)) return json({error:"Некорректный id"},400);
        const cocktail = await env.DB.prepare("SELECT * FROM cocktails WHERE id=?").bind(id).first();
        if (!cocktail) return json({error:"Коктейль не найден"},404);
        const {results} = await env.DB.prepare(
          `SELECT ri.ingredient_id,ri.quantity,i.name,i.category,i.unit
           FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id
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
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div>
<div class="grid">
<a class="card" href="/bar/recipes"><h2>🍸 Книга рецептов</h2><p class="muted">Создание коктейлей и рецептур</p></a>
<a class="card" href="/bar/ingredients"><h2>🧾 Ингредиенты</h2><p class="muted">Ваш справочник ингредиентов</p></a>
<a class="card" href="/bar/stock"><h2>📦 Склад</h2><p class="muted">Товары и остатки</p></a>
<a class="card" href="/bar/shop"><h2>🛒 Магазин</h2><p class="muted">Закупки и партии</p></a>
<a class="card" href="/bar/orders"><h2>🔔 Заказы</h2><p class="muted">Заказы гостей</p></a>
</div></div>`);

      if (url.pathname === "/bar/recipes") return page(`
<header><h1>🍸 Книга рецептов</h1><div class="sub">Рецепт здесь — источник для гостевой «Карты бара»</div></header>
<div class="wrap">
  <div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div>
  <div class="card">
    <div class="row" style="justify-content:space-between"><h2>Новый коктейль</h2></div>
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
  const [cr,pr]=await Promise.all([fetch("/api/cocktails"),fetch("/api/ingredients")]);
  const cocktails=await cr.json(); products=await pr.json();
  document.querySelector("#list").innerHTML=cocktails.length
    ? cocktails.map(c=>'<div style="padding:14px 0;border-bottom:1px solid #292929"><h3>'+esc(c.name)+'</h3><div class="muted">'+esc(c.description||"Без описания")+'</div><span class="pill">'+esc(c.category||"Без категории")+'</span><span class="pill">'+esc(c.strength||"")+'</span><span class="pill">'+Number(c.price_rub||0)+' ₽</span></div>').join("")
    : '<div class="empty">Пока коктейлей нет. Создай первый 👇</div>';
  if (!document.querySelector(".recipe-row")) addRow();
};
const addRow=()=>{
  const wrap=document.createElement("div"); wrap.className="recipe-row";
  wrap.innerHTML='<div><input class="ingredient-search" type="search" placeholder="🔎 Введите ингредиент..." autocomplete="off"><select class="prod"><option value="">Выберите ингредиент...</option></select></div><input class="qty" type="number" min="0.01" step="0.01" placeholder="Количество"><button type="button" class="secondary remove">×</button>';
  const search=wrap.querySelector(".ingredient-search"), select=wrap.querySelector(".prod");
  const fill=()=>{
    const q=search.value.trim().toLowerCase().replace(/ё/g,"е");
    const filtered=products.filter(p=>String(p.name).toLowerCase().replace(/ё/g,"е").includes(q));
    select.innerHTML='<option value="">Выберите ингредиент...</option>'+filtered.map(p=>'<option value="'+p.id+'">'+esc(p.name)+' ('+esc(p.unit)+')</option>').join("");
    if(filtered.length===1) select.value=String(filtered[0].id);
  };
  search.addEventListener("input",fill);
  select.addEventListener("change",()=>{const p=products.find(x=>String(x.id)===select.value);if(p)search.value=p.name;});
  wrap.querySelector(".remove").onclick=()=>wrap.remove();
  document.querySelector("#recipeItems").appendChild(wrap);
  fill();
};

document.querySelector("#addIngredient").onclick=addRow;
document.querySelector("#cocktailForm").onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const recipe_items=[...document.querySelectorAll(".recipe-row")].map(r=>({ingredient_id:Number(r.querySelector(".prod").value),quantity:Number(r.querySelector(".qty").value)})).filter(x=>x.ingredient_id>0&&x.quantity>0);
  const body=Object.fromEntries(f.entries()); body.recipe_items=recipe_items;
  const r=await fetch("/api/cocktails",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data=await r.json();
  document.querySelector("#msg").textContent=r.ok?"Сохранено ✅":"Ошибка: "+(data.error||"не удалось сохранить");
  if(r.ok){e.target.reset();document.querySelector("#recipeItems").innerHTML="";await load();}
};
load();
</script>`, "Книга рецептов");


      if (url.pathname === "/bar/ingredients") return page(`
<header><h1>🧾 Ингредиенты</h1><div class="sub">Системные ингредиенты для рецептов и склада</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a><a href="/bar/recipes" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🍸 Книга рецептов</a></div>
<div class="card">
<h2>Добавить ингредиент</h2>
<p class="muted">Название здесь — это стабильное имя ингредиента. Бренд, магазин и конкретная упаковка сюда не записываются.</p>
<form id="ingredientForm">
<label>Название *</label><input name="name" required placeholder="Например, Тоник апельсиновый">
<label>Единица</label><select name="unit"><option value="ml">мл</option><option value="g">г</option><option value="pcs">шт.</option></select>
<div style="margin-top:16px"><button>＋ Добавить</button></div><p id="msg" class="muted"></p>
</form>
</div><div style="height:16px"></div>
<div class="card"><h2>Справочник</h2><div id="list">Загрузка...</div></div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function load(){const r=await fetch("/api/ingredients");const x=await r.json();document.querySelector("#list").innerHTML=x.map(i=>'<div style="padding:10px 0;border-bottom:1px solid #292929"><b>#'+i.id+' · '+esc(i.name)+'</b><span class="muted"> · '+i.unit+'</span> <button type="button" class="secondary edit" data-id="'+i.id+'" data-name="'+esc(i.name)+'" data-unit="'+i.unit+'">Изменить</button></div>').join("")||'<div class="empty">Нет ингредиентов</div>';
document.querySelectorAll(".edit").forEach(b=>b.onclick=async()=>{const name=prompt("Название ингредиента",b.dataset.name);if(!name)return;const unit=prompt("Единица: ml, g или pcs",b.dataset.unit)||b.dataset.unit;const r=await fetch("/api/ingredients",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({id:Number(b.dataset.id),name,unit})});const d=await r.json();if(!r.ok)alert(d.error||"Ошибка");else load()})}
document.querySelector("#ingredientForm").onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch("/api/ingredients",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json();document.querySelector("#msg").textContent=r.ok?"Ингредиент добавлен ✅":"Ошибка: "+(d.error||"");if(r.ok){e.target.reset();load()}};load();
</script>`, "Ингредиенты");
      if (url.pathname === "/bar/stock") return page(`
<header><h1>📦 Склад</h1><div class="sub">Справочник товаров и текущие остатки</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div>
<div class="card">
<h2>Новый товар</h2>
<form id="productForm">
<label>Ингредиент *</label><select name="ingredient_id" id="ingredientSelect" required><option value="">Загрузка...</option></select>
<label>Название/описание товара в магазине</label><input name="brand" placeholder="Царская · Перекрёсток">
<label>Категория</label><input name="category" placeholder="Спиртное">
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
async function load(){const [r,ir]=await Promise.all([fetch("/api/products"),fetch("/api/ingredients")]);const x=await r.json();const ingredients=await ir.json();document.querySelector("#ingredientSelect").innerHTML='<option value="">Выберите ингредиент...</option>'+ingredients.map(p=>'<option value="'+p.id+'">'+esc(p.name)+' ('+p.unit+')</option>').join("");document.querySelector("#stock").innerHTML=x.length?x.map(p=>'<div style="padding:12px 0;border-bottom:1px solid #292929"><b>'+esc(p.name)+'</b>'+(p.brand?' <span class="muted">· '+esc(p.brand)+'</span>':"")+'<div class="muted">'+esc(p.category||"")+' · '+p.stock+' '+p.unit+'</div></div>').join(""):'<div class="empty">Товаров пока нет.</div>'}
document.querySelector("#productForm").onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const selected=body.ingredient_id;body.name="";body.ingredient_id=Number(selected);body.min_stock=Number(body.min_stock||0);body.unit=document.querySelector("#ingredientSelect").selectedOptions[0]?.textContent.match(/\((ml|g|pcs)\)$/)?.[1]||"ml";const r=await fetch("/api/products",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json();document.querySelector("#msg").textContent=r.ok?"Товар добавлен ✅":"Ошибка: "+(d.error||"");if(r.ok){e.target.reset();await load()}};
load();
</script>`, "Склад");

      if (url.pathname === "/menu") return page(`
<header><h1>🥂 Карта бара</h1><div class="sub">Гостевое меню · без рецептур</div></header>
<div class="wrap"><div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div><div id="menu" class="grid"><div class="card">Загрузка...</div></div></div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
fetch("/api/cocktails").then(r=>r.json()).then(x=>{document.querySelector("#menu").innerHTML=x.length?x.map(c=>'<div class="card">'+(c.photo_url?'<img src="'+esc(c.photo_url)+'" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;margin-bottom:12px">':"")+'<h2>'+esc(c.name)+'</h2><p class="muted">'+esc(c.description)+'</p><span class="pill">'+esc(c.strength||"")+'</span><span class="pill">'+Number(c.price_rub||0)+' ₽</span></div>').join(""):'<div class="card">Пока коктейлей нет.</div>'});
</script>`);

      if (url.pathname === "/bar/shop") return page(`
<header><h1>🛒 Магазин</h1><div class="sub">Закупки — следующий модуль</div></header>
<div class="wrap"><div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div><div class="card"><h2>Здесь будет учёт закупок</h2><p class="muted">Партии товара, цена закупки, остаток партии и журнал движений.</p><a href="/bar">← Назад</a></div></div>`);

      if (url.pathname === "/bar/orders") return page(`
<header><h1>🔔 Заказы</h1><div class="sub">Заказы гостей — следующий модуль</div></header>
<div class="wrap"><div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div><div class="card"><h2>Здесь будут заказы</h2><p class="muted">Гость → заказ → принят барменом → приготовлен → выдан.</p><a href="/bar">← Назад</a></div></div>`);

      return new Response("Не найдено",{status:404});
    } catch (error) {
      console.error(error);
      return json({error:"Ошибка сервера",details:String(error?.message||error)},500);
    }
  }
};
