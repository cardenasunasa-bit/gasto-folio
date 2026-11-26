/* GastoFolio V6: cola local duradera de gastos/fotos y documentos.
   No almacena contraseñas ni utiliza service_role. Los archivos quedan en
   IndexedDB del dispositivo hasta que Supabase confirme la sincronización.
*/
'use strict';
window.GFOffline = (() => {
  const DB_NAME = 'gastofolio_v3_local'; // Mantener base local V3: NO perder pendientes
  let opened, client=null, getUser=null, compress=null, refresh=null, setState=null;
  let working=false, lastError='', activeSync=null;
  const state = { documentToAttach: null };
  const $=id=>document.getElementById(id);
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function openDb(){
    if(!opened){
      opened=new Promise((resolve,reject)=>{
        if(!('indexedDB' in window))return reject(new Error('Este navegador no admite IndexedDB; no se puede guardar sin conexión.'));
        const req=indexedDB.open(DB_NAME,1);
        req.onupgradeneeded=()=>{
          const db=req.result;
          if(!db.objectStoreNames.contains('jobs'))db.createObjectStore('jobs',{keyPath:'id'});
          if(!db.objectStoreNames.contains('cache'))db.createObjectStore('cache',{keyPath:'id'});
        };
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error||Error('No se pudo abrir IndexedDB.'));
        req.onblocked=()=>reject(Error('Otra pestaña impide abrir el almacenamiento local. Cierra la pestaña anterior.'));
      }).catch(e=>{opened=null;throw e});
    }
    return opened;
  }
  async function tx(storeName,mode,makeReq){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const t=db.transaction(storeName,mode);
      let result;
      const r=makeReq(t.objectStore(storeName));
      r.onsuccess=()=>{result=r.result};
      t.oncomplete=()=>resolve(result);
      t.onerror=()=>reject(t.error||Error('El almacenamiento local falló.'));
      t.onabort=()=>reject(t.error||Error('No se pudo confirmar el guardado local.'));
    });
  }
  const putJob=job=>tx('jobs','readwrite',s=>s.put(job));
  const rmJob=id=>tx('jobs','readwrite',s=>s.delete(id));
  async function getJobs(uid){
    const all=await tx('jobs','readonly',s=>s.getAll());
    return (all||[]).filter(x=>x.uid===uid).sort((a,b)=>a.created.localeCompare(b.created));
  }
  async function getPendingDeletedIds(uid){return (await getJobs(uid)).filter(j=>j.kind==='delete_expense').map(j=>j.expenseId)}
  async function getPendingJobIds(ids){const names=new Set(ids);return (await getJobs(userId())).filter(j=>names.has(j.id)).map(j=>j.id)}
  const getSyncError=()=>lastError;
  const putCache=(id,data)=>tx('cache','readwrite',s=>s.put({id,data}));
  async function getCache(id){const r=await tx('cache','readonly',s=>s.get(id));return r?.data||[];}
  function userId(){const id=getUser?.()?.id;if(!id)throw Error('Debes entrar a tu cuenta de GastoFolio antes de guardar.');return id;}
  function paintNetwork(){
    const el=$('networkStatus');if(!el)return;
    const online=navigator.onLine;
    el.className='offline-banner'+(online?' online':'');
    el.textContent=online?'🟢 Conexión detectada. Los pendientes se sincronizan automáticamente al abrir o recuperar internet.':'🟠 Sin internet. Los registros y archivos nuevos se guardarán en este teléfono (sin enviar a Supabase).';
  }
  function label(j){
    if(j.kind==='expense')return 'Gasto · '+j.payload.categoria+' · $'+j.payload.valor_cop;
    if(j.kind==='attach')return 'Comprobante adicional de gasto';
    if(j.kind==='delete_expense')return 'Eliminación definitiva de gasto · '+j.expenseId;
    if(j.kind==='document')return (j.payload.tipo==='rut'?'RUT':j.payload.tipo==='cuenta_cobro'?'Cuenta de cobro':'Documento')+' · '+j.payload.establecimiento;
    if(j.kind==='doc_file')return 'Archivo PDF o foto para un documento pendiente';
    return j.kind;
  }
  async function displayQueue(){
    paintNetwork();
    if(!getUser?.()?.id)return;
    try{
      const jobs=await getJobs(userId());
      const container=$('pendingList');container.replaceChildren();
      for(const j of jobs){
        const div=document.createElement('div');div.className='queue-card';
        // Solo metadatos; nunca insertar fotos privadas en HTML.
        div.innerHTML='<strong>⏳ '+escape(label(j))+'</strong><div class="muted">Guardado en el teléfono · '+escape(new Date(j.created).toLocaleString('es-CO'))+(j.blob?' · Archivo pendiente de subir':'')+'</div>';
        if(j.kind==='expense'){
          const btn=document.createElement('button');btn.type='button';btn.className='danger';
          btn.textContent='🗑️ Eliminar gasto pendiente';
          btn.onclick=async()=>{
            if(!confirm('¿Eliminar este gasto pendiente y su archivo? Si hubo una subida parcial, GastoFolio también intentará borrarlo de Supabase.'))return;
            btn.disabled=true;
            try{await enqueueDeleteExpense({id:j.payload.id}); sync();}
            catch(e){setState?.('pendingStatus','No se pudo poner en cola la eliminación: '+e.message,'error')}
            finally{btn.disabled=false}
          };
          div.appendChild(btn);
        }
        container.appendChild(div);
      }
      setState?.('pendingStatus',jobs.length?`${jobs.length} registro(s) pendientes de sincronización. ${lastError?'Último error: '+lastError:''}`:'✅ No hay registros pendientes en este teléfono.',jobs.length?'':'ok');
      const btn=$('syncNow');if(btn)btn.disabled=working||!navigator.onLine;
    }catch(e){setState?.('pendingStatus','No se puede leer la cola local: '+e.message,'error');}
  }
  async function persist(job){
    if(!job?.uid)throw Error('Usuario no identificado.');
    try{await putJob(job)}catch(e){throw Error('El dispositivo no pudo conservar el registro (espacio insuficiente, modo privado o navegador bloqueado): '+e.message)}
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    await displayQueue();
    return job;
  }
  async function enqueueExpense(payload,prepared){
    const uid=userId();
    return persist({id:payload.id,kind:'expense',uid,payload:{...payload,creado_por:uid},
      blob:prepared?.blob||null,mime:prepared?.mime||null,ext:prepared?.ext||null,
      created:new Date().toISOString()});
  }
  // Guardar gasto + recibo + todos los documentos en UNA transacción local.
  // No se anuncia éxito si IndexedDB no pudo almacenar todos los archivos.
  async function enqueueExpenseBundle(payload,preparedReceipt,docItems=[]){
    const uid=userId();
    const createdMs=Date.now();
    const jobs=[{
      id:payload.id,kind:'expense',uid,payload:{...payload,creado_por:uid},
      blob:preparedReceipt?.blob||null,mime:preparedReceipt?.mime||null,
      ext:preparedReceipt?.ext||null,created:new Date(createdMs).toISOString()
    }];
    for(let i=0;i<docItems.length;i++){
      const {payload:doc,prepared}=docItems[i];
      if(doc.gasto_id!==payload.id)throw Error('El documento no corresponde al gasto.');
      jobs.push({
        id:doc.id,kind:'document',uid,payload:{...doc,creado_por:uid},
        blob:prepared?.blob||null,mime:prepared?.mime||null,
        ext:prepared?.ext||null,filename:prepared?.name||null,
        created:new Date(createdMs+i+1).toISOString()
      });
    }
    const database=await openDb();
    await new Promise((resolve,reject)=>{
      const tr=database.transaction('jobs','readwrite');
      for(const j of jobs)tr.objectStore('jobs').add(j);
      tr.oncomplete=resolve;
      tr.onerror=()=>reject(tr.error||Error('No se pudieron guardar todos los archivos.'));
      tr.onabort=()=>reject(tr.error||Error('No se completó el guardado de gastos y documentos.'));
    });
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    await displayQueue();
    return jobs;
  }
  async function getPendingForExpenseIds(expenseIds){
    const ids=new Set(expenseIds);
    return (await getJobs(userId())).filter(j=>
      (j.kind==='expense'&&ids.has(j.payload.id)) ||
      (j.kind==='attach'&&ids.has(j.expenseId)) ||
      (j.kind==='document'&&ids.has(j.payload?.gasto_id)) ||
      (j.kind==='delete_expense'&&ids.has(j.expenseId))
    );
  }
  async function enqueueAttach(expenseId,prepared){
    const uid=userId();
    const queued=(await getJobs(uid)).some(j=>j.kind==='attach'&&j.expenseId===expenseId);
    if(queued)throw Error('Ya existe un comprobante pendiente para este gasto.');
    return persist({id:crypto.randomUUID(),kind:'attach',uid,expenseId,
      blob:prepared.blob,mime:prepared.mime,ext:prepared.ext,created:new Date().toISOString()});
  }
  // Cancelar el gasto pendiente y dejar un tombstone de eliminación; si parte
  // de la subida llegó al servidor, se borrará al recuperar la conexión.
  async function enqueueDeleteExpense(expense){
    const uid=userId(),id=expense?.id;
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id||''))throw Error('Identificador de gasto inválido.');
    if(working)throw Error('Hay una sincronización en curso; vuelve a intentar cuando termine.');
    const jobs=await getJobs(uid);
    const database=await openDb();
    await new Promise((resolve,reject)=>{
      const tr=database.transaction(['jobs','cache'],'readwrite');
      const jobStore=tr.objectStore('jobs'),cacheStore=tr.objectStore('cache');
      for(const j of jobs){
        if((j.kind==='expense'&&j.payload.id===id)||(j.kind==='attach'&&j.expenseId===id)||(j.kind==='document'&&j.payload?.gasto_id===id))jobStore.delete(j.id);
      }
      jobStore.put({id:'delete:'+id,kind:'delete_expense',uid,expenseId:id,created:new Date().toISOString()});
      const get=cacheStore.get('expenses:'+uid);
      get.onsuccess=()=>{
        const old=get.result?.data||[];
        cacheStore.put({id:'expenses:'+uid,data:old.filter(x=>x.id!==id)});
      };
      const docGet=cacheStore.get('docs:'+uid);
      docGet.onsuccess=()=>{
        const old=docGet.result?.data||[];
        cacheStore.put({id:'docs:'+uid,data:old.map(d=>d.gasto_id===id?{...d,gasto_id:null}:d)});
      };
      tr.oncomplete=resolve;
      tr.onerror=()=>reject(tr.error||Error('No se pudo guardar la eliminación en el teléfono.'));
      tr.onabort=()=>reject(tr.error||Error('Error guardando el borrado.'));
    });
    // Los documentos separados que aún estén pendientes conservan sus archivos.
    // Solo dejamos de asociarlos al gasto eliminado.
    for(const j of jobs){
      if(j.kind==='document'&&j.payload?.gasto_id===id){
        // Eliminado en la misma transacción; no volver a encolar.
      }
    }
    await displayQueue();
  }
  async function prepareDocument(file,convert){
    if(!file)return null;
    const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name||'');
    if(isPdf){
      if(file.size>10*1024*1024)throw Error('El PDF supera 10 MB.');
      if((await file.slice(0,5).text())!=='%PDF-')throw Error('El archivo no parece un PDF válido.');
      return {blob:file,mime:'application/pdf',ext:'pdf',name:file.name||'documento.pdf'};
    }
    if(file.type.startsWith('image/')){
      const blob=await convert(file);
      return {blob,mime:'image/webp',ext:'webp',name:file.name||'imagen.webp'};
    }
    throw Error('Solo se aceptan PDF o imágenes.');
  }
  async function enqueueDocument(payload,prepared){
    const uid=userId();
    return persist({id:payload.id,kind:'document',uid,
      payload:{...payload,creado_por:uid},blob:prepared?.blob||null,
      mime:prepared?.mime||null,ext:prepared?.ext||null,filename:prepared?.name||null,
      created:new Date().toISOString()});
  }
  async function enqueueDocFile(docId,prepared){
    const uid=userId();
    // Duplicar la operación de este documento produce un archivo inaccesible.
    const existing=(await getJobs(uid)).some(j=>((j.kind==='doc_file'&&j.docId===docId)||(j.kind==='document'&&j.payload?.id===docId))&&j.blob);
    if(existing)throw Error('Este documento ya tiene una subida pendiente. Espera que se sincronice.');
    return persist({id:crypto.randomUUID(),kind:'doc_file',uid,docId,blob:prepared.blob,
      mime:prepared.mime,ext:prepared.ext,filename:prepared.name,created:new Date().toISOString()});
  }
  async function saveCachedExpenses(uid,rows){return putCache('expenses:'+uid,rows||[])}
  async function getCachedExpenses(uid){return getCache('expenses:'+uid)}
  async function saveCachedDocs(uid,rows){return putCache('docs:'+uid,rows||[])}
  async function getCachedDocs(uid){return getCache('docs:'+uid)}

  // Comprobación de contenido de reintentos para no sustituir un archivo distinto.
  async function sha(blob){
    const data=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return [...new Uint8Array(data)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function safeUpload(bucket,path,blob,mime){
    const {error}=await client.storage.from(bucket).upload(path,blob,{upsert:false,contentType:mime});
    if(!error)return;
    // Si el objeto se subió antes de que el cliente recibiera respuesta,
    // aceptar reintento solo si es exactamente el mismo archivo.
    const {data:already,error:probeError}=await client.storage.from(bucket).download(path);
    if(probeError||!already)throw Error('No se pudo subir '+path+': '+error.message);
    if(already.size!==blob.size||(await sha(already))!==(await sha(blob)))
      throw Error('Ya existe otro archivo en esta ruta. No se sobrescribió nada.');
  }
  async function insertOnce(table,payload){
    const {error}=await client.from(table).insert(payload);
    if(!error)return;
    if(error.code!=='23505')throw Error(table+': '+error.message);
    const {data:existing,error:fetchError}=await client.from(table).select('*').eq('id',payload.id).maybeSingle();
    if(fetchError||!existing||existing.creado_por!==payload.creado_por)throw Error('ID duplicado sin permiso para recuperar: '+payload.id);
  }
  async function linkReceipt(uid,id,blob,mime='image/webp',ext='webp'){
    if(!['application/pdf','image/webp'].includes(mime)||!['pdf','webp'].includes(ext))throw Error('Formato de comprobante no permitido.');
    if((mime==='application/pdf')!==(ext==='pdf'))throw Error('Extensión y tipo de archivo no coinciden.');
    const path=uid+'/'+id+'/recibo.'+ext;
    await safeUpload('gastofolio-recibos',path,blob,mime);
    const {data:linked,error}=await client.from('gastofolio_gastos')
      .update({comprobante_ruta:path,comprobante_tipo:mime})
      .eq('id',id).eq('creado_por',uid).select('id').maybeSingle();
    if(error||!linked)throw Error('Archivo guardado, pero no se confirmó la asociación al gasto: '+(error?.message||'Registro no encontrado.'));
  }
  async function deleteRemoteExpense(uid,id){
    const {data:row,error:readError}=await client.from('gastofolio_gastos')
      .select('id').eq('id',id).eq('creado_por',uid).maybeSingle();
    if(readError)throw Error('No se pudo comprobar el gasto antes de eliminar: '+readError.message);
    if(!row)return; // Idempotente: ya eliminado en un intento anterior.
    // Usar la API Storage, nunca DELETE SQL de storage.objects.
    const folder=uid+'/'+id;
    const {error:storageError}=await client.storage.from('gastofolio-recibos')
      .remove([folder+'/recibo.webp',folder+'/recibo.pdf']);
    if(storageError)throw Error('No se pudo eliminar el archivo; se conserva el gasto: '+storageError.message);
    const {data:remaining,error:listError}=await client.storage.from('gastofolio-recibos')
      .list(folder,{limit:100});
    if(listError)throw Error('No se pudo confirmar la eliminación de los archivos: '+listError.message);
    if((remaining||[]).some(f=>f.name==='recibo.webp'||f.name==='recibo.pdf'))
      throw Error('Aún existe un comprobante en Storage. La eliminación queda pendiente.');
    const {data:deleted,error:deleteError}=await client.from('gastofolio_gastos')
      .delete().eq('id',id).eq('creado_por',uid).select('id');
    if(deleteError||!deleted?.length)throw Error('No se confirmó la eliminación del gasto: '+(deleteError?.message||'El servidor no confirmó el borrado.'));
  }
  async function uploadDoc(uid,id,blob,mime,ext,filename){
    const path=uid+'/'+id+'/documento.'+ext;
    await safeUpload('gastofolio-documentos',path,blob,mime);
    const {data:linked,error}=await client.from('gastofolio_documentos').update({
      archivo_ruta:path,archivo_tipo:mime,archivo_nombre:(filename||'').slice(0,255)||null,estado:'recibido'
    }).eq('id',id).eq('creado_por',uid).select('id').maybeSingle();
    if(error||!linked)throw Error('Documento cargado, pero no se confirmó su asociación al registro: '+(error?.message||'Registro no encontrado.'));
  }
  async function process(job){
    if(job.kind==='expense'){
      await insertOnce('gastofolio_gastos',job.payload);
      if(job.blob)await linkReceipt(job.uid,job.payload.id,job.blob,job.mime||'image/webp',job.ext||'webp');
    }else if(job.kind==='attach'){
      await linkReceipt(job.uid,job.expenseId,job.blob,job.mime||'image/webp',job.ext||'webp');
    }else if(job.kind==='delete_expense'){
      await deleteRemoteExpense(job.uid,job.expenseId);
    }else if(job.kind==='document'){
      await insertOnce('gastofolio_documentos',{
        id:job.payload.id,creado_por:job.uid,tipo:job.payload.tipo,
        establecimiento:job.payload.establecimiento,nit:job.payload.nit,
        nota:job.payload.nota,gasto_id:job.payload.gasto_id,estado:'pendiente'
      });
      if(job.blob)await uploadDoc(job.uid,job.payload.id,job.blob,job.mime,job.ext,job.filename);
    }else if(job.kind==='doc_file'){
      await uploadDoc(job.uid,job.docId,job.blob,job.mime,job.ext,job.filename);
    }else throw Error('Tipo de operación no reconocido: '+job.kind);
  }
  async function sync(manual=false){
    paintNetwork();
    // Si la sincronización anterior sigue activa, esperar a que termine y
    // volver a comprobar la cola. Evita que un guardado online quede esperando
    // solo porque la aplicación estaba sincronizando algo al abrir.
    if(working){
      if(activeSync)await activeSync.catch(()=>{});
      if(navigator.onLine)return sync(manual);
      await displayQueue();return;
    }
    if(!navigator.onLine||!client||!getUser?.()?.id){await displayQueue();return}
    working=true;lastError='';
    let markDone;
    activeSync=new Promise(resolve=>{markDone=resolve});
    try{
      const uid=userId();
      const jobs=await getJobs(uid);
      if(!jobs.length){await displayQueue();return}
      setState?.('pendingStatus','Comprobando sesión y permiso de propietario...');
      const {data,error}=await client.auth.getUser();
      if(error||data?.user?.id!==uid)throw Error('La sesión venció o cambió. Entra nuevamente con internet.');
      const auth=await client.rpc('gastofolio_is_owner');
      if(auth.error||auth.data!==true)throw Error('El usuario no tiene autorización de propietario.');
      let success=0;
      const failedExpenses=new Set();
      for(const job of jobs){
        if(!navigator.onLine)break;
        // El RUT/cuenta de cobro espera al gasto cuando su sincronización falló.
        if(job.kind==='document' && failedExpenses.has(job.payload?.gasto_id))continue;
        try{
          setState?.('pendingStatus',`Subiendo ${success+1} de ${jobs.length}: ${label(job)}...`);
          await process(job);
          await rmJob(job.id);success++;
        }catch(e){lastError=e.message;if(job.kind==='expense')failedExpenses.add(job.payload.id);console.warn('GastoFolio: operación conservada pendiente:',job.kind,e)}
      }
      if(success){
        await refresh?.();
        if(typeof window.refreshDocs==='function')await window.refreshDocs();
      }
    }catch(e){lastError=e.message; if(manual)setState?.('pendingStatus','No se pudo sincronizar: '+e.message,'error')}
    finally{working=false;await displayQueue();markDone();activeSync=null}
  }
  function attach({db,getUser:currentUser,compress,update,setState:stateFn}){
    client=db;getUser=currentUser;refresh=update;setState=stateFn;
    paintNetwork();displayQueue();
  }
  return Object.assign(state,{version:"6.0.0",
    attach,paintNetwork,displayQueue,enqueueExpense,enqueueExpenseBundle,getPendingJobIds,getSyncError,enqueueAttach,getPendingForExpenseIds,prepareDocument,
    enqueueDocument,enqueueDocFile,enqueueDeleteExpense,getPendingDeletedIds,saveCachedExpenses,getCachedExpenses,
    saveCachedDocs,getCachedDocs,sync
  });
})();
