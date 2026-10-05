
const resetLegacyDataOnce=async env=>{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  const done=await env.DB.prepare("SELECT name FROM app_migrations WHERE name=?").bind("reset-to-empty-2026-10-04").first();
  if(done) return;
  const wipe=async sql=>{try{await env.DB.prepare(sql).run()}catch(e){}};
  await wipe("DELETE FROM reviews");
  await wipe("DELETE FROM favorites");
  await wipe("DELETE FROM order_items");
  await wipe("DELETE FROM orders");
  await wipe("DELETE FROM stock_movements");
  await wipe("DELETE FROM purchase_batches");
  await wipe("DELETE FROM recipe_ingredients");
  await wipe("DELETE FROM recipe_items");
  await wipe("DELETE FROM products");
  await wipe("DELETE FROM cocktails");
  await wipe("DELETE FROM ingredients");
  await wipe("DELETE FROM guests");
  await wipe("DELETE FROM shifts");
  await env.DB.prepare("INSERT INTO app_migrations(name) VALUES(?)").bind("reset-to-empty-2026-10-04").run();
};

const resetAutoIncrementSequencesOnce=async env=>{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  const name="reset-autoincrement-sequences-2026-10-04";
  const done=await env.DB.prepare("SELECT name FROM app_migrations WHERE name=?").bind(name).first();
  if(done) return;
  for(const table of ["ingredients","products","cocktails","recipe_ingredients","recipe_items","purchase_batches","stock_movements","guests","orders","order_items","reviews","shifts","favorites"]){
    try{await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name=?").bind(table).run()}catch(e){}
  }
  await env.DB.prepare("INSERT INTO app_migrations(name) VALUES(?)").bind(name).run();
};

const ensureIngredientSystem=async env=>{
  // This migration must be safe against the older D1 schema. In particular,
  // SQLite/D1 does not allow ADD COLUMN with a non-constant DEFAULT.
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL DEFAULT 'ml' CHECK(unit IN ('ml','g','pcs')), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT NULL, updated_at TEXT DEFAULT NULL)").run();
  try{ await env.DB.prepare("ALTER TABLE ingredients ADD COLUMN unit TEXT NOT NULL DEFAULT 'ml'").run(); }catch(e){}
  try{ await env.DB.prepare("ALTER TABLE ingredients ADD COLUMN strength_percent REAL NOT NULL DEFAULT 0").run(); }catch(e){}
  try{ await env.DB.prepare("ALTER TABLE ingredients ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1").run(); }catch(e){}
  try{ await env.DB.prepare("ALTER TABLE ingredients ADD COLUMN created_at TEXT DEFAULT NULL").run(); }catch(e){}
  try{ await env.DB.prepare("ALTER TABLE ingredients ADD COLUMN updated_at TEXT DEFAULT NULL").run(); }catch(e){}
  try{ await env.DB.prepare("UPDATE ingredients SET created_at=COALESCE(created_at,CURRENT_TIMESTAMP), updated_at=COALESCE(updated_at,CURRENT_TIMESTAMP)").run(); }catch(e){}

  // Recipe migration is deliberately isolated: a broken/old recipe table
  // must never prevent the ingredient list from loading.
  try{
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS recipe_ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, cocktail_id INTEGER NOT NULL REFERENCES cocktails(id) ON DELETE CASCADE, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL CHECK(quantity > 0), UNIQUE(cocktail_id, ingredient_id))").run();
  }catch(e){}

  // Product links are also migrated independently from the ingredient API.
  try{ await env.DB.prepare("ALTER TABLE products ADD COLUMN ingredient_id INTEGER").run(); }catch(e){}
  try{ await env.DB.prepare("ALTER TABLE products ADD COLUMN store TEXT DEFAULT ''").run(); }catch(e){}
  try{
    const {results: ps}=await env.DB.prepare("SELECT id,name,ingredient_id FROM products").all();
    for(const p of ps){
      if(p.ingredient_id) continue;
      const ing=await env.DB.prepare("SELECT id FROM ingredients WHERE lower(replace(name,'ё','е'))=lower(replace(?,'ё','е')) LIMIT 1").bind(p.name).first();
      if(ing) await env.DB.prepare("UPDATE products SET ingredient_id=? WHERE id=?").bind(ing.id,p.id).run();
    }
  }catch(e){}

  try{
    await env.DB.prepare("INSERT OR IGNORE INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) SELECT ri.cocktail_id,p.ingredient_id,ri.quantity FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE p.ingredient_id IS NOT NULL").run();
  }catch(e){}
};

