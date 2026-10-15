import { renderDocument, htmlResponse, icon, monogram } from "./design.js";
// Схема базы. Раньше каждая таблица/колонка «досоздавалась» на КАЖДОМ запросе
// (30–40 последовательных обращений к D1 ≈ 3–5 с). Теперь всё это выполняется
// один раз: результат отмечается в app_migrations, а внутри экземпляра Worker'а
// запоминается промисом. Чтобы изменить схему — добавь команду в SCHEMA_SQL и
// поменяй SCHEMA_VERSION: новая версия применится один раз при следующем запросе.
const SCHEMA_VERSION="schema-2026-10-15";
const SCHEMA_SQL=[
  "CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL DEFAULT 'ml' CHECK(unit IN ('ml','g','pcs')), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT NULL, updated_at TEXT DEFAULT NULL)",
  // SQLite/D1 does not allow ADD COLUMN with a non-constant DEFAULT.
  "ALTER TABLE ingredients ADD COLUMN unit TEXT NOT NULL DEFAULT 'ml'",
  "ALTER TABLE ingredients ADD COLUMN strength_percent REAL NOT NULL DEFAULT 0",
  "ALTER TABLE ingredients ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE ingredients ADD COLUMN created_at TEXT DEFAULT NULL",
  "ALTER TABLE ingredients ADD COLUMN updated_at TEXT DEFAULT NULL",
  "CREATE TABLE IF NOT EXISTS recipe_ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, cocktail_id INTEGER NOT NULL REFERENCES cocktails(id) ON DELETE CASCADE, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL CHECK(quantity > 0), UNIQUE(cocktail_id, ingredient_id))",
  "ALTER TABLE products ADD COLUMN ingredient_id INTEGER",
  "ALTER TABLE products ADD COLUMN store TEXT DEFAULT ''",
  "ALTER TABLE purchase_batches ADD COLUMN receipt_deleted INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE cocktails ADD COLUMN avatar_url TEXT DEFAULT ''",
  "CREATE TABLE IF NOT EXISTS stock_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL, unit_price REAL NOT NULL DEFAULT 0, brand TEXT DEFAULT '', store TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "ALTER TABLE stock_adjustments ADD COLUMN brand TEXT DEFAULT ''",
  "ALTER TABLE stock_adjustments ADD COLUMN store TEXT DEFAULT ''",
  "CREATE TABLE IF NOT EXISTS current_stock_lots (id INTEGER PRIMARY KEY AUTOINCREMENT,ingredient_id INTEGER NOT NULL,brand TEXT DEFAULT '',store TEXT DEFAULT '',quantity REAL NOT NULL DEFAULT 0,unit_price REAL NOT NULL DEFAULT 0,source_type TEXT NOT NULL DEFAULT 'manual',source_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_current_stock_source ON current_stock_lots(source_type,source_id)",
  "CREATE INDEX IF NOT EXISTS idx_current_stock_ingredient ON current_stock_lots(ingredient_id)",
  "CREATE TABLE IF NOT EXISTS bar_shifts (id INTEGER PRIMARY KEY AUTOINCREMENT,status TEXT NOT NULL DEFAULT 'open',started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,closed_at TEXT)",
  "CREATE TABLE IF NOT EXISTS bar_orders (id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL REFERENCES bar_shifts(id),status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,accepted_at TEXT,price_total REAL NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS bar_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES bar_orders(id) ON DELETE CASCADE,cocktail_id INTEGER NOT NULL REFERENCES cocktails(id),quantity INTEGER NOT NULL CHECK(quantity>0),price_rub REAL NOT NULL DEFAULT 0,UNIQUE(order_id,cocktail_id))",
  "CREATE TABLE IF NOT EXISTS bar_stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES bar_orders(id),ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),quantity REAL NOT NULL,unit TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  // Гостевая часть (src/worker.js)
  "CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT UNIQUE,pin_salt TEXT NOT NULL,pin_hash TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS guest_sessions (token TEXT PRIMARY KEY,guest_id INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT,guest_id INTEGER,status TEXT NOT NULL DEFAULT 'pending',total_rub INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,accepted_at TEXT,served_at TEXT)",
  "CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,cocktail_id INTEGER NOT NULL,quantity INTEGER NOT NULL,unit_price_rub INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS guest_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT,guest_id INTEGER NOT NULL,order_item_id INTEGER NOT NULL UNIQUE,order_id INTEGER NOT NULL,cocktail_id INTEGER NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
];
const migrateSchema=async env=>{
  try{
    if(await env.DB.prepare("SELECT name FROM app_migrations WHERE name=?").bind(SCHEMA_VERSION).first())return;
  }catch(e){/* app_migrations ещё нет — создадим ниже */}
  let ok=true;
  for(const sql of SCHEMA_SQL){
    // ALTER ... ADD COLUMN падает, если колонка уже есть, — это нормально.
    try{await env.DB.prepare(sql).run()}catch(e){if(!sql.startsWith("ALTER TABLE")){ok=false;console.error("schema:",sql.slice(0,80),e?.message)}}
  }
  if(!ok)throw new Error("schema migration incomplete");
  await env.DB.prepare("INSERT OR IGNORE INTO app_migrations(name) VALUES(?)").bind(SCHEMA_VERSION).run();
};
// Флаг, а не общий промис: в Workers промис, начатый одним запросом, нельзя
// безопасно ждать из другого — если первый запрос оборвётся, второй зависнет.
// Одновременные «холодные» запросы просто проверят отметку каждый сам.
let schemaReady=false;
export const ensureSchema=async env=>{
  if(schemaReady)return;
  try{await migrateSchema(env);schemaReady=true}catch(e){console.error("schema migration failed:",e?.message)}
};

const getOpenBarShift=async env=>{return await env.DB.prepare("SELECT id,status,started_at,closed_at FROM bar_shifts WHERE status='open' ORDER BY id DESC LIMIT 1").first();};
const ensureOpenBarShift=async env=>{let shift=await getOpenBarShift(env);if(shift)return shift;const r=await env.DB.prepare("INSERT INTO bar_shifts(status) VALUES('open')").run();return await env.DB.prepare("SELECT id,status,started_at,closed_at FROM bar_shifts WHERE id=?").bind(Number(r.meta.last_row_id)).first();};
// Сколько ингредиентов зарезервировано черновиками заказов (кроме заказа excludeOrderId).
const RESERVED_SQL="SELECT ri.ingredient_id,COALESCE(SUM(ri.quantity*oi.quantity),0) reserved FROM bar_orders o JOIN bar_order_items oi ON oi.order_id=o.id JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id WHERE o.status='draft' AND o.id<>? GROUP BY ri.ingredient_id";
const OPEN_SHIFT_ID_SQL="SELECT id FROM bar_shifts WHERE status='open' ORDER BY id DESC LIMIT 1";
const DRAFT_ORDER_ID_SQL=`SELECT id FROM bar_orders WHERE shift_id=(${OPEN_SHIFT_ID_SQL}) AND status='draft' ORDER BY id DESC LIMIT 1`;
const getDraftBarOrder=async(env,create=false)=>{
  // Смена, черновик заказа и его позиции — одним обращением к D1.
  const [shiftRes,orderRes,itemsRes]=await env.DB.batch([
    env.DB.prepare("SELECT id,status,started_at,closed_at FROM bar_shifts WHERE status='open' ORDER BY id DESC LIMIT 1"),
    env.DB.prepare(`SELECT id,shift_id,status,created_at,accepted_at,price_total FROM bar_orders WHERE id=(${DRAFT_ORDER_ID_SQL})`),
    env.DB.prepare(`SELECT oi.id,oi.cocktail_id,oi.quantity,oi.price_rub,c.name cocktail_name FROM bar_order_items oi JOIN cocktails c ON c.id=oi.cocktail_id WHERE oi.order_id=(${DRAFT_ORDER_ID_SQL}) ORDER BY oi.id`),
  ]);
  let shift=shiftRes.results?.[0]||null,order=orderRes.results?.[0]||null,items=itemsRes.results||[];
  if(!shift&&create){shift=await ensureOpenBarShift(env);order=null;items=[];}
  if(!shift)return {shift:null,order:null,items:[]};
  if(!order&&create){const r=await env.DB.prepare("INSERT INTO bar_orders(shift_id,status) VALUES(?,'draft')").bind(shift.id).run();order=await env.DB.prepare("SELECT id,shift_id,status,created_at,accepted_at,price_total FROM bar_orders WHERE id=?").bind(Number(r.meta.last_row_id)).first();items=[];}
  if(!order)return {shift,order:null,items:[]};
  return {shift,order,items,total_cocktails:items.reduce((n,x)=>n+Number(x.quantity||0),0),total_price:items.reduce((n,x)=>n+Number(x.quantity||0)*Number(x.price_rub||0),0)};
};
// Списание ингредиентов принятого заказа со склада: по партиям, старые — первыми.
// Ничего не пишет сам — возвращает команды, которые выполняются одной транзакцией
// вместе со сменой статуса заказа (либо всё, либо ничего).
const planBarOrderConsumption=(env,orderId,required,lots)=>{
  const statements=[];
  for(const [ingredientId,{quantity,unit}] of required){
    let left=Number(quantity||0);
    for(const lot of lots){if(left<=0)break;if(Number(lot.ingredient_id)!==ingredientId)continue;const take=Math.min(left,Number(lot.quantity||0));if(take>0){statements.push(env.DB.prepare("UPDATE current_stock_lots SET quantity=quantity-? WHERE id=?").bind(take,lot.id));left-=take;}}
    if(left>0)statements.push(env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,quantity,unit_price,source_type,source_id) VALUES(?,?,?,?,?,'adjustment',?)").bind(ingredientId,"Заказ #"+orderId,"Списание",-left,0,"order-"+orderId+"-"+ingredientId));
    statements.push(env.DB.prepare("INSERT INTO bar_stock_movements(order_id,ingredient_id,quantity,unit) VALUES(?,?,?,?)").bind(orderId,ingredientId,quantity,unit||"ml"));
  }
  return statements;
};
const formatUnitLabelServer=u=>u==="g"?"гр":u==="ml"?"мл":u==="pcs"?"шт.":String(u||"");


