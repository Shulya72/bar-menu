import { renderDocument, htmlResponse, icon, monogram, wordmark } from "./design.js";
// Схема базы. Раньше каждая таблица/колонка «досоздавалась» на КАЖДОМ запросе
// (30–40 последовательных обращений к D1 ≈ 3–5 с). Теперь всё это выполняется
// один раз: результат отмечается в app_migrations, а внутри экземпляра Worker'а
// запоминается промисом. Чтобы изменить схему — добавь команду в SCHEMA_SQL и
// поменяй SCHEMA_VERSION: новая версия применится один раз при следующем запросе.
const SCHEMA_VERSION="schema-2026-10-21-guest-shift";
// Время самого раннего заказа гостя, принятого после закрытия последней смены (или NULL).
const ORPHAN_GUEST_SQL="SELECT MIN(COALESCE(accepted_at,created_at)) FROM orders WHERE status IN ('accepted','served') AND COALESCE(accepted_at,created_at)>(SELECT MAX(closed_at) FROM bar_shifts WHERE status='closed')";
const SCHEMA_SQL=[
  "CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  // Основные таблицы — для новой пустой базы (раньше их создавал schema.sql). На рабочей базе
  // они давно есть, и эти команды ничего не меняют.
  "CREATE TABLE IF NOT EXISTS cocktails (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT DEFAULT '',category TEXT DEFAULT '',strength TEXT DEFAULT '',price_rub INTEGER DEFAULT 0,photo_url TEXT DEFAULT '',avatar_url TEXT DEFAULT '',glass TEXT DEFAULT '',ice TEXT DEFAULT '',method TEXT DEFAULT '',garnish TEXT DEFAULT '',is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,brand TEXT DEFAULT '',category TEXT DEFAULT '',unit TEXT NOT NULL CHECK(unit IN ('ml','g','pcs')),min_stock REAL NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,ingredient_id INTEGER,store TEXT DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS recipe_items (id INTEGER PRIMARY KEY AUTOINCREMENT,cocktail_id INTEGER NOT NULL REFERENCES cocktails(id) ON DELETE CASCADE,product_id INTEGER NOT NULL REFERENCES products(id),quantity REAL NOT NULL CHECK(quantity > 0),UNIQUE(cocktail_id,product_id))",
  "CREATE TABLE IF NOT EXISTS purchase_batches (id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER NOT NULL REFERENCES products(id),purchased_qty REAL NOT NULL CHECK(purchased_qty > 0),remaining_qty REAL NOT NULL CHECK(remaining_qty >= 0),price_rub REAL NOT NULL DEFAULT 0,purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,receipt_deleted INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_items_cocktail ON recipe_items(cocktail_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_items_product ON recipe_items(product_id)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_batches_product ON purchase_batches(product_id,purchased_at)",
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
  // Бутылка: volume — объём целой бутылки, quantity — сколько в ней осталось.
  "ALTER TABLE current_stock_lots ADD COLUMN volume REAL",
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
  // Телефоны гостей в единый вид +7XXXXXXXXXX (раньше хранились как ввели: 8…, 7…, 9…).
  // OR IGNORE: если человек был зарегистрирован дважды (с 8 и с +7), обе записи остаются, вход найдёт нужную по PIN.
  "UPDATE OR IGNORE guests SET phone='+7'||substr(phone,2) WHERE length(phone)=11 AND (phone GLOB '8*' OR phone GLOB '7*') AND phone NOT GLOB '*[^0-9]*'",
  "UPDATE OR IGNORE guests SET phone='+7'||phone WHERE length(phone)=10 AND phone GLOB '9*' AND phone NOT GLOB '*[^0-9]*'",
  // Уведомления на телефон: подписки (бармен / гость) и ключи VAPID.
  "CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT,endpoint TEXT NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,role TEXT NOT NULL,guest_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint_role ON push_subscriptions(endpoint,role)",
  // Проверка уведомлений: устройство и последний ответ push-сервера.
  "ALTER TABLE push_subscriptions ADD COLUMN label TEXT",
  "ALTER TABLE push_subscriptions ADD COLUMN last_status INTEGER",
  "ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT",
  "ALTER TABLE push_subscriptions ADD COLUMN last_at TEXT",
  "ALTER TABLE push_subscriptions ADD COLUMN bar_session_id INTEGER",
  "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  // Вход в панель бармена: сессии устройств (только SHA-256 токена) и неудачные попытки.
  "CREATE TABLE IF NOT EXISTS bar_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,label TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS bar_login_failures (id INTEGER PRIMARY KEY AUTOINCREMENT,ip TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS idx_bar_login_failures_at ON bar_login_failures(at)",
  // До защиты панели подписаться «как бармен» мог кто угодно — такие подписки сбрасываются
  // (один раз, при этой миграции); хозяева включат уведомления заново после входа.
  "DELETE FROM push_subscriptions WHERE role='bar' AND NOT EXISTS (SELECT 1 FROM app_migrations WHERE name='schema-2026-10-18-bar-auth')",
  "CREATE TABLE IF NOT EXISTS guest_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT,guest_id INTEGER NOT NULL,order_item_id INTEGER NOT NULL UNIQUE,order_id INTEGER NOT NULL,cocktail_id INTEGER NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  // Один раз (при этой миграции): раньше принятие заказа гостя не открывало смену, и заказы,
  // принятые после закрытия последней смены, не попадали ни в одну. Смена считается открытой
  // с первого такого заказа — так, как сделал бы новый код.
  `UPDATE bar_shifts SET started_at=(${ORPHAN_GUEST_SQL}) WHERE id=(SELECT id FROM bar_shifts WHERE status='open' ORDER BY id DESC LIMIT 1) AND started_at>(${ORPHAN_GUEST_SQL}) AND NOT EXISTS (SELECT 1 FROM app_migrations WHERE name='schema-2026-10-21-guest-shift')`,
  `INSERT INTO bar_shifts(status,started_at) SELECT 'open',m FROM (SELECT (${ORPHAN_GUEST_SQL}) m) WHERE m IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bar_shifts WHERE status='open') AND NOT EXISTS (SELECT 1 FROM app_migrations WHERE name='schema-2026-10-21-guest-shift')`,
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
  // Цены коктейлей по новым правилам (себестоимость по средней цене бутылок в шкафу).
  try{await env.DB.prepare(PRICE_UPDATE_SQL).run()}catch(e){console.error("price refresh:",e?.message)}
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
// Бронь ингредиентов: черновик заказа за стойкой и ещё не принятые заказы гостей.
// Параметры: id черновика стойки и id гостевого заказа, которые НЕ считать бронью
// (их как раз принимают — иначе ингредиенты учитывались бы дважды).
const RESERVED_SQL=`SELECT ingredient_id,SUM(reserved) reserved FROM (
  SELECT ri.ingredient_id,ri.quantity*oi.quantity reserved FROM bar_orders o JOIN bar_order_items oi ON oi.order_id=o.id JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id WHERE o.status='draft' AND o.id<>?
  UNION ALL
  SELECT ri.ingredient_id,ri.quantity*gi.quantity FROM orders g JOIN order_items gi ON gi.order_id=g.id JOIN recipe_ingredients ri ON ri.cocktail_id=gi.cocktail_id WHERE g.status='pending' AND g.id<>?
) GROUP BY ingredient_id`;
// Порядок списания бутылок: сначала начатые (и бутылки без указанного объёма), потом целые — от старых к новым.
const LOTS_ORDER="ORDER BY CASE WHEN volume IS NOT NULL AND quantity>=volume-0.0001 THEN 1 ELSE 0 END,created_at,id";
// Цена коктейля = себестоимость, округлённая вверх до 10 ₽. Цена ингредиента — средняя
// по бутылкам в шкафу с учётом остатков; если ингредиент кончился — цена последней бутылки.
const PRICE_UPDATE_SQL=`UPDATE cocktails SET price_rub=(SELECT CAST((COALESCE(SUM(ri.quantity*COALESCE(
  (SELECT SUM(l.quantity*l.unit_price)/SUM(l.quantity) FROM current_stock_lots l WHERE l.ingredient_id=ri.ingredient_id AND l.quantity>0),
  (SELECT l.unit_price FROM current_stock_lots l WHERE l.ingredient_id=ri.ingredient_id AND l.unit_price>0 ORDER BY l.created_at DESC,l.id DESC LIMIT 1),
  0)),0)+9.9999)/10 AS INTEGER)*10 FROM recipe_ingredients ri WHERE ri.cocktail_id=cocktails.id)`;
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
// Списание ингредиентов принятого заказа со склада по бутылкам (порядок — LOTS_ORDER: сначала начатые).
// Ничего не пишет сам — возвращает команды, которые выполняются одной транзакцией
// вместе со сменой статуса заказа (либо всё, либо ничего). guard — условие «заказ ещё не
// принят»: при двойном нажатии «Принять» вторая транзакция ничего не спишет.
const planBarOrderConsumption=(env,orderId,required,lots,{ref="order",log=true,guard="1",guardArgs=[]}={})=>{
  const statements=[];
  for(const [ingredientId,{quantity,unit}] of required){
    let left=Number(quantity||0);
    for(const lot of lots){if(left<=0)break;if(Number(lot.ingredient_id)!==ingredientId)continue;const take=Math.min(left,Number(lot.quantity||0));if(take>0){statements.push(env.DB.prepare(`UPDATE current_stock_lots SET quantity=quantity-? WHERE id=? AND ${guard}`).bind(take,lot.id,...guardArgs));left-=take;}}
    if(left>0.000001)statements.push(env.DB.prepare(`INSERT INTO current_stock_lots(ingredient_id,brand,store,quantity,unit_price,source_type,source_id) SELECT ?,?,?,?,?,'adjustment',? WHERE ${guard}`).bind(ingredientId,"Заказ #"+orderId,"Списание",-left,0,ref+"-"+orderId+"-"+ingredientId,...guardArgs));
    if(log)statements.push(env.DB.prepare(`INSERT INTO bar_stock_movements(order_id,ingredient_id,quantity,unit) SELECT ?,?,?,? WHERE ${guard}`).bind(orderId,ingredientId,quantity,unit||"ml",...guardArgs));
  }
  return statements;
};
// Сколько чего нужно на заказ: строки рецептов (item_qty, ingredient_id, quantity, name, unit) → Map.
const sumRequired=rows=>{
  const required=new Map();
  for(const row of rows||[]){const id=Number(row.ingredient_id);const cur=required.get(id)||{quantity:0,name:row.name,unit:row.unit};cur.quantity=Number(cur.quantity||0)+Number(row.quantity||0)*Number(row.item_qty||0);required.set(id,cur);}
  return required;
};
const findShortages=(required,products)=>{
  const available=new Map((products||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)])),out=[];
  for(const [id,{quantity:qty,name,unit}] of required){const have=Number(available.get(id)||0);if(have+0.000001<qty)out.push((name||("Ингредиент #"+id))+" — доступно "+Number(have).toLocaleString("ru-RU")+" "+formatUnitLabelServer(unit)+", нужно "+Number(qty).toLocaleString("ru-RU")+" "+formatUnitLabelServer(unit));}
  return out;
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


const refreshCocktailPrice = async (env, cocktailId) => {
  await env.DB.prepare(PRICE_UPDATE_SQL+" WHERE id=?").bind(cocktailId).run();
  const row=await env.DB.prepare("SELECT price_rub FROM cocktails WHERE id=?").bind(cocktailId).first();
  const price=Number(row?.price_rub||0);
  return {cost:price,price};
};

const BUILD_VERSION = "2026-10-22-ivory-v4.7";

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

// Ключ файла в R2 по ссылке из коктейля: "/api/cocktail-photo?key=cocktails/…" или старый вид "/api/cocktail-photo/cocktails/…".
const photoKeyOf = (value) => {
  if (!value) return "";
  try {
    const u = new URL(value, "https://bar-menu.invalid");
    const key = u.searchParams.get("key") || (u.pathname.startsWith("/api/cocktail-photo/") ? decodeURIComponent(u.pathname.slice("/api/cocktail-photo/".length)) : "");
    return key.startsWith("cocktails/") ? key : "";
  } catch (e) {
    return "";
  }
};

// Уборка хранилища фото: удаляет файлы, на которые не ссылается ни один коктейль, —
// остатки старых замен, фото от несохранённых правок, файлы после сбоя удаления.
// Файлы моложе суток не трогаем: их могли загрузить только что, а коктейль ещё сохраняется.
export const sweepPhotos = async (env, minAgeMs = 24 * 3600e3) => {
  if (!env.PHOTOS) return null;
  const { results } = await env.DB.prepare("SELECT photo_url,avatar_url FROM cocktails").all();
  const used = new Set();
  for (const c of results || []) for (const v of [c.photo_url, c.avatar_url]) { const k = photoKeyOf(v); if (k) used.add(k); }
  const now = Date.now(), extra = [];
  let files = 0, cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: "cocktails/", cursor });
    for (const o of page.objects || []) {
      if (!used.has(o.key) && now - new Date(o.uploaded).getTime() > minAgeMs) extra.push(o);
      else files++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < extra.length; i += 1000) await env.PHOTOS.delete(extra.slice(i, i + 1000).map((o) => o.key));
  const result = { at: new Date(now).toISOString(), files, deleted: extra.length, freed: extra.reduce((s, o) => s + o.size, 0) };
  await env.DB.prepare("INSERT INTO app_kv(key,value) VALUES('photo_sweep',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(result)).run();
  return result;
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
      const key=photoKeyOf(c[field]);
      if(key)c[field]="/api/cocktail-photo?key="+encodeURIComponent(key);
    }
    c.recipe_items=recipesByCocktail.get(Number(c.id))||[];
    if(includeStock){
      c.recipe_items=c.recipe_items.map(i=>({...i,stock_available:Number(stockMap.get(Number(i.ingredient_id))||0)}));
      // Сколько порций можно приготовить из того, что есть (с учётом брони). null — рецепт пуст.
      c.available_portions=c.recipe_items.length?Math.max(0,Math.min(...c.recipe_items.map(i=>Number(i.quantity)>0?Math.floor((Number(i.stock_available)+1e-6)/Number(i.quantity)):Infinity))):null;
      if(c.available_portions===Infinity)c.available_portions=null;
      c.available=c.available_portions===null||c.available_portions>0;
    }
  }
  return results;
};

// Склад по ингредиентам. on_hand — сколько физически в бутылках, reserved — забронировано
// заказами, stock — доступно для новых заказов. unit_price — средняя цена по бутылкам в шкафу.
// excludeOrderId / excludeGuestOrderId — заказ, который сейчас принимают (его бронь не вычитается).
const getProducts = async (env, includeDetails = true, excludeOrderId = 0, excludeGuestOrderId = 0) => {
  const statements=[
    env.DB.prepare(`SELECT i.id ingredient_id,i.name ingredient_name,i.unit,
    COALESCE((SELECT SUM(cs.quantity) FROM current_stock_lots cs WHERE cs.ingredient_id=i.id),0) on_hand,
    COALESCE((SELECT SUM(cs.quantity*cs.unit_price) FROM current_stock_lots cs WHERE cs.ingredient_id=i.id AND cs.quantity>0),0) value,
    COALESCE((SELECT SUM(cs.quantity) FROM current_stock_lots cs WHERE cs.ingredient_id=i.id AND cs.quantity>0),0) positive
    FROM ingredients i WHERE i.is_active=1 ORDER BY i.name`),
    env.DB.prepare(RESERVED_SQL).bind(Number(excludeOrderId)||0,Number(excludeGuestOrderId)||0),
  ];
  if(includeDetails)statements.push(env.DB.prepare(`SELECT id,ingredient_id,COALESCE(brand,'') brand,COALESCE(store,'') store,volume,quantity,unit_price,source_type,created_at
      FROM current_stock_lots WHERE quantity>0.0001 ${LOTS_ORDER}`));
  // Все чтения склада — одним обращением к D1.
  const [stockRes,reservedRes,rows]=await env.DB.batch(statements);
  const reservedMap=new Map((reservedRes.results||[]).map(x=>[Number(x.ingredient_id),Number(x.reserved||0)]));
  const byIngredient=new Map();
  if(includeDetails)for(const l of rows.results||[]){
    const id=Number(l.ingredient_id),vol=l.volume==null?null:Number(l.volume),q=Number(l.quantity||0),up=Number(l.unit_price||0);
    if(!byIngredient.has(id))byIngredient.set(id,[]);
    byIngredient.get(id).push({id:Number(l.id),brand:l.brand,store:l.store,volume:vol,quantity:q,unit_price:up,bottle_price:vol?up*vol:null,opened:vol==null||q<vol-0.0001,source_type:l.source_type,created_at:l.created_at,
      // совместимость со старыми клиентами
      stock:q,stock_value:q*up,brand_key:l.brand,store_key:l.store});
  }
  return (stockRes.results||[]).map(x=>{
    const onHand=Math.max(0,Number(x.on_hand||0)),reserved=Number(reservedMap.get(Number(x.ingredient_id))||0),stock=Math.max(0,onHand-reserved);
    const unitPrice=Number(x.positive)>0?Number(x.value)/Number(x.positive):0;
    const out={ingredient_id:x.ingredient_id,ingredient_name:x.ingredient_name,unit:x.unit,on_hand:onHand,reserved,stock,unit_price:unitPrice,stock_value:onHand*unitPrice};
    if(includeDetails)out.details=byIngredient.get(Number(x.ingredient_id))||[];
    return out;
  }).filter(x=>x.on_hand>0.0001);
};

