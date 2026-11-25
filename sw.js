/* GastoFolio V3 — caché solamente de archivos estáticos públicos.
   Nunca almacena consultas de Supabase, tokens ni archivos privados.
*/
const CACHE='gastofolio-shell-v3-20261125';
const APP=['./','./index.html','./config.js','./offline.js','./logo.png','./icon.png','./manifest.webmanifest'];
const VENDORS=[
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];
self.addEventListener('install',evt=>{
 evt.waitUntil((async()=>{
   const cache=await caches.open(CACHE);
   await cache.addAll(APP); // si falla, no anuncia soporte offline
   await Promise.allSettled(VENDORS.map(async url=>{
     const req=new Request(url,{mode:'no-cors'});
     const response=await fetch(req);
     await cache.put(url,response);
   }));
   await self.skipWaiting();
 })());
});
self.addEventListener('activate',evt=>evt.waitUntil((async()=>{
 const keys=await caches.keys();
 await Promise.all(keys.filter(k=>k.startsWith('gastofolio-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
 await self.clients.claim();
})()));
self.addEventListener('fetch',evt=>{
 const req=evt.request;if(req.method!=='GET')return;
 const url=new URL(req.url);
 const ours=url.origin===self.location.origin&&url.pathname.startsWith(new URL(self.registration.scope).pathname);
 const vendor=VENDORS.some(v=>url.href===v||url.href.startsWith(v+'?'));
 if(!ours&&!vendor)return; // no cachear nada de Supabase
 if(ours && req.mode==='navigate'){
   evt.respondWith((async()=>{
     try{const response=await fetch(req);if(response.ok){const cache=await caches.open(CACHE);cache.put('./index.html',response.clone());}return response}
     catch{const cache=await caches.open(CACHE);return await cache.match('./index.html')||Response.error()}
   })());return;
 }
 evt.respondWith((async()=>{
   const cache=await caches.open(CACHE);
   const cached=await cache.match(req);
   if(cached)return cached;
   try{const response=await fetch(req);if(response&&(response.ok||response.type==='opaque'))cache.put(req,response.clone());return response}
   catch{return Response.error()}
 })());
});