const ensureStockAdjustmentSystem=async env=>{ await ensureShopSystem(env); try{await env.DB.prepare("CREATE TABLE IF NOT EXISTS stock_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL, unit_price REAL NOT NULL DEFAULT 0, brand TEXT DEFAULT '', store TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run()}catch(e){} try{await env.DB.prepare("ALTER TABLE stock_adjustments ADD COLUMN brand TEXT DEFAULT ''").run()}catch(e){} try{await env.DB.prepare("ALTER TABLE stock_adjustments ADD COLUMN store TEXT DEFAULT ''").run()}catch(e){}
  try{await env.DB.prepare("DELETE FROM stock_adjustments WHERE brand='Ручная корректировка'").run()}catch(e){} };

const ensureShopSystem=async env=>{
  await ensureIngredientSystem(env);
  // Kept as a separate guarded migration for old installations.
  try{await env.DB.prepare("ALTER TABLE products ADD COLUMN store TEXT DEFAULT ''").run()}catch(e){}
};

const ensureBarOrderSystem=async env=>{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bar_shifts (id INTEGER PRIMARY KEY AUTOINCREMENT,status TEXT NOT NULL DEFAULT 'open',started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,closed_at TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bar_orders (id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL REFERENCES bar_shifts(id),status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,accepted_at TEXT,price_total REAL NOT NULL DEFAULT 0)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bar_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES bar_orders(id) ON DELETE CASCADE,cocktail_id INTEGER NOT NULL REFERENCES cocktails(id),quantity INTEGER NOT NULL CHECK(quantity>0),price_rub REAL NOT NULL DEFAULT 0,UNIQUE(order_id,cocktail_id))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bar_stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES bar_orders(id),ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),quantity REAL NOT NULL,unit TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
};
const getOpenBarShift=async env=>{await ensureBarOrderSystem(env);return await env.DB.prepare("SELECT id,status,started_at,closed_at FROM bar_shifts WHERE status='open' ORDER BY id DESC LIMIT 1").first();};
const ensureOpenBarShift=async env=>{await ensureBarOrderSystem(env);let shift=await getOpenBarShift(env);if(shift)return shift;const r=await env.DB.prepare("INSERT INTO bar_shifts(status) VALUES('open')").run();return await env.DB.prepare("SELECT id,status,started_at,closed_at FROM bar_shifts WHERE id=?").bind(Number(r.meta.last_row_id)).first();};
const getReservedIngredients=async env=>{await ensureBarOrderSystem(env);const {results}=await env.DB.prepare("SELECT ri.ingredient_id,COALESCE(SUM(ri.quantity*oi.quantity),0) reserved FROM bar_orders o JOIN bar_order_items oi ON oi.order_id=o.id JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id WHERE o.status='draft' GROUP BY ri.ingredient_id").all();return new Map((results||[]).map(x=>[Number(x.ingredient_id),Number(x.reserved||0)]));};
const getDraftBarOrder=async(env,create=false)=>{
  await ensureBarOrderSystem(env);let shift=await getOpenBarShift(env);if(!shift&&create)shift=await ensureOpenBarShift(env);if(!shift)return {shift:null,order:null,items:[]};
  let order=await env.DB.prepare("SELECT id,shift_id,status,created_at,accepted_at,price_total FROM bar_orders WHERE shift_id=? AND status='draft' ORDER BY id DESC LIMIT 1").bind(shift.id).first();
  if(!order&&create){const r=await env.DB.prepare("INSERT INTO bar_orders(shift_id,status) VALUES(?,'draft')").bind(shift.id).run();order=await env.DB.prepare("SELECT id,shift_id,status,created_at,accepted_at,price_total FROM bar_orders WHERE id=?").bind(Number(r.meta.last_row_id)).first();}
  if(!order)return {shift,order:null,items:[]};
  const {results}=await env.DB.prepare("SELECT oi.id,oi.cocktail_id,oi.quantity,oi.price_rub,c.name cocktail_name FROM bar_order_items oi JOIN cocktails c ON c.id=oi.cocktail_id WHERE oi.order_id=? ORDER BY oi.id").bind(order.id).all();
  const items=results||[];return {shift,order,items,total_cocktails:items.reduce((n,x)=>n+Number(x.quantity||0),0),total_price:items.reduce((n,x)=>n+Number(x.quantity||0)*Number(x.price_rub||0),0)};
};
const consumeIngredientForBarOrder=async(env,orderId,ingredientId,quantity)=>{
  let left=Number(quantity||0);
  const {results}=await env.DB.prepare("SELECT pb.id,pb.remaining_qty FROM purchase_batches pb JOIN products p ON p.id=pb.product_id WHERE p.ingredient_id=? AND p.is_active=1 AND pb.remaining_qty>0 ORDER BY pb.purchased_at ASC,pb.id ASC").bind(ingredientId).all();
  for(const batch of (results||[])){if(left<=0)break;const take=Math.min(left,Number(batch.remaining_qty||0));if(take>0){await env.DB.prepare("UPDATE purchase_batches SET remaining_qty=remaining_qty-? WHERE id=?").bind(take,batch.id).run();left-=take;}}
  if(left>0){await ensureStockAdjustmentSystem(env);await env.DB.prepare("INSERT INTO stock_adjustments(ingredient_id,quantity,unit_price,brand,store) VALUES(?,?,?,?,?)").bind(ingredientId,-left,0,"Заказ #"+orderId,"Списание").run();}
  const ing=await env.DB.prepare("SELECT unit FROM ingredients WHERE id=?").bind(ingredientId).first();await env.DB.prepare("INSERT INTO bar_stock_movements(order_id,ingredient_id,quantity,unit) VALUES(?,?,?,?)").bind(orderId,ingredientId,quantity,ing?.unit||"ml").run();
};
const formatUnitLabelServer=u=>u==="g"?"гр":u==="ml"?"мл":u==="pcs"?"шт.":String(u||"");


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
.cocktail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:18px;margin-top:4px}
.cocktail-card{overflow:hidden;padding:0;display:flex;flex-direction:column;background:linear-gradient(180deg,#151515 0%,#101010 100%);border-color:#303030;box-shadow:0 12px 30px rgba(0,0,0,.22)}
.cocktail-photo-wrap{position:relative;overflow:hidden;background:#181818}
.cocktail-photo-wrap:after{content:"";position:absolute;inset:45% 0 0;background:linear-gradient(180deg,transparent,rgba(0,0,0,.45));pointer-events:none}
.cocktail-photo{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#181818;transition:transform .25s ease}
.cocktail-card:hover .cocktail-photo{transform:scale(1.015)}
.cocktail-photo-placeholder{width:100%;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#171717,#242424);color:#777;font-size:44px}
.cocktail-actions{display:flex;gap:7px}
.cocktail-actions button{width:42px;height:42px;padding:0;border-radius:12px;font-size:18px}
.cocktail-actions .secondary{background:#242424}
.cocktail-card-body{padding:16px 17px 17px}
.cocktail-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.cocktail-card-head .row{flex-shrink:0}
.cocktail-title-row{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap}
.cocktail-card h3{margin:0;font-size:23px;line-height:1.08;letter-spacing:-.3px}
.cocktail-description{margin-top:7px;line-height:1.35}
.cocktail-meta{display:flex;gap:7px;flex-wrap:wrap;margin:11px 0 0}
.cocktail-meta .pill{margin:0;padding:6px 10px;background:#252525;color:#ddd}
.cocktail-meta .strength-pill{background:#c8ff3d;color:#0a0a0a;font-weight:850}
.cocktail-price{font-size:21px;font-weight:850;margin-top:12px}
.cocktail-section{margin-top:14px;padding-top:13px;border-top:1px solid #292929}
.cocktail-section-title{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8f8f8f;font-weight:800;margin-bottom:8px}
.recipe-list{display:flex;flex-direction:column;gap:7px}
.recipe-line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;line-height:1.25}
.recipe-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.recipe-qty{white-space:nowrap;color:#f1f1f1;font-weight:750}
.recipe-stock{display:block;color:#777;font-size:12px;font-weight:500;margin-top:2px}
.cocktail-info-grid{display:grid;grid-template-columns:1fr;gap:8px;margin-top:13px}
.cocktail-info{padding:9px 11px;border-radius:11px;background:#191919;color:#bdbdbd;line-height:1.35}
.cocktail-info b{color:#e5e5e5}
.order-controls{margin-top:15px!important;padding-top:13px;border-top:1px solid #292929}
.order-controls button{min-width:52px;height:48px;font-size:22px;padding:8px 14px}
.order-controls button:not(.secondary){box-shadow:0 5px 18px rgba(200,255,61,.15);font-size:24px}
.order-controls span{min-width:48px;text-align:center;font-size:20px;font-weight:900}
label{display:block;color:#aaa;font-size:13px;margin:12px 0 6px}
input,textarea,select{width:100%;padding:12px;border:1px solid #333;border-radius:12px;background:#181818;color:#fff;font:inherit}
textarea{min-height:80px;resize:vertical}
button{border:0;border-radius:12px;padding:12px 16px;background:#c8ff3d;color:#000;font-weight:800;cursor:pointer}
button.secondary{background:#252525;color:#fff}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
a{color:#c8ff3d;text-decoration:none}.muted{color:#999}.pill{display:inline-block;padding:5px 9px;border-radius:99px;background:#202020;color:#bbb;margin:3px 3px 0 0}
.recipe-row{display:grid;grid-template-columns:1fr 100px 58px;gap:8px;align-items:end;margin-bottom:10px}
.recipe-row button{padding:10px}.empty{padding:24px;text-align:center;color:#888}
.recipe-form-panel{margin-bottom:16px}
.form-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
@media(max-width:600px){
  .wrap{padding:12px}
  header{padding:14px 12px}
  h1{font-size:20px}
  .card{padding:14px;border-radius:15px}
  .cocktail-grid{grid-template-columns:1fr}
  .recipe-row{grid-template-columns:minmax(0,1fr) 82px 48px}
  .recipe-row input{min-width:0}
  .form-actions button{flex:1}
}
.ingredient-picker{position:relative}
.ingredient-suggestions{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:10;background:#181818;border:1px solid #333;border-radius:12px;max-height:220px;overflow:auto;box-shadow:0 10px 30px #000}
.ingredient-suggestion{padding:12px;border-bottom:1px solid #292929;cursor:pointer}
.ingredient-suggestion:last-child{border-bottom:0}
.ingredient-suggestion:hover{background:#252525}
.ingredient-suggestion .muted{font-size:12px}
@media(max-width:600px){.recipe-row{grid-template-columns:1fr 90px 58px}}
</style>
</head><body>${body}</body></html>`, {headers:{"content-type":"text/html;charset=UTF-8","cache-control":"no-store"}});

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

const BUILD_VERSION = "2026-10-05-russian-ui-inventory-strength-v2";

const calculateCocktailStrength = (recipeItems) => {
  let alcoholMl = 0;
  let liquidMl = 0;
  let iceG = 0;
  for (const item of (Array.isArray(recipeItems) ? recipeItems : [])) {
    const q = Number(item.quantity);
    const unit = String(item.unit || "");
    const name = String(item.ingredient_name || item.name || "").toLowerCase().replace(/ё/g,"е");
    const pct = Number(item.strength_percent);
    if (!(q > 0)) continue;
    if (unit === "ml") {
      liquidMl += q;
      if (Number.isFinite(pct) && pct > 0) alcoholMl += q * Math.min(100, Math.max(0, pct)) / 100;
    } else if (unit === "g" && (name.includes("лед") || name.includes("ice"))) {
      iceG += q;
    }
  }
  const dilutionMl = iceG * 0.15;
  const totalMl = liquidMl + dilutionMl;
  const abv = totalMl > 0 ? alcoholMl / totalMl * 100 : 0;
  const strength = abv <= 0 ? "Безалкогольный" : abv <= 10 ? "Лёгкий" : abv <= 20 ? "Средний" : "Крепкий";
  return {abv, strength, liquidMl, dilutionMl};
};

const refreshCocktailStrength = async (env, cocktailId) => {
  await ensureIngredientSystem(env);
  const {results} = await env.DB.prepare(
    "SELECT ri.quantity,i.unit,i.strength_percent FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.cocktail_id=?"
  ).bind(cocktailId).all();
  const calculated = calculateCocktailStrength(results);
  await env.DB.prepare("UPDATE cocktails SET strength=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(calculated.strength,cocktailId).run();
  return calculated;
};

const getCocktails = async (env) => {
  const { results } = await env.DB.prepare(
    "SELECT id,name,description,category,strength,price_rub,photo_url,glass,ice,method,garnish,is_active,created_at,updated_at FROM cocktails WHERE is_active=1 ORDER BY name"
  ).all();
  for(const c of results){
    // Normalize legacy photo URLs and keep the database independent from the public route.
    if(c.photo_url){
      try{
        const u=new URL(c.photo_url,"https://bar-menu.invalid");
        const key=u.searchParams.get("key") || (u.pathname.startsWith("/api/cocktail-photo/") ? decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length)) : "");
        if(key && key.startsWith("cocktails/")) c.photo_url="/api/cocktail-photo?key="+encodeURIComponent(key);
      }catch(e){}
    }
    const r=await env.DB.prepare(
      "SELECT ri.ingredient_id,ri.quantity,i.name ingredient_name,i.unit,i.strength_percent FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.cocktail_id=? ORDER BY ri.id"
    ).bind(c.id).all();
    c.recipe_items=r.results||[];
    const stockRows=await getProducts(env),stockMap=new Map((stockRows||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)]));
    c.recipe_items=c.recipe_items.map(i=>({...i,stock_available:Number(stockMap.get(Number(i.ingredient_id))||0)}));
    const calculated=calculateCocktailStrength(c.recipe_items);
    c.strength=calculated.strength;
    c.strength_abv=Number(calculated.abv.toFixed(2));
  }
  return results;
};

const getProducts = async (env) => {
  // Склад не должен зависеть от миграций магазина. Сначала гарантируем
  // базовый справочник ингредиентов, затем отдельно пытаемся включить
  // ручные корректировки остатков.
  await ensureIngredientSystem(env);
  let adjustmentsAvailable=true;
  try{
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS stock_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL, unit_price REAL NOT NULL DEFAULT 0, brand TEXT DEFAULT '', store TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    try{await env.DB.prepare("ALTER TABLE stock_adjustments ADD COLUMN brand TEXT DEFAULT ''").run()}catch(e){}
    try{await env.DB.prepare("ALTER TABLE stock_adjustments ADD COLUMN store TEXT DEFAULT ''").run()}catch(e){}
    // Удаляем старые записи, которые были созданы прежней логикой общего остатка.
    try{await env.DB.prepare("DELETE FROM stock_adjustments WHERE brand='Ручная корректировка' OR (COALESCE(brand,'')='' AND COALESCE(store,'')='')").run()}catch(e){}
  }catch(e){
    adjustmentsAvailable=false;
  }

  const adjustmentStock=adjustmentsAvailable
    ? "COALESCE((SELECT SUM(sa.quantity) FROM stock_adjustments sa WHERE sa.ingredient_id=i.id),0)"
    : "0";
  const adjustmentValue=adjustmentsAvailable
    ? "COALESCE((SELECT SUM(sa.quantity*sa.unit_price) FROM stock_adjustments sa WHERE sa.ingredient_id=i.id),0)"
    : "0";

  const q=`SELECT i.id ingredient_id,i.name ingredient_name,i.unit,
    COALESCE((SELECT SUM(pb.remaining_qty) FROM purchase_batches pb JOIN products pp ON pp.id=pb.product_id WHERE pp.ingredient_id=i.id AND pp.is_active=1),0)+${adjustmentStock} stock,
    COALESCE((SELECT SUM(pb.remaining_qty*(pb.price_rub/NULLIF(pb.purchased_qty,0))) FROM purchase_batches pb JOIN products pp ON pp.id=pb.product_id WHERE pp.ingredient_id=i.id AND pp.is_active=1),0)+${adjustmentValue} stock_value
    FROM ingredients i WHERE i.is_active=1 ORDER BY i.name`;
  const {results}=await env.DB.prepare(q).all();
  const reservedMap=await getReservedIngredients(env);

  for(const x of results){
    const batches=await env.DB.prepare(`
      SELECT COALESCE(NULLIF(p.brand,''),'Без бренда') brand,
             COALESCE(NULLIF(p.store,''),'') store,
             SUM(pb.remaining_qty) stock,
             SUM(pb.remaining_qty*(pb.price_rub/NULLIF(pb.purchased_qty,0))) stock_value
      FROM purchase_batches pb
      JOIN products p ON p.id=pb.product_id
      WHERE p.ingredient_id=? AND p.is_active=1 AND pb.remaining_qty>0
      GROUP BY p.brand,p.store
      HAVING SUM(pb.remaining_qty)>0
      ORDER BY p.brand,p.store
    `).bind(x.ingredient_id).all();

    x.details=(batches.results||[]).map(b=>({
      brand:b.brand,store:b.store,stock:Number(b.stock||0),
      stock_value:Number(b.stock_value||0),
      unit_price:Number(b.stock||0)>0?Number(b.stock_value||0)/Number(b.stock):0,
      source_type:"purchase"
    }));

    if(adjustmentsAvailable){
      try{
        const adjustments=await env.DB.prepare("SELECT COALESCE(NULLIF(brand,''),'Ручная корректировка') brand, COALESCE(NULLIF(store,''),'Ручной ввод') store, SUM(quantity) stock, SUM(quantity*unit_price) stock_value FROM stock_adjustments WHERE ingredient_id=? AND quantity>0 GROUP BY brand,store ORDER BY brand,store").bind(x.ingredient_id).all();
        for(const adjustment of (adjustments.results||[])){
          const stock=Number(adjustment.stock||0), value=Number(adjustment.stock_value||0);
          if(stock>0){
            x.details.push({brand:adjustment.brand,store:adjustment.store,stock,stock_value:value,unit_price:value/stock,source_type:"manual"});
          }
        }
      }catch(e){}
    }
  }

  for(const x of results){
    const reserved=Number(reservedMap.get(Number(x.ingredient_id))||0),baseStock=Number(x.stock||0),baseValue=Number(x.stock_value||0),baseUnitPrice=baseStock>0?baseValue/baseStock:0;
    x.reserved=reserved;x.stock=Math.max(0,baseStock-reserved);x.stock_value=Math.max(0,baseValue-reserved*baseUnitPrice);
  }
  return results.map(x=>({...x,stock:Number(x.stock||0),reserved:Number(x.reserved||0),stock_value:Number(x.stock_value||0),unit_price:Number(x.stock||0)>0?Number(x.stock_value||0)/Number(x.stock):0})).filter(x=>x.stock>0);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") return json({ok:true,service:"bar-menu",database:"bar-menu-db",photos:!!env.PHOTOS,build:BUILD_VERSION});

      // Temporary R2 diagnostics: shows whether uploaded cocktail objects actually exist
      // and what metadata Cloudflare stored for them.
      if (url.pathname === "/api/photo-debug" && request.method === "GET") {
        if(!env.PHOTOS) return json({ok:false,error:"R2 binding missing",build:BUILD_VERSION},503);
        const listed=await env.PHOTOS.list({prefix:"cocktails/",limit:100});
        const objects=(listed.objects||[]).map(o=>({key:o.key,size:o.size,uploaded:o.uploaded,httpMetadata:o.httpMetadata||null,etag:o.etag||null}));
        const cocktails=await env.DB.prepare("SELECT id,name,photo_url FROM cocktails WHERE photo_url IS NOT NULL AND photo_url != '' ORDER BY id DESC LIMIT 100").all();
        return json({ok:true,build:BUILD_VERSION,bucket_objects:objects,cocktails_with_photos:cocktails.results||[]});
      }

      if (url.pathname === "/api/cocktail-photo" && request.method === "POST") {
        if(!env.PHOTOS)return json({error:"Хранилище фотографий R2 ещё не подключено"},503);
        const form=await request.formData();
        const file=form.get("file");
        if(!(file instanceof File))return json({error:"Файл не выбран"},400);
        if(!String(file.type||"").startsWith("image/"))return json({error:"Можно загружать только изображения"},400);
        if(file.size>8*1024*1024)return json({error:"Фото слишком большое. Максимум 8 МБ"},400);
        const ext=(String(file.name||"").split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"");
        const key="cocktails/"+crypto.randomUUID()+"."+((ext==="jpeg")?"jpg":ext||"jpg");
        await env.PHOTOS.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type||"image/jpeg",cacheControl:"no-store"}});
        return json({ok:true,key,photo_key:key,url:"/api/cocktail-photo?key="+encodeURIComponent(key)});
      }

      if ((url.pathname.startsWith("/api/cocktail-photo/") || url.pathname === "/api/cocktail-photo") && request.method === "GET") {
        if(!env.PHOTOS)return new Response("R2 не подключено",{status:503});
        let key=url.searchParams.get("key")||"";
        if(!key && url.pathname.startsWith("/api/cocktail-photo/")){
          try{key=decodeURIComponent(url.pathname.slice("/api/cocktail-photo/".length));}catch(e){}
        }
        if(!key.startsWith("cocktails/") || key.includes(".."))return new Response("Not found",{status:404});
        const object=await env.PHOTOS.get(key);
        if(!object)return new Response("Photo not found: "+key,{status:404,headers:{"cache-control":"no-store","x-photo-key":key,"x-build-version":BUILD_VERSION}});
        const headers=new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag",object.httpEtag);
        headers.set("cache-control","no-store");
        if(!headers.get("content-type")){const ext=key.split(".").pop().toLowerCase();const ct={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif"}[ext];if(ct)headers.set("content-type",ct);}
        headers.set("x-content-type-options","nosniff");
        return new Response(object.body,{headers});
      }

      if (url.pathname === "/api/cocktails" && request.method === "GET") {
        return json(await getCocktails(env));
      }

      if (url.pathname === "/api/cocktails" && request.method === "PUT") {
        const data=await request.json();
        const id=Number(data.id);
        const name=String(data.name||"").trim();
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректный коктейль"},400);
        if(!name)return json({error:"Название коктейля обязательно"},400);
        const existing=await env.DB.prepare("SELECT id FROM cocktails WHERE id=?").bind(id).first();
        if(!existing)return json({error:"Коктейль не найден"},404);
        await env.DB.prepare("UPDATE cocktails SET name=?,description=?,category=?,strength=?,photo_url=?,glass=?,ice=?,method=?,garnish=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(name,String(data.description||""),"","",String(data.photo_url||""),String(data.inventory??data.glass??""),"",String(data.method||""),"",id).run();
        await ensureIngredientSystem(env);
        await env.DB.prepare("DELETE FROM recipe_ingredients WHERE cocktail_id=?").bind(id).run();
        for(const item of (Array.isArray(data.recipe_items)?data.recipe_items:[])){
          const iid=Number(item.ingredient_id), q=Number(item.quantity);
          if(Number.isInteger(iid)&&iid>0&&q>0)await env.DB.prepare("INSERT INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) VALUES(?,?,?)").bind(id,iid,q).run();
        }
        const pricing=await refreshCocktailPrice(env,id);
        const strength=await refreshCocktailStrength(env,id);
        return json({ok:true,id,pricing,strength});
      }

      if (url.pathname === "/api/cocktails" && request.method === "DELETE") {
        const data=await request.json();
        const id=Number(data.id);
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректный коктейль"},400);

        const cocktail=await env.DB.prepare("SELECT id,name,photo_url FROM cocktails WHERE id=?").bind(id).first();
        if(!cocktail)return json({error:"Коктейль не найден"},404);

        // Remove the R2 object first so deleting a cocktail cannot leave its photo behind.
        let photoDeleted=true;
        let photoKey="";
        if(cocktail.photo_url && env.PHOTOS){
          try{
            const u=new URL(cocktail.photo_url,"https://bar-menu.invalid");
            photoKey=u.searchParams.get("key") || (u.pathname.startsWith("/api/cocktail-photo/") ? decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length)) : "");
            if(photoKey && photoKey.startsWith("cocktails/")) await env.PHOTOS.delete(photoKey);
          }catch(e){
            photoDeleted=false;
          }
        }

        try{
          await env.DB.prepare("DELETE FROM recipe_ingredients WHERE cocktail_id=?").bind(id).run();
          try{await env.DB.prepare("DELETE FROM recipe_items WHERE cocktail_id=?").bind(id).run();}catch(e){}
          await env.DB.prepare("DELETE FROM cocktails WHERE id=?").bind(id).run();
        }catch(e){
          return json({error:"Не удалось удалить коктейль",details:String(e&&e.message||e)},500);
        }

        return json({ok:true,id,name:cocktail.name,photo_deleted:photoDeleted,photo_key:photoKey||null});
      }

      if (url.pathname === "/api/cocktails" && request.method === "POST") {
        const data=await request.json(), name=String(data.name||"").trim();
        if(!name)return json({error:"Название коктейля обязательно"},400);
        const r=await env.DB.prepare(`INSERT INTO cocktails(name,description,category,strength,price_rub,photo_url,glass,ice,method,garnish) VALUES(?,?,?,?,0,?,?,?,?,?)`).bind(name,String(data.description||""),String(data.category||""),"",String(data.photo_url||""),String(data.inventory??data.glass??""),"",String(data.method||""),String(data.garnish||"")).run();
        const id=r.meta.last_row_id;
        await ensureIngredientSystem(env);
        for(const item of (Array.isArray(data.recipe_items)?data.recipe_items:[])){let iid=Number(item.ingredient_id);if(!Number.isInteger(iid)&&item.name)iid=await resolveIngredient(env,item.name);const q=Number(item.quantity);if(Number.isInteger(iid)&&q>0)await env.DB.prepare("INSERT OR REPLACE INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) VALUES(?,?,?)").bind(id,iid,q).run();}
        const pricing=await refreshCocktailPrice(env,id);
        const strength=await refreshCocktailStrength(env,id);
        return json({ok:true,id,pricing,strength},201);
      }


      if (url.pathname === "/api/bar/shift" && request.method === "GET") return json({shift:await getOpenBarShift(env)});
      if (url.pathname === "/api/bar/shift" && request.method === "POST") return json({shift:await ensureOpenBarShift(env)});
      if (url.pathname === "/api/bar/shift" && request.method === "PUT") {
        const shift=await getOpenBarShift(env);if(!shift)return json({error:"Открытой смены нет"},400);
        const draft=await getDraftBarOrder(env,false);if((draft.items||[]).length)return json({error:"Сначала примите или отмените текущий заказ."},409);
        await env.DB.prepare("UPDATE bar_shifts SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").bind(shift.id).run();return json({ok:true,shift_id:shift.id});
      }
      if (url.pathname === "/api/bar/order" && request.method === "GET") return json(await getDraftBarOrder(env,false));
      if (url.pathname === "/api/bar/order" && request.method === "POST") {
        const data=await request.json(),cocktailId=Number(data.cocktail_id),delta=Number(data.delta);
        if(!Number.isInteger(cocktailId)||cocktailId<1||!Number.isInteger(delta)||!delta||Math.abs(delta)>1)return json({error:"Некорректное изменение количества"},400);
        const cocktail=await env.DB.prepare("SELECT id,name,price_rub FROM cocktails WHERE id=? AND is_active=1").bind(cocktailId).first();if(!cocktail)return json({error:"Коктейль не найден"},404);
        const draft=await getDraftBarOrder(env,true),item=await env.DB.prepare("SELECT id,quantity FROM bar_order_items WHERE order_id=? AND cocktail_id=?").bind(draft.order.id,cocktailId).first(),next=Number(item?.quantity||0)+delta;if(next<0)return json({error:"Количество не может быть отрицательным"},400);
        if(delta>0){
          const recipe=await env.DB.prepare("SELECT ri.ingredient_id,ri.quantity,i.name,i.unit FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.cocktail_id=?").bind(cocktailId).all();
          const stockRows=await getProducts(env),stockMap=new Map((stockRows||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)]));
          const shortages=(recipe.results||[]).filter(r=>Number(stockMap.get(Number(r.ingredient_id))||0)+0.000001<Number(r.quantity||0));
          if(shortages.length)return json({error:"Не хватает: "+shortages.map(x=>x.name+" — "+Number(x.quantity).toLocaleString("ru-RU")+" "+formatUnitLabelServer(x.unit)).join(", ")},409);
        }
        if(next===0){if(item)await env.DB.prepare("DELETE FROM bar_order_items WHERE id=?").bind(item.id).run();}
        else if(item)await env.DB.prepare("UPDATE bar_order_items SET quantity=? WHERE id=?").bind(next,item.id).run();
        else await env.DB.prepare("INSERT INTO bar_order_items(order_id,cocktail_id,quantity,price_rub) VALUES(?,?,?,?)").bind(draft.order.id,cocktailId,next,Number(cocktail.price_rub||0)).run();
        return json(await getDraftBarOrder(env,false));
      }
      if (url.pathname === "/api/bar/order" && request.method === "DELETE") {const draft=await getDraftBarOrder(env,false);if(draft.order)await env.DB.prepare("DELETE FROM bar_order_items WHERE order_id=?").bind(draft.order.id).run();return json({ok:true});}
      if (url.pathname === "/api/bar/order/accept" && request.method === "POST") {
        const draft=await getDraftBarOrder(env,false);if(!draft.order||!(draft.items||[]).length)return json({error:"В заказе пока ничего нет"},400);
        const required=new Map();
        for(const oi of draft.items){const r=await env.DB.prepare("SELECT ingredient_id,quantity FROM recipe_ingredients WHERE cocktail_id=?").bind(oi.cocktail_id).all();for(const row of (r.results||[])){const id=Number(row.ingredient_id);required.set(id,Number(required.get(id)||0)+Number(row.quantity||0)*Number(oi.quantity||0));}}
        const effective=await getProducts(env),effectiveMap=new Map((effective||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)])),shortages=[];
        for(const [id,qty] of required){const available=Number(effectiveMap.get(id)||0)+Number(qty||0);if(available+0.000001<qty){const ing=await env.DB.prepare("SELECT name,unit FROM ingredients WHERE id=?").bind(id).first();shortages.push((ing?.name||("Ингредиент #"+id))+" — "+Number(available).toLocaleString("ru-RU")+" "+formatUnitLabelServer(ing?.unit));}}
        if(shortages.length)return json({error:"Недостаточно ингредиентов для принятия заказа: "+shortages.join(", ")},409);
        for(const [id,qty] of required)await consumeIngredientForBarOrder(env,draft.order.id,id,qty);
        const totalPrice=Number(draft.total_price||0);await env.DB.prepare("UPDATE bar_orders SET status='accepted',accepted_at=CURRENT_TIMESTAMP,price_total=? WHERE id=?").bind(totalPrice,draft.order.id).run();
        return json({ok:true,order_id:draft.order.id,total_cocktails:draft.total_cocktails,total_price:totalPrice});
      }
      if (url.pathname === "/api/bar/statistics" && request.method === "GET") {
        const {results}=await env.DB.prepare("SELECT s.id,s.status,s.started_at,s.closed_at,COUNT(DISTINCT CASE WHEN o.status='accepted' THEN o.id END) orders_count,COALESCE(SUM(CASE WHEN o.status='accepted' THEN oi.quantity ELSE 0 END),0) cocktails_count,COALESCE(SUM(CASE WHEN o.status='accepted' THEN oi.quantity*oi.price_rub ELSE 0 END),0) revenue_rub FROM bar_shifts s LEFT JOIN bar_orders o ON o.shift_id=s.id LEFT JOIN bar_order_items oi ON oi.order_id=o.id GROUP BY s.id ORDER BY s.id DESC LIMIT 100").all();return json({shifts:results||[]});
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return json(await getProducts(env));
      }

      if (url.pathname === "/api/products" && request.method === "PUT") {
        await ensureStockAdjustmentSystem(env);
        const data=await request.json();
        if(data.source_edit){
          const ingredientId=Number(data.ingredient_id);
          const oldBrand=String(data.old_brand||"").trim();
          const oldStore=String(data.old_store||"").trim();
          const brand=String(data.brand||"").trim();
          const quantity=Number(data.quantity), unitPrice=Number(data.unit_price);
          if(!Number.isInteger(ingredientId)||ingredientId<1||!oldBrand||!brand||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0)return json({error:"Некорректные данные товара"},400);
          await env.DB.prepare("DELETE FROM stock_adjustments WHERE ingredient_id=? AND brand=? AND COALESCE(store,'')=?").bind(ingredientId,oldBrand,oldStore).run();
          await env.DB.prepare("INSERT INTO stock_adjustments(ingredient_id,quantity,unit_price,brand,store) VALUES(?,?,?,?,?)").bind(ingredientId,quantity,unitPrice,brand,"Ручной ввод").run();
          return json({ok:true});
        }

        const ingredientId=Number(data.ingredient_id), target=Number(data.stock);
        if(!Number.isInteger(ingredientId)||ingredientId<1||!Number.isFinite(target)||target<0)return json({error:"Некорректный остаток"},400);
        const items=await getProducts(env); const item=items.find(x=>Number(x.ingredient_id)===ingredientId);
        if(!item)return json({error:"Ингредиент не найден на складе"},404);
        const delta=target-Number(item.stock); if(Math.abs(delta)<0.000001)return json({ok:true});
        await env.DB.prepare("INSERT INTO stock_adjustments(ingredient_id,quantity,unit_price,brand,store) VALUES(?,?,?,?,?)").bind(ingredientId,delta,Number(item.unit_price||0),"Ручная корректировка","Ручной ввод").run();
        return json({ok:true,stock:target});
      }

      if (url.pathname === "/api/products" && request.method === "DELETE") {
        await ensureStockAdjustmentSystem(env);
        const data=await request.json();
        const ingredientId=Number(data.ingredient_id);
        const brand=String(data.brand||"").trim();
        const store=String(data.store||"").trim();
        if(!Number.isInteger(ingredientId)||ingredientId<1||!brand)return json({error:"Не указан товар"},400);
        if(store==="Ручной ввод" || brand==="Ручная корректировка"){
          const r=await env.DB.prepare("DELETE FROM stock_adjustments WHERE ingredient_id=? AND (brand=? OR brand='Ручная корректировка')").bind(ingredientId,brand).run();
          return json({ok:true,deleted:Number(r.meta.changes||0)});
        }
        const r=await env.DB.prepare("UPDATE purchase_batches SET remaining_qty=0 WHERE product_id IN (SELECT p.id FROM products p WHERE p.ingredient_id=? AND p.brand=? AND p.store=? AND p.is_active=1) AND remaining_qty>0").bind(ingredientId,brand,store).run();
        return json({ok:true,deleted:Number(r.meta.changes||0)});
      }

      if (url.pathname === "/api/products" && request.method === "POST") {
        await ensureIngredientSystem(env);
        const data=await request.json();
        const ingredientId=Number(data.ingredient_id);
        const brand=String(data.brand||"").trim();
        const quantity=Number(data.quantity||0);
        const takeAverage=Boolean(data.take_average);
        let bottlePrice=Number(data.price);

        if(!Number.isInteger(ingredientId)||ingredientId<1)return json({error:"Выберите ингредиент"},400);
        if(!Number.isFinite(quantity)||quantity<0)return json({error:"Некорректное количество"},400);

        const found=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE id=? AND is_active=1").bind(ingredientId).first();
        if(!found)return json({error:"Ингредиент не найден"},404);

        if(takeAverage){
          const items=await getProducts(env);
          const item=items.find(x=>Number(x.ingredient_id)===ingredientId);
          if(!item||Number(item.stock)<=0)return json({error:"Для этого ингредиента пока нет средней цены. Укажите цену вручную."},400);
          bottlePrice=Number(item.unit_price||0)*quantity;
        }
        if(quantity>0&&(!Number.isFinite(bottlePrice)||bottlePrice<0))return json({error:"Укажите цену за бутылку или выберите «Взять среднюю»"},400);
        const unitPrice=quantity>0?bottlePrice/quantity:0;

        let product=await env.DB.prepare("SELECT id FROM products WHERE ingredient_id=? AND brand=? AND is_active=1 LIMIT 1").bind(ingredientId,brand).first();
        let productId;
        if(product){
          productId=Number(product.id);
        }else{
          const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id) VALUES(?,?,?,?,0,?)")
            .bind(found.name,brand,"",found.unit,ingredientId).run();
          productId=Number(pr.meta.last_row_id);
        }

        if(quantity>0){
          await ensureStockAdjustmentSystem(env);
          await env.DB.prepare("INSERT INTO stock_adjustments(ingredient_id,quantity,unit_price,brand,store) VALUES(?,?,?,?,?)")
            .bind(ingredientId,quantity,unitPrice,brand,"Ручной ввод").run();
        }

        return json({ok:true,id:productId,unit_price:unitPrice,price_rub:bottlePrice},201);
      }

      if (url.pathname === "/api/shop/purchases" && request.method === "GET") {
        await ensureShopSystem(env);
        const from=url.searchParams.get("date_from")||"";
        const to=url.searchParams.get("date_to")||"";
        const ingredientId=Number(url.searchParams.get("ingredient_id")||0);
        let sql=`SELECT pb.id,pb.purchased_qty,pb.remaining_qty,pb.price_rub,substr(pb.purchased_at,1,10) purchased_at,
                  p.ingredient_id,COALESCE(i.name,p.name) ingredient_name,COALESCE(i.unit,p.unit) unit,p.brand,p.store
           FROM purchase_batches pb JOIN products p ON p.id=pb.product_id
           LEFT JOIN ingredients i ON i.id=p.ingredient_id WHERE 1=1`;
        const binds=[];
        if(/^\d{4}-\d{2}-\d{2}$/.test(from)){sql+=" AND pb.purchased_at >= ?";binds.push(from+" 00:00:00")}
        if(/^\d{4}-\d{2}-\d{2}$/.test(to)){sql+=" AND pb.purchased_at < datetime(?, '+1 day')";binds.push(to+" 00:00:00")}
        if(Number.isInteger(ingredientId)&&ingredientId>0){sql+=" AND p.ingredient_id=?";binds.push(ingredientId)}
        sql+=" ORDER BY pb.purchased_at DESC,pb.id DESC LIMIT 500";
        const {results}=await env.DB.prepare(sql).bind(...binds).all();
        return json(results);
      }
      if (url.pathname === "/api/shop/purchase" && request.method === "PUT") {
        await ensureShopSystem(env);
        const data=await request.json();
        const id=Number(data.id), ingredientId=Number(data.ingredient_id);
        const qty=Number(data.quantity), price=Number(data.price_rub);
        const store=String(data.store||"").trim(), brand=String(data.brand||"").trim();
        const purchaseDate=String(data.purchased_at||"").trim();
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректная закупка"},400);
        if(!Number.isInteger(ingredientId)||ingredientId<1)return json({error:"Выберите ингредиент"},400);
        if(!(qty>0))return json({error:"Укажите количество"},400);
        if(!(price>=0))return json({error:"Укажите цену закупки"},400);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate))return json({error:"Укажите дату покупки"},400);
        const batch=await env.DB.prepare("SELECT id,purchased_qty,remaining_qty,product_id FROM purchase_batches WHERE id=?").bind(id).first();
        if(!batch)return json({error:"Закупка не найдена"},404);
        const consumed=Number(batch.purchased_qty)-Number(batch.remaining_qty);
        if(qty<consumed)return json({error:"Количество не может быть меньше уже списанного остатка: "+consumed},400);
        const ing=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE id=? AND is_active=1").bind(ingredientId).first();
        if(!ing)return json({error:"Ингредиент не найден"},404);
        let product=await env.DB.prepare("SELECT id FROM products WHERE ingredient_id=? AND brand=? AND store=? AND is_active=1 LIMIT 1").bind(ingredientId,brand,store).first();
        let productId;
        if(product){productId=Number(product.id)}
        else{
          const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id,store) VALUES(?,?,?,?,0,?,?)").bind(ing.name,brand,"",ing.unit,ingredientId,store).run();
          productId=Number(pr.meta.last_row_id);
        }
        const newRemaining=qty-consumed;
        await env.DB.prepare("UPDATE purchase_batches SET product_id=?,purchased_qty=?,remaining_qty=?,price_rub=?,purchased_at=? WHERE id=?").bind(productId,qty,newRemaining,price,purchaseDate+" 00:00:00",id).run();
        return json({ok:true});
      }

      if (url.pathname === "/api/shop/purchase" && request.method === "DELETE") {
        await ensureShopSystem(env);
        const id=Number(url.searchParams.get("id"));
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректная закупка"},400);
        const batch=await env.DB.prepare("SELECT id,remaining_qty,purchased_qty FROM purchase_batches WHERE id=?").bind(id).first();
        if(!batch)return json({error:"Закупка не найдена"},404);
        const movement=await env.DB.prepare("SELECT COUNT(*) n FROM stock_movements WHERE batch_id=?").bind(id).first();
        if(Number(movement?.n)>0)return json({error:"Эту закупку уже использовали на складе — удалить её нельзя"},409);
        await env.DB.prepare("DELETE FROM purchase_batches WHERE id=?").bind(id).run();
        return json({ok:true});
      }

      if (url.pathname === "/api/shop/purchase" && request.method === "POST") {
        await ensureShopSystem(env);
        const data=await request.json();
        const ingredientId=Number(data.ingredient_id), qty=Number(data.quantity), price=Number(data.price_rub);
        const store=String(data.store||"").trim(), brand=String(data.brand||"").trim();
        const purchaseDate=String(data.purchased_at||"").trim();
        if(!Number.isInteger(ingredientId)||ingredientId<1) return json({error:"Выберите ингредиент"},400);
        if(!(qty>0)) return json({error:"Укажите количество"},400);
        if(!(price>=0)) return json({error:"Укажите цену закупки"},400);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) return json({error:"Укажите дату покупки"},400);
        const ing=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE id=? AND is_active=1").bind(ingredientId).first();
        if(!ing)return json({error:"Ингредиент не найден"},404);
        let product=await env.DB.prepare("SELECT id FROM products WHERE ingredient_id=? AND brand=? AND store=? AND is_active=1 LIMIT 1").bind(ingredientId,brand,store).first();
        let productId;
        if(product){productId=Number(product.id)}else{
          const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id,store) VALUES(?,?,?,?,0,?,?)").bind(ing.name,brand,"",ing.unit,ingredientId,store).run();
          productId=Number(pr.meta.last_row_id);
        }
        const batch=await env.DB.prepare("INSERT INTO purchase_batches(product_id,purchased_qty,remaining_qty,price_rub,purchased_at) VALUES(?,?,?,?,?)").bind(productId,qty,qty,price,purchaseDate+" 00:00:00").run();
        return json({ok:true,id:Number(batch.meta.last_row_id),product_id:productId},201);
      }

      if (url.pathname === "/api/ingredients" && request.method === "GET") {
        await ensureIngredientSystem(env);
        const {results}=await env.DB.prepare("SELECT id,name,unit,strength_percent FROM ingredients WHERE is_active=1 ORDER BY name").all();
        return json(results);
      }
      if (url.pathname === "/api/ingredients" && request.method === "POST") {
        await ensureIngredientSystem(env);
        const data=await request.json(), name=String(data.name||"").trim(), unit=String(data.unit||"ml"), strength=Number(data.strength_percent||0);
        if(!name||!["ml","g","pcs"].includes(unit)||!Number.isFinite(strength)||strength<0||strength>100) return json({error:"Укажите название, единицу и крепость от 0 до 100%"},400);
        const r=await env.DB.prepare("INSERT INTO ingredients(name,unit,strength_percent) VALUES(?,?,?)").bind(name,unit,strength).run();
        return json({ok:true,id:r.meta.last_row_id},201);
      }
      if (url.pathname === "/api/ingredients" && request.method === "PUT") {
        await ensureIngredientSystem(env);
        const data=await request.json(), id=Number(data.id), name=String(data.name||"").trim(), unit=String(data.unit||"ml"), strength=Number(data.strength_percent||0);
        if(!id||!name||!["ml","g","pcs"].includes(unit)||!Number.isFinite(strength)||strength<0||strength>100) return json({error:"Некорректные данные: крепость должна быть от 0 до 100%"},400);
        await env.DB.prepare("UPDATE ingredients SET name=?,unit=?,strength_percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(name,unit,strength,id).run();
        const affected=await env.DB.prepare("SELECT DISTINCT cocktail_id FROM recipe_ingredients WHERE ingredient_id=?").bind(id).all();
        for(const row of (affected.results||[])) await refreshCocktailStrength(env,Number(row.cocktail_id));
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
          `SELECT ri.ingredient_id,ri.quantity,i.name,i.category,i.unit,i.strength_percent
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
<a class="card" href="/bar/orders"><h2>📋 Заказы</h2><p class="muted">Текущий заказ бармена</p></a>
<a class="card" href="/bar/statistics"><h2>📊 Статистика</h2><p class="muted">Смены, заказы и коктейли</p></a>
</div></div>`);

      if (url.pathname === "/bar/recipes") return page(`
<header><h1>🍸 Книга рецептов</h1><div class="sub">Рецепт здесь — источник для гостевой «Карты бара»</div></header>
<div class="wrap">
  <div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div>
  <div class="row" style="margin-bottom:16px">
    <button type="button" id="newCocktailBtn">＋ Создать коктейль</button>
  </div>

  <div class="card recipe-form-panel" id="cocktailPanel" hidden>
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 id="formTitle">Новый коктейль</h2></div>
    <form id="cocktailForm">
      <label>Название *</label><input name="name" required placeholder="Например, Negroni">
      <label>Описание для гостя</label><textarea name="description" placeholder="Короткое описание вкуса"></textarea>
      <label>Инвентарь</label>
      <textarea name="inventory" rows="2" placeholder="Джигер
Барная ложка"></textarea>
      <label>Способ приготовления</label><textarea name="method" placeholder="Например: собрать в бокале, перемешать барной ложкой"></textarea>
      <label>Фото коктейля</label>
      <input id="photoFile" type="file" accept="image/*" style="padding:10px">
      <div id="photoPreview" style="margin-top:10px"></div>
      <input name="photo_url" id="photoUrl" type="hidden">

      <h3 style="margin-top:22px">Состав</h3>
      <div id="recipeItems"></div>
      <button type="button" class="secondary" id="addIngredient">＋ Добавить ингредиент</button>

      <div class="form-actions" style="margin-top:18px">
        <button type="submit">💾 Сохранить коктейль</button>
        <button type="button" class="secondary" id="cancelCocktail">Отмена</button>
      </div>
      <p id="msg" class="muted"></p>
    </form>
  </div>

  <div class="card"><div class="row" style="justify-content:space-between"><h2>Коктейли</h2><span class="muted" id="cocktailCount"></span></div><div id="list">Загрузка...</div></div>
</div>
<div id="orderSummary"></div>

<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const unitLabel=u=>u==="g"?"гр":u==="ml"?"мл":u==="pcs"?"шт.":String(u??"");
const fmtQty=v=>{const n=Number(v||0);return Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')};
let products=[];
let draft={shift:null,order:null,items:[]};const load=async()=>{
  const [cr,pr]=await Promise.all([fetch("/api/cocktails"),fetch("/api/ingredients")]);
  const cocktails=await cr.json(); products=await pr.json();
  document.querySelector("#cocktailCount").textContent=cocktails.length ? cocktails.length+" шт." : "";
  document.querySelector("#list").innerHTML=cocktails.length
    ? '<div class="cocktail-grid">'+cocktails.map(c=>'<article class="card cocktail-card">'+
      (c.photo_url?'<div class="cocktail-photo-wrap"><img class="cocktail-photo" src="'+esc(c.photo_url)+'" alt="Фото '+esc(c.name)+'"></div>':'<div class="cocktail-photo-wrap"><div class="cocktail-photo-placeholder">🍸</div></div>')+
      '<div class="cocktail-card-body"><div class="cocktail-card-head"><div style="min-width:0;flex:1">'+
      '<div class="cocktail-title-row"><h3>'+esc(c.name)+'</h3></div>'+
      '<div class="cocktail-description muted">'+esc(c.description||"Без описания")+'</div>'+
      '<div class="cocktail-meta">'+(c.strength?'<span class="pill strength-pill">🍸 '+esc(c.strength)+'</span>':"")+'</div>'+
      '</div><div class="cocktail-actions">'+
      '<button type="button" class="secondary edit-cocktail" data-id="'+c.id+'" title="Редактировать">✏️</button>'+
      '<button type="button" class="secondary delete-cocktail" data-id="'+c.id+'" title="Удалить коктейль">🗑️</button>'+
      '</div></div>'+
      '<div class="cocktail-price">'+Number(c.price_rub||0)+' ₽</div>'+
      '<div class="cocktail-section"><div class="cocktail-section-title">Состав</div>'+
      (c.recipe_items?.length?'<div class="recipe-list">'+c.recipe_items.map(i=>'<div class="recipe-line"><div class="recipe-name">'+esc(i.ingredient_name)+'<span class="recipe-stock">остаток: '+fmtQty(i.stock_available)+' '+unitLabel(i.unit)+'</span></div><div class="recipe-qty">'+fmtQty(i.quantity)+' '+unitLabel(i.unit)+'</div></div>').join("")+'</div>':'<span class="muted">Не указан</span>')+
      '</div>'+
      ((c.method||c.glass)?'<div class="cocktail-info-grid">'+
        (c.method?'<div class="cocktail-info">🥄 <b>Приготовление</b><br>'+esc(c.method)+'</div>':"")+
        (c.glass?'<div class="cocktail-info">🧰 <b>Инвентарь</b><br><span style="white-space:pre-line">'+esc(c.glass)+'</span></div>':"")+
      '</div>':"")+
      '</div></article>').join("")+'</div>'
    : '<div class="empty">Пока коктейлей нет. Создай первый 👇</div>';
  document.querySelectorAll(".edit-cocktail").forEach(btn=>btn.onclick=()=>startEdit(cocktails.find(c=>Number(c.id)===Number(btn.dataset.id))));
  document.querySelectorAll(".delete-cocktail").forEach(btn=>btn.onclick=async()=>{
    const c=cocktails.find(x=>Number(x.id)===Number(btn.dataset.id));
    if(!c)return;
    if(!confirm('Удалить коктейль «'+c.name+'»? Его рецепт и фотография также будут удалены.'))return;
    btn.disabled=true;
    const r=await fetch("/api/cocktails",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({id:c.id})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok){
      btn.disabled=false;
      alert(data.error||"Не удалось удалить коктейль");
      return;
    }
    await load();
  });
  loadOrderBar();
  if (!document.querySelector(".recipe-row")) addRow();
};
async function loadOrderBar(){const r=await fetch("/api/bar/order");if(!r.ok)return;draft=await r.json();enhanceOrderControls();renderOrderSummary()}
function draftQty(id){return Number((draft.items||[]).find(x=>Number(x.cocktail_id)===Number(id))?.quantity||0)}
function enhanceOrderControls(){document.querySelectorAll(".order-controls").forEach(x=>x.remove());document.querySelectorAll(".cocktail-card").forEach(card=>{const edit=card.querySelector(".edit-cocktail");if(!edit)return;const id=Number(edit.dataset.id),qty=draftQty(id);const box=document.createElement("div");box.className="order-controls row";box.style.cssText="justify-content:center";const minus=document.createElement("button");minus.type="button";minus.className="secondary";minus.textContent="−";minus.setAttribute("aria-label","Убрать коктейль");minus.disabled=qty<=0;minus.onclick=()=>changeOrder(id,-1);const count=document.createElement("span");count.textContent=String(qty);count.setAttribute("aria-label","Количество");const plus=document.createElement("button");plus.type="button";plus.textContent="+";plus.setAttribute("aria-label","Добавить коктейль");plus.onclick=()=>changeOrder(id,1);box.append(minus,count,plus);card.querySelector(".cocktail-card-body").appendChild(box)})}
async function changeOrder(id,delta){const r=await fetch("/api/bar/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cocktail_id:id,delta})});const d=await r.json().catch(()=>({}));if(!r.ok){alert(d.error||"Не удалось изменить заказ");return}draft=d;enhanceOrderControls();renderOrderSummary()}
function renderOrderSummary(){const box=document.querySelector("#orderSummary");if(!box)return;const items=draft.items||[];if(!items.length){box.innerHTML="";return}box.innerHTML="";const card=document.createElement("div");card.className="card";card.style.cssText="margin:14px 0;position:sticky;bottom:10px;z-index:5;box-shadow:0 12px 40px #000;border-color:#3b3b3b";const title=document.createElement("h3");title.textContent="📋 Текущий заказ";card.appendChild(title);const sh=document.createElement("div");sh.className="muted";sh.textContent="Смена №"+(draft.shift?.id||"—");card.appendChild(sh);items.forEach(x=>{const row=document.createElement("div");row.style.padding="5px 0";row.textContent=x.cocktail_name+" × "+x.quantity;card.appendChild(row)});const total=document.createElement("div");total.style.marginTop="6px";total.textContent="Всего коктейлей: "+Number(draft.total_cocktails||0)+" · Сумма: "+Number(draft.total_price||0).toFixed(0)+" ₽";card.appendChild(total);const actions=document.createElement("div");actions.className="row";actions.style.marginTop="10px";const accept=document.createElement("button");accept.textContent="✅ Принять заказ";accept.onclick=async()=>{const r=await fetch("/api/bar/order/accept",{method:"POST"}),d=await r.json().catch(()=>({}));if(!r.ok){alert(d.error||"Не удалось принять заказ");return}alert("Заказ №"+d.order_id+" принят ✅");await load();await loadOrderBar()};const clear=document.createElement("button");clear.className="secondary";clear.textContent="Очистить";clear.onclick=async()=>{if(!confirm("Очистить текущий заказ? Резерв ингредиентов будет снят."))return;await fetch("/api/bar/order",{method:"DELETE"});draft={shift:draft.shift,order:null,items:[]};enhanceOrderControls();renderOrderSummary()};actions.append(accept,clear);card.appendChild(actions);box.appendChild(card)}
const showPanel=()=>{
  const panel=document.querySelector("#cocktailPanel");
  panel.hidden=false;
  panel.scrollIntoView({behavior:"smooth",block:"start"});
};
const resetCocktailForm=()=>{
  const form=document.querySelector("#cocktailForm");
  form.reset();
  delete form.dataset.editId;
  document.querySelector("#recipeItems").innerHTML="";
  document.querySelector("#photoUrl").value="";
  document.querySelector("#photoPreview").innerHTML="";
  document.querySelector("#msg").textContent="";
  document.querySelector("#formTitle").textContent="Новый коктейль";
  form.querySelector('button[type=submit]').textContent="💾 Сохранить коктейль";
  addRow();
};
const startEdit=(c)=>{
  if(!c)return;
  showPanel();
  const form=document.querySelector("#cocktailForm");
  form.dataset.editId=c.id;
  for(const n of ["name","description","method"]){
    const el=form.elements[n]; if(el)el.value=c[n]||"";
  }
  if(form.elements.inventory)form.elements.inventory.value=c.glass||"";
  document.querySelector("#photoUrl").value=c.photo_url||"";
  document.querySelector("#photoPreview").innerHTML=c.photo_url?'<img src="'+esc(c.photo_url)+'" style="max-width:240px;max-height:240px;border-radius:14px;display:block" alt="Фото">':"";
  document.querySelector("#recipeItems").innerHTML="";
  (c.recipe_items||[]).forEach(item=>addRow(item));
  document.querySelector("#formTitle").textContent="Редактирование: "+(c.name||"коктейль");
  document.querySelector("#cocktailForm button[type=submit]").textContent="💾 Сохранить изменения";
};
const addRow=(initial=null)=>{
  const wrap=document.createElement("div"); wrap.className="recipe-row";
  wrap.innerHTML='<div class="ingredient-picker"><input class="ingredient-search" type="search" placeholder="🔎 Введите ингредиент..." autocomplete="off"><input class="prod" type="hidden" value=""><div class="ingredient-suggestions" hidden></div></div><input class="qty" type="number" min="0.01" step="0.01" placeholder="Количество"><button type="button" class="secondary remove">×</button>';
  const search=wrap.querySelector(".ingredient-search"), hidden=wrap.querySelector(".prod"), suggestions=wrap.querySelector(".ingredient-suggestions");
  const fill=()=>{
    hidden.value="";
    const q=search.value.trim().toLowerCase().replace(/ё/g,"е");
    const filtered=products.filter(p=>String(p.name).toLowerCase().replace(/ё/g,"е").includes(q)).slice(0,20);
    suggestions.innerHTML=filtered.length
      ? filtered.map(p=>'<div class="ingredient-suggestion" data-id="'+p.id+'"><b>'+esc(p.name)+'</b><div class="muted">'+esc(p.unit)+'</div></div>').join("")
      : '<div class="ingredient-suggestion muted">Ничего не найдено</div>';
    suggestions.hidden=false;
    suggestions.querySelectorAll("[data-id]").forEach(el=>el.onclick=()=>{
      const p=products.find(x=>String(x.id)===String(el.dataset.id));
      if(!p)return;
      hidden.value=String(p.id);
      search.value=p.name;
      suggestions.hidden=true;
    });
  };
  search.addEventListener("input",fill);
  search.addEventListener("focus",()=>{if(search.value.trim())fill();});
  document.addEventListener("click",ev=>{if(!wrap.contains(ev.target))suggestions.hidden=true},{once:false});
  wrap.querySelector(".remove").onclick=()=>wrap.remove();
  document.querySelector("#recipeItems").appendChild(wrap);
  if(initial){
    const p=products.find(x=>Number(x.id)===Number(initial.ingredient_id));
    if(p){search.value=p.name;hidden.value=String(p.id);}
    wrap.querySelector(".qty").value=initial.quantity;
  }
};

document.querySelector("#newCocktailBtn").onclick=()=>{
  resetCocktailForm();
  showPanel();
};
document.querySelector("#cancelCocktail").onclick=()=>{
  document.querySelector("#cocktailPanel").hidden=true;
  resetCocktailForm();
};
document.querySelector("#photoFile").onchange=()=>{
  const file=document.querySelector("#photoFile").files[0], box=document.querySelector("#photoPreview");
  if(!file){box.innerHTML="";return;}
  const url=URL.createObjectURL(file);
  box.innerHTML='<img src="'+url+'" style="max-width:240px;max-height:240px;border-radius:14px;display:block" alt="Превью">';
};
document.querySelector("#addIngredient").onclick=addRow;
document.querySelector("#cocktailForm").onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const recipe_items=[...document.querySelectorAll(".recipe-row")].map(r=>({ingredient_id:Number(r.querySelector(".prod").value),quantity:Number(r.querySelector(".qty").value)})).filter(x=>x.ingredient_id>0&&x.quantity>0);
  if(!recipe_items.length && document.querySelector(".recipe-row")){document.querySelector("#msg").textContent="Выберите ингредиент из списка";return;}
  const file=document.querySelector("#photoFile").files[0];
  if(file){
    document.querySelector("#msg").textContent="Загрузка фотографии…";
    const upload=new FormData(); upload.append("file",file);
    const ur=await fetch("/api/cocktail-photo",{method:"POST",body:upload});
    const ud=await ur.json();
    if(!ur.ok){document.querySelector("#msg").textContent="Ошибка фото: "+(ud.error||"не удалось загрузить");return;}
    document.querySelector("#photoUrl").value=ud.url;
    // FormData was created before the async upload, so update it explicitly.
    // Otherwise the uploaded R2 URL never reaches /api/cocktails.
    f.set("photo_url", ud.url);
    document.querySelector("#photoPreview").innerHTML='<img src="'+esc(ud.url)+'" style="max-width:240px;max-height:240px;border-radius:14px;display:block" alt="Фото">';
  }
  const body=Object.fromEntries(f.entries()); body.recipe_items=recipe_items;
  if(body.photo_url) body.photo_url=String(body.photo_url);
  const editId=Number(e.target.dataset.editId||0);
  const r=await fetch("/api/cocktails",{method:editId?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(editId?{...body,id:editId}:body)});
  const data=await r.json();
  document.querySelector("#msg").textContent=r.ok?"Сохранено ✅":"Ошибка: "+(data.error||"не удалось сохранить");
  if(r.ok){
    document.querySelector("#cocktailPanel").hidden=true;
    resetCocktailForm();
    await load();
  }
};
load();
loadOrderBar();
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
<label>Крепость алкоголя, %</label><input name="strength_percent" type="number" min="0" max="100" step="0.1" value="0" placeholder="Например, 40"><p class="muted">Для водки 40%, ликёра 20%, сока/газировки — 0%.</p>
<div style="margin-top:16px"><button>＋ Добавить</button></div><p id="msg" class="muted"></p>
</form>
</div><div style="height:16px"></div>
<div class="card"><h2>Справочник</h2><div id="list">Загрузка...</div></div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function load(){const r=await fetch("/api/ingredients");const x=await r.json();document.querySelector("#list").innerHTML=x.map(i=>'<div class="ingredient-item" data-id="'+i.id+'" style="padding:12px 0;border-bottom:1px solid #292929"><div class="ingredient-view"><b>#'+i.id+' · '+esc(i.name)+'</b><span class="muted"> · '+i.unit+' · <strong>🍸 '+Number(i.strength_percent||0).toFixed(1)+'%</strong></span> <button type="button" class="secondary edit">Изменить</button></div></div>').join("")||'<div class="empty">Нет ингредиентов</div>';
document.querySelectorAll(".ingredient-item .edit").forEach(b=>b.onclick=()=>{const item=b.closest(".ingredient-item"), id=Number(item.dataset.id), current=x.find(v=>Number(v.id)===id);if(!current)return;item.innerHTML='<div class="grid" style="grid-template-columns:1fr 140px 140px;align-items:end"><div><label>Название</label><input class="edit-name" value="'+esc(current.name)+'"></div><div><label>Единица</label><select class="edit-unit"><option value="ml"'+(current.unit==="ml"?" selected":"")+'>мл</option><option value="g"'+(current.unit==="g"?" selected":"")+'>г</option><option value="pcs"'+(current.unit==="pcs"?" selected":"")+'>шт.</option></select></div><div><label>Крепость, %</label><input class="edit-strength" type="number" min="0" max="100" step="0.1" value="'+Number(current.strength_percent||0)+'"></div></div><div class="row" style="margin-top:10px"><button type="button" class="save-edit">💾 Сохранить</button><button type="button" class="secondary cancel-edit">Отмена</button><span class="edit-msg muted"></span></div>';item.querySelector(".cancel-edit").onclick=()=>load();item.querySelector(".save-edit").onclick=async()=>{const name=item.querySelector(".edit-name").value.trim(),unit=item.querySelector(".edit-unit").value,strength=Number(item.querySelector(".edit-strength").value||0),msg=item.querySelector(".edit-msg");if(!name||!Number.isFinite(strength)||strength<0||strength>100){msg.textContent="Проверьте название и крепость 0–100%";return}const r=await fetch("/api/ingredients",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({id,name,unit,strength_percent:strength})});const d=await r.json();if(!r.ok){msg.textContent=d.error||"Ошибка"}else load()}})}
document.querySelector("#ingredientForm").onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch("/api/ingredients",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json();document.querySelector("#msg").textContent=r.ok?"Ингредиент добавлен ✅":"Ошибка: "+(d.error||"");if(r.ok){e.target.reset();load()}};load();
</script>`, "Ингредиенты");
      if (url.pathname === "/bar/stock") {
        // Первичная загрузка склада выполняется на сервере. Это исключает
        // зависимость открытия страницы от отдельного AJAX-запроса и старого
        // браузерного кэша: пользователь сразу видит ингредиенты и остатки.
        let stockIngredients=[], stockItems=[];
        let stockLoadError="";
        try{
          await ensureIngredientSystem(env);
          const ir=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE is_active=1 ORDER BY name").all();
          stockIngredients=ir.results||[];
          stockItems=await getProducts(env);
        }catch(e){
          stockLoadError=String(e?.message||e);
        }
        const hEsc=s=>String(s??"").replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;",'\'':"&#39;"}[c]));
        const initialIngredients=JSON.stringify(stockIngredients).replace(/</g,"\\u003c");
        const initialStock=JSON.stringify(stockItems).replace(/</g,"\\u003c");
        return page(`
<header><h1>📦 Склад</h1><div class="sub">Справочник товаров и текущие остатки</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div>
<div class="card">
<h2>Новый товар</h2>
<form id="productForm">
<label>Ингредиент *</label><select name="ingredient_id" id="ingredientSelect" required><option value="">Выберите ингредиент...</option>${stockIngredients.map(p=>'<option value="'+p.id+'">'+hEsc(p.name)+' ('+hEsc(p.unit)+')</option>').join("")}</select>
<label>Бренд</label><input name="brand" placeholder="Например, Царская">
<label>Количество ингредиента в бутылке / упаковке</label><input name="quantity" id="quantity" type="number" min="0" step="0.01" value="0" placeholder="Например, 500">
<label>Цена за бутылку / упаковку, ₽</label><input name="price" id="stockPrice" type="number" min="0" step="0.01" placeholder="Например, 300">
<label style="display:flex;align-items:center;gap:10px;margin-top:10px"><input name="take_average" id="takeAverage" type="checkbox" style="width:auto"> Взять среднюю цену по ингредиенту</label>
<div style="margin-top:16px"><button>＋ Добавить товар</button></div>
<p id="msg" class="muted"></p>
</form>
</div>
<div style="height:16px"></div>
<div class="card"><h2>Товары</h2><div id="stock">${stockLoadError?'<div class="empty">Ошибка загрузки склада: '+hEsc(stockLoadError)+'<br><button type="button" onclick="location.reload()">Обновить</button></div>':(stockItems.length?stockItems.map(p=>'<div class="stock-item" data-id="'+p.ingredient_id+'" style="padding:12px 0;border-bottom:1px solid #292929"><div><b>🥃 '+hEsc(p.ingredient_name)+'</b></div><div class="muted" style="margin-top:5px">Всего: <b>'+Number(p.stock).toFixed(2)+' '+hEsc(p.unit)+'</b> · Средняя цена: <b>'+Number(p.unit_price).toFixed(4)+' ₽/'+hEsc(p.unit)+'</b></div><div style="margin-top:9px;padding-left:12px;border-left:2px solid #333">'+(p.details||[]).map(d=>'<div style="padding:5px 0"><b>'+hEsc(d.brand)+'</b> — '+Number(d.stock).toFixed(2)+' '+hEsc(p.unit)+' · '+Number(d.unit_price).toFixed(4)+' ₽/'+hEsc(p.unit)+(d.store?' · '+hEsc(d.store):'')+'</div>').join("")+'</div><div class="row" style="margin-top:9px"></div></div>').join(""):'<div class="empty">Товаров пока нет.</div>')}</div></div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let stockItems=${initialStock};

function renderStock(){
  const el=document.querySelector("#stock");
  if(!stockItems.length){el.innerHTML='<div class="empty">Товаров пока нет.</div>';return}
  el.innerHTML=stockItems.map(p=>'<div class="stock-item" data-id="'+p.ingredient_id+'" style="padding:12px 0;border-bottom:1px solid #292929"><div><b>🥃 '+esc(p.ingredient_name)+'</b></div><div class="muted" style="margin-top:5px">Всего: <b>'+Number(p.stock).toFixed(2)+' '+esc(p.unit)+'</b> · Средняя цена: <b>'+Number(p.unit_price).toFixed(4)+' ₽/'+esc(p.unit)+'</b></div><div style="margin-top:9px;padding-left:12px;border-left:2px solid #333">'+(p.details||[]).map((d,di)=>'<div class="stock-detail" style="padding:8px 0;border-bottom:1px solid #222"><div><b>'+esc(d.brand)+'</b> — '+Number(d.stock).toFixed(2)+' '+esc(p.unit)+' · '+Number(d.unit_price).toFixed(4)+' ₽/'+esc(p.unit)+(d.store?' · '+esc(d.store):'')+'</div><div class="row" style="margin-top:6px;gap:8px"><button type="button" class="secondary edit-source" data-i="'+di+'" style="padding:6px 10px;font-size:13px">✏️ Изменить</button><button type="button" class="secondary delete-source" data-i="'+di+'" style="padding:6px 10px;font-size:13px">🗑️ Удалить</button></div></div>').join("")+'</div><div class="row" style="margin-top:9px"></div></div>').join("");
  bindStockButtons();
}

function bindStockButtons(){
  document.querySelectorAll(".delete-source").forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest(".stock-item");
    const p=stockItems.find(v=>Number(v.ingredient_id)===Number(row.dataset.id));
    const d=p?.details?.[Number(btn.dataset.i)];
    if(!p||!d)return;
    if(!confirm("Удалить «"+d.brand+"» из склада?"+(d.store&&d.store!=="Ручной ввод"?" Остаток закупки будет обнулён, история покупки сохранится.":"")))return;
    const r=await fetch("/api/products",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({ingredient_id:p.ingredient_id,brand:d.brand,store:d.store||""})});
    const x=await r.json();
    if(!r.ok){alert(x.error||"Ошибка");return}
    location.reload();
  });

  document.querySelectorAll(".edit-source").forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest(".stock-item");
    const p=stockItems.find(v=>Number(v.ingredient_id)===Number(row.dataset.id));
    const d=p?.details?.[Number(btn.dataset.i)];
    if(!p||!d)return;
    if(d.source_type!=="manual"){
      alert("Закупленный товар редактируется в разделе «Магазин».");
      return;
    }
    const brand=prompt("Название / бренд",d.brand);
    if(brand===null)return;
    const qty=prompt("Количество, "+p.unit,Number(d.stock));
    if(qty===null)return;
    const pricePerUnit=prompt("Цена за "+p.unit+" ₽",Number(d.unit_price).toFixed(4));
    if(pricePerUnit===null)return;
    const quantity=Number(qty), unitPrice=Number(pricePerUnit);
    if(!brand.trim()||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0){
      alert("Проверьте название, количество и цену.");
      return;
    }
    const r=await fetch("/api/products",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({source_edit:true,ingredient_id:p.ingredient_id,old_brand:d.brand,old_store:d.store||"Ручной ввод",brand:brand.trim(),store:"Ручной ввод",quantity,unit_price:unitPrice})});
    const x=await r.json();
    if(!r.ok){alert(x.error||"Ошибка");return}
    location.reload();
  });
}

document.querySelector("#productForm").onsubmit=async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target));
  body.name="";
  body.ingredient_id=Number(body.ingredient_id);
  delete body.unit;
  body.quantity=Number(body.quantity||0);
  body.price=Number(body.price||0);
  body.take_average=document.querySelector("#takeAverage").checked;
  const r=await fetch("/api/products",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();
  document.querySelector("#msg").textContent=r.ok?"Товар добавлен ✅":"Ошибка: "+(d.error||"");
  if(r.ok){e.target.reset();location.reload();}
};

function updateAveragePrice(){
  const checked=document.querySelector("#takeAverage").checked;
  const price=document.querySelector("#stockPrice");
  price.disabled=checked;
  if(!checked)return;
  const ingredientId=Number(document.querySelector("#ingredientSelect").value);
  const item=stockItems.find(v=>Number(v.ingredient_id)===ingredientId);
  price.value=item&&Number(item.stock)>0?Number(item.unit_price)*Number(document.querySelector("#quantity").value||0)>0?(Number(item.unit_price)*Number(document.querySelector("#quantity").value||0)).toFixed(2):"":"";
}
document.querySelector("#takeAverage").onchange=updateAveragePrice;
document.querySelector("#ingredientSelect").onchange=updateAveragePrice;
document.querySelector("#quantity").oninput=updateAveragePrice;
renderStock();
</script>`, "Склад");
      }

      if (url.pathname === "/menu") return page(`
<header><h1>🥂 Карта бара</h1><div class="sub">Гостевое меню · без рецептур</div></header>
<div class="wrap"><div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a></div><div id="menu" class="grid"><div class="card">Загрузка...</div></div></div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
fetch("/api/cocktails").then(r=>r.json()).then(x=>{document.querySelector("#menu").innerHTML=x.length?x.map(c=>'<div class="card">'+(c.photo_url?'<img src="'+esc(c.photo_url)+'" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;margin-bottom:12px;display:block" alt="Фото '+esc(c.name)+'">':"")+'<h2>'+esc(c.name)+'</h2><p class="muted">'+esc(c.description)+'</p><span class="pill">'+esc(c.strength||"")+'</span><span class="pill">'+Number(c.price_rub||0)+' ₽</span></div>').join(""):'<div class="card">Пока коктейлей нет.</div>'});
</script>`);

      if (url.pathname === "/bar/shop") return page(`
<header><h1>🛒 Магазин</h1><div class="sub">Закупки и партии товара</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a><a href="/bar/stock" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">📦 Склад</a></div>

<div class="card"><h2>Новая закупка</h2><p class="muted">Фиксируем фактически купленную партию.</p>
<form id="purchaseForm">
<label>Ингредиент *</label><select name="ingredient_id" id="ingredientSelect" required><option value="">Загрузка...</option></select>
<label>Магазин / поставщик</label><input name="store" placeholder="Например, Перекрёсток">
<label>Бренд</label><input name="brand" placeholder="Например, Царская">
<label>Дата покупки *</label><input name="purchased_at" type="date" required>
<div class="grid"><div><label>Количество *</label><input name="quantity" type="number" min="0.01" step="0.01" required placeholder="1000"></div><div><label>Цена закупки, ₽ *</label><input name="price_rub" type="number" min="0" step="0.01" required placeholder="650"></div></div>
<div style="margin-top:16px"><button>🛒 Оприходовать закупку</button></div><p id="msg" class="muted"></p>
</form></div>

<div style="height:16px"></div>
<div class="card"><h2>🔎 Фильтр закупок</h2>
<div class="grid">
<div><label>С даты</label><input id="filterFrom" type="date"></div>
<div><label>По дату</label><input id="filterTo" type="date"></div>
</div>
<label>Ингредиент</label><select id="filterIngredient"><option value="">Все ингредиенты</option></select>
<div class="row" style="margin-top:14px"><button type="button" id="applyFilter">🔎 Показать</button><button type="button" class="secondary" id="todayFilter">Сегодня</button><button type="button" class="secondary" id="clearFilter">Сбросить</button></div>
<p class="muted">Например, выберите «Водка», чтобы увидеть все покупки водки. Чтобы посмотреть покупки только за 5 число — поставьте 5-е число в оба поля.</p>
</div>

<div style="height:16px"></div><div class="card"><h2>Закупки</h2><div id="history">Загрузка...</div></div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let ingredients=[];
const pad=n=>String(n).padStart(2,"0");
const localDate=()=>{const d=new Date();return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())};
document.querySelector("#purchaseForm [name=purchased_at]").value=localDate();
const formatDate=s=>{const m=String(s||"").match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+"."+m[2]+"."+m[1]:String(s||"")};
const unitPrice=(price,qty)=>qty>0?(Number(price)/Number(qty)).toFixed(4):"0.0000";

async function loadIngredients(){
  const r=await fetch("/api/ingredients");
  const data=await r.json();
  if(!r.ok||!Array.isArray(data)) throw new Error(data?.error||"Не удалось загрузить ингредиенты");
  ingredients=data;
  const opts=ingredients.map(i=>'<option value="'+i.id+'">'+esc(i.name)+' ('+esc(i.unit)+')</option>').join("");
  document.querySelector("#ingredientSelect").innerHTML='<option value="">Выберите ингредиент...</option>'+opts;
  document.querySelector("#filterIngredient").innerHTML='<option value="">Все ингредиенты</option>'+opts;
}

async function loadHistory(){
  const params=new URLSearchParams();
  const from=document.querySelector("#filterFrom").value, to=document.querySelector("#filterTo").value, ing=document.querySelector("#filterIngredient").value;
  if(from)params.set("date_from",from); if(to)params.set("date_to",to); if(ing)params.set("ingredient_id",ing);
  const r=await fetch("/api/shop/purchases?"+params.toString()); const history=await r.json();
  if(!r.ok||!Array.isArray(history)) throw new Error(history?.error||"Не удалось загрузить закупки");
  document.querySelector("#history").innerHTML=history.length?history.map(x=>{
    const consumed=Math.max(0,Number(x.purchased_qty)-Number(x.remaining_qty));
    return '<div class="purchase-item" data-id="'+x.id+'" style="padding:13px 0;border-bottom:1px solid #292929">'+
      '<div class="purchase-view"><b>'+esc(x.ingredient_name)+'</b><div class="muted">Дата покупки: '+formatDate(x.purchased_at)+'</div><div class="muted">'+Number(x.purchased_qty)+' '+esc(x.unit)+' · '+Number(x.price_rub).toFixed(2)+' ₽ · '+unitPrice(x.price_rub,x.purchased_qty)+' ₽/'+esc(x.unit)+(x.store?' · '+esc(x.store):'')+(x.brand?' · '+esc(x.brand):'')+'</div>'+
      '<div class="muted">Осталось: '+Number(x.remaining_qty)+' '+esc(x.unit)+(consumed?' · списано: '+consumed+' '+esc(x.unit):'')+'</div>'+
      '<div class="row" style="margin-top:9px"><button type="button" class="secondary edit">✏️ Изменить</button><button type="button" class="secondary delete">🗑 Удалить</button></div></div></div>';
  }).join(""):'<div class="empty">По выбранному фильтру закупок нет.</div>';
  document.querySelectorAll(".purchase-item .edit").forEach(b=>b.onclick=()=>editPurchase(history,b.closest(".purchase-item").dataset.id));
  document.querySelectorAll(".purchase-item .delete").forEach(b=>b.onclick=()=>deletePurchase(b.closest(".purchase-item").dataset.id));
}

function editPurchase(history,id){
  const item=history.find(x=>String(x.id)===String(id)); if(!item)return;
  const row=document.querySelector('.purchase-item[data-id="'+id+'"]');
  const consumed=Math.max(0,Number(item.purchased_qty)-Number(item.remaining_qty));
  const dt=String(item.purchased_at||"").slice(0,10);
  row.innerHTML='<div><div class="grid">'+
    '<div><label>Ингредиент</label><select class="edit-ingredient">'+ingredients.map(i=>'<option value="'+i.id+'"'+(Number(i.id)===Number(item.ingredient_id)?' selected':'')+'>'+esc(i.name)+' ('+esc(i.unit)+')</option>').join("")+'</select></div>'+
    '<div><label>Магазин / поставщик</label><input class="edit-store" value="'+esc(item.store||"")+'"></div>'+
    '<div><label>Бренд</label><input class="edit-brand" value="'+esc(item.brand||"")+'"></div>'+
    '<div><label>Дата покупки</label><input class="edit-date" type="date" value="'+dt+'"></div>'+
    '<div><label>Количество</label><input class="edit-qty" type="number" min="'+Math.max(0.01,consumed).toString()+'" step="0.01" value="'+Number(item.purchased_qty)+'"></div>'+
    '<div><label>Цена закупки, ₽</label><input class="edit-price" type="number" min="0" step="0.01" value="'+Number(item.price_rub)+'"></div>'+
    '</div><p class="muted">Уже списано: '+consumed+' '+esc(item.unit)+'. Количество нельзя уменьшить ниже этого значения.</p>'+
    '<div class="row"><button type="button" class="save-edit">💾 Сохранить</button><button type="button" class="secondary cancel-edit">Отмена</button><span class="edit-msg muted"></span></div></div>';
  row.querySelector(".cancel-edit").onclick=loadHistory;
  row.querySelector(".save-edit").onclick=async()=>{
    const body={id:Number(id),ingredient_id:Number(row.querySelector(".edit-ingredient").value),store:row.querySelector(".edit-store").value.trim(),brand:row.querySelector(".edit-brand").value.trim(),purchased_at:row.querySelector(".edit-date").value,quantity:Number(row.querySelector(".edit-qty").value),price_rub:Number(row.querySelector(".edit-price").value)};
    const msg=row.querySelector(".edit-msg");
    const r=await fetch("/api/shop/purchase",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); const d=await r.json();
    if(!r.ok){msg.textContent="Ошибка: "+(d.error||"не удалось сохранить");return} await loadHistory();
  };
}

async function deletePurchase(id){
  if(!confirm("Удалить эту закупку? Товар и его остаток по этой партии будут удалены из истории магазина."))return;
  const r=await fetch("/api/shop/purchase?id="+encodeURIComponent(id),{method:"DELETE"}); const d=await r.json();
  if(!r.ok){alert(d.error||"Не удалось удалить закупку");return} await loadHistory();
}

document.querySelector("#purchaseForm").onsubmit=async e=>{
  e.preventDefault(); const body=Object.fromEntries(new FormData(e.target));
  body.ingredient_id=Number(body.ingredient_id); body.quantity=Number(body.quantity); body.price_rub=Number(body.price_rub);
  const r=await fetch("/api/shop/purchase",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); const d=await r.json();
  document.querySelector("#msg").textContent=r.ok?"Закупка добавлена ✅":"Ошибка: "+(d.error||"не удалось сохранить");
  if(r.ok){e.target.reset();document.querySelector("#purchaseForm [name=purchased_at]").value=localDate();await loadHistory();}
};

document.querySelector("#applyFilter").onclick=loadHistory;
document.querySelector("#clearFilter").onclick=()=>{document.querySelector("#filterFrom").value="";document.querySelector("#filterTo").value="";document.querySelector("#filterIngredient").value="";loadHistory();};
document.querySelector("#todayFilter").onclick=()=>{const d=new Date();const s=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());document.querySelector("#filterFrom").value=s;document.querySelector("#filterTo").value=s;loadHistory();};

(async()=>{
  try{
    await loadIngredients();
    await loadHistory();
  }catch(e){
    document.querySelector("#ingredientSelect").innerHTML='<option value="">Ошибка загрузки ингредиентов</option>';
    document.querySelector("#filterIngredient").innerHTML='<option value="">Не удалось загрузить</option>';
    document.querySelector("#history").innerHTML='<div class="empty">Ошибка: '+esc(e.message||e)+'</div>';
  }
})();
</script>`, "Магазин");

      if (url.pathname === "/bar/statistics") return page(`<header><h1>📊 Статистика</h1><div class="sub">Смены, заказы и приготовленные коктейли</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a><a href="/bar/recipes" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🍸 Книга рецептов</a></div>
<div class="card" id="shiftBox">Загрузка…</div>
<div style="height:16px"></div>
<div class="card"><h2>История смен</h2><div id="stats">Загрузка…</div></div>
</div>
<script>
async function loadStats(){
 const r=await fetch("/api/bar/statistics");
 const d=await r.json();
 if(!r.ok){document.querySelector("#stats").textContent=d.error||"Ошибка";return;}
 const open=(d.shifts||[]).find(x=>x.status==="open");
 const box=document.querySelector("#shiftBox");
 box.innerHTML=open?"<h2>Смена №"+open.id+" 🟢</h2><p class=\"muted\">Начало: "+open.started_at+"</p><button id=\"closeShift\" class=\"secondary\">Закрыть смену</button>":"<h2>Смена не открыта</h2><p class=\"muted\">Нажми «＋» у коктейля — смена откроется автоматически.</p><button id=\"openShift\">▶ Открыть смену</button>";
 if(open){document.querySelector("#closeShift").onclick=async()=>{const x=await fetch("/api/bar/shift",{method:"PUT"});const j=await x.json();if(!x.ok){alert(j.error||"Не удалось закрыть смену");return;}loadStats()};}
 else{document.querySelector("#openShift").onclick=async()=>{const x=await fetch("/api/bar/shift",{method:"POST"});if(!x.ok){alert("Не удалось открыть смену");return;}loadStats()};}
 document.querySelector("#stats").innerHTML=(d.shifts||[]).map(x=>"<div style=\"padding:14px 0;border-bottom:1px solid #292929\"><b>Смена №"+x.id+"</b> · "+(x.status==="open"?"🟢 открыта":"закрыта")+"<div class=\"muted\">"+x.started_at+" → "+(x.closed_at||"сейчас")+"</div><div style=\"margin-top:6px\"><b>"+Number(x.orders_count||0)+"</b> заказов · <b>"+Number(x.cocktails_count||0)+"</b> коктейлей · <b>"+Number(x.revenue_rub||0).toFixed(0)+" ₽</b></div></div>").join("")||"<div class=\"empty\">Смен ещё нет.</div>";
}
loadStats();
</script>`, "Статистика");

      if (url.pathname === "/bar/orders") return page(`<header><h1>📋 Текущий заказ</h1><div class="sub">＋ и − меняют заказ. Склад резервируется сразу, окончательное списание — после принятия.</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a><a href="/bar/recipes" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🍸 Книга рецептов</a></div>
<div class="card"><div id="order">Загрузка…</div></div>
</div>
<script>
async function loadOrder(){
 const r=await fetch("/api/bar/order");const d=await r.json();const box=document.querySelector("#order");
 if(!d.items||!d.items.length){box.innerHTML="<div class=\"empty\">Текущий заказ пуст.<br><a href=\"/bar/recipes\">← Вернуться в книгу рецептов</a></div>";return;}
 box.innerHTML="<h2>Смена №"+(d.shift?.id||"—")+"</h2>"+d.items.map(i=>"<div class=\"row\" style=\"justify-content:space-between;padding:12px 0;border-bottom:1px solid #292929\"><b>"+i.cocktail_name+"</b><span class=\"row\"><button type=\"button\" class=\"secondary minus\" data-id=\""+i.cocktail_id+"\">−</button><b>"+i.quantity+"</b><button type=\"button\" class=\"plus\" data-id=\""+i.cocktail_id+"\">＋</button></span></div>").join("")+"<p style=\"margin-top:14px\">Коктейлей: <b>"+d.total_cocktails+"</b> · Сумма: <b>"+Number(d.total_price||0).toFixed(0)+" ₽</b></p><div class=\"row\"><button id=\"accept\">✅ Принять заказ</button><button id=\"clear\" class=\"secondary\">Очистить</button></div>";
 document.querySelectorAll(".minus").forEach(b=>b.onclick=()=>changeOrder(Number(b.dataset.id),-1));
 document.querySelectorAll(".plus").forEach(b=>b.onclick=()=>changeOrder(Number(b.dataset.id),1));
 document.querySelector("#accept").onclick=async()=>{const r=await fetch("/api/bar/order/accept",{method:"POST"});const d=await r.json();if(!r.ok){alert(d.error||"Ошибка");return;}alert("Заказ №"+d.order_id+" принят ✅");loadOrder()};
 document.querySelector("#clear").onclick=async()=>{if(!confirm("Очистить текущий заказ?"))return;await fetch("/api/bar/order",{method:"DELETE"});loadOrder()};
}
async function changeOrder(id,delta){const r=await fetch("/api/bar/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cocktail_id:id,delta})});const d=await r.json();if(!r.ok){alert(d.error||"Ошибка");return;}loadOrder()}
loadOrder();
</script>`, "Заказы");

      return new Response("Не найдено",{status:404});
    } catch (error) {
      console.error(error);
      return json({error:"Ошибка сервера",details:String(error?.message||error)},500);
    }
  }
};