// ——— Заказы гостей и склад (используются в worker.js) ———
// Проверка перед оформлением: хватает ли доступного (с учётом брони) на весь заказ.
// items: [{id, qty}]. Возвращает текст ошибки или null.
export const guestOrderShortage=async(env,items)=>{
  const ids=[...new Set(items.map(x=>Number(x.id)))];
  if(!ids.length)return null;
  const [recipeRes,products]=await Promise.all([
    env.DB.prepare(`SELECT ri.cocktail_id,ri.ingredient_id,ri.quantity,i.name,i.unit,c.name cocktail_name FROM recipe_ingredients ri JOIN cocktails c ON c.id=ri.cocktail_id LEFT JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.cocktail_id IN (${ids.map(()=>"?").join(",")})`).bind(...ids).all(),
    getProducts(env,false),
  ]);
  const rows=recipeRes.results||[],qtyById=new Map(items.map(x=>[Number(x.id),Number(x.qty)]));
  // Сначала — коктейли, которых нет даже в одной порции (их гость видит серыми).
  const unavailable=[];
  for(const id of ids){
    const own=rows.filter(r=>Number(r.cocktail_id)===id);
    if(own.length&&findShortages(sumRequired(own.map(r=>({...r,item_qty:1}))),products).length)unavailable.push(own[0].cocktail_name);
  }
  if(unavailable.length)return "Сейчас нет в наличии: "+unavailable.join(", ")+". Уберите из корзины и выберите другой коктейль.";
  const short=findShortages(sumRequired(rows.map(r=>({...r,item_qty:qtyById.get(Number(r.cocktail_id))||0}))),products);
  if(short.length)return "Столько сейчас не приготовим — уменьшите количество. Не хватает: "+short.map(x=>x.split(" — ")[0]).join(", ")+".";
  return null;
};
// «Принять» заказ гостя: проверка остатков и списание из бутылок (сначала начатые) —
// одной транзакцией со сменой статуса. Возвращает [тело ответа, http-статус].
export const acceptGuestOrderWithStock=async(env,id)=>{
  const o=await env.DB.prepare("SELECT id,status FROM orders WHERE id=?").bind(id).first();
  if(!o)return [{error:"Заказ не найден"},404];
  if(o.status!=="pending")return [{error:"Заказ уже обработан"},409];
  const [[recipeRes,lotsRes],products]=await Promise.all([
    env.DB.batch([
      env.DB.prepare("SELECT oi.quantity item_qty,ri.ingredient_id,ri.quantity,i.name,i.unit FROM order_items oi JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id LEFT JOIN ingredients i ON i.id=ri.ingredient_id WHERE oi.order_id=? ORDER BY oi.id,ri.ingredient_id").bind(id),
      env.DB.prepare("SELECT id,ingredient_id,quantity FROM current_stock_lots WHERE quantity>0 AND ingredient_id IN (SELECT ri.ingredient_id FROM order_items oi JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id WHERE oi.order_id=?) "+LOTS_ORDER).bind(id),
    ]),
    getProducts(env,false,0,id),
  ]);
  const required=sumRequired(recipeRes.results);
  const shortages=findShortages(required,products);
  if(shortages.length)return [{error:"Недостаточно ингредиентов: "+shortages.join(", ")+". Можно отклонить заказ или докупить."},409];
  const done=await env.DB.batch([
    ...planBarOrderConsumption(env,id,required,lotsRes.results||[],{ref:"guest",log:false,guard:"EXISTS(SELECT 1 FROM orders WHERE id=? AND status='pending')",guardArgs:[id]}),
    // Смена закрыта — принятый заказ гостя открывает её, как первый коктейль за стойкой.
    env.DB.prepare("INSERT INTO bar_shifts(status) SELECT 'open' WHERE NOT EXISTS (SELECT 1 FROM bar_shifts WHERE status='open') AND EXISTS (SELECT 1 FROM orders WHERE id=? AND status='pending')").bind(id),
    env.DB.prepare(PRICE_UPDATE_SQL),
    env.DB.prepare("UPDATE orders SET status='accepted',accepted_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(id),
  ]);
  if(!Number(done.at(-1)?.meta?.changes))return [{error:"Заказ уже обработан"},409];
  return [{ok:true,order_id:id},200];
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
        // Замена фото: старый оригинал и кадр удаляются сразу. Сравниваем ключи файлов, а не текст ссылок —
        // у старых записей ссылка могла храниться в другом виде, и неизменённое фото удалилось бы.
        if(env.PHOTOS){
          const keep=new Set([photoKeyOf(nextPhotoUrl),photoKeyOf(nextAvatarUrl)]);
          for(const key of [photoKeyOf(existing.photo_url),photoKeyOf(existing.avatar_url)])
            if(key&&!keep.has(key))try{await env.PHOTOS.delete(key)}catch(e){}
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
            const key=photoKeyOf(value);
            if(!key)continue;
            try{if(!photoKey)photoKey=key;await env.PHOTOS.delete(key);}catch(e){photoDeleted=false;}
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
          const stockRows=await getProducts(env,false),stockMap=new Map((stockRows||[]).map(x=>[Number(x.ingredient_id),Number(x.stock||0)]));
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
            env.DB.prepare("SELECT id,ingredient_id,quantity FROM current_stock_lots WHERE quantity>0 AND ingredient_id IN (SELECT ri.ingredient_id FROM bar_order_items oi JOIN recipe_ingredients ri ON ri.cocktail_id=oi.cocktail_id WHERE oi.order_id=?) "+LOTS_ORDER).bind(draft.order.id),
          ]),
          getProducts(env,false,order.id),
        ]);
        const required=sumRequired(recipeRes.results);
        const shortages=findShortages(required,effective);
        if(shortages.length)return json({error:"Недостаточно ингредиентов для принятия заказа: "+shortages.join(", ")},409);
        const totalPrice=Number(draft.total_price||0);
        const done=await env.DB.batch([
          ...planBarOrderConsumption(env,order.id,required,lotsRes.results||[],{guard:"EXISTS(SELECT 1 FROM bar_orders WHERE id=? AND status='draft')",guardArgs:[order.id]}),
          env.DB.prepare(PRICE_UPDATE_SQL),
          env.DB.prepare("UPDATE bar_orders SET status='accepted',accepted_at=CURRENT_TIMESTAMP,price_total=? WHERE id=? AND status='draft'").bind(totalPrice,order.id),
        ]);
        if(!Number(done.at(-1)?.meta?.changes))return json({error:"Заказ уже принят"},409);
        return json({ok:true,order_id:order.id,total_cocktails:draft.total_cocktails,total_price:totalPrice});
      }
      if (url.pathname === "/api/bar/statistics" && request.method === "GET") {
        const {results}=await env.DB.prepare("SELECT s.id,s.status,s.started_at,s.closed_at,COUNT(DISTINCT CASE WHEN o.status='accepted' THEN o.id END)+(SELECT COUNT(*) FROM orders go WHERE go.status IN ('accepted','served') AND COALESCE(go.accepted_at,go.created_at)>=s.started_at AND (s.closed_at IS NULL OR COALESCE(go.accepted_at,go.created_at)<=s.closed_at)) orders_count,COALESCE(SUM(CASE WHEN o.status='accepted' THEN oi.quantity ELSE 0 END),0)+(SELECT COALESCE(SUM(gi.quantity),0) FROM orders go JOIN order_items gi ON gi.order_id=go.id WHERE go.status IN ('accepted','served') AND COALESCE(go.accepted_at,go.created_at)>=s.started_at AND (s.closed_at IS NULL OR COALESCE(go.accepted_at,go.created_at)<=s.closed_at)) cocktails_count,COALESCE(SUM(CASE WHEN o.status='accepted' THEN oi.quantity*oi.price_rub ELSE 0 END),0)+(SELECT COALESCE(SUM(go.total_rub),0) FROM orders go WHERE go.status IN ('accepted','served') AND COALESCE(go.accepted_at,go.created_at)>=s.started_at AND (s.closed_at IS NULL OR COALESCE(go.accepted_at,go.created_at)<=s.closed_at)) revenue_rub FROM bar_shifts s LEFT JOIN bar_orders o ON o.shift_id=s.id LEFT JOIN bar_order_items oi ON oi.order_id=o.id GROUP BY s.id ORDER BY s.id DESC LIMIT 100").all();return json({shifts:results||[]});
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
          // Пустой old_brand допустим: это сырой ключ партии без бренда (brand_key).
          if(!Number.isInteger(ingredientId)||ingredientId<1||!brand||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0)return json({error:"Некорректные данные товара"},400);
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
        // Пустой brand допустим: это сырой ключ партии без бренда (brand_key).
        if(!Number.isInteger(ingredientId)||ingredientId<1)return json({error:"Не указан товар"},400);
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
                  p.ingredient_id,COALESCE(i.name,p.name) ingredient_name,COALESCE(i.unit,p.unit) unit,p.brand,p.store,
                  MAX(1,(SELECT COUNT(*) FROM current_stock_lots l WHERE l.source_type='purchase' AND l.source_id LIKE pb.id||'-%')) bottles
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
        // Закупка = N одинаковых бутылок: объём бутылки, сколько бутылок, цена за бутылку.
        // (Старый формат — общее количество quantity и общая цена price_rub — считается одной бутылкой.)
        const ingredientId=Number(data.ingredient_id);
        const bottles=data.volume!=null?Math.floor(Number(data.bottles||1)):1;
        const volume=data.volume!=null?Number(data.volume):Number(data.quantity);
        const bottlePrice=data.volume!=null?Number(data.bottle_price):Number(data.price_rub);
        const qty=volume*bottles, price=bottlePrice*bottles;
        const store=String(data.store||"").trim(), brand=String(data.brand||"").trim();
        const purchaseDate=String(data.purchased_at||"").trim();
        if(!Number.isInteger(ingredientId)||ingredientId<1) return json({error:"Выберите ингредиент"},400);
        if(!(volume>0)) return json({error:"Укажите объём бутылки"},400);
        if(!Number.isInteger(bottles)||bottles<1||bottles>48) return json({error:"Сколько бутылок купили? От 1 до 48"},400);
        if(!(bottlePrice>=0)) return json({error:"Укажите цену бутылки"},400);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) return json({error:"Укажите дату покупки"},400);
        const ing=await env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE id=? AND is_active=1").bind(ingredientId).first();
        if(!ing)return json({error:"Ингредиент не найден"},404);
        let product=await env.DB.prepare("SELECT id FROM products WHERE ingredient_id=? AND brand=? AND store=? AND is_active=1 LIMIT 1").bind(ingredientId,brand,store).first();
        let productId;
        if(product){productId=Number(product.id)}else{
          const pr=await env.DB.prepare("INSERT INTO products(name,brand,category,unit,min_stock,ingredient_id,store) VALUES(?,?,?,?,0,?,?)").bind(ing.name,brand,"",ing.unit,ingredientId,store).run();
          productId=Number(pr.meta.last_row_id);
        }
        // Чек в истории и бутылки в шкафу — одной транзакцией. Каждая бутылка хранит свою цену;
        // цена ингредиента для коктейлей — средняя по шкафу (PRICE_UPDATE_SQL).
        const [batch]=await env.DB.batch([
          env.DB.prepare("INSERT INTO purchase_batches(product_id,purchased_qty,remaining_qty,price_rub,purchased_at) VALUES(?,?,?,?,?)").bind(productId,qty,qty,price,purchaseDate+" 00:00:00"),
          ...Array.from({length:bottles},(_,k)=>env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,volume,quantity,unit_price,source_type,source_id,created_at) VALUES(?,?,?,?,?,?,'purchase',CAST((SELECT MAX(id) FROM purchase_batches) AS TEXT)||'-'||?,?)").bind(ingredientId,brand,store,volume,volume,bottlePrice/volume,k+1,purchaseDate+" 00:00:00")),
          env.DB.prepare(PRICE_UPDATE_SQL),
        ]);
        const batchId=Number(batch.meta.last_row_id);
        return json({ok:true,id:batchId,product_id:productId,bottles},201);
      }

      // ——— Бутылки в шкафу ———
      // Бутылка: ингредиент, бренд, объём целой бутылки, сколько осталось, цена всей бутылки.
      if (url.pathname === "/api/stock/bottle" && (request.method === "POST" || request.method === "PUT")) {
        const d=await request.json().catch(()=>({}));
        const volume=Number(d.volume), quantity=Number(d.quantity), price=Number(d.price);
        const brand=String(d.brand||"").trim().slice(0,80), store=String(d.store||"").trim().slice(0,80);
        if(!(volume>0)||volume>1000000)return json({error:"Укажите объём бутылки"},400);
        if(!Number.isFinite(quantity)||quantity<0)return json({error:"Укажите, сколько осталось"},400);
        if(quantity>volume+0.0001)return json({error:"Осталось не может быть больше объёма бутылки"},400);
        if(!Number.isFinite(price)||price<0)return json({error:"Укажите цену бутылки"},400);
        const unitPrice=price/volume;
        if(request.method==="POST"){
          const ingredientId=Number(d.ingredient_id);
          const ing=Number.isInteger(ingredientId)?await env.DB.prepare("SELECT id FROM ingredients WHERE id=? AND is_active=1").bind(ingredientId).first():null;
          if(!ing)return json({error:"Выберите ингредиент"},400);
          if(!(quantity>0))return json({error:"Укажите, сколько осталось"},400);
          const [r]=await env.DB.batch([
            env.DB.prepare("INSERT INTO current_stock_lots(ingredient_id,brand,store,volume,quantity,unit_price,source_type,source_id) VALUES(?,?,?,?,?,?,'manual',?)").bind(ingredientId,brand,store,volume,quantity,unitPrice,"bottle-"+crypto.randomUUID()),
            env.DB.prepare(PRICE_UPDATE_SQL),
          ]);
          return json({ok:true,id:Number(r.meta.last_row_id)},201);
        }
        const id=Number(d.id);
        const lot=Number.isInteger(id)?await env.DB.prepare("SELECT id FROM current_stock_lots WHERE id=? AND quantity>0").bind(id).first():null;
        if(!lot)return json({error:"Бутылка не найдена"},404);
        await env.DB.batch([
          env.DB.prepare("UPDATE current_stock_lots SET brand=?,store=?,volume=?,quantity=?,unit_price=? WHERE id=?").bind(brand,store,volume,quantity,unitPrice,id),
          env.DB.prepare(PRICE_UPDATE_SQL),
        ]);
        return json({ok:true,id});
      }
      if (url.pathname === "/api/stock/bottle" && request.method === "DELETE") {
        const d=await request.json().catch(()=>({}));const id=Number(d.id);
        if(!Number.isInteger(id)||id<1)return json({error:"Бутылка не найдена"},400);
        // Пустая бутылка просто исчезает из шкафа (остаток 0); история закупок не меняется.
        await env.DB.batch([env.DB.prepare("UPDATE current_stock_lots SET quantity=0 WHERE id=?").bind(id),env.DB.prepare(PRICE_UPDATE_SQL)]);
        return json({ok:true});
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
        extraCss:".landing{min-height:calc(100dvh - 140px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px}.landing .monogram{width:min(232px,62vw);height:auto;filter:drop-shadow(0 14px 34px rgba(214,168,78,.16));margin-bottom:14px}.landing h2{font-family:var(--serif);font-weight:400;font-size:2.6rem;margin:6px 0 0;letter-spacing:.04em}.landing .tagline{color:var(--label-2);margin:0 0 26px}.landing .tracker{width:min(100%,320px);margin:0 auto 30px}.landing .button-row{width:min(100%,360px);flex-direction:column}.large-title{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
        body:`<section class="landing">${monogram(232)}<p class="tagline">Семейный бар у нас дома</p>
<div class="tracker" aria-label="VIA — от имён Владимир и Анастасия"><div class="tracker-stop done"><span class="station"></span>Владимир</div><div class="tracker-stop done"><span class="station"></span>VIA</div><div class="tracker-stop done"><span class="station"></span>Анастасия</div></div>
<div class="button-row"><a class="btn btn-primary btn-block" href="/menu">${icon("glass")}Открыть меню</a><a class="btn btn-tinted btn-block" href="/bar/orders">${icon("bell")}Я за стойкой</a></div></section>`,
      }));

      if (url.pathname === "/bar") {
        // Сводка отзывов для строки «Отзывы гостей»; «новые» считает телефон (что уже открывали).
        let rv={n:0,avg:0,ids:""};
        try{const r=await env.DB.prepare("SELECT COUNT(*) n,AVG(rating) avg,(SELECT GROUP_CONCAT(id) FROM (SELECT id FROM guest_reviews ORDER BY id DESC LIMIT 100)) ids FROM guest_reviews").first();rv={n:Number(r?.n||0),avg:Number(r?.avg||0),ids:String(r?.ids||"")}}catch(e){}
        let devices=0;try{devices=Number((await env.DB.prepare("SELECT COUNT(*) n FROM bar_sessions").first())?.n||0)}catch(e){}
        // Цены в меню гостей: бармен может скрыть их на вечер (см. worker.js, guest_prices).
        let pricesHidden=false;try{pricesHidden=(await env.DB.prepare("SELECT value FROM app_kv WHERE key='guest_prices'").first())?.value==="hidden"}catch(e){}
        const devSub="Панель открыта на "+devices+" "+(devices%10===1&&devices%100!==11?"устройстве":"устройствах");
        const rvSub=rv.n?rv.n+" "+(rv.n%10===1&&rv.n%100!==11?"отзыв":[2,3,4].includes(rv.n%10)&&![12,13,14].includes(rv.n%100)?"отзыва":"отзывов")+" · ★ "+rv.avg.toFixed(1).replace(".",","):"Пока нет — гости оценивают выданные коктейли";
        return htmlResponse(renderDocument({
        title:"Ещё", app:"bar", tab:"more", docTitle:"Ещё · VIA Бар",
        extraCss:`.section{margin-top:22px}.section-header{margin:0 4px 9px}.section-header h2{font:700 .6875rem/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--label-3)}#logoutAll .cell-icon{background:var(--danger-tint);color:var(--danger)}.cell .badge{flex:none}.cell .danger-text{color:var(--danger)}.form-msg{margin:12px 4px 0;color:var(--danger)}.form-msg:empty{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sw{position:relative;flex:none;width:51px;height:31px;border:0;border-radius:16px;padding:0;background:var(--sep-strong);cursor:pointer;transition:background .2s}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(42,14,22,.22);transition:transform .2s cubic-bezier(.2,.9,.25,1)}
.sw[aria-checked="true"]{background:var(--accent)}.sw[aria-checked="true"]::after{transform:translateX(20px)}.sw:disabled{opacity:.6}`,
        body:`<div class="section"><div class="section-header"><h2>Бар</h2></div><div class="list">
<a class="cell has-icon" href="/bar/ingredients"><span class="cell-icon">${icon("leaf")}</span><span class="cell-body"><span class="cell-title">Ингредиенты</span><span class="cell-sub">Справочник для рецептов и склада</span></span>${icon("chevronRight","cell-chevron")}</a>
<a class="cell has-icon" href="/bar/statistics"><span class="cell-icon">${icon("chart")}</span><span class="cell-body"><span class="cell-title">Статистика</span><span class="cell-sub">Смены, заказы и выручка</span></span>${icon("chevronRight","cell-chevron")}</a>
</div></div>
<div class="section"><div class="section-header"><h2>Гости</h2></div><div class="list">
<div class="cell has-icon"><span class="cell-icon">${icon("coin")}</span><span class="cell-body"><span class="cell-title" id="pricesTitle">Цены в меню гостей</span><span class="cell-sub" id="pricesSub">${pricesHidden?"Скрыты — гости видят меню без цен":"Гости видят цены коктейлей"}</span></span><button class="sw" type="button" role="switch" id="pricesSw" aria-labelledby="pricesTitle" aria-checked="${pricesHidden?"false":"true"}"></button></div>
<a class="cell has-icon" href="/bar/reviews" id="reviewsCell" data-ids="${rv.ids}"><span class="cell-icon">${icon("star")}</span><span class="cell-body"><span class="cell-title">Отзывы гостей</span><span class="cell-sub">${rvSub}</span></span><span class="badge" id="reviewsNew" hidden></span>${icon("chevronRight","cell-chevron")}</a>
<a class="cell has-icon" href="/menu"><span class="cell-icon">${icon("coupe")}</span><span class="cell-body"><span class="cell-title">Гостевое меню</span><span class="cell-sub">Так видят бар гости</span></span>${icon("chevronRight","cell-chevron")}</a>
<a class="cell has-icon" href="/"><span class="cell-icon">${icon("home")}</span><span class="cell-body"><span class="cell-title">Главная</span></span>${icon("chevronRight","cell-chevron")}</a>
</div></div>
<div class="section"><div class="section-header"><h2>Уведомления</h2></div><div class="list">
<div class="cell has-icon"><span class="cell-icon">${icon("bell")}</span><span class="cell-body"><span class="cell-title">Новые заказы и отзывы</span><span class="cell-sub" id="pushSub" aria-live="polite">Проверяем…</span></span><button class="btn btn-tinted btn-sm" type="button" id="pushBtn" hidden>Включить</button></div>
<button class="cell has-icon" type="button" id="pushTest" hidden><span class="cell-icon">${icon("check")}</span><span class="cell-body"><span class="cell-title">Отправить тестовое уведомление</span><span class="cell-sub">Придёт через 5 секунд — сверните приложение</span></span></button>
</div><p class="section-footer">Придут на этот телефон, даже когда приложение закрыто: «Новый заказ от: Анна», «Новый отзыв от: Анна». Включите на каждом телефоне, где стоит барменская панель.</p></div>
<div class="section"><div class="section-header"><h2>Безопасность</h2></div><div class="list">
<button class="cell has-icon" type="button" data-open-sheet="pinSheet"><span class="cell-icon">${icon("lock")}</span><span class="cell-body"><span class="cell-title">Сменить код</span><span class="cell-sub">${devSub}</span></span>${icon("chevronRight","cell-chevron")}</button>
<button class="cell has-icon" type="button" id="logoutHere"><span class="cell-icon">${icon("logout")}</span><span class="cell-body"><span class="cell-title">Выйти на этом телефоне</span></span></button>
<button class="cell has-icon" type="button" id="logoutAll"><span class="cell-icon">${icon("close")}</span><span class="cell-body"><span class="cell-title danger-text">Выйти на всех устройствах</span><span class="cell-sub">Если телефон потерялся: везде понадобится код, уведомления бармена отключатся</span></span></button>
</div><p class="section-footer">Панель открывается только по коду, гостям доступно лишь меню. Забыли код — «Забыли код?» на экране входа и ключ восстановления.</p></div>
<div class="sheet" id="pinSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
<div class="sheet-grabber"></div>
<div class="sheet-head"><button class="btn btn-plain left" type="button" data-close-sheet>Отмена</button><h2 id="pinTitle" tabindex="-1">Новый код</h2><button class="btn btn-plain right strong" type="submit" form="pinForm" id="pinSave">Готово</button></div>
<div class="sheet-body"><form id="pinForm" novalidate><input class="sr-only" name="username" autocomplete="username" value="VIA Bar" tabindex="-1" aria-hidden="true" readonly>
<div class="list"><label class="field"><span>Текущий код</span><input name="current" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="current-password" required placeholder="6–12 цифр"></label></div>
<div class="list" style="margin-top:14px"><label class="field"><span>Новый код</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="new-password" required placeholder="6–12 цифр"></label><label class="field"><span>Повторите новый код</span><input name="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="new-password" required placeholder="6–12 цифр"></label></div>
<p class="form-msg" id="pinMsg" role="alert"></p>
<p class="section-footer">Устройства, где уже выполнен вход, останутся в панели. Новый код понадобится при следующем входе.</p></form></div></div></div>`,
      }).replace("</main>",()=>`</main><script>
// Цены в меню гостей: тумблер сохраняется сразу; у гостей меню обновится в течение минуты.
document.addEventListener("DOMContentLoaded",function(){var sw=document.getElementById("pricesSw"),ps=document.getElementById("pricesSub");if(!sw)return;
sw.addEventListener("click",function(){var show=sw.getAttribute("aria-checked")!=="true";sw.disabled=true;
fetch("/api/bar/guest-prices",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({hidden:!show})}).then(function(r){if(!r.ok)throw new Error("Не получилось — проверьте интернет");
sw.setAttribute("aria-checked",show?"true":"false");ps.textContent=show?"Гости видят цены коктейлей":"Скрыты — гости видят меню без цен";VIA.toast(show?"Цены снова видны гостям":"Цены скрыты: гости увидят меню без цен")})
.catch(function(e){VIA.toast(e.message||"Не получилось",true,4000)}).then(function(){sw.disabled=false})})});
document.addEventListener("DOMContentLoaded",function(){var sub=document.getElementById("pushSub"),btn=document.getElementById("pushBtn"),cur="";
function paint(st){cur=st;sub.textContent=VIA.push.text[st]||"";btn.hidden=!(st==="on"||st==="off");btn.textContent=st==="on"?"Выключить":"Включить"}
var test=document.getElementById("pushTest");
// Подписка этого телефона (адрес) — тестовое уведомление показываем, только если сервер её знает.
var endpoint=function(){if(!("serviceWorker" in navigator)||!("PushManager" in window))return Promise.resolve("");
return Promise.race([navigator.serviceWorker.ready,new Promise(function(ok){setTimeout(ok,4000)})]).then(function(reg){return reg?reg.pushManager.getSubscription():null}).then(function(x){return x?x.endpoint:""}).catch(function(){return ""})};
var server=function(){return endpoint().then(function(ep){return fetch("/api/bar/push/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({endpoint:ep})}).then(function(r){return r.json()}).then(function(d){
test.hidden=!(d.devices||[]).some(function(x){return x.mine})})}).catch(function(){test.hidden=true})};
VIA.push.state("bar").then(paint);VIA.push.sync("bar").then(server);
btn.addEventListener("click",function(){btn.disabled=true;var p=cur==="on"?VIA.push.disable("bar"):VIA.push.enable("bar");
p.then(function(){VIA.toast(cur==="on"?"Уведомления выключены":"Готово — новые заказы придут на этот телефон")}).catch(function(e){VIA.toast(e.message||"Не получилось",true,4000)})
.then(function(){return VIA.push.state("bar")}).then(paint).then(server).then(function(){btn.disabled=false})});
test.addEventListener("click",function(){test.disabled=true;endpoint().then(function(ep){return fetch("/api/bar/push/test",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({endpoint:ep})}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Не получилось");return d})})})
.then(function(){VIA.toast("Отправили — сверните приложение: уведомление придёт через 5 секунд",false,5000)}).catch(function(e){VIA.toast(e.message,true,5000);server()}).then(function(){setTimeout(function(){test.disabled=false},6000)})})});
(function(){
var post=function(u,b){return fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok)throw new Error(d.error||"Не получилось — проверьте интернет");return d})})};
// Выход: стираем сохранённые копии страниц панели, чтобы без входа их не было видно и офлайн.
var forget=function(){if(!window.caches)return Promise.resolve();return caches.keys().then(function(ks){return Promise.all(ks.map(function(k){
if(/^via-(pages|data)/.test(k))return caches.delete(k);if(/^via-static/.test(k))return caches.open(k).then(function(c){return c.keys().then(function(rs){return Promise.all(rs.filter(function(q){return q.url.indexOf("/__via-warm-bar")>=0}).map(function(q){return c.delete(q)}))})})}))}).catch(function(){})};
var out=function(all){return (all?Promise.resolve():VIA.push.state("bar").then(function(st){if(st==="on")return VIA.push.disable("bar")}).catch(function(){}))
.then(function(){return post("/api/bar/auth/logout",{all:!!all})}).then(forget).then(function(){location.replace("/bar")}).catch(function(e){VIA.toast(e.message,true,4000)})};
document.getElementById("logoutHere").addEventListener("click",function(){if(confirm("Выйти из панели на этом телефоне? Чтобы вернуться, понадобится код."))out(false)});
document.getElementById("logoutAll").addEventListener("click",function(){if(confirm("Выйти на всех устройствах, включая этот? Везде понадобится код, уведомления бармена отключатся."))out(true)});
var f=document.getElementById("pinForm"),msg=document.getElementById("pinMsg"),save=document.getElementById("pinSave");
f.addEventListener("submit",function(e){e.preventDefault();msg.textContent="";var cur=f.current.value.trim(),pin=f.pin.value.trim();
if(!/^\\d{6,12}$/.test(pin)){msg.textContent="Новый код — от 6 до 12 цифр";return}if(pin!==f.pin2.value.trim()){msg.textContent="Новые коды не совпадают";return}
save.disabled=true;post("/api/bar/auth/change",{current:cur,pin:pin}).then(function(){f.reset();VIA.closeSheet("pinSheet");VIA.toast("Код изменён")}).catch(function(e){msg.textContent=e.message}).then(function(){save.disabled=false})});
})();
(function(){var c=document.getElementById("reviewsCell"),b=document.getElementById("reviewsNew");if(!c||!b)return;
var seen=0;try{seen=Number(localStorage.getItem("via.reviews.seen")||0)}catch(e){}
var n=String(c.dataset.ids||"").split(",").filter(function(x){return Number(x)>seen}).length;
if(n){b.textContent=n+" "+(n%10===1&&n%100!==11?"новый":"новых");b.hidden=false}})();
</script>`));
      }


      // ═══════ route-block: /bar/reviews ═══════
      // Отзывы гостей: средняя оценка, по коктейлям и все отзывы (новые помечаются на этом телефоне).
      if (url.pathname === "/bar/reviews") {
        const h=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
        const stars=n=>{n=Math.max(0,Math.min(5,Math.round(Number(n)||0)));return "★".repeat(n)+"☆".repeat(5-n)};
        const num1=v=>Number(v||0).toFixed(1).replace(".",",");
        let list=[],byCocktail=[];
        try{
          const [a,b2]=await env.DB.batch([
            env.DB.prepare("SELECT gr.id,gr.rating,COALESCE(gr.comment,'') comment,gr.created_at,COALESCE(c.name,'Коктейль') cocktail,COALESCE(g.name,'Гость') guest FROM guest_reviews gr LEFT JOIN cocktails c ON c.id=gr.cocktail_id LEFT JOIN guests g ON g.id=gr.guest_id ORDER BY gr.id DESC LIMIT 200"),
            env.DB.prepare("SELECT COALESCE(c.name,'Коктейль') cocktail,COUNT(*) n,AVG(gr.rating) avg FROM guest_reviews gr LEFT JOIN cocktails c ON c.id=gr.cocktail_id GROUP BY gr.cocktail_id ORDER BY avg DESC,n DESC"),
          ]);
          list=a.results||[];byCocktail=b2.results||[];
        }catch(e){}
        const total=list.length,avg=total?list.reduce((x,r)=>x+Number(r.rating||0),0)/total:0;
        const word=n=>n%10===1&&n%100!==11?"отзыв":[2,3,4].includes(n%10)&&![12,13,14].includes(n%100)?"отзыва":"отзывов";
        const body=!total
          ?`<div class="list" style="margin-top:8px"><div class="empty-state">${icon("star")}<h3>Отзывов пока нет</h3><p>Гость может оценить коктейль после того, как вы его выдадите. Новые отзывы появятся здесь.</p></div></div>`
          :`<div class="list rv-summary"><div class="cell"><span class="cell-body"><span class="rv-avg num">${num1(avg)}</span><span class="rv-stars" aria-label="Средняя оценка ${num1(avg)} из 5">${stars(avg)}</span></span><span class="cell-value num">${total} ${word(total)}</span></div></div>
<div class="section"><div class="section-header"><h2>По коктейлям</h2></div><div class="list">${byCocktail.map(r=>`<div class="cell"><span class="cell-body"><span class="cell-title">${h(r.cocktail)}</span><span class="cell-sub">${Number(r.n)} ${word(Number(r.n))}</span></span><span class="cell-value num"><span class="rv-stars sm" aria-hidden="true">★</span> ${num1(r.avg)}</span></div>`).join("")}</div></div>
<div class="section"><div class="section-header"><h2>Все отзывы</h2></div><div class="list" id="rvList">${list.map(r=>`<div class="rv-item" data-id="${Number(r.id)}"><div class="rv-head"><span class="cell-title">${h(r.cocktail)}</span><span class="rv-stars" aria-label="Оценка ${Number(r.rating)} из 5">${stars(r.rating)}</span></div>${r.comment?`<p class="rv-comment">${h(r.comment)}</p>`:""}<div class="rv-meta"><span>${h(r.guest)}</span> · <time data-ts="${h(r.created_at)}">${h(String(r.created_at).slice(0,16))}</time><span class="badge rv-new" hidden>новый</span></div></div>`).join("")}</div></div>`;
        return htmlResponse(renderDocument({
          title:"Отзывы", app:"bar", tab:"more", back:{href:"/bar",label:"Ещё"}, docTitle:"Отзывы гостей · VIA Бар",
          sub:"Оценки, которые гости поставили выданным коктейлям.",
          extraCss:`
.rv-summary{margin-top:6px}
.rv-avg{font:600 2.5rem/1 var(--serif);color:var(--accent);margin-right:10px}
.rv-stars{color:var(--brass);letter-spacing:2px}
#rvList .cell-title,.rv-item .cell-title{font:600 1.125rem/1.15 var(--serif)}
.rv-stars.sm{letter-spacing:0}
.rv-summary .cell-body{display:flex;align-items:baseline}
.rv-item{padding:12px 14px}
.rv-item+.rv-item{border-top:.5px solid var(--sep-strong)}
.rv-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.rv-comment{margin:6px 0 0;color:var(--label);line-height:1.4;overflow-wrap:anywhere}
.rv-meta{margin-top:6px;font-size:.8125rem;color:var(--label-2);display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.rv-new{margin-left:6px}`,
          body,
        }).replace("</main>",()=>`</main><script>
(function(){var pad=function(n){return String(n).padStart(2,"0")},today=new Date();
document.querySelectorAll("time[data-ts]").forEach(function(t){var d=new Date(String(t.dataset.ts).replace(" ","T")+"Z");if(isNaN(d))return;
var hm=pad(d.getHours())+":"+pad(d.getMinutes());t.textContent=d.toDateString()===today.toDateString()?"сегодня в "+hm:d.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})+", "+hm});
var seen=0;try{seen=Number(localStorage.getItem("via.reviews.seen")||0)}catch(e){}
var max=seen;document.querySelectorAll(".rv-item[data-id]").forEach(function(el){var id=Number(el.dataset.id);if(id>seen){var b=el.querySelector(".rv-new");if(b)b.hidden=false}if(id>max)max=id});
try{localStorage.setItem("via.reviews.seen",String(max))}catch(e){}})();
</script>`));
      }

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
.rb-thumb{width:50px;height:50px;border-radius:13px}
.thumb-ph.rb-thumb{color:var(--line,var(--gold));background:color-mix(in srgb,var(--line,var(--gold)) 10%,var(--bg-raised-2))}
.rb-row .cell-title{font:600 1.1875rem/1.12 var(--serif)}
.rb-ings{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rb-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:6px;font-size:.8125rem;color:var(--label-2)}
.rb-price{font-weight:700;color:var(--accent)}
.rb-short{display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:3px 10px;border-radius:12px;background:var(--warn-tint);color:var(--warn);font-size:.71875rem;font-weight:700;line-height:1.25}
.rb-short .ic{width:13px;height:13px;flex:none}
.rb-row.is-short .rb-thumb{filter:brightness(.6)}
.scale{display:inline-flex;align-items:center;gap:3px}
.scale i{display:block;width:7px;height:7px;border-radius:50%;background:var(--brass)}
.scale i.o{background:none;box-shadow:inset 0 0 0 1.3px var(--brass)}
.rb-stepper{flex:none}
.rb-row .rb-stepper{margin-right:10px}
.rb-stepper button{position:relative}
.rb-stepper button::after{content:"";position:absolute;inset:-4px 0}
.rb-stepper .ic{width:17px;height:17px}
.rb-stepper.is-empty .st-minus,.rb-stepper.is-empty .st-count{display:none}
.rb-stepper.is-empty{min-width:36px;width:36px;height:36px;padding:0;border-radius:50%;justify-content:center}
.rb-stepper.is-empty .st-plus{width:36px;height:36px}
.rb-stepper .st-plus.is-short{color:var(--label-3)}
.rb-empty .btn{margin-top:14px}
.order-bar{position:fixed;z-index:45;left:50%;bottom:calc(var(--tabbar-h) + 12px + var(--safe-b));transform:translateX(-50%);width:min(calc(100% - 24px),520px);display:flex;align-items:center;gap:8px;padding:8px;border-radius:20px;background:var(--bg-raised);box-shadow:0 18px 40px rgba(40,8,16,.24),inset 0 0 0 1px var(--sep-strong);animation:ob-in .28s cubic-bezier(.2,.9,.25,1)}
@keyframes ob-in{from{opacity:0;transform:translate(-50%,14px)}}
.ob-info{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:44px;padding:0 6px 0 8px;border:0;border-radius:14px;background:none;color:var(--label);font:inherit;text-align:left;cursor:pointer}
.ob-info:active{background:var(--bg-pressed)}
.ob-title,.ob-sub{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ob-title{font-weight:700;font-size:.9375rem}
.ob-sub{font-size:.75rem;color:var(--label-3);margin-top:2px}
.order-bar .ob-btn{min-height:44px;padding:0 13px;border-radius:14px;font-size:.84375rem;flex:none}
body.app.has-order .screen{padding-bottom:calc(var(--tabbar-h) + 108px + var(--safe-b))}
body.has-order:not(:has(.sheet.open)) .toast{bottom:calc(var(--tabbar-h) + 96px + var(--safe-b))}
.toast{width:max-content;border-radius:22px}
.line-other{--line:var(--gold)}
.route.line-zero{--line:var(--line-zero)}.route.line-light{--line:var(--line-light)}.route.line-mid{--line:var(--line-mid)}.route.line-strong{--line:var(--line-strong)}
.sheet-panel:focus{outline:none}
.dt-photo{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:20px;background:#2A0A14;margin:2px 0 16px;box-shadow:0 12px 26px rgba(84,24,38,.16)}
.dt-name{font:600 2.25rem/1.04 var(--serif);margin:4px 0 10px;text-wrap:balance;overflow-wrap:anywhere}
.dt-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dt-meta .badge{height:26px;padding:0 11px;font-size:.8125rem}
.dt-price{color:var(--label-2);font-weight:600;font-variant-numeric:tabular-nums}
.dt-desc{color:var(--label-2);margin:12px 0 0;line-height:1.45;white-space:pre-line}
.dt-warn{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;padding:12px 14px;border-radius:var(--r-md);background:var(--warn-tint);color:var(--warn);font-size:.9375rem;line-height:1.35}
.dt-warn .ic{margin-top:1px}
.dt-order{margin-top:16px}
.dt-panel{padding:16px 14px}
.dt-empty{margin:0;color:var(--label-2)}
.rs-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.rs-name{font-weight:500;overflow-wrap:anywhere}
.rs-qty{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.rs-stock{font-size:.8125rem;color:var(--label-2);margin-top:2px;font-variant-numeric:tabular-nums}
.route-stop.short .station{background:var(--warn);box-shadow:0 0 0 3px var(--warn-tint)}
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
    VIA.toast("Заказ"+(d.order_id?" №"+d.order_id:"")+" принят, ингредиенты списаны"+VIA.notifiedNote(d));
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
        extraCss:`#list .cell-title{font:600 1.125rem/1.15 var(--serif)}`,
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
        // Склад рисуется на сервере (первый кадр без ожидания API) и дальше
        // обновляется на клиенте тем же кодом: stockUI() самодостаточна, её
        // исходник вставляется в страницу. При включённом keepNames esbuild
        // добавляет внутрь вызовы __name() — на этот случай на клиенте есть заглушка.
        // Поэтому внутри stockUI нельзя ссылаться ни на что снаружи неё.
        // Модель: ингредиент (Водка) = сумма остатков его бутылок (Белуга, Мамонт…).
        let stockIngredients=[], stockItems=[], recipeRows=[];
        let stockLoadError="";
        try{
          const [ir,products,rr]=await Promise.all([
            env.DB.prepare("SELECT id,name,unit FROM ingredients WHERE is_active=1 ORDER BY name").all(),
            getProducts(env),
            // Для «Пора докупить»: сколько ингредиента уходит на порцию в активных рецептах.
            env.DB.prepare("SELECT ri.ingredient_id,ri.quantity,c.name FROM recipe_ingredients ri JOIN cocktails c ON c.id=ri.cocktail_id WHERE c.is_active=1 ORDER BY c.name").all().catch(()=>({results:[]})),
          ]);
          stockIngredients=ir.results||[];
          stockItems=products;
          recipeRows=rr.results||[];
        }catch(e){
          stockLoadError=String(e?.message||e);
        }
        const stockUsage={};
        for(const r of recipeRows){
          const id=Number(r.ingredient_id),u=stockUsage[id]||(stockUsage[id]={per:0,names:[]});
          u.per=Math.max(u.per,Number(r.quantity)||0);
          if(!u.names.includes(r.name))u.names.push(r.name);
        }
        const stockUI=()=>{
          const LOW=3,UNITS={ml:"мл",g:"г",pcs:"шт"},ui={LOW};
          ui.esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
          ui.norm=s=>String(s??"").toLowerCase().replace(/ё/g,"е").trim();
          ui.unit=u=>UNITS[u]||String(u||"");
          ui.num=(v,d)=>{v=Number(v)||0;const p=Math.pow(10,d||0),r=Math.round(Math.abs(v)*p)/p,parts=String(r).split(".");return (v<0&&r?"−":"")+parts[0].replace(/\B(?=(\d{3})+(?!\d))/g," ")+(parts[1]?","+parts[1]:"")};
          ui.money=v=>ui.num(v,Math.abs(Number(v)||0)>=100?0:2)+" ₽";
          ui.qty=(v,u)=>ui.num(v,1)+" "+ui.unit(u);
          ui.rate=(v,u)=>ui.num(v,Number(v)<1?3:2)+" ₽/"+ui.unit(u);
          ui.plural=(n,one,few,many)=>{const a=Math.abs(n)%100,b=a%10;return a>10&&a<20?many:b===1?one:b>1&&b<5?few:many};
          ui.ic=(n,c)=>'<svg class="ic'+(c?" "+c:"")+'" aria-hidden="true"><use href="#i-'+n+'"/></svg>';
          // Жидкости — в бутылках, лёд и лаймы — в упаковках.
          ui.packs=(n,u)=>n+" "+(u==="ml"?ui.plural(n,"бутылка","бутылки","бутылок"):ui.plural(n,"упаковка","упаковки","упаковок"));
          ui.servings=(p,use)=>use&&use.per>0?Math.floor(Number(p.stock)/use.per+1e-9):null;
          ui.portions=s=>s<1?"меньше чем на порцию":"на "+s+" "+ui.plural(s,"порцию","порции","порций");
          ui.isLow=(p,use)=>{const s=ui.servings(p,use);return s!==null&&s<=LOW};
          ui.summary=items=>{const n=items.length,total=items.reduce((a,p)=>a+(Number(p.stock_value)||0),0);return n?n+" "+ui.plural(n,"ингредиент","ингредиента","ингредиентов")+" на "+ui.money(total):"Бутылки в шкафу и их остатки"};
          ui.list=(items,usage,ingredients,q)=>{
            const e=ui.esc,nq=ui.norm(q),chev=ui.ic("chevronRight","cell-chevron");
            const shown=items.filter(p=>!nq||ui.norm(p.ingredient_name).includes(nq)||(p.details||[]).some(d=>ui.norm(d.brand).includes(nq)));
            const have=new Set(items.map(p=>Number(p.ingredient_id)));
            const low=shown.filter(p=>ui.isLow(p,usage[p.ingredient_id]));
            const out=ingredients.filter(i=>usage[i.id]&&!have.has(Number(i.id))&&(!nq||ui.norm(i.name).includes(nq)));
            let h="";
            if(!items.length&&!nq)
              h='<div class="empty-state">'+ui.ic("box")+'<h3>Склад пока пуст</h3><p>Добавьте бутылки из шкафа — или внесите покупку в <a href="/bar/shop">«Закупках»</a>.</p><button type="button" class="btn btn-primary" data-add-query>'+ui.ic("plus")+'Добавить бутылку</button></div>';
            if(low.length||out.length){
              h+='<section class="section" aria-labelledby="restockHead"><div class="section-header"><h2 id="restockHead">Пора докупить</h2></div><div class="list">'
                +out.map(i=>'<button type="button" class="cell" data-add="'+Number(i.id)+'"><span class="cell-body"><span class="cell-title">'+e(i.name)+'</span><span class="cell-sub">Нужен для: '+e(usage[i.id].names.join(", "))+'</span></span><span class="badge danger">нет</span>'+chev+'</button>').join("")
                +low.map(p=>'<button type="button" class="cell" data-id="'+Number(p.ingredient_id)+'" aria-haspopup="dialog"><span class="cell-body"><span class="cell-title">'+e(p.ingredient_name)+'</span><span class="cell-sub">'+ui.qty(p.stock,p.unit)+' — хватит '+ui.portions(ui.servings(p,usage[p.ingredient_id]))+'</span></span><span class="badge warn">мало</span>'+chev+'</button>').join("")
                +'</div><p class="section-footer">'+[low.length?"«Мало» — хватит на "+LOW+" порции или меньше.":"",out.length?"«Нет» — закончилось, коктейли с ним гостям недоступны.":""].filter(Boolean).join(" ")+'</p></section>';
            }
            if(shown.length){
              h+='<section class="section" aria-labelledby="stockHead"><div class="section-header"><h2 id="stockHead">В шкафу</h2><span class="num">'+shown.length+'</span></div><div class="list">'
                +shown.map(p=>{const n=(p.details||[]).length;return '<button type="button" class="cell" data-id="'+Number(p.ingredient_id)+'" aria-haspopup="dialog"><span class="cell-body"><span class="cell-title">'+e(p.ingredient_name)+'</span><span class="cell-sub">'+(n?ui.packs(n,p.unit)+' · ':'')+'в среднем '+ui.rate(p.unit_price,p.unit)+(ui.isLow(p,usage[p.ingredient_id])?' · <span class="low">мало</span>':'')+'</span></span><span class="cell-value num">'+ui.qty(p.on_hand,p.unit)+'</span>'+chev+'</button>'}).join("")
                +'</div><p class="section-footer">Справа — сколько всего осталось во всех бутылках. По средней цене считается цена коктейля.</p></section>';
            }else if(nq&&!out.length){
              h+='<div class="empty-state">'+ui.ic("search")+'<h3>Ничего не нашлось</h3><p>Попробуйте другое название или бренд.</p><button type="button" class="btn btn-tinted" data-add-query>'+ui.ic("plus")+'Добавить «'+e(String(q).trim())+'»</button></div>';
            }
            return h;
          };
          ui.kv=(k,v,cls)=>'<div class="cell"><span class="cell-body"><span class="cell-title">'+k+'</span></span><span class="cell-value num'+(cls?" "+cls:"")+'">'+v+'</span></div>';
          ui.left=(d,u)=>"осталось "+(d.volume?ui.num(d.quantity,1)+" из "+ui.qty(d.volume,u):ui.qty(d.quantity,u));
          ui.detail=(p,use)=>{
            const e=ui.esc,u=p.unit,s=ui.servings(p,use),bottles=p.details||[],chev=ui.ic("chevronRight","cell-chevron");
            let h='<div class="list">'+ui.kv("Всего в шкафу",ui.qty(p.on_hand,u))
              +(Number(p.reserved)>0?ui.kv("Ждёт в заказах",ui.qty(p.reserved,u)):"")
              +ui.kv("Средняя цена",ui.rate(p.unit_price,u))
              +(s!==null?ui.kv("Хватит",ui.portions(s),s<=LOW?"low":""):"")
              +'</div>';
            const notes=[];
            if(Number(p.reserved)>0)notes.push("«Ждёт в заказах» — гости уже заказали, спишется, когда вы примете заказ.");
            if(use&&use.names.length)notes.push("В рецептах: "+e(use.names.join(", "))+".");
            if(notes.length)h+='<p class="section-footer">'+notes.join(" ")+'</p>';
            h+='<section class="section" aria-labelledby="bottlesHead"><div class="section-header"><h3 id="bottlesHead">'+(u==="ml"?"Бутылки":"Упаковки")+'</h3><span class="num">'+bottles.length+'</span></div><div class="list">'
              +bottles.map((d,i)=>{const b=d.brand?e(d.brand):"Без бренда";
                return '<button type="button" class="cell" data-bottle="'+i+'" aria-haspopup="dialog" aria-label="'+b+', '+ui.left(d,u)+'. Изменить"><span class="cell-body"><span class="cell-title">'+b+'</span><span class="cell-sub num">'+ui.left(d,u)+'</span></span><span class="cell-value num">'+(d.bottle_price!=null?ui.money(d.bottle_price):ui.rate(d.unit_price,u))+'</span>'+chev+'</button>'}).join("")
              +'</div><p class="section-footer">Для коктейлей берём сначала из начатой бутылки. Пустая бутылка исчезает со склада сама.</p></section>'
              +'<div class="section"><button type="button" class="btn btn-tinted btn-block" data-add-bottle>'+ui.ic("plus")+(u==="ml"?"Добавить бутылку":"Добавить упаковку")+'</button></div>';
            return h;
          };
          return ui;
        };
        const ui=stockUI();
        const toJson=v=>JSON.stringify(v).replace(/</g,"\\u003c");
        const stockBody=stockLoadError
          ?`<div id="stockView"><div class="empty-state" role="alert">${icon("warning")}<h3>Не удалось загрузить склад</h3><p>Проверьте связь и обновите страницу.</p><p class="caption">${ui.esc(stockLoadError)}</p><button class="btn btn-tinted" type="button" data-reload>${icon("refresh")}Обновить</button></div></div>`
          :`<label class="search">${icon("search")}<input type="search" id="stockSearch" placeholder="Ингредиент или бренд" autocomplete="off" aria-label="Поиск по складу" enterkeyhint="search"></label>
<div id="stockView">${ui.list(stockItems,stockUsage,stockIngredients,"")}</div>`;
        const stockSheets=`
<div class="sheet sheet-top" id="bottleSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="bottleTitle">
<div class="sheet-grabber"></div>
<div class="sheet-head"><button class="btn btn-plain left" type="button" data-close-sheet>Отмена</button><h2 id="bottleTitle">Бутылка</h2><button class="btn btn-plain right strong" type="submit" form="bottleForm" id="bottleHeadSubmit">Готово</button></div>
<div class="sheet-body"><form id="bottleForm" novalidate autocomplete="off"><input type="hidden" name="ingredient_id">
<div id="ingPick">
<div class="list"><label class="field"><span>Ингредиент</span><input id="ingInput" type="search" placeholder="Водка, лайм, тоник…" aria-describedby="ingHint" enterkeyhint="next" autocomplete="off" spellcheck="false"></label></div>
<div class="list suggest" id="ingSuggest" role="group" aria-label="Подходящие ингредиенты"></div>
<p class="section-footer" id="ingHint"></p>
<div id="newIng" hidden>
<div class="section-header new-head"><h3>Новый ингредиент</h3></div>
<div class="list">
<label class="field"><span>Название</span><input id="newIngName" placeholder="Например, ром тёмный" enterkeyhint="done"></label>
<div class="field"><span id="newIngUnitLabel">Единица</span><div class="segmented" role="group" aria-labelledby="newIngUnitLabel"><button type="button" data-unit="ml" aria-pressed="true">мл</button><button type="button" data-unit="g" aria-pressed="false">граммы</button><button type="button" data-unit="pcs" aria-pressed="false">штуки</button></div></div>
<label class="field"><span>Крепость, %</span><input id="newIngStrength" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="0" enterkeyhint="done"></label>
</div>
<p class="section-footer">Водка — 40%, ликёр — около 20%, сок и газировка — 0%. По крепости ингредиентов считается крепость коктейля.</p>
<p class="form-msg" id="newIngMsg" role="alert"></p>
<div class="button-row new-actions"><button type="button" class="btn btn-gray" id="newIngCancel">Отмена</button><button type="button" class="btn btn-tinted" id="newIngSave">Создать</button></div>
</div>
</div>
<p class="footnote sheet-note" id="bottleFor" hidden></p>
<div class="section"><div class="list">
<label class="field"><span>Бренд</span><input name="brand" list="brandOptions" placeholder="Например, Белуга" enterkeyhint="next" maxlength="80"></label>
<label class="field"><span data-l="volume">Объём бутылки, мл</span><input name="volume" type="number" inputmode="decimal" min="0" step="any" placeholder="Например, 700" enterkeyhint="next"></label>
<label class="field"><span data-l="left">Осталось, мл</span><input name="quantity" type="number" inputmode="decimal" min="0" step="any" placeholder="Полная" enterkeyhint="next"></label>
<label class="field"><span data-l="price">Цена бутылки, ₽</span><input name="price" type="number" inputmode="decimal" min="0" step="any" placeholder="Например, 1500" enterkeyhint="done"></label>
</div>
<p class="section-footer num" id="bottleCalc" aria-live="polite"></p></div>
<datalist id="brandOptions"></datalist>
<p class="form-msg" id="bottleMsg" role="alert"></p>
<div class="section" id="bottleAddRow"><button class="btn btn-primary btn-block" type="submit">${icon("plus")}Добавить на склад</button></div>
<div class="section" id="bottleDelRow" hidden><button class="btn btn-danger btn-block" type="button" id="bottleDel">${icon("trash")}Убрать со склада</button></div>
</form></div></div></div>
<div class="sheet" id="detailSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
<div class="sheet-grabber"></div>
<div class="sheet-head"><span class="left"></span><h2 id="detailTitle" tabindex="-1">Ингредиент</h2><button class="btn btn-plain right strong" type="button" data-close-sheet>Готово</button></div>
<div class="sheet-body" id="detailBody"></div>
</div></div>`;
        const stockScript=`<script>
var __name=function(t){return t};
// VIA (шторки, тосты) определяется скриптом каркаса ниже — запускаемся после разбора страницы.
document.addEventListener("DOMContentLoaded",function(){
"use strict";
const UI=(${stockUI})();
let items=${toJson(stockItems)};
const ingredients=${toJson(stockIngredients)};
const usage=${toJson(stockUsage)};
const LOAD_ERROR=${stockLoadError?"true":"false"};
${String.raw`const $=s=>document.querySelector(s);
const view=$("#stockView"),summary=$("#stockSummary"),search=$("#stockSearch");
let q="",openId=0,lastFetch=Date.now();
const setMsg=(el,text,info)=>{el.textContent=text||"";el.classList.toggle("info",!!info)};
const fail=(el,text,focus)=>{setMsg(el,text);if(focus)focus.focus()};
const busy=(form,on)=>document.querySelectorAll('[form="'+form.id+'"],#'+form.id+' [type=submit],#bottleDel').forEach(b=>{b.disabled=on});
const stockOf=id=>items.find(p=>Number(p.ingredient_id)===Number(id));
const send=async(method,body)=>{const r=await fetch("/api/stock/bottle",{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось сохранить");return d};

// Шторка может открываться поверх другой: закрытие верхней не снимает блокировку
// прокрутки, а фокус возвращается туда, откуда шторку открыли.
const returnFocus=new Map();
const shellClose=VIA.closeSheet;
VIA.closeSheet=function(id){const s=typeof id==="string"?document.getElementById(id):id;shellClose(s);if(!s)return;
  if(document.querySelector(".sheet.open"))document.documentElement.style.overflow="hidden";
  if(s.id==="detailSheet")openId=0;
  const f=returnFocus.get(s.id),el=typeof f==="function"?f():f;returnFocus.delete(s.id);
  if(el&&document.contains(el))setTimeout(()=>el.focus({preventScroll:true}),0)};
const open=(id,from)=>{if(from)returnFocus.set(id,from);VIA.openSheet(id)};

const render=()=>{if(LOAD_ERROR||!view)return;view.innerHTML=UI.list(items,usage,ingredients,q);if(summary)summary.textContent=UI.summary(items)};
const refresh=async()=>{const r=await fetch("/api/products",{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);const d=await r.json();if(!Array.isArray(d))throw new Error("Неожиданный ответ");items=d;lastFetch=Date.now();render();if(openId)renderDetail()};
const refreshOrReload=()=>refresh().catch(()=>location.reload());

if(search)search.addEventListener("input",()=>{q=search.value;render()});
if(view)view.addEventListener("click",e=>{const t=e.target.closest("[data-id],[data-add],[data-add-query],[data-reload]");if(!t)return;
  if(t.dataset.id)openDetail(Number(t.dataset.id),t);
  else if(t.dataset.add)openAdd({id:Number(t.dataset.add)},t);
  else if(t.hasAttribute("data-add-query"))openAdd({query:q.trim()},t);
  else location.reload()});
// Вернулись на вкладку — тихо подтянуть остатки (их могли списать заказы на другом телефоне).
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!LOAD_ERROR&&!document.querySelector(".sheet.open")&&Date.now()-lastFetch>30000)refresh().catch(()=>{})});
addEventListener("pageshow",e=>{if(e.persisted&&!LOAD_ERROR)refresh().catch(()=>{})});

// ——— Карточка ингредиента: сводка и бутылки ———
const detailBody=$("#detailBody"),detailTitle=$("#detailTitle");
const current=()=>stockOf(openId);
function renderDetail(){const p=current();if(!p){if(openId)VIA.closeSheet("detailSheet");return}
  const had=detailBody.contains(document.activeElement);
  detailTitle.textContent=p.ingredient_name;detailBody.innerHTML=UI.detail(p,usage[p.ingredient_id]);
  if(had||document.activeElement===document.body)detailTitle.focus({preventScroll:true})}
function openDetail(id,from){openId=id;renderDetail();detailBody.scrollTop=0;returnFocus.set("detailSheet",()=>view.querySelector('[data-id="'+id+'"]')||from);VIA.openSheet("detailSheet")}
detailBody.addEventListener("click",e=>{const t=e.target.closest("[data-bottle],[data-add-bottle]");if(!t)return;const p=current();if(!p)return;
  if(t.hasAttribute("data-add-bottle")){openAdd({id:p.ingredient_id},t);return}
  const d=(p.details||[])[Number(t.dataset.bottle)];if(d)openEdit(p,d,t)});

// ——— Бутылка: добавить или изменить (одна форма) ———
const form=$("#bottleForm"),msg=$("#bottleMsg"),calc=$("#bottleCalc"),brandOptions=$("#brandOptions"),bottleFor=$("#bottleFor");
const ingPick=$("#ingPick"),ingInput=$("#ingInput"),suggestBox=$("#ingSuggest"),ingHint=$("#ingHint");
const newBox=$("#newIng"),newName=$("#newIngName"),newStrength=$("#newIngStrength"),newMsg=$("#newIngMsg"),newSave=$("#newIngSave");let newUnit="ml";
let editing=null; // бутылка, которую меняем; null — добавляем новую
const selected=()=>ingredients.find(i=>Number(i.id)===Number(form.ingredient_id.value));
const fmt=v=>String(Math.round(Number(v)*100)/100);
function labels(unit){
  const ml=unit!=="g"&&unit!=="pcs",u=UI.unit(unit||"ml");
  form.querySelector('[data-l="volume"]').textContent=(ml?"Объём бутылки, ":unit==="pcs"?"В упаковке, ":"Вес упаковки, ")+u;
  form.querySelector('[data-l="left"]').textContent="Осталось, "+u;
  form.querySelector('[data-l="price"]').textContent=(ml?"Цена бутылки":"Цена упаковки")+", ₽";
  form.volume.placeholder="Например, "+(ml?"700":unit==="pcs"?"10":"1000");form.price.placeholder="Например, "+(ml?"1500":"300");
}
function syncCalc(){
  const sel=selected(),v=Number(form.volume.value),p=form.price.value.trim(),pv=Number(p);
  calc.textContent=sel&&v>0&&p!==""&&pv>=0?"Выходит "+UI.rate(pv/v,sel.unit):"";
}
function renderSuggest(){
  const sel=selected();suggestBox.hidden=!!sel||!newBox.hidden||!!editing;if(suggestBox.hidden){suggestBox.innerHTML="";return}
  const raw=ingInput.value.trim(),nq=UI.norm(raw);
  const list=ingredients.filter(i=>!nq||UI.norm(i.name).includes(nq)).sort((a,b)=>(UI.norm(b.name).startsWith(nq)-UI.norm(a.name).startsWith(nq))||String(a.name).localeCompare(String(b.name),"ru"));
  const exact=list.some(i=>UI.norm(i.name)===nq),top=list.slice(0,6);
  suggestBox.innerHTML=top.map(i=>{const s=stockOf(i.id);return '<button type="button" class="cell" data-pick="'+Number(i.id)+'"><span class="cell-body"><span class="cell-title">'+UI.esc(i.name)+'</span></span><span class="cell-value num">'+(s?UI.qty(s.on_hand,s.unit):"нет на складе")+'</span></button>'}).join("")
    +(list.length>top.length?'<p class="cell more">Ещё '+(list.length-top.length)+' — уточните название</p>':"")
    +'<button type="button" class="cell create" data-create>'+UI.ic("plus")+'<span class="cell-body"><span class="cell-title">'+(nq&&!exact?"Создать «"+UI.esc(raw)+"»":"Создать новый ингредиент")+'</span></span></button>';
}
function syncIngredient(){
  const sel=selected(),s=sel&&stockOf(sel.id);
  labels(sel&&sel.unit);
  ingHint.textContent=!newBox.hidden?"":sel?(s?"В шкафу "+UI.qty(s.on_hand,s.unit)+", в среднем "+UI.rate(s.unit_price,s.unit)+".":"Сейчас этого на складе нет."):"Выберите из списка или создайте новый.";
  const brands=[...new Set(((s&&s.details)||[]).map(d=>d.brand).filter(Boolean))];
  brandOptions.innerHTML=brands.map(b=>'<option value="'+UI.esc(b)+'"></option>').join("");
  renderSuggest();syncCalc();
}
function pick(id,focusNext){const i=ingredients.find(x=>Number(x.id)===Number(id));if(!i)return;form.ingredient_id.value=String(i.id);ingInput.value=i.name;setMsg(msg,"");syncIngredient();if(focusNext)form.brand.focus()}
function resetForm(){form.reset();form.ingredient_id.value="";setMsg(msg,"");setMsg(newMsg,"");busy(form,false);newBox.hidden=true;form.closest(".sheet-body").scrollTop=0}
function openAdd(preset,from){
  editing=null;resetForm();
  ingPick.hidden=false;bottleFor.hidden=true;$("#bottleAddRow").hidden=false;$("#bottleDelRow").hidden=true;
  $("#bottleTitle").textContent="Новая бутылка";$("#bottleHeadSubmit").textContent="Добавить";
  form.quantity.placeholder="Полная";
  ingInput.value=(preset&&preset.query)||"";
  const hasId=!!(preset&&preset.id);
  if(hasId)pick(preset.id);else syncIngredient();
  ingInput.toggleAttribute("autofocus",!hasId);form.brand.toggleAttribute("autofocus",hasId);
  open("bottleSheet",from);
}
function openEdit(p,d,from){
  editing={id:d.id,store:d.store||"",unit:p.unit,brand:d.brand};resetForm();
  form.ingredient_id.value=String(p.ingredient_id);
  ingPick.hidden=true;bottleFor.hidden=false;bottleFor.textContent=p.ingredient_name+(d.volume?"":" · укажите объём и цену бутылки, по ним считается цена коктейлей");$("#bottleAddRow").hidden=true;$("#bottleDelRow").hidden=false;
  $("#bottleTitle").textContent=d.brand||"Бутылка";$("#bottleHeadSubmit").textContent="Сохранить";
  form.quantity.placeholder="0 — пустая";
  labels(p.unit);
  form.brand.value=d.brand||"";form.volume.value=d.volume?fmt(d.volume):"";form.quantity.value=fmt(d.quantity);
  form.price.value=d.bottle_price!=null?fmt(d.bottle_price):"";
  form.brand.removeAttribute("autofocus");form.quantity.setAttribute("autofocus","");
  brandOptions.innerHTML=[...new Set((p.details||[]).map(x=>x.brand).filter(Boolean))].map(b=>'<option value="'+UI.esc(b)+'"></option>').join("");
  syncCalc();
  open("bottleSheet",()=>detailBody.querySelector('[data-bottle="'+(p.details||[]).indexOf(d)+'"]')||from);
}
const addOpen=$("#addOpen");if(addOpen)addOpen.addEventListener("click",e=>openAdd(null,e.currentTarget));
ingInput.addEventListener("input",()=>{form.ingredient_id.value="";syncIngredient()});
ingInput.addEventListener("keydown",e=>{
  if(e.key==="Enter"){e.preventDefault();if(selected())form.brand.focus();else{const f=suggestBox.querySelector("[data-pick]");if(f)pick(f.dataset.pick,true)}}
  else if(e.key==="ArrowDown"&&!suggestBox.hidden){const f=suggestBox.querySelector("button");if(f){e.preventDefault();f.focus()}}});
suggestBox.addEventListener("keydown",e=>{if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;e.preventDefault();
  const bs=[...suggestBox.querySelectorAll("button")],i=bs.indexOf(document.activeElement)+(e.key==="ArrowDown"?1:-1);(i<0?ingInput:bs[Math.min(i,bs.length-1)]).focus()});
suggestBox.addEventListener("click",e=>{const b=e.target.closest("[data-pick],[data-create]");if(!b)return;if(b.dataset.pick)pick(b.dataset.pick,true);else showNew()});
["volume","price","quantity"].forEach(n=>form[n].addEventListener("input",syncCalc));
form.addEventListener("input",e=>{if(!newBox.contains(e.target))setMsg(msg,"")});

const setUnit=u=>{newUnit=u;newBox.querySelectorAll("[data-unit]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.unit===u)))};
newBox.querySelectorAll("[data-unit]").forEach(b=>b.addEventListener("click",()=>setUnit(b.dataset.unit)));
function showNew(){newBox.hidden=false;newName.value=ingInput.value.trim();newStrength.value="0";setUnit("ml");setMsg(newMsg,"");syncIngredient();newName.focus()}
$("#newIngCancel").addEventListener("click",()=>{newBox.hidden=true;setMsg(newMsg,"");syncIngredient();ingInput.focus()});
[newName,newStrength].forEach(el=>el.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();saveNew()}}));
newSave.addEventListener("click",saveNew);
async function saveNew(){
  const name=newName.value.trim(),strength=Number(newStrength.value||0);
  if(!name)return fail(newMsg,"Введите название ингредиента.",newName);
  if(!Number.isFinite(strength)||strength<0||strength>100)return fail(newMsg,"Крепость — число от 0 до 100.",newStrength);
  newSave.disabled=true;setMsg(newMsg,"Сохраняем…",true);
  try{
    const r=await fetch("/api/ingredients",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,unit:newUnit,strength_percent:strength})});
    const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось сохранить ингредиент");
    const id=Number(d.id);if(!ingredients.some(i=>Number(i.id)===id))ingredients.push({id,name,unit:newUnit});
    newBox.hidden=true;setMsg(newMsg,"");pick(id,true);
    VIA.toast(d.exists?"Такой ингредиент уже есть — выбрали его":"Ингредиент сохранён. Теперь бутылка");
  }catch(err){setMsg(newMsg,err.message||"Нет связи — попробуйте ещё раз")}
  finally{newSave.disabled=false}
}

