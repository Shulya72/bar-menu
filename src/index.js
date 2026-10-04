const page = (body) => new Response('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111"><title>Бар</title><style>*{box-sizing:border-box}body{margin:0;background:#090909;color:#fff;font:15px system-ui,sans-serif}header{padding:18px 16px;border-bottom:1px solid #222;position:sticky;top:0;background:#090909;z-index:2}h1{margin:0;font-size:22px}.sub{color:#999;margin-top:4px}.wrap{max-width:900px;margin:auto;padding:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.card{border:1px solid #292929;border-radius:18px;padding:18px;background:#111}button{border:0;border-radius:12px;padding:12px 16px;background:#7CFC00;color:#000;font-weight:700;cursor:pointer}a{color:#7CFC00;text-decoration:none}.pill{display:inline-block;padding:5px 9px;border-radius:99px;background:#202020;color:#bbb;margin:3px 3px 0 0}</style></head><body>'+body+'</body></html>',{headers:{'content-type':'text/html;charset=UTF-8'}});

export default {
 async fetch(request, env) {
   const url = new URL(request.url);
   if (url.pathname === '/api/health') return Response.json({ok:true,service:'bar-menu'});
   if (url.pathname === '/api/cocktails') {
     const {results}=await env.DB.prepare('SELECT id,name,description,category,strength,price_rub,photo_url,glass,ice,method,garnish FROM cocktails WHERE is_active=1 ORDER BY name').all();
     return Response.json(results);
   }
   if (url.pathname === '/api/products') {
     const {results}=await env.DB.prepare('SELECT p.id,p.name,p.brand,p.category,p.unit,p.min_stock,COALESCE(SUM(b.remaining_qty),0) stock FROM products p LEFT JOIN purchase_batches b ON b.product_id=p.id WHERE p.is_active=1 GROUP BY p.id ORDER BY p.name').all();
     return Response.json(results);
   }
   if (url.pathname === '/') return page('<header><h1>🍸 Бар</h1><div class="sub">Новая версия — Cloudflare</div></header><div class="wrap"><div class="card"><h2>Система готова к сборке</h2><p>Здесь будут две связанные части: <b>👨‍🍳 Книга рецептов / Меню бармена</b> и <b>🥂 Карта бара</b>.</p><p>Следующий технический этап — подключение D1 и создание первого коктейля.</p></div></div>');
   if (url.pathname === '/bar') return page('<header><h1>👨‍🍳 Меню бармена</h1><div class="sub">Рабочая часть</div></header><div class="wrap"><div class="grid"><a class="card" href="/bar/recipes"><h2>🍸 Книга рецептов</h2><p>Коктейли и рецептуры</p></a><a class="card" href="/bar/stock"><h2>📦 Склад</h2><p>Остатки и движения</p></a><a class="card" href="/bar/shop"><h2>🛒 Магазин</h2><p>Закупки и партии</p></a><a class="card" href="/bar/orders"><h2>🔔 Заказы</h2><p>Заказы гостей</p></a></div></div>');
   if (url.pathname === '/menu') return page('<header><h1>🥂 Карта бара</h1><div class="sub">Меню для гостей</div></header><div class="wrap"><div id="menu" class="grid"><div class="card">Загрузка...</div></div><script>fetch("/api/cocktails").then(r=>r.json()).then(x=>{document.querySelector("#menu").innerHTML=x.length?x.map(c=>"<div class=\"card\"><h2>"+c.name+"</h2><p>"+c.description+"</p><span class=\"pill\">"+c.strength+"</span> <span class=\"pill\">"+c.price_rub+" ₽</span></div>").join(""):"<div class=\"card\">Пока коктейлей нет.</div>"})</script></div>');
   if (url.pathname === '/bar/recipes') return page('<header><h1>🍸 Книга рецептов</h1><div class="sub">Источник данных для «Карты бара»</div></header><div class="wrap"><div class="card"><h2>Первый этап готов</h2><p>База рецептов уже спроектирована. Здесь разместим создание и редактирование коктейлей.</p><a href="/bar">← Назад в меню бармена</a></div></div>');
   return new Response('Не найдено',{status:404});
 }
};