const resolveIngredient=async(env,name)=>{
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
html,body,button,a,input,select,textarea,[role="button"]{touch-action:manipulation}body{margin:0;background:#090909;color:#f5f5f5;font:15px system-ui,-apple-system,sans-serif}
header{padding:18px 16px;border-bottom:1px solid #242424;position:sticky;top:0;background:#090909ee;backdrop-filter:blur(10px);z-index:3}
h1{margin:0;font-size:22px}h2{margin:0 0 8px}h3{margin:0 0 6px}.sub{color:#999;margin-top:4px}
.wrap{max-width:980px;margin:auto;padding:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}
.card{border:1px solid #292929;border-radius:18px;padding:18px;background:#111}
.cocktail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:18px;margin-top:4px}
.cocktail-card{overflow:hidden;padding:0;display:flex;flex-direction:column;background:linear-gradient(180deg,#151515 0%,#101010 100%);border-color:#303030;box-shadow:0 12px 30px rgba(0,0,0,.22);transition:filter .2s ease,opacity .2s ease,border-color .2s ease}
.cocktail-card.unavailable{filter:grayscale(1);opacity:.48;border-color:#242424}
.cocktail-card.unavailable .cocktail-photo{filter:grayscale(1)}
.cocktail-card.unavailable .strength-pill{background:#555;color:#ddd}
.cocktail-unavailable{margin-top:10px;padding:7px 10px;border-radius:10px;background:#242424;color:#999;font-size:13px;font-weight:700}
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
.order-controls span{min-width:48px;text-align:center;font-size:20px;font-weight:900;transition:transform .18s ease}
.order-count-pop{transform:scale(1.22)}
.order-controls button{transition:transform .12s ease,opacity .12s ease}
.order-controls button:active{transform:scale(.9)}
label{display:block;color:#aaa;font-size:13px;margin:12px 0 6px}
input,textarea,select{width:100%;padding:12px;border:1px solid #333;border-radius:12px;background:#181818;color:#fff;font:inherit;font-size:16px!important}
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
.avatar-editor{margin-top:16px;padding:14px;border:1px solid rgba(229,185,88,.28);border-radius:16px;background:linear-gradient(145deg,#171512,#0c0b09)}
.avatar-editor h3{color:#fbe29f;font-size:16px}
.avatar-crop-stage{width:min(100%,320px);aspect-ratio:4/5;margin:0 auto;overflow:hidden;border:1px solid rgba(229,185,88,.5);border-radius:14px;background:#050505;touch-action:none}
#avatarCropCanvas{display:block;width:100%;height:100%;object-fit:contain;touch-action:none;cursor:grab}
#avatarCropCanvas:active{cursor:grabbing}
#avatarZoom{accent-color:#e5b958;padding:0}
#avatarPreview img{display:block;width:96px;height:120px;object-fit:cover;border-radius:14px;border:1px solid #c7a04c}
.ingredient-suggestions{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:10;background:#181818;border:1px solid #333;border-radius:12px;max-height:220px;overflow:auto;box-shadow:0 10px 30px #000}
.ingredient-suggestion{padding:12px;border-bottom:1px solid #292929;cursor:pointer}
.ingredient-suggestion:last-child{border-bottom:0}
.ingredient-suggestion:hover{background:#252525}
.ingredient-suggestion .muted{font-size:12px}
@media(max-width:600px){.recipe-row{grid-template-columns:1fr 90px 58px}}
/* Compact recipe toolbar and live search */
.recipe-toolbar{display:flex;align-items:center;gap:10px;margin:0 0 14px}
.recipe-toolbar>*{min-height:44px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
.recipe-toolbar .recipe-home-link{padding:10px 14px;border:1px solid rgba(214,177,99,.2);border-radius:13px;background:#171613;color:#e5b958;text-decoration:none}
.recipe-toolbar #newCocktailBtn{flex:1}
.recipe-catalog-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.recipe-catalog-head h2{margin:0}
.recipe-search-wrap{display:flex;align-items:center;gap:9px;padding:0 12px;margin:0 0 8px;border:1px solid rgba(214,177,99,.27);border-radius:13px;background:#10100e;min-height:48px;color:#d9b65e}
.recipe-search-wrap>span{font-size:25px;line-height:1}
.recipe-search-wrap input{border:0!important;outline:none!important;box-shadow:none!important;background:transparent!important;min-width:0;flex:1;padding:10px 0;margin:0;color:#f5f0e5}
.recipe-search-wrap input::-webkit-search-cancel-button{display:none}
.recipe-search-wrap button{padding:0;min-width:28px;width:28px;height:28px;border-radius:50%;background:#282319;color:#f4e5c4;font-size:20px;box-shadow:none}
.recipe-search-wrap button[hidden]{display:none}
.recipe-search-status{font-size:12px;min-height:18px;margin:0 0 8px}
@media(max-width:600px){.recipe-toolbar{gap:8px}.recipe-toolbar .recipe-home-link{padding:9px 10px;font-size:13px}.recipe-toolbar #newCocktailBtn{padding:10px 9px;font-size:13px}.recipe-catalog{padding:12px}.recipe-catalog-head{margin-bottom:10px}}
/* Compact expandable recipe cards */
.cocktail-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:10px}
.cocktail-card.recipe-compact{padding:0;overflow:hidden}
.recipe-card-summary{display:flex;align-items:center;gap:12px;padding:12px}
.recipe-thumb{width:66px;height:66px;flex:0 0 66px;object-fit:cover;border-radius:12px;border:1px solid rgba(214,177,99,.28);background:#17140e}
.recipe-thumb-placeholder{display:flex;align-items:center;justify-content:center;font-size:26px}
.recipe-summary-main{flex:1;min-width:0}
.recipe-summary-main h3{font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.25;letter-spacing:0;overflow-wrap:anywhere;margin:0 0 4px}
.recipe-summary-main .cocktail-price{font-size:16px;margin:2px 0 5px}
.recipe-summary-main .pill{font-size:11px;padding:3px 7px}
.recipe-summary-actions{display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto}
.recipe-summary-actions .cocktail-actions{gap:5px}
.recipe-summary-actions .cocktail-actions button{width:32px;height:32px;font-size:14px;border-radius:9px}
.recipe-expand{width:32px;height:28px;min-width:32px;padding:0;font-size:21px;line-height:1;border-radius:9px}
.recipe-expand[aria-expanded="true"]{transform:rotate(180deg)}
.recipe-card-details{padding:0 12px 14px;border-top:1px solid rgba(214,177,99,.16)}
.recipe-card-details[hidden]{display:none}
.recipe-card-details .cocktail-photo-wrap{margin-top:12px;border-radius:12px;overflow:hidden}
.recipe-card-details .cocktail-photo{aspect-ratio:16/9}
.recipe-card-details .cocktail-description{line-height:1.45;margin-top:12px}
.recipe-card-details .cocktail-section{margin-top:12px;padding-top:10px}
.recipe-stock-warning{font-size:11px;color:#e7b56b;margin-top:4px}
.cocktail-card.unavailable{opacity:1;filter:none}
.cocktail-card.unavailable .recipe-thumb{filter:grayscale(.8)}
@media(max-width:600px){.cocktail-grid{grid-template-columns:1fr;gap:9px}.recipe-card-summary{padding:10px;gap:10px}.recipe-thumb{width:58px;height:58px;flex-basis:58px}.recipe-summary-main h3{font-size:15px}.recipe-summary-actions .cocktail-actions button{width:30px;height:30px}.recipe-card-details{padding:0 10px 12px}}
/* VIA BAR premium black-and-gold styling for the bartender workspace */
:root{color-scheme:dark;--via-gold:#e5b958;--via-gold-light:#fbe29f;--via-gold-border:rgba(214,177,99,.28)}
body{background:radial-gradient(ellipse at 50% -18%,rgba(157,119,43,.11),transparent 44%),#090908;color:#f3eee3}
header{background:rgba(9,9,8,.94);border-bottom:1px solid var(--via-gold-border);box-shadow:0 8px 24px rgba(0,0,0,.14)}
h1,h2{color:#f5e8c8;font-family:'Cinzel',Georgia,serif;letter-spacing:.1px}
h3{color:#eee4cf}
.sub,.muted{color:#aaa69c}
.wrap>.row a,.wrap>a.card{transition:border-color .18s ease,background .18s ease,transform .18s ease}
.card{background:linear-gradient(150deg,rgba(24,22,17,.98),rgba(13,13,11,.98));border-color:rgba(214,177,99,.22);box-shadow:0 8px 26px rgba(0,0,0,.17)}
a.card{display:block;color:inherit}
a.card:hover,.wrap>.row a:hover{border-color:rgba(229,185,88,.6)!important;background-color:#1c1912;transform:translateY(-1px)}
button{background:linear-gradient(135deg,#f0cc76,#c9953c);color:#17120a;box-shadow:0 4px 14px rgba(200,157,64,.08)}
button:hover{filter:brightness(1.06)}
button.secondary,.cocktail-actions .secondary,.order-controls button.secondary{background:#242018;color:#f5e8c8;border:1px solid rgba(214,177,99,.15);box-shadow:none}
a{color:var(--via-gold)}
input,textarea,select{background:#11110f;border-color:#393329;color:#f5f0e5}
input:focus,textarea:focus,select:focus{outline:1px solid rgba(229,185,88,.62);border-color:#b99348}
label,.cocktail-section-title{color:#bdb5a4}
.pill,.cocktail-meta .pill{background:#252117;color:#d8cba9;border:1px solid rgba(214,177,99,.12)}
.cocktail-meta .strength-pill{background:linear-gradient(135deg,#f0cc76,#c9953c);color:#17120a}
.cocktail-card{background:linear-gradient(155deg,#1a1711,#0d0d0b);border-color:rgba(214,177,99,.27)}
.cocktail-section,.order-controls,.recipe-row{border-color:rgba(214,177,99,.17)}
.cocktail-info{background:#191710;color:#c7c0b2}
.cocktail-info b,.recipe-qty{color:#f3e6c6}
.cocktail-actions button:not(.secondary),.order-controls button:not(.secondary){box-shadow:0 5px 18px rgba(200,157,64,.12)}
.ingredient-suggestions{background:#15130f;border-color:rgba(214,177,99,.28)}
.ingredient-suggestion{border-color:rgba(214,177,99,.13)}
.ingredient-suggestion:hover{background:#242018}
.empty{color:#b4ad9f}
@media(max-width:600px){.card{padding:14px}.grid{gap:11px}}
</style>
</head><body>${body}</body></html>`, {headers:{"content-type":"text/html;charset=UTF-8","cache-control":"no-store"}});

const refreshCocktailPrice = async (env, cocktailId) => {
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

const BUILD_VERSION = "2026-10-15-fast-db-v1";

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
  const {results} = await env.DB.prepare(
    "SELECT ri.quantity,i.unit,i.strength_percent FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.cocktail_id=?"
  ).bind(cocktailId).all();
  const calculated = calculateCocktailStrength(results);
  await env.DB.prepare("UPDATE cocktails SET strength=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(calculated.strength,cocktailId).run();
  return calculated;
};

const getCocktails = async (env, includeStock = true) => {
  // Коктейли, рецепты и остатки читаются параллельно, а не по очереди.
  const [[cocktailRows,recipeRows],stockRows]=await Promise.all([
    env.DB.batch([
      env.DB.prepare("SELECT id,name,description,category,strength,price_rub,photo_url,avatar_url,glass,ice,method,garnish,is_active,created_at,updated_at FROM cocktails WHERE is_active=1 ORDER BY name"),
      env.DB.prepare("SELECT ri.cocktail_id,ri.ingredient_id,ri.quantity,i.name ingredient_name,i.unit,i.strength_percent FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id ORDER BY ri.cocktail_id,ri.id"),
    ]),
    includeStock?getProducts(env,false):null,
  ]);
  const results=cocktailRows.results||[];
  if(!results.length)return results;
  const recipesByCocktail=new Map();
  for(const item of (recipeRows.results||[])){
    const id=Number(item.cocktail_id);
    if(!recipesByCocktail.has(id))recipesByCocktail.set(id,[]);
    const {cocktail_id,...recipeItem}=item;
    recipesByCocktail.get(id).push(recipeItem);
  }
  let stockMap=new Map();
  if(includeStock){
    stockMap=new Map((stockRows||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)]));
  }
  for(const c of results){
    for(const field of ["photo_url","avatar_url"]){
      if(!c[field])continue;
      try{
        const u=new URL(c[field],"https://bar-menu.invalid");
        const key=u.searchParams.get("key") || (u.pathname.startsWith("/api/cocktail-photo/") ? decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length)) : "");
        if(key && key.startsWith("cocktails/"))c[field]="/api/cocktail-photo?key="+encodeURIComponent(key);
      }catch(e){}
    }
    c.recipe_items=recipesByCocktail.get(Number(c.id))||[];
    if(includeStock)c.recipe_items=c.recipe_items.map(i=>({...i,stock_available:Number(stockMap.get(Number(i.ingredient_id))||0)}));
  }
  return results;
};

// excludeOrderId: не вычитать резерв этого черновика (нужно при принятии заказа,
// иначе его ингредиенты учитываются дважды — как резерв и как требуемое количество).
const getProducts = async (env, includeDetails = true, excludeOrderId = 0) => {
  const statements=[
    env.DB.prepare(`SELECT i.id ingredient_id,i.name ingredient_name,i.unit,
    COALESCE((SELECT SUM(cs.quantity) FROM current_stock_lots cs WHERE cs.ingredient_id=i.id),0) stock,
    COALESCE((SELECT SUM(cs.quantity*cs.unit_price) FROM current_stock_lots cs WHERE cs.ingredient_id=i.id),0) stock_value
    FROM ingredients i WHERE i.is_active=1 ORDER BY i.name`),
    env.DB.prepare(RESERVED_SQL).bind(Number(excludeOrderId)||0),
  ];
  if(includeDetails)statements.push(env.DB.prepare(`SELECT ingredient_id,COALESCE(NULLIF(brand,''),'Без бренда') brand,COALESCE(NULLIF(store,''),'') store,
      SUM(quantity) stock,SUM(quantity*unit_price) stock_value,
      CASE WHEN SUM(CASE WHEN source_type='purchase' THEN 1 ELSE 0 END)>0 THEN 'purchase' ELSE 'manual' END source_type
      FROM current_stock_lots GROUP BY ingredient_id,brand,store HAVING SUM(quantity)>0 ORDER BY ingredient_id,brand,store`));
  // Все чтения склада — одним обращением к D1.
  const [stockRes,reservedRes,rows]=await env.DB.batch(statements);
  const results=stockRes.results||[];
  const reservedMap=new Map((reservedRes.results||[]).map(x=>[Number(x.ingredient_id),Number(x.reserved||0)]));
  if(includeDetails){
    const byIngredient=new Map();
    for(const row of rows.results||[]){
      const id=Number(row.ingredient_id),stock=Number(row.stock||0),value=Number(row.stock_value||0);
      if(stock<=0)continue;
      if(!byIngredient.has(id))byIngredient.set(id,[]);
      byIngredient.get(id).push({brand:row.brand,store:row.store,stock,stock_value:value,unit_price:value/stock,source_type:row.source_type});
    }
    for(const x of results)x.details=byIngredient.get(Number(x.ingredient_id))||[];
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
        // Ключ фото — случайный UUID, содержимое по нему никогда не меняется,
        // поэтому браузер может хранить фото у себя хоть год.
        headers.set("cache-control","public, max-age=31536000, immutable");
        if(!headers.get("content-type")){const ext=key.split(".").pop().toLowerCase();const ct={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif"}[ext];if(ct)headers.set("content-type",ct);}
        headers.set("x-content-type-options","nosniff");
        return new Response(object.body,{headers});
      }

      if (url.pathname === "/api/cocktails" && request.method === "GET") {
        return json(await getCocktails(env, url.searchParams.get("include_stock") !== "0"));
      }

      if (url.pathname === "/api/cocktails" && request.method === "PUT") {
        const data=await request.json();
        const id=Number(data.id);
        const name=String(data.name||"").trim();
        const strength=String(data.strength||"Лёгкий").trim();
        const allowedStrengths=["Безалкогольный","Лёгкий","Средний","Крепкий"];
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректный коктейль"},400);
        if(!name)return json({error:"Название коктейля обязательно"},400);
        if(!allowedStrengths.includes(strength))return json({error:"Выберите крепость коктейля"},400);
        const existing=await env.DB.prepare("SELECT id,photo_url,avatar_url FROM cocktails WHERE id=?").bind(id).first();
        if(!existing)return json({error:"Коктейль не найден"},404);
        const nextPhotoUrl=String(data.photo_url||""),nextAvatarUrl=String(data.avatar_url??existing.avatar_url??"");
        await env.DB.prepare("UPDATE cocktails SET name=?,description=?,category=?,strength=?,photo_url=?,avatar_url=?,glass=?,ice=?,method=?,garnish=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(name,String(data.description||""),"",strength,nextPhotoUrl,nextAvatarUrl,String(data.inventory??data.glass??""),"",String(data.method||""),"",id).run();
        if(env.PHOTOS){
          for(const oldUrl of [existing.photo_url,existing.avatar_url]){
            if(!oldUrl||oldUrl===nextPhotoUrl||oldUrl===nextAvatarUrl)continue;
            try{const u=new URL(oldUrl,"https://bar-menu.invalid"),key=u.searchParams.get("key")||(u.pathname.startsWith("/api/cocktail-photo/")?decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length)):"");if(key&&key.startsWith("cocktails/"))await env.PHOTOS.delete(key)}catch(e){}
          }
        }
        await env.DB.prepare("DELETE FROM recipe_ingredients WHERE cocktail_id=?").bind(id).run();
        for(const item of (Array.isArray(data.recipe_items)?data.recipe_items:[])){
          const iid=Number(item.ingredient_id), q=Number(item.quantity);
          if(Number.isInteger(iid)&&iid>0&&q>0)await env.DB.prepare("INSERT INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) VALUES(?,?,?)").bind(id,iid,q).run();
        }
        const pricing=await refreshCocktailPrice(env,id);
        return json({ok:true,id,pricing,strength});
      }

      if (url.pathname === "/api/cocktails" && request.method === "DELETE") {
        const data=await request.json();
        const id=Number(data.id);
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректный коктейль"},400);

        const cocktail=await env.DB.prepare("SELECT id,name,photo_url,avatar_url FROM cocktails WHERE id=?").bind(id).first();
        if(!cocktail)return json({error:"Коктейль не найден"},404);

        // Remove both the original photo and its independently stored square avatar.
        let photoDeleted=true;
        let photoKey="";
        if(env.PHOTOS){
          for(const value of [cocktail.photo_url,cocktail.avatar_url]){
            if(!value)continue;
            try{
              const u=new URL(value,"https://bar-menu.invalid");
              const key=u.searchParams.get("key") || (u.pathname.startsWith("/api/cocktail-photo/") ? decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length)) : "");
              if(key && key.startsWith("cocktails/")){if(!photoKey)photoKey=key;await env.PHOTOS.delete(key);}
            }catch(e){photoDeleted=false;}
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
        const data=await request.json(), name=String(data.name||"").trim(), strength=String(data.strength||"Лёгкий").trim();
        const allowedStrengths=["Безалкогольный","Лёгкий","Средний","Крепкий"];
        if(!name)return json({error:"Название коктейля обязательно"},400);
        if(!allowedStrengths.includes(strength))return json({error:"Выберите крепость коктейля"},400);
        const r=await env.DB.prepare(`INSERT INTO cocktails(name,description,category,strength,price_rub,photo_url,avatar_url,glass,ice,method,garnish) VALUES(?,?,?,?,0,?,?,?,?,?,?)`).bind(name,String(data.description||""),String(data.category||""),strength,String(data.photo_url||""),String(data.avatar_url||""),String(data.inventory??data.glass??""),"",String(data.method||""),String(data.garnish||"")).run();
        const id=r.meta.last_row_id;
        for(const item of (Array.isArray(data.recipe_items)?data.recipe_items:[])){let iid=Number(item.ingredient_id);if(!Number.isInteger(iid)&&item.name)iid=await resolveIngredient(env,item.name);const q=Number(item.quantity);if(Number.isInteger(iid)&&q>0)await env.DB.prepare("INSERT OR REPLACE INTO recipe_ingredients(cocktail_id,ingredient_id,quantity) VALUES(?,?,?)").bind(id,iid,q).run();}
        const pricing=await refreshCocktailPrice(env,id);
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
        const payload=await request.json().catch(()=>({}));
        const clientItems=Array.isArray(payload.items)?payload.items:null;
        let shift=await getOpenBarShift(env);if(!shift)shift=await ensureOpenBarShift(env);
        let order=await env.DB.prepare("SELECT id,shift_id,status,created_at,accepted_at,price_total FROM bar_orders WHERE shift_id=? AND status='draft' ORDER BY id DESC LIMIT 1").bind(shift.id).first();
        if(!order){
          const r=await env.DB.prepare("INSERT INTO bar_orders(shift_id,status) VALUES(?,'draft')").bind(shift.id).run();
          order=await env.DB.prepare("SELECT id,shift_id,status,created_at,accepted_at,price_total FROM bar_orders WHERE id=?").bind(Number(r.meta.last_row_id)).first();
        }
        if(clientItems){
          const wanted=[];
          for(const raw of clientItems){
            const cocktailId=Number(raw.cocktail_id),quantity=Math.floor(Number(raw.quantity||0));
            if(!Number.isInteger(cocktailId)||cocktailId<1||quantity<=0)continue;
            wanted.push({cocktailId,quantity});
          }
          const prices=new Map();
          if(wanted.length){
            const ids=[...new Set(wanted.map(x=>x.cocktailId))];
            const {results}=await env.DB.prepare(`SELECT id,price_rub FROM cocktails WHERE id IN (${ids.map(()=>"?").join(",")})`).bind(...ids).all();
            for(const c of results||[])prices.set(Number(c.id),Number(c.price_rub||0));
          }
          if(wanted.some(x=>!prices.has(x.cocktailId)))return json({error:"Коктейль не найден"},400);
          await env.DB.batch([
            env.DB.prepare("DELETE FROM bar_order_items WHERE order_id=?").bind(order.id),
            ...wanted.map(x=>env.DB.prepare("INSERT INTO bar_order_items(order_id,cocktail_id,quantity,price_rub) VALUES(?,?,?,?)").bind(order.id,x.cocktailId,x.quantity,prices.get(x.cocktailId))),
          ]);
        }
        const draft=await getDraftBarOrder(env,false);
        if(!draft.order||!(draft.items||[]).length)return json({error:"В заказе пока ничего нет"},400);
        // Состав заказа, партии склада и доступные остатки читаются параллельно.
        const [[recipeRes,lotsRes],effective]=await Promise.all([
          env.DB.batch([
            env.DB.prepare("SELECT oi.quantity item_qty,ri.ingredient_id,ri.quantity,i.name,i.unit FROM bar_order_items oi JOIN cocktails c ON c.id=oi.cocktail_id JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id LEFT JOIN ingredients i ON i.id=ri.ingredient_id WHERE oi.order_id=? ORDER BY oi.id,ri.ingredient_id").bind(draft.order.id),
            env.DB.prepare("SELECT id,ingredient_id,quantity FROM current_stock_lots WHERE quantity>0 AND ingredient_id IN (SELECT ri.ingredient_id FROM bar_order_items oi JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id WHERE oi.order_id=?) ORDER BY created_at ASC,id ASC").bind(draft.order.id),
          ]),
          getProducts(env,false,order.id),
        ]);
        const required=new Map();
        for(const row of recipeRes.results||[]){const id=Number(row.ingredient_id);const cur=required.get(id)||{quantity:0,name:row.name,unit:row.unit};cur.quantity=Number(cur.quantity||0)+Number(row.quantity||0)*Number(row.item_qty||0);required.set(id,cur);}
        const effectiveMap=new Map((effective||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)])),shortages=[];
        for(const [id,{quantity:qty,name,unit}] of required){const available=Number(effectiveMap.get(id)||0);if(available+0.000001<qty)shortages.push((name||("Ингредиент #"+id))+" — доступно "+Number(available).toLocaleString("ru-RU")+" "+formatUnitLabelServer(unit)+", нужно "+Number(qty).toLocaleString("ru-RU")+" "+formatUnitLabelServer(unit));}
        if(shortages.length)return json({error:"Недостаточно ингредиентов для принятия заказа: "+shortages.join(", ")},409);
        const totalPrice=Number(draft.total_price||0);
        await env.DB.batch([
          ...planBarOrderConsumption(env,order.id,required,lotsRes.results||[]),
          env.DB.prepare("UPDATE bar_orders SET status='accepted',accepted_at=CURRENT_TIMESTAMP,price_total=? WHERE id=?").bind(totalPrice,order.id),
        ]);
        return json({ok:true,order_id:order.id,total_cocktails:draft.total_cocktails,total_price:totalPrice});
      }
      if (url.pathname === "/api/bar/statistics" && request.method === "GET") {
        const {results}=await env.DB.prepare("SELECT s.id,s.status,s.started_at,s.closed_at,COUNT(DISTINCT CASE WHEN o.status='accepted' THEN o.id END)+(SELECT COUNT(*) FROM orders go WHERE go.status IN ('accepted','served') AND go.created_at>=s.started_at AND (s.closed_at IS NULL OR go.created_at<=s.closed_at)) orders_count,COALESCE(SUM(CASE WHEN o.status='accepted' THEN oi.quantity ELSE 0 END),0)+(SELECT COALESCE(SUM(gi.quantity),0) FROM orders go JOIN order_items gi ON gi.order_id=go.id WHERE go.status IN ('accepted','served') AND go.created_at>=s.started_at AND (s.closed_at IS NULL OR go.created_at<=s.closed_at)) cocktails_count,COALESCE(SUM(CASE WHEN o.status='accepted' THEN oi.quantity*oi.price_rub ELSE 0 END),0)+(SELECT COALESCE(SUM(go.total_rub),0) FROM orders go WHERE go.status IN ('accepted','served') AND go.created_at>=s.started_at AND (s.closed_at IS NULL OR go.created_at<=s.closed_at)) revenue_rub FROM bar_shifts s LEFT JOIN bar_orders o ON o.shift_id=s.id LEFT JOIN bar_order_items oi ON oi.order_id=o.id GROUP BY s.id ORDER BY s.id DESC LIMIT 100").all();return json({shifts:results||[]});
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return json(await getProducts(env));
      }

      if (url.pathname === "/api/products" && request.method === "PUT") {
        const data=await request.json();
        if(data.source_edit){
          const ingredientId=Number(data.ingredient_id);
          const oldBrand=String(data.old_brand||"").trim();
          const oldStore=String(data.old_store||"").trim();
          const brand=String(data.brand||"").trim();
          const quantity=Number(data.quantity), unitPrice=Number(data.unit_price);
          if(!Number.isInteger(ingredientId)||ingredientId<1||!oldBrand||!brand||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0)return json({error:"Некорректные данные товара"},400);
          await env.DB.prepare("UPDATE current_stock_lots SET quantity=0 WHERE ingredient_id=? AND COALESCE(brand,'')=? AND COALESCE(store,'')=?").bind(ingredientId,oldBrand,oldStore).run();
          await env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,quantity,unit_price,source_type,source_id) VALUES(?,?,?,?,?,'manual',?)").bind(ingredientId,brand,"Ручной ввод",quantity,unitPrice,"edit-"+crypto.randomUUID()).run();
          return json({ok:true});
        }

        const ingredientId=Number(data.ingredient_id), target=Number(data.stock);
        if(!Number.isInteger(ingredientId)||ingredientId<1||!Number.isFinite(target)||target<0)return json({error:"Некорректный остаток"},400);
        const items=await getProducts(env); const item=items.find(x=>Number(x.ingredient_id)===ingredientId);
        if(!item)return json({error:"Ингредиент не найден на складе"},404);
        let delta=target-Number(item.stock); if(Math.abs(delta)<0.000001)return json({ok:true});
        if(delta>0){
          await env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,quantity,unit_price,source_type,source_id) VALUES(?,?,?,?,?,'manual',?)").bind(ingredientId,"Ручная корректировка","Ручной ввод",delta,Number(item.unit_price||0),"adjust-"+crypto.randomUUID()).run();
        }else{
          let left=-delta;
          const lots=await env.DB.prepare("SELECT id,quantity FROM current_stock_lots WHERE ingredient_id=? AND quantity>0 ORDER BY created_at DESC,id DESC").bind(ingredientId).all();
          for(const lot of lots.results||[]){if(left<=0)break;const take=Math.min(left,Number(lot.quantity||0));if(take>0){await env.DB.prepare("UPDATE current_stock_lots SET quantity=quantity-? WHERE id=?").bind(take,lot.id).run();left-=take;}}
        }
        return json({ok:true,stock:target});
      }

      if (url.pathname === "/api/products" && request.method === "DELETE") {
        const data=await request.json();
        const ingredientId=Number(data.ingredient_id);
        const brand=String(data.brand||"").trim();
        const store=String(data.store||"").trim();
        if(!Number.isInteger(ingredientId)||ingredientId<1||!brand)return json({error:"Не указан товар"},400);
        const r=await env.DB.prepare("UPDATE current_stock_lots SET quantity=0 WHERE ingredient_id=? AND COALESCE(brand,'')=? AND COALESCE(store,'')=? AND quantity<>0").bind(ingredientId,brand,store).run();
        return json({ok:true,deleted:Number(r.meta.changes||0)});
      }

      if (url.pathname === "/api/products" && request.method === "POST") {
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
          await env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,quantity,unit_price,source_type,source_id) VALUES(?,?,?,?,?,'manual',?)")
            .bind(ingredientId,brand,"Ручной ввод",quantity,unitPrice,"manual-"+crypto.randomUUID()).run();
        }

        return json({ok:true,id:productId,unit_price:unitPrice,price_rub:bottlePrice},201);
      }

      if (url.pathname === "/api/shop/purchases" && request.method === "GET") {
        const from=url.searchParams.get("date_from")||"";
        const to=url.searchParams.get("date_to")||"";
        const ingredientId=Number(url.searchParams.get("ingredient_id")||0);
        let sql=`SELECT pb.id,pb.purchased_qty,pb.remaining_qty,pb.price_rub,substr(pb.purchased_at,1,10) purchased_at,
                  p.ingredient_id,COALESCE(i.name,p.name) ingredient_name,COALESCE(i.unit,p.unit) unit,p.brand,p.store
           FROM purchase_batches pb JOIN products p ON p.id=pb.product_id
           LEFT JOIN ingredients i ON i.id=p.ingredient_id WHERE COALESCE(pb.receipt_deleted,0)=0`;
        const binds=[];
        if(/^\d{4}-\d{2}-\d{2}$/.test(from)){sql+=" AND pb.purchased_at >= ?";binds.push(from+" 00:00:00")}
        if(/^\d{4}-\d{2}-\d{2}$/.test(to)){sql+=" AND pb.purchased_at < datetime(?, '+1 day')";binds.push(to+" 00:00:00")}
        if(Number.isInteger(ingredientId)&&ingredientId>0){sql+=" AND p.ingredient_id=?";binds.push(ingredientId)}
        sql+=" ORDER BY pb.purchased_at DESC,pb.id DESC LIMIT 500";
        const {results}=await env.DB.prepare(sql).bind(...binds).all();
        return json(results);
      }
      if (url.pathname === "/api/shop/purchase" && request.method === "PUT") {
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
        const batch=await env.DB.prepare("SELECT id,purchased_qty,remaining_qty,product_id FROM purchase_batches WHERE id=? AND COALESCE(receipt_deleted,0)=0").bind(id).first();
        if(!batch)return json({error:"Запись о покупке не найдена"},404);
        const ing=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE id=? AND is_active=1").bind(ingredientId).first();
        if(!ing)return json({error:"Ингредиент не найден"},404);
        let product=await env.DB.prepare("SELECT id FROM products WHERE ingredient_id=? AND brand=? AND store=? AND is_active=1 LIMIT 1").bind(ingredientId,brand,store).first();
        let productId;
        if(product){productId=Number(product.id)}
        else{
          const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id,store) VALUES(?,?,?,?,0,?,?)").bind(ing.name,brand,"",ing.unit,ingredientId,store).run();
          productId=Number(pr.meta.last_row_id);
        }
        await env.DB.prepare("UPDATE purchase_batches SET product_id=?,purchased_qty=?,remaining_qty=?,price_rub=?,purchased_at=? WHERE id=?").bind(productId,qty,qty,price,purchaseDate+" 00:00:00",id).run();
        return json({ok:true});
      }

      if (url.pathname === "/api/shop/purchase" && request.method === "DELETE") {
        const id=Number(url.searchParams.get("id"));
        if(!Number.isInteger(id)||id<1)return json({error:"Некорректная закупка"},400);
        const batch=await env.DB.prepare("SELECT id FROM purchase_batches WHERE id=? AND COALESCE(receipt_deleted,0)=0").bind(id).first();
        if(!batch)return json({error:"Запись о покупке не найдена"},404);
        await env.DB.prepare("UPDATE purchase_batches SET receipt_deleted=1 WHERE id=?").bind(id).run();
        return json({ok:true});
      }

      if (url.pathname === "/api/shop/purchase" && request.method === "POST") {
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
        // Новая закупка задаёт актуальную цену ингредиента для текущего склада;
        // запись в магазине остаётся отдельным историческим чеком.
        // Чек и партия на складе пишутся одной транзакцией: либо оба, либо ничего.
        const [,batch]=await env.DB.batch([
          env.DB.prepare("UPDATE current_stock_lots SET unit_price=? WHERE ingredient_id=? AND quantity>0").bind(price/qty,ingredientId),
          env.DB.prepare("INSERT INTO purchase_batches(product_id,purchased_qty,remaining_qty,price_rub,purchased_at) VALUES(?,?,?,?,?)").bind(productId,qty,qty,price,purchaseDate+" 00:00:00"),
          env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,quantity,unit_price,source_type,source_id,created_at) VALUES(?,?,?,?,?,'purchase',CAST(last_insert_rowid() AS TEXT),?)").bind(ingredientId,brand,store,qty,price/qty,purchaseDate+" 00:00:00"),
        ]);
        const batchId=Number(batch.meta.last_row_id);
        return json({ok:true,id:batchId,product_id:productId},201);
      }

      if (url.pathname === "/api/ingredients" && request.method === "GET") {
        const {results}=await env.DB.prepare("SELECT id,name,unit,strength_percent FROM ingredients WHERE is_active=1 ORDER BY name").all();
        return json(results);
      }
      if (url.pathname === "/api/ingredients" && request.method === "POST") {
        const data=await request.json(), name=String(data.name||"").trim(), unit=String(data.unit||"ml"), strength=Number(data.strength_percent||0);
        if(!name||!["ml","g","pcs"].includes(unit)||!Number.isFinite(strength)||strength<0||strength>100) return json({error:"Укажите название, единицу и крепость от 0 до 100%"},400);
        const existing=await env.DB.prepare("SELECT id FROM ingredients WHERE is_active=1 AND lower(trim(name))=lower(trim(?)) AND unit=? LIMIT 1").bind(name,unit).first();
        if(existing)return json({ok:true,id:Number(existing.id),exists:true});
        const r=await env.DB.prepare("INSERT INTO ingredients(name,unit,strength_percent) VALUES(?,?,?)").bind(name,unit,strength).run();
        return json({ok:true,id:r.meta.last_row_id},201);
      }
      if (url.pathname === "/api/ingredients" && request.method === "PUT") {
        const data=await request.json(), id=Number(data.id), name=String(data.name||"").trim(), unit=String(data.unit||"ml"), strength=Number(data.strength_percent||0);
        if(!id||!name||!["ml","g","pcs"].includes(unit)||!Number.isFinite(strength)||strength<0||strength>100) return json({error:"Некорректные данные: крепость должна быть от 0 до 100%"},400);
        await env.DB.prepare("UPDATE ingredients SET name=?,unit=?,strength_percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(name,unit,strength,id).run();
        return json({ok:true});
      }
      if (url.pathname === "/api/ingredients" && request.method === "DELETE") {
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

      if (url.pathname === "/") return htmlResponse(renderDocument({
        title:"VIA Bar", navbar:false,
        docTitle:"VIA Bar — семейный бар",
        extraCss:".landing{min-height:calc(100dvh - 140px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px}.landing .monogram{filter:drop-shadow(0 12px 30px rgba(214,168,78,.18));margin-bottom:6px}.landing h2{font-family:var(--serif);font-weight:400;font-size:2.6rem;margin:6px 0 0;letter-spacing:.04em}.landing .tagline{color:var(--label-2);margin:0 0 26px}.landing .tracker{width:min(100%,320px);margin:0 auto 30px}.landing .button-row{width:min(100%,360px);flex-direction:column}.large-title{display:none}",
        body:`<section class="landing">${monogram(132,"lm")}<h2>VIA Bar</h2><p class="tagline">Семейный бар у нас дома</p>
<div class="tracker" aria-label="VIA — от имён Владимир и Анастасия"><div class="tracker-stop done"><span class="station"></span>Владимир</div><div class="tracker-stop done"><span class="station"></span>VIA</div><div class="tracker-stop done"><span class="station"></span>Анастасия</div></div>
<div class="button-row"><a class="btn btn-primary btn-block" href="/menu">${icon("glass")}Открыть меню</a><a class="btn btn-tinted btn-block" href="/bar/orders">${icon("bell")}Я за стойкой</a></div></section>`,
      }));

      if (url.pathname === "/bar") return htmlResponse(renderDocument({
        title:"Ещё", app:"bar", tab:"more", docTitle:"Ещё · VIA Бар",
        body:`<div class="section"><div class="section-header"><h2>Бар</h2></div><div class="list">
<a class="cell has-icon" href="/bar/ingredients"><span class="cell-icon">${icon("leaf")}</span><span class="cell-body"><span class="cell-title">Ингредиенты</span><span class="cell-sub">Справочник для рецептов и склада</span></span>${icon("chevronRight","cell-chevron")}</a>
<a class="cell has-icon" href="/bar/statistics"><span class="cell-icon">${icon("chart")}</span><span class="cell-body"><span class="cell-title">Статистика</span><span class="cell-sub">Смены, заказы и выручка</span></span>${icon("chevronRight","cell-chevron")}</a>
</div></div>
<div class="section"><div class="section-header"><h2>Для гостей</h2></div><div class="list">
<a class="cell has-icon" href="/menu"><span class="cell-icon">${icon("glass")}</span><span class="cell-body"><span class="cell-title">Гостевое меню</span><span class="cell-sub">Так видят бар гости</span></span>${icon("chevronRight","cell-chevron")}</a>
<a class="cell has-icon" href="/"><span class="cell-icon">${icon("home")}</span><span class="cell-body"><span class="cell-title">Главная</span></span>${icon("chevronRight","cell-chevron")}</a>
</div></div>`,
      }));

      if (url.pathname === "/bar/recipes") return page(`
<header><h1>🍸 Книга рецептов</h1><div class="sub">Рецепт здесь — источник для гостевой «Карты бара»</div></header>
<div class="wrap">
  <div class="recipe-toolbar">
    <a href="/" class="recipe-home-link">⌂ Главное меню</a>
    <button type="button" id="newCocktailBtn">＋ Создать коктейль</button>
  </div>

  <div class="card recipe-form-panel" id="cocktailPanel" hidden>
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 id="formTitle">Новый коктейль</h2></div>
    <form id="cocktailForm">
      <label>Название *</label><input name="name" required placeholder="Например, Negroni">
      <label>Описание для гостя</label><textarea name="description" placeholder="Короткое описание вкуса"></textarea>
      <label>Крепость коктейля</label>
      <select name="strength" required>
        <option value="Безалкогольный">Безалкогольный</option>
        <option value="Лёгкий" selected>Лёгкий</option>
        <option value="Средний">Средний</option>
        <option value="Крепкий">Крепкий</option>
      </select>
      <p class="muted" style="font-size:12px;margin-top:4px">Указывай крепость вручную — она будет отображаться в гостевой карте бара.</p>
      <label>Инвентарь</label>
      <textarea name="inventory" rows="2" placeholder="Джигер
Барная ложка"></textarea>
      <label>Способ приготовления</label><textarea name="method" placeholder="Например: собрать в бокале, перемешать барной ложкой"></textarea>
      <label>Основное фото коктейля</label>
      <input id="photoFile" type="file" accept="image/*" style="padding:10px">
      <p class="muted" style="margin:6px 0 0;font-size:12px">Оригинал сохраняется целиком для книги рецептов. Для карты бара и личного кабинета ниже настраивается отдельный вертикальный кадр 4:5.</p>
      <div id="photoPreview" style="margin-top:10px"></div>
      <input name="photo_url" id="photoUrl" type="hidden">
      <input name="avatar_url" id="avatarUrl" type="hidden">
      <section id="avatarCropPanel" class="avatar-editor" hidden>
        <h3>Вертикальное фото 4:5 для карты бара и ЛК</h3>
        <p class="muted" style="font-size:13px;margin:6px 0 12px">Перемещай фотографию пальцем и настрой масштаб. Оригинал при этом не обрезается.</p>
        <div class="avatar-crop-stage"><canvas id="avatarCropCanvas" width="320" height="400" aria-label="Предпросмотр кадрирования коктейля 4:5"></canvas></div>
        <label for="avatarZoom">Масштаб кадра</label>
        <input id="avatarZoom" type="range" min="100" max="250" step="5" value="100">
        <div class="row" style="justify-content:space-between;margin-top:10px;align-items:center">
          <button type="button" class="secondary" id="applyAvatarCrop">✓ Применить кадрирование</button>
          <span id="avatarCropStatus" class="muted" style="font-size:12px">Вертикальный кадр 4:5</span>
        </div>
        <div id="avatarPreview" style="margin-top:12px"></div>
      </section>

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

  <div class="card recipe-catalog"><div class="recipe-catalog-head"><h2>Коктейли</h2><span class="muted" id="cocktailCount"></span></div><label class="recipe-search-wrap" for="recipeSearch"><span aria-hidden="true">⌕</span><input type="search" id="recipeSearch" placeholder="Найти коктейль по названию…" autocomplete="off"><button type="button" id="clearRecipeSearch" aria-label="Очистить поиск" hidden>×</button></label><div id="recipeSearchStatus" class="muted recipe-search-status" aria-live="polite"></div><div id="list">Загрузка...</div></div>
</div>
<div id="orderSummary"></div>

<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const unitLabel=u=>u==="g"?"гр":u==="ml"?"мл":u==="pcs"?"шт.":String(u??"");
const fmtQty=v=>{const n=Number(v||0);return Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')};
let products=[];
let draft={shift:null,order:null,items:[]};
let cocktailCatalog=new Map();
const load=async()=>{
  const [cr,pr]=await Promise.all([fetch("/api/cocktails"),fetch("/api/ingredients")]);
  const cocktails=await cr.json(); products=await pr.json();
  cocktailCatalog=new Map((cocktails||[]).map(c=>[Number(c.id),c]));
  document.querySelector("#cocktailCount").textContent=cocktails.length ? cocktails.length+" шт." : "";
  document.querySelector("#list").innerHTML=cocktails.length
    ? '<div class="cocktail-grid">'+cocktails.map(c=>{const unavailable=(c.recipe_items||[]).some(i=>Number(i.stock_available||0)<Number(i.quantity||0));return '<article class="card cocktail-card recipe-compact'+(unavailable?' unavailable':'')+'"><div class="recipe-card-summary">'+
      (c.photo_url?'<img class="recipe-thumb" loading="lazy" decoding="async" src="'+esc(c.avatar_url||c.photo_url)+'" alt="">':'<div class="recipe-thumb recipe-thumb-placeholder">🍸</div>')+
      '<div class="recipe-summary-main"><h3>'+esc(c.name)+'</h3><div class="cocktail-price">'+Number(c.price_rub||0)+' ₽</div>'+(c.strength?'<span class="pill strength-pill">'+esc(c.strength)+'</span>':"")+(unavailable?'<div class="recipe-stock-warning">⚠️ Мало ингредиентов</div>':"")+'</div>'+
      '<div class="recipe-summary-actions"><div class="cocktail-actions"><button type="button" class="secondary edit-cocktail" data-id="'+c.id+'" title="Редактировать" aria-label="Редактировать">✏️</button><button type="button" class="secondary delete-cocktail" data-id="'+c.id+'" title="Удалить коктейль" aria-label="Удалить">🗑️</button></div><button type="button" class="secondary recipe-expand" aria-expanded="false" aria-label="Раскрыть рецепт">⌄</button></div></div>'+
      '<div class="recipe-card-details" hidden>'+(c.photo_url?'<div class="cocktail-photo-wrap"><img class="cocktail-photo" data-src="'+esc(c.photo_url)+'" alt="Фото '+esc(c.name)+'" loading="lazy" decoding="async"></div>':'')+
      '<div class="cocktail-description muted">'+esc(c.description||"Без описания")+'</div><div class="cocktail-meta">'+(c.strength?'<span class="pill strength-pill">🍸 '+esc(c.strength)+'</span>':"")+'</div>'+
      '<div class="cocktail-section"><div class="cocktail-section-title">Состав</div>'+
      (c.recipe_items?.length?'<div class="recipe-list">'+c.recipe_items.map(i=>'<div class="recipe-line" data-ingredient-id="'+i.ingredient_id+'" data-recipe-qty="'+Number(i.quantity||0)+'" data-base-stock="'+Number(i.stock_available||0)+'"><div class="recipe-name">'+esc(i.ingredient_name)+'<span class="recipe-stock" data-stock="'+Number(i.stock_available||0)+'" data-unit="'+esc(unitLabel(i.unit))+'">остаток: '+fmtQty(i.stock_available)+' '+unitLabel(i.unit)+'</span></div><div class="recipe-qty">'+fmtQty(i.quantity)+' '+unitLabel(i.unit)+'</div></div>').join("")+'</div>':'<span class="muted">Не указан</span>')+'</div>'+
      ((c.method||c.glass)?'<div class="cocktail-info-grid">'+(c.method?'<div class="cocktail-info">🥄 <b>Приготовление</b><br>'+esc(c.method)+'</div>':"")+(c.glass?'<div class="cocktail-info">🧰 <b>Инвентарь</b><br><span style="white-space:pre-line">'+esc(c.glass)+'</span></div>':"")+'</div>':"")+'</div></article>'}).join("")+'</div>'
    : '<div class="empty">Пока коктейлей нет. Создай первый 👇</div>';
  const recipeSearch=document.querySelector("#recipeSearch");
  const clearRecipeSearch=document.querySelector("#clearRecipeSearch");
  const recipeSearchStatus=document.querySelector("#recipeSearchStatus");
  const filterRecipeCards=()=>{
    const q=(recipeSearch.value||"").trim().toLocaleLowerCase("ru");
    let shown=0;
    document.querySelectorAll("#list .recipe-compact").forEach(card=>{
      const title=card.querySelector(".recipe-summary-main h3")?.textContent||"";
      const description=card.querySelector(".recipe-card-details .cocktail-description")?.textContent||"";
      const ingredients=Array.from(card.querySelectorAll(".recipe-name")).map(n=>n.textContent).join(" ");
      const matches=(title+" "+description+" "+ingredients).toLocaleLowerCase("ru").includes(q);
      card.hidden=!matches;if(matches)shown++;
    });
    clearRecipeSearch.hidden=!recipeSearch.value;
    recipeSearchStatus.textContent=q?(shown?"Найдено: "+shown:"Ничего не найдено"):"";
  };
  recipeSearch.addEventListener("input",filterRecipeCards);
  clearRecipeSearch.onclick=()=>{recipeSearch.value="";filterRecipeCards();recipeSearch.focus();};
  document.querySelectorAll(".recipe-expand").forEach(btn=>btn.onclick=()=>{const card=btn.closest(".recipe-compact");const details=card?.querySelector(".recipe-card-details");if(!details)return;const opening=details.hidden;details.hidden=!opening;if(opening)details.querySelectorAll("img[data-src]").forEach(img=>{img.src=img.dataset.src;img.removeAttribute("data-src")});btn.setAttribute("aria-expanded",String(opening));btn.textContent=opening?"⌃":"⌄";btn.setAttribute("aria-label",(opening?"Свернуть":"Раскрыть")+" рецепт");});
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
function enhanceOrderControls(){
  document.querySelectorAll(".order-controls").forEach(x=>x.remove());
  document.querySelectorAll(".cocktail-card").forEach(card=>{
    const edit=card.querySelector(".edit-cocktail"); if(!edit)return;
    const id=Number(edit.dataset.id),qty=draftQty(id);
    const box=document.createElement("div");
    box.className="order-controls row";
    box.style.cssText="justify-content:center";
    const minus=document.createElement("button");
    minus.type="button"; minus.className="secondary"; minus.textContent="−";
    minus.setAttribute("aria-label","Убрать коктейль");
    minus.disabled=qty<=0;
    minus.onclick=()=>changeOrder(id,-1);
    const count=document.createElement("span");
    count.textContent=String(qty); count.setAttribute("aria-label","Количество");
    const plus=document.createElement("button");
    plus.type="button"; plus.textContent="+";
    plus.setAttribute("aria-label","Добавить коктейль");
    plus.onclick=()=>changeOrder(id,1);
    box.append(minus,count,plus);
    const summary=card.querySelector(".recipe-card-summary");
    if(summary){box.style.margin="0 12px 12px";summary.after(box)}else card.appendChild(box);
  });
  refreshOrderAvailability();
}
function refreshOrderAvailability(){
  const reserved=new Map();
  for(const item of (draft.items||[])){
    const cocktail=cocktailCatalog.get(Number(item.cocktail_id));
    for(const ri of (cocktail?.recipe_items||[])){
      const ingredientId=Number(ri.ingredient_id);
      const used=Number(ri.quantity||0)*Number(item.quantity||0);
      reserved.set(ingredientId,Number(reserved.get(ingredientId)||0)+used);
    }
  }
  document.querySelectorAll(".cocktail-card").forEach(card=>{
    const edit=card.querySelector(".edit-cocktail"); if(!edit)return;
    const cocktailId=Number(edit.dataset.id);
    let unavailable=false;
    card.querySelectorAll(".recipe-line").forEach(line=>{
      const ingredientId=Number(line.dataset.ingredientId);
      const recipeQty=Number(line.dataset.recipeQty||0);
      const base=Number(line.dataset.baseStock||0);
      const stock=Math.max(0,base-Number(reserved.get(ingredientId)||0));
      const stockEl=line.querySelector(".recipe-stock");
      if(stockEl){
        stockEl.dataset.stock=String(stock);
        stockEl.textContent="остаток: "+fmtQty(stock)+" "+(stockEl.dataset.unit||"");
      }
      if(stock+0.000001<recipeQty) unavailable=true;
    });
    card.classList.toggle("unavailable",unavailable);
    const plus=card.querySelector(".order-controls button:not(.secondary)");
    if(plus) plus.disabled=unavailable;
    const minus=card.querySelector(".order-controls button.secondary");
    const qty=draftQty(cocktailId);
    if(minus) minus.disabled=qty<=0;
  });
}
function optimisticOrderVisual(id,delta){
  const edit=document.querySelector('.edit-cocktail[data-id="'+id+'"]');
  const card=edit?.closest(".cocktail-card"); if(!card)return;
  const controls=card.querySelector(".order-controls"),count=controls?.querySelector("span");
  if(count){
    count.textContent=String(Math.max(0,Number(count.textContent||0)+delta));
    count.classList.add("order-count-pop");
    setTimeout(()=>count.classList.remove("order-count-pop"),180);
  }
}
function optimisticDraftChange(id,delta){
  const items=draft.items||[];
  let item=items.find(x=>Number(x.cocktail_id)===Number(id));
  if(!item&&delta>0){
    const c=cocktailCatalog.get(Number(id));
    if(!c)return;
    item={cocktail_id:Number(id),cocktail_name:c.name,quantity:0,price_rub:Number(c.price_rub||0)};
    items.push(item);
  }
  if(!item)return;
  item.quantity=Math.max(0,Number(item.quantity||0)+delta);
  if(item.quantity<=0) draft.items=items.filter(x=>Number(x.cocktail_id)!==Number(id));
  else draft.items=items;
  draft.total_cocktails=(draft.items||[]).reduce((n,x)=>n+Number(x.quantity||0),0);
  draft.total_price=(draft.items||[]).reduce((n,x)=>n+Number(x.quantity||0)*Number(x.price_rub||0),0);
}
function changeOrder(id,delta){
  if(delta>0){
    const card=document.querySelector('.edit-cocktail[data-id="'+id+'"]')?.closest(".cocktail-card");
    const plus=card?.querySelector(".order-controls button:not(.secondary)");
    if(plus?.disabled)return;
  }
  optimisticDraftChange(id,delta);
  optimisticOrderVisual(id,delta);
  refreshOrderAvailability();
  renderOrderSummary();
}
function renderOrderSummary(){const box=document.querySelector("#orderSummary");if(!box)return;const items=draft.items||[];if(!items.length){box.innerHTML="";return}box.innerHTML="";const card=document.createElement("div");card.className="card";card.style.cssText="margin:14px 0;position:sticky;bottom:10px;z-index:5;box-shadow:0 12px 40px #000;border-color:#3b3b3b";const title=document.createElement("h3");title.textContent="📋 Текущий заказ";card.appendChild(title);const sh=document.createElement("div");sh.className="muted";sh.textContent="Смена №"+(draft.shift?.id||"—");card.appendChild(sh);items.forEach(x=>{const row=document.createElement("div");row.style.padding="5px 0";row.textContent=x.cocktail_name+" × "+x.quantity;card.appendChild(row)});const total=document.createElement("div");total.style.marginTop="6px";total.textContent="Всего коктейлей: "+Number(draft.total_cocktails||0)+" · Сумма: "+Number(draft.total_price||0).toFixed(0)+" ₽";card.appendChild(total);const actions=document.createElement("div");actions.className="row";actions.style.marginTop="10px";const accept=document.createElement("button");accept.textContent="✅ Принять заказ";accept.onclick=async()=>{if(!(draft.items||[]).length)return;accept.disabled=true;const r=await fetch("/api/bar/order/accept",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:(draft.items||[]).map(x=>({cocktail_id:Number(x.cocktail_id),quantity:Number(x.quantity||0)}))})}),d=await r.json().catch(()=>({}));if(!r.ok){accept.disabled=false;alert(d.error||"Не удалось принять заказ");return}location.reload()};const clear=document.createElement("button");clear.className="secondary";clear.textContent="Очистить";clear.onclick=async()=>{if(!confirm("Очистить текущий заказ?"))return;for(const item of (draft.items||[])){optimisticOrderVisual(Number(item.cocktail_id),-Number(item.quantity||0));}draft={shift:draft.shift,order:null,items:[],total_cocktails:0,total_price:0};enhanceOrderControls();refreshOrderAvailability();renderOrderSummary();fetch("/api/bar/order",{method:"DELETE"}).catch(()=>{});};actions.append(accept,clear);card.appendChild(actions);box.appendChild(card)}
let cropSourceImage=null,cropZoom=1,cropOffsetX=0,cropOffsetY=0,cropPointer=null,avatarCropBlob=null,cropObjectUrl="",cropLoadPromise=Promise.resolve(false);
const cropCanvas=document.querySelector("#avatarCropCanvas"),cropCtx=cropCanvas.getContext("2d");
function clampCropOffset(){if(!cropSourceImage)return;const scale=Math.max(cropCanvas.width/cropSourceImage.naturalWidth,cropCanvas.height/cropSourceImage.naturalHeight)*cropZoom;const w=cropSourceImage.naturalWidth*scale,h=cropSourceImage.naturalHeight*scale,baseX=(cropCanvas.width-w)/2,baseY=(cropCanvas.height-h)/2;cropOffsetX=Math.min(-baseX,Math.max(cropCanvas.width-w-baseX,cropOffsetX));cropOffsetY=Math.min(-baseY,Math.max(cropCanvas.height-h-baseY,cropOffsetY));}
function drawAvatarCrop(){if(!cropSourceImage)return;const scale=Math.max(cropCanvas.width/cropSourceImage.naturalWidth,cropCanvas.height/cropSourceImage.naturalHeight)*cropZoom,w=cropSourceImage.naturalWidth*scale,h=cropSourceImage.naturalHeight*scale;clampCropOffset();cropCtx.clearRect(0,0,cropCanvas.width,cropCanvas.height);cropCtx.drawImage(cropSourceImage,(cropCanvas.width-w)/2+cropOffsetX,(cropCanvas.height-h)/2+cropOffsetY,w,h);}
function loadCropSource(src,isObjectUrl=false){if(cropObjectUrl&&!isObjectUrl){URL.revokeObjectURL(cropObjectUrl);cropObjectUrl="";}avatarCropBlob=null;document.querySelector("#avatarCropStatus").textContent="Перемести фото и нажми «Применить»";document.querySelector("#avatarCropPanel").hidden=!src;if(!src){cropSourceImage=null;cropLoadPromise=Promise.resolve(false);return cropLoadPromise;}cropLoadPromise=new Promise(resolve=>{const img=new Image();img.onload=()=>{cropSourceImage=img;cropZoom=1;cropOffsetX=0;cropOffsetY=0;document.querySelector("#avatarZoom").value="100";drawAvatarCrop();resolve(true)};img.onerror=()=>{cropSourceImage=null;resolve(false)};img.src=src});return cropLoadPromise;}
function captureAvatarCrop(){return new Promise(resolve=>cropCanvas.toBlob(blob=>resolve(blob),"image/webp",.9));}
function markCropChanged(){avatarCropBlob=null;document.querySelector("#avatarCropStatus").textContent="Кадр изменён — нажми «Применить»";}
cropCanvas.addEventListener("pointerdown",e=>{if(!cropSourceImage)return;cropPointer={x:e.clientX,y:e.clientY,ox:cropOffsetX,oy:cropOffsetY};cropCanvas.setPointerCapture(e.pointerId)});
cropCanvas.addEventListener("pointermove",e=>{if(!cropPointer)return;const rect=cropCanvas.getBoundingClientRect(),sx=cropCanvas.width/rect.width,sy=cropCanvas.height/rect.height;cropOffsetX=cropPointer.ox+(e.clientX-cropPointer.x)*sx;cropOffsetY=cropPointer.oy+(e.clientY-cropPointer.y)*sy;markCropChanged();drawAvatarCrop()});
for(const eventName of ["pointerup","pointercancel","lostpointercapture"])cropCanvas.addEventListener(eventName,()=>{cropPointer=null});
document.querySelector("#avatarZoom").addEventListener("input",e=>{cropZoom=Number(e.target.value)/100;markCropChanged();drawAvatarCrop()});
document.querySelector("#applyAvatarCrop").onclick=async()=>{if(!cropSourceImage){document.querySelector("#avatarCropStatus").textContent="Сначала загрузи фото";return;}avatarCropBlob=await captureAvatarCrop();if(!avatarCropBlob){document.querySelector("#avatarCropStatus").textContent="Не удалось подготовить аватар";return;}document.querySelector("#avatarPreview").innerHTML='<img src="'+cropCanvas.toDataURL("image/webp",.9)+'" alt="Вертикальное фото коктейля 4:5"><div class="muted" style="font-size:12px;margin-top:5px">Предпросмотр фото 4:5</div>';document.querySelector("#avatarCropStatus").textContent="Кадрирование готово ✓"};
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
  document.querySelector("#avatarUrl").value="";
  document.querySelector("#photoFile").value="";
  document.querySelector("#photoPreview").innerHTML="";
  document.querySelector("#avatarPreview").innerHTML="";
  document.querySelector("#avatarCropPanel").hidden=true;
  if(cropObjectUrl){URL.revokeObjectURL(cropObjectUrl);cropObjectUrl="";}
  cropSourceImage=null;avatarCropBlob=null;cropZoom=1;cropOffsetX=0;cropOffsetY=0;
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
  for(const n of ["name","description","strength","method"]){
    const el=form.elements[n]; if(el)el.value=c[n]||"";
  }
  if(form.elements.inventory)form.elements.inventory.value=c.glass||"";
  document.querySelector("#photoUrl").value=c.photo_url||"";
  document.querySelector("#avatarUrl").value=c.avatar_url||"";
  document.querySelector("#photoFile").value="";
  document.querySelector("#photoPreview").innerHTML=c.photo_url?'<img src="'+esc(c.photo_url)+'" style="max-width:240px;max-height:240px;border-radius:14px;display:block" alt="Оригинал фото">':"";
  document.querySelector("#avatarPreview").innerHTML=(c.avatar_url||c.photo_url)?'<img src="'+esc(c.avatar_url||c.photo_url)+'" style="width:96px;height:120px;object-fit:cover;border-radius:14px;border:1px solid #c7a04c" alt="Текущий аватар"><div class="muted" style="font-size:12px;margin-top:5px">Текущий аватар</div>':"";
  loadCropSource(c.photo_url||c.avatar_url||"");
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
  if(!file)return;
  if(cropObjectUrl)URL.revokeObjectURL(cropObjectUrl);
  cropObjectUrl=URL.createObjectURL(file);
  box.innerHTML='<img src="'+cropObjectUrl+'" style="max-width:240px;max-height:240px;border-radius:14px;display:block" alt="Оригинал фото">';
  loadCropSource(cropObjectUrl,true).then(ok=>{if(!ok)document.querySelector("#avatarCropStatus").textContent="Не удалось открыть изображение";});
};
document.querySelector("#addIngredient").onclick=addRow;
document.querySelector("#cocktailForm").onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const recipe_items=[...document.querySelectorAll(".recipe-row")].map(r=>({ingredient_id:Number(r.querySelector(".prod").value),quantity:Number(r.querySelector(".qty").value)})).filter(x=>x.ingredient_id>0&&x.quantity>0);
  if(!recipe_items.length && document.querySelector(".recipe-row")){document.querySelector("#msg").textContent="Выберите ингредиент из списка";return;}
  const file=document.querySelector("#photoFile").files[0];
  if(file){
    document.querySelector("#msg").textContent="Загрузка оригинала…";
    const upload=new FormData(); upload.append("file",file);
    const ur=await fetch("/api/cocktail-photo",{method:"POST",body:upload});
    const ud=await ur.json().catch(()=>({}));
    if(!ur.ok){document.querySelector("#msg").textContent="Ошибка фото: "+(ud.error||"не удалось загрузить");return;}
    document.querySelector("#photoUrl").value=ud.url;
    f.set("photo_url",ud.url);
    document.querySelector("#photoPreview").innerHTML='<img src="'+esc(ud.url)+'" style="max-width:240px;max-height:240px;border-radius:14px;display:block" alt="Оригинал фото">';
  }
  if(file||avatarCropBlob){
    document.querySelector("#msg").textContent="Подготавливаем квадратный аватар…";
    if(!avatarCropBlob){const ready=await cropLoadPromise;if(ready)avatarCropBlob=await captureAvatarCrop();}
    if(!avatarCropBlob){document.querySelector("#msg").textContent="Не удалось подготовить аватар. Проверь фото и попробуй ещё раз.";return;}
    const avatarFile=new File([avatarCropBlob],"cocktail-avatar.webp",{type:"image/webp"}),avatarUpload=new FormData();avatarUpload.append("file",avatarFile);
    const ar=await fetch("/api/cocktail-photo",{method:"POST",body:avatarUpload}),ad=await ar.json().catch(()=>({}));
    if(!ar.ok){document.querySelector("#msg").textContent="Ошибка аватара: "+(ad.error||"не удалось загрузить");return;}
    document.querySelector("#avatarUrl").value=ad.url;
    f.set("avatar_url",ad.url);
    document.querySelector("#avatarPreview").innerHTML='<img src="'+esc(ad.url)+'" alt="Вертикальное фото коктейля 4:5"><div class="muted" style="font-size:12px;margin-top:5px">Аватар сохранён ✓</div>';
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


      if (url.pathname === "/bar/ingredients") return htmlResponse(renderDocument({
        title:"Ингредиенты", app:"bar", tab:"more", back:{href:"/bar",label:"Ещё"}, docTitle:"Ингредиенты · VIA Бар",
        right:`<button class="icon-btn" type="button" data-open-sheet="ingredientSheet" aria-label="Добавить ингредиент">${icon("plus")}</button>`,
        sub:"Постоянные названия для рецептов и склада. Бренд и магазин указываются в закупках.",
        body:`<label class="search">${icon("search")}<input type="search" id="ingSearch" placeholder="Поиск ингредиента" autocomplete="off" aria-label="Поиск ингредиента"></label>
<div class="section"><div class="list" id="list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><p class="section-footer" id="listFooter"></p></div>
<div class="sheet" id="ingredientSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="ingSheetTitle">
<div class="sheet-grabber"></div>
<div class="sheet-head"><button class="btn btn-plain left" type="button" data-close-sheet>Отмена</button><h2 id="ingSheetTitle">Новый ингредиент</h2><button class="btn btn-plain right" type="submit" form="ingredientForm" style="font-weight:700">Готово</button></div>
<div class="sheet-body"><form id="ingredientForm" autocomplete="off"><input type="hidden" name="id">
<div class="list"><label class="field"><span>Название</span><input name="name" required placeholder="Например, тоник апельсиновый" autofocus></label>
<div class="field"><span>Единица</span><div class="segmented" role="group" aria-label="Единица"><button type="button" data-unit="ml" aria-pressed="true">мл</button><button type="button" data-unit="g" aria-pressed="false">граммы</button><button type="button" data-unit="pcs" aria-pressed="false">штуки</button></div><input type="hidden" name="unit" value="ml"></div>
<label class="field"><span>Крепость, %</span><input name="strength_percent" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="0"></label></div>
<p class="section-footer">Водка — 40%, ликёр — около 20%, сок и газировка — 0%. По крепости ингредиентов считается крепость коктейля.</p>
<p class="footnote" id="ingMsg" role="alert"></p>
<button class="btn btn-danger btn-block" type="button" id="ingDelete" hidden>${icon("trash")}Удалить ингредиент</button>
</form></div></div></div>`,
      }).replace("</main>",String.raw`</main>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const UNIT={ml:"мл",g:"граммы",pcs:"штуки"};
let all=[];
const form=document.querySelector("#ingredientForm"),msg=document.querySelector("#ingMsg"),del=document.querySelector("#ingDelete");
const setUnit=u=>{form.unit.value=u;form.querySelectorAll("[data-unit]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.unit===u)))};
form.querySelectorAll("[data-unit]").forEach(b=>b.onclick=()=>setUnit(b.dataset.unit));
const openForm=item=>{form.reset();msg.textContent="";form.id.value=item?item.id:"";form.name.value=item?item.name:"";form.strength_percent.value=item?Number(item.strength_percent||0):0;setUnit(item?item.unit:"ml");document.querySelector("#ingSheetTitle").textContent=item?"Ингредиент":"Новый ингредиент";del.hidden=!item;VIA.openSheet("ingredientSheet")};
document.querySelector("[data-open-sheet=ingredientSheet]").addEventListener("click",e=>{e.stopPropagation();openForm(null)});
const render=()=>{const q=document.querySelector("#ingSearch").value.trim().toLocaleLowerCase("ru").replace(/ё/g,"е");const rows=all.filter(i=>!q||String(i.name).toLocaleLowerCase("ru").replace(/ё/g,"е").includes(q));
document.querySelector("#list").innerHTML=rows.map(i=>'<button type="button" class="cell" data-id="'+i.id+'"><span class="cell-body"><span class="cell-title">'+esc(i.name)+'</span><span class="cell-sub">'+UNIT[i.unit]+(Number(i.strength_percent)>0?' · '+Number(i.strength_percent).toLocaleString("ru-RU")+'% алк.':' · без алкоголя')+'</span></span><svg class="ic cell-chevron" aria-hidden="true"><use href="#i-chevronRight"/></svg></button>').join("")||'<div class="empty-state"><h3>'+(q?"Ничего не нашлось":"Пока пусто")+'</h3>'+(q?"Попробуйте другое название.":"Добавьте первый ингредиент кнопкой «+» вверху.")+'</div>';
document.querySelector("#listFooter").textContent=all.length?("Всего: "+all.length):"";
document.querySelectorAll("#list .cell").forEach(b=>b.onclick=()=>openForm(all.find(v=>Number(v.id)===Number(b.dataset.id))))};
async function load(){try{const r=await fetch("/api/ingredients");if(!r.ok)throw 0;all=await r.json();render()}catch(e){document.querySelector("#list").innerHTML='<div class="empty-state"><h3>Не удалось загрузить</h3>Проверьте интернет и обновите страницу.</div>'}}
document.querySelector("#ingSearch").addEventListener("input",render);
form.onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(form));const id=Number(body.id);const strength=Number(body.strength_percent||0);
if(!String(body.name).trim()){msg.textContent="Введите название.";return}
if(!Number.isFinite(strength)||strength<0||strength>100){msg.textContent="Крепость — число от 0 до 100.";return}
msg.textContent="Сохраняем…";
try{const r=await fetch("/api/ingredients",{method:id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(id?{id,name:body.name,unit:body.unit,strength_percent:strength}:{name:body.name,unit:body.unit,strength_percent:strength})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось сохранить");VIA.closeSheet("ingredientSheet");VIA.toast(id?"Сохранено":d.exists?"Такой ингредиент уже есть":"Ингредиент добавлен");load()}catch(err){msg.textContent=err.message||"Ошибка сети. Попробуйте ещё раз."}};
del.onclick=async()=>{const id=Number(form.id.value);if(!id||!confirm("Удалить ингредиент «"+form.name.value+"»?"))return;try{const r=await fetch("/api/ingredients?id="+id,{method:"DELETE"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось удалить");VIA.closeSheet("ingredientSheet");VIA.toast("Ингредиент удалён");load()}catch(err){msg.textContent=err.message}};
load();
</script>`));

      if (url.pathname === "/bar/stock") {
        // Первичная загрузка склада выполняется на сервере. Это исключает
        // зависимость открытия страницы от отдельного AJAX-запроса и старого
        // браузерного кэша: пользователь сразу видит ингредиенты и остатки.
        let stockIngredients=[], stockItems=[];
        let stockLoadError="";
        try{
          const [ir,products]=await Promise.all([
            env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE is_active=1 ORDER BY name").all(),
            getProducts(env),
          ]);
          stockIngredients=ir.results||[];
          stockItems=products;
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
<details class="card" id="addStockProduct" style="padding:0;overflow:hidden">
<summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;color:#f0c766;font-weight:700;font-size:18px;touch-action:manipulation"><span>＋ Добавить позицию на склад</span><span id="addStockChevron" aria-hidden="true" style="font-size:22px;transition:transform .2s">⌄</span></summary>
<div style="padding:0 22px 22px">
<h2 style="margin-top:4px">Новый товар</h2>
<form id="productForm">
<label>Ингредиент *</label>
<input id="stockIngredientSearch" type="search" placeholder="⌕ Найти ингредиент…" autocomplete="off" aria-label="Поиск ингредиента" style="margin-bottom:8px">
<select name="ingredient_id" id="ingredientSelect" required><option value="">Выберите ингредиент...</option>${stockIngredients.map(p=>'<option value="'+p.id+'">'+hEsc(p.name)+' ('+hEsc(p.unit)+')</option>').join("")}</select>
<button type="button" class="secondary" id="showInlineIngredient" style="margin-top:8px;padding:8px 12px;font-size:14px">＋ Нет в списке? Создать ингредиент</button>
<div id="inlineIngredientBox" hidden style="margin-top:12px;padding:14px;border:1px solid #55452a;border-radius:14px;background:#11100d">
<strong style="display:block;margin-bottom:10px;color:#f0c766">Новый ингредиент</strong>
<label>Название *</label><input id="inlineIngredientName" placeholder="Например, Ром тёмный">
<label>Единица измерения</label><select id="inlineIngredientUnit"><option value="ml">мл</option><option value="g">гр.</option><option value="pcs">шт.</option></select>
<label>Крепость алкоголя, %</label><input id="inlineIngredientStrength" type="number" min="0" max="100" step="0.1" value="0" placeholder="Например, 40"><p class="muted" style="margin:6px 0 0">Для водки — 40, ликёра — например 20, сока или газировки — 0.</p>
<div class="row" style="margin-top:12px;gap:8px"><button type="button" id="saveInlineIngredient">Сохранить ингредиент</button><button type="button" class="secondary" id="cancelInlineIngredient">Отмена</button></div>
<p id="inlineIngredientMsg" class="muted" style="margin:8px 0 0"></p>
</div>
<label>Бренд</label><input name="brand" placeholder="Например, Царская">
<label>Количество ингредиента в бутылке / упаковке</label><input name="quantity" id="quantity" type="number" min="0" step="0.01" value="0" placeholder="Например, 500">
<label>Цена за бутылку / упаковку, ₽</label><input name="price" id="stockPrice" type="number" min="0" step="0.01" placeholder="Например, 300">
<label style="display:flex;align-items:center;gap:10px;margin-top:10px"><input name="take_average" id="takeAverage" type="checkbox" style="width:auto"> Взять среднюю цену по ингредиенту</label>
<div style="margin-top:16px"><button>＋ Добавить товар</button></div>
<p id="msg" class="muted"></p>
</form>
</div>
</details>
<div style="height:16px"></div>
<div class="card"><h2>Товары</h2><div id="stock">${stockLoadError?'<div class="empty">Ошибка загрузки склада: '+hEsc(stockLoadError)+'<br><button type="button" onclick="location.reload()">Обновить</button></div>':(stockItems.length?stockItems.map(p=>'<div class="stock-item" data-id="'+p.ingredient_id+'" style="padding:12px 0;border-bottom:1px solid #292929"><div><b>🥃 '+hEsc(p.ingredient_name)+'</b></div><div class="muted" style="margin-top:5px">Всего: <b>'+Number(p.stock).toFixed(2)+' '+hEsc(p.unit)+'</b> · Средняя цена: <b>'+Number(p.unit_price).toFixed(4)+' ₽/'+hEsc(p.unit)+'</b></div><div style="margin-top:9px;padding-left:12px;border-left:2px solid #333">'+(p.details||[]).map(d=>'<div style="padding:5px 0"><b>'+hEsc(d.brand)+'</b> — '+Number(d.stock).toFixed(2)+' '+hEsc(p.unit)+' · '+Number(d.unit_price).toFixed(4)+' ₽/'+hEsc(p.unit)+(d.store?' · '+hEsc(d.store):'')+'</div>').join("")+'</div><div class="row" style="margin-top:9px"></div></div>').join(""):'<div class="empty">Товаров пока нет.</div>')}</div></div>
</div>
<div id="stockEditModal" hidden style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.78);padding:18px;align-items:center;justify-content:center">
  <div class="card" style="width:min(100%,520px);max-height:90vh;overflow:auto;border:1px solid #55452a;background:#11100d;padding:22px">
    <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">✏️ Редактировать склад</h2><button type="button" class="secondary" id="closeStockEdit" aria-label="Закрыть">✕</button></div>
    <p class="muted" id="stockEditIngredient" style="margin:8px 0 16px"></p>
    <form id="stockEditForm">
      <label>Название / бренд *</label><input id="stockEditBrand" required>
      <label>Количество, <span id="stockEditUnit"></span> *</label><input id="stockEditQty" type="number" min="0.01" step="0.01" required>
      <label>Цена за единицу, ₽/<span id="stockEditPriceUnit"></span> *</label><input id="stockEditPrice" type="number" min="0" step="0.0001" required>
      <p class="muted">Изменения затронут только текущий склад. Чек в магазине останется без изменений.</p>
      <div class="row" style="gap:10px"><button type="submit" id="saveStockEdit">💾 Сохранить</button><button type="button" class="secondary" id="cancelStockEdit">Отмена</button></div>
      <p id="stockEditMsg" class="muted" role="status"></p>
    </form>
  </div>
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
    if(!confirm("Удалить «"+d.brand+"» из текущего остатка склада? История покупки в магазине сохранится."))return;
    const r=await fetch("/api/products",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({ingredient_id:p.ingredient_id,brand:d.brand,store:d.store||""})});
    const x=await r.json();
    if(!r.ok){alert(x.error||"Ошибка");return}
    location.reload();
  });

  document.querySelectorAll(".edit-source").forEach(btn=>btn.onclick=()=>{
    const row=btn.closest(".stock-item");
    const p=stockItems.find(v=>Number(v.ingredient_id)===Number(row.dataset.id));
    const d=p?.details?.[Number(btn.dataset.i)];
    if(!p||!d)return;
    const modal=document.querySelector("#stockEditModal");
    modal.dataset.ingredientId=String(p.ingredient_id);
    modal.dataset.oldBrand=d.brand;
    modal.dataset.oldStore=d.store||"Ручной ввод";
    modal.querySelector("#stockEditIngredient").textContent=p.ingredient_name;
    modal.querySelector("#stockEditUnit").textContent=p.unit;
    modal.querySelector("#stockEditPriceUnit").textContent=p.unit;
    modal.querySelector("#stockEditBrand").value=d.brand;
    modal.querySelector("#stockEditQty").value=Number(d.stock);
    modal.querySelector("#stockEditPrice").value=Number(d.unit_price).toFixed(4);
    modal.querySelector("#stockEditMsg").textContent="";
    modal.querySelector("#saveStockEdit").disabled=false;
    modal.hidden=false;modal.style.display="flex";
  });
}

function closeStockEdit(){const m=document.querySelector("#stockEditModal");m.hidden=true;m.style.display="none";}
document.querySelector("#closeStockEdit").onclick=closeStockEdit;
document.querySelector("#cancelStockEdit").onclick=closeStockEdit;
document.querySelector("#stockEditModal").onclick=e=>{if(e.target.id==="stockEditModal")closeStockEdit();};
document.querySelector("#stockEditForm").onsubmit=async e=>{
  e.preventDefault();
  const modal=document.querySelector("#stockEditModal"),msg=document.querySelector("#stockEditMsg"),save=document.querySelector("#saveStockEdit");
  const brand=document.querySelector("#stockEditBrand").value.trim(),quantity=Number(document.querySelector("#stockEditQty").value),unit_price=Number(document.querySelector("#stockEditPrice").value);
  if(!brand||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unit_price)||unit_price<0){msg.textContent="Проверь название, количество и цену.";return;}
  save.disabled=true;msg.textContent="Сохраняю…";
  try{
    const r=await fetch("/api/products",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({source_edit:true,ingredient_id:Number(modal.dataset.ingredientId),old_brand:modal.dataset.oldBrand,old_store:modal.dataset.oldStore,brand,store:"Ручной ввод",quantity,unit_price})});
    const d=await r.json();
    if(!r.ok){msg.textContent="Ошибка: "+(d.details||d.error||"не удалось сохранить");save.disabled=false;return;}
    closeStockEdit();location.reload();
  }catch(err){msg.textContent="Ошибка соединения: "+String(err.message||err);save.disabled=false;}
};
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeStockEdit();});

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
const stockIngredientSearch=document.querySelector("#stockIngredientSearch");
const stockIngredientSelect=document.querySelector("#ingredientSelect");
const stockIngredientOptions=Array.from(stockIngredientSelect.options).slice(1).map(o=>({value:o.value,text:o.textContent}));
stockIngredientSearch.oninput=()=>{
  const query=stockIngredientSearch.value.trim().toLocaleLowerCase("ru");
  const selected=stockIngredientSelect.value;
  stockIngredientSelect.replaceChildren(new Option("Выберите ингредиент…",""));
  stockIngredientOptions.filter(o=>o.text.toLocaleLowerCase("ru").includes(query)).forEach(o=>stockIngredientSelect.add(new Option(o.text,o.value)));
  if(selected&&stockIngredientOptions.some(o=>o.value===selected&&o.text.toLocaleLowerCase("ru").includes(query)))stockIngredientSelect.value=selected;
  if(!stockIngredientSelect.value&&stockIngredientSelect.options.length===2&&query)stockIngredientSelect.selectedIndex=1;
};
document.querySelector("#takeAverage").onchange=updateAveragePrice;
document.querySelector("#ingredientSelect").onchange=updateAveragePrice;
document.querySelector("#quantity").oninput=updateAveragePrice;

const inlineBox=document.querySelector("#inlineIngredientBox");
document.querySelector("#showInlineIngredient").onclick=()=>{
  inlineBox.hidden=false;
  document.querySelector("#inlineIngredientName").focus();
};
document.querySelector("#cancelInlineIngredient").onclick=()=>{
  inlineBox.hidden=true;
  document.querySelector("#inlineIngredientMsg").textContent="";
};
document.querySelector("#saveInlineIngredient").onclick=async()=>{
  const name=document.querySelector("#inlineIngredientName").value.trim();
  const unit=document.querySelector("#inlineIngredientUnit").value;
  const strength=Number(document.querySelector("#inlineIngredientStrength").value||0);
  const msg=document.querySelector("#inlineIngredientMsg");
  const save=document.querySelector("#saveInlineIngredient");
  if(!name){msg.textContent="Введи название ингредиента.";document.querySelector("#inlineIngredientName").focus();return}
  if(!Number.isFinite(strength)||strength<0||strength>100){msg.textContent="Укажи крепость от 0 до 100%.";document.querySelector("#inlineIngredientStrength").focus();return}
  save.disabled=true;msg.textContent="Сохраняю…";
  try{
    const r=await fetch("/api/ingredients",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,unit,strength_percent:strength})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось сохранить ингредиент");
    const select=document.querySelector("#ingredientSelect");
    const search=document.querySelector("#stockIngredientSearch");
    let option=Array.from(select.options).find(o=>o.value===String(Number(d.id)));
    if(!option){option=document.createElement("option");option.value=String(d.id);option.textContent=name+" ("+unit+")";select.appendChild(option)}
    const cached=stockIngredientOptions.find(o=>o.value===String(Number(d.id)));
    if(!cached)stockIngredientOptions.push({value:String(d.id),text:option.textContent});
    search.value="";
    search.dispatchEvent(new Event("input"));
    select.value=String(d.id);
    document.querySelector("#inlineIngredientName").value="";
    inlineBox.hidden=true;
    msg.textContent="";
    document.querySelector("#msg").textContent=d.exists?"Ингредиент уже был в справочнике — выбрал его.":"Ингредиент сохранён. Теперь заполни бренд, количество и цену.";
    updateAveragePrice();
    document.querySelector("#brand")?.focus();
  }catch(err){msg.textContent=err.message||"Ошибка сохранения"}
  finally{save.disabled=false}
};
renderStock();
</script>`, "Склад");
      }

      if (url.pathname === "/menu") return page(`
<style>
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
:root{--via-gold:#e5b958;--via-light:#fbe29f;--via-muted:#9ca3af;--via-green:#e5b958}
.guest-menu{max-width:520px;margin:auto;padding:24px 18px 100px;color:#f3f4f6;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
.guest-menu *{box-sizing:border-box}
.via-brand{text-align:center;margin:0 0 24px;padding-top:4px}
.via-monogram{width:76px;height:76px;display:block;margin:0 auto 14px;filter:drop-shadow(0 0 16px rgba(229,185,88,.35))}
.via-family-pill{display:inline-flex;align-items:center;gap:7px;padding:5px 14px;background:rgba(229,185,88,.08);border:1px solid rgba(229,185,88,.28);border-radius:999px;font-size:10px;font-weight:700;letter-spacing:2px;color:var(--via-gold);text-transform:uppercase;margin-bottom:10px}
.via-family-pill:before{content:'●';color:#10b981;font-size:8px}
.via-brand-title{font-family:'Cinzel',Georgia,serif;font-size:34px;font-weight:900;letter-spacing:4px;background:linear-gradient(135deg,#fff 20%,var(--via-light) 60%,var(--via-gold));-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.1;margin:0 0 7px}
.via-brand-hosts{font-size:13px;letter-spacing:.5px;color:var(--via-muted);font-weight:500}.via-brand-hosts span{color:var(--via-gold);font-weight:700}
.via-guest-card{background:rgba(15,13,9,.94);border:1px solid rgba(229,185,88,.24);border-radius:20px;padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:20px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
.via-guest-avatar{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--via-gold),#c89132);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.via-guest-info{flex:1;min-width:0;text-align:left}.via-guest-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--via-muted);margin-bottom:3px}.via-guest-name{font-size:15px;font-weight:800;color:#fff}
.via-guest-score{text-align:right}.via-score-value{font-size:20px;font-weight:800;color:var(--via-gold)}.via-score-caption{font-size:10px;color:var(--via-muted);text-transform:uppercase}
#guestRegisterButton{border:1px solid rgba(229,185,88,.3)!important;border-radius:12px!important;background:rgba(229,185,88,.08)!important;color:var(--via-gold)!important;padding:10px 12px!important;font-size:12px!important;font-weight:800!important}
.via-search-wrap{position:relative;margin-bottom:14px}.via-search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);opacity:.55;pointer-events:none}
.via-search{width:100%;height:48px;background:rgba(229,185,88,.045);border:1px solid rgba(229,185,88,.18);padding:0 15px 0 42px;border-radius:14px;color:#fff;font-size:16px!important;outline:none;font-family:inherit}.via-search:focus{border-color:var(--via-gold)}.via-search::placeholder{color:var(--via-muted)}
.via-filters{display:flex;gap:8px;overflow-x:auto;padding:0 0 9px;margin-bottom:17px;scrollbar-width:none}.via-filters::-webkit-scrollbar{display:none}
.via-filter{flex-shrink:0;padding:9px 13px;background:rgba(229,185,88,.045);border:1px solid rgba(229,185,88,.13);border-radius:12px;font-size:12px;font-weight:700;color:var(--via-muted);cursor:pointer;font-family:inherit;white-space:nowrap}
.via-filter.active{background:linear-gradient(135deg,rgba(229,185,88,.25),rgba(200,145,50,.14));border-color:var(--via-gold);color:#fff;box-shadow:0 4px 14px rgba(229,185,88,.18)}
#menu{display:flex;flex-direction:column;gap:18px}
#menu .guest-card:not(.guest-empty){display:flex;flex-direction:column;align-items:stretch;min-width:0;overflow:hidden;margin:0;padding:12px;background:linear-gradient(155deg,rgba(24,21,16,.98),rgba(10,10,9,.99) 55%);border:1px solid rgba(214,177,99,.34);border-radius:22px;box-shadow:0 14px 34px rgba(0,0,0,.22)}
#menu .guest-photo,#menu .guest-photo-placeholder{display:flex;align-items:center;justify-content:center;flex:none;width:100%;aspect-ratio:16/9;height:auto;max-height:none;object-fit:cover;object-position:center;border-radius:15px;background:radial-gradient(circle,rgba(229,185,88,.08),rgba(15,13,9,.9));border:1px solid rgba(229,185,88,.17);color:var(--via-gold);font-size:32px}
#menu .guest-card h2{margin:17px 3px 7px;font-family:'Cinzel',Georgia,serif;font-size:25px;font-weight:700;letter-spacing:.1px;line-height:1.2;color:#f5e8c8}
#menu .guest-description{font-size:14px;line-height:1.58;color:#b9b6ae;margin:0 3px 5px;overflow-wrap:anywhere}#menu .guest-description.is-collapsed{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}#menu .guest-description-toggle{align-self:flex-start;margin:0 3px 13px;padding:4px 0;border:0;background:transparent;color:var(--via-gold);font:600 12px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}#menu .guest-description-toggle:focus-visible{outline:1px solid var(--via-gold);outline-offset:3px;border-radius:3px}
#menu .guest-strength{font-size:12px;letter-spacing:.15px;color:#bdb7aa;margin:0 3px 4px}
#menu .guest-price{font-size:25px;line-height:1.2;color:var(--via-gold);font-weight:800;letter-spacing:.1px;margin:0 3px 4px}
#menu .guest-ingredients{font-size:13px;line-height:1.6;color:#c3beb3;margin-top:13px;padding:12px 3px 1px;border-top:1px solid rgba(214,177,99,.16)}
#menu .guest-empty{display:block!important;padding:28px;text-align:center;color:var(--via-muted);background:rgba(15,13,9,.94);border:1px solid rgba(229,185,88,.24);border-radius:20px}
#menu .guest-order-controls{display:flex!important;align-items:center;justify-content:flex-start;gap:12px!important;margin-top:14px!important;padding-top:13px!important;border-top:1px solid rgba(214,177,99,.16)!important}
#menu .guest-order-controls button{width:54px;min-width:54px;height:50px;border-radius:15px;font-size:24px;font-weight:800;padding:0;background:linear-gradient(135deg,#e5c16f,#c9953c);color:#17120a;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
#menu .guest-order-controls button.secondary{background:#242018;color:#f5e8c8;border:1px solid rgba(214,177,99,.14);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
#menu .guest-order-controls span{min-width:38px;text-align:center;font-size:19px;font-weight:700;color:#f3f0e8}
@media(min-width:520px){#menu .guest-card:not(.guest-empty){padding:16px}#menu .guest-card h2{font-size:28px}}
#guestRegisterModal>div{background:#131520!important;border:1px solid rgba(229,185,88,.24)!important;border-radius:22px!important}
#guestRegisterModal h2{font-family:'Cinzel',Georgia,serif}
#guestRegisterForm input{width:100%;margin:5px 0 12px;background:#0b0d13;border:1px solid #343541;border-radius:12px;color:#fff;padding:13px;font:inherit}
#guestRegisterForm button[type=submit]{background:linear-gradient(135deg,var(--via-gold),#c89132);color:#111;border:0;border-radius:13px;padding:14px;font-weight:800}
@media(max-width:430px){.guest-menu{padding:20px 14px 100px}.via-brand-title{font-size:31px;letter-spacing:3px}.via-monogram{width:72px;height:72px}.via-guest-card{padding:12px;gap:9px}#guestRegisterButton{padding:9px 10px!important;font-size:11px!important}#menu .guest-card:not(.guest-empty){grid-template-columns:78px minmax(0,1fr);column-gap:12px;padding:12px}#menu .guest-photo,#menu .guest-photo-placeholder{width:100%;height:auto;aspect-ratio:16/9;max-height:none}#menu .guest-card h2{font-size:15px}}
</style>
<div class="guest-menu">
<header class="via-brand">
<svg class="via-monogram" viewBox="0 0 1000 1000" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Золотой герб VA семьи Шульминых">
<defs>
  <linearGradient id="viaCrestGold" x1="170" y1="180" x2="820" y2="850" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff5c7"/><stop offset=".22" stop-color="#fbe29f"/><stop offset=".52" stop-color="#e5b958"/><stop offset=".78" stop-color="#c89132"/><stop offset="1" stop-color="#fbe29f"/>
  </linearGradient>
  <filter id="viaCrestGlow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="9" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<!-- Evenly spaced dotted outer seal and precise concentric rings -->
<circle cx="500" cy="500" r="365" stroke="url(#viaCrestGold)" stroke-width="15" stroke-linecap="round" stroke-dasharray="1 27" opacity=".95"/>
<circle cx="500" cy="500" r="329" stroke="url(#viaCrestGold)" stroke-width="8" opacity=".95"/>
<circle cx="500" cy="500" r="305" stroke="url(#viaCrestGold)" stroke-width="3.5" opacity=".72"/>
<!-- Clean geometric VA monogram, inspired by the chosen crest -->
<g stroke="url(#viaCrestGold)" stroke-linecap="butt" stroke-linejoin="miter" filter="url(#viaCrestGlow)">
  <path d="M285 330 L445 680 L590 285 L745 680" stroke-width="30"/>
  <path d="M520 545 L650 545" stroke-width="25"/>
</g>
</svg>
<div class="via-family-pill">Shulmin Private Lounge</div><h1 class="via-brand-title">VIA BAR</h1>
</header>

<div style="display:flex;justify-content:flex-end;margin:-8px 0 14px"><button type="button" id="guestRegisterButton" class="secondary">👤 Войти</button></div>
<div class="via-search-wrap"><span class="via-search-icon">🔍</span><input id="ingredientSearch" class="via-search" placeholder="Поиск (джин, сауэр, виски)..." autocomplete="off"></div>
<div class="via-filters" id="viaFilters"><button class="via-filter active" type="button" data-filter="all">Все меню</button><button class="via-filter" type="button" data-filter="duo">✨ Дуэт VIA</button><button class="via-filter" type="button" data-filter="vladimir">🥃 Выбор Владимира</button><button class="via-filter" type="button" data-filter="anastasia">🍸 Выбор Анастасии</button><button class="via-filter" type="button" data-filter="mocktail">🍃 Без алкоголя</button></div>
<div id="guestRegisterModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:1000;padding:24px 14px;overflow:auto"><div style="max-width:430px;margin:8vh auto 0;background:#151515;border:1px solid #333;border-radius:18px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.45)"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px"><h2 style="margin:0;color:#f4f4f4">👤 Вход / регистрация</h2><button type="button" id="guestRegisterClose" class="secondary">✕</button></div><div style="color:#999;font-size:13px;line-height:1.4;margin-bottom:14px">Регистрация добровольная. После входа появится возможность делать заказы.</div><form id="guestRegisterForm"><label>Имя</label><input name="name" required maxlength="80" placeholder="Ваше имя" autocomplete="name"><label>Телефон</label><input name="phone" required maxlength="30" placeholder="+7 900 123-45-67" autocomplete="tel"><label>PIN-код</label><input name="pin" required minlength="4" maxlength="12" inputmode="numeric" pattern="[0-9]{4,12}" placeholder="4–12 цифр" autocomplete="new-password"><button type="submit" style="width:100%;margin-top:12px">Зарегистрироваться</button><div id="guestRegisterMessage" style="margin-top:12px;color:#aaa;font-size:14px"></div></form></div></div>
<div id="menu"><div class="guest-card guest-empty">Загружаем меню салона…</div></div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let cocktails=[],viaFilter="all";
const norm=s=>String(s||"").toLowerCase().replace(/ё/g,"е");
const curatorOf=c=>{const n=norm(c.name);if(/virgin|безалк|mocktail|garden/.test(n)||norm(c.strength).includes("безалк"))return "mocktail";if(/anastasia|анастас|passion sour|clover club/.test(n))return "anastasia";if(/via royal|royal heritage/.test(n))return "duo";return "vladimir"};
const render=()=>{const q=norm(document.querySelector("#ingredientSearch").value.trim());const list=cocktails.filter(c=>{if(viaFilter!=="all"&&curatorOf(c)!==viaFilter)return false;if(q){const ing=(c.recipe_items||[]).map(i=>i.ingredient_name||i.name||"").join(" ");if(!norm(c.name+" "+ing+" "+(c.strength||"")).includes(q))return false}return true});const box=document.querySelector("#menu");if(!list.length){box.innerHTML='<div class="guest-card guest-empty">По вашему запросу коктейлей не найдено.</div>';return}box.innerHTML=list.map(c=>{const names=(c.recipe_items||[]).map(i=>String(i.ingredient_name||i.name||"").trim()).filter(Boolean);const unique=[...new Map(names.map(n=>[norm(n),n])).values()];const st=norm(c.strength);const strength=st.includes("безалк")?"Без алкоголя":st.includes("лег")?"Лёгкий":st.includes("сред")?"Средний":st.includes("креп")?"Крепкий":c.strength||"Не указана";return '<article class="guest-card" id="cocktail-'+Number(c.id)+'">'+((c.photo_url||c.avatar_url)?'<img class="guest-photo" loading="lazy" decoding="async" src="'+esc(c.photo_url||c.avatar_url)+'" alt="'+esc(c.name)+'">':'<div class="guest-photo-placeholder">🍸</div>')+'<h2>'+esc(c.name)+'</h2>'+(c.description&&String(c.description).trim()?'<div class="guest-description is-collapsed" id="guest-description-'+Number(c.id)+'">'+esc(c.description)+'</div>'+(String(c.description).trim().length>145?'<button type="button" class="guest-description-toggle" aria-expanded="false" data-description="'+Number(c.id)+'">Читать полностью ↓</button>':''): '')+'<div class="guest-strength">Крепость · '+esc(strength)+'</div><div class="guest-price">'+Number(c.price_rub||0).toLocaleString("ru-RU")+' ₽</div>'+(unique.length?'<div class="guest-ingredients"><span style="display:block;color:var(--via-gold);font-size:10px;letter-spacing:1.4px;text-transform:uppercase;margin-bottom:5px">Состав</span>'+unique.map(esc).join(", ")+'</div>':'')+'</article>'}).join("")};
document.querySelector("#ingredientSearch").addEventListener("input",render);document.querySelector("#menu").addEventListener("click",e=>{const b=e.target.closest(".guest-description-toggle");if(!b)return;const d=document.querySelector("#guest-description-"+Number(b.dataset.description));if(!d)return;const expanded=b.getAttribute("aria-expanded")==="true";d.classList.toggle("is-collapsed",expanded);b.setAttribute("aria-expanded",String(!expanded));b.textContent=expanded?"Читать полностью ↓":"Свернуть ↑";});
document.querySelectorAll(".via-filter").forEach(b=>b.addEventListener("click",()=>{viaFilter=b.dataset.filter;document.querySelectorAll(".via-filter").forEach(x=>x.classList.toggle("active",x===b));render()}));
const guestRegisterButton=document.querySelector("#guestRegisterButton"),guestRegisterModal=document.querySelector("#guestRegisterModal"),guestRegisterClose=document.querySelector("#guestRegisterClose"),guestRegisterForm=document.querySelector("#guestRegisterForm"),guestRegisterMessage=document.querySelector("#guestRegisterMessage");
const closeGuestRegister=()=>{guestRegisterModal.style.display="none";guestRegisterMessage.textContent=""};
guestRegisterButton.onclick=()=>{guestRegisterModal.style.display="block";guestRegisterForm.elements.name.focus()};guestRegisterClose.onclick=closeGuestRegister;guestRegisterModal.onclick=e=>{if(e.target===guestRegisterModal)closeGuestRegister()};
guestRegisterForm.onsubmit=async e=>{e.preventDefault();guestRegisterMessage.textContent="Подключаем…";try{const body=Object.fromEntries(new FormData(guestRegisterForm));const r=await fetch("/api/guest/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok){guestRegisterMessage.textContent=d.error||"Не удалось зарегистрироваться";return}guestRegisterMessage.textContent="Готово!";setTimeout(closeGuestRegister,900)}catch(err){guestRegisterMessage.textContent="Ошибка соединения. Попробуйте ещё раз."}};
fetch("/api/guest/me").then(r=>r.json()).then(x=>{if(x.guest){document.querySelector("#guestRegisterButton").textContent="👤 "+x.guest.name}}).catch(()=>{});
fetch("/api/cocktails?include_stock=0").then(r=>r.json()).then(x=>{cocktails=Array.isArray(x)?x:[];render()}).catch(()=>{document.querySelector("#menu").innerHTML='<div class="guest-card guest-empty">Не удалось загрузить меню. Попробуйте обновить страницу.</div>'});
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
      '<div class="muted">Запись о покупке · остаток на складе ведётся отдельно</div>'+
      '<div class="row" style="margin-top:9px"><button type="button" class="secondary edit">✏️ Изменить</button><button type="button" class="secondary delete">🗑 Удалить</button></div></div></div>';
  }).join(""):'<div class="empty">По выбранному фильтру закупок нет.</div>';
  document.querySelectorAll(".purchase-item .edit").forEach(b=>b.onclick=()=>editPurchase(history,b.closest(".purchase-item").dataset.id));
  document.querySelectorAll(".purchase-item .delete").forEach(b=>b.onclick=()=>deletePurchase(b.closest(".purchase-item").dataset.id));
}

function editPurchase(history,id){
  const item=history.find(x=>String(x.id)===String(id)); if(!item)return;
  const row=document.querySelector('.purchase-item[data-id="'+id+'"]');
  const consumed=0;
  const dt=String(item.purchased_at||"").slice(0,10);
  row.innerHTML='<div><div class="grid">'+
    '<div><label>Ингредиент</label><select class="edit-ingredient">'+ingredients.map(i=>'<option value="'+i.id+'"'+(Number(i.id)===Number(item.ingredient_id)?' selected':'')+'>'+esc(i.name)+' ('+esc(i.unit)+')</option>').join("")+'</select></div>'+
    '<div><label>Магазин / поставщик</label><input class="edit-store" value="'+esc(item.store||"")+'"></div>'+
    '<div><label>Бренд</label><input class="edit-brand" value="'+esc(item.brand||"")+'"></div>'+
    '<div><label>Дата покупки</label><input class="edit-date" type="date" value="'+dt+'"></div>'+
    '<div><label>Количество</label><input class="edit-qty" type="number" min="0.01" step="0.01" value="'+Number(item.purchased_qty)+'"></div>'+
    '<div><label>Цена закупки, ₽</label><input class="edit-price" type="number" min="0" step="0.01" value="'+Number(item.price_rub)+'"></div>'+
    '</div><p class="muted">Редактирование изменит только запись о покупке, текущий остаток склада не изменится.</p>'+
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
  if(!confirm("Удалить запись о покупке из истории магазина? Текущий склад останется без изменений."))return;
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
 box.innerHTML=open?"<h2>Смена №"+open.id+" 🟢</h2><p class=\\"muted\\">Начало: "+open.started_at+"</p><button id=\\"closeShift\\" class=\\"secondary\\">Закрыть смену</button>":"<h2>Смена не открыта</h2><p class=\\"muted\\">Нажми «＋» у коктейля — смена откроется автоматически.</p><button id=\\"openShift\\">▶ Открыть смену</button>";
 if(open){document.querySelector("#closeShift").onclick=async()=>{const x=await fetch("/api/bar/shift",{method:"PUT"});const j=await x.json();if(!x.ok){alert(j.error||"Не удалось закрыть смену");return;}loadStats()};}
 else{document.querySelector("#openShift").onclick=async()=>{const x=await fetch("/api/bar/shift",{method:"POST"});if(!x.ok){alert("Не удалось открыть смену");return;}loadStats()};}
 document.querySelector("#stats").innerHTML=(d.shifts||[]).map(x=>"<div style=\\"padding:14px 0;border-bottom:1px solid #292929\\"><b>Смена №"+x.id+"</b> · "+(x.status==="open"?"🟢 открыта":"закрыта")+"<div class=\\"muted\\">"+x.started_at+" → "+(x.closed_at||"сейчас")+"</div><div style=\\"margin-top:6px\\"><b>"+Number(x.orders_count||0)+"</b> заказов · <b>"+Number(x.cocktails_count||0)+"</b> коктейлей · <b>"+Number(x.revenue_rub||0).toFixed(0)+" ₽</b></div></div>").join("")||"<div class=\\"empty\\">Смен ещё нет.</div>";
}
loadStats();
</script>`, "Статистика");

      if (url.pathname === "/bar/orders") return page(`<header><h1>📋 Текущий заказ</h1><div class="sub">＋ и − меняют заказ. Склад резервируется сразу, окончательное списание — после принятия.</div></header>
<div class="wrap">
<div class="row" style="margin-bottom:14px"><a href="/" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🏠 Главное меню</a><a href="/bar/recipes" style="display:inline-block;padding:10px 14px;border:1px solid #333;border-radius:12px;background:#151515">🍸 Книга рецептов</a></div>
<div class="card"><div id="order">Загрузка…</div></div>
<div id="orderRecipeModal" hidden style="position:fixed;inset:0;z-index:1000;background:#000c;display:none;align-items:flex-end;justify-content:center;padding:14px">
 <section style="width:100%;max-width:620px;max-height:84vh;overflow:auto;background:linear-gradient(145deg,#1b1913,#0b0b0a);border:1px solid #55452a;border-radius:24px;padding:20px;box-shadow:0 20px 70px #000">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><h2 id="orderRecipeTitle" style="margin:0;color:#f1dfb5"></h2><button type="button" id="closeOrderRecipe" class="secondary" aria-label="Закрыть рецепт" style="min-width:44px;width:44px;height:44px;padding:0;border-radius:50%">×</button></div>
  <div id="orderRecipeBody" style="margin-top:14px"></div>
 </section>
</div>
</div>
<script>
const orderEsc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const orderUnit=u=>u==="g"?"гр.":u==="ml"?"мл.":u==="pcs"?"шт.":String(u||"");
let orderCocktails=new Map();
async function loadOrderRecipes(){
 try{const r=await fetch("/api/cocktails?include_stock=0");if(!r.ok)return;const data=await r.json();orderCocktails=new Map((Array.isArray(data)?data:[]).map(c=>[Number(c.id),c]));}catch(e){}
}
function openOrderRecipe(id){
 const c=orderCocktails.get(Number(id));if(!c){alert("Не удалось загрузить рецепт. Обнови страницу и попробуй ещё раз.");return;}
 document.querySelector("#orderRecipeTitle").textContent=c.name||"Рецепт коктейля";
 const ingredients=(c.recipe_items||[]).map(i=>'<div style="display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid #342b1c"><span>'+orderEsc(i.ingredient_name||i.name||"Ингредиент")+'</span><b style="white-space:nowrap;color:#e5bd61">'+orderEsc(i.quantity)+' '+orderEsc(orderUnit(i.unit))+'</b></div>').join("");
 const body=document.querySelector("#orderRecipeBody");
 body.innerHTML=(c.photo_url?'<img src="'+orderEsc(c.photo_url)+'" alt="" loading="lazy" style="display:block;width:100%;max-height:240px;object-fit:cover;border-radius:14px;margin-bottom:14px;border:1px solid #493b25">':"")+
 (c.description?'<p style="color:#b9b5ac;line-height:1.55">'+orderEsc(c.description)+'</p>':"")+
 (c.strength?'<p style="color:#e5bd61;margin:10px 0">Крепость · '+orderEsc(c.strength)+'</p>':"")+
 '<h3 style="margin:18px 0 4px;color:#f1dfb5">Состав и дозировки</h3>'+
 (ingredients||'<p class="muted">Состав пока не указан.</p>')+
 (c.method?'<h3 style="margin:18px 0 6px;color:#f1dfb5">Способ приготовления</h3><p style="white-space:pre-line;line-height:1.55">'+orderEsc(c.method)+'</p>':"")+
 (c.glass?'<h3 style="margin:18px 0 6px;color:#f1dfb5">Инвентарь</h3><p style="white-space:pre-line;line-height:1.55">'+orderEsc(c.glass)+'</p>':"");
 const modal=document.querySelector("#orderRecipeModal");modal.hidden=false;modal.style.display="flex";document.body.style.overflow="hidden";
}
function closeOrderRecipe(){const m=document.querySelector("#orderRecipeModal");m.hidden=true;m.style.display="none";document.body.style.overflow="";}
document.querySelector("#closeOrderRecipe").onclick=closeOrderRecipe;
document.querySelector("#orderRecipeModal").onclick=e=>{if(e.target.id==="orderRecipeModal")closeOrderRecipe()};
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeOrderRecipe()});
async function loadOrder(){
 const r=await fetch("/api/bar/order");const d=await r.json();const box=document.querySelector("#order");
 if(!d.items||!d.items.length){box.innerHTML="<div class=\\"empty\\">Текущий заказ пуст.<br><a href=\\"/bar/recipes\\">← Вернуться в книгу рецептов</a></div>";return;}
 box.innerHTML="<h2>Смена №"+(d.shift?.id||"—")+"</h2>"+d.items.map(i=>"<div class=\\"row\\" style=\\"justify-content:space-between;padding:12px 0;border-bottom:1px solid #292929;gap:12px\\"><button type=\\"button\\" class=\\"order-recipe-link\\" data-recipe-id=\\""+Number(i.cocktail_id)+"\\" style=\\"padding:4px 0;border:0;background:none;color:#f0c766;text-decoration:underline;text-decoration-color:#80642f;text-underline-offset:4px;text-align:left;font:inherit;font-weight:700;cursor:pointer;flex:1;min-width:0\\">"+orderEsc(i.cocktail_name)+"</button><span class=\\"row\\" style=\\"flex-shrink:0\\"><button type=\\"button\\" class=\\"secondary minus\\" data-id=\\""+Number(i.cocktail_id)+"\\">−</button><b>"+Number(i.quantity)+"</b><button type=\\"button\\" class=\\"plus\\" data-id=\\""+Number(i.cocktail_id)+"\\">＋</button></span></div>").join("")+"<p style=\\"margin-top:14px\\">Коктейлей: <b>"+Number(d.total_cocktails||0)+"</b> · Сумма: <b>"+Number(d.total_price||0).toFixed(0)+" ₽</b></p><div class=\\"row\\"><button id=\\"accept\\">✅ Принять заказ</button><button id=\\"clear\\" class=\\"secondary\\">Очистить</button></div>";
 document.querySelectorAll(".order-recipe-link").forEach(b=>b.onclick=()=>openOrderRecipe(Number(b.dataset.recipeId)));
 document.querySelectorAll(".minus").forEach(b=>b.onclick=()=>changeOrder(Number(b.dataset.id),-1));
 document.querySelectorAll(".plus").forEach(b=>b.onclick=()=>changeOrder(Number(b.dataset.id),1));
 document.querySelector("#accept").onclick=async()=>{const r=await fetch("/api/bar/order/accept",{method:"POST"});const d=await r.json();if(!r.ok){alert(d.error||"Ошибка");return;}alert("Заказ №"+d.order_id+" принят ✅");loadOrder()};
 document.querySelector("#clear").onclick=async()=>{if(!confirm("Очистить текущий заказ?"))return;await fetch("/api/bar/order",{method:"DELETE"});loadOrder()};
}
async function changeOrder(id,delta){const r=await fetch("/api/bar/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cocktail_id:id,delta})});const d=await r.json();if(!r.ok){alert(d.error||"Ошибка");return;}loadOrder()}
Promise.all([loadOrderRecipes(),loadOrder()]);
</script>`, "Заказы");

      return new Response("Не найдено",{status:404});
    } catch (error) {
      console.error(error);
      return json({error:"Ошибка сервера",details:String(error?.message||error)},500);
    }
  }
};