form.addEventListener("submit",async e=>{e.preventDefault();setMsg(msg,"");
  if(!newBox.hidden)return fail(msg,"Сначала сохраните новый ингредиент или нажмите «Отмена».",newName);
  let sel=selected();
  if(!sel&&!editing){const nq=UI.norm(ingInput.value),m=nq?ingredients.filter(i=>UI.norm(i.name).includes(nq)):[],one=m.find(i=>UI.norm(i.name)===nq)||(m.length===1?m[0]:null);if(one){pick(one.id);sel=one}}
  if(!sel&&!editing)return fail(msg,"Выберите ингредиент из списка или создайте новый.",ingInput);
  const unit=editing?editing.unit:sel.unit,u=UI.unit(unit);
  const volume=Number(form.volume.value),leftRaw=form.quantity.value.trim(),priceRaw=form.price.value.trim(),price=Number(priceRaw);
  if(!(volume>0))return fail(msg,unit==="ml"?"Укажите объём бутылки в мл — как на этикетке.":"Укажите, сколько "+u+" в упаковке.",form.volume);
  // Новая бутылка с пустым «Осталось» — полная.
  const quantity=leftRaw===""&&!editing?volume:Number(leftRaw);
  if(leftRaw===""&&editing)return fail(msg,"Укажите, сколько осталось. 0 — бутылка пустая.",form.quantity);
  if(!Number.isFinite(quantity)||quantity<0||(!editing&&quantity<=0))return fail(msg,"Осталось — больше нуля.",form.quantity);
  if(quantity>volume+0.0001)return fail(msg,"Осталось не может быть больше объёма ("+UI.qty(volume,unit)+").",form.quantity);
  if(priceRaw===""||!Number.isFinite(price)||price<0)return fail(msg,unit==="ml"?"Укажите цену бутылки.":"Укажите цену упаковки.",form.price);
  busy(form,true);setMsg(msg,"Сохраняем…",true);
  try{
    const brand=form.brand.value.trim();
    if(editing){await send("PUT",{id:editing.id,brand,store:editing.store,volume,quantity,price});VIA.closeSheet("bottleSheet");VIA.toast(quantity>0?"Сохранено":"Пустая бутылка убрана со склада")}
    else{await send("POST",{ingredient_id:Number(sel.id),brand,volume,quantity,price});VIA.closeSheet("bottleSheet");VIA.toast("Добавлено: "+sel.name+(brand?" "+brand:"")+", "+UI.qty(quantity,unit))}
    editing=null;await refreshOrReload();
  }catch(err){setMsg(msg,(err.message||"Нет связи")+". Попробуйте ещё раз.")}
  finally{busy(form,false)}
});
$("#bottleDel").addEventListener("click",async()=>{if(!editing)return;
  if(!confirm("Убрать «"+(editing.brand||"бутылку")+"» со склада? Покупки в «Закупках» останутся."))return;
  busy(form,true);
  try{await send("DELETE",{id:editing.id});editing=null;VIA.closeSheet("bottleSheet");VIA.toast("Убрано со склада");await refreshOrReload()}
  catch(err){setMsg(msg,(err.message||"Нет связи")+". Попробуйте ещё раз.")}
  finally{busy(form,false)}
});`}
});
</script>`;
        const stockCss=`
#stockView .cell-title{font:600 1.125rem/1.15 var(--serif)}
.list label,label.cell{margin:0}
.sheet-top{z-index:85}
.sheet-head .strong{font-weight:700}
.sheet-top .sheet-head h2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stockView .cell:focus-visible,.sheet .cell:focus-visible{outline-offset:-3px;border-radius:12px}
.empty-state .btn .ic{width:1.3em;height:1.3em;margin:0;color:currentColor}
.sheet-note{margin:2px 4px 10px;font-size:1.0625rem;color:var(--label)}
#stockView>.section:first-child,#stockView>.empty-state:first-child{margin-top:18px}
.cell-sub .low,.cell-value.low{color:var(--warn)}
.cell .badge{flex:none}
.suggest{margin-top:8px}
.suggest .cell{min-height:48px}
.suggest .more{min-height:40px;margin:0;color:var(--label-3);font-size:.8125rem}
.suggest .create,.suggest .create .cell-title{color:var(--gold);font-weight:600}
.new-head{margin-top:18px}
.new-actions{margin-top:12px}
.form-msg{margin:12px 4px 0;font-size:.9375rem;color:var(--danger)}
.form-msg.info{color:var(--label-2)}
.form-msg:empty{display:none}
.empty-state p{margin:0 0 16px}
.empty-state .caption{overflow-wrap:anywhere}`;
        return htmlResponse(renderDocument({
          title:"Склад", app:"bar", tab:"stock", docTitle:"Склад · VIA Бар",
          right:`<button class="icon-btn" type="button" id="addOpen" aria-label="Добавить бутылку">${icon("plus")}</button>`,
          sub:`<span id="stockSummary">${stockLoadError?"Бутылки в шкафу и их остатки":ui.summary(stockItems)}</span>`,
          extraCss:stockCss,
          body:stockBody+stockSheets,
        }).replace("</main>",()=>"</main>"+stockScript));
      }


      // ═══════ route-block: /menu ═══════ (agents: edit only inside your own block)

      if (url.pathname === "/menu") {
        // Гостевое приложение VIA Bar: три вкладки (Меню · Заказ · Профиль) на одной странице.
        // Дизайн «Слоновая кость и бордо»: плитки коктейлей по две в ряд, карточка с фото на всю ширину,
        // заказ с маршрутом статусов, вход «Знакомимся» при первой отправке, бордовая карта гостя.
        const guestCss = `
.pane[hidden]{display:none!important}
.tabbar button.tab{border:0;font-family:inherit;cursor:pointer;padding:0;background:transparent}
.app-guest .screen{padding-bottom:calc(var(--tabbar-h) + 104px + var(--safe-b))}
/* бренд и приветствие */
.brand{display:grid;grid-template-columns:42px 1fr 42px;align-items:center;margin-top:6px}
.brand .wordmark{grid-column:2}
.avatar{grid-column:3;justify-self:end;width:40px;height:40px;border-radius:50%;border:0;display:grid;place-items:center;background:var(--btn-fill);color:var(--btn-ink);font:600 1.1875rem/1 var(--serif);cursor:pointer;padding:0;box-shadow:0 6px 14px rgba(80,18,34,.18)}
.avatar .ic{width:20px;height:20px}
.hello{margin-top:24px}
/* на телефоне имя всегда отдельной строкой: приветствие одинаково утром и вечером, с коротким и длинным именем;
   на планшете и компьютере места хватает — одна строка */
.hello em{display:block;overflow-wrap:anywhere}
@media (min-width:600px){.hello em{display:inline}}
.menu-tools{margin-top:18px}
.menu-tools .chips{margin-top:12px}
/* плитки меню */
.menu-sec{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:26px 2px 12px}
.menu-sec h2{margin:0;font:600 1.5625rem/1.1 var(--serif)}
.menu-sec span{font-size:.78125rem;font-weight:600;color:var(--label-3)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 14px}
@media (min-width:600px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.dk{min-width:0;display:flex;flex-direction:column}
.dk-open{display:block;width:100%;text-align:left;background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer}
.dk-open:active .ph{transform:scale(.98)}
.ph{position:relative;display:block;border-radius:20px;overflow:hidden;aspect-ratio:4/5;background:#2A0A14;box-shadow:0 12px 26px rgba(84,24,38,.16);transition:transform .15s ease}
.ph img{width:100%;height:100%;object-fit:cover;display:block}
.ph-empty{display:grid;place-items:center;color:var(--brass);background:var(--bg-raised-2);box-shadow:none}
.ph-empty .ic{width:34px;height:34px}
.dk-name{display:block;margin-top:12px;font:600 1.1875rem/1.12 var(--serif);color:var(--label)}
.dk-ing{display:block;margin-top:4px;font-size:.75rem;line-height:1.35;color:var(--label-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:10px;min-height:44px}
.dk-ft>b{font-size:.9375rem;white-space:nowrap}
.add-pill{position:relative;height:34px;border-radius:17px;padding:0 14px;border:0;display:inline-flex;align-items:center;font:inherit;font-weight:700;font-size:.8125rem;background:var(--btn-fill);color:var(--btn-ink);cursor:pointer;white-space:nowrap}
.add-pill::after{content:"";position:absolute;left:0;right:0;top:-5px;bottom:-5px}
.add-pill:active{transform:scale(.95)}
.dk .stepper{min-width:90px}
/* цены скрыты (Ещё → Цены в меню гостей): «В заказ» и счётчик — на всю ширину плитки, по центру */
.dk-ft.no-price .menu-side{flex:1;min-width:0}.dk-ft.no-price .add-pill{width:100%;justify-content:center}.dk-ft.no-price .stepper{width:100%;justify-content:space-between}
/* Нет в наличии: фото под тёплой тёмной маской цвета «чернил» сайта, цвет коктейля виден */
.dk.is-out .ph::after,.cs-hero.is-out::after{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,rgba(42,14,22,.38),rgba(42,14,22,.56));pointer-events:none}
.dk.is-out .dk-name{color:var(--label-2)}
.dk.is-out .dk-ft>b{color:var(--label-3);font-weight:600}
.tag{position:absolute;z-index:2;left:10px;bottom:10px;height:26px;border-radius:13px;padding:0 10px;display:flex;align-items:center;font-size:.71875rem;font-weight:700;background:rgba(255,250,242,.92);color:#5A1322}
/* полоса заказа над вкладками */
.cart-bar{position:fixed;z-index:45;left:max(14px,calc(50% - 346px));right:max(14px,calc(50% - 346px));bottom:calc(var(--tabbar-h) + 12px + var(--safe-b));min-height:60px;display:flex;align-items:center;gap:12px;padding:8px 9px 8px 18px;border-radius:20px;background:var(--btn-fill);color:var(--btn-ink);box-shadow:0 18px 34px rgba(60,12,24,.32)}
.cart-bar .txt{flex:1;min-width:0;font-weight:700;font-size:.9375rem;line-height:1.2}
.cart-bar .txt small{display:block;margin-top:2px;font-weight:500;font-size:.78125rem;opacity:.82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cart-bar .go{flex:none;height:42px;border-radius:14px;padding:0 14px;border:0;display:inline-flex;align-items:center;gap:6px;font:inherit;font-weight:700;font-size:.875rem;background:rgba(255,255,255,.14);color:inherit;cursor:pointer;white-space:nowrap}
.cart-bar .go .ic{width:16px;height:16px}
/* карточка коктейля */
.cs-panel .sheet-body{padding:0}
.cs-hero{position:relative;width:100%;aspect-ratio:1/1;max-height:min(56dvh,560px);background:#2A0A14;overflow:hidden}
.cs-hero img{width:100%;height:100%;object-fit:cover;display:block}
.cs-x{position:absolute;top:14px;right:14px;z-index:3;width:40px;height:40px;border-radius:50%;border:0;display:grid;place-items:center;background:rgba(255,250,242,.9);color:#3A0F18;cursor:pointer;padding:0}
.cs-x .ic{width:18px;height:18px}
.cs-card{position:relative;z-index:2;margin-top:-30px;border-radius:30px 30px 0 0;background:var(--paint) no-repeat,var(--bg);padding:12px 22px 0}
.cs-card .sheet-grabber{margin:0 auto 16px}
.cs-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.cs-str{display:inline-flex;align-items:center;gap:6px}
.cs-str .label-caps{color:var(--brass);margin-left:4px}
.cs-price{font:600 1.75rem/1 var(--serif);color:var(--accent)}
.cs-name{margin:12px 0 0;font:600 2.5rem/1.02 var(--serif)}
.cs-desc{margin:10px 0 0;font-size:.90625rem;line-height:1.55;color:var(--label-2)}
.cs-comp{margin-top:20px}
.ing-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.ing-chips span{min-height:32px;border-radius:16px;padding:6px 13px;display:inline-flex;align-items:center;background:var(--bg-raised);box-shadow:inset 0 0 0 1px var(--sep-strong);font-size:.8125rem;font-weight:600;color:var(--label-2)}
.cs-act{position:sticky;bottom:0;z-index:2;display:flex;gap:12px;align-items:center;margin-top:16px;padding:16px 22px 18px;background:linear-gradient(180deg,rgba(246,239,229,0),var(--bg) 32%)}
.cs-act .btn{flex:1}
.cs-act .stepper{height:50px;min-width:122px;border-radius:16px}
.cs-act .stepper button{width:44px;height:50px}
.cs-out{flex:1;font-size:.8125rem;line-height:1.45;color:var(--label-2)}
/* заказ */
.pane-head{margin-top:6px}
.oi{position:relative;display:flex;align-items:center;gap:12px;padding:14px 16px}
.oi+.oi::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;background:var(--sep)}
.oi .body{flex:1;min-width:0}
.oi .name-serif{display:block}
.oi small{display:block;font-size:.78125rem;color:var(--label-3);margin-top:2px}
.tot{display:flex;align-items:baseline;justify-content:space-between;padding:14px 16px 4px;border-top:1px solid var(--sep)}
.tot b{font:600 1.875rem/1 var(--serif)}
.send{display:flex;width:calc(100% - 32px);margin:12px 16px 16px}
.live{padding:16px;margin-top:14px}
.live-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.live .route{margin-top:14px}
.route-body b{display:block;font-size:.875rem;font-weight:700;line-height:1.3}
.route-body small{display:block;font-size:.78125rem;color:var(--label-3);margin-top:1px}
.route-stop:not(.done):not(.current) .route-body b{color:var(--label-3)}
.orders-list{margin-top:12px}
.ord .name-serif{font-size:1.0625rem}
.order-cancelled{display:flex;align-items:center;gap:8px;padding:10px 0 0;color:var(--danger);font-size:.8125rem;font-weight:600}
.order-cancelled .ic{width:16px;height:16px;flex:none}
/* профиль: карта гостя */
.gcard{position:relative;margin-top:16px;min-height:224px;border-radius:24px;overflow:hidden;padding:20px 22px 18px;color:#F6ECDF;display:flex;flex-direction:column;background:radial-gradient(90% 120% at 100% 0%,rgba(214,120,110,.28),rgba(214,120,110,0) 60%),linear-gradient(145deg,#80243A 0%,#521425 55%,#33091A 100%);box-shadow:0 22px 44px rgba(64,12,26,.35),inset 0 0 0 1px rgba(227,195,128,.25)}
.gcard .gl{position:absolute;right:-20px;top:0;width:250px;height:100%;fill:none;stroke:#E3C380;stroke-width:.6;opacity:.32;pointer-events:none}
.gcard-top{position:relative;display:flex;justify-content:space-between;align-items:flex-start}
.gcard .wordmark{text-align:left}
.gcard .wordmark b{font-size:1.375rem;letter-spacing:.3em;margin-right:0;color:#E3C380}
.gcard .wordmark span{color:rgba(246,236,223,.7);margin-top:5px}
.gcard-top .monogram{width:46px;height:46px}
.gcard-who{position:relative;margin-top:22px}
.gcard-who b{display:block;font:600 2.125rem/1 var(--serif);overflow-wrap:anywhere}
.gcard-who span{display:block;margin-top:6px;font-size:.8125rem;letter-spacing:.06em;color:rgba(246,236,223,.72)}
.gcard-st{position:relative;display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:20px;margin-top:auto;padding-top:22px}
.gcard-st.no-money{grid-template-columns:auto minmax(0,1fr)}
.gcard-st b{display:block;font-size:1.0625rem;font-weight:700;color:#F6ECDF;line-height:1.05;white-space:nowrap}
.gcard-st b.fav{font:italic 600 1.1875rem/1.05 var(--serif);color:#E3C380;white-space:normal}
.gcard-st span{display:block;margin-top:5px;font-size:.6875rem;line-height:1.2;color:rgba(246,236,223,.68)}
.last{padding:16px}
.last-r{display:flex;gap:12px;align-items:center}
.last-r .body{flex:1;min-width:0}
.last .btn{margin-top:14px;width:100%;min-height:46px}
.rows-gap{margin-top:14px}
.cell-title.acc{color:var(--accent)}
.welcome{text-align:center;padding:24px 4px 8px}
.welcome .monogram{margin:0 auto 14px}
.welcome h2{font:600 2rem/1.1 var(--serif);margin:0 0 8px}
.welcome p{color:var(--label-2);margin:0 auto 22px;max-width:30ch;line-height:1.5}
.welcome .btn{width:100%}
.welcome .btn+.btn{margin-top:10px}
/* вход и регистрация */
.auth-panel .sheet-body{padding:4px 22px 26px}
.auth-x{position:absolute;top:10px;right:10px;z-index:2}
.auth-title{margin:6px 0 0;font:600 2rem/1.05 var(--serif)}
.auth-sub{margin:6px 0 16px;color:var(--label-2);font-size:.875rem;line-height:1.45}
.auth-note{margin:-6px 0 14px;padding:10px 14px;border-radius:14px;background:var(--tint);color:var(--tint-ink);font-size:.8125rem;font-weight:600;line-height:1.4}
.fbox{display:block;margin:12px 0 0;padding:9px 16px 8px;border-radius:16px;background:var(--bg-raised);box-shadow:inset 0 0 0 1px var(--sep-strong)}
.fbox:focus-within{box-shadow:inset 0 0 0 1.6px var(--brass)}
.fbox>span{display:block;margin:0;font-size:.71875rem;font-weight:600;color:var(--label-3)}
.fbox input{display:block;width:100%;min-height:30px;margin-top:2px;padding:2px 0!important;border:0;background:transparent!important;box-shadow:none!important;border-radius:0!important;font:inherit;font-weight:600;font-size:max(16px,1rem);color:var(--label);outline:none}
.auth-why{margin:12px 2px 0;font-size:.78125rem;color:var(--label-3);line-height:1.45}
.form-alert{margin:10px 2px 0;font-size:.8125rem;font-weight:600;color:var(--danger)}
.form-alert:empty{display:none}
.auth-panel .btn-block{margin-top:16px}
/* оценки */
.stars{display:flex;gap:2px;margin:4px 0 2px -8px}
.stars button{width:44px;height:44px;border:0;background:none;color:var(--label-3);display:grid;place-items:center;cursor:pointer;padding:0}
.stars button .ic{width:24px;height:24px}
.stars button[aria-checked=true]{color:var(--brass)}
.stars button[aria-checked=true] .ic{fill:currentColor}
.stars-static{color:var(--brass);letter-spacing:2px}
.review-item{padding:14px 16px}
.review-item+.review-item{border-top:1px solid var(--sep)}
.review-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.rev-form textarea{min-height:60px;margin-top:6px}
.rev-form .btn{margin-top:10px}
`;
        // Гильош — тонкие золотые волны на карте гостя (как на ценных бумагах).
        const guilloche = (() => {
          const w = 230, h = 214;
          let p = "";
          for (let k = 0; k < 18; k++) {
            let d = "";
            for (let x = 0; x <= w; x += 3) d += (x ? "L" : "M") + x + " " + (h / 2 + Math.sin(x / 24 + k * 0.36) * (30 + k * 2.6) * Math.sin(x / 92 + 0.5)).toFixed(1);
            p += `<path d="${d}"/>`;
          }
          return `<svg class="gl" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${p}</svg>`;
        })();
        const guestTabs = `<nav class="tabbar" aria-label="Разделы">
<button class="tab" type="button" data-pane="menu" aria-current="page">${icon("coupe")}<span>Меню</span></button>
<button class="tab" type="button" data-pane="order">${icon("chit")}<span>Заказ</span><b class="tab-badge" id="cartBadge" hidden></b></button>
<button class="tab" type="button" data-pane="profile">${icon("person")}<span>Профиль</span></button>
</nav>
<div class="cart-bar" id="cartBar" hidden><div class="txt" id="cartBarText" role="status" aria-live="polite"></div><button class="go" type="button" id="cartBarGo">К заказу${icon("arrow")}</button></div>`;
        const guestSheets = `
<div class="sheet" id="cocktailSheet" hidden><div class="sheet-panel cs-panel" role="dialog" aria-modal="true" aria-labelledby="csTitle">
<div class="sheet-body" id="csBody"></div></div></div>

<div class="sheet" id="authSheet" hidden><div class="sheet-panel auth-panel" role="dialog" aria-modal="true" aria-labelledby="authTitle">
<div class="sheet-grabber"></div><button class="icon-btn auth-x" type="button" data-close-sheet aria-label="Закрыть">${icon("close")}</button>
<div class="sheet-body">
<h2 class="auth-title" id="authTitle">Знакомимся</h2>
<p class="auth-sub" id="authSub">Один раз — и мы будем знать, кому нести коктейль.</p>
<p class="auth-note" id="authNote" hidden></p>
<div class="segmented" role="tablist" aria-label="Вход или регистрация"><button type="button" role="tab" id="authTabLogin" aria-selected="false">Войти</button><button type="button" role="tab" id="authTabReg" aria-selected="true">Зарегистрироваться</button></div>
<form id="loginForm" autocomplete="on" hidden>
<label class="fbox"><span>Телефон</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+7 900 123-45-67"></label>
<label class="fbox"><span>PIN-код</span><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4,12}" required placeholder="4–12 цифр"></label>
<p class="form-alert" id="loginMsg" role="alert"></p><button class="btn btn-primary btn-block" type="submit" id="loginBtn">Войти</button></form>
<form id="regForm" autocomplete="on">
<label class="fbox"><span>Имя</span><input name="name" autocomplete="name" required minlength="2" maxlength="80" placeholder="Как вас зовут"></label>
<label class="fbox"><span>Телефон</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+7 900 123-45-67"></label>
<label class="fbox"><span>Придумайте PIN-код</span><input name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4,12}" required placeholder="4–12 цифр"></label>
<p class="form-alert" id="regMsg" role="alert"></p><button class="btn btn-primary btn-block" type="submit" id="regBtn">Зарегистрироваться</button>
<p class="auth-why">Телефон и PIN нужны, чтобы сохранилась ваша история заказов.</p></form>
</div></div></div>

<div class="sheet" id="reviewsSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="revTitle">
<div class="sheet-grabber"></div><div class="sheet-head"><span class="left"></span><h2 id="revTitle">Мои оценки</h2><button class="btn btn-plain right" type="button" data-close-sheet>Готово</button></div>
<div class="sheet-body"><p class="footnote" style="margin:0 2px 14px">Оцените выпитые коктейли — нам важно знать, что понравилось.</p><div class="list" id="revList"><div class="skeleton"></div></div></div></div></div>`;
        const guestBody = `
<section class="pane" data-pane="menu" aria-label="Меню">
<div class="brand"><span></span>${wordmark()}<button class="avatar" type="button" data-goto="profile" id="avatarBtn" aria-label="Профиль">${icon("person")}</button></div>
<h1 class="large-title hello" id="hello">Добро пожаловать</h1>
<p class="screen-sub" style="margin-bottom:0">Что приготовим сегодня?</p>
<div class="menu-tools"><label class="search">${icon("search")}<input type="search" id="q" placeholder="Коктейль или ингредиент" autocomplete="off" aria-label="Поиск по меню"></label>
<div class="chips" id="lineChips" role="group" aria-label="Крепость"></div></div>
<div id="menuList"><div class="grid" style="margin-top:26px"><div class="skeleton" style="aspect-ratio:4/5"></div><div class="skeleton" style="aspect-ratio:4/5"></div></div></div>
</section>
<section class="pane" data-pane="order" aria-label="Заказ" hidden>
<div class="pane-head"><h1 class="large-title">Ваш заказ</h1><p class="screen-sub" id="orderSub" style="margin-bottom:0"></p></div>
<div id="cartBox"></div>
<div id="ordersBox"></div>
</section>
<section class="pane" data-pane="profile" aria-label="Профиль" hidden>
<div class="pane-head"><h1 class="large-title">Профиль</h1></div>
<div id="profileBox"><div class="skeleton" style="height:224px;border-radius:24px;margin-top:16px"></div></div>
</section>`;
        const guestScript = String.raw`<script>
(function(){
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm=s=>String(s||"").toLocaleLowerCase("ru").replace(/ё/g,"е");
const rub=n=>Number(n||0).toLocaleString("ru-RU",{maximumFractionDigits:0})+" ₽";
// Сумма с приставкой (« · 520 ₽») или ничего — когда бармен скрыл цены, сервер присылает вместо сумм null.
const money=(n,pre)=>n==null?"":(pre||"")+rub(n);
const plural=(n,f)=>{const a=Math.abs(n)%100,b=a%10;return f[a>10&&a<20?2:b===1?0:b>=2&&b<=4?1:2]};
const cocktailsWord=n=>n+" "+plural(n,["коктейль","коктейля","коктейлей"]);
const toDate=s=>s?new Date(String(s).replace(" ","T")+(/[zZ]|[+-]\d\d:?\d\d$/.test(s)?"":"Z")):null;
const hm=d=>d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
const when=s=>{const d=toDate(s);if(!d||isNaN(d))return"";const today=new Date();return d.toDateString()===today.toDateString()?"сегодня в "+hm(d):d.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})+", "+hm(d)};
const ic=n=>'<svg class="ic" aria-hidden="true"><use href="#i-'+n+'"/></svg>';
const LINES=[{key:"Безалкогольный",cls:"line-zero",title:"Без градуса",dots:0,label:"Без алкоголя"},{key:"Лёгкий",cls:"line-light",title:"Лёгкие",dots:1,label:"Лёгкий"},{key:"Средний",cls:"line-mid",title:"Средние",dots:2,label:"Средний"},{key:"Крепкий",cls:"line-strong",title:"Крепкие",dots:3,label:"Крепкий"}];
const lineOf=c=>{const s=norm(c.strength);return LINES.find(l=>norm(l.key)===s)||(s.includes("безалк")?LINES[0]:s.includes("лег")?LINES[1]:s.includes("сред")?LINES[2]:s.includes("креп")?LINES[3]:null)};
// Крепость точками: заполнено столько, сколько «градусов» у линии (из трёх).
const scale=l=>l?'<span class="scale" role="img" aria-label="Крепость: '+l.label.toLowerCase()+'">'+[0,1,2].map(i=>'<i'+(i<l.dots?' class="f"':"")+'></i>').join("")+'</span>':"";
const tile=c=>c.avatar_url||c.photo_url||"";   // плитка меню 4:5 — кадр, выбранный в редакторе
const hero=c=>c.photo_url||c.avatar_url||"";   // карточка — квадратное фото целиком
const ingNames=c=>{const seen=new Map();(c.recipe_items||[]).forEach(i=>{const n=String(i.ingredient_name||i.name||"").trim();if(n&&!seen.has(norm(n)))seen.set(norm(n),n)});return [...seen.values()]};

let cocktails=[],byId=new Map(),guest=null,stats=null,lineFilter="all",pane="menu",pendingSend=false,sending=false;
// Уведомления гостю («заказ готов»): состояние на этом телефоне.
let pushState="";
function refreshPush(){if(!guest||!window.VIA||!VIA.push)return Promise.resolve();return VIA.push.state("guest").then(st=>{pushState=st;if(pane==="order")renderOrders();if(pane==="profile")renderProfile()})}
function togglePush(){if(!window.VIA||!VIA.push)return;
if(pushState==="install"){VIA.toast("Уведомления работают в приложении: Поделиться → «На экран „Домой“», затем откройте меню оттуда",true,6000);return}
if(pushState==="denied"){VIA.toast("Уведомления запрещены: Настройки → Уведомления → VIA Bar",true,5000);return}
if(pushState==="unsupported"){VIA.toast(VIA.push.text.unsupported,true);return}
const off=pushState==="on";(off?VIA.push.disable("guest"):VIA.push.enable("guest")).then(()=>VIA.toast(off?"Уведомления выключены":"Готово — напишем, когда примем заказ и когда он будет готов")).catch(e=>VIA.toast(e.message||"Не получилось",true,4000)).then(refreshPush)}
document.addEventListener("click",e=>{if(e.target.closest("#pushToggle,#pushAsk"))togglePush()});
let cart={};try{cart=JSON.parse(localStorage.getItem("via.cart")||"{}")||{}}catch(e){cart={}}
const saveCart=()=>{try{localStorage.setItem("via.cart",JSON.stringify(cart))}catch(e){}};
const cartItems=()=>Object.entries(cart).map(([id,q])=>({c:byId.get(Number(id)),q:Number(q)})).filter(x=>x.c&&x.q>0);
const cartCount=()=>cartItems().reduce((n,x)=>n+x.q,0);
const cartTotal=()=>cartItems().reduce((n,x)=>n+x.q*Number(x.c.price_rub||0),0);
// Гость уже входил на этом телефоне — при первой отправке предлагаем «Войти», а не регистрацию.
const known=()=>{try{return localStorage.getItem("via.known")==="1"}catch(e){return false}};
const markKnown=()=>{try{localStorage.setItem("via.known","1")}catch(e){}};

/* ——— приветствие ——— */
function renderHello(){const h=new Date().getHours(),part=h>=5&&h<12?"Доброе утро":h>=12&&h<17?"Добрый день":h>=17&&h<23?"Добрый вечер":"Доброй ночи";
const first=guest?String(guest.name||"").trim().split(/\s+/)[0]:"";
$("#hello").innerHTML=esc(part)+(first?', <em>'+esc(first)+'</em>':"");
const a=$("#avatarBtn");a.innerHTML=first?esc(first.charAt(0).toLocaleUpperCase("ru")):ic("person");a.setAttribute("aria-label",first?"Профиль: "+first:"Профиль")}

/* ——— вкладки ——— */
const TITLES={menu:"VIA Bar",order:"Ваш заказ",profile:"Профиль"};
function show(p,push){pane=p;document.querySelectorAll(".pane").forEach(s=>s.hidden=s.dataset.pane!==p);document.querySelectorAll(".tabbar .tab").forEach(t=>{if(t.dataset.pane===p)t.setAttribute("aria-current","page");else t.removeAttribute("aria-current")});
$(".nav-title").textContent=TITLES[p];document.title=(p==="menu"?"VIA Bar — меню":TITLES[p]+" · VIA Bar");
if(push!==false&&location.hash!=="#"+p)history.replaceState(null,"","#"+p);window.scrollTo(0,0);dispatchEvent(new Event("scroll"));renderCartBar();
if(p==="order"){renderCart();refreshStats()}if(p==="profile"){renderProfile();refreshStats()}if(p==="menu"&&menuLoadedAt&&Date.now()-menuLoadedAt>20000)loadMenu(true)}
document.querySelectorAll(".tabbar .tab").forEach(t=>t.onclick=()=>show(t.dataset.pane));
addEventListener("hashchange",()=>{const h=location.hash.slice(1);if(TITLES[h]&&h!==pane)show(h,false)});

/* ——— меню ——— */
// Сколько порций можно заказать: столько, на сколько хватает ингредиентов (не больше 20).
const maxOf=c=>!c?0:c.available===false?0:c.available_portions==null?20:Math.max(0,Math.min(20,Number(c.available_portions)));
const isOut=c=>!!c&&maxOf(c)<1;
function stepperHtml(id,q){const c=byId.get(id);const n=esc(c?c.name:"коктейль"),max=maxOf(c);
return '<span class="stepper" data-id="'+id+'"><button type="button" data-d="-1" aria-label="Убрать «'+n+'»">'+ic("minus")+'</button><output role="status" aria-label="«'+n+'» в заказе">'+q+'</output><button type="button" data-d="1" aria-label="Добавить «'+n+'»'+(q>=max?" — больше сейчас нет":"")+'"'+(q>=max?" disabled":"")+'>'+ic("plus")+'</button></span>'}
// Низ плитки: «В заказ», счётчик или ничего (нет в наличии — метка на фото).
function tileSide(id){const c=byId.get(id),q=Number(cart[id]||0);if(q>0)return stepperHtml(id,q);if(isOut(c))return "";
return '<button class="add-pill" type="button" data-add="'+id+'" aria-label="Добавить «'+esc(c?c.name:"коктейль")+'» в заказ">В заказ</button>'}
// Низ карточки коктейля.
function sheetAct(id){const c=byId.get(id),q=Number(cart[id]||0),price=Number(c&&c.price_rub||0);
if(q<1&&isOut(c))return '<p class="cs-out">Закончился один из ингредиентов. Докупим — и коктейль вернётся в меню.</p>';
if(q<1)return '<button class="btn btn-primary" type="button" data-add="'+id+'">Добавить'+(price?" · "+rub(price):"")+'</button>';
return stepperHtml(id,q)+'<button class="btn btn-primary" type="button" data-goto="order">К заказу'+(price?" · "+rub(price*q):"")+'</button>'}
function renderChips(){const present=LINES.filter(l=>cocktails.some(c=>lineOf(c)===l));
$("#lineChips").innerHTML=['<button class="chip" type="button" data-line="all" aria-pressed="'+(lineFilter==="all")+'">Все<small>'+cocktails.length+'</small></button>'].concat(present.map(l=>'<button class="chip" type="button" data-line="'+l.cls+'" aria-pressed="'+(lineFilter===l.cls)+'">'+l.title+'<small>'+cocktails.filter(c=>lineOf(c)===l).length+'</small></button>')).join("")}
function drinkHtml(c){const id=Number(c.id),ings=ingNames(c),p=tile(c),price=Number(c.price_rub||0),out=isOut(c);
return '<article class="dk'+(out?" is-out":"")+'" data-row="'+id+'"><button class="dk-open" type="button" data-open="'+id+'" aria-label="'+esc(c.name)+(out?", нет в наличии":"")+': подробнее">'
+(p?'<span class="ph"><img src="'+esc(p)+'" alt="" loading="lazy" decoding="async">':'<span class="ph ph-empty">'+ic("coupe"))+(out?'<span class="tag">Нет в наличии</span>':"")+'</span>'
+'<span class="dk-name">'+esc(c.name)+'</span>'+(ings.length?'<span class="dk-ing">'+esc(ings.join(" · "))+'</span>':"")+'</button>'
+'<div class="dk-ft'+(price?'':' no-price')+'">'+(price?'<b class="num">'+rub(price)+'</b>':'')+'<span class="menu-side">'+tileSide(id)+'</span></div></article>'}
function renderMenu(){const q=norm($("#q").value.trim());
const match=c=>(lineFilter==="all"||(lineOf(c)||{}).cls===lineFilter)&&(!q||norm(c.name+" "+(c.description||"")+" "+ingNames(c).join(" ")).includes(q));
const byStock=list=>list.filter(c=>!isOut(c)).concat(list.filter(isOut));
const groups=LINES.map(l=>({l,items:byStock(cocktails.filter(c=>lineOf(c)===l&&match(c)))})).concat([{l:null,items:byStock(cocktails.filter(c=>!lineOf(c)&&match(c)))}]).filter(g=>g.items.length);
if(!cocktails.length){$("#menuList").innerHTML='<div class="card" style="margin-top:26px"><div class="empty-state">'+ic("coupe")+'<h3>Меню готовится</h3>Скоро здесь появятся коктейли.</div></div>';return}
if(!groups.length){$("#menuList").innerHTML='<div class="card" style="margin-top:26px"><div class="empty-state">'+ic("search")+'<h3>Ничего не нашлось</h3>Попробуйте другое название или ингредиент.</div></div>';return}
$("#menuList").innerHTML=groups.map(g=>'<div class="menu-sec"><h2>'+(g.l?g.l.title:"Другие")+'</h2><span>'+cocktailsWord(g.items.length)+'</span></div><div class="grid">'+g.items.map(drinkHtml).join("")+'</div>').join("")}
function updateRow(id){document.querySelectorAll('[data-row="'+id+'"] .menu-side').forEach(el=>{el.innerHTML=el.closest(".oi")?stepperHtml(id,Number(cart[id]||0)):tileSide(id)});
document.querySelectorAll('[data-sheet-act="'+id+'"]').forEach(el=>el.innerHTML=sheetAct(id))}
function setQty(id,q){const max=maxOf(byId.get(id)),want=q;q=Math.max(0,Math.min(max,q));if(want>q&&want>Number(cart[id]||0))VIA.toast(max?"Больше сейчас не приготовим — хватит на "+max+" "+plural(max,["порцию","порции","порций"]):"Сейчас нет в наличии",true);if(q)cart[id]=q;else delete cart[id];saveCart();updateRow(id);renderCartBar();if(pane==="order")renderCart()}
document.addEventListener("click",e=>{const add=e.target.closest("[data-add]");if(add){const id=Number(add.dataset.add);setQty(id,Number(cart[id]||0)+1);const nb=document.querySelector('[data-row="'+id+'"] .stepper button[data-d="1"]');if(nb&&add.closest(".menu-side"))nb.focus();return}
const st=e.target.closest(".stepper[data-id] button[data-d]");if(st){const id=Number(st.closest(".stepper").dataset.id),d=Number(st.dataset.d);setQty(id,Number(cart[id]||0)+d);return}
const op=e.target.closest("[data-open]");if(op){openCocktail(Number(op.dataset.open));return}
const ch=e.target.closest("#lineChips .chip");if(ch){lineFilter=ch.dataset.line;renderChips();renderMenu()}});
$("#q").addEventListener("input",renderMenu);

function openCocktail(id){const c=byId.get(id);if(!c)return;const l=lineOf(c),ings=ingNames(c),price=Number(c.price_rub||0),out=isOut(c),p=hero(c);
$("#csBody").innerHTML='<div class="cs-hero'+(out?" is-out":"")+'">'+(p?'<img src="'+esc(p)+'" alt="'+esc(c.name)+'">':"")+'<button class="cs-x" type="button" data-close-sheet aria-label="Закрыть">'+ic("close")+'</button></div>'
+'<div class="cs-card"><div class="sheet-grabber"></div><div class="cs-meta"><span class="cs-str">'+(l?scale(l)+'<span class="label-caps">'+l.label+'</span>':"")+'</span>'+(out?'<span class="badge danger">Нет в наличии</span>':price?'<span class="cs-price num">'+rub(price)+'</span>':"")+'</div>'
+'<h3 class="cs-name" id="csTitle">'+esc(c.name)+'</h3>'+(c.description?'<p class="cs-desc">'+esc(c.description)+'</p>':"")
+(ings.length?'<div class="cs-comp"><span class="label-caps">Состав</span><div class="ing-chips">'+ings.map(n=>'<span>'+esc(n)+'</span>').join("")+'</div></div>':"")+'</div>'
+'<div class="cs-act" data-sheet-act="'+id+'">'+sheetAct(id)+'</div>';
VIA.openSheet("cocktailSheet");$("#csBody").scrollTop=0}

/* ——— заказ ——— */
function renderCartBar(){const n=cartCount();const b=$("#cartBadge");b.textContent=n;b.hidden=!n;const bar=$("#cartBar");bar.hidden=!n||pane==="order";
if(n){const names=cartItems().map(x=>x.c.name+(x.q>1?" × "+x.q:"")).join(", ");$("#cartBarText").innerHTML=esc(cocktailsWord(n))+(cartTotal()?' · <span class="num">'+rub(cartTotal())+'</span>':"")+'<small>'+esc(names)+'</small>'}}
$("#cartBarGo").onclick=()=>show("order");
const STEP={pending:0,accepted:1,served:2};
const PILL={pending:["Заказан",""],accepted:["Принят","warn"],served:["Выдан","ok"],cancelled:["Отменён","danger"]};
const pill=st=>{const p=PILL[st]||PILL.pending;return '<span class="badge '+p[1]+'">'+p[0]+'</span>'};
// Маршрут заказа: Заказан → Принят → Выдан; станции до текущей — пройдены.
function route(o){const s=STEP[o.status]??0,t=toDate(o.created_at);
const stops=[["Заказан"+(t&&!isNaN(t)?" в "+hm(t):""),s===0?"Скоро примем заказ":""],["Принят",s===0?"Начнём готовить":s===1?"Готовим":""],["Выдан",s===1?"Скоро принесём":s===2?"Приятного вечера!":""]];
return '<div class="route">'+stops.map((x,i)=>{const done=i<=s,cur=i===s+1;return '<div class="route-stop'+(done?" done":cur?" current":"")+'"><span class="station">'+(done?ic("check"):"")+'</span><div class="route-body"><b>'+esc(x[0])+'</b>'+(x[1]?'<small>'+esc(x[1])+'</small>':"")+'</div></div>'}).join("")+'</div>'}
function renderCart(){const items=cartItems(),n=cartCount();
$("#orderSub").textContent=n?cocktailsWord(n):"Пока ничего не выбрано";
$("#cartBox").innerHTML=items.length?'<div class="card" style="margin-top:18px">'+items.map(x=>{const id=Number(x.c.id),p=tile(x.c);return '<div class="oi" data-row="'+id+'">'+(p?'<img class="thumb" src="'+esc(p)+'" alt="">':'<span class="thumb thumb-ph">'+ic("coupe")+'</span>')+'<span class="body"><span class="name-serif">'+esc(x.c.name)+'</span>'+(Number(x.c.price_rub)?'<small class="num">'+rub(x.c.price_rub)+'</small>':"")+'</span><span class="menu-side">'+stepperHtml(id,x.q)+'</span></div>'}).join("")
+(cartTotal()?'<div class="tot"><span class="label-caps">Итого</span><b class="num">'+rub(cartTotal())+'</b></div>':"")
+'<button class="btn btn-primary send" type="button" id="sendOrder"'+(sending?" disabled":"")+'>'+ic("send")+(sending?"Отправляем…":"Отправить заказ")+'</button></div>'
:'<div class="card" style="margin-top:18px"><div class="empty-state">'+ic("coupe")+'<h3>Пока ничего не выбрано</h3>Загляните в меню и нажмите «В заказ» у коктейля.</div></div><button class="btn btn-tinted btn-block" type="button" data-goto="menu" style="margin-top:12px">Открыть меню</button>';
const sb=$("#sendOrder");if(sb)sb.onclick=sendOrder;renderOrders()}
function renderOrders(){const box=$("#ordersBox");if(!guest){box.innerHTML="";return}const h=(stats&&stats.history)||[];
if(!h.length){box.innerHTML=stats?'<div class="section"><div class="section-header"><h2>Мои заказы</h2></div><div class="card"><div class="empty-state">Заказов пока не было.</div></div></div>':"";return}
// Есть незавершённый заказ, а уведомления выключены — предлагаем сообщить, когда будет готов.
const ask=pushState==="off"&&h.some(o=>o.status==="pending"||o.status==="accepted")?'<div class="list" style="margin-top:14px"><div class="cell has-icon"><span class="cell-icon">'+ic("bell")+'</span><span class="cell-body"><span class="cell-title">Написать, когда заказ будет готов?</span><span class="cell-sub">Пришлём уведомление на этот телефон</span></span><button class="btn btn-primary btn-sm" type="button" id="pushAsk">Включить</button></div></div>':"";
const live=h.filter(o=>o.status==="pending"||o.status==="accepted"),rest=h.filter(o=>!live.includes(o));
// Сколько всего — за всё время, в заголовке списка всех заказов
box.innerHTML='<div class="section"><div class="section-header"><h2>Мои заказы</h2><span class="num">'+cocktailsWord(Number(stats.cocktails_count||0))+money(stats.spent_rub,' · ')+'</span></div>'+ask
+live.map(o=>'<div class="card live"><div class="live-top"><span class="name-serif">Заказ №'+Number(o.id)+(o.items?' · '+esc(o.items):"")+'</span>'+pill(o.status)+'</div>'+route(o)+'</div>').join("")
+(rest.length?'<div class="list orders-list">'+rest.map(o=>'<div class="cell ord"><span class="cell-body"><span class="name-serif">№'+Number(o.id)+(o.items?' · '+esc(o.items):"")+'</span><span class="cell-sub num">'+esc(when(o.created_at))+money(o.total_rub,' · ')+'</span>'+(o.status==="cancelled"?'<span class="order-cancelled">'+ic("close")+'В этот раз не получилось — попробуйте ещё раз</span>':"")+'</span>'+pill(o.status)+'</div>').join("")+'</div>':"")+'</div>'}
document.addEventListener("click",e=>{const g=e.target.closest("[data-goto]");if(g){if(g.closest(".sheet"))VIA.closeSheet(g.closest(".sheet"));show(g.dataset.goto)}});
async function sendOrder(){if(sending)return;const items=cartItems().map(x=>({cocktail_id:Number(x.c.id),quantity:x.q}));if(!items.length)return;
if(!guest){pendingSend=true;openAuth(known()?"login":"reg");return}
sending=true;renderCart();
try{const r=await fetch("/api/guest/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items})});const d=await r.json().catch(()=>({}));
if(r.status===401){guest=null;pendingSend=true;renderHello();openAuth("login","Сессия закончилась — войдите ещё раз.");return}
if(r.status===409){await loadMenu(true);throw new Error(d.error||"Чего-то из заказа сейчас нет")}
if(!r.ok)throw new Error(d.error||"Не удалось отправить заказ");
cart={};saveCart();cocktails.forEach(c=>updateRow(Number(c.id)));VIA.toast("Заказ №"+d.order_id+" отправлен в бар");await refreshStats(true);loadMenu(true)}
catch(e){VIA.toast(e.message||"Ошибка сети. Попробуйте ещё раз.",true)}
finally{sending=false;renderCart();renderCartBar()}}

/* ——— профиль ——— */
const GUILLOCHE=${JSON.stringify(guilloche)},LOGO_GOLD=${JSON.stringify(monogram(46, "gold"))},LOGO=${JSON.stringify(monogram(132))},WM=${JSON.stringify(wordmark("Карта гостя"))};
const chev=()=>ic("chevronRight").replace('class="ic"','class="ic cell-chevron"');
function renderProfile(){const box=$("#profileBox");
if(!guest){box.innerHTML='<div class="welcome">'+LOGO+'<h2>Добро пожаловать</h2><p>Войдите, чтобы заказывать коктейли, следить за заказом и оценивать выпитое.</p><button class="btn btn-primary" type="button" id="pLogin">Войти</button><button class="btn btn-gray" type="button" id="pReg">Зарегистрироваться</button></div>';
// Вход из профиля — без отправки заказа (её включает только кнопка «Отправить заказ»).
$("#pLogin").onclick=()=>{pendingSend=false;openAuth("login")};$("#pReg").onclick=()=>{pendingSend=false;openAuth("reg")};return}
const s=stats||{},digits=String(guest.phone||"").replace(/\D/g,""),last4=digits.slice(-4),latest=(s.history||[])[0],li=s.latest_order_items||[];
const lp=li.find(i=>i.photo_url);
box.innerHTML='<div class="gcard">'+GUILLOCHE+'<div class="gcard-top">'+WM+LOGO_GOLD+'</div>'
+'<div class="gcard-who"><b>'+esc(guest.name)+'</b>'+(last4.length===4?'<span class="num">+7 ••• ••• '+last4.slice(0,2)+' '+last4.slice(2)+'</span>':"")+'</div>'
+'<div class="gcard-st'+(s.visit_rub==null?' no-money':'')+'"><div><b class="num">'+Number(s.visit_cocktails||0)+'</b><span>'+plural(Number(s.visit_cocktails||0),["коктейль","коктейля","коктейлей"])+'<br>за визит</span></div>'+(s.visit_rub==null?'':'<div><b class="num">'+rub(s.visit_rub)+'</b><span>потрачено<br>за визит</span></div>')
+(s.favorite_cocktail?'<div><b class="fav">'+esc(s.favorite_cocktail)+'</b><span>любимый<br>коктейль</span></div>':"")+'</div></div>'
+(latest?'<div class="section"><div class="section-header"><h2>Последний заказ</h2><span>'+esc(when(latest.created_at))+'</span></div><div class="card last"><div class="last-r">'+(lp?'<img class="thumb" src="'+esc(lp.photo_url)+'" alt="">':'<span class="thumb thumb-ph">'+ic("coupe")+'</span>')+'<span class="body"><span class="name-serif" style="display:block">'+esc(latest.items||"—")+'</span><span class="cell-sub num">'+money(latest.total_rub,'')+(latest.total_rub==null?'':' · ')+(PILL[latest.status]||PILL.pending)[0]+'</span></span></div>'+(li.length?'<button class="btn btn-outline" type="button" id="repeatOrder">'+ic("repeat")+'Повторить заказ</button>':"")+'</div></div>':"")
+'<div class="list rows-gap"><button class="cell has-icon" type="button" data-goto="order"><span class="cell-icon">'+ic("chit")+'</span><span class="cell-body"><span class="cell-title">Мои заказы</span><span class="cell-sub">'+Number(s.orders_count||0)+' '+plural(Number(s.orders_count||0),["заказ","заказа","заказов"])+(s.orders_count?' · '+cocktailsWord(Number(s.cocktails_count||0))+money(s.spent_rub,' · '):'')+'</span></span>'+chev()+'</button>'
+'<button class="cell has-icon" type="button" id="openReviews"><span class="cell-icon">'+ic("star")+'</span><span class="cell-body"><span class="cell-title">Мои оценки</span><span class="cell-sub">Оцените выпитые коктейли</span></span>'+chev()+'</button>'
+(pushState&&pushState!=="unsupported"?'<button class="cell has-icon" type="button" id="pushToggle"><span class="cell-icon">'+ic("bell")+'</span><span class="cell-body"><span class="cell-title">Уведомления о заказе</span><span class="cell-sub">'+esc(pushState==="off"?"Напишем, когда примем заказ и когда он будет готов":VIA.push.text[pushState]||"")+'</span></span><span class="cell-value">'+(pushState==="on"?"Вкл.":pushState==="off"?"Выкл.":"")+'</span></button>':"")
+'<button class="cell has-icon" type="button" id="logout"><span class="cell-icon">'+ic("logout")+'</span><span class="cell-body"><span class="cell-title acc">Выйти</span></span></button></div>';
// Повторить заказ: добавляем только то, что сейчас есть в наличии (не больше остатка).
const rp=$("#repeatOrder");if(rp)rp.onclick=()=>{const added=[],out=[],less=[];
li.forEach(i=>{const id=Number(i.cocktail_id),c=byId.get(id),want=Number(i.quantity||1),max=maxOf(c),name=(c&&c.name)||i.cocktail_name||"Коктейль";
if(!c||max<1){out.push("«"+name+"»");return}
const have=Number(cart[id]||0),next=Math.min(max,have+want);if(next>have){cart[id]=next;added.push(name)}
if(have+want>max)less.push("«"+name+"» — только "+max)});
saveCart();cocktails.forEach(c=>updateRow(Number(c.id)));renderCartBar();
if(!added.length){VIA.toast(out.length?"Сейчас нет в наличии: "+out.join(", ")+". Повторить заказ не получится.":"Больше сейчас не приготовим: "+less.join(", "),true,5000);return}
const note=(out.length?" Нет в наличии: "+out.join(", ")+".":"")+(less.length?" Хватит не на всё: "+less.join(", ")+".":"");
VIA.toast("Добавили в заказ."+note,!!note,note?5000:2600);show("order")};
$("#openReviews").onclick=openReviews;$("#logout").onclick=logout}

async function refreshStats(force){if(!guest){renderOrders();return}try{const r=await fetch("/api/guest/stats");const d=await r.json();if(!d.guest){guest=null;stats=null;renderHello()}else stats=d}catch(e){}if(pane==="order")renderOrders();if(pane==="profile")renderProfile()}
setInterval(()=>{if(!document.hidden&&guest&&pane!=="menu")refreshStats()},15000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&guest&&pane!=="menu")refreshStats()});

/* ——— вход и регистрация ——— */
function authMode(m){const login=m==="login",send=pendingSend;$("#loginForm").hidden=!login;$("#regForm").hidden=login;$("#authTabLogin").setAttribute("aria-selected",String(login));$("#authTabReg").setAttribute("aria-selected",String(!login));
$("#authTitle").textContent=login?"С возвращением":"Знакомимся";
$("#authSub").textContent=login?"Телефон и PIN-код, которые вы указали при регистрации.":"Один раз — и мы будем знать, кому нести коктейль.";
$("#loginBtn").textContent=send?"Войти и отправить":"Войти";$("#regBtn").textContent=send?"Зарегистрироваться и отправить":"Зарегистрироваться";
$("#loginMsg").textContent="";$("#regMsg").textContent=""}
function openAuth(m,note){authMode(m||"login");$("#authNote").textContent=note||"";$("#authNote").hidden=!note;VIA.openSheet("authSheet");setTimeout(()=>{const f=(m==="reg"?$("#regForm"):$("#loginForm")).querySelector("input");if(f)f.focus()},320)}
$("#authTabLogin").onclick=()=>authMode("login");$("#authTabReg").onclick=()=>authMode("reg");
async function afterAuth(name){markKnown();VIA.closeSheet("authSheet");await loadMe();
// Уведомления уже включены на этом телефоне — привязываем их к вошедшему гостю.
if(window.VIA&&VIA.push)VIA.push.state("guest").then(st=>{if(st==="on")return VIA.push.enable("guest")}).catch(()=>{});VIA.toast("Здравствуйте, "+(name||(guest&&guest.name)||"гость")+"!");if(pendingSend){pendingSend=false;show("order");sendOrder()}else if(pane!=="menu")show(pane,false)}
$("#loginForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),m=$("#loginMsg");m.textContent="";$("#loginBtn").disabled=true;
try{const r=await fetch("/api/guest/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone:f.get("phone"),pin:f.get("pin")})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось войти");e.target.reset();afterAuth(d.name)}catch(err){m.textContent=err.message||"Ошибка сети. Попробуйте ещё раз."}finally{$("#loginBtn").disabled=false}};
$("#regForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),m=$("#regMsg");m.textContent="";$("#regBtn").disabled=true;
try{const r=await fetch("/api/guest/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:f.get("name"),phone:f.get("phone"),pin:f.get("pin")})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось зарегистрироваться");const nm=f.get("name");e.target.reset();afterAuth(nm)}catch(err){m.textContent=err.message||"Ошибка сети. Попробуйте ещё раз."}finally{$("#regBtn").disabled=false}};
async function logout(){if(!confirm("Выйти из профиля?"))return;try{if(pushState==="on")await VIA.push.disable("guest")}catch(e){}try{await fetch("/api/guest/logout",{method:"POST"})}catch(e){}guest=null;stats=null;pushState="";renderHello();renderProfile();renderCart();VIA.toast("Вы вышли из профиля")}

/* ——— оценки ——— */
async function openReviews(){VIA.openSheet("reviewsSheet");const box=$("#revList");box.innerHTML='<div class="skeleton"></div>';
try{const r=await fetch("/api/guest/reviews");const d=await r.json();if(!r.ok)throw new Error(d.error||"Не удалось загрузить");const items=d.items||[];
if(!items.length){box.innerHTML='<div class="empty-state">'+ic("star")+'<h3>Пока нечего оценить</h3>Оценить можно коктейль, который вам уже выдали.</div>';return}
box.innerHTML=items.map(it=>'<div class="review-item" data-item="'+Number(it.order_item_id)+'"><div class="review-head"><span class="name-serif">'+esc(it.cocktail_name)+(Number(it.quantity)>1?" × "+Number(it.quantity):"")+'</span><span class="caption">Заказ №'+Number(it.order_id)+'</span></div>'
+(it.rating?'<div style="margin-top:6px"><span class="stars-static" aria-label="Оценка '+Number(it.rating)+' из 5">'+"★".repeat(Number(it.rating))+"☆".repeat(5-Number(it.rating))+'</span>'+(it.comment?'<div class="cell-sub">'+esc(it.comment)+'</div>':"")+'</div>'
:'<form class="rev-form"><div class="stars" role="radiogroup" aria-label="Оценка «'+esc(it.cocktail_name)+'»">'+[1,2,3,4,5].map(n=>'<button type="button" role="radio" aria-checked="false" data-star="'+n+'" aria-label="'+n+" "+plural(n,["звезда","звезды","звёзд"])+'">'+ic("star")+'</button>').join("")+'</div><textarea name="comment" maxlength="500" placeholder="Пара слов о коктейле (необязательно)" aria-label="Комментарий"></textarea><input type="hidden" name="rating"><button class="btn btn-primary btn-sm" type="submit" disabled>Отправить оценку</button><p class="form-alert" role="alert"></p></form>')+'</div>').join("")}
catch(e){box.innerHTML='<div class="empty-state"><h3>Не удалось загрузить</h3>'+esc(e.message)+'</div>'}}
$("#revList").addEventListener("click",e=>{const b=e.target.closest("[data-star]");if(!b)return;const f=b.closest("form"),n=Number(b.dataset.star);f.rating.value=n;f.querySelectorAll("[data-star]").forEach(x=>x.setAttribute("aria-checked",String(Number(x.dataset.star)<=n)));f.querySelector("button[type=submit]").disabled=false});
$("#revList").addEventListener("submit",async e=>{e.preventDefault();const f=e.target,item=Number(f.closest("[data-item]").dataset.item),msg=f.querySelector("[role=alert]");msg.textContent="";
try{const r=await fetch("/api/guest/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({order_item_id:item,rating:Number(f.rating.value),comment:f.comment.value})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Не удалось сохранить");VIA.toast("Спасибо за оценку!");openReviews()}catch(err){msg.textContent=err.message}});

/* ——— загрузка ——— */
async function loadMe(){try{const r=await fetch("/api/guest/me");const d=await r.json();guest=d.guest||null}catch(e){guest=null}if(guest){markKnown();await refreshStats()}renderHello();renderProfile();if(pane==="order")renderCart();if(guest)VIA.push.sync("guest").then(refreshPush)}
// Меню вместе с наличием: коктейль, на который не хватает ингредиентов, заказать нельзя.
let menuLoadedAt=0;
async function loadMenu(quiet){try{const r=await fetch("/api/cocktails?for=menu",{cache:"no-store"});if(!r.ok)throw 0;const x=await r.json();cocktails=Array.isArray(x)?x:[];byId=new Map(cocktails.map(c=>[Number(c.id),c]));menuLoadedAt=Date.now();
const gone=[];Object.keys(cart).forEach(id=>{const c=byId.get(Number(id)),max=maxOf(c);if(!c||max<1){if(c)gone.push(c.name);delete cart[id]}else if(cart[id]>max)cart[id]=max});saveCart();
if(gone.length)VIA.toast((gone.length>1?"Закончились: ":"Закончился: ")+gone.join(", ")+" — убрали из заказа",true);
const focusRow=document.activeElement&&document.activeElement.closest&&document.activeElement.closest("[data-row]");
renderChips();renderMenu();renderCartBar();if(pane==="order")renderCart();
if(!$("#cocktailSheet").hidden){const sid=Number(($("#csBody [data-sheet-act]")||{dataset:{}}).dataset.sheetAct);if(sid&&byId.has(sid)&&!quiet)openCocktail(sid);else if(sid)updateRow(sid)}
if(focusRow){const el=document.querySelector('[data-row="'+focusRow.dataset.row+'"] button');if(el)el.focus({preventScroll:true})}}
catch(e){if(quiet)return;$("#menuList").innerHTML='<div class="card" style="margin-top:26px"><div class="empty-state"><h3>Не удалось загрузить меню</h3>Проверьте интернет и обновите страницу.<div style="margin-top:14px"><button class="btn btn-tinted btn-sm" type="button" onclick="location.reload()">Обновить</button></div></div></div>'}}
// Наличие меняется, пока гости заказывают, — меню тихо обновляется раз в минуту.
setInterval(()=>{if(!document.hidden)loadMenu(true)},60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-menuLoadedAt>20000)loadMenu(true)});
renderHello();
const start=location.hash.slice(1);
Promise.all([loadMenu(),loadMe()]).then(()=>{if(TITLES[start]&&start!=="menu")show(start,false)});
if(TITLES[start]&&start!=="menu")show(start,false);
})();
</script>`;
        return htmlResponse(renderDocument({
          title:"VIA Bar", app:"guest", docTitle:"VIA Bar — меню", heading:false,
          extraCss:guestCss, body:guestBody,
        }).replace("</main>",()=>"</main>"+guestTabs+guestSheets+guestScript));
      }


      // ═══════ route-block: /bar/shop ═══════ (agents: edit only inside your own block)

      if (url.pathname === "/bar/shop") return htmlResponse(renderDocument({
        title:"Закупки", app:"bar", tab:"shop", docTitle:"Закупки · VIA Бар",
        right:`<button class="icon-btn" type="button" id="addPurchase" aria-label="Новая закупка" aria-haspopup="dialog">${icon("plus")}</button>`,
        sub:"Чеки покупок для бара. Новая закупка сразу пополняет склад.",
        extraCss:`
.sh-sum{padding:18px 18px 16px;display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.sh-sum b{display:block;margin-top:8px;font:600 2.125rem/1 var(--serif);color:var(--accent);white-space:nowrap}
.sh-range{text-align:right;font-size:.78125rem;color:var(--label-3);line-height:1.45}
.sh-sum+.list{margin-top:12px}
#history .cell-title{font:600 1.125rem/1.15 var(--serif)}
.shop-filters{display:flex;align-items:center;gap:8px}
.shop-filters .segmented{flex:1;min-width:0}
.shop-filters .segmented button{position:relative;min-height:40px;padding:0 4px}
.shop-filters .segmented button::after{content:"";position:absolute;inset:-2px 0}
.filter-btn{position:relative;flex:none;width:44px;height:44px;display:grid;place-items:center;padding:0;border:0;border-radius:10px;background:var(--bg-raised-2);box-shadow:inset 0 0 0 .5px var(--sep);color:var(--label);cursor:pointer}
.filter-btn .ic{width:22px;height:22px}
.filter-btn:active{background:var(--bg-pressed)}
.filter-btn[data-active]{background:var(--gold-soft);color:var(--gold);box-shadow:inset 0 0 0 1px var(--gold-ring)}
.filter-btn .dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;background:var(--gold)}
.filter-note{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 4px 0;font-size:.875rem;color:var(--label-2)}
.filter-note span{min-width:0;overflow-wrap:anywhere}
.filter-note .btn{flex:none;margin-right:-10px}
.filter-note:not([hidden])+.section{margin-top:10px}
.empty-state p{text-wrap:balance}
.field input[list]::-webkit-calendar-picker-indicator{display:none!important}
#history{transition:opacity .2s ease}
#history.loading{opacity:.5}
.summary .cell-value,.receipt .price{color:var(--label);font-weight:600}
.cell-value.stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.suggest{margin-top:8px}
.suggest .cell{min-height:46px}
.suggest .create,.suggest .create .ic{color:var(--gold)}
.suggest .more{min-height:40px;margin:0;font-size:.8125rem;color:var(--label-3)}
.sheet-head .strong{font-weight:700}
.sheet-head h2:focus{outline:none}
.list>.field-row:first-child{border-top:0}
.field-row+.field{border-top:.5px solid var(--sep-strong)}
.field input[type=date]{-webkit-appearance:none;appearance:none;text-align:left}
.field input[type=date]::-webkit-date-and-time-value{text-align:left}
.form-msg{margin:10px 4px 0;font-size:.875rem;color:var(--danger)}
.form-msg.info{color:var(--label-2)}
.form-msg:empty{display:none}
#newIng{margin-top:8px}
#newIng .button-row{margin-top:12px}
`,
        body:`<div class="shop-filters">
<div class="segmented" id="presets" role="group" aria-label="Период"><button type="button" data-preset="today" aria-pressed="false">Сегодня</button><button type="button" data-preset="week" aria-pressed="false">Неделя</button><button type="button" data-preset="month" aria-pressed="true">Месяц</button><button type="button" data-preset="all" aria-pressed="false">Всё</button></div>
<button type="button" class="filter-btn" id="filterBtn" aria-haspopup="dialog" aria-label="Фильтр по датам и ингредиенту">${icon("filter")}<span class="dot" hidden></span></button>
</div>
<div class="filter-note" id="filterNote" hidden><span id="filterNoteText"></span><button type="button" class="btn btn-plain" data-reset-filter>Сбросить</button></div>
<div class="section summary" id="summary"><div class="list"><div class="skeleton"></div></div></div>
<div id="history" aria-busy="true"><div class="section"><div class="list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div></div></div>
<p class="section-footer" id="historyFooter" hidden></p>

<div class="sheet" id="purchaseSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="purchaseTitle">
<div class="sheet-grabber"></div>
<div class="sheet-head"><button class="btn btn-plain left" type="button" data-close-sheet>Отмена</button><h2 id="purchaseTitle" tabindex="-1">Новая закупка</h2><button class="btn btn-plain right strong" type="submit" form="purchaseForm" id="purchaseSubmit">Добавить</button></div>
<div class="sheet-body"><form id="purchaseForm" novalidate autocomplete="off"><input type="hidden" name="ingredient_id">
<div id="ingPick">
<div class="list"><label class="field"><span>Ингредиент</span><input id="ingInput" type="text" placeholder="Водка, лайм, тоник…" autocomplete="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="next" aria-describedby="ingHint"></label></div>
<div class="list suggest" id="ingSuggest" role="group" aria-label="Подходящие ингредиенты" hidden></div>
<p class="form-msg" id="ingMsg" role="alert"></p>
<p class="section-footer" id="ingHint"></p>
</div>
<div id="newIng" hidden>
<div class="section-header"><h3>Новый ингредиент</h3></div>
<div class="list">
<label class="field"><span>Название</span><input id="newIngName" placeholder="Например, ром тёмный" autocomplete="off" enterkeyhint="done"></label>
<div class="field"><span id="newIngUnitLabel">Единица</span><div class="segmented" role="group" aria-labelledby="newIngUnitLabel"><button type="button" data-unit="ml" aria-pressed="true">мл</button><button type="button" data-unit="g" aria-pressed="false">граммы</button><button type="button" data-unit="pcs" aria-pressed="false">штуки</button></div></div>
<label class="field"><span>Крепость, %</span><input id="newIngStrength" type="text" inputmode="decimal" value="0" autocomplete="off" enterkeyhint="done"></label>
</div>
<p class="section-footer">Водка — 40%, ликёр — около 20%, сок и газировка — 0%. По крепости ингредиентов считается крепость коктейля.</p>
<p class="form-msg" id="newIngMsg" role="alert"></p>
<div class="button-row"><button type="button" class="btn btn-gray" id="newIngCancel">Назад к списку</button><button type="button" class="btn btn-tinted" id="newIngSave">Создать</button></div>
</div>
<div class="section"><div class="list">
<div class="field-row"><label class="field"><span data-l="volume">Объём бутылки, мл</span><input name="volume" type="text" inputmode="decimal" placeholder="700" autocomplete="off" enterkeyhint="next"></label><label class="field"><span data-l="bottles">Бутылок</span><input name="bottles" type="text" inputmode="numeric" value="1" autocomplete="off" enterkeyhint="next"></label></div>
<label class="field"><span data-l="price">Цена за бутылку, ₽</span><input name="bottle_price" type="text" inputmode="decimal" placeholder="1400" autocomplete="off" enterkeyhint="next"></label>
<label class="field"><span>Бренд</span><input name="brand" list="brandList" placeholder="Например, Бакарди" autocomplete="off" enterkeyhint="next"></label>
<label class="field"><span>Магазин</span><input name="store" list="storeList" placeholder="Например, Перекрёсток" autocomplete="off" enterkeyhint="next"></label>
<label class="field"><span>Дата покупки</span><input name="purchased_at" type="date" required></label>
</div><p class="form-msg" id="purchaseMsg" role="alert"></p><p class="section-footer num" id="purchaseCalc" aria-live="polite"></p></div>
<p class="section-footer" id="purchaseNote"></p>
<div class="section" id="purchaseDeleteWrap" hidden><button class="btn btn-danger btn-block" type="button" id="purchaseDelete">${icon("trash")}Удалить чек</button></div>
<datalist id="brandList"></datalist><datalist id="storeList"></datalist>
</form></div></div></div>

<div class="sheet" id="filterSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="filterTitle">
<div class="sheet-grabber"></div>
<div class="sheet-head"><button class="btn btn-plain left" type="button" data-close-sheet>Отмена</button><h2 id="filterTitle">Фильтр</h2><button class="btn btn-plain right strong" type="submit" form="filterForm">Показать</button></div>
<div class="sheet-body"><form id="filterForm" novalidate>
<div class="list"><label class="field"><span>Ингредиент</span><select name="ing" id="filterIng"><option value="">Все ингредиенты</option></select></label></div>
<p class="section-footer" id="filterIngHint">Например, «Водка» — все покупки водки за выбранный период.</p>
<div class="section"><div class="section-header"><h3>Период</h3></div>
<div class="list"><div class="field-row"><label class="field"><span>С даты</span><input type="date" name="from"></label><label class="field"><span>По дату</span><input type="date" name="to"></label></div></div>
<p class="section-footer">Один день — одна и та же дата в обоих полях. Пустое поле — без ограничения.</p></div>
<div class="section"><button class="btn btn-gray btn-block" type="button" data-reset-filter>Сбросить фильтр</button></div>
</form></div></div></div>`,
      }).replace("</main>",String.raw`</main>
<script>
(function(){
"use strict";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $=s=>document.querySelector(s);
const ic=(n,c)=>'<svg class="ic'+(c?" "+c:"")+'" aria-hidden="true"><use href="#i-'+n+'"/></svg>';
const UNITS={ml:"мл",g:"г",pcs:"шт"};
const unitOf=u=>UNITS[u]||String(u||"");
const norm=s=>String(s??"").toLocaleLowerCase("ru").replace(/ё/g,"е").trim();
const plural=(n,a,b,c)=>{const m=Math.abs(n)%100,k=m%10;return m>10&&m<20?c:k===1?a:k>1&&k<5?b:c};
const fmt=(v,o)=>(Number(v)||0).toLocaleString("ru-RU",o);
const money=v=>{v=Math.round((Number(v)||0)*100)/100;return fmt(v,{minimumFractionDigits:Number.isInteger(v)?0:2,maximumFractionDigits:2})+" ₽"};
const qty=(v,u)=>fmt(v,{maximumFractionDigits:2})+" "+unitOf(u);
// Цена за единицу: 2,5 ₽ — с копейками, 0,14 ₽ — две значащие цифры.
const rate=(price,q)=>{q=Number(q);const v=Number(price)/q;if(!(q>0)||!Number.isFinite(v))return"";return v>=1?fmt(v,{maximumFractionDigits:v>=100?0:2}):fmt(v,{maximumSignificantDigits:2})};
const toNum=s=>{s=String(s??"").replace(/[\s ]/g,"").replace(",",".");return s===""?NaN:Number(s)};
const toInput=v=>String(Math.round((Number(v)||0)*10000)/10000).replace(".",",");
const netError=e=>e instanceof TypeError;

// ——— Даты ———
const pad=n=>String(n).padStart(2,"0");
const iso=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const dayOffset=n=>{const d=new Date();d.setDate(d.getDate()+n);return iso(d)};
const MONTHS=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const parseDay=s=>{const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(s||""));return m?{y:+m[1],m:+m[2],d:+m[3]}:null};
const dayText=(s,year)=>{const p=parseDay(s);if(!p)return String(s||"");return p.d+" "+MONTHS[p.m-1]+(year||p.y!==new Date().getFullYear()?" "+p.y:"")};
const dayTitle=s=>s===dayOffset(0)?"Сегодня":s===dayOffset(-1)?"Вчера":parseDay(s)?dayText(s):"Без даты";
const rangeText=(a,b)=>{
  if(!a&&!b)return"За всё время";
  if(a&&!b)return"С "+dayText(a);
  if(!a&&b)return"По "+dayText(b);
  if(a===b)return a===dayOffset(0)?"Сегодня":dayText(a);
  const x=parseDay(a),y=parseDay(b);if(!x||!y)return a+" – "+b;
  if(x.y===y.y&&x.m===y.m)return x.d+"–"+dayText(b);
  if(x.y===y.y)return x.d+" "+MONTHS[x.m-1]+" – "+dayText(b);
  return dayText(a,true)+" – "+dayText(b,true);
};

// ——— Фильтр: период (пресет или свои даты) и ингредиент ———
const PRESETS={today:()=>[dayOffset(0),dayOffset(0)],week:()=>[dayOffset(-6),dayOffset(0)],month:()=>[dayOffset(-29),dayOffset(0)],all:()=>["",""]};
const KEY="via-shop-period";
let savedPreset="month";
try{const v=localStorage.getItem(KEY);if(v&&PRESETS[v])savedPreset=v}catch(_){}
const state={preset:savedPreset,from:"",to:"",ing:""};
const applyPreset=p=>{state.preset=p;const r=PRESETS[p]();state.from=r[0];state.to=r[1]};
applyPreset(savedPreset);
const filtered=()=>!!state.ing||!state.preset;

const presetsEl=$("#presets"),filterBtn=$("#filterBtn"),filterNote=$("#filterNote"),filterNoteText=$("#filterNoteText");
const summaryEl=$("#summary"),historyEl=$("#history"),footerEl=$("#historyFooter");
let ingredients=[],ingState="loading",rows=[],loaded=false,seq=0,lastLoad=0;
const brands=new Set(),stores=new Set(),lastBought=new Map();
const ingName=id=>{const i=ingredients.find(x=>String(x.id)===String(id));if(i)return i.name;const r=rows.find(x=>String(x.ingredient_id)===String(id));return r?r.ingredient_name:""};

function syncFilterUi(){
  presetsEl.querySelectorAll("[data-preset]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.preset===state.preset)));
  const on=filtered();
  filterBtn.toggleAttribute("data-active",on);filterBtn.querySelector(".dot").hidden=!on;
  filterBtn.setAttribute("aria-label",on?"Фильтр по датам и ингредиенту, включён":"Фильтр по датам и ингредиенту");
  filterNote.hidden=!on;
  if(on){const parts=[];if(state.ing)parts.push("«"+(ingName(state.ing)||"ингредиент")+"»");if(!state.preset)parts.push(rangeText(state.from,state.to));filterNoteText.textContent="Фильтр: "+parts.join(", ")}
}

// ——— История чеков ———
const rowHtml=r=>{
  const n=Math.max(1,Number(r.bottles)||1),sub=[(n>1?n+" × "+qty(r.purchased_qty/n,r.unit):qty(r.purchased_qty,r.unit)),esc(r.brand),esc(r.store)].filter(Boolean).join(" · "),rt=rate(r.price_rub,r.purchased_qty);
  return '<button type="button" class="cell receipt" data-id="'+Number(r.id)+'" aria-haspopup="dialog"><span class="cell-body"><span class="cell-title">'+esc(r.ingredient_name)+'</span><span class="cell-sub">'+sub+'</span></span>'
    +'<span class="cell-value stack"><span class="price num">'+money(r.price_rub)+'</span>'+(rt?'<span class="caption num">'+rt+' ₽/'+esc(unitOf(r.unit))+'</span>':'')+'</span>'+ic("chevronRight","cell-chevron")+'</button>';
};
function emptyHtml(){
  if(!filtered()&&state.preset==="all")
    return '<div class="empty-state">'+ic("bag")+'<h3>Пока ни одной закупки</h3><p>Внесите первый чек — покупка сразу попадёт на склад.</p><button type="button" class="btn btn-primary" data-new>'+ic("plus")+'Новая закупка</button></div>';
  const when={today:"Сегодня закупок не было",week:"За неделю закупок не было",month:"За месяц закупок не было",all:"Закупок не было"}[state.preset]||"За эти даты закупок нет";
  const name="«"+esc(ingName(state.ing)||"Этот ингредиент")+"»";
  const text=state.ing?(state.preset==="all"?name+" ещё не покупали.":"Закупок "+name+" за этот период нет."):"Посмотрите все закупки или внесите новую кнопкой «+».";
  return '<div class="empty-state">'+ic("receipt")+'<h3>'+(state.ing?"Ничего не нашлось":when)+'</h3><p>'+text+'</p><button type="button" class="btn btn-tinted" data-show-all>Показать все закупки</button></div>';
}
function render(){
  const n=rows.length;
  if(!n){summaryEl.hidden=true;footerEl.hidden=true;historyEl.innerHTML=emptyHtml();return}
  const total=rows.reduce((s,r)=>s+(Number(r.price_rub)||0),0);
  let h='<div class="card sh-sum"><div><span class="label-caps">Потрачено</span><b class="num">'+money(total)+'</b></div><div class="sh-range">'+esc(rangeText(state.from,state.to))+'<br>'+n+' '+plural(n,"закупка","закупки","закупок")+'</div></div>';
  if(state.ing){
    const q=rows.reduce((s,r)=>s+(Number(r.purchased_qty)||0),0),u=rows[0].unit,rt=rate(total,q);
    h+='<div class="list"><div class="cell has-icon"><span class="cell-icon">'+ic("bottle")+'</span><span class="cell-body"><span class="cell-title">Куплено</span><span class="cell-sub">'+esc(rows[0].ingredient_name)+(rt?' · в среднем '+rt+' ₽ за '+esc(unitOf(u)):'')+'</span></span><span class="cell-value num">'+qty(q,u)+'</span></div></div>';
  }
  summaryEl.innerHTML=h;summaryEl.hidden=false;
  const groups=[];let g=null;
  rows.forEach(r=>{const k=String(r.purchased_at||"").slice(0,10);if(!g||g.key!==k){g={key:k,items:[],sum:0};groups.push(g)}g.items.push(r);g.sum+=Number(r.price_rub)||0});
  historyEl.innerHTML=groups.map((x,i)=>'<section class="section" aria-labelledby="day'+i+'"><div class="section-header"><h2 id="day'+i+'">'+esc(dayTitle(x.key))+'</h2><span class="num">'+money(x.sum)+'</span></div><div class="list">'+x.items.map(rowHtml).join("")+'</div></section>').join("");
  footerEl.textContent=(n>=500?"Показаны последние 500 закупок — более ранние найдутся через фильтр по датам. ":"")+"Коснитесь чека, чтобы исправить или удалить его. Остатки на складе от этого не изменятся.";
  footerEl.hidden=false;
}
function renderError(detail){
  summaryEl.hidden=true;footerEl.hidden=true;
  historyEl.innerHTML='<div class="empty-state" role="alert">'+ic("warning")+'<h3>Не удалось загрузить закупки</h3><p>Проверьте связь и попробуйте ещё раз.</p>'+(detail?'<p class="caption">'+esc(detail)+'</p>':'')+'<button type="button" class="btn btn-tinted" data-retry>'+ic("refresh")+'Повторить</button></div>';
}
async function loadHistory(quiet){
  const my=++seq;
  if(state.preset)applyPreset(state.preset);
  syncFilterUi();
  if(loaded&&!quiet)historyEl.classList.add("loading");
  historyEl.setAttribute("aria-busy","true");
  const p=new URLSearchParams();
  if(state.from)p.set("date_from",state.from);if(state.to)p.set("date_to",state.to);if(state.ing)p.set("ingredient_id",state.ing);
  try{
    const r=await fetch("/api/shop/purchases"+(p.toString()?"?"+p:""),{cache:"no-store"});
    const d=await r.json().catch(()=>null);
    if(!r.ok||!Array.isArray(d))throw new Error((d&&(d.details||d.error))||"Сервер ответил "+r.status);
    if(my!==seq)return;
    rows=d;loaded=true;lastLoad=Date.now();
    d.forEach(x=>{if(x.brand)brands.add(x.brand);if(x.store)stores.add(x.store);
      const id=Number(x.ingredient_id),day=String(x.purchased_at||"");if(id&&day>(lastBought.get(id)||""))lastBought.set(id,day)});
    render();syncFilterUi();
  }catch(e){if(my===seq)renderError(netError(e)?"":String(e.message||""))}
  finally{if(my===seq){historyEl.classList.remove("loading");historyEl.removeAttribute("aria-busy")}}
}

// ——— Справочник ингредиентов ———
async function loadIngredients(){
  ingState="loading";
  try{
    const r=await fetch("/api/ingredients",{cache:"no-store"});
    const d=await r.json().catch(()=>null);
    if(!r.ok||!Array.isArray(d))throw new Error("bad");
    ingredients=d;ingState="ok";
  }catch(e){ingState="error"}
  fillFilterSelect();syncFilterUi();
  if(!$("#purchaseSheet").hidden)syncIng();
}
const filterForm=$("#filterForm"),filterIng=$("#filterIng");
function fillFilterSelect(){
  const cur=state.ing;
  let o='<option value="">Все ингредиенты</option>'+ingredients.map(i=>'<option value="'+Number(i.id)+'">'+esc(i.name)+'</option>').join("");
  if(cur&&!ingredients.some(i=>String(i.id)===String(cur)))o+='<option value="'+esc(cur)+'">'+esc(ingName(cur)||"Ингредиент")+'</option>';
  filterIng.innerHTML=o;filterIng.value=cur;
  $("#filterIngHint").textContent=ingState==="error"?"Список ингредиентов не загрузился — фильтр по датам работает. Обновите страницу, чтобы выбрать ингредиент.":"Например, «Водка» — все покупки водки за выбранный период.";
}

// Загружаем историю и справочник параллельно.
loadHistory();loadIngredients();

presetsEl.addEventListener("click",e=>{const b=e.target.closest("[data-preset]");if(!b)return;
  savedPreset=b.dataset.preset;try{localStorage.setItem(KEY,savedPreset)}catch(_){}
  applyPreset(savedPreset);loadHistory()});
const resetFilter=()=>{state.ing="";applyPreset(savedPreset);loadHistory()};
document.querySelectorAll("[data-reset-filter]").forEach(b=>b.addEventListener("click",()=>{
  const inSheet=!!b.closest(".sheet");resetFilter();
  if(inSheet)VIA.closeSheet("filterSheet");else presetsEl.querySelector('[aria-pressed="true"]')?.focus()}));
historyEl.addEventListener("click",e=>{const t=e.target.closest("[data-id],[data-new],[data-show-all],[data-retry]");if(!t)return;
  if(t.dataset.id){const r=rows.find(x=>String(x.id)===t.dataset.id);if(r)openPurchase(r,t)}
  else if(t.hasAttribute("data-new"))openPurchase(null,t);
  else if(t.hasAttribute("data-show-all")){state.ing="";applyPreset("all");loadHistory()}
  else loadHistory()});
// Вернулись на вкладку — тихо обновить: чек мог добавить второй бармен со своего телефона.
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&loaded&&!document.querySelector(".sheet.open")&&Date.now()-lastLoad>60000)loadHistory(true)});
addEventListener("pageshow",e=>{if(e.persisted)loadHistory(true)});

// ——— Шторка фильтра ———
filterBtn.addEventListener("click",()=>{
  fillFilterSelect();filterForm.elements.from.value=state.from;filterForm.elements.to.value=state.to;
  returnTo.filterSheet=()=>filterBtn;VIA.openSheet("filterSheet")});
filterForm.addEventListener("submit",e=>{e.preventDefault();
  let a=filterForm.elements.from.value,b=filterForm.elements.to.value;if(a&&b&&a>b){const t=a;a=b;b=t}
  state.ing=filterIng.value;
  const match=Object.keys(PRESETS).filter(k=>{const r=PRESETS[k]();return r[0]===a&&r[1]===b});
  state.preset=match.includes(state.preset)?state.preset:(match[0]||null);
  state.from=a;state.to=b;
  VIA.closeSheet("filterSheet");loadHistory()});

// ——— Шторка закупки: новая или исправление чека ———
const form=$("#purchaseForm"),F=form.elements,ingInput=$("#ingInput"),suggest=$("#ingSuggest"),ingHint=$("#ingHint"),ingPick=$("#ingPick");
const newIng=$("#newIng"),newName=$("#newIngName"),newStrength=$("#newIngStrength"),newMsg=$("#newIngMsg"),newSave=$("#newIngSave");
const msg=$("#purchaseMsg"),ingMsg=$("#ingMsg"),calcEl=$("#purchaseCalc"),noteEl=$("#purchaseNote"),titleEl=$("#purchaseTitle"),submitBtn=$("#purchaseSubmit"),delWrap=$("#purchaseDeleteWrap"),delBtn=$("#purchaseDelete");
let editing=null,saving=false,newUnit="ml";
const setMsg=(el,text,info)=>{el.textContent=text||"";el.classList.toggle("info",!!info)};
const fail=(el,text,field)=>{setMsg(el,text);if(field)field.focus();return false};
const selectedIng=()=>{const id=F.ingredient_id.value;if(!id)return null;
  return ingredients.find(i=>String(i.id)===id)||(editing&&String(editing.ingredient_id)===id?{id:editing.ingredient_id,name:editing.ingredient_name,unit:editing.unit}:null)};
// Сначала — начинающиеся с запроса, затем недавно купленные, затем по алфавиту.
const recent=i=>lastBought.get(Number(i.id))||"";
const matches=q=>ingredients.filter(i=>!q||norm(i.name).includes(q)).sort((a,b)=>(norm(b.name).startsWith(q)-norm(a.name).startsWith(q))||recent(b).localeCompare(recent(a))||String(a.name).localeCompare(String(b.name),"ru"));

function renderSuggest(){
  if(ingState!=="ok"&&!ingredients.length){
    suggest.innerHTML=ingState==="loading"?'<p class="cell more">Загружаем справочник…</p>':'<button type="button" class="cell" data-retry-ing>'+ic("refresh")+'<span class="cell-body"><span class="cell-title">Справочник не загрузился — повторить</span></span></button>';
    return;
  }
  const raw=ingInput.value.trim(),q=norm(raw),list=matches(q),top=list.slice(0,6),exact=list.some(i=>norm(i.name)===q);
  suggest.innerHTML=top.map(i=>'<button type="button" class="cell" data-pick="'+Number(i.id)+'"><span class="cell-body"><span class="cell-title">'+esc(i.name)+'</span></span><span class="cell-value">'+esc(unitOf(i.unit))+'</span></button>').join("")
    +(list.length>top.length?'<p class="cell more">Ещё '+(list.length-top.length)+' — уточните название</p>':'')
    +'<button type="button" class="cell create" data-create>'+ic("plus")+'<span class="cell-body"><span class="cell-title">'+(q&&!exact?"Создать «"+esc(raw)+"»":"Новый ингредиент")+'</span></span></button>';
}
function syncIng(){
  const sel=selectedIng(),creating=!newIng.hidden;
  ingPick.hidden=creating;
  suggest.hidden=!!sel||creating;
  if(!suggest.hidden)renderSuggest();else suggest.innerHTML="";
  const unit=sel?sel.unit:"ml",ml=unit!=="g"&&unit!=="pcs",u=unitOf(unit);
  form.querySelector('[data-l="volume"]').textContent=(ml?"Объём бутылки, ":unit==="pcs"?"В упаковке, ":"Вес упаковки, ")+u;
  form.querySelector('[data-l="bottles"]').textContent=ml?"Бутылок":"Упаковок";
  form.querySelector('[data-l="price"]').textContent=(ml?"Цена за бутылку":"Цена за упаковку")+", ₽";
  F.volume.placeholder=ml?"700":unit==="pcs"?"10":"1000";F.bottle_price.placeholder=ml?"1400":"300";
  ingHint.textContent=sel?"":ingState==="error"&&!ingredients.length?"":"Выберите из справочника или создайте новый.";
  ingHint.hidden=!ingHint.textContent;
  calc();
}
function calc(){
  const sel=selectedIng(),v=toNum(F.volume.value),n=toNum(F.bottles.value),p=toNum(F.bottle_price.value),rt=sel&&v>0&&p>=0?rate(p,v):"";
  const many=Number.isInteger(n)&&n>1;
  calcEl.textContent=rt?(many?"Всего "+qty(v*n,sel.unit)+" за "+money(p*n)+" · ":"")+"выходит "+rt+" ₽ за "+unitOf(sel.unit):"";calcEl.hidden=!rt;
}
function pick(id){
  const i=ingredients.find(x=>Number(x.id)===Number(id));if(!i)return;
  F.ingredient_id.value=i.id;ingInput.value=i.name;setMsg(ingMsg,"");syncIng();F.volume.focus();
}
const setNewUnit=u=>{newUnit=u;newIng.querySelectorAll("[data-unit]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.unit===u)))};
newIng.querySelectorAll("[data-unit]").forEach(b=>b.addEventListener("click",()=>setNewUnit(b.dataset.unit)));
function showNewIng(name){newIng.hidden=false;newName.value=name||"";newStrength.value="0";setNewUnit("ml");setMsg(newMsg,"");setMsg(ingMsg,"");syncIng();newName.focus()}
function hideNewIng(){newIng.hidden=true;syncIng()}
$("#newIngCancel").addEventListener("click",()=>{hideNewIng();ingInput.focus()});
async function createIng(){
  const name=newName.value.trim(),st=newStrength.value.trim()===""?0:toNum(newStrength.value);
  if(!name)return fail(newMsg,"Введите название ингредиента.",newName);
  if(!Number.isFinite(st)||st<0||st>100)return fail(newMsg,"Крепость — число от 0 до 100.",newStrength);
  newSave.disabled=true;setMsg(newMsg,"Создаём…",true);
  try{
    const r=await fetch("/api/ingredients",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,unit:newUnit,strength_percent:st})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"Не удалось создать ингредиент");
    const id=Number(d.id);
    await loadIngredients();
    if(!ingredients.some(i=>Number(i.id)===id)){ingredients.push({id,name,unit:newUnit,strength_percent:st});fillFilterSelect()}
    newIng.hidden=true;pick(id);
    VIA.toast(d.exists?"Такой ингредиент уже есть — выбрали его":"Ингредиент «"+name+"» добавлен");
  }catch(err){setMsg(newMsg,netError(err)?"Нет связи — проверьте интернет и попробуйте ещё раз.":err.message)}
  finally{newSave.disabled=false}
}
newSave.addEventListener("click",createIng);
[newName,newStrength].forEach(el=>el.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();createIng()}}));
suggest.addEventListener("click",e=>{const t=e.target.closest("[data-pick],[data-create],[data-retry-ing]");if(!t)return;
  if(t.dataset.pick)pick(t.dataset.pick);
  else if(t.hasAttribute("data-create")){const q=norm(ingInput.value);showNewIng(q&&!matches(q).some(i=>norm(i.name)===q)?ingInput.value.trim():"")}
  else{ingState="loading";renderSuggest();loadIngredients()}});
ingInput.addEventListener("input",()=>{const sel=selectedIng();if(sel&&ingInput.value!==sel.name)F.ingredient_id.value="";syncIng()});
ingInput.addEventListener("focus",()=>{if(selectedIng())setTimeout(()=>ingInput.select(),0)});
ingInput.addEventListener("keydown",e=>{if(e.key!=="Enter")return;e.preventDefault();
  if(selectedIng()){F.volume.focus();return}
  const q=norm(ingInput.value);if(!q)return;
  const list=matches(q),exact=list.find(i=>norm(i.name)===q);
  if(exact||list.length===1)pick((exact||list[0]).id);else if(!list.length)showNewIng(ingInput.value.trim())});
form.addEventListener("input",e=>{if(e.target===F.volume||e.target===F.bottles||e.target===F.bottle_price)calc();if(e.target===ingInput)setMsg(ingMsg,"");else if(!saving)setMsg(msg,"")});
const fillDatalists=()=>{
  const o=s=>[...s].sort((a,b)=>String(a).localeCompare(String(b),"ru")).map(v=>'<option value="'+esc(v)+'"></option>').join("");
  $("#brandList").innerHTML=o(brands);$("#storeList").innerHTML=o(stores);
};

function openPurchase(item,trigger){
  editing=item||null;
  form.reset();setMsg(msg,"");setMsg(ingMsg,"");newIng.hidden=true;
  if(item){
    const known=item.ingredient_id&&(ingredients.some(i=>String(i.id)===String(item.ingredient_id))||ingState!=="ok");
    F.ingredient_id.value=known?String(item.ingredient_id):"";
    ingInput.value=item.ingredient_name||"";
    const n=Math.max(1,Number(item.bottles)||1);
    F.volume.value=toInput(item.purchased_qty/n);F.bottles.value=String(n);F.bottle_price.value=toInput(item.price_rub/n);
    F.brand.value=item.brand||"";F.store.value=item.store||"";
    F.purchased_at.value=String(item.purchased_at||"").slice(0,10)||dayOffset(0);
  }else{
    F.ingredient_id.value="";ingInput.value="";F.purchased_at.value=dayOffset(0);
  }
  titleEl.textContent=item?"Закупка":"Новая закупка";
  submitBtn.textContent=item?"Сохранить":"Добавить";
  noteEl.textContent=item?"Изменится только чек. Бутылки на складе правятся в «Складе».":"Бутылки сразу появятся на складе, а цена коктейлей пересчитается по средней цене ингредиента.";
  delWrap.hidden=!item;
  ingInput.autofocus=!item;
  fillDatalists();syncIng();
  const id=item?Number(item.id):0;
  returnTo.purchaseSheet=()=>(id&&historyEl.querySelector('[data-id="'+id+'"]'))||(trigger&&document.contains(trigger)?trigger:$("#addPurchase"));
  $("#purchaseSheet .sheet-body").scrollTop=0;
  VIA.openSheet("purchaseSheet");
  if(item)setTimeout(()=>{if(!$("#purchaseSheet").hidden)titleEl.focus({preventScroll:true})},320);
}
$("#addPurchase").addEventListener("click",e=>openPurchase(null,e.currentTarget));

const inFilter=b=>(!state.ing||String(state.ing)===String(b.ingredient_id))&&(!state.from||b.purchased_at>=state.from)&&(!state.to||b.purchased_at<=state.to);
const busy=on=>{saving=on;submitBtn.disabled=on;delBtn.disabled=on};
// Ошибка сервера или сети — показываем у полей и прокручиваем к ней.
const showError=err=>{setMsg(msg,netError(err)?"Нет связи — проверьте интернет и попробуйте ещё раз.":err.message);msg.scrollIntoView({block:"nearest",behavior:"smooth"})};
form.addEventListener("submit",async e=>{e.preventDefault();if(saving)return;
  if(!newIng.hidden)return fail(newMsg,"Сначала создайте ингредиент — или вернитесь к списку.",newName);
  const sel=selectedIng();
  if(!sel)return fail(ingMsg,ingInput.value.trim()?"Выберите ингредиент из списка или создайте новый.":"Укажите ингредиент.",ingInput);
  const volume=toNum(F.volume.value),bottles=toNum(F.bottles.value),bottlePrice=toNum(F.bottle_price.value),date=F.purchased_at.value,ml=sel.unit!=="g"&&sel.unit!=="pcs";
  if(!(volume>0))return fail(msg,ml?"Укажите объём бутылки в мл — как на этикетке.":"Укажите, сколько "+unitOf(sel.unit)+" в упаковке.",F.volume);
  if(!Number.isInteger(bottles)||bottles<1||bottles>48)return fail(msg,(ml?"Сколько бутылок купили?":"Сколько упаковок купили?")+" От 1 до 48.",F.bottles);
  if(!(bottlePrice>=0))return fail(msg,ml?"Укажите цену за бутылку: 0 или больше.":"Укажите цену за упаковку: 0 или больше.",F.bottle_price);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return fail(msg,"Укажите дату покупки.",F.purchased_at);
  const wasEdit=!!editing;
  const body={ingredient_id:Number(sel.id),store:F.store.value.trim(),brand:F.brand.value.trim(),purchased_at:date};
  // Новая закупка — N бутылок на склад; исправление чека меняет только итог в истории.
  if(wasEdit){body.id=Number(editing.id);body.quantity=volume*bottles;body.price_rub=bottlePrice*bottles}
  else{body.volume=volume;body.bottles=bottles;body.bottle_price=bottlePrice}
  busy(true);setMsg(msg,"Сохраняем…",true);
  try{
    const r=await fetch("/api/shop/purchase",{method:wasEdit?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"Не удалось сохранить. Попробуйте ещё раз.");
    if(body.brand)brands.add(body.brand);if(body.store)stores.add(body.store);
    setMsg(msg,"");VIA.closeSheet("purchaseSheet");
    VIA.toast(wasEdit?"Чек сохранён":inFilter(body)?"Закупка добавлена — бутылки на складе":"Закупка добавлена — её не видно из-за фильтра");
    await loadHistory();restoreFocus("purchaseSheet");
  }catch(err){showError(err)}
  finally{busy(false)}
});
delBtn.addEventListener("click",async()=>{if(!editing||saving)return;
  const it=editing;
  if(!confirm("Удалить чек «"+it.ingredient_name+", "+qty(it.purchased_qty,it.unit).replace(/ /g," ")+"» из истории закупок? Остаток на складе не изменится."))return;
  busy(true);setMsg(msg,"Удаляем…",true);
  try{
    const r=await fetch("/api/shop/purchase?id="+encodeURIComponent(it.id),{method:"DELETE"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"Не удалось удалить закупку");
    setMsg(msg,"");editing=null;returnTo.purchaseSheet=()=>$("#addPurchase");
    VIA.closeSheet("purchaseSheet");VIA.toast("Чек удалён");
    await loadHistory();
  }catch(err){showError(err)}
  finally{busy(false)}
});

// Фокус возвращается туда, откуда открыли шторку (VIA появляется чуть ниже — каркас).
const returnTo={};
function restoreFocus(id){
  const f=returnTo[id],el=f&&f();if(!el||!document.contains(el))return;
  const a=document.activeElement;
  if(!a||a===document.body||a.closest(".sheet:not(.open)"))el.focus({preventScroll:true});
}
document.addEventListener("DOMContentLoaded",()=>{
  const close=VIA.closeSheet;
  VIA.closeSheet=function(id){const s=typeof id==="string"?document.getElementById(id):id;close(s);if(s&&s.id)setTimeout(()=>restoreFocus(s.id),0)};
});
})();
</script>`));


      // ═══════ route-block: /bar/statistics ═══════ (agents: edit only inside your own block)

      if (url.pathname === "/bar/statistics") return htmlResponse(renderDocument({
        title:"Статистика", app:"bar", tab:"more", back:{href:"/bar",label:"Ещё"}, docTitle:"Статистика · VIA Бар",
        sub:"Смены за стойкой: сколько заказов, коктейлей и на какую сумму.",
        extraCss:`.stat-actions{margin-top:12px}
.st-cur{padding:18px}
.st-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.st-h{font:600 1.5625rem/1.1 var(--serif)}
.st-live{display:inline-flex;align-items:center;gap:7px;font-size:.8125rem;font-weight:700;color:var(--ok);white-space:nowrap}
.st-live i{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px var(--ok-tint)}
.st-kp{display:grid;grid-template-columns:1fr 1fr 1.3fr;margin-top:18px;padding-top:16px;border-top:1px solid var(--sep)}
.st-kp div{min-width:0}.st-kp div+div{border-left:1px solid var(--sep);padding-left:14px}
.st-kp b{display:block;font:600 1.875rem/1 var(--serif);color:var(--accent);white-space:nowrap}
.st-kp span{display:block;margin-top:5px;font-size:.75rem;font-weight:600;color:var(--label-3)}
.st-cur .btn{margin-top:18px}
.st-note{margin:10px 2px 0;font-size:.78125rem;color:var(--label-3);line-height:1.45}
#shifts .cell-title{font:600 1.125rem/1.15 var(--serif)}`,
        body:`<div class="section"><div class="section-header"><h2>Текущая смена</h2></div><div id="current"><div class="list"><div class="skeleton"></div><div class="skeleton"></div></div></div></div>
<div class="section"><div class="section-header"><h2>Все смены</h2><span id="shiftCount" class="num"></span></div><div class="list" id="shifts"><div class="skeleton"></div><div class="skeleton"></div></div>
<p class="section-footer">Учитываются принятые заказы со стойки и принятые или выданные заказы гостей за время смены.</p></div>`,
      }).replace("</main>",String.raw`</main>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const plural=(n,f)=>{const a=Math.abs(n)%100,b=a%10;return f[a>10&&a<20?2:b===1?0:b>=2&&b<=4?1:2]};
const toDate=s=>s?new Date(String(s).replace(" ","T")+(/[zZ]|[+-]\d\d:?\d\d$/.test(s)?"":"Z")):null;
const fmt=s=>{const d=toDate(s);return d&&!isNaN(d)?d.toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).replace(" г.",""):"—"};
const fmtTime=s=>{const d=toDate(s);return d&&!isNaN(d)?d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}):""};
const dur=(a,b)=>{const x=toDate(a),y=b?toDate(b):new Date();if(!x||isNaN(x))return"—";let m=Math.max(0,Math.round((y-x)/60000));const h=Math.floor(m/60);m%=60;return(h?h+" ч ":"")+m+" мин"};
const rub=n=>Number(n||0).toLocaleString("ru-RU",{maximumFractionDigits:0})+" ₽";
let busy=false;
async function act(method){
  if(busy)return;
  if(method==="PUT"&&!confirm("Закрыть текущую смену?"))return;
  busy=true;document.querySelectorAll("#current .btn").forEach(b=>b.disabled=true);
  try{const r=await fetch("/api/bar/shift",{method});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||(method==="PUT"?"Не удалось закрыть смену":"Не удалось открыть смену"));VIA.toast(method==="PUT"?"Смена закрыта":"Смена открыта");await load()}
  catch(e){VIA.toast(e.message||"Ошибка сети. Попробуйте ещё раз.",true);document.querySelectorAll("#current .btn").forEach(b=>b.disabled=false)}
  finally{busy=false}
}
async function load(){
  try{
    const r=await fetch("/api/bar/statistics");const d=await r.json();if(!r.ok)throw new Error(d.error||"Не удалось загрузить");
    const shifts=d.shifts||[];const open=shifts.find(x=>x.status==="open");
    $("#current").innerHTML=open
      ?(()=>{const oc=Number(open.orders_count||0),cc=Number(open.cocktails_count||0);
        return '<div class="card st-cur"><div class="st-top"><span class="st-h">Смена №'+Number(open.id)+'</span><span class="st-live"><i></i>идёт '+esc(dur(open.started_at))+'</span></div>'
        +'<div class="st-kp"><div><b class="num">'+oc+'</b><span>'+plural(oc,["заказ","заказа","заказов"])+'</span></div><div><b class="num">'+cc+'</b><span>'+plural(cc,["коктейль","коктейля","коктейлей"])+'</span></div><div><b class="num">'+rub(open.revenue_rub)+'</b><span>выручка</span></div></div>'
        +'<button class="btn btn-outline btn-block" type="button" id="closeShift">Закрыть смену</button>'
        +'<p class="st-note">Смена началась '+esc(fmt(open.started_at))+'. После закрытия у гостей обнулятся счётчики «за визит».</p></div>'})()
      :'<div class="list"><div class="empty-state"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg><h3>Смена не открыта</h3>Она откроется сама с первым заказом за стойкой или когда вы примете заказ гостя. Можно открыть и сейчас.</div></div>'
        +'<div class="stat-actions"><button class="btn btn-primary btn-block" type="button" id="openShift">Открыть смену</button></div>';
    const c=$("#closeShift"),o=$("#openShift");if(c)c.onclick=()=>act("PUT");if(o)o.onclick=()=>act("POST");
    $("#shiftCount").textContent=shifts.length?shifts.length+" "+plural(shifts.length,["смена","смены","смен"]):"";
    $("#shifts").innerHTML=shifts.map(x=>{const oc=Number(x.orders_count||0),cc=Number(x.cocktails_count||0);
      const when=esc(fmt(x.started_at))+(x.closed_at?" – "+esc(fmtTime(x.closed_at)):" · идёт");
      return '<div class="cell"><span class="cell-body"><span class="cell-title">Смена №'+Number(x.id)+'</span><span class="cell-sub">'+when+' · '+oc+' '+plural(oc,["заказ","заказа","заказов"])+' · '+cc+' '+plural(cc,["коктейль","коктейля","коктейлей"])+'</span></span><span class="cell-value num">'+rub(x.revenue_rub)+'</span></div>'}).join("")
      ||'<div class="empty-state"><h3>Смен ещё не было</h3>Первая появится с первым заказом.</div>';
  }catch(e){$("#shifts").innerHTML='<div class="empty-state"><h3>Не удалось загрузить</h3>'+esc(e.message)+'</div>';$("#current").innerHTML=""}
}
load();
document.addEventListener("visibilitychange",()=>{if(!document.hidden)load()});
</script>`));


      // ═══════ route-block: /bar/orders ═══════ (agents: edit only inside your own block)

      // Заказы: очередь гостевых заказов (принять → выдать) и заказ за стойкой
      // (черновик с резервом ингредиентов → принять со списанием). Рецепт — в шторке.
      if (url.pathname === "/bar/orders") return htmlResponse(renderDocument({
        title:"Заказы", app:"bar", tab:"orders", docTitle:"Заказы · VIA Бар",
        right:`<button class="icon-btn" type="button" id="refreshBtn" aria-label="Обновить заказы">${icon("refresh")}</button>`,
        extraCss:`
.toast{width:max-content;border-radius:22px}
.vh{position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.q-seg{margin:6px 0 2px}
.q-seg button{position:relative;display:flex;align-items:center;justify-content:center;gap:7px;min-height:40px;font-size:.9375rem}
.q-seg button::after{content:"";position:absolute;inset:-2px 0}
.q-num{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--bg-pressed);color:var(--label-2);font-size:.75rem;font-weight:700;line-height:20px;text-align:center;font-variant-numeric:tabular-nums}
.q-num.hot{background:var(--gold-soft);color:var(--gold);box-shadow:inset 0 0 0 .75px var(--gold-ring)}
.q-num:empty{display:none}
.q-note{display:flex;gap:8px;align-items:flex-start;margin:14px 4px 0;color:var(--warn);font-size:.8125rem;line-height:1.35}
.q-note .ic{width:16px;height:16px;margin-top:1px}
.q-note[hidden]{display:none}
.q-skel .skeleton{min-height:64px;border-radius:0}.q-skel .skeleton+.skeleton{border-top:.5px solid var(--sep-strong)}
.q-card{padding:16px;margin-top:14px}
.q-top{display:flex;gap:12px;align-items:flex-start}
.q-av{width:42px;height:42px;flex:none;border-radius:50%;display:grid;place-items:center;background:var(--btn-fill);color:var(--btn-ink);font:600 1.3125rem/1 var(--serif)}
.q-who{flex:1;min-width:0}
.q-name{margin:0;font:600 1.3125rem/1.1 var(--serif);overflow-wrap:anywhere}
.q-when{display:block;margin-top:3px;font-size:.78125rem;color:var(--label-3);font-variant-numeric:tabular-nums}
.q-phone{display:inline-flex;align-items:center;gap:5px;margin-top:3px;font-size:.78125rem;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
.q-phone .ic{width:13px;height:13px}
.q-track{margin:16px 2px 4px}
.q-items{margin-top:12px;border-top:1px solid var(--sep)}
.q-item{display:flex;align-items:center;gap:8px;width:100%;min-height:46px;padding:10px 0;border:0;border-bottom:1px solid var(--sep);background:none;color:var(--label);font:inherit;text-align:left;cursor:pointer}
.q-item:active{opacity:.7}
.q-iname{flex:1;min-width:0;font:600 1.125rem/1.15 var(--serif)}
.q-item b{font-size:.9375rem;font-variant-numeric:tabular-nums}
.q-item .ic{width:17px;height:17px;color:var(--label-3)}
.q-act{display:flex;align-items:center;gap:10px;margin-top:14px}
.q-sum{flex:1;min-width:72px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.q-sum b{display:block;font-size:1.1875rem;font-weight:700;font-variant-numeric:tabular-nums}
.q-sum .cell-sub{margin-top:2px}
.q-act .btn-sm{min-height:42px;padding:0 12px;font-size:.84375rem;gap:6px;flex:none}
.q-act .btn-sm .ic{width:16px;height:16px}
.q-reject:disabled{opacity:.5}
.q-card .q-msg{margin:10px 0 0;padding:0}
.q-order.is-fresh .q-card{animation:q-fresh 2.8s ease-out}
@keyframes q-fresh{0%,35%{box-shadow:var(--shadow),inset 0 0 0 1.5px var(--brass),0 0 0 5px var(--tint)}}
.q-order.is-leaving{overflow:hidden;transition:opacity .3s ease,max-height .35s ease,margin-top .35s ease}
.q-order.is-gone{opacity:0;max-height:0!important;margin-top:0}
.q-track ol,.rc-panel ol{list-style:none;margin:0;padding:0}
.q-dot{width:10px;height:10px;flex:none;border-radius:50%;background:var(--line,var(--label-3))}
.q-done{color:var(--ok);font-weight:600;display:inline-flex;align-items:center;gap:6px;min-height:50px}
.q-msg:empty{display:none}
.q-drows{position:relative}
.q-drow{gap:8px;padding-top:4px;padding-bottom:4px;--sep-inset:38px}
.q-dname{flex:1;min-width:0;display:flex;align-items:center;gap:14px;min-height:52px;padding:4px 0;border:0;background:none;color:var(--label);font:inherit;text-align:left;cursor:pointer}
.q-dname:active{opacity:.7}
.q-dname .cell-sub:empty{display:none}
.q-stepper{flex:none}
.q-stepper button{position:relative}
.q-stepper button::after{content:"";position:absolute;inset:-4px 0}
.q-stepper .ic{width:20px;height:20px}
.q-stepper output{min-width:26px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
.q-addrow{color:var(--gold);font-weight:500;gap:9px;cursor:pointer;--sep-inset:38px}
.q-addrow .ic{width:20px;height:20px;margin-left:-5px}
.q-total{color:var(--label);font-size:1.0625rem}
.q-actions{margin-top:18px}
.q-actions .btn-gray{flex:0 0 auto}
.q-msg{color:var(--danger);margin:12px 4px 0;line-height:1.35}
.q-msg:empty{display:none}
.empty-state p{margin:0 auto;max-width:34ch;line-height:1.4}
.q-empty-actions{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:18px}
.empty-state .btn .ic{width:1.3em;height:1.3em;margin:0;color:inherit}
.q-pick{cursor:pointer;--sep-inset:36px}
.q-pick .ic.q-plus{color:var(--gold);width:22px;height:22px}
.q-pick .badge{font-variant-numeric:tabular-nums}
#pickList:empty{display:none}
.scale{display:inline-flex;align-items:center;gap:3px}
.scale i{display:block;width:7px;height:7px;border-radius:50%;background:var(--line)}
.scale i.o{background:none;box-shadow:inset 0 0 0 1.5px var(--line)}
.route.line-zero{--line:var(--line-zero)}.route.line-light{--line:var(--line-light)}.route.line-mid{--line:var(--line-mid)}.route.line-strong{--line:var(--line-strong)}
.section-header h4{margin:0;font:inherit}
.sheet-panel:focus,#panelGuests:focus,#panelBar:focus{outline:none}
.rc-photo{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r-lg);background:var(--bg-raised-2);margin:2px 0 14px}
.rc-name{font-size:1.75rem;line-height:1.15;margin:4px 0 10px;text-wrap:balance;overflow-wrap:anywhere}
.rc-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rc-meta .badge{height:26px;padding:0 11px;font-size:.8125rem}
.rc-price{color:var(--label-2);font-weight:600;font-variant-numeric:tabular-nums}
.rc-desc{color:var(--label-2);margin:12px 0 0;line-height:1.45;white-space:pre-line}
.rc-panel{padding:16px 14px}
.rc-row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.rc-ing{font-weight:500;overflow-wrap:anywhere}
.rc-qty{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.rc-text{white-space:pre-line;line-height:1.45;margin:0}
.rc-empty{margin:0;color:var(--label-2)}
`,
        body:`<div class="segmented q-seg" role="tablist" aria-label="Очередь заказов">
<button type="button" role="tab" id="segGuests" aria-controls="panelGuests" aria-selected="true">Гости<span class="q-num" id="segGuestsNum"></span></button>
<button type="button" role="tab" id="segBar" aria-controls="panelBar" aria-selected="false" tabindex="-1">Стойка<span class="q-num" id="segBarNum"></span></button>
</div>
<section id="panelGuests" role="tabpanel" aria-labelledby="segGuests" tabindex="-1">
<h2 class="vh">Заказы гостей</h2>
<p class="q-note" id="guestNote" role="status" hidden></p>
<div id="guestList"><div class="section q-skel" aria-hidden="true"><div class="list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div></div></div>
<div class="empty-state" id="guestEmpty" hidden>${icon("bell")}<h3>Гости пока ничего не заказали</h3><p>Новые заказы из меню появятся здесь сами — список обновляется каждые 10 секунд.</p><div class="q-empty-actions"><a class="btn btn-tinted" href="/menu">${icon("glass")}Гостевое меню</a></div></div>
<div class="empty-state" id="guestError" hidden>${icon("warning")}<h3>Не удалось загрузить заказы гостей</h3><p>Проверьте интернет. Мы попробуем ещё раз через 10 секунд.</p><div class="q-empty-actions"><button class="btn btn-tinted" type="button" data-retry>${icon("refresh")}Повторить</button></div></div>
</section>
<section id="panelBar" role="tabpanel" aria-labelledby="segBar" tabindex="-1" hidden>
<h2 class="vh">Заказ за стойкой</h2>
<div class="section q-skel" id="draftSkel" aria-hidden="true"><div class="list"><div class="skeleton"></div><div class="skeleton"></div></div></div>
<div class="empty-state" id="draftError" hidden>${icon("warning")}<h3>Не удалось загрузить заказ</h3><p>Проверьте интернет. Мы попробуем ещё раз через 10 секунд.</p><div class="q-empty-actions"><button class="btn btn-tinted" type="button" data-retry>${icon("refresh")}Повторить</button></div></div>
<div class="empty-state" id="draftEmpty" hidden>${icon("glass")}<h3>Заказ за стойкой пуст</h3><p>Добавьте коктейли — ингредиенты зарезервируются сразу, а спишутся со склада, когда вы примете заказ.</p><div class="q-empty-actions"><button class="btn btn-tinted" type="button" data-open-pick>${icon("plus")}Добавить коктейль</button><a class="btn btn-plain" href="/bar/recipes">Открыть рецепты</a></div><p class="footnote" id="shiftNote"></p></div>
<div id="draftFull" hidden>
<div class="section"><div class="section-header"><h3 id="draftHead">Текущий заказ</h3><span id="shiftInfo"></span></div>
<div class="list"><div class="cell-wrap q-drows" id="draftRows"></div><button type="button" class="cell q-addrow" id="draftAddRow" data-open-pick>${icon("plus")}<span class="cell-body">Добавить коктейль</span></button></div></div>
<div class="section"><div class="list"><div class="cell"><span class="cell-body"><span class="cell-title">Итого</span><span class="cell-sub" id="draftCount"></span></span><span class="cell-value price q-total" id="draftTotal"></span></div></div>
<p class="section-footer">Ингредиенты уже зарезервированы. Со склада они спишутся, когда вы примете заказ.</p></div>
<div class="button-row q-actions"><button class="btn btn-gray" type="button" id="draftClear">Очистить</button><button class="btn btn-primary" type="button" id="draftAccept">${icon("check")}Принять заказ</button></div>
</div>
<p class="q-msg" id="draftMsg" role="alert"></p>
</section>
<div class="sheet" id="recipeSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="recipeName" tabindex="-1">
<div class="sheet-grabber"></div>
<div class="sheet-head"><span class="left"></span><h2>Рецепт</h2><button class="btn btn-plain right" type="button" data-close-sheet style="font-weight:700">Готово</button></div>
<div class="sheet-body" id="recipeBody"></div>
</div></div>
<div class="sheet" id="pickSheet" hidden><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="pickTitle" tabindex="-1">
<div class="sheet-grabber"></div>
<div class="sheet-head"><span class="left"></span><h2 id="pickTitle">Добавить в заказ</h2><button class="btn btn-plain right" type="button" data-close-sheet style="font-weight:700">Готово</button></div>
<div class="sheet-body">
<label class="search">${icon("search")}<input type="search" id="pickSearch" placeholder="Поиск коктейля" autocomplete="off" aria-label="Поиск коктейля"></label>
<div class="section"><div class="list" id="pickList"></div><div class="empty-state" id="pickEmpty" hidden></div>
<p class="section-footer">Нажмите на коктейль, чтобы добавить порцию. Ингредиенты зарезервируются сразу.</p></div>
</div></div></div>`,
      }).replace("</main>",()=>String.raw`</main>
<script>
(function(){
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ic=(n,c)=>'<svg class="ic'+(c?" "+c:"")+'" aria-hidden="true"><use href="#i-'+n+'"/></svg>';
const UNIT={ml:"мл",g:"гр",pcs:"шт."};
const unitLabel=u=>UNIT[u]||String(u??"");
const fmtQty=v=>Number(v||0).toLocaleString("ru-RU",{maximumFractionDigits:2});
const fmtRub=v=>Math.round(Number(v||0)).toLocaleString("ru-RU")+" ₽";
const plural=(n,f)=>{const a=Math.abs(n)%100,b=a%10;return f[a>10&&a<20?2:b===1?0:b>1&&b<5?1:2]};
const drinks=n=>n+" "+plural(n,["коктейль","коктейля","коктейлей"]);
const LINES={"Безалкогольный":{cls:"line-zero",dots:0,label:"без алкоголя"},"Лёгкий":{cls:"line-light",dots:1,label:"лёгкий"},"Средний":{cls:"line-mid",dots:2,label:"средний"},"Крепкий":{cls:"line-strong",dots:3,label:"крепкий"}};
const lineOf=c=>c?LINES[String(c.strength||"").trim()]||null:null;
const scaleHtml=L=>'<span class="scale" aria-hidden="true">'+(L.dots===0?'<i class="o"></i>':'<i></i>'.repeat(L.dots))+'</span>';
const dotHtml=cid=>{const L=lineOf(cocktails.get(Number(cid)));return '<span class="q-dot'+(L?" "+L.cls:"")+'" data-line-cid="'+Number(cid)+'" aria-hidden="true"></span>'};
const parseTs=s=>{if(!s)return null;const t=String(s).trim().replace(" ","T");const d=new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(t)?t:t+"Z");return isNaN(d)?null:d};
const hhmm=d=>d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
const ago=d=>{const m=Math.max(0,Math.floor((Date.now()-d)/60000));if(m<1)return "только что";if(m<60)return m+" мин назад";return Math.floor(m/60)+" ч назад"};
const whenText=s=>{const d=parseTs(s);if(!d)return String(s||"");return Date.now()-d>864e5?d.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})+", "+hhmm(d):hhmm(d)+" · "+ago(d)};
const fmtPhone=p=>{const s=String(p||"").trim(),m=s.match(/^\+?7(\d{3})(\d{3})(\d{2})(\d{2})$/);return m?"+7 "+m[1]+" "+m[2]+"-"+m[3]+"-"+m[4]:s};
const netErr="Нет связи. Проверьте интернет и попробуйте ещё раз.";
async function api(url,opt){const r=await fetch(url,Object.assign({cache:"no-store"},opt||{}));const d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||"");e.status=r.status;throw e}return d}
const post=(url,body,method)=>api(url,{method:method||"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});

/* ——— Коктейли (рецепты для шторки и добавления) ——— */
let cocktails=new Map(),cocktailsOk=false,cocktailsReq=null;
function loadCocktails(){
  if(cocktailsReq)return cocktailsReq;
  cocktailsReq=api("/api/cocktails?include_stock=0").then(d=>{cocktails=new Map((Array.isArray(d)?d:[]).map(c=>[Number(c.id),c]));cocktailsOk=true;paintLines();if(isOpen("pickSheet"))renderPick();return true}).catch(()=>false).finally(()=>{cocktailsReq=null});
  return cocktailsReq;
}
function paintLines(){document.querySelectorAll("[data-line-cid]").forEach(n=>{const L=lineOf(cocktails.get(Number(n.dataset.lineCid)));n.className="q-dot"+(L?" "+L.cls:"")})}
const isOpen=id=>{const s=document.getElementById(id);return !!s&&s.classList.contains("open")};

/* ——— Шторки: фокус внутрь при открытии и обратно при закрытии ——— */
let opener=null;
function openSheet(id){opener=document.activeElement;VIA.openSheet(id);setTimeout(()=>{const p=document.querySelector("#"+id+" .sheet-panel");if(p&&!p.contains(document.activeElement))p.focus({preventScroll:true})},60)}
document.querySelectorAll(".sheet").forEach(s=>new MutationObserver(()=>{if(s.classList.contains("open")||!opener)return;const o=opener;opener=null;const a=document.activeElement;if((s.contains(a)||a===document.body||!a)&&o.isConnected)o.focus({preventScroll:true})}).observe(s,{attributes:true,attributeFilter:["class"]}));

/* ——— Шторка рецепта ——— */
function recipeHtml(c){
  const L=lineOf(c),items=c.recipe_items||[];let h="";
  if(c.photo_url)h+='<img class="rc-photo" src="'+esc(c.photo_url)+'" alt="Фото: '+esc(c.name)+'" decoding="async">';
  h+='<h3 class="rc-name serif" id="recipeName">'+esc(c.name||"Коктейль")+'</h3>';
  const meta=(L?'<span class="badge line '+L.cls+'">'+scaleHtml(L)+esc(c.strength)+'</span>':c.strength?'<span class="badge">'+esc(c.strength)+'</span>':"")+(Number(c.price_rub||0)>0?'<span class="rc-price">'+fmtRub(c.price_rub)+'</span>':"");
  if(meta)h+='<div class="rc-meta">'+meta+'</div>';
  if(c.description)h+='<p class="rc-desc">'+esc(c.description)+'</p>';
  h+='<div class="section"><div class="section-header"><h4>Состав</h4>'+(items.length?'<span>'+items.length+" "+plural(items.length,["ингредиент","ингредиента","ингредиентов"])+'</span>':"")+'</div>';
  h+=items.length?'<div class="list rc-panel"><ol class="route'+(L?" "+L.cls:"")+'">'+items.map(i=>'<li class="route-stop"><span class="station"></span><div class="route-body rc-row"><span class="rc-ing">'+esc(i.ingredient_name||i.name||"Ингредиент")+'</span><span class="rc-qty">'+fmtQty(i.quantity)+" "+esc(unitLabel(i.unit))+'</span></div></li>').join("")+'</ol></div>':'<div class="list rc-panel"><p class="rc-empty">Состав пока не указан.</p></div>';
  h+='</div>';
  const steps=String(c.method||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if(steps.length)h+='<div class="section"><div class="section-header"><h4>Приготовление</h4></div><div class="list rc-panel">'+(steps.length>1?'<ol class="route'+(L?" "+L.cls:"")+'">'+steps.map(s=>'<li class="route-stop"><span class="station"></span><div class="route-body">'+esc(s)+'</div></li>').join("")+'</ol>':'<p class="rc-text">'+esc(steps[0])+'</p>')+'</div></div>';
  const serve=[];String(c.glass||"").split(/\n+/).map(s=>s.trim()).filter(Boolean).forEach(t=>serve.push(["",t]));
  if(String(c.ice||"").trim())serve.push(["Лёд",String(c.ice).trim()]);
  if(String(c.garnish||"").trim())serve.push(["Украшение",String(c.garnish).trim()]);
  if(serve.length)h+='<div class="section"><div class="section-header"><h4>Инвентарь и подача</h4></div><div class="list">'+serve.map(([k,v])=>'<div class="cell"><span class="cell-body"><span class="cell-title">'+esc(v)+'</span>'+(k?'<span class="cell-sub">'+esc(k)+'</span>':"")+'</span></div>').join("")+'</div></div>';
  return h;
}
async function openRecipe(id){
  id=Number(id);let c=cocktails.get(id);
  if(!c){await loadCocktails();c=cocktails.get(id)}
  if(!c){VIA.toast(cocktailsOk?"Рецепт не найден — возможно, коктейль убрали из книги.":"Не удалось загрузить рецепт. Проверьте интернет и попробуйте ещё раз.",true);return}
  const b=$("#recipeBody");b.innerHTML=recipeHtml(c);b.scrollTop=0;openSheet("recipeSheet");
}

/* ——— Переключатель «Гости / Стойка» ——— */
let tabTouched=/^#(bar|guests)$/.test(location.hash);
function setTab(t,focus){
  const g=t!=="bar",sg=$("#segGuests"),sb=$("#segBar");
  sg.setAttribute("aria-selected",String(g));sb.setAttribute("aria-selected",String(!g));
  sg.tabIndex=g?0:-1;sb.tabIndex=g?-1:0;
  $("#panelGuests").hidden=!g;$("#panelBar").hidden=g;
  try{history.replaceState(null,"",location.pathname+(g?"":"#bar"))}catch(e){}
  if(focus)(g?sg:sb).focus();
}
$("#segGuests").onclick=()=>{tabTouched=true;setTab("guests")};
$("#segBar").onclick=()=>{tabTouched=true;setTab("bar")};
$(".q-seg").addEventListener("keydown",e=>{if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight"&&e.key!=="Home"&&e.key!=="End")return;e.preventDefault();tabTouched=true;setTab($("#segGuests").getAttribute("aria-selected")==="true"?"bar":"guests",true)});
if(location.hash==="#bar")setTab("bar");

function setNum(sel,n,hot){const el=$(sel);el.textContent=n>0?String(n):"";el.classList.toggle("hot",!!hot)}
function updateCounts(){
  const p=guestOrders.filter(o=>o.status==="pending").length;
  setNum("#segGuestsNum",guestsLoaded?guestOrders.length:0,p>0);
  setNum("#segBarNum",draftLoaded?Number(draft.total_cocktails||0):0,false);
  const b=document.getElementById("ordersBadge");if(b&&guestsLoaded){b.textContent=p;b.hidden=!p}
}

/* ——— Гостевые заказы ——— */
let guestOrders=[],guestsLoaded=false,guestGen=0,firstGuestLoad=true;const seen=new Set();
const orderSig=o=>JSON.stringify([o.status,o.total_rub,o.guest_name,o.guest_phone,(o.items||[]).map(i=>[i.cocktail_id,i.cocktail_name,i.quantity])]);
const whenLine=o=>"Заказ №"+Number(o.id)+" · "+whenText(o.created_at);
const stopHtml=(label,state)=>'<li class="tracker-stop'+(state?" "+state:"")+'"'+(state==="current"?' aria-current="step"':"")+'><span class="station"></span>'+label+(state==="done"?'<span class="vh"> — готово</span>':"")+'</li>';
const trackerHtml=st=>'<ol class="tracker" aria-label="Статус заказа">'+stopHtml("Заказан",st==="pending"?"current":"done")+stopHtml("Принят",st==="pending"?"":st==="accepted"?"current":"done")+stopHtml("Выдан",st==="served"?"done":"")+'</ol>';
function orderHtml(o){
  const id=Number(o.id),pending=o.status==="pending",name=String(o.guest_name||"").trim()||"Гость",items=o.items||[];
  const count=items.reduce((s,i)=>s+Number(i.quantity||0),0);
  return '<div class="card q-card'+(pending?" is-pending":"")+'">'+
    '<div class="q-top"><span class="q-av" aria-hidden="true">'+esc(name.charAt(0).toLocaleUpperCase("ru"))+'</span><div class="q-who"><h3 class="q-name" id="q'+id+'t">'+esc(name)+'</h3><span class="q-when">'+esc(whenLine(o))+'</span>'+(o.guest_phone?'<a class="q-phone" href="tel:'+esc(o.guest_phone)+'">'+ic("phone")+esc(fmtPhone(o.guest_phone))+'</a>':"")+'</div>'+(pending?'<span class="badge">Новый</span>':'<span class="badge warn">Принят</span>')+'</div>'+
    '<div class="q-track">'+trackerHtml(o.status)+'</div>'+
    '<div class="q-items">'+items.map(i=>'<button type="button" class="q-item" data-recipe="'+Number(i.cocktail_id)+'" data-fk="i'+Number(i.cocktail_id)+'"><span class="vh">Рецепт: </span><span class="q-iname">'+esc(i.cocktail_name||"Коктейль")+'</span><b>× '+Number(i.quantity||0)+'</b>'+ic("chevronRight")+'</button>').join("")+'</div>'+
    '<div class="q-act"><div class="q-sum"><b class="price">'+fmtRub(o.total_rub)+'</b><span class="cell-sub">'+drinks(count)+'</span></div>'+
    // Не из чего приготовить — заказ можно отклонить: гость увидит «Отменён», бронь снимется.
    (pending?'<button type="button" class="btn btn-gray btn-sm q-reject" data-fk="reject">Отклонить</button>':"")+
    '<button type="button" class="btn btn-primary btn-sm q-go" data-act="'+(pending?"accept":"serve")+'" data-fk="act">'+(pending?ic("check")+"Принять":ic("coupe")+"Выдать")+'</button></div>'+
    '<p class="q-msg" role="alert"></p>'+
  '</div>';
}
function renderGuests(){
  const box=$("#guestList"),ids=new Set(guestOrders.map(o=>Number(o.id)));
  box.querySelectorAll(".q-skel").forEach(n=>n.remove());
  box.querySelectorAll(".q-order").forEach(n=>{if(!ids.has(Number(n.dataset.oid))&&!n.dataset.busy&&!n.classList.contains("is-leaving"))leave(n)});
  let prev=null;
  for(const o of guestOrders){
    const id=Number(o.id),sig=orderSig(o);
    let n=box.querySelector('.q-order[data-oid="'+id+'"]');
    if(n&&(n.dataset.busy||n.classList.contains("is-leaving"))){prev=n;continue}
    if(!n){
      n=document.createElement("article");n.className="section q-order";n.dataset.oid=id;n.setAttribute("aria-labelledby","q"+id+"t");
      n.innerHTML=orderHtml(o);n.dataset.sig=sig;
      if(!firstGuestLoad&&!seen.has(id)){n.classList.add("is-fresh");setTimeout(()=>n.classList.remove("is-fresh"),3000)}
    }else if(n.dataset.sig!==sig){
      const a=document.activeElement,key=n.contains(a)&&a.dataset?a.dataset.fk:"";
      n.innerHTML=orderHtml(o);n.dataset.sig=sig;
      if(key){const t=n.querySelector('[data-fk="'+key+'"]');if(t)t.focus({preventScroll:true})}
    }else{const w=n.querySelector(".q-when");if(w)w.textContent=whenLine(o)}
    let want=prev?prev.nextElementSibling:box.firstElementChild;
    while(want&&want!==n&&!ids.has(Number(want.dataset.oid)))want=want.nextElementSibling;
    if(n!==want)box.insertBefore(n,want);
    prev=n;
  }
  const live=box.querySelectorAll(".q-order:not(.is-leaving)").length;
  $("#guestEmpty").hidden=live>0||!guestsLoaded;
  $("#guestError").hidden=true;
  updateCounts();
}
function leave(n){
  if(n.contains(document.activeElement)){const next=[...$("#guestList").querySelectorAll(".q-order:not(.is-leaving)")].find(x=>x!==n);const t=next?next.querySelector(".q-go"):null;(t||$("#panelGuests")).focus({preventScroll:true})}
  n.classList.add("is-leaving");n.style.maxHeight=n.offsetHeight+"px";
  requestAnimationFrame(()=>requestAnimationFrame(()=>n.classList.add("is-gone")));
  setTimeout(()=>{n.remove();if(guestsLoaded&&!$("#guestList .q-order"))$("#guestEmpty").hidden=false},380);
}
async function loadGuests(){
  const g=++guestGen;
  try{
    const d=await api("/api/bar/guest-orders");
    if(g!==guestGen)return;
    const list=Array.isArray(d.orders)?d.orders:[];
    const fresh=firstGuestLoad?[]:list.filter(o=>o.status==="pending"&&!seen.has(Number(o.id)));
    guestOrders=list;guestsLoaded=true;renderGuests();
    list.forEach(o=>seen.add(Number(o.id)));firstGuestLoad=false;
    $("#guestNote").hidden=true;
    if(fresh.length)VIA.toast(fresh.length===1?"Новый заказ: "+(String(fresh[0].guest_name||"").trim()||"гость"):"Новых заказов: "+fresh.length);
    return true;
  }catch(e){
    if(g!==guestGen)return;
    if(!guestsLoaded){$("#guestList").querySelectorAll(".q-skel").forEach(n=>n.remove());$("#guestError").hidden=false}
    else{const n=$("#guestNote");n.innerHTML=ic("warning")+"<span>Нет связи — показываем последние данные. Обновим, как только сеть вернётся.</span>";n.hidden=false}
    return false;
  }
}
async function rejectGuest(btn){
  const card=btn.closest(".q-order");if(!card||card.dataset.busy)return;
  const id=Number(card.dataset.oid),o=guestOrders.find(x=>Number(x.id)===id),name=String((o&&o.guest_name)||"").trim()||"гостя";
  if(!confirm("Отклонить заказ №"+id+" от "+name+"? Гость увидит, что заказ отменён."))return;
  card.dataset.busy="1";btn.disabled=true;btn.textContent="Отклоняем…";
  try{
    await post("/api/bar/guest-order/reject",{order_id:id});
    guestGen++;guestOrders=guestOrders.filter(x=>Number(x.id)!==id);
    delete card.dataset.busy;leave(card);updateCounts();
    VIA.toast("Заказ №"+id+" отклонён");
  }catch(e){delete card.dataset.busy;btn.disabled=false;btn.textContent="Отклонить";VIA.toast(e.message||netErr,true)}
  loadGuests();
}
async function guestAction(btn){
  const card=btn.closest(".q-order");if(!card||card.dataset.busy)return;
  const id=Number(card.dataset.oid),serve=btn.dataset.act==="serve",hadFocus=document.activeElement===btn,html=btn.innerHTML;
  const qm=card.querySelector(".q-msg");if(qm)qm.textContent="";
  card.dataset.busy="1";btn.disabled=true;btn.textContent=serve?"Выдаём…":"Принимаем…";
  try{
    await post(serve?"/api/bar/guest-order/serve":"/api/bar/guest-order/accept",{order_id:id});
    guestGen++;
    if(serve){
      guestOrders=guestOrders.filter(o=>Number(o.id)!==id);
      const tr=card.querySelector(".q-track");if(tr)tr.innerHTML=trackerHtml("served");
      const act=btn.parentNode;btn.remove();act.insertAdjacentHTML("beforeend",'<span class="q-done">'+ic("check")+'Выдан</span>');
      if(hadFocus)$("#panelGuests").focus({preventScroll:true});
      VIA.toast("Заказ №"+id+" выдан");
      setTimeout(()=>{delete card.dataset.busy;leave(card);updateCounts()},1200);
      updateCounts();
    }else{
      const o=guestOrders.find(x=>Number(x.id)===id);if(o)o.status="accepted";
      delete card.dataset.busy;renderGuests();
      if(hadFocus){const t=card.querySelector(".q-go");if(t)t.focus({preventScroll:true})}
      VIA.toast("Заказ №"+id+" принят");
    }
  }catch(e){
    delete card.dataset.busy;btn.disabled=false;btn.innerHTML=html;
    // Не хватает ингредиентов — объяснение остаётся под заказом, а не только во всплывашке.
    if(e.status===409&&qm){qm.textContent=e.message;VIA.toast("Не хватает ингредиентов — подробности в заказе",true)}
    else VIA.toast(e.message||netErr,true);
  }
  loadGuests();
}
$("#guestList").addEventListener("click",e=>{const r=e.target.closest("[data-recipe]");if(r){openRecipe(r.dataset.recipe);return}const x=e.target.closest(".q-reject");if(x){rejectGuest(x);return}const b=e.target.closest(".q-go");if(b)guestAction(b)});

/* ——— Заказ за стойкой (черновик) ——— */
let draft={shift:null,order:null,items:[]},draftLoaded=false,draftGen=0,draftOps=0,draftFailed=false,chain=Promise.resolve();
const recalc=()=>{const it=draft.items||[];draft.total_cocktails=it.reduce((s,i)=>s+Number(i.quantity||0),0);draft.total_price=it.reduce((s,i)=>s+Number(i.quantity||0)*Number(i.price_rub||0),0)};
const lineSub=i=>Number(i.price_rub||0)>0?fmtRub(Number(i.quantity||0)*Number(i.price_rub||0)):"";
function draftRowHtml(i){
  const cid=Number(i.cocktail_id),name=esc(i.cocktail_name||"Коктейль");
  return '<button type="button" class="q-dname" data-recipe="'+cid+'">'+dotHtml(cid)+'<span class="cell-body"><span class="vh">Рецепт: </span><span class="cell-title q-dn">'+name+'</span><span class="cell-sub q-ds">'+lineSub(i)+'</span></span></button>'+
    '<div class="stepper q-stepper"><button type="button" data-d="-1" aria-label="Убрать «'+name+'»">'+ic("minus")+'</button><output aria-live="polite" aria-atomic="true"><span class="vh">'+name+', порций: </span><span class="q-n">'+Number(i.quantity||0)+'</span></output><button type="button" data-d="1" aria-label="Добавить «'+name+'»">'+ic("plus")+'</button></div>';
}
function renderDraft(){
  const items=draft.items||[],has=items.length>0,box=$("#draftRows"),a=document.activeElement;
  const hadFocus=$("#panelBar").contains(a)&&a!==$("#panelBar");
  $("#draftSkel").hidden=true;$("#draftError").hidden=true;
  const ids=new Set(items.map(i=>Number(i.cocktail_id)));let lostAt=-1;
  [...box.children].forEach((n,ix)=>{if(!ids.has(Number(n.dataset.cid))){if(n.contains(a))lostAt=ix;n.remove()}});
  let prev=null;
  for(const i of items){
    const cid=Number(i.cocktail_id);let n=box.querySelector('.q-drow[data-cid="'+cid+'"]');
    if(!n){n=document.createElement("div");n.className="cell q-drow";n.dataset.cid=cid;n.innerHTML=draftRowHtml(i)}
    else{n.querySelector(".q-n").textContent=Number(i.quantity||0);n.querySelector(".q-ds").textContent=lineSub(i)}
    const want=prev?prev.nextElementSibling:box.firstElementChild;if(n!==want)box.insertBefore(n,want);prev=n;
  }
  $("#draftEmpty").hidden=has;$("#draftFull").hidden=!has;
  const sh=draft.shift;
  $("#shiftInfo").textContent=sh?"Смена №"+Number(sh.id):"";
  const st=sh?parseTs(sh.started_at):null;
  $("#shiftNote").textContent=sh?"Смена №"+Number(sh.id)+" открыта"+(st?" в "+hhmm(st):"")+".":"Смена откроется сама, когда вы добавите первый коктейль.";
  $("#draftCount").textContent=drinks(Number(draft.total_cocktails||0));
  $("#draftTotal").textContent=fmtRub(draft.total_price);
  const cur=document.activeElement;
  if(lostAt>=0||(hadFocus&&(!$("#panelBar").contains(cur)||!cur.offsetParent||cur.disabled))){
    const rows=box.children,t=has?(rows[Math.min(Math.max(lostAt,0),rows.length-1)]||null):null;
    (t?t.querySelector(".q-dname"):has?$("#draftAddRow"):$("#draftEmpty [data-open-pick]")).focus({preventScroll:true});
  }
  updateCounts();syncPickCounts();
}
async function loadDraft(){
  const g=++draftGen;
  try{
    const d=await api("/api/bar/order");
    if(g!==draftGen||draftOps)return;
    draft=d;recalc();draftLoaded=true;renderDraft();return true;
  }catch(e){
    if(g!==draftGen)return;
    if(!draftLoaded){$("#draftSkel").hidden=true;$("#draftError").hidden=false}
    return false;
  }
}
const keepFocus=(had,b)=>{if(!had)return;const t=b.offsetParent?b:$("#draftEmpty [data-open-pick]");if(t)t.focus({preventScroll:true})};
const setMsg=t=>{$("#draftMsg").textContent=t||""};
function changeQty(cid,delta){
  cid=Number(cid);setMsg("");
  const items=draft.items||[],item=items.find(i=>Number(i.cocktail_id)===cid);
  if(item){item.quantity=Number(item.quantity||0)+delta;if(item.quantity<=0)draft.items=items.filter(i=>i!==item)}
  else if(delta>0){const c=cocktails.get(cid);draft.items=items.concat([{cocktail_id:cid,cocktail_name:c?c.name:"Коктейль",quantity:1,price_rub:c?Number(c.price_rub||0):0}])}
  else return Promise.resolve(false);
  recalc();renderDraft();
  draftOps++;draftGen++;
  const p=chain.then(async()=>{
    try{const d=await post("/api/bar/order",{cocktail_id:cid,delta});if(draftOps===1){draft=d;recalc();draftLoaded=true;renderDraft()}return true}
    catch(e){draftFailed=true;const m=e.message||netErr;setMsg(m);VIA.toast(m,true);return false}
    finally{draftOps--;if(!draftOps&&draftFailed){draftFailed=false;loadDraft()}}
  });
  chain=p.catch(()=>{});
  return p;
}
$("#draftRows").addEventListener("click",e=>{
  const s=e.target.closest("[data-d]");if(s){changeQty(s.closest(".q-drow").dataset.cid,Number(s.dataset.d));return}
  const r=e.target.closest("[data-recipe]");if(r)openRecipe(r.dataset.recipe);
});
$("#draftAccept").onclick=async()=>{
  const b=$("#draftAccept"),html=b.innerHTML,hadFocus=document.activeElement===b;b.disabled=true;b.textContent="Принимаем…";setMsg("");
  await chain;
  try{
    const d=await post("/api/bar/order/accept",{});
    draftGen++;draft={shift:draft.shift,order:null,items:[]};recalc();renderDraft();
    VIA.toast("Заказ №"+Number(d.order_id)+" принят"+VIA.notifiedNote(d));
  }catch(e){const m=e.message||netErr;setMsg(m);VIA.toast(e.status===409?"Не хватает ингредиентов — подробности под заказом":m,true)}
  finally{b.disabled=false;b.innerHTML=html;keepFocus(hadFocus,b);loadDraft()}
};
$("#draftClear").onclick=async()=>{
  if(!confirm("Очистить текущий заказ? Резерв ингредиентов снимется."))return;
  const b=$("#draftClear"),hadFocus=document.activeElement===b;b.disabled=true;setMsg("");
  await chain;
  try{await api("/api/bar/order",{method:"DELETE"});draftGen++;draft={shift:draft.shift,order:draft.order,items:[]};recalc();renderDraft();VIA.toast("Заказ очищен")}
  catch(e){VIA.toast(e.message||netErr,true)}
  finally{b.disabled=false;keepFocus(hadFocus,b);loadDraft()}
};

/* ——— Шторка «Добавить в заказ» ——— */
const norm=s=>String(s??"").trim().toLocaleLowerCase("ru").replace(/ё/g,"е");
const inDraft=cid=>{const i=(draft.items||[]).find(x=>Number(x.cocktail_id)===Number(cid));return i?Number(i.quantity||0):0};
function renderPick(){
  const q=norm($("#pickSearch").value),list=[...cocktails.values()].filter(c=>!q||norm(c.name).includes(q)).sort((a,b)=>String(a.name).localeCompare(String(b.name),"ru"));
  $("#pickList").innerHTML=list.map(c=>{const L=lineOf(c),n=inDraft(c.id),sub=[L?L.label:"",Number(c.price_rub||0)>0?fmtRub(c.price_rub):""].filter(Boolean).join(" · ");
    return '<button type="button" class="cell q-pick" data-add="'+Number(c.id)+'">'+dotHtml(c.id)+'<span class="cell-body"><span class="vh">Добавить: </span><span class="cell-title">'+esc(c.name)+'</span>'+(sub?'<span class="cell-sub">'+esc(sub)+'</span>':"")+'</span><span class="badge" data-in="'+Number(c.id)+'"'+(n?"":" hidden")+'><span class="vh">в заказе </span>× '+n+'</span>'+ic("plus","q-plus")+'</button>'}).join("");
  const e=$("#pickEmpty");
  e.hidden=list.length>0;
  e.innerHTML=!cocktailsOk?ic("warning")+"<h3>Не удалось загрузить коктейли</h3><p>Проверьте интернет и откройте список ещё раз.</p>":q?"<h3>Ничего не нашлось</h3><p>Попробуйте другое название.</p>":"<h3>В книге пока нет коктейлей</h3><p>Добавьте рецепт в разделе «Рецепты».</p>";
}
function syncPickCounts(){document.querySelectorAll("#pickList [data-in]").forEach(b=>{const n=inDraft(b.dataset.in);b.hidden=!n;b.innerHTML='<span class="vh">в заказе </span>× '+n})}
async function openPick(){
  $("#pickSearch").value="";
  if(!cocktailsOk){$("#pickList").innerHTML='<div class="skeleton"></div><div class="skeleton"></div>';$("#pickEmpty").hidden=true}else renderPick();
  openSheet("pickSheet");
  if(!cocktailsOk){await loadCocktails();renderPick()}
}
document.addEventListener("click",e=>{if(e.target.closest("[data-open-pick]"))openPick()});
$("#pickSearch").addEventListener("input",renderPick);
$("#pickList").addEventListener("click",async e=>{
  const b=e.target.closest("[data-add]");if(!b)return;
  const c=cocktails.get(Number(b.dataset.add));
  if(await changeQty(b.dataset.add,1))VIA.toast("Добавлено: "+(c?c.name:"коктейль"));
});

/* ——— Загрузка, опрос каждые 10 секунд (только пока страница на экране) ——— */
const POLL=10000;let pollT=0;
function schedule(){clearTimeout(pollT);pollT=setTimeout(async()=>{if(!document.hidden)await Promise.all([loadGuests(),draftOps?null:loadDraft()]);schedule()},POLL)}
async function refreshAll(){return Promise.all([loadGuests(),draftOps?true:loadDraft()])}
document.addEventListener("visibilitychange",()=>{if(document.hidden)clearTimeout(pollT);else{refreshAll();schedule()}});
addEventListener("pageshow",e=>{if(e.persisted){refreshAll();schedule()}});
document.addEventListener("click",e=>{if(e.target.closest("[data-retry]"))refreshAll()});
$("#refreshBtn").onclick=async()=>{const b=$("#refreshBtn");b.disabled=true;const r=await refreshAll();b.disabled=false;VIA.toast(r.every(x=>x!==false)?"Обновлено":netErr,r.some(x=>x===false))};
loadCocktails();
refreshAll().then(()=>{if(!tabTouched&&guestsLoaded&&!guestOrders.length&&(draft.items||[]).length)setTab("bar")});
schedule();
})();
</script>`));

      // ═══════ end of route blocks ═══════

      return new Response("Не найдено",{status:404});
    } catch (error) {
      console.error(error);
      return json({error:"Ошибка сервера",details:String(error?.message||error)},500);
    }
  }
};





