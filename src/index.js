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


      // ═══════ route-block: /bar/recipes ═══════ (agents: edit only inside your own block)

      if (url.pathname === "/bar/recipes") return htmlResponse(renderDocument({
        title:"Рецепты", app:"bar", tab:"recipes", docTitle:"Рецепты · VIA Бар",
        right:`<button class="icon-btn" type="button" id="newCocktailBtn" aria-label="Новый коктейль">${icon("plus")}</button>`,
        sub:"Книга бара: из неё собирается гостевое меню.",
        extraCss:`
.vh{position:absolute!important;width:1px!important;min-width:0!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
label.field,label.cell{margin:0}
.rb-search{padding-right:0}
.search-clear{display:grid;place-items:center;width:44px;height:40px;margin-left:-4px;border:0;background:none;color:var(--label-3);cursor:pointer;padding:0;flex:none}
.search-clear .ic{width:18px;height:18px}
#searchStatus{margin:8px 4px 0}
#searchStatus:empty{display:none}
#lines>.list{margin-top:16px}
.rb-skel .skeleton{min-height:80px;border-radius:0}.rb-skel .skeleton+.skeleton{border-top:.5px solid var(--sep-strong)}
.rb-line .line-head{margin:24px 2px 10px}
.rb-line:first-child .line-head{margin-top:14px}
.rb-line .line-head .count{font-variant-numeric:tabular-nums}
.rb-row{display:flex;align-items:center;--sep-inset:74px}
.rb-open{flex:1;min-width:0;padding-right:6px;cursor:pointer}
.rb-thumb{width:48px;height:60px;border-radius:10px}
.thumb-ph.rb-thumb{color:var(--line,var(--gold));background:color-mix(in srgb,var(--line,var(--gold)) 10%,var(--bg-raised-2))}
.rb-row .cell-title{font-weight:600}
.rb-ings{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rb-meta{display:flex;flex-wrap:wrap;align-items:center;gap:3px 10px;margin-top:5px;font-size:.8125rem;color:var(--label-2)}
.rb-price{font-weight:600}
.rb-short{display:inline-flex;align-items:center;gap:4px;color:var(--warn);font-weight:600}
.rb-short .ic{width:15px;height:15px}
.rb-row.is-short .rb-thumb{opacity:.55}
.scale{display:inline-flex;align-items:center;gap:3px}
.scale i{display:block;width:7px;height:7px;border-radius:50%;background:var(--line)}
.scale i.o{background:none;box-shadow:inset 0 0 0 1.5px var(--line)}
.rb-stepper{flex:none}
.rb-row .rb-stepper{margin-right:10px}
.rb-stepper button{position:relative}
.rb-stepper button::after{content:"";position:absolute;inset:-4px 0}
.rb-stepper .ic{width:20px;height:20px}
.rb-stepper.is-empty .st-minus,.rb-stepper.is-empty .st-count{display:none}
.rb-stepper.is-empty{background:var(--gold-soft);box-shadow:inset 0 0 0 .75px var(--gold-ring)}
.rb-stepper .st-plus.is-short{color:var(--label-3)}
.rb-empty .btn{margin-top:14px}
.order-bar{position:fixed;z-index:45;left:50%;bottom:calc(var(--tabbar-h) + 20px + var(--safe-b));transform:translateX(-50%);width:min(calc(100% - 24px),520px);display:flex;align-items:center;gap:6px;padding:6px;border-radius:999px;background:var(--bg-raised-2);box-shadow:var(--shadow),inset 0 0 0 .75px var(--gold-ring);animation:ob-in .28s cubic-bezier(.2,.9,.25,1)}
@keyframes ob-in{from{opacity:0;transform:translate(-50%,14px)}}
.ob-info{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:44px;padding:0 6px 0 12px;border:0;border-radius:999px;background:none;color:var(--label);font:inherit;text-align:left;cursor:pointer}
.ob-info:active{background:var(--bg-pressed)}
.ob-title,.ob-sub{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ob-title{font-weight:600;font-size:.9375rem}
.ob-sub{font-size:.75rem;color:var(--label-2);margin-top:1px}
.order-bar .ob-btn{min-height:44px;padding:0 14px;font-size:.9375rem;flex:none}
body.app.has-order .screen{padding-bottom:calc(var(--tabbar-h) + 108px + var(--safe-b))}
body.has-order:not(:has(.sheet.open)) .toast{bottom:calc(var(--tabbar-h) + 96px + var(--safe-b))}
.toast{width:max-content;border-radius:22px}
.line-other{--line:var(--gold)}
.route.line-zero{--line:var(--line-zero)}.route.line-light{--line:var(--line-light)}.route.line-mid{--line:var(--line-mid)}.route.line-strong{--line:var(--line-strong)}
.sheet-panel:focus{outline:none}
.dt-photo{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r-lg);background:var(--bg-raised-2);margin:2px 0 14px}
.dt-name{font-size:1.75rem;line-height:1.15;margin:4px 0 10px;text-wrap:balance;overflow-wrap:anywhere}
.dt-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dt-meta .badge{height:26px;padding:0 11px;font-size:.8125rem}
.dt-price{color:var(--label-2);font-weight:600;font-variant-numeric:tabular-nums}
.dt-desc{color:var(--label-2);margin:12px 0 0;line-height:1.45;white-space:pre-line}
.dt-warn{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;padding:12px 14px;border-radius:var(--r-md);background:color-mix(in srgb,var(--warn) 12%,transparent);color:var(--warn);font-size:.9375rem;line-height:1.35}
.dt-warn .ic{margin-top:1px}
.dt-order{margin-top:16px}
.dt-panel{padding:16px 14px}
.dt-empty{margin:0;color:var(--label-2)}
.rs-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.rs-name{font-weight:500;overflow-wrap:anywhere}
.rs-qty{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.rs-stock{font-size:.8125rem;color:var(--label-2);margin-top:2px;font-variant-numeric:tabular-nums}
.route-stop.short .station{background:var(--warn);box-shadow:inset 0 0 0 4px var(--warn),inset 0 0 0 6px var(--bg)}
.route-stop.short .rs-stock{color:var(--warn);font-weight:600}
.dt-text{white-space:pre-line;line-height:1.45;margin:0}
.dt-actions{margin-top:24px}
.ord-shift{margin:2px 4px 10px}
.ord-item .rb-stepper{margin-left:4px}
.ord-total{margin-top:12px}
.ord-actions{margin-top:20px}
.sheet-full .sheet-panel{height:92dvh}
.sheet-head h2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px}
.rb-form .section:first-child{margin-top:4px}
.ri-main{display:grid;grid-template-columns:minmax(0,1fr) 116px 44px;align-items:center}
.ri-main .field+.field{border-top:0;border-left:.5px solid var(--sep-strong)}
.ri-main .field{padding-right:10px}
.ri-remove{color:var(--label-3)}
.ri+.ri{border-top:.5px solid var(--sep-strong)}
#recipeItems:not(:empty)+.ri-add{border-top:.5px solid var(--sep-strong)}
.ri-add{color:var(--gold);font-weight:500;cursor:pointer;min-height:48px}
.ri-add .ic{width:22px;height:22px}
.ri-new{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:0 14px 12px;font-size:.8125rem;color:var(--label-2)}
.ri-new .segmented{flex:none;width:168px}
.ri-new .segmented button{min-height:44px}
.ri-sugg{padding:0 10px 10px}
.sugg{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:10px;background:var(--bg-raised-2);color:var(--label);font:inherit;text-align:left;cursor:pointer}
.sugg+.sugg{margin-top:4px}
.sugg:active,.sugg:focus-visible{background:var(--bg-pressed)}
.sugg-unit{color:var(--label-2);font-size:.875rem;flex:none}
.sugg-new{color:var(--gold);justify-content:flex-start}
.sugg-new .ic{width:18px;height:18px}
.photo-pick{cursor:pointer}
.vh:focus-visible+.photo-pick{outline:2px solid var(--gold);outline-offset:-2px;border-radius:var(--r-lg)}
.photo-preview{padding:0 14px 14px}
.photo-preview:empty{display:none}
.photo-preview img{display:block;max-width:100%;max-height:220px;border-radius:12px}
.crop-panel{padding:6px 0 12px}
.crop-stage{width:min(100%,240px);aspect-ratio:4/5;margin:10px auto 4px;border-radius:14px;overflow:hidden;background:var(--bg);box-shadow:inset 0 0 0 1px var(--gold-ring);touch-action:none}
.crop-stage canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.crop-panel input[type=range]{accent-color:var(--gold);min-height:44px}
.crop-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 14px 0}
.crop-actions .btn{min-height:44px}
.avatar-preview{display:flex;gap:12px;align-items:center;padding:12px 14px 0}
.avatar-preview:empty{display:none}
.avatar-preview img{width:72px;height:90px;object-fit:cover;border-radius:10px;box-shadow:0 0 0 1px var(--gold-ring)}
.form-msg{margin:14px 4px 0}
.form-msg:empty{display:none}
.form-msg.error{color:var(--danger)}
.form-actions{display:grid;gap:10px;margin-top:22px}
`,
        body:`<div class="search rb-search">${icon("search")}<input type="search" id="recipeSearch" placeholder="Коктейль или ингредиент" autocomplete="off" enterkeyhint="search" aria-label="Поиск по рецептам"><button class="search-clear" type="button" id="clearSearch" aria-label="Очистить поиск" hidden>${icon("close")}</button></div>
<p class="footnote" id="searchStatus" role="status" aria-live="polite"></p>
<div id="lines" aria-busy="true"><div class="list rb-skel"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div></div>
<p class="section-footer" id="listFooter"></p>

<div class="order-bar" id="orderBar" hidden>
<button type="button" class="ob-info" id="orderOpen" aria-haspopup="dialog" aria-controls="orderSheet"><span class="ob-title" id="obTitle">Заказ</span><span class="ob-sub" id="obSub"></span></button>
<button type="button" class="btn btn-gray ob-btn" id="orderClear">Очистить</button>
<button type="button" class="btn btn-primary ob-btn" id="orderAccept">Принять</button>
</div>

<div class="sheet" id="detailSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="detailName" tabindex="-1">
<div class="sheet-grabber"></div>
<div class="sheet-head"><span class="left"></span><h2>Рецепт</h2><button class="btn btn-plain right" type="button" data-close-sheet style="font-weight:700">Готово</button></div>
<div class="sheet-body" id="detailBody"></div>
</div></div>

<div class="sheet" id="orderSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="orderTitle" tabindex="-1">
<div class="sheet-grabber"></div>
<div class="sheet-head"><span class="left"></span><h2 id="orderTitle">Текущий заказ</h2><button class="btn btn-plain right" type="button" data-close-sheet style="font-weight:700">Готово</button></div>
<div class="sheet-body">
<p class="footnote ord-shift" id="orderShift"></p>
<div class="list" id="orderItems"></div>
<div class="list ord-total"><div class="cell"><span class="cell-body"><span class="cell-title">Итого</span><span class="cell-sub" id="orderCountText"></span></span><span class="cell-value price" id="orderTotal"></span></div></div>
<p class="section-footer">При принятии ингредиенты спишутся со склада. Этот же заказ открыт во вкладке «Заказы».</p>
<div class="button-row ord-actions"><button class="btn btn-gray" type="button" id="orderClear2">Очистить</button><button class="btn btn-primary" type="button" id="orderAccept2">${icon("check")}Принять заказ</button></div>
</div></div></div>

<div class="sheet sheet-full" id="editSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="editTitle" tabindex="-1">
<div class="sheet-grabber"></div>
<div class="sheet-head"><button class="btn btn-plain left" type="button" data-close-sheet>Отмена</button><h2 id="editTitle">Новый коктейль</h2><button class="btn btn-plain right" type="submit" form="cocktailForm" style="font-weight:700">Готово</button></div>
<div class="sheet-body"><form id="cocktailForm" class="rb-form" autocomplete="off" novalidate>
<div class="section"><div class="list">
<label class="field"><span>Название</span><input name="name" required maxlength="80" placeholder="Например, Негрони" autocapitalize="sentences"></label>
<label class="field"><span>Описание для гостя</span><textarea name="description" rows="2" placeholder="Коротко о вкусе"></textarea></label>
<label class="field"><span>Крепость</span><select name="strength" required><option value="Безалкогольный">Безалкогольный</option><option value="Лёгкий" selected>Лёгкий</option><option value="Средний">Средний</option><option value="Крепкий">Крепкий</option></select></label>
</div><p class="section-footer">Крепость гости видят в меню — по ней коктейль попадает на свою линию.</p></div>

<div class="section"><div class="section-header"><h2>Состав</h2></div>
<div class="list"><div id="recipeItems"></div><button type="button" class="cell ri-add" id="addIngredient">${icon("plus")}<span>Добавить ингредиент</span></button></div>
<p class="section-footer">Начните вводить название и выберите из списка. Если ингредиента ещё нет, он добавится в справочник с крепостью 0% — её можно поправить в «Ингредиентах».</p></div>

<div class="section"><div class="section-header"><h2>Приготовление</h2></div><div class="list">
<label class="field"><span>Способ приготовления</span><textarea name="method" rows="3" placeholder="Например: собрать в бокале со льдом, перемешать барной ложкой"></textarea></label>
<label class="field"><span>Инвентарь</span><textarea name="inventory" rows="2" placeholder="Джигер&#10;Барная ложка"></textarea></label>
</div><p class="section-footer">Инвентарь — по одному предмету на строку.</p></div>

<div class="section"><div class="section-header"><h2>Фото</h2></div><div class="list">
<input id="photoFile" class="vh" type="file" accept="image/*">
<label class="cell has-icon tappable photo-pick" for="photoFile"><span class="cell-icon">${icon("camera")}</span><span class="cell-body"><span class="cell-title" id="photoPickTitle">Выбрать фото</span><span class="cell-sub">Оригинал хранится целиком — для книги рецептов</span></span>${icon("chevronRight","cell-chevron")}</label>
<div id="photoPreview" class="photo-preview"></div>
</div>
<input name="photo_url" id="photoUrl" type="hidden"><input name="avatar_url" id="avatarUrl" type="hidden">
<div id="avatarCropPanel" hidden>
<div class="section"><div class="section-header"><h2>Кадр 4:5 для меню и кабинета</h2></div><div class="list crop-panel">
<div class="crop-stage"><canvas id="avatarCropCanvas" width="320" height="400" aria-label="Кадр 4:5: перетащите фото, чтобы выбрать часть"></canvas></div>
<label class="field"><span>Масштаб кадра</span><input id="avatarZoom" type="range" min="100" max="250" step="5" value="100"></label>
<div class="crop-actions"><span id="avatarCropStatus" class="footnote" role="status">Вертикальный кадр 4:5</span><button type="button" class="btn btn-tinted btn-sm" id="applyAvatarCrop">${icon("check")}Применить</button></div>
<div id="avatarPreview" class="avatar-preview"></div>
</div><p class="section-footer">Двигайте фото пальцем и меняйте масштаб — оригинал при этом не обрезается.</p></div>
</div></div>

<p class="footnote form-msg" id="msg" role="alert"></p>
<div class="form-actions"><button class="btn btn-primary btn-block" type="submit" id="saveBtn">Сохранить коктейль</button>
<button class="btn btn-danger btn-block" type="button" id="editDelete" hidden>${icon("trash")}Удалить коктейль</button></div>
</form></div></div></div>`,
      }).replace("</main>",()=>String.raw`</main>
<script>
(function(){
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ic=n=>'<svg class="ic" aria-hidden="true"><use href="#i-'+n+'"/></svg>';
const $=s=>document.querySelector(s);
const norm=s=>String(s??"").trim().toLocaleLowerCase("ru").replace(/ё/g,"е");
const UNIT={ml:"мл",g:"гр",pcs:"шт."};
const unitLabel=u=>UNIT[u]||String(u??"");
const fmtQty=v=>Number(v||0).toLocaleString("ru-RU",{maximumFractionDigits:2});
const fmtRub=v=>Math.round(Number(v||0)).toLocaleString("ru-RU")+" ₽";
const plural=(n,f)=>{const a=Math.abs(n)%100,b=a%10;return f[a>10&&a<20?2:b===1?0:b>1&&b<5?1:2]};
const LINES=[
  {key:"Безалкогольный",cls:"line-zero",title:"Без градуса",dots:0,label:"без алкоголя"},
  {key:"Лёгкий",cls:"line-light",title:"Лёгкие",dots:1,label:"лёгкий"},
  {key:"Средний",cls:"line-mid",title:"Средние",dots:2,label:"средний"},
  {key:"Крепкий",cls:"line-strong",title:"Крепкие",dots:3,label:"крепкий"},
];
const OTHER={key:"",cls:"line-other",title:"Без линии",dots:-1,label:"не указана"};
const lineOf=c=>LINES.find(l=>l.key===String(c.strength||"").trim())||OTHER;
const scaleHtml=L=>L.dots<0?"":'<span class="scale" role="img" aria-label="Крепость: '+L.label+'">'+(L.dots===0?'<i class="o"></i>':'<i></i>'.repeat(L.dots))+'</span>';

let cocktails=[],byId=new Map(),products=[],draft={shift:null,order:null,items:[]};
let loaded=false,pending=0,chain=Promise.resolve(),busy=false,detailId=0,gen=0;

const setCocktails=list=>{cocktails=Array.isArray(list)?list:[];byId=new Map(cocktails.map(c=>[Number(c.id),c]))};
const normDraft=d=>{d=d&&typeof d==="object"?d:{};d.items=Array.isArray(d.items)?d.items:[];recalc(d);return d};
function recalc(d){d.total_cocktails=d.items.reduce((n,x)=>n+Number(x.quantity||0),0);d.total_price=d.items.reduce((n,x)=>n+Number(x.quantity||0)*Number(x.price_rub||0),0)}
const qtyOf=id=>{const it=(draft.items||[]).find(x=>Number(x.cocktail_id)===Number(id));return it?Number(it.quantity||0):0};
const shortages=c=>(c&&c.recipe_items||[]).filter(i=>Number(i.stock_available||0)+0.000001<Number(i.quantity||0));
const shortText=list=>"Не хватает: "+list.map(i=>i.ingredient_name).join(", ");
const isOpen=id=>{const s=document.getElementById(id);return !!s&&s.classList.contains("open")};
function toastLong(m,isError){VIA.toast(m,isError);const t=document.getElementById("viaToast");if(t&&m.length>60){clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),5500)}}

/* ——— Список по линиям ——— */
function stepperHtml(c){
  const q=qtyOf(c.id),n=esc(c.name||c.cocktail_name||"коктейль"),id=Number(c.id||c.cocktail_id);
  return '<div class="stepper rb-stepper'+(q?"":" is-empty")+'" data-stepper="'+id+'">'+
    '<button type="button" class="st-minus" data-delta="-1" aria-label="Убрать «'+n+'»"'+(q?"":" disabled")+'>'+ic("minus")+'</button>'+
    '<span class="st-count" role="status">'+q+'<span class="vh"> в заказе</span></span>'+
    '<button type="button" class="st-plus" data-delta="1" aria-label="Добавить «'+n+'»">'+ic("plus")+'</button></div>';
}
function rowHtml(c){
  const L=lineOf(c),short=shortages(c),src=c.avatar_url||c.photo_url;
  const thumb=src?'<img class="thumb rb-thumb" src="'+esc(src)+'" alt="" loading="lazy" decoding="async">':'<span class="thumb thumb-ph rb-thumb">'+ic("glass")+'</span>';
  const ings=(c.recipe_items||[]).map(i=>i.ingredient_name).join(", ");
  const price=Number(c.price_rub||0)>0?'<span class="rb-price">'+fmtRub(c.price_rub)+'</span>':"";
  return '<div class="cell-wrap rb-row '+L.cls+(short.length?" is-short":"")+'" data-id="'+Number(c.id)+'">'+
    '<button type="button" class="cell rb-open" aria-haspopup="dialog">'+thumb+'<span class="cell-body"><span class="cell-title">'+esc(c.name)+'</span>'+
    '<span class="cell-sub rb-ings">'+esc(ings||"Состав не указан")+'</span>'+
    '<span class="rb-meta">'+scaleHtml(L)+price+'<span class="rb-short"'+(short.length?"":" hidden")+'>'+ic("warning")+'<span class="rb-short-t">'+esc(short.length?shortText(short):"")+'</span></span></span></span></button>'+
    stepperHtml(c)+'</div>';
}
function matches(c,q){
  if(!q)return true;
  const hay=[c.name,c.description].concat((c.recipe_items||[]).map(i=>i.ingredient_name)).join(" ");
  return norm(hay).includes(q);
}
function renderList(){
  const box=$("#lines"),q=norm($("#recipeSearch").value);
  box.removeAttribute("aria-busy");
  $("#clearSearch").hidden=!$("#recipeSearch").value;
  if(!cocktails.length){
    box.innerHTML='<div class="list rb-empty"><div class="empty-state">'+ic("book")+'<h3>Рецептов пока нет</h3><p>Добавьте первый коктейль — он сразу появится в гостевом меню.</p><button class="btn btn-tinted" type="button" data-new-cocktail>'+ic("plus")+'Новый коктейль</button></div></div>';
    $("#listFooter").textContent="";$("#searchStatus").textContent="";return;
  }
  const shown=cocktails.filter(c=>matches(c,q));
  const groups=LINES.concat([OTHER]).map(L=>({L,items:shown.filter(c=>lineOf(c)===L)})).filter(g=>g.items.length);
  box.innerHTML=groups.length?groups.map(g=>'<section class="rb-line '+g.L.cls+'" aria-labelledby="lh-'+g.L.cls+'"><div class="line-head"><span class="line-mark" aria-hidden="true"></span><h2 id="lh-'+g.L.cls+'">'+g.L.title+'</h2><span class="count">'+g.items.length+'</span></div><div class="list">'+g.items.map(rowHtml).join("")+'</div></section>').join("")
    :'<div class="list"><div class="empty-state">'+ic("search")+'<h3>Ничего не нашлось</h3><p>Попробуйте другое название или ингредиент.</p></div></div>';
  $("#searchStatus").textContent=q?(shown.length?"Найдено: "+shown.length:"Ничего не найдено"):"";
  $("#listFooter").textContent=q?"":"В книге "+cocktails.length+" "+plural(cocktails.length,["коктейль","коктейля","коктейлей"]);
}
function syncRows(){
  document.querySelectorAll("#lines .rb-row").forEach(row=>{
    const c=byId.get(Number(row.dataset.id));if(!c)return;
    const short=shortages(c),s=row.querySelector(".rb-short");
    row.classList.toggle("is-short",!!short.length);
    if(s){s.hidden=!short.length;s.querySelector(".rb-short-t").textContent=short.length?shortText(short):""}
  });
}
function syncSteppers(){
  document.querySelectorAll("[data-stepper]").forEach(st=>{
    const id=Number(st.dataset.stepper),q=qtyOf(id),c=byId.get(id),short=!!(c&&shortages(c).length);
    const minus=st.querySelector(".st-minus"),plus=st.querySelector(".st-plus"),cnt=st.querySelector(".st-count");
    st.classList.toggle("is-empty",!q);
    if(cnt.firstChild.nodeValue!==String(q))cnt.firstChild.nodeValue=String(q);
    if(!q&&document.activeElement===minus)plus.focus({preventScroll:true});
    minus.disabled=!q;
    plus.classList.toggle("is-short",short);
    const name=(c&&c.name)||((draft.items||[]).find(x=>Number(x.cocktail_id)===id)||{}).cocktail_name||"коктейль";
    plus.setAttribute("aria-label","Добавить «"+name+"»"+(short?" — не хватает ингредиентов":""));
  });
}

/* ——— Заказ (общий черновик с вкладкой «Заказы») ——— */
function reserve(c,delta){
  for(const ri of (c.recipe_items||[])){
    const iid=Number(ri.ingredient_id),used=Number(ri.quantity||0)*delta;
    for(const x of cocktails)for(const y of (x.recipe_items||[]))if(Number(y.ingredient_id)===iid)y.stock_available=Number(y.stock_available||0)-used;
  }
}
function applyLocal(id,delta){
  let it=draft.items.find(x=>Number(x.cocktail_id)===id);
  const c=byId.get(id);
  if(!it){if(delta<=0)return;it={cocktail_id:id,cocktail_name:c?c.name:"",quantity:0,price_rub:Number(c&&c.price_rub||0)};draft.items.push(it)}
  it.quantity=Math.max(0,Number(it.quantity||0)+delta);
  if(!it.quantity)draft.items=draft.items.filter(x=>x!==it);
  recalc(draft);
  if(c)reserve(c,delta);
  syncAll();
}
function changeOrder(id,delta){
  if(busy)return;
  if(delta<0&&qtyOf(id)<=0)return;
  // Если по нашим данным ингредиентов не хватает — не рисуем заранее, а сверяем остатки:
  // склад могли пополнить с другого телефона. Не хватает и на сервере — объясняем чего.
  const optimistic=!(delta>0&&shortages(byId.get(id)).length);
  gen++;
  if(optimistic)applyLocal(id,delta);
  pending++;
  chain=chain.then(async()=>{
    try{
      if(!optimistic){
        const cr=await fetch("/api/cocktails");
        if(cr.ok)applyCocktails(await cr.json());
        const sh=shortages(byId.get(id));
        if(sh.length)throw new Error(shortText(sh)+". Пополните склад, чтобы добавить.");
      }
      const r=await fetch("/api/bar/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cocktail_id:id,delta})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||"Не удалось изменить заказ. Попробуйте ещё раз.");
      if(!optimistic)applyLocal(id,delta);
    }catch(e){
      if(optimistic)applyLocal(id,-delta);
      toastLong(e&&e.message||"Нет связи. Попробуйте ещё раз.",true);
    }finally{
      pending--;gen++;
      if(!pending)refresh();
    }
  });
}
function setBusy(on){busy=on;["#orderAccept","#orderClear","#orderAccept2","#orderClear2"].forEach(s=>{const b=$(s);if(b)b.disabled=on})}
async function acceptOrder(){
  if(busy||!(draft.items||[]).length)return;
  setBusy(true);gen++;
  try{
    await chain;
    const r=await fetch("/api/bar/order/accept",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"Не удалось принять заказ. Попробуйте ещё раз.");
    VIA.closeSheet("orderSheet");
    VIA.toast("Заказ"+(d.order_id?" №"+d.order_id:"")+" принят, ингредиенты списаны");
  }catch(e){toastLong(e&&e.message||"Нет связи. Попробуйте ещё раз.",true)}
  finally{setBusy(false);await refresh()}
}
async function clearOrder(){
  if(busy||!(draft.items||[]).length)return;
  if(!confirm("Очистить текущий заказ?"))return;
  setBusy(true);gen++;
  for(const it of draft.items){const c=byId.get(Number(it.cocktail_id));if(c)reserve(c,-Number(it.quantity||0))}
  draft.items=[];recalc(draft);syncAll();VIA.closeSheet("orderSheet");
  try{await chain;const r=await fetch("/api/bar/order",{method:"DELETE"});if(!r.ok)throw 0;VIA.toast("Заказ очищен")}
  catch(e){VIA.toast("Не удалось очистить заказ. Попробуйте ещё раз.",true)}
  finally{setBusy(false);await refresh()}
}
function syncOrder(){
  const items=draft.items||[],n=Number(draft.total_cocktails||0),bar=$("#orderBar");
  bar.hidden=!items.length;
  document.body.classList.toggle("has-order",!!items.length);
  $("#obTitle").textContent="Заказ: "+n+" · "+fmtRub(draft.total_price);
  $("#obSub").textContent=items.map(x=>x.cocktail_name+" ×"+x.quantity).join(", ");
  $("#orderOpen").setAttribute("aria-label","Текущий заказ: "+n+" "+plural(n,["коктейль","коктейля","коктейлей"])+" на "+fmtRub(draft.total_price)+". Открыть состав");
  if(isOpen("orderSheet")){if(!items.length)VIA.closeSheet("orderSheet");else renderOrderSheet(false)}
}
function renderOrderSheet(full){
  const items=draft.items||[],box=$("#orderItems");
  const ids=items.map(x=>Number(x.cocktail_id)).join(",");
  if(full||box.dataset.ids!==ids){
    const hadFocus=box.contains(document.activeElement);
    box.dataset.ids=ids;
    box.innerHTML=items.map(x=>{const c=byId.get(Number(x.cocktail_id))||{id:x.cocktail_id,name:x.cocktail_name};return '<div class="cell ord-item" data-item="'+Number(x.cocktail_id)+'"><span class="cell-body"><span class="cell-title">'+esc(x.cocktail_name||c.name)+'</span><span class="cell-sub ord-sub num"></span></span>'+stepperHtml(c)+'</div>'}).join("");
    if(hadFocus)$("#orderSheet .sheet-panel").focus({preventScroll:true});
  }
  items.forEach(x=>{const el=box.querySelector('[data-item="'+Number(x.cocktail_id)+'"] .ord-sub');if(el)el.textContent=Number(x.price_rub||0)>0?fmtRub(x.price_rub)+" × "+x.quantity+" = "+fmtRub(Number(x.price_rub||0)*Number(x.quantity||0)):"Цена пока не рассчитана"});
  $("#orderShift").textContent=draft.shift&&draft.shift.id?"Смена №"+draft.shift.id+(draft.order&&draft.order.id?" · черновик заказа №"+draft.order.id:""):"";
  const n=Number(draft.total_cocktails||0);
  $("#orderCountText").textContent=n+" "+plural(n,["коктейль","коктейля","коктейлей"]);
  $("#orderTotal").textContent=fmtRub(draft.total_price);
  syncSteppers();
}
function openOrderSheet(){rememberOpener($("#orderOpen"));renderOrderSheet(true);VIA.openSheet("orderSheet");focusPanel("orderSheet")}
function focusPanel(id){setTimeout(()=>{const p=document.querySelector("#"+id+" .sheet-panel");if(p&&isOpen(id))p.focus({preventScroll:true})},320)}
// Когда шторка закрылась, фокус возвращается туда, откуда её открыли (а не в начало страницы).
let opener=null;
function rememberOpener(el){opener=el&&el!==document.body?el:null}
const watchSheet=new MutationObserver(()=>{
  if(document.querySelector(".sheet.open"))return;
  const a=document.activeElement;
  if(a&&a!==document.body&&!a.closest(".sheet"))return;
  if(opener&&opener.isConnected&&!opener.closest(".sheet"))opener.focus({preventScroll:true});
});
["#detailSheet","#orderSheet","#editSheet"].forEach(s=>watchSheet.observe($(s),{attributes:true,attributeFilter:["class"]}));

/* ——— Карточка рецепта ——— */
function stockLine(i){
  const stock=Math.max(0,Number(i.stock_available||0)),u=unitLabel(i.unit);
  return (Number(i.stock_available||0)+0.000001<Number(i.quantity||0)?"Не хватает — свободно ":"Свободно ")+fmtQty(stock)+" "+u;
}
function renderDetail(){
  const c=byId.get(detailId),body=$("#detailBody");
  if(!c){VIA.closeSheet("detailSheet");return}
  const L=lineOf(c),short=shortages(c),items=c.recipe_items||[],keepScroll=body.scrollTop;
  let h="";
  if(c.photo_url)h+='<img class="dt-photo" src="'+esc(c.photo_url)+'" alt="Фото: '+esc(c.name)+'" decoding="async">';
  h+='<h3 class="dt-name serif" id="detailName">'+esc(c.name)+'</h3>';
  h+='<div class="dt-meta"><span class="badge line '+L.cls+'">'+scaleHtml(L)+esc(L.key||"Крепость не указана")+'</span>'+(Number(c.price_rub||0)>0?'<span class="dt-price">'+fmtRub(c.price_rub)+'</span>':"")+'</div>';
  if(c.description)h+='<p class="dt-desc">'+esc(c.description)+'</p>';
  h+='<div class="dt-warn" id="dtWarn"'+(short.length?"":" hidden")+'>'+ic("warning")+'<span id="dtWarnText">'+esc(short.length?shortText(short)+". Пополните склад, чтобы добавить в заказ.":"")+'</span></div>';
  h+='<div class="list dt-order"><div class="cell"><span class="cell-body"><span class="cell-title">В заказе</span><span class="cell-sub">Ингредиенты резервируются до принятия</span></span>'+stepperHtml(c)+'</div></div>';
  h+='<div class="section"><div class="section-header"><h2>Состав</h2><span>'+items.length+" "+plural(items.length,["ингредиент","ингредиента","ингредиентов"])+'</span></div>';
  h+=items.length?'<div class="list dt-panel"><div class="route '+L.cls+'">'+items.map(i=>'<div class="route-stop'+(Number(i.stock_available||0)+0.000001<Number(i.quantity||0)?" short":"")+'" data-iid="'+Number(i.ingredient_id)+'"><span class="station"></span><div class="route-body"><div class="rs-top"><span class="rs-name">'+esc(i.ingredient_name)+'</span><span class="rs-qty">'+fmtQty(i.quantity)+" "+unitLabel(i.unit)+'</span></div><div class="rs-stock">'+stockLine(i)+'</div></div></div>').join("")+'</div></div><p class="section-footer">Свободно — остаток на складе за вычетом текущего заказа.</p>'
    :'<div class="list dt-panel"><p class="dt-empty">Состав пока не указан.</p></div>';
  h+='</div>';
  const steps=String(c.method||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if(steps.length)h+='<div class="section"><div class="section-header"><h2>Приготовление</h2></div><div class="list dt-panel">'+(steps.length>1?'<div class="route '+L.cls+'">'+steps.map(s=>'<div class="route-stop"><span class="station"></span><div class="route-body">'+esc(s)+'</div></div>').join("")+'</div>':'<p class="dt-text">'+esc(steps[0])+'</p>')+'</div></div>';
  const tools=String(c.glass||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if(tools.length)h+='<div class="section"><div class="section-header"><h2>Инвентарь</h2></div><div class="list">'+tools.map(t=>'<div class="cell"><span class="cell-body"><span class="cell-title">'+esc(t)+'</span></span></div>').join("")+'</div></div>';
  h+='<div class="button-row dt-actions"><button class="btn btn-tinted" type="button" id="detailEdit">'+ic("pencil")+'Изменить</button><button class="btn btn-danger" type="button" id="detailDelete">'+ic("trash")+'Удалить</button></div>';
  body.innerHTML=h;body.scrollTop=keepScroll;
}
function syncDetail(){
  if(!detailId||!isOpen("detailSheet"))return;
  const c=byId.get(detailId);if(!c)return;
  const short=shortages(c),w=$("#dtWarn");
  if(w){w.hidden=!short.length;$("#dtWarnText").textContent=short.length?shortText(short)+". Пополните склад, чтобы добавить в заказ.":""}
  (c.recipe_items||[]).forEach(i=>{const st=document.querySelector('#detailBody .route-stop[data-iid="'+Number(i.ingredient_id)+'"]');if(!st)return;st.classList.toggle("short",Number(i.stock_available||0)+0.000001<Number(i.quantity||0));st.querySelector(".rs-stock").textContent=stockLine(i)});
}
function openDetail(id){detailId=Number(id);rememberOpener(document.querySelector('.rb-row[data-id="'+detailId+'"] .rb-open'));$("#detailBody").scrollTop=0;renderDetail();VIA.openSheet("detailSheet");focusPanel("detailSheet")}
async function deleteCocktail(id){
  const c=byId.get(Number(id));if(!c)return;
  if(!confirm("Удалить коктейль «"+c.name+"»? Его рецепт и фотография также будут удалены."))return;
  try{
    const r=await fetch("/api/cocktails",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({id:c.id})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"Не удалось удалить коктейль. Попробуйте ещё раз.");
    VIA.closeSheet("detailSheet");VIA.closeSheet("editSheet");detailId=0;
    VIA.toast("Коктейль «"+c.name+"» удалён");
    await loadAll();
  }catch(e){toastLong(e&&e.message||"Нет связи. Попробуйте ещё раз.",true)}
}

function syncAll(){syncRows();syncSteppers();syncOrder();syncDetail()}

/* ——— Загрузка и обновление ——— */
const sig=list=>JSON.stringify((list||[]).map(c=>[c.id,c.name,c.description,c.strength,c.price_rub,c.photo_url,c.avatar_url,c.glass,c.method,(c.recipe_items||[]).map(i=>[i.ingredient_id,i.quantity,i.ingredient_name,i.unit])]));
function focusKey(){
  const a=document.activeElement;if(!a||a===document.body||!a.closest)return null;
  const st=a.closest("[data-stepper]"),sheet=a.closest(".sheet");
  if(st)return {st:st.dataset.stepper,cls:a.classList.contains("st-minus")?"st-minus":"st-plus",scope:sheet?sheet.id:""};
  const row=a.closest(".rb-row");return row?{row:row.dataset.id}:null;
}
function restoreFocus(k){
  if(!k||(document.activeElement&&document.activeElement!==document.body))return;
  const root=k.scope?document.getElementById(k.scope):$("#lines");
  const el=k.st?(root&&(root.querySelector('[data-stepper="'+k.st+'"] .'+k.cls+':not(:disabled)')||root.querySelector('[data-stepper="'+k.st+'"] .st-plus'))):document.querySelector('.rb-row[data-id="'+k.row+'"] .rb-open');
  if(el)el.focus({preventScroll:true});
}
function applyCocktails(list){
  const structural=sig(list)!==sig(cocktails);
  setCocktails(list);
  if(!structural)return;
  const k=focusKey();
  renderList();
  if(detailId&&isOpen("detailSheet"))renderDetail();
  restoreFocus(k);
}
async function loadAll(){
  try{
    const [cr,pr,or]=await Promise.all([fetch("/api/cocktails"),fetch("/api/ingredients"),fetch("/api/bar/order")]);
    if(!cr.ok)throw new Error("cocktails");
    const list=await cr.json();
    if(pr.ok)products=await pr.json().catch(()=>products);
    if(or.ok)draft=normDraft(await or.json().catch(()=>({})));
    setCocktails(list);loaded=true;
    renderList();
    if(detailId&&isOpen("detailSheet"))renderDetail();
    syncAll();
  }catch(e){
    if(loaded){VIA.toast("Не удалось обновить рецепты. Проверьте интернет.",true);return}
    const box=$("#lines");box.removeAttribute("aria-busy");
    box.innerHTML='<div class="list"><div class="empty-state">'+ic("warning")+'<h3>Не удалось загрузить рецепты</h3><p>Проверьте интернет и попробуйте ещё раз.</p><button class="btn btn-tinted" type="button" data-retry>'+ic("refresh")+'Повторить</button></div></div>';
  }
}
// Сверка с сервером. Ответ, пришедший после новых нажатий, устарел — его не применяем,
// а перезапрашиваем, когда очередь нажатий опустеет.
let refreshing=false,again=false;
async function refresh(){
  if(!loaded)return;
  if(refreshing){again=true;return}
  refreshing=true;again=false;
  const g=gen;
  try{
    const [or,cr]=await Promise.all([fetch("/api/bar/order"),fetch("/api/cocktails")]);
    const d=or.ok?await or.json().catch(()=>null):null,list=cr.ok?await cr.json().catch(()=>null):null;
    if(pending||g!==gen){again=true;return}
    if(d)draft=normDraft(d);
    if(list)applyCocktails(list);
    syncAll();
  }catch(e){}
  finally{refreshing=false;if(again&&!pending){again=false;refresh()}}
}
setInterval(()=>{if(!document.hidden&&!pending&&!busy&&!isOpen("editSheet"))refresh()},20000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh()});
window.addEventListener("pageshow",e=>{if(e.persisted)refresh()});

/* ——— События списка и шторок ——— */
$("#lines").addEventListener("click",e=>{
  const st=e.target.closest("[data-delta]");
  if(st){const box=st.closest("[data-stepper]");changeOrder(Number(box.dataset.stepper),Number(st.dataset.delta));return}
  const open=e.target.closest(".rb-open");
  if(open){openDetail(open.closest(".rb-row").dataset.id);return}
  if(e.target.closest("[data-new-cocktail]")){openEditor(null);return}
  if(e.target.closest("[data-retry]")){$("#lines").innerHTML='<div class="list rb-skel"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';loadAll()}
});
["#detailSheet","#orderSheet"].forEach(s=>$(s).addEventListener("click",e=>{
  const st=e.target.closest("[data-delta]");
  if(st){changeOrder(Number(st.closest("[data-stepper]").dataset.stepper),Number(st.dataset.delta));return}
  if(e.target.closest("#detailEdit")){openEditor(byId.get(detailId),true);return}
  if(e.target.closest("#detailDelete"))deleteCocktail(detailId);
}));
const search=$("#recipeSearch");
search.addEventListener("input",renderList);
$("#clearSearch").onclick=()=>{search.value="";renderList();search.focus()};
$("#orderOpen").onclick=openOrderSheet;
$("#orderAccept").onclick=acceptOrder;$("#orderAccept2").onclick=acceptOrder;
$("#orderClear").onclick=clearOrder;$("#orderClear2").onclick=clearOrder;
$("#newCocktailBtn").onclick=()=>openEditor(null);

/* ——— Редактор коктейля ——— */
const form=$("#cocktailForm"),msg=$("#msg"),recipeBox=$("#recipeItems");
let editId=0,returnTo=0,saving=false,needAvatar=false,riSeq=0;
const setMsg=(t,isError)=>{msg.textContent=t||"";msg.classList.toggle("error",!!isError)};

// Кадрирование вертикального фото 4:5 (аватар для меню и кабинета гостя).
let cropSourceImage=null,cropZoom=1,cropOffsetX=0,cropOffsetY=0,cropPointer=null,avatarCropBlob=null,cropObjectUrl="",cropLoadPromise=Promise.resolve(false);
const cropCanvas=$("#avatarCropCanvas"),cropCtx=cropCanvas.getContext("2d"),cropStatus=$("#avatarCropStatus");
function clampCropOffset(){if(!cropSourceImage)return;const scale=Math.max(cropCanvas.width/cropSourceImage.naturalWidth,cropCanvas.height/cropSourceImage.naturalHeight)*cropZoom;const w=cropSourceImage.naturalWidth*scale,h=cropSourceImage.naturalHeight*scale,baseX=(cropCanvas.width-w)/2,baseY=(cropCanvas.height-h)/2;cropOffsetX=Math.min(-baseX,Math.max(cropCanvas.width-w-baseX,cropOffsetX));cropOffsetY=Math.min(-baseY,Math.max(cropCanvas.height-h-baseY,cropOffsetY))}
function drawAvatarCrop(){if(!cropSourceImage)return;const scale=Math.max(cropCanvas.width/cropSourceImage.naturalWidth,cropCanvas.height/cropSourceImage.naturalHeight)*cropZoom,w=cropSourceImage.naturalWidth*scale,h=cropSourceImage.naturalHeight*scale;clampCropOffset();cropCtx.clearRect(0,0,cropCanvas.width,cropCanvas.height);cropCtx.drawImage(cropSourceImage,(cropCanvas.width-w)/2+cropOffsetX,(cropCanvas.height-h)/2+cropOffsetY,w,h)}
function loadCropSource(src,isObjectUrl){if(cropObjectUrl&&!isObjectUrl){URL.revokeObjectURL(cropObjectUrl);cropObjectUrl=""}avatarCropBlob=null;cropStatus.textContent="Сдвиньте фото и нажмите «Применить»";$("#avatarCropPanel").hidden=!src;if(!src){cropSourceImage=null;cropLoadPromise=Promise.resolve(false);return cropLoadPromise}cropLoadPromise=new Promise(resolve=>{const img=new Image();img.onload=()=>{cropSourceImage=img;cropZoom=1;cropOffsetX=0;cropOffsetY=0;$("#avatarZoom").value="100";drawAvatarCrop();resolve(true)};img.onerror=()=>{cropSourceImage=null;resolve(false)};img.src=src});return cropLoadPromise}
function captureAvatarCrop(){return new Promise(resolve=>cropCanvas.toBlob(blob=>resolve(blob),"image/webp",.9))}
function markCropChanged(){avatarCropBlob=null;needAvatar=true;cropStatus.textContent="Кадр изменён — сохранится вместе с коктейлем"}
cropCanvas.addEventListener("pointerdown",e=>{if(!cropSourceImage)return;cropPointer={x:e.clientX,y:e.clientY,ox:cropOffsetX,oy:cropOffsetY};try{cropCanvas.setPointerCapture(e.pointerId)}catch(_){}});
cropCanvas.addEventListener("pointermove",e=>{if(!cropPointer)return;const rect=cropCanvas.getBoundingClientRect(),sx=cropCanvas.width/rect.width,sy=cropCanvas.height/rect.height;cropOffsetX=cropPointer.ox+(e.clientX-cropPointer.x)*sx;cropOffsetY=cropPointer.oy+(e.clientY-cropPointer.y)*sy;markCropChanged();drawAvatarCrop()});
for(const ev of ["pointerup","pointercancel","lostpointercapture"])cropCanvas.addEventListener(ev,()=>{cropPointer=null});
$("#avatarZoom").addEventListener("input",e=>{cropZoom=Number(e.target.value)/100;markCropChanged();drawAvatarCrop()});
$("#applyAvatarCrop").onclick=async()=>{if(!cropSourceImage){cropStatus.textContent="Сначала выберите фото";return}avatarCropBlob=await captureAvatarCrop();if(!avatarCropBlob){cropStatus.textContent="Не удалось подготовить кадр";return}$("#avatarPreview").innerHTML='<img src="'+cropCanvas.toDataURL("image/webp",.9)+'" alt="Кадр 4:5 для меню"><span class="footnote">Так коктейль будет выглядеть в меню</span>';cropStatus.textContent="Кадр готов"};

const photoImg=(src,alt)=>'<img src="'+esc(src)+'" alt="'+esc(alt)+'">';
$("#photoFile").onchange=()=>{
  const file=$("#photoFile").files[0];if(!file)return;
  if(cropObjectUrl)URL.revokeObjectURL(cropObjectUrl);
  cropObjectUrl=URL.createObjectURL(file);needAvatar=true;
  $("#photoPreview").innerHTML='<img src="'+cropObjectUrl+'" alt="Новое фото коктейля">';
  $("#photoPickTitle").textContent="Заменить фото";
  $("#avatarPreview").innerHTML="";
  loadCropSource(cropObjectUrl,true).then(ok=>{if(!ok)cropStatus.textContent="Не удалось открыть изображение — выберите другое"});
};

// Строки состава: поиск по справочнику + новые названия прямо в строке.
function rowInfo(row){
  const input=row.querySelector(".ri-search"),name=input.value.trim(),qn=norm(name);
  let p=null;
  if(row.dataset.id)p=products.find(x=>String(x.id)===row.dataset.id&&norm(x.name)===qn)||null;
  if(!p&&row._fixed&&norm(row._fixed.name)===qn)p=row._fixed;
  if(!p&&qn)p=products.find(x=>norm(x.name)===qn)||null;
  const raw=row.querySelector(".ri-q").value.trim().replace(",","."),qty=raw===""?NaN:Number(raw);
  return {row,input,name,p,isNew:!!name&&!p,unit:p?p.unit:(row.dataset.unit||"ml"),qty,raw};
}
function refreshRow(row){
  const info=rowInfo(row),sugg=row.querySelector(".ri-sugg");
  row.querySelector(".ri-unit").textContent="Кол-во, "+unitLabel(info.unit);
  row.querySelector(".ri-new").hidden=!(info.isNew&&sugg.hidden);
  row.querySelector(".ri-remove").setAttribute("aria-label",info.name?"Убрать «"+info.name+"»":"Убрать строку");
  row.querySelectorAll("[data-unit]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.unit===(row.dataset.unit||"ml"))));
}
function hideSugg(row){const s=row.querySelector(".ri-sugg");s.hidden=true;s.innerHTML="";row.querySelector(".ri-search").setAttribute("aria-expanded","false");refreshRow(row)}
function fillSugg(row){
  const input=row.querySelector(".ri-search"),sugg=row.querySelector(".ri-sugg"),q=norm(input.value);
  if(!q){hideSugg(row);return}
  const found=products.filter(p=>norm(p.name).includes(q)).sort((a,b)=>(norm(a.name).startsWith(q)?0:1)-(norm(b.name).startsWith(q)?0:1)).slice(0,6);
  const exact=products.some(p=>norm(p.name)===q);
  sugg.innerHTML=found.map(p=>'<button type="button" role="option" class="sugg" data-pick="'+p.id+'"><span>'+esc(p.name)+'</span><span class="sugg-unit">'+unitLabel(p.unit)+'</span></button>').join("")+
    (exact?"":'<button type="button" role="option" class="sugg sugg-new" data-pick-new>'+ic("plus")+'<span>Новый ингредиент «'+esc(input.value.trim())+'»</span></button>');
  sugg.hidden=false;input.setAttribute("aria-expanded","true");
  row.querySelector(".ri-new").hidden=true;
}
function addRow(initial){
  const n=++riSeq,row=document.createElement("div");row.className="ri";
  row.innerHTML='<div class="ri-main"><label class="field"><span>Ингредиент</span><input class="ri-search" type="text" placeholder="Начните вводить" autocomplete="off" autocapitalize="sentences" enterkeyhint="next" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="riSugg'+n+'"></label>'+
    '<label class="field"><span class="ri-unit">Кол-во, мл</span><input class="ri-q" type="text" inputmode="decimal" placeholder="0" autocomplete="off"></label>'+
    '<button type="button" class="icon-btn ri-remove" aria-label="Убрать строку">'+ic("close")+'</button></div>'+
    '<div class="ri-sugg" id="riSugg'+n+'" role="listbox" aria-label="Подходящие ингредиенты" hidden></div>'+
    '<div class="ri-new" hidden><span>Новый ингредиент, единица:</span><div class="segmented" role="group" aria-label="Единица нового ингредиента"><button type="button" data-unit="ml" aria-pressed="true">мл</button><button type="button" data-unit="g" aria-pressed="false">гр</button><button type="button" data-unit="pcs" aria-pressed="false">шт.</button></div></div>';
  const input=row.querySelector(".ri-search");
  input.addEventListener("input",()=>{row.dataset.id="";fillSugg(row);refreshRow(row)});
  input.addEventListener("focus",()=>{if(input.value.trim()&&!rowInfo(row).p)fillSugg(row)});
  row.querySelector(".ri-q").addEventListener("focus",()=>{if(!row.querySelector(".ri-sugg").hidden)hideSugg(row)});
  input.addEventListener("keydown",e=>{
    const sugg=row.querySelector(".ri-sugg");
    if(e.key==="Escape"&&!sugg.hidden){e.stopPropagation();hideSugg(row)}
    else if(e.key==="Enter"){e.preventDefault();const first=sugg.hidden?null:sugg.querySelector("[data-pick]");if(first)first.click();else{hideSugg(row);row.querySelector(".ri-q").focus()}}
    else if(e.key==="ArrowDown"&&!sugg.hidden){e.preventDefault();const f=sugg.querySelector("button");if(f)f.focus()}
  });
  row.querySelector(".ri-sugg").addEventListener("keydown",e=>{
    const b=e.target.closest("button");if(!b)return;
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();const t=e.key==="ArrowDown"?b.nextElementSibling:b.previousElementSibling;(t||input).focus()}
    else if(e.key==="Escape"){e.stopPropagation();hideSugg(row);input.focus()}
  });
  row.querySelector(".ri-sugg").addEventListener("click",e=>{
    const pick=e.target.closest("[data-pick]");
    if(pick){const p=products.find(x=>String(x.id)===pick.dataset.pick);if(p){row.dataset.id=String(p.id);input.value=p.name}}
    else if(!e.target.closest("[data-pick-new]"))return;
    hideSugg(row);row.querySelector(".ri-q").focus();
  });
  row.querySelector(".ri-new").addEventListener("click",e=>{const b=e.target.closest("[data-unit]");if(!b)return;row.dataset.unit=b.dataset.unit;refreshRow(row)});
  row.querySelector(".ri-remove").onclick=()=>{const next=row.nextElementSibling||row.previousElementSibling;row.remove();const f=next?next.querySelector(".ri-search"):$("#addIngredient");if(f)f.focus()};
  recipeBox.appendChild(row);
  if(initial){
    const p=products.find(x=>Number(x.id)===Number(initial.ingredient_id));
    row._fixed={id:Number(initial.ingredient_id),name:initial.ingredient_name||(p&&p.name)||"",unit:initial.unit||(p&&p.unit)||"ml"};
    input.value=p?p.name:row._fixed.name;row.dataset.id=String(initial.ingredient_id);
    row.querySelector(".ri-q").value=fmtQty(initial.quantity).replace(/\s/g,"");
  }
  refreshRow(row);
  return row;
}
document.addEventListener("pointerdown",e=>{document.querySelectorAll(".ri-sugg:not([hidden])").forEach(s=>{const row=s.closest(".ri");if(!row.contains(e.target))hideSugg(row)})});
$("#addIngredient").onclick=()=>addRow(null).querySelector(".ri-search").focus();

function resetCocktailForm(){
  form.reset();editId=0;needAvatar=false;
  recipeBox.innerHTML="";
  $("#photoUrl").value="";$("#avatarUrl").value="";$("#photoFile").value="";
  $("#photoPreview").innerHTML="";$("#avatarPreview").innerHTML="";$("#avatarCropPanel").hidden=true;
  $("#photoPickTitle").textContent="Выбрать фото";
  if(cropObjectUrl){URL.revokeObjectURL(cropObjectUrl);cropObjectUrl=""}
  cropSourceImage=null;avatarCropBlob=null;cropZoom=1;cropOffsetX=0;cropOffsetY=0;cropLoadPromise=Promise.resolve(false);
  setMsg("");$("#editTitle").textContent="Новый коктейль";$("#saveBtn").textContent="Сохранить коктейль";$("#editDelete").hidden=true;
}
function openEditor(c,fromDetail){
  resetCocktailForm();
  const nameInput=form.elements.name;
  returnTo=fromDetail&&c?Number(c.id):0;
  if(c){
    editId=Number(c.id);
    for(const n of ["name","description","method"])form.elements[n].value=c[n]||"";
    form.elements.strength.value=LINES.some(l=>l.key===c.strength)?c.strength:"Лёгкий";
    form.elements.inventory.value=c.glass||"";
    $("#photoUrl").value=c.photo_url||"";$("#avatarUrl").value=c.avatar_url||"";
    if(c.photo_url){$("#photoPreview").innerHTML=photoImg(c.photo_url,"Оригинал фото");$("#photoPickTitle").textContent="Заменить фото"}
    if(c.avatar_url||c.photo_url)$("#avatarPreview").innerHTML=photoImg(c.avatar_url||c.photo_url,"Текущий кадр для меню")+'<span class="footnote">Текущий кадр в меню</span>';
    loadCropSource(c.photo_url||c.avatar_url||"");
    (c.recipe_items||[]).forEach(i=>addRow(i));
    if(!(c.recipe_items||[]).length)addRow(null);
    $("#editTitle").textContent="Изменить коктейль";$("#saveBtn").textContent="Сохранить изменения";$("#editDelete").hidden=false;
    nameInput.removeAttribute("autofocus");
  }else{addRow(null);nameInput.setAttribute("autofocus","")}
  $("#editSheet .sheet-body").scrollTop=0;
  rememberOpener(c?document.querySelector('.rb-row[data-id="'+Number(c.id)+'"] .rb-open'):$("#newCocktailBtn"));
  if(isOpen("detailSheet"))VIA.closeSheet("detailSheet");
  VIA.openSheet("editSheet");
  if(c)focusPanel("editSheet");
  fetch("/api/ingredients").then(r=>r.ok?r.json():null).then(d=>{if(Array.isArray(d)){products=d;recipeBox.querySelectorAll(".ri").forEach(refreshRow)}}).catch(()=>{});
}
$("#editDelete").onclick=()=>{if(editId)deleteCocktail(editId)};

async function uploadPhoto(file){
  const up=new FormData();up.append("file",file);
  const r=await fetch("/api/cocktail-photo",{method:"POST",body:up}),d=await r.json().catch(()=>({}));
  if(!r.ok||!d.url)throw new Error(d.error||"не удалось загрузить");
  return d.url;
}
form.onsubmit=async e=>{
  e.preventDefault();
  if(saving)return;
  const fail=(t,el)=>{setMsg(t,true);if(el)el.focus();return false};
  if(!form.elements.name.value.trim())return fail("Введите название коктейля.",form.elements.name);
  const rows=[...recipeBox.querySelectorAll(".ri")].map(rowInfo);
  const used=rows.filter(r=>r.name||r.raw);
  for(const r of used){
    if(!r.name)return fail("Укажите ингредиент или уберите пустую строку.",r.input);
    if(!(r.qty>0))return fail("Укажите количество: «"+r.name+"».",r.row.querySelector(".ri-q"));
  }
  if(!used.length&&rows.length)return fail("Выберите ингредиент и укажите количество.",rows[0].input);
  const seen=new Set();
  for(const r of used){const k=r.p?"id"+r.p.id:"new"+norm(r.name)+r.unit;if(seen.has(k))return fail("«"+r.name+"» указан дважды — оставьте одну строку.",r.input);seen.add(k)}
  saving=true;form.querySelectorAll("[type=submit]").forEach(b=>b.disabled=true);$("#editSheet .sheet-head .right").disabled=true;
  try{
    for(const r of used.filter(x=>x.isNew)){
      setMsg("Добавляем «"+r.name+"» в справочник…");
      const res=await fetch("/api/ingredients",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:r.name,unit:r.unit,strength_percent:0})});
      const d=await res.json().catch(()=>({}));
      if(!res.ok||!d.id)throw new Error("Не удалось добавить «"+r.name+"»: "+(d.error||"попробуйте ещё раз"));
      r.p={id:Number(d.id),name:r.name,unit:r.unit};r.row.dataset.id=String(d.id);products.push(r.p);r.isNew=false;refreshRow(r.row);
    }
    const file=$("#photoFile").files[0];
    if(file){
      setMsg("Загружаем фото…");
      let url;try{url=await uploadPhoto(file)}catch(err){throw new Error("Фото не загрузилось: "+err.message)}
      $("#photoUrl").value=url;$("#photoFile").value="";
      $("#photoPreview").innerHTML=photoImg(url,"Оригинал фото");
    }
    if(needAvatar||avatarCropBlob){
      setMsg("Готовим кадр 4:5…");
      if(!avatarCropBlob){const ready=await cropLoadPromise;if(ready)avatarCropBlob=await captureAvatarCrop()}
      if(!avatarCropBlob)throw new Error("Не удалось подготовить кадр 4:5. Выберите фото ещё раз.");
      let url;try{url=await uploadPhoto(new File([avatarCropBlob],"cocktail-avatar.webp",{type:"image/webp"}))}catch(err){throw new Error("Кадр не загрузился: "+err.message)}
      $("#avatarUrl").value=url;avatarCropBlob=null;needAvatar=false;
      $("#avatarPreview").innerHTML=photoImg(url,"Кадр 4:5 для меню")+'<span class="footnote">Кадр сохранён</span>';
    }
    setMsg("Сохраняем…");
    const body=Object.fromEntries(new FormData(form).entries());
    body.recipe_items=used.map(r=>({ingredient_id:Number(r.p.id),quantity:r.qty}));
    if(body.photo_url)body.photo_url=String(body.photo_url);
    const r=await fetch("/api/cocktails",{method:editId?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(editId?{...body,id:editId}:body)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error("Не удалось сохранить: "+(data.error||"попробуйте ещё раз"));
    const wasEdit=!!editId,back=returnTo;
    VIA.closeSheet("editSheet");
    VIA.toast(wasEdit?"Изменения сохранены":"Коктейль «"+body.name.trim()+"» добавлен");
    await loadAll();
    resetCocktailForm();
    if(back&&byId.has(back))openDetail(back);
  }catch(err){setMsg(err&&err.message||"Нет связи. Попробуйте ещё раз.",true)}
  finally{saving=false;form.querySelectorAll("[type=submit]").forEach(b=>b.disabled=false);$("#editSheet .sheet-head .right").disabled=false}
};

loadAll();
})();
</script>`));



      // ═══════ route-block: /bar/ingredients ═══════ (agents: edit only inside your own block)

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


      // ═══════ route-block: /bar/stock ═══════ (agents: edit only inside your own block)

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


      // ═══════ route-block: /menu ═══════ (agents: edit only inside your own block)

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


      // ═══════ route-block: /bar/shop ═══════ (agents: edit only inside your own block)

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


      // ═══════ route-block: /bar/statistics ═══════ (agents: edit only inside your own block)

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


      // ═══════ route-block: /bar/orders ═══════ (agents: edit only inside your own block)

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

      // ═══════ end of route blocks ═══════

      return new Response("Не найдено",{status:404});
    } catch (error) {
      console.error(error);
      return json({error:"Ошибка сервера",details:String(error?.message||error)},500);
    }
  }
};





