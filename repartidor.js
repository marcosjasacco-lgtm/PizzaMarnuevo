const SUPABASE_URL="https://nqfyxdptyqviyqlkulzq.supabase.co";
const SUPABASE_KEY="sb_publishable_79TQSkWMhsZ8DJldFxAIxA_cubFt0l-";
const driverDb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const msg=document.getElementById('message'),list=document.getElementById('orders');
const incoming=new URLSearchParams(location.hash.slice(1)).get('token');
let driverToken=incoming||'';
try{
  if(incoming)localStorage.setItem('pm_driver_access',incoming);
  else driverToken=localStorage.getItem('pm_driver_access')||'';
}catch{}
if(incoming)history.replaceState(null,'',location.pathname+location.search);
let loading=false,busy=false;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function loadDriverOrders(){
  if(loading||busy)return;
  if(!driverToken){msg.textContent='Abrí el enlace privado que te compartió PizzaMar.';list.innerHTML='';return;}
  loading=true;
  try{
    const result=await driverDb.rpc('pm_driver_orders',{p_token:driverToken});
    if(result.error)throw result.error;
    if(!Array.isArray(result.data))throw new Error('No se pudo leer la lista de pedidos.');
    msg.textContent='';
    list.innerHTML=result.data.length?result.data.map(o=>{
      const c=o.customer||{},ready=o.status==='ready',way=o.status==='on_the_way';
      const address=[c.address,c.cross||c.cross_streets,c.neighborhood].filter(Boolean).join(' · ');
      return `<article class="panel"><div class="row"><strong>Pedido ${esc(o.number||o.id)}</strong><span>${ready?'Listo para retirar':way?'En camino':esc(o.status)}</span></div>
        <p><b>${esc(c.name)}</b><br>${esc(c.phone)}<br>${esc(address)}</p>
        <p>${(Array.isArray(o.items)?o.items:[]).map(i=>`${Number(i.qty??i.quantity??1)} × ${esc(i.name)}`).join('<br>')}</p>
        ${o.notes?`<p>Notas: ${esc(o.notes)}</p>`:''}
        <p>${esc(o.payment_method)} · <b>$ ${Number(o.total||0).toLocaleString('es-AR')}</b></p>
        ${ready||way?`<button data-id="${esc(o.id)}" data-action="${ready?'pickup':'deliver'}">${ready?'Retirar pedido':'Marcar entregado'}</button>`:''}</article>`;
    }).join(''):'<div class="panel">No hay pedidos disponibles para vos en este momento.</div>';
  }catch(error){list.innerHTML='';msg.textContent=String(error.message||error).includes('PM_DRIVER_FORBIDDEN')?'El acceso venció o fue desactivado. Pedí un nuevo enlace a PizzaMar.':'No se pudieron cargar los pedidos: '+(error.message||error);}
  finally{loading=false;}
}
list.addEventListener('click',async event=>{
  const btn=event.target.closest('button[data-action]');if(!btn||busy)return;
  if(!confirm(btn.dataset.action==='pickup'?'¿Retiraste este pedido del local?':'¿Entregaste este pedido al cliente?'))return;
  busy=true;list.querySelectorAll('button').forEach(b=>b.disabled=true);
  let ok=false;
  try{
    const fn=btn.dataset.action==='pickup'?'pm_driver_pickup':'pm_driver_deliver';
    const result=await driverDb.rpc(fn,{p_id:btn.dataset.id,p_token:driverToken});
    if(result.error)throw result.error;
    if(!result.data?.id)throw new Error('No se recibió confirmación. Actualizá antes de reintentar.');
    ok=true;
  }catch(error){msg.textContent='No se pudo actualizar: '+(error.message||error);}
  finally{busy=false;list.querySelectorAll('button').forEach(b=>b.disabled=false);}
  if(ok)await loadDriverOrders();
});
document.getElementById('refresh').onclick=loadDriverOrders;
document.getElementById('exit').onclick=()=>{driverToken='';try{localStorage.removeItem('pm_driver_access')}catch{}list.innerHTML='';msg.textContent='Sesión cerrada. Para volver, abrí tu enlace privado.';};
loadDriverOrders();setInterval(()=>{if(!document.hidden)loadDriverOrders()},10000);
