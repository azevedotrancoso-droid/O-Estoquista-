
/* =========================================================
   SUPABASE — MODO ONLINE
   ========================================================= */
const SUPABASE_URL="https://qhqpasthwgysdjkeqnjt.supabase.co";
const SUPABASE_PUBLISHABLE_KEY="sb_publishable_Bh_yKtGCsd_Iam3DSFXT7Q_Io3t-xUu";
const SUPABASE_USER_FUNCTION="bright-worker";
const supabaseClient=window.supabase?.createClient
  ? window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}})
  : null;
let cloudReady=false;
let cloudSyncing=false;
let cloudSaveQueue=Promise.resolve();
let lastCloudVersion=0;

function cloudPayload(){
  const copy=JSON.parse(JSON.stringify(db));
  if(Array.isArray(copy.users)){
    copy.users=copy.users.map(u=>{
      const x={...u};
      delete x.senha;
      return x;
    });
  }
  return copy;
}
function normalizeCloudUsers(){
  if(!Array.isArray(db.users))db.users=[];
  db.users.forEach(u=>{if(!Object.prototype.hasOwnProperty.call(u,"senha"))u.senha="";});
}
async function cloudLoad(){
  if(!supabaseClient)throw new Error("Biblioteca do Supabase não carregada.");
  const {data,error}=await supabaseClient.from("estoquista_state")
    .select("id,dados,versao,atualizado_em").eq("id",1).single();
  if(error)throw error;
  const cloud=data?.dados;
  if(cloud&&typeof cloud==="object"&&Object.keys(cloud).length){
    const hasCloudData=Object.entries(cloud).some(([k,v])=>k!=="users"&&Array.isArray(v)&&v.length>0);
    const hasLocalData=Object.entries(db).some(([k,v])=>k!=="users"&&Array.isArray(v)&&v.length>0);
    if(hasCloudData||!hasLocalData){
      db=cloud;
      if(!Array.isArray(db.users))db.users=[];
      normalizeCloudUsers();
    }
  }
  lastCloudVersion=Number(data?.versao||0);
  cloudReady=true;
  return data;
}
async function cloudSave(){
  if(!cloudReady||!supabaseClient)return;
  cloudSaveQueue=cloudSaveQueue.then(async()=>{
    const {data:{user}}=await supabaseClient.auth.getUser();
    if(!user)return;
    const {data:row,error:readError}=await supabaseClient.from("estoquista_state")
      .select("versao").eq("id",1).single();
    if(readError)throw readError;
    const nextVersion=Number(row?.versao||0)+1;
    const {error}=await supabaseClient.from("estoquista_state").update({
      dados:cloudPayload(),
      versao:nextVersion,
      atualizado_por:user.id
    }).eq("id",1);
    if(error)throw error;
    lastCloudVersion=nextVersion;
  }).catch(e=>console.error("Falha ao sincronizar com Supabase:",e));
  return cloudSaveQueue;
}
async function syncCloudAfterLogin(authUser){
  if(!supabaseClient)throw new Error("Biblioteca do Supabase não carregada.");

  // Primeiro valida o usuário autenticado e carrega o perfil.
  // A leitura de estoquista_state é complementar e não pode impedir o login.
  const {data:profile,error:profileError}=await supabaseClient.from("profiles")
    .select("id,nome,login,email,perfil,ativo").eq("id",authUser.id).single();
  if(profileError)throw profileError;
  if(!profile)throw new Error("Perfil não encontrado.");
  if(profile.ativo===false)throw new Error("Usuário inativo.");

  const cleanProfile={
    id:profile.id,
    nome:profile.nome||profile.login||authUser.email||"Usuário",
    login:profile.login||authUser.email||"usuario",
    email:profile.email||authUser.email||"",
    perfil:profile.perfil||"Consulta",
    ativo:profile.ativo!==false,
    senha:""
  };

  if(!Array.isArray(db.users))db.users=[];
  const existing=db.users.find(u=>String(u.id)===String(profile.id)||
    String(u.login||"").toLowerCase()===String(cleanProfile.login).toLowerCase());
  if(existing)Object.assign(existing,cleanProfile);else db.users.push(cleanProfile);
  normalizeCloudUsers();

  // Dados operacionais são sincronizados depois da autenticação.
  // Se houver problema de RLS/rede nessa tabela, o usuário continua logado.
  try{
    const data=await cloudLoad();
    const cloudDados=data?.dados;
    const cloudHasData=cloudDados&&typeof cloudDados==="object"
      ? Object.entries(cloudDados).some(([k,v])=>k!=="users"&&Array.isArray(v)&&v.length>0)
      : false;
    const localHasData=Object.entries(db).some(([k,v])=>k!=="users"&&Array.isArray(v)&&v.length>0);
    if(!cloudHasData&&localHasData&&cloudReady)await cloudSave();
  }catch(e){
    cloudReady=false;
    console.warn("Dados operacionais ainda não foram sincronizados; login mantido:",e);
  }

  // Reaplica o perfil depois de qualquer carga da nuvem para garantir as permissões.
  if(!Array.isArray(db.users))db.users=[];
  const afterCloud=db.users.find(u=>String(u.id)===String(profile.id));
  if(afterCloud)Object.assign(afterCloud,cleanProfile);
  else db.users.push(cleanProfile);
  normalizeCloudUsers();
  persistLocalOnly();
  return cleanProfile;
}

function persistLocalOnly(){
  try{
    normalizarCategoriasProdutos();
    localStorage.setItem(KEY,JSON.stringify(db));
    return true;
  }catch(e){console.error("Falha no cache local:",e);return false;}
}
async function refreshCloudSilently(){
  if(!cloudReady||cloudSyncing||!supabaseClient)return;
  cloudSyncing=true;
  try{
    const {data,error}=await supabaseClient.from("estoquista_state")
      .select("dados,versao,atualizado_em").eq("id",1).single();
    if(error)throw error;
    const version=Number(data?.versao||0);
    if(version>lastCloudVersion && data?.dados){
      const active=document.querySelector(".view.active")?.id||"inicio";
      db=data.dados;
      if(!Array.isArray(db.users))db.users=[];
      normalizeCloudUsers();
      lastCloudVersion=version;
      persistLocalOnly();
      render();
      const activeView=document.getElementById(active);
      if(activeView){
        document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
        activeView.classList.add("active");
      }
      applyPermissions();
    }
  }catch(e){console.warn("Sincronização automática indisponível:",e);}
  finally{cloudSyncing=false;}
}

function ensureAdmin(){
  if(!Array.isArray(db.users))db.users=[];
  if(!Array.isArray(db.anotacoes))db.anotacoes=[];
  // O administrador é gerenciado exclusivamente pelo Supabase Auth + profiles.
  // Não criar usuário/senha local aqui.
}

async function login(){
  const user=(document.getElementById("loginUser").value||"").trim();
  const pass=document.getElementById("loginPass").value||"";
  const err=document.getElementById("loginError");
  if(!user||!pass){
    if(err){err.textContent="Informe usuário e senha.";err.style.display="block";}
    return;
  }
  if(!supabaseClient){
    if(err){err.textContent="Não foi possível carregar o servidor online.";err.style.display="block";}
    return;
  }
  let email=user;
  try{
    if(!user.includes("@")){
      const {data:profileLookup,error:lookupError}=await supabaseClient.from("profiles")
        .select("email,ativo").eq("login",user.toLowerCase()).maybeSingle();
      if(lookupError)throw lookupError;
      if(!profileLookup?.email || profileLookup.ativo===false)throw new Error("Usuário não encontrado ou inativo.");
      email=profileLookup.email;
    }
    const {data,error}=await supabaseClient.auth.signInWithPassword({email,password:pass});
    if(error)throw error;
    await syncCloudAfterLogin(data.user);
    const profile=db.users.find(u=>String(u.id)===String(data.user.id))||
      db.users.find(u=>String(u.login||"").toLowerCase()===user.toLowerCase())||
      db.users.find(u=>String(u.email||"").toLowerCase()===String(email).toLowerCase());
    if(!profile||profile.ativo===false)throw new Error("Perfil não encontrado ou inativo.");
    sessionStorage.setItem("o_estoquista_logged","1");
    sessionStorage.setItem("o_estoquista_user",profile.login||user);
    registrarAuditoria("Login","Entrada no sistema",`Usuário: ${profile.login||user}`);
    persist();
    document.getElementById("loginScreen").style.display="none";
    if(err)err.style.display="none";
    render();
  }catch(e){
    console.error("Falha no login online:",e);
    if(err){
      err.textContent="Usuário ou senha inválidos, ou não foi possível conectar ao servidor.";
      err.style.display="block";
    }
    document.getElementById("loginPass").value="";
    document.getElementById("loginPass").focus();
  }
}
async function logout(){
  try{if(supabaseClient)await supabaseClient.auth.signOut();}catch(e){console.warn(e);}
  sessionStorage.removeItem("o_estoquista_logged");
  sessionStorage.removeItem("o_estoquista_user");
  location.reload();
}
async function checkLogin(){
  const screen=document.getElementById("loginScreen");
  if(!supabaseClient){
    if(screen)screen.style.display="flex";
    return false;
  }
  const {data}=await supabaseClient.auth.getSession();
  const session=data?.session;
  if(!session){
    sessionStorage.removeItem("o_estoquista_logged");
    sessionStorage.removeItem("o_estoquista_user");
    if(screen)screen.style.display="flex";
    return false;
  }
  try{
    await syncCloudAfterLogin(session.user);
    const profile=db.users.find(u=>String(u.id)===String(session.user.id))||
      db.users.find(u=>String(u.email||"").toLowerCase()===String(session.user.email||"").toLowerCase());
    if(profile&&profile.ativo!==false){
      sessionStorage.setItem("o_estoquista_logged","1");
      sessionStorage.setItem("o_estoquista_user",profile.login||session.user.email);
      if(screen)screen.style.display="none";
      render();
      return true;
    }
  }catch(e){console.error("Falha ao restaurar sessão:",e);}
  try{await supabaseClient.auth.signOut();}catch(e){}
  if(screen)screen.style.display="flex";
  return false;
}

function currentUser(){
  const login=(sessionStorage.getItem("o_estoquista_user")||"").trim();
  if(!login)return null;
  return db.users.find(u=>String(u.login||"").trim().toLowerCase()===login.toLowerCase())||null;
}
function isConsulta(){
  const u=currentUser();
  return !!u && String(u.perfil||"").trim().toLowerCase()==="consulta";
}
function canEditStock(){
  const u=currentUser();
  if(!u)return false;
  const perfil=String(u.perfil||"").trim().toLowerCase();
  return perfil==="administrador" || perfil==="estoquista" || String(u.login||"").trim().toLowerCase()==="admin";
}
function isAdmin(){
  const u=currentUser();
  if(!u)return false;
  const perfil=String(u.perfil||"").trim().toLowerCase();
  return perfil==="administrador" || String(u.login||"").trim().toLowerCase()==="admin";
}
function canDelete(){ return isAdmin(); }
function denyDelete(){ alert("⛔ Seu perfil não tem permissão para excluir ou apagar dados. Apenas Administradores podem realizar essa ação."); }

const KEY="o_estoquista_v1";
let db;
try{db=JSON.parse(localStorage.getItem(KEY)||"null")}catch(e){db=null;}
if(!db||typeof db!=="object"||Array.isArray(db))db={};
if(!Array.isArray(db.produtos))db.produtos=[];
if(!Array.isArray(db.req))db.req=[];
if(!Array.isArray(db.emprestimos))db.emprestimos=[];
if(!Array.isArray(db.mov))db.mov=[];
if(!Array.isArray(db.users))db.users=[];
if(!Array.isArray(db.comprasEspeciais))db.comprasEspeciais=[];
if(!Array.isArray(db.auditoria))db.auditoria=[];
if(!Array.isArray(db.inventarios))db.inventarios=[];
if(!Array.isArray(db.destilados))db.destilados=[];
if(!Array.isArray(db.drinks))db.drinks=[];
if(!Array.isArray(db.categorias))db.categorias=[];
db.produtos.forEach(p=>{ if(!Number.isFinite(Number(p.ideal))) p.ideal=Math.max(Number(p.min)||0,(Number(p.min)||0)*2); });
const CATEGORIAS_PADRAO=["Camara Fria","Estoque Seco","Destilados","Limpeza","Refrigerantes","Cervejas e chopp"];
const categoriasLegadas=[...db.produtos.map(p=>String(p.categoria||"").trim()).filter(Boolean)];
db.categorias=[...new Set([...CATEGORIAS_PADRAO,...db.categorias.map(x=>String(x||"").trim()).filter(Boolean),...categoriasLegadas])];

// Referências explícitas aos elementos da interface. Isso evita depender
// do comportamento implícito do navegador de transformar IDs em variáveis globais.
const sProdutos=document.getElementById("sProdutos");
const sBaixo=document.getElementById("sBaixo");
const sReq=document.getElementById("sReq");
const sMov=document.getElementById("sMov");
const baixo=document.getElementById("baixo");
const rProd=document.getElementById("rProd");
const eProd=document.getElementById("eProd");
const eUn=document.getElementById("eUn");
const rUn=document.getElementById("rUn");
const rQtd=document.getElementById("rQtd");
const rSetor=document.getElementById("rSetor");
const rPrioridade=document.getElementById("rPrioridade");
const rSol=document.getElementById("rSol");
const mProd=document.getElementById("mProd");
const mTipo=document.getElementById("mTipo");
const mQtd=document.getElementById("mQtd");
const mData=document.getElementById("mData");
const mMot=document.getElementById("mMot");
const prodTable=document.getElementById("prodTable");
const userTable=document.getElementById("userTable");
const reqModal=document.getElementById("reqModal");
const reqModalTitle=document.getElementById("reqModalTitle");
const reqModalSub=document.getElementById("reqModalSub");
const reqModalStatus=document.getElementById("reqModalStatus");
const reqModalPriority=document.getElementById("reqModalPriority");
const reqModalDate=document.getElementById("reqModalDate");
const reqModalSetor=document.getElementById("reqModalSetor");
const reqModalItems=document.getElementById("reqModalItems");
function persist(){
  try{
    normalizarCategoriasProdutos();
    localStorage.setItem(KEY,JSON.stringify(db));
    if(cloudReady)cloudSave();
    return true;
  }catch(e){
    console.error("Falha ao salvar os dados do O Estoquista:",e);
    alert("Não foi possível preparar os dados para salvamento.");
    return false;
  }
}
const save=()=>{if(!persist())return false;window._estoqueAlertShown=false;render();return true;};
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
function usuarioAtualNome(){const u=currentUser();return u?`${u.nome||u.login} (${u.login})`:'Sistema';}
function registrarAuditoria(tipo,acao,detalhes){
  if(!Array.isArray(db.auditoria))db.auditoria=[];
  db.auditoria.unshift({id:id(),dataHora:new Date().toISOString(),data:hojeISO(),usuario:usuarioAtualNome(),tipo,acao,detalhes:String(detalhes||'')});
  if(db.auditoria.length>2000)db.auditoria=db.auditoria.slice(0,2000);
}
function canOperateStock(){const u=currentUser();return !!u && String(u.perfil||'').trim().toLowerCase()!=='consulta';}
function denyOperate(){alert('⛔ Seu perfil não possui permissão para realizar ajustes de estoque.');}

function applyPermissions(){
 const admin=isAdmin();
 const resetBtn=document.getElementById("resetDataBtn");
 const resetLocked=document.getElementById("resetDataLocked");
 if(resetBtn)resetBtn.style.display=admin?"inline-block":"none";
 if(resetLocked)resetLocked.style.display=admin?"none":"inline";
 document.querySelectorAll('[data-admin-only="1"]').forEach(el=>{
   el.style.display=admin?"":"none";
 });
 const podeEditar=canEditStock();
 document.querySelectorAll('[data-stock-action="1"]').forEach(el=>{
   el.style.display=podeEditar?"":"none";
 });
 // Se um usuário não autorizado estiver com uma tela restrita aberta,
 // devolve-o imediatamente para o início.
 const active=document.querySelector('.view.active');
 if(active && (active.id==='relatorios'||active.id==='auditoria'||active.id==='usuarios') && !admin){
   document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
   const inicio=document.getElementById('inicio'); if(inicio)inicio.classList.add('active');
   document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view==='inicio'));
 }
}
const ICON_PATHS={
  '📦':'<path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z"/><path d="M4 7.5 12 11l8-3.5M12 11v9"/>',
  '🏠':'<path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/>',
  '📋':'<path d="M8 4h8l1 2h3v15H4V6h3z"/><path d="M9 4a3 3 0 0 1 6 0M8 10h8M8 14h8M8 18h5"/>',
  '📌':'<path d="m15 4 5 5-3 1-3 5-4-4 5-3z"/><path d="m10 14-6 6M8 16l2 2"/>',
  '📝':'<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h6"/>',
  '🔄':'<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M19 12a7 7 0 0 0-12-4L5 10M5 12a7 7 0 0 0 12 4l2-2"/>',
  '🍊':'<circle cx="12" cy="13" r="7"/><path d="M12 6c0-2 2-3 4-3M12 6c-1-2-3-2-4-1"/>',
  '🧊':'<path d="m5 7 7-4 7 4v10l-7 4-7-4z"/><path d="m5 7 7 4 7-4M12 11v10"/>',
  '🍸':'<path d="m4 4 8 8 8-8"/><path d="M12 12v8M8 20h8"/>',
  '📊':'<path d="M4 19V5M4 19h17"/><path d="M8 16v-5M12 16V8M16 16V4M20 16v-7"/>',
  '🛡':'<path d="M12 3 20 6v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  '👤':'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  '⚙️':'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06-1.9 1.9-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.65V21h-2.7v-.08A1.8 1.8 0 0 0 11 19.27a1.8 1.8 0 0 0-2-.36l-.06.06-1.9-1.9.06-.06a1.8 1.8 0 0 0 .36-2A1.8 1.8 0 0 0 5.81 14H5.7v-2.7h.11A1.8 1.8 0 0 0 7.46 10a1.8 1.8 0 0 0-.36-2l-.06-.06 1.9-1.9.06.06a1.8 1.8 0 0 0 2 .36A1.8 1.8 0 0 0 12.1 4.8V4h2.7v.8a1.8 1.8 0 0 0 1.1 1.65 1.8 1.8 0 0 0 2-.36l.06-.06 1.9 1.9-.06.06a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.65 1.1h.11V14h-.11A1.8 1.8 0 0 0 19.4 15z"/>',
  '⚙':'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06-1.9 1.9-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.65V21h-2.7v-.08A1.8 1.8 0 0 0 11 19.27a1.8 1.8 0 0 0-2-.36l-.06.06-1.9-1.9.06-.06a1.8 1.8 0 0 0 .36-2A1.8 1.8 0 0 0 5.81 14H5.7v-2.7h.11A1.8 1.8 0 0 0 7.46 10a1.8 1.8 0 0 0-.36-2l-.06-.06 1.9-1.9.06.06a1.8 1.8 0 0 0 2 .36A1.8 1.8 0 0 0 12.1 4.8V4h2.7v.8a1.8 1.8 0 0 0 1.1 1.65 1.8 1.8 0 0 0 2-.36l.06-.06 1.9 1.9-.06.06a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.65 1.1h.11V14h-.11A1.8 1.8 0 0 0 19.4 15z"/>',
  '🚨':'<path d="M12 3 2.7 20h18.6z"/><path d="M12 9v5M12 17h.01"/>',
  '🔎':'<circle cx="10.5" cy="10.5" r="6"/><path d="m16 16 5 5"/>',
  '📄':'<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h5M9 13h6M9 17h6"/>',
  '🛒':'<path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.5a2 2 0 0 0 1.9-1.4L20 8H6"/><circle cx="10" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/>',
  '🧾':'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  '💾':'<path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  '📱':'<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 5h4M11 18.5h2"/>',
  '📁':'<path d="M3 6h7l2 2h9v11H3z"/>',
  '🥃':'<path d="M6 4h12l-1 16H7z"/><path d="M8 13h8"/>',
  '🍹':'<path d="m6 4 6 8 6-8"/><path d="M12 12v8M8 20h8M7 7h10"/>',
  '🔒':'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  '🔐':'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  '⬇️':'<path d="M12 4v12M7 12l5 5 5-5M5 20h14"/>',
  '⬆️':'<path d="M12 20V8M7 12l5-5 5 5M5 4h14"/>',
  '🗑':'<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
  '🗑️':'<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
  '✏':'<path d="m4 20 4.2-1 10.4-10.4a2.2 2.2 0 0 0-3.1-3.1L5.1 15.9z"/><path d="m13.5 7.5 3 3"/>',
  '✏️':'<path d="m4 20 4.2-1 10.4-10.4a2.2 2.2 0 0 0-3.1-3.1L5.1 15.9z"/><path d="m13.5 7.5 3 3"/>',
  '📥':'<path d="M4 4h16v16H4z"/><path d="M8 12h8M12 8v8M9 14l3 3 3-3"/>',
  '✅':'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  '⛔':'<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  '✓':'<path d="m5 12 4 4L19 6"/>',
  '⇥':'<path d="M4 5v14M4 12h12M12 7l5 5-5 5"/>'
};
function iconSvg(symbol){
  const paths=ICON_PATHS[String(symbol||'')];
  if(!paths)return null;
  const span=document.createElement('span'); span.className='ui-icon'; span.setAttribute('aria-hidden','true');
  span.innerHTML=`<svg viewBox="0 0 24 24" focusable="false">${paths}</svg>`;
  return span;
}
function normalizeIcons(root=document.body){
  if(!root)return;
  const symbols=Object.keys(ICON_PATHS).sort((a,b)=>b.length-a.length);
  const escaped=symbols.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const re=new RegExp(escaped.join('|'),'g');
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(node){
    if(!node.nodeValue || !re.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
    re.lastIndex=0;
    if(node.parentElement?.closest('.ui-icon,script,style'))return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }});
  const nodes=[]; let n; while((n=walker.nextNode()))nodes.push(n);
  nodes.forEach(node=>{
    const frag=document.createDocumentFragment(); let text=node.nodeValue,last=0,m;
    re.lastIndex=0;
    while((m=re.exec(text))){
      if(m.index>last)frag.append(document.createTextNode(text.slice(last,m.index)));
      const el=iconSvg(m[0]); frag.append(el||document.createTextNode(m[0])); last=re.lastIndex;
    }
    if(last<text.length)frag.append(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  });
}

function render(){
 applyPermissions();
 document.querySelectorAll("select").forEach(()=>{});
 sProdutos.textContent=db.produtos.length;sReq.textContent=db.req.length;sMov.textContent=db.mov.length;
 const low=db.produtos.filter(p=>p.estoque<=p.min);sBaixo.textContent=low.length;
 baixo.innerHTML=low.length?low.map(p=>`<div class="stock-alert">🚨 ${esc(p.nome)}<small>Estoque atual: <b>${p.estoque} ${p.un}</b> · Estoque mínimo: <b>${p.min} ${p.un}</b></small></div>`).join(""):"<div class='stock-ok'>✅ Todos os produtos estão acima do estoque mínimo.</div>";
 const opts='<option value="">Selecione...</option>'+db.produtos.map(p=>`<option value="${p.id}">${esc(p.nome)} (${p.estoque} ${p.un})</option>`).join("");
 const selectedProd=rProd.value; rProd.innerHTML=opts; mProd.innerHTML=opts;
 const selectedEmp=eProd?.value; if(eProd){eProd.innerHTML=opts; if(selectedEmp && db.produtos.some(p=>String(p.id)===String(selectedEmp)))eProd.value=selectedEmp;} updateEmprestimoUnit(); if(selectedProd && db.produtos.some(p=>String(p.id)===String(selectedProd))){rProd.value=selectedProd;} updateReqUnit();
 renderCategoriasUI();
 renderProdutos();
 renderRequisicoes();
 renderPendencias();
 renderMovimentos();
  renderNotas();
  renderComprasEspeciais();
  renderBebidas();
  renderGraficoConsumoMes();
  normalizeIcons(document.body);
  renderInventario();
  renderRelatorios();
  renderAuditoria();
  const userRows=db.users.map(u=>{
    const actions=u.login==="admin"?'<span class="muted">🔒 Principal</span>':(canDelete()?`<div class="actions"><button class="action-btn" onclick="editUser('${u.id}')">✏️ Editar</button><button class="trash-btn action-btn" onclick="delUser('${u.id}')" title="Excluir usuário" aria-label="Excluir usuário"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Excluir</button></div>`:`<span class="muted">🔒 Sem permissão</span>`);
    return `<tr><td>${esc(u.nome)}</td><td>${esc(u.login)}</td><td>${esc(u.email||"—")}</td><td>${esc(u.perfil)}</td><td>${actions}</td></tr>`;
  }).join("");
  userTable.innerHTML=db.users.length?`<div class="product-table-wrap"><table><tr><th>Nome</th><th>Usuário</th><th>E-mail</th><th>Perfil</th><th>Ações</th></tr>${userRows}</table></div>`:"<p class='muted'>Nenhum usuário cadastrado.</p>";
}
function id(){return Date.now().toString(36)+Math.random().toString(36).slice(2)}
function now(){return new Date().toLocaleString("pt-BR")}

function normalizarCategoriasProdutos(){
  if(!Array.isArray(db.produtos)) db.produtos=[];
  if(!Array.isArray(db.categorias)) db.categorias=[];
  db.produtos.forEach(p=>{ if(typeof p.categoria!=="string") p.categoria=""; });
  db.categorias=[...new Set([...CATEGORIAS_PADRAO,...db.categorias.map(x=>String(x||"").trim()).filter(Boolean),...db.produtos.map(p=>String(p.categoria||"").trim()).filter(Boolean)])];
}
function renderCategoriasUI(){
  normalizarCategoriasProdutos();
  const cats=db.categorias.slice().sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const pSel=document.getElementById('pCategoria');
  const filtro=document.getElementById('filtroCategoriaProduto');
  const atualP=pSel?.value||''; const atualF=filtro?.value||'';
  if(pSel)pSel.innerHTML='<option value="">Selecione a categoria</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if(filtro)filtro.innerHTML='<option value="">Todas as categorias</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if(pSel && cats.includes(atualP))pSel.value=atualP;
  if(filtro && cats.includes(atualF))filtro.value=atualF;
}
function criarCategoria(){
  if(!canEditStock())return denyOperate();
  const input=document.getElementById('novaCategoria');
  const nome=(input?.value||'').trim().replace(/\s+/g,' ');
  if(!nome)return alert('Digite o nome da nova categoria.');
  normalizarCategoriasProdutos();
  if(db.categorias.some(c=>c.toLowerCase()===nome.toLowerCase()))return alert('Essa categoria já existe.');
  db.categorias.push(nome);
  registrarAuditoria('Produto','Criou categoria',`Categoria: ${nome}`);
  if(input)input.value='';
  save();
  const sel=document.getElementById('pCategoria');if(sel)sel.value=nome;
  renderProdutos();
}

function renderProdutos(){
  normalizarCategoriasProdutos();
 const termo=(document.getElementById("buscaProduto")?.value||"").toLowerCase().trim();
 const filtro=document.getElementById("filtroProduto")?.value||"todos";
 const filtroCategoria=document.getElementById("filtroCategoriaProduto")?.value||"";
 let lista=db.produtos.filter(p=>{
   const nome=String(p.nome||"");
   const match=!termo || nome.toLowerCase().includes(termo) || String(p.cod||"").toLowerCase().includes(termo);
   const baixo=p.estoque<=p.min;
   return match && (filtro==="todos" || (filtro==="baixo"&&baixo) || (filtro==="normal"&&!baixo)) && (!filtroCategoria || (p.categoria||"")===filtroCategoria);
 });
 const baixos=db.produtos.filter(p=>p.estoque<=p.min).length;
 const norm=db.produtos.length-baixos;
 const resumo=document.getElementById("prodResumo");
 if(resumo) resumo.innerHTML=`<span class="summary-pill">📦 ${db.produtos.length} produtos</span><span class="summary-pill">🚨 ${baixos} com estoque baixo</span><span class="summary-pill">✅ ${norm} normais</span>`;
 if(!lista.length){
   prodTable.innerHTML='<div class="empty-products">🔎 Nenhum produto encontrado com os filtros atuais.</div>';
   return;
 }
 prodTable.innerHTML=`<div class="product-table-wrap"><table class="product-table"><tr><th>Produto</th><th>Categoria</th><th>Unidade</th><th>Estoque atual</th><th>Estoque mínimo</th><th>Estoque ideal</th><th>Status</th><th>Ação</th></tr>${
   lista.map(p=>{
     const baixo=p.estoque<=p.min;
     return `<tr>
       <td><div class="product-name">${esc(p.nome)}</div><div class="product-code">${p.cod?("Código: "+esc(p.cod)):"Sem código"}</div></td>
       <td>
<select class="product-category-select" data-product-id="${esc(p.id)}"
  onchange="alterarCategoriaProduto(this.dataset.productId,this.value)" onkeydown="event.stopPropagation()"
  onclick="event.stopPropagation()" title="Alterar categoria">
<option value="">Sem categoria</option>
${db.categorias.slice().sort((a,b)=>a.localeCompare(b,'pt-BR')).map(c=>`<option value="${esc(c)}" ${p.categoria===c?"selected":""}>${esc(c)}</option>`).join("")}
</select>
</td>
       <td><b>${esc(p.un)}</b></td>
       <td><span class="stock-number ${baixo?"stock-low":"stock-normal"}">${p.estoque}</span></td>
       <td>${p.min}</td>
       <td>${Number(p.ideal||Math.max(Number(p.min)||0,(Number(p.min)||0)*2))}</td>
       <td>${baixo?'<span class="badge low">🚨 Estoque baixo</span>':'<span class="badge ok">✓ Normal</span>'}</td>
       <td>${canDelete()?`<button class="trash-btn action-btn" onclick="delProduto('${p.id}')" title="Excluir produto" aria-label="Excluir produto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Excluir</button>`:`<span class="muted">🔒 Sem permissão</span>`}</td>
     </tr>`;
   }).join("")
 }</table></div>`;
}

function addProduto(){
  if(!canEditStock())return denyOperate();
  const nome = (document.getElementById("pNome")?.value || "").trim();
  const cod = (document.getElementById("pCod")?.value || "").trim();
  const un = document.getElementById("pUn")?.value || "UN";
  const categoria = document.getElementById("pCategoria")?.value || "";
  const estoque = Number(document.getElementById("pEst")?.value || 0);
  const min = Number(document.getElementById("pMin")?.value || 0);
  const idealInput=(document.getElementById("pIdeal")?.value||"").trim();
  const ideal = idealInput==="" || (Number(idealInput)===0 && min>0) ? Math.max(min,min*2) : Number(idealInput);

  if(!nome) return alert("Informe o nome.");
  if(!Number.isFinite(estoque) || estoque < 0) return alert("Informe um estoque inicial válido.");
  if(!Number.isFinite(min) || min < 0) return alert("Informe um estoque mínimo válido.");
  if(!Number.isFinite(ideal) || ideal < min) return alert("O estoque ideal deve ser maior ou igual ao mínimo.");
  if(!categoria) return alert("Selecione a categoria.");

  db.produtos.push({
    id:id(),
    nome,
    cod,
    un,
    categoria,
    estoque,
    min,
    ideal
  });

  document.getElementById("pNome").value="";
  document.getElementById("pCod").value="";
  document.getElementById("pCategoria").value="";
  document.getElementById("pEst").value=0;
  document.getElementById("pMin").value=0;
  if(document.getElementById("pIdeal"))document.getElementById("pIdeal").value=0;
  registrarAuditoria("Produto","Cadastro de produto",`Produto: ${nome} · Estoque inicial: ${estoque} ${un} · Mínimo: ${min} ${un} · Ideal: ${ideal} ${un}`);
  save();
}
function updateReqUnit(){const p=db.produtos.find(x=>String(x.id)===String(rProd.value)); rUn.value=p?p.un:"";}
if(rProd)rProd.addEventListener("change",updateReqUnit);
let reqItens=[]; let currentReqId=null;
function reqNextNumber(){
  const nums=db.req.map(r=>parseInt(String(r.numero||'').replace(/\D/g,''),10)).filter(Number.isFinite);
  const base=nums.length?Math.max(...nums):db.req.length;
  return 'REQ-'+String(base+1).padStart(4,'0');
}
function addReqItem(){
  if(!canEditStock())return denyOperate();
  const p=db.produtos.find(x=>String(x.id)===String(rProd.value)), q=+rQtd.value;
  if(!p||q<1)return alert('Selecione produto e quantidade.');
  const existente=reqItens.find(x=>x.prodId===p.id);
  const un=p.un||'UN'; if(existente){existente.qtd+=q;existente.un=un;} else reqItens.push({prodId:p.id,prod:p.nome,qtd:q,un,categoria:rSetor.value});
  rQtd.value=1; renderReqDraft();
}
function renderReqDraft(){
  const box=document.getElementById('reqDraftItems'); if(!box)return;
  if(!reqItens.length){box.innerHTML='<p class="muted">Nenhum item adicionado à nova requisição.</p>';return;}
  box.innerHTML=reqItens.map((it,i)=>`<div class="req-draft-item"><div><b>${esc(it.prod)}</b><small>${it.qtd} ${esc(it.un)} · ${esc(it.categoria)}</small></div><button class="req-draft-remove" type="button" onclick="reqItens.splice(${i},1);renderReqDraft()">Remover</button></div>`).join('');
}
function addReq(){
  if(!canEditStock())return denyOperate();
  if(!reqItens.length)return alert('Adicione pelo menos um produto à requisição.');
  const sol=rSol.value.trim(); if(!sol)return alert('Informe o solicitante.');
  const req={id:id(),numero:reqNextNumber(),data:now(),dataISO:hojeISO(),setor:rSetor.value,prioridade:rPrioridade.value,sol,itens:reqItens.map(x=>({...x,entregue:0})),status:'Pendente'};
  db.req.push(req); registrarAuditoria("Requisição","Criou requisição",`${req.numero} · Setor: ${req.setor} · Solicitante: ${req.sol} · ${req.itens.length} item(s)`); reqItens=[]; rSol.value=''; rQtd.value=1; renderReqDraft(); save(); openReqModal(req.id);
}
let emprestimoItens=[];
function updateEmprestimoUnit(){const p=db.produtos.find(x=>String(x.id)===String(eProd?.value));if(eUn)eUn.value=p?p.un:"";}
if(eProd)eProd.addEventListener("change",updateEmprestimoUnit);
function emprestimoNextNumber(){const nums=db.emprestimos.map(x=>parseInt(String(x.numero||'').replace(/\D/g,''),10)).filter(Number.isFinite);const base=nums.length?Math.max(...nums):db.emprestimos.length;return 'EMP-'+String(base+1).padStart(4,'0');}
function addEmprestimoItem(){
 if(!canEditStock())return denyOperate();
 const p=db.produtos.find(x=>String(x.id)===String(eProd?.value)),q=Number(document.getElementById('eQtd')?.value||0);
 if(!p||q<1)return alert('Selecione um produto e informe uma quantidade válida.');
 if(Number(p.estoque)<q)return alert(`Estoque insuficiente. Disponível: ${p.estoque} ${p.un}.`);
 const existente=emprestimoItens.find(x=>String(x.prodId)===String(p.id));
 if(existente){if(p.estoque<existente.qtd+q)return alert(`Estoque insuficiente. Disponível: ${p.estoque} ${p.un}.`);existente.qtd+=q;}else emprestimoItens.push({prodId:p.id,prod:p.nome,qtd:q,un:p.un});
 document.getElementById('eQtd').value=1;renderEmprestimoDraft();
}
function renderEmprestimoDraft(){const box=document.getElementById('emprestimoDraftItems');if(!box)return;if(!emprestimoItens.length){box.innerHTML='<p class="muted">Nenhum produto adicionado ao empréstimo.</p>';return;}box.innerHTML=emprestimoItens.map((it,i)=>`<div class="req-draft-item"><div><b>${esc(it.prod)}</b><small>${it.qtd} ${esc(it.un)}</small></div><button class="req-draft-remove" type="button" onclick="emprestimoItens.splice(${i},1);renderEmprestimoDraft()">Remover</button></div>`).join('');}
function addEmprestimo(){
 if(!canEditStock())return denyOperate();
 const pessoa=(document.getElementById('ePessoa')?.value||'').trim(),data=document.getElementById('eData')?.value||hojeISO(),obs=(document.getElementById('eObs')?.value||'').trim();
 if(!pessoa)return alert('Informe para quem o produto está sendo emprestado.');
 if(!emprestimoItens.length)return alert('Adicione pelo menos um produto ao empréstimo.');
 for(const it of emprestimoItens){const p=db.produtos.find(x=>String(x.id)===String(it.prodId));if(!p||Number(p.estoque)<Number(it.qtd))return alert(`Estoque insuficiente para ${it.prod}.`);}
 const emp={id:id(),numero:emprestimoNextNumber(),data,dataCriado:now(),pessoa,obs,status:'Pendente',itens:emprestimoItens.map(x=>({...x}))};
 emp.itens.forEach(it=>{const p=db.produtos.find(x=>String(x.id)===String(it.prodId));p.estoque-=Number(it.qtd);db.mov.push({id:id(),data:emp.data,prodId:p.id,prod:p.nome,tipo:'saida',qtd:Number(it.qtd),un:p.un,motivo:`Empréstimo ${emp.numero} · ${emp.pessoa}`,origem:'emprestimo',emprestimoId:emp.id});});
 db.emprestimos.unshift(emp);registrarAuditoria('Empréstimo','Registrou empréstimo',`${emp.numero} · Para: ${emp.pessoa} · ${emp.itens.length} item(s)`);emprestimoItens=[];document.getElementById('ePessoa').value='';document.getElementById('eObs').value='';document.getElementById('eQtd').value=1;renderEmprestimoDraft();save();
}
function renderPendencias(){
 const box=document.getElementById('pendTable');if(!box)return;const busca=(document.getElementById('pendBusca')?.value||'').toLowerCase().trim(),status=document.getElementById('pendStatusFiltro')?.value||'';const all=(db.emprestimos||[]).slice().reverse();const list=all.filter(x=>(!status||x.status===status)&&(!busca||`${x.numero} ${x.pessoa} ${x.obs||''} ${(x.itens||[]).map(i=>i.prod).join(' ')}`.toLowerCase().includes(busca)));const c=document.getElementById('pendCount');if(c)c.textContent=all.length;if(!list.length){box.innerHTML='<div class="req-empty">Nenhum empréstimo encontrado.</div>';return;}box.innerHTML=list.map(x=>{const pago=x.status==='Pago';return `<div class="req-card pend-card ${pago?'pend-paid':''}"><div class="req-card-top"><div><div class="req-code">${esc(x.numero)}</div><div class="req-meta">👤 ${esc(x.pessoa)} · ${esc(formatDateBR(x.data))}</div></div><span class="req-badge ${pago?'status-entregue':'status-pendente'}">${pago?'Pago':'Pendente'}</span></div><div class="pend-items">${(x.itens||[]).map(i=>`<span>${esc(i.prod)} · ${i.qtd} ${esc(i.un)}</span>`).join('')}</div>${x.obs?`<div class="req-bottom">Obs.: ${esc(x.obs)}</div>`:''}<div class="pend-actions">${!pago&&canEditStock()?`<button class="green" type="button" onclick="marcarEmprestimoPago('${x.id}');event.stopPropagation()">✓ Marcar como pago</button>`:''}${canDelete()?`<button class="danger" type="button" onclick="excluirEmprestimo('${x.id}');event.stopPropagation()">🗑️ Excluir</button>`:''}</div></div>`;}).join('');}
function marcarEmprestimoPago(i){if(!canEditStock())return denyOperate();const e=db.emprestimos.find(x=>String(x.id)===String(i));if(!e||e.status==='Pago')return;if(!confirm(`Marcar ${e.numero} como pago/devolvido?\n\nOs produtos serão devolvidos ao estoque.`))return;for(const it of e.itens||[]){const p=db.produtos.find(x=>String(x.id)===String(it.prodId));if(p){p.estoque+=Number(it.qtd);db.mov.push({id:id(),data:hojeISO(),prodId:p.id,prod:p.nome,tipo:'entrada',qtd:Number(it.qtd),un:p.un,motivo:`Devolução ${e.numero} · ${e.pessoa}`,origem:'emprestimo_devolucao',emprestimoId:e.id});}}e.status='Pago';e.pagoEm=now();registrarAuditoria('Empréstimo','Marcou como pago/devolvido',`${e.numero} · ${e.pessoa}`);save();}
function excluirEmprestimo(i){if(!canDelete())return denyDelete();const e=db.emprestimos.find(x=>String(x.id)===String(i));if(!e)return;if(e.status!=='Pago')return alert('Só é possível excluir um empréstimo depois de marcar como pago/devolvido.');if(!confirm(`Excluir ${e.numero}? O histórico de estoque será mantido.`))return;registrarAuditoria('Empréstimo','Excluiu empréstimo',`${e.numero} · ${e.pessoa}`);db.emprestimos=db.emprestimos.filter(x=>String(x.id)!==String(i));save();}
function limparFiltrosPendencias(){['pendBusca','pendStatusFiltro'].forEach(i=>{const e=document.getElementById(i);if(e)e.value='';});renderPendencias();}

function normalizeReq(r){
  if(!r || typeof r!=="object")return r;
  if(!Array.isArray(r.itens)){
    r.numero=r.numero||'REQ-'+String(db.req.indexOf(r)+1).padStart(4,'0');
    r.data=r.data||now();
    r.dataISO=r.dataISO||((/^\d{4}-\d{2}-\d{2}$/.test(String(r.data||'')))?String(r.data):hojeISO());
    r.setor=r.setor||'Outros';
    r.prioridade=r.prioridade||'Normal';
    r.sol=r.sol||'';
    r.itens=[{prodId:r.prodId||'',prod:r.prod||'',qtd:Number(r.qtd)||0,un:r.un||'UN',categoria:r.setor||'Outros',entregue:0}];
    r.status=r.status||'Pendente';
  }
  r.itens=r.itens.map(it=>({...it,prodId:it.prodId||'',prod:it.prod||'',qtd:Number(it.qtd)||0,un:it.un||'UN',categoria:it.categoria||r.setor||'Outros',entregue:Number(it.entregue)||0}));
  r.numero=r.numero||'REQ-'+String(db.req.indexOf(r)+1).padStart(4,'0');
  r.dataISO=r.dataISO||hojeISO();
  r.setor=r.setor||'Outros';
  r.prioridade=r.prioridade||'Normal';
  r.sol=r.sol||'';
  r.status=r.status||'Pendente';
  return r;
}
function reqMatches(r){
 const busca=(document.getElementById('reqBusca')?.value||'').toLowerCase().trim(), setor=document.getElementById('reqSetor')?.value||'', status=document.getElementById('reqStatusFiltro')?.value||'', pri=document.getElementById('reqPrioridadeFiltro')?.value||'';
 const txt=(r.numero+' '+r.sol+' '+r.setor+' '+r.itens.map(i=>i.prod).join(' ')).toLowerCase();
 return (!busca||txt.includes(busca))&&(!setor||r.setor===setor)&&(!status||r.status===status)&&(!pri||r.prioridade===pri);
}
function renderRequisicoes(){
  const list=document.getElementById('reqTable'); if(!list)return;
  const all=db.req.map(normalizeReq).slice().reverse(), filtered=all.filter(reqMatches);
  document.getElementById('reqCount').textContent=all.length;
  if(!filtered.length){list.innerHTML='<div class="req-empty">Nenhuma requisição encontrada.</div>';return;}
  list.innerHTML=filtered.map(r=>{const pc='priority-'+r.prioridade.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); const sc='status-'+r.status.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); return `<div class="req-card" onclick="openReqModal('${r.id}')"><div class="req-card-top"><div><div class="req-code">${esc(r.numero)} <span class="req-badge ${pc}">${esc(r.prioridade)}</span></div><div class="req-meta">${esc(r.setor)} · ${esc(r.sol)} · ${esc(r.data)}</div></div><span class="req-badge ${sc}">${esc(r.status)}</span></div><div class="req-bottom">${r.itens.length} item(s) · Data ${esc(r.dataISO||r.data)}</div></div>`;}).join('');
}
function limparFiltrosReq(){['reqBusca','reqSetor','reqStatusFiltro','reqPrioridadeFiltro'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=''});renderRequisicoes()}
function openReqModal(i){
  const raw=db.req.find(x=>String(x.id)===String(i)); if(!raw)return; const r=normalizeReq(raw); currentReqId=raw.id;
  reqModalTitle.textContent=r.numero; reqModalSub.textContent=`${r.setor} · ${r.sol} · ${r.data}`; reqModalStatus.textContent=r.status; reqModalStatus.className="req-modal-status status-"+r.status.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); reqModalPriority.textContent=r.prioridade; reqModalDate.textContent=r.dataISO||r.data; reqModalSetor.textContent=r.setor;
  reqModalItems.innerHTML=r.itens.map((it,idx)=>{const entregue=Number(it.entregue)||0; const bloqueado=r.status==='Entregue'; return `<tr><td>${esc(it.categoria||r.setor)}</td><td><div>${esc(it.prod)}</div>${it.obs?`<div class="muted">Obs.: ${esc(it.obs)}</div>`:''}</td><td>${it.qtd} ${esc(it.un)}</td><td>${bloqueado?`${entregue} ${esc(it.un)}`:`<input class="req-delivered-input" data-req-item="${idx}" type="number" min="0" max="${it.qtd}" value="${entregue||it.qtd}" onclick="event.stopPropagation()"> ${esc(it.un)}`}</td><td>${Math.max(0,Number(it.qtd)-entregue)} ${esc(it.un)}</td></tr>`;}).join('');

  const actions=document.querySelector('.req-actions');
  if(actions){
    if(r.status==='Entregue'){
      actions.innerHTML='<div class="req-locked-notice">🔒 Requisição entregue e bloqueada para alterações. Apenas a exclusão permanece disponível.</div><button type="button" class="req-red req-delete" onclick="deleteCurrentReq()" title="Excluir requisição" aria-label="Excluir requisição"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg><span>Excluir requisição</span></button>';
    }else{
      actions.innerHTML='<button type="button" class="req-orange" onclick="changeReqStatus(\'Separando\')">Marcar Separando</button><button type="button" class="req-green" onclick="changeReqStatus(\'Entregue\')">Ajustar / Confirmar entrega</button><button type="button" class="req-red" onclick="changeReqStatus(\'Pendente\')">Cancelar</button><button type="button" class="req-red req-delete" onclick="deleteCurrentReq()" title="Excluir requisição" aria-label="Excluir requisição"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg><span>Excluir requisição</span></button>';
    }
  }
  reqModal.classList.add('open'); document.body.style.overflow='hidden';
}
function closeReqModal(){reqModal.classList.remove('open');document.body.style.overflow=''}
function getReqProduct(item){
  if(item.prodId){
    const byId=db.produtos.find(p=>String(p.id)===String(item.prodId));
    if(byId)return byId;
  }
  return db.produtos.find(p=>String(p.nome).trim().toLowerCase()===String(item.prod||'').trim().toLowerCase());
}
function changeReqStatus(status){
  if(!canEditStock())return denyOperate();
  const r=db.req.find(x=>String(x.id)===String(currentReqId)); if(!r)return;
  const itens=Array.isArray(r.itens)?r.itens:[];
  const anterior=r.status||'Pendente';

  // Entregue é um estado final: não permite retorno ou edição.
  if(anterior==='Entregue'){
    alert('🔒 Esta requisição já foi entregue e está bloqueada para alterações. Ela pode apenas ser excluída.');
    openReqModal(currentReqId);
    return;
  }

  if(anterior===status){save();openReqModal(currentReqId);return;}

  if(status==='Entregue'){
    const entregas=itens.map((item,idx)=>{const el=document.querySelector(`.req-delivered-input[data-req-item="${idx}"]`);const qtd=el?Number(el.value):Number(item.entregue||item.qtd)||0;return {item,qtd};});
    for(const {item,qtd} of entregas){
      const p=getReqProduct(item);
      if(!p){alert('Não foi possível localizar o produto "'+String(item.prod||'')+'" no estoque.');return;}
      if(!Number.isFinite(qtd)||qtd<0||qtd>Number(item.qtd)){alert(`Quantidade entregue inválida para ${item.prod}.`);return;}
      if(p.estoque<qtd){alert('Estoque insuficiente para entregar a requisição.\n\nProduto: '+p.nome+'\nDisponível: '+p.estoque+' '+p.un+'\nEntregue: '+qtd+' '+p.un);return;}
    }
    entregas.forEach(({item,qtd})=>{
      const p=getReqProduct(item); p.estoque-=qtd; item.entregue=qtd;
      if(qtd>0)db.mov.push({id:id(),data:hojeISO(),prodId:p.id,prod:p.nome,tipo:'saida',qtd:qtd,un:p.un,motivo:'Requisição '+(r.numero||r.id),origem:'requisicao',reqId:r.id});
    });
  }

  r.status=status;
  registrarAuditoria("Requisição","Alterou status",`${r.numero}: ${anterior} → ${status}`);
  save(); openReqModal(currentReqId);
}
function deleteCurrentReq(){
  if(!canDelete()){denyDelete();return;}
  const r=db.req.find(x=>String(x.id)===String(currentReqId));
  if(!r)return;
  const vinculadas=db.mov.filter(m=>String(m.reqId||'')===String(r.id));
  const aviso=vinculadas.length
    ? `\n\nExistem ${vinculadas.length} movimentação(ões) de estoque vinculada(s). Elas serão mantidas no histórico, mas desvinculadas da requisição para não apagar um movimento real de estoque.`
    : '';
  if(!confirm(`Excluir ${r.numero||'esta requisição'}?${aviso}\n\nEsta ação não pode ser desfeita.`))return;
  vinculadas.forEach(m=>{delete m.reqId; if(m.origem==='requisicao')m.origem='historico_requisicao';});
  registrarAuditoria('Requisição','Excluiu requisição',`${r.numero||r.id}${vinculadas.length?` · ${vinculadas.length} movimentação(ões) mantida(s) no histórico`:''}`);
  db.req=db.req.filter(x=>String(x.id)!==String(currentReqId));
  save();
  closeReqModal();
}
function delReq(i){ if(!canDelete()){denyDelete();return;} currentReqId=i; deleteCurrentReq(); }

function delProduto(i){if(!canDelete()){denyDelete();return;}if(confirm("Excluir este produto?")){const p=db.produtos.find(x=>x.id===i);if(p)registrarAuditoria("Produto","Excluiu produto",p.nome);db.produtos=db.produtos.filter(x=>x.id!==i);save()}}
function alterarCategoriaProduto(i,categoria){
  if(!canEditStock())return denyOperate();
  const p = db.produtos.find(x=>String(x.id)===String(i));
  if(!p) return;
  p.categoria = categoria || "";
  save();
  renderProdutos();
}

function moedaBR(v){return Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
function mesAtualISO(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}
function configurarComprasEspeciais(){
  const hoje=hojeISO(); const mes=mesAtualISO();
  ['sucoData','geloData'].forEach(id=>{const el=document.getElementById(id);if(el&&!el.value)el.value=hoje;});
  ['sucoMesFiltro','geloMesFiltro'].forEach(id=>{const el=document.getElementById(id);if(el&&!el.value)el.value=mes;});
  const sq=document.getElementById('sucoPreco'), sp=document.getElementById('sucoQtd'), gq=document.getElementById('geloQtd'), gp=document.getElementById('geloPreco');
  if(sq&&!sq.dataset.bound){sq.dataset.bound='1';sq.addEventListener('input',atualizarPreviewCompras);}
  if(sp&&!sp.dataset.bound){sp.dataset.bound='1';sp.addEventListener('input',atualizarPreviewCompras);}
  if(gp&&!gp.dataset.bound){gp.dataset.bound='1';gp.addEventListener('input',atualizarPreviewCompras);}
  if(gq&&!gq.dataset.bound){gq.dataset.bound='1';gq.addEventListener('input',atualizarPreviewCompras);}
  atualizarPreviewCompras();
}
function atualizarPreviewCompras(){
  const s=(+(document.getElementById('sucoQtd')?.value||0))*(+(document.getElementById('sucoPreco')?.value||0));
  const g=(+(document.getElementById('geloQtd')?.value||0))*(+(document.getElementById('geloPreco')?.value||0));
  const se=document.getElementById('sucoLancamentoTotal'),ge=document.getElementById('geloLancamentoTotal');
  if(se)se.textContent=moedaBR(s); if(ge)ge.textContent=moedaBR(g);
}
function addCompraEspecial(tipo){
  if(!canEditStock())return denyOperate();
  const prefix=tipo==='suco'?'suco':'gelo';
  const qtd=+(document.getElementById(prefix+'Qtd')?.value||0);
  const preco=+(document.getElementById(prefix+'Preco')?.value||0);
  const data=document.getElementById(prefix+'Data')?.value||'';
  if(!Number.isFinite(qtd)||qtd<1)return alert('Informe uma quantidade válida.');
  if(!Number.isFinite(preco)||preco<=0)return alert('Informe um preço válido.');
  if(!data)return alert('Selecione a data da compra.');
  const un=tipo==='suco'?'Galão de 5 litros':'Pacote';
  db.comprasEspeciais.push({id:id(),tipo,qtd,un,precoUnitario:preco,total:qtd*preco,data});
  registrarAuditoria('Compra','Lançou compra',`${tipo==='suco'?'Suco de laranja':'Gelo'} · ${qtd} ${un} · ${moedaBR(qtd*preco)} · ${data}`);
  save();
  const q=document.getElementById(prefix+'Qtd'), pr=document.getElementById(prefix+'Preco');
  if(q)q.value=1; if(pr&&tipo==='suco')pr.value='45.00'; if(pr&&tipo==='gelo')pr.value='';
  const d=document.getElementById(prefix+'Data');if(d)d.value=hojeISO();
  atualizarPreviewCompras();
}
function renderComprasEspeciais(){
  configurarComprasEspeciais();
  const agora=mesAtualISO();
  ['suco','gelo'].forEach(tipo=>{
    const mes=(document.getElementById(tipo+'MesFiltro')?.value||agora);
    const lista=(Array.isArray(db.comprasEspeciais)?db.comprasEspeciais:[]).filter(x=>x.tipo===tipo && String(x.data||'').slice(0,7)===mes).sort((a,b)=>String(b.data||'').localeCompare(String(a.data||'')));
    const total=lista.reduce((s,x)=>s+(Number(x.total)||Number(x.qtd||0)*Number(x.precoUnitario||0)),0);
    const qtd=lista.reduce((s,x)=>s+(Number(x.qtd)||0),0);
    const totalEl=document.getElementById(tipo+'TotalMes'),qtdEl=document.getElementById(tipo+'QtdMes'),count=document.getElementById(tipo+'Count'),box=document.getElementById(tipo+'Table'),label=document.getElementById(tipo+'MesLabel');
    if(totalEl)totalEl.textContent=moedaBR(total); if(qtdEl)qtdEl.textContent=qtd; if(count)count.textContent=`${lista.length} lançamento(s)`;
    if(label){const [y,m]=mes.split('-');label.textContent=`Referente a ${m}/${y}`;}
    if(!box) return;
    box.innerHTML=lista.length?lista.map(x=>`<div class="special-row"><div><strong>${esc(formatNoteDate(x.data))}</strong><small>${x.qtd} ${esc(x.un)}</small></div><div><span>${moedaBR(x.precoUnitario)} / unidade</span><strong>${moedaBR(x.total)}</strong></div>${canDelete()?`<button class="special-delete" type="button" onclick="deleteCompraEspecial('${x.id}')">Apagar</button>`:''}</div>`).join(''):'<div class="special-empty">Nenhuma compra lançada para este mês.</div>';
  });
}
function deleteCompraEspecial(i){
  if(!canDelete()){denyDelete();return;}
  const item=db.comprasEspeciais.find(x=>String(x.id)===String(i)); if(!item)return;
  if(!confirm(`Apagar esta compra de ${item.tipo==='suco'?'suco de laranja':'gelo'}?`))return;
  db.comprasEspeciais=db.comprasEspeciais.filter(x=>String(x.id)!==String(i)); registrarAuditoria("Compra","Excluiu compra",`${item.tipo==='suco'?'Suco de laranja':'Gelo'} · ${item.qtd} ${item.un} · ${item.data}`); save();
}

function renderMovimentos(){
 const filtro=(document.getElementById("filtroMovimento")?.value||"").trim().toLowerCase();
 const todos=Array.isArray(db.mov)?db.mov:[];
 const lista=filtro?todos.filter(m=>String(m.motivo||"").toLowerCase().includes(filtro)):todos;
 const movCount=document.getElementById("movCountLabel");
 if(movCount) movCount.textContent=lista.length+(lista.length===1?" movimento":" movimentos");
 const box=document.getElementById("movTable");
 if(!box)return;
 box.innerHTML=lista.length?`<div class="mov-list">${lista.slice().reverse().map(m=>{const entrada=m.tipo==="entrada";return `<div class="mov-card ${entrada?'mov-entry':'mov-exit'}"><div class="mov-card-top"><div><div class="mov-product">${esc(m.prod)}</div><div class="mov-meta">${esc(formatDateBR(m.data))} · ${esc(m.un||'un.')}</div></div><span class="mov-badge ${entrada?'mov-badge-entry':'mov-badge-exit'}">${entrada?'↑ Entrada':'↓ Saída'}</span></div><div class="mov-details"><div class="mov-detail">Quantidade<strong>${m.qtd} ${esc(m.un||'')}</strong></div><div class="mov-detail">Motivo<strong>${esc(m.motivo||'Sem motivo informado')}</strong></div><div class="mov-detail">Ação<strong>${m.reqId||m.origem==="requisicao"?'🔒 Requisição entregue':(canDelete()?`<button class="mov-delete" onclick="delMov('${m.id}')">Apagar</button>`:'🔒 Sem permissão')}</strong></div></div></div>`}).join('')}</div>`:"<div class='mov-empty'>Nenhuma movimentação encontrada para este filtro.</div>";
}
function addMov(){
 if(!canEditStock())return denyOperate();
 let p=db.produtos.find(x=>String(x.id)===String(mProd.value)),q=Number(mQtd.value),tipo=mTipo.value;
 if(!p||!Number.isFinite(q)||q<1)return alert("Selecione produto e informe uma quantidade válida.");
 if(!["entrada","saida"].includes(tipo))return alert("Tipo de movimento inválido.");
 if(!mData.value)return alert("Selecione a data do movimento.");
 if(tipo==="saida"&&p.estoque<q)return alert("Estoque insuficiente.");
 p.estoque+=tipo==="entrada"?q:-q;
 db.mov.push({id:id(),data:mData.value,prodId:p.id,prod:p.nome,tipo,qtd:q,un:p.un,motivo:mMot.value.trim()});
 registrarAuditoria("Movimentação",mTipo.value==="entrada"?"Lançou entrada":"Lançou saída",`${p.nome} · ${q} ${p.un} · ${mMot.value.trim()||"Sem motivo"} · Data: ${mData.value}`);
 mMot.value="";
 save();
}
async function addUser(){
 if(!isAdmin())return alert("🔒 Apenas o Administrador pode cadastrar usuários.");
 if(!supabaseClient)return alert("Servidor online indisponível.");
 const nome=document.getElementById("uNome").value.trim();
 const login=document.getElementById("uLogin").value.trim().toLowerCase();
 const email=document.getElementById("uEmail").value.trim().toLowerCase();
 const senha=document.getElementById("uSenha").value;
 const perfil=document.getElementById("uPerfil").value;
 if(!nome||!login||!email||!senha)return alert("Informe nome, usuário, e-mail e senha.");
 if(login.length<3)return alert("O usuário deve ter pelo menos 3 caracteres.");
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return alert("Informe um e-mail válido.");
 if(senha.length<6)return alert("A senha deve ter pelo menos 6 caracteres.");
 if(!["Administrador","Estoquista","Consulta"].includes(perfil))return alert("Perfil inválido.");
 if(db.users.some(u=>String(u.login||"").trim().toLowerCase()===login))return alert("Esse usuário já está cadastrado.");
 if(db.users.some(u=>String(u.email||"").trim().toLowerCase()===email))return alert("Esse e-mail já está cadastrado.");
 const btn=document.getElementById("userSaveBtn");
 const oldText=btn?.textContent;
 if(btn){btn.disabled=true;btn.textContent="Criando usuário...";}
 try{
   // Atualiza a sessão antes da chamada para garantir um JWT válido.
   const {data:sessionData,error:sessionError}=await supabaseClient.auth.getSession();
   if(sessionError)throw sessionError;
   let session=sessionData?.session||null;
   if(!session){
     const refreshed=await supabaseClient.auth.refreshSession();
     if(refreshed.error)throw refreshed.error;
     session=refreshed.data?.session||null;
   }
   if(!session?.access_token)throw new Error("Sessão do administrador não encontrada. Faça login novamente.");

   // Chamada HTTP direta: envia explicitamente o JWT do administrador
   // no Authorization e a chave pública no apikey.
   const functionUrl=`${SUPABASE_URL}/functions/v1/${SUPABASE_USER_FUNCTION}`;
   const response=await fetch(functionUrl,{
     method:"POST",
     headers:{
       "Content-Type":"application/json",
       "Authorization":`Bearer ${session.access_token}`,
       "apikey":SUPABASE_PUBLISHABLE_KEY
     },
     body:JSON.stringify({nome,login,email,senha,perfil})
   });

   const responseText=await response.text();
   let data=null;
   try{data=responseText?JSON.parse(responseText):null;}catch(_e){data=null;}

   if(!response.ok){
     const serverMessage=data?.error||data?.message||responseText||`HTTP ${response.status}`;
     throw new Error(`Erro ${response.status} ao criar usuário: ${serverMessage}`);
   }
   if(!data?.ok||!data?.user)throw new Error(data?.error||"A função não confirmou a criação do usuário.");
   const created={...data.user,senha:""};
   db.users.push(created);
   registrarAuditoria("Usuário","Criou usuário online",`${nome} · ${login} · ${email} · Perfil: ${perfil}`);
   document.getElementById("uNome").value="";
   document.getElementById("uLogin").value="";
   document.getElementById("uEmail").value="";
   document.getElementById("uSenha").value="";
   cancelEditUser();
   save();
   alert(`Usuário ${login} criado com sucesso.`);
 }catch(e){
   console.error("Falha ao criar usuário online:",e);
   const msg=e?.context?.body?.error||e?.message||"Não foi possível criar o usuário.";
   alert("❌ "+msg);
 }finally{
   if(btn){btn.disabled=false;btn.textContent=oldText||"Adicionar usuário";}
 }
}
function editUser(i){
 if(!isAdmin())return denyDelete();
 const u=db.users.find(x=>String(x.id)===String(i));
 if(!u)return alert("Usuário não encontrado.");
 document.getElementById("uNome").value=u.nome||"";
 document.getElementById("uLogin").value=u.login||"";
 document.getElementById("uLogin").readOnly=true;
 document.getElementById("uEmail").value=u.email||"";
 document.getElementById("uEmail").readOnly=true;
 document.getElementById("uSenha").value="";
 document.getElementById("uPerfil").value=u.perfil||"Consulta";
 document.getElementById("userFormTitle").textContent="Editar usuário";
 const btn=document.getElementById("userSaveBtn");btn.textContent="Salvar alterações";btn.onclick=function(){saveUserEdit(i)};
 document.getElementById("userCancelBtn").style.display="inline-block";
 document.getElementById("uNome").focus();
}
function saveUserEdit(i){
 if(!isAdmin())return denyDelete();
 const u=db.users.find(x=>String(x.id)===String(i));
 if(!u)return;
 const nome=document.getElementById("uNome").value.trim();
 const login=document.getElementById("uLogin").value.trim();
 const senha=document.getElementById("uSenha").value;
 const perfil=document.getElementById("uPerfil").value;
 if(!nome||!login)return alert("Informe nome e usuário.");
 if(db.users.some(x=>x!==u&&String(x.login||"").trim().toLowerCase()===login.toLowerCase()))return alert("Esse usuário já está cadastrado.");
 if(u.login==="admin"&&login!=="admin")return alert("O usuário administrador principal deve continuar com o login admin.");
 u.nome=nome;u.login=login;u.perfil=perfil;if(senha)u.senha=senha;
 registrarAuditoria("Usuário","Editou usuário",`${nome} · ${login} · Perfil: ${perfil}`);
 cancelEditUser();save();
}
function cancelEditUser(){
 document.getElementById("uNome").value="";document.getElementById("uLogin").value="";document.getElementById("uLogin").readOnly=false;document.getElementById("uEmail").value="";document.getElementById("uEmail").readOnly=false;document.getElementById("uSenha").value="";
 document.getElementById("uPerfil").value="Administrador";
 document.getElementById("userFormTitle").textContent="Cadastrar usuário";
 const btn=document.getElementById("userSaveBtn");btn.textContent="Adicionar usuário";btn.onclick=addUser;
 document.getElementById("userCancelBtn").style.display="none";
}
function delUser(i){
 if(!canDelete()){denyDelete();return;}
 const u=db.users.find(x=>String(x.id)===String(i));
 if(!u)return;
 if(u.login==="admin")return alert("O usuário administrador principal não pode ser excluído.");
 if(confirm("Excluir o usuário "+u.nome+" ("+u.login+")?\n\nEssa ação não pode ser desfeita.")){
  db.users=db.users.filter(x=>String(x.id)!==String(i)); registrarAuditoria("Usuário","Excluiu usuário",`${u.nome} · ${u.login}`); save();
 }
}
function formatMes(v){if(!v)return '';const [a,b]=String(v).split('-');return a&&b?`${b}/${a}`:v;}
function renderGraficoConsumoMes(){
  const mes=mesAtualISO();
  const compras=Array.isArray(db.comprasEspeciais)?db.comprasEspeciais.filter(x=>String(x.data||'').slice(0,7)===mes):[];
  const suco=compras.filter(x=>x.tipo==='suco').reduce((s,x)=>s+(Number(x.total)||Number(x.qtd||0)*Number(x.precoUnitario||0)),0);
  const gelo=compras.filter(x=>x.tipo==='gelo').reduce((s,x)=>s+(Number(x.total)||Number(x.qtd||0)*Number(x.precoUnitario||0)),0);
  const total=suco+gelo;
  const chart=document.getElementById('consumoGrafico'),legend=document.getElementById('consumoLegenda'),totalEl=document.getElementById('consumoTotalMes');
  if(!chart||!legend)return;
  if(totalEl)totalEl.textContent=moedaBR(total);
  if(total<=0){chart.innerHTML='<div class="consumption-empty">Nenhuma compra de suco ou gelo lançada neste mês.</div>';legend.innerHTML='';return;}
  const raio=82,circ=2*Math.PI*raio,sucoDash=(suco/total)*circ,geloDash=(gelo/total)*circ;
  const sucoPct=(suco/total)*100,geloPct=(gelo/total)*100;
  chart.innerHTML=`<div class="donut-chart" aria-label="Distribuição dos gastos do mês"><svg viewBox="0 0 220 220" role="img"><circle class="donut-track" cx="110" cy="110" r="${raio}"></circle><circle class="donut-suco" cx="110" cy="110" r="${raio}" stroke-dasharray="${sucoDash} ${circ-sucoDash}" transform="rotate(-90 110 110)"></circle><circle class="donut-gelo" cx="110" cy="110" r="${raio}" stroke-dasharray="${geloDash} ${circ-geloDash}" stroke-dashoffset="-${sucoDash}" transform="rotate(-90 110 110)"></circle></svg><div class="donut-center"><strong>${moedaBR(total)}</strong><span>No mês</span></div></div>`;
  legend.innerHTML=`<div class="legend-item"><span class="legend-dot suco"></span><div><strong>Suco de laranja — ${moedaBR(suco)}</strong><small>${sucoPct.toFixed(1).replace('.',',')}% do total</small></div></div><div class="legend-item"><span class="legend-dot gelo"></span><div><strong>Gelo — ${moedaBR(gelo)}</strong><small>${geloPct.toFixed(1).replace('.',',')}% do total</small></div></div>`;
}
function renderInventario(){
 const dataEl=document.getElementById('inventarioData'); if(dataEl&&!dataEl.value)dataEl.value=hojeISO();
 normalizarCategoriasProdutos();
 const box=document.getElementById('inventarioTable'); if(!box)return;
 const lista=db.produtos.slice().sort((a,b)=>String(a.nome).localeCompare(String(b.nome),'pt-BR'));
 const categorias=[...new Set(lista.map(p=>String(p.categoria||'Sem categoria').trim()||'Sem categoria'))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
 const totalCategorias=categorias.length;
 const grupos=categorias.map(cat=>({cat,items:lista.filter(p=>(String(p.categoria||'Sem categoria').trim()||'Sem categoria')===cat)}));
 const rows=grupos.map(g=>{
   const header=`<tr class="inventory-category-row"><td colspan="5"><strong>📁 ${esc(g.cat)}</strong><span>${g.items.length} produto(s)</span></td></tr>`;
   const body=g.items.map(p=>{
     const val=document.getElementById('inv_'+p.id)?.value??'';
     return `<tr><td><strong>${esc(p.nome)}</strong><small class="muted">${esc(p.cod||'')}</small></td><td>${esc(p.un)}</td><td>${Number(p.estoque||0)}</td><td><input class="inventory-count-input" id="inv_${esc(p.id)}" data-prod-id="${esc(p.id)}" type="number" min="0" step="any" value="${esc(val)}" placeholder="Contagem"></td><td id="diff_${esc(p.id)}">—</td></tr>`;
   }).join('');
   return header+body;
 }).join('');
 box.innerHTML=lista.length?`<div class="inventory-category-summary">${grupos.map(g=>`<span class="inventory-cat-pill">📁 ${esc(g.cat)} <b>${g.items.length}</b></span>`).join('')}</div><div class="product-table-wrap"><table><thead><tr><th>Produto</th><th>Unidade</th><th>Sistema</th><th>Contagem física</th><th>Diferença</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="empty-products">Nenhum produto cadastrado para inventariar.</div>';
 document.querySelectorAll('.inventory-count-input').forEach(el=>el.addEventListener('input',()=>{
   const p=db.produtos.find(x=>String(x.id)===String(el.dataset.prodId));
   const d=document.getElementById('diff_'+el.dataset.prodId);
   if(d)d.textContent=el.value===''?'—':`${Number(el.value)-Number(p?.estoque||0)}`;
 }));
 const resumo=document.getElementById('inventarioResumo');if(resumo)resumo.textContent=`${lista.length} produto(s) · ${totalCategorias} categoria(s) · informe apenas os itens contados`;
 const hist=Array.isArray(db.inventarios)?db.inventarios.slice().sort((a,b)=>String(b.dataHora).localeCompare(String(a.dataHora))):[];const hc=document.getElementById('inventarioHistoricoCount');if(hc)hc.textContent=`${hist.length} registro(s)`;const hb=document.getElementById('inventarioHistorico');if(hb)hb.innerHTML=hist.length?`<div class="product-table-wrap"><table><tr><th>Data</th><th>Categoria</th><th>Produto</th><th>Sistema</th><th>Físico</th><th>Diferença</th><th>Usuário</th>${isAdmin()?'<th>Ações</th>':''}</tr>${hist.slice(0,100).map(x=>`<tr><td>${esc(x.data)}</td><td>${esc(x.categoria||'Sem categoria')}</td><td>${esc(x.prod)}</td><td>${x.sistema}</td><td>${x.fisico}</td><td><strong>${x.diferenca>0?'+':''}${x.diferenca}</strong></td><td>${esc(x.usuario||'')}</td>${isAdmin()?`<td><button class="inventory-delete-btn" type="button" onclick="apagarInventario('${x.id}')" title="Excluir inventário" aria-label="Excluir inventário"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg><span>Excluir</span></button></td>`:''}</tr>`).join('')}</table></div>`:'<div class="empty-products">Nenhum inventário registrado.</div>';
}

function apagarInventario(inventarioId){
 if(!isAdmin()){denyDelete();return;}
 const item=Array.isArray(db.inventarios)?db.inventarios.find(x=>String(x.id)===String(inventarioId)):null;
 if(!item)return alert('Inventário não encontrado.');
 if(!confirm(`Apagar o registro de inventário de ${item.prod||'produto'} em ${item.data||''}?\n\nEsta ação remove o registro do histórico e não desfaz o ajuste de estoque que já foi aplicado.\n\nEsta ação não pode ser desfeita.`))return;
 db.inventarios=db.inventarios.filter(x=>String(x.id)!==String(inventarioId));
 registrarAuditoria('Inventário','Apagou inventário',`Produto: ${item.prod||''} · Data: ${item.data||''} · Registro: ${item.id}`);
 save();
 alert('Registro de inventário apagado.');
}

function aplicarInventario(){
 if(!canEditStock())return denyOperate();
 const data=document.getElementById('inventarioData')?.value||hojeISO();
 const inputs=[...document.querySelectorAll('.inventory-count-input')].filter(x=>x.value!=='');
 if(!inputs.length)return alert('Informe pelo menos uma contagem física.');
 const conferencias=[];
 for(const el of inputs){
   const p=db.produtos.find(x=>String(x.id)===String(el.dataset.prodId));
   const fisico=Number(el.value);
   if(!p)return alert('Um dos produtos da contagem não foi encontrado. Nenhuma alteração foi aplicada.');
   if(!Number.isFinite(fisico)||fisico<0)return alert(`A contagem física de ${p.nome} é inválida. Nenhuma alteração foi aplicada.`);
   const sistema=Number(p.estoque)||0;
   conferencias.push({p,fisico,sistema,dif:fisico-sistema});
 }
 let alterados=0;
 conferencias.forEach(({p,fisico,sistema,dif})=>{
   if(dif!==0){
     p.estoque=fisico;
     db.mov.push({id:id(),data,prodId:p.id,prod:p.nome,tipo:dif>0?'entrada':'saida',qtd:Math.abs(dif),un:p.un,motivo:'Ajuste de inventário',origem:'inventario'});
     alterados++;
   }
   db.inventarios.unshift({id:id(),data,prod:p.nome,prodId:p.id,categoria:p.categoria||'Sem categoria',sistema,fisico,diferenca:dif,usuario:usuarioAtualNome(),dataHora:new Date().toISOString()});
 });
 registrarAuditoria('Inventário','Aplicou inventário',`${conferencias.length} produto(s) conferido(s) · ${alterados} ajuste(s) realizado(s) · Data: ${data}`);
 save();
 alert(`Inventário aplicado. ${alterados} ajuste(s) realizado(s).`);
}
function sugestoesCompra(){return db.produtos.map(p=>{const ideal=Number(p.ideal||Math.max(Number(p.min)||0,(Number(p.min)||0)*2));const falta=Math.max(0,ideal-(Number(p.estoque)||0));return {...p,ideal,sugerida:falta};}).filter(p=>p.sugerida>0).sort((a,b)=>b.sugerida-a.sugerida);}
function renderRelatorios(){
 if(!isAdmin())return;
 const mes=document.getElementById('relatorioMes')?.value||mesAtualISO();const mov=(db.mov||[]).filter(m=>String(m.data||'').slice(0,7)===mes);const req=(db.req||[]).map(normalizeReq).filter(r=>String(r.dataISO||r.data||'').slice(0,7)===mes);const compras=(db.comprasEspeciais||[]).filter(x=>String(x.data||'').slice(0,7)===mes);const entradas=mov.filter(m=>m.tipo==='entrada').reduce((s,m)=>s+Number(m.qtd||0),0),saidas=mov.filter(m=>m.tipo==='saida').reduce((s,m)=>s+Number(m.qtd||0),0);const gastos=compras.reduce((s,x)=>s+Number(x.total||0),0);const baixo=db.produtos.filter(p=>Number(p.estoque)<=Number(p.min)).length;
 const cards=document.getElementById('relatorioCards');if(cards)cards.innerHTML=`<div class="card"><span>Produtos</span><div class="stat">${db.produtos.length}</div></div><div class="card"><span>Estoque baixo</span><div class="stat">${baixo}</div></div><div class="card"><span>Entradas</span><div class="stat">${entradas}</div></div><div class="card"><span>Saídas</span><div class="stat">${saidas}</div></div><div class="card"><span>Requisições</span><div class="stat">${req.length}</div></div><div class="card"><span>Compras especiais</span><div class="stat">${moedaBR(gastos)}</div></div>`;
 const sug=document.getElementById('sugestaoComprasTable');const arr=sugestoesCompra();if(sug)sug.innerHTML=arr.length?`<div class="product-table-wrap"><table><tr><th>Produto</th><th>Atual</th><th>Mínimo</th><th>Ideal</th><th>Sugerir compra</th><th>Unidade</th></tr>${arr.map(p=>`<tr><td>${esc(p.nome)}</td><td>${p.estoque}</td><td>${p.min}</td><td>${p.ideal}</td><td><strong>${p.sugerida}</strong></td><td>${esc(p.un)}</td></tr>`).join('')}</table></div>`:'<div class="report-empty">✅ Nenhum produto abaixo do estoque ideal.</div>';
 const est=document.getElementById('relatorioEstoque');if(est)est.innerHTML=`<div class="product-table-wrap"><table><tr><th>Produto</th><th>Categoria</th><th>Atual</th><th>Mínimo</th><th>Ideal</th><th>Status</th></tr>${db.produtos.slice().sort((a,b)=>String(a.nome).localeCompare(String(b.nome),'pt-BR')).map(p=>`<tr><td>${esc(p.nome)}</td><td>${esc(p.categoria||'-')}</td><td>${p.estoque} ${esc(p.un)}</td><td>${p.min}</td><td>${Number(p.ideal||0)}</td><td>${p.estoque<=p.min?'<span class="badge low">Baixo</span>':'<span class="badge ok">Normal</span>'}</td></tr>`).join('')}</table></div>`;
 const rm=document.getElementById('relatorioMovimentos');if(rm)rm.innerHTML=mov.length?`<div class="product-table-wrap"><table><tr><th>Data</th><th>Produto</th><th>Tipo</th><th>Qtd.</th><th>Motivo</th></tr>${mov.slice().reverse().map(m=>`<tr><td>${esc(m.data)}</td><td>${esc(m.prod)}</td><td>${m.tipo==='entrada'?'Entrada':'Saída'}</td><td>${m.qtd} ${esc(m.un||'')}</td><td>${esc(m.motivo||'-')}</td></tr>`).join('')}</table></div>`:'<div class="report-empty">Nenhuma movimentação no mês selecionado.</div>';
 const rr=document.getElementById('relatorioRequisicoes');if(rr)rr.innerHTML=req.length?`<div class="product-table-wrap"><table><tr><th>Requisição</th><th>Setor</th><th>Solicitante</th><th>Status</th><th>Prioridade</th></tr>${req.map(r=>`<tr><td>${esc(r.numero)}</td><td>${esc(r.setor)}</td><td>${esc(r.sol)}</td><td>${esc(r.status)}</td><td>${esc(r.prioridade)}</td></tr>`).join('')}</table></div>`:'<div class="report-empty">Nenhuma requisição no mês selecionado.</div>';
 const rc=document.getElementById('relatorioCompras');if(rc)rc.innerHTML=compras.length?`<div class="product-table-wrap"><table><tr><th>Data</th><th>Tipo</th><th>Quantidade</th><th>Unidade</th><th>Total</th></tr>${compras.slice().reverse().map(x=>`<tr><td>${esc(x.data)}</td><td>${x.tipo==='suco'?'Suco de laranja':'Gelo'}</td><td>${x.qtd}</td><td>${esc(x.un)}</td><td>${moedaBR(x.total)}</td></tr>`).join('')}</table></div>`:'<div class="report-empty">Nenhuma compra especial no mês selecionado.</div>';
}
function exportSugestaoCompras(){if(!isAdmin())return denyDelete();const rows=[['Produto','Atual','Mínimo','Ideal','Sugestão de compra','Unidade'],...sugestoesCompra().map(p=>[p.nome,p.estoque,p.min,p.ideal,p.sugerida,p.un])];download('o_estoquista_sugestao_compras.csv',csv(rows));}
function exportRelatorioMes(){if(!isAdmin())return denyDelete();const mes=document.getElementById('relatorioMes')?.value||mesAtualISO();const rows=[['RELATÓRIO DO MÊS',formatMes(mes)],[],['MOVIMENTAÇÕES'],['Data','Produto','Tipo','Quantidade','Unidade','Motivo'],...(db.mov||[]).filter(m=>String(m.data||'').slice(0,7)===mes).map(m=>[m.data,m.prod,m.tipo,m.qtd,m.un,m.motivo]),[],['REQUISIÇÕES'],['Número','Setor','Solicitante','Status','Prioridade'],...(db.req||[]).map(normalizeReq).filter(r=>String(r.dataISO||r.data||'').slice(0,7)===mes).map(r=>[r.numero,r.setor,r.sol,r.status,r.prioridade])];download(`o_estoquista_relatorio_${mes}.csv`,csv(rows));}
function renderAuditoria(){const box=document.getElementById('auditoriaTable');if(!box)return;if(!isAdmin()){box.innerHTML='<div class="report-empty">🔒 A área de auditoria é exclusiva do Administrador.</div>';const c=document.getElementById('auditoriaCount');if(c)c.textContent='Acesso restrito';return;}const q=(document.getElementById('auditoriaBusca')?.value||'').toLowerCase().trim(),tipo=document.getElementById('auditoriaTipo')?.value||'';const all=(db.auditoria||[]).filter(x=>(!tipo||x.tipo===tipo)&&(!q||`${x.usuario} ${x.acao} ${x.detalhes}`.toLowerCase().includes(q)));const c=document.getElementById('auditoriaCount');if(c)c.textContent=`${all.length} registro(s)`;box.innerHTML=all.length?`<div class="product-table-wrap"><table><tr><th>Data/hora</th><th>Usuário</th><th>Tipo</th><th>Ação</th><th>Detalhes</th></tr>${all.slice(0,300).map(x=>`<tr><td>${esc(new Date(x.dataHora).toLocaleString('pt-BR'))}</td><td>${esc(x.usuario)}</td><td><span class="audit-type">${esc(x.tipo)}</span></td><td><strong>${esc(x.acao)}</strong></td><td>${esc(x.detalhes)}</td></tr>`).join('')}</table></div>`:'<div class="report-empty">Nenhum registro encontrado.</div>';}
function exportAuditoria(){if(!isAdmin())return denyDelete();const rows=[['Data/hora','Usuário','Tipo','Ação','Detalhes'],...(db.auditoria||[]).map(x=>[new Date(x.dataHora).toLocaleString('pt-BR'),x.usuario,x.tipo,x.acao,x.detalhes])];download('o_estoquista_auditoria.csv',csv(rows));}

function csv(rows){return "\ufeff"+rows.map(r=>r.map(x=>`"${String(x??"").replace(/"/g,'""')}"`).join(";")).join("\r\n")}
function download(name,content,type="text/csv;charset=utf-8"){let a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function isReqMovement(m){return !!(m && (m.reqId || m.origem==="requisicao" || String(m.motivo||"").startsWith("Requisição ")));}
function reverseMovement(m){
 const p=db.produtos.find(x=>String(x.id)===String(m.prodId||"")||String(x.nome).trim().toLowerCase()===String(m.prod||"").trim().toLowerCase());
 if(!p)return;
 const q=Number(m.qtd)||0;
 if(m.tipo==="entrada")p.estoque=Math.max(0,(+p.estoque||0)-q);
 else if(m.tipo==="saida")p.estoque=(+p.estoque||0)+q;
}
function reopenRequisition(reqId){
 const r=db.req.find(x=>String(x.id)===String(reqId));
 if(!r)return;
 r.status="Pendente";
 if(Array.isArray(r.itens))r.itens.forEach(it=>it.entregue=0);
}
function delMov(i){
 if(!canDelete()){denyDelete();return;}
 const m=db.mov.find(x=>String(x.id)===String(i));
 if(!m)return;
 const reqMove=isReqMovement(m);
 if(reqMove&&!isAdmin())return alert("Somente o Administrador pode apagar movimentações geradas por requisições.");
 if(reqMove){
   const reqId=m.reqId;
   const related=db.mov.filter(x=>String(x.reqId||"")===String(reqId));
   if(!confirm("Esta movimentação pertence a uma requisição entregue.\n\nAo apagar, todas as movimentações dessa requisição serão revertidas e a requisição voltará para Pendente.\n\nContinuar?"))return;
   related.forEach(reverseMovement);
   db.mov=db.mov.filter(x=>String(x.reqId||"")!==String(reqId));
   reopenRequisition(reqId);
 }else{
   if(!confirm("Apagar esta movimentação?\n\nTipo: "+m.tipo+"\nProduto: "+m.prod+"\nQuantidade: "+m.qtd+" "+(m.un||"")+"\n\nO estoque será ajustado automaticamente."))return;
   reverseMovement(m);
   db.mov=db.mov.filter(x=>String(x.id)!==String(i));
 }
 save(); render();
}
function hojeISO(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function formatDateBR(v){const s=String(v||'');if(/^\d{4}-\d{2}-\d{2}$/.test(s)){const [y,m,d]=s.split('-');return `${d}/${m}/${y}`;}return s;}
function formatNoteDate(v){const p=String(v||'').split('-');return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:String(v||'');}
function clearNoteForm(){document.getElementById('noteTitulo').value='';document.getElementById('noteData').value=hojeISO();document.getElementById('noteTexto').value='';}
function deleteNote(id){const n=db.anotacoes.find(x=>String(x.id)===String(id));if(!n)return;if(!confirm(`Apagar a anotação "${n.titulo||'Anotação'}"?`))return;db.anotacoes=db.anotacoes.filter(x=>String(x.id)!==String(id));save();renderNotas();}
let editingNoteId=null;
function editNote(id){const n=db.anotacoes.find(x=>String(x.id)===String(id));if(!n)return;editingNoteId=n.id;document.getElementById('noteTitulo').value=n.titulo||'';document.getElementById('noteData').value=n.data||hojeISO();document.getElementById('noteTexto').value=n.texto||'';const btn=document.getElementById('noteSaveBtn');if(btn)btn.textContent='Salvar alterações';const cancel=document.getElementById('noteCancelBtn');if(cancel)cancel.style.display='inline-block';document.getElementById('noteTitulo').focus();}
function cancelNoteEdit(){editingNoteId=null;clearNoteForm();const btn=document.getElementById('noteSaveBtn');if(btn)btn.textContent='Salvar anotação';const cancel=document.getElementById('noteCancelBtn');if(cancel)cancel.style.display='none';renderNotas();}
function addNote(){const titulo=(document.getElementById('noteTitulo').value||'').trim(),texto=(document.getElementById('noteTexto').value||'').trim(),data=document.getElementById('noteData').value||hojeISO();if(!titulo&&!texto)return alert('Digite uma anotação antes de salvar.');if(editingNoteId!==null){const n=db.anotacoes.find(x=>String(x.id)===String(editingNoteId));if(!n)return cancelNoteEdit();n.titulo=titulo||'Anotação';n.texto=texto;n.data=data;n.atualizadoEm=new Date().toISOString();editingNoteId=null;}else{db.anotacoes.unshift({id:Date.now(),titulo:titulo||'Anotação',texto,data,criadoEm:new Date().toISOString()});}save();clearNoteForm();const btn=document.getElementById('noteSaveBtn');if(btn)btn.textContent='Salvar anotação';const cancel=document.getElementById('noteCancelBtn');if(cancel)cancel.style.display='none';renderNotas();}
function renderNotas(){const list=document.getElementById('notesList'),count=document.getElementById('noteCount');if(!list)return;const notes=Array.isArray(db.anotacoes)?db.anotacoes.slice().sort((a,b)=>String(b.data||'').localeCompare(String(a.data||''))||(+b.id||0)-(+a.id||0)):[];if(count)count.textContent=`${notes.length} anotação(ões)`;if(!notes.length){list.innerHTML='<div class="note-empty">Nenhuma anotação cadastrada.</div>';return;}list.innerHTML=notes.map(n=>`<article class="note-card"><div class="note-top"><div><div class="note-title">${esc(n.titulo||'Anotação')}</div><div class="note-date">${esc(formatNoteDate(n.data))}</div></div></div><div class="note-text">${esc(n.texto||'')}</div><div class="note-actions"><button class="secondary" type="button" onclick="editNote('${n.id}')">Editar</button><button class="danger" type="button" onclick="deleteNote('${n.id}')">Apagar</button></div></article>`).join('');}
function exportNotesPDF(){if(!Array.isArray(db.anotacoes)||!db.anotacoes.length)return alert('Não há anotações para exportar.');renderNotas();window.print();}

function exportCSV(){let rows=[["Data","Produto","Tipo","Quantidade","Unidade","Motivo"] ,...db.mov.map(m=>[m.data,m.prod,m.tipo,m.qtd,m.un,m.motivo])];download("o_estoquista_entradas_saidas.csv",csv(rows))}
function exportAll(){let rows=[["CATEGORIAS"],["Categoria"],...(db.categorias||[]).map(c=>[c]),[],["PRODUTOS"],["Nome","Código","Unidade","Categoria","Estoque","Mínimo","Ideal"],...db.produtos.map(p=>[p.nome,p.cod,p.un,p.categoria,p.estoque,p.min,p.ideal]),[],["MOVIMENTAÇÕES"],["Data","Produto","Tipo","Quantidade","Unidade","Motivo"],...db.mov.map(m=>[m.data,m.prod,m.tipo,m.qtd,m.un,m.motivo]),[],["COMPRAS ESPECIAIS"],["Tipo","Data","Quantidade","Unidade","Preço unitário","Total"],...(db.comprasEspeciais||[]).map(x=>[x.tipo,x.data,x.qtd,x.un,x.precoUnitario,x.total]),[],["DESTILADOS"],["Nome","Marca","Categoria","Volume (ml)","Preço compra","Custo/ml"],...(db.destilados||[]).map(d=>[d.nome,d.marca,d.categoria,d.volumeMl,d.preco,d.custoMl]),[],["FICHAS TÉCNICAS DE DRINKS"],["Drink","Categoria","Rendimento","Preço venda","Margem-alvo","Preço sugerido","Custo por drink","Lucro","Margem"],...(db.drinks||[]).map(d=>{const c=drinkCalculos(d);return[d.nome,d.categoria,d.rendimento,d.precoVenda,c.alvo/100,c.precoSugerido,c.custo,c.lucro,c.margem/100]} )];download("o_estoquista_dados.csv",csv(rows))}
let editingDrinkId=null;
let bebidaIngredientes=[];

function moedaBebida(v){return Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
function bebidaNumero(v){return Number(v)||0;}
function bebidaCustoMl(d){return bebidaNumero(d?.preco)/Math.max(1,bebidaNumero(d?.volumeMl));}
function updateBebDestCost(){
  const vol=bebidaNumero(document.getElementById('bebDestVolume')?.value),preco=bebidaNumero(document.getElementById('bebDestPreco')?.value);
  const el=document.getElementById('bebDestCustoMl'); if(el)el.textContent=moedaBebida(vol>0?preco/vol:0).replace(/(,\d{2})$/,'$1')+' / ml';
}
function addDestilado(){
  if(!canOperateStock()){denyOperate();return;}
  const nome=(document.getElementById('bebDestNome').value||'').trim(),marca=(document.getElementById('bebDestMarca').value||'').trim(),volume=bebidaNumero(document.getElementById('bebDestVolume').value),preco=bebidaNumero(document.getElementById('bebDestPreco').value),categoria=document.getElementById('bebDestCategoria').value;
  if(!nome)return alert('Informe o nome do destilado.');
  if(volume<=0)return alert('Informe um volume de garrafa válido.');
  if(preco<0)return alert('Informe um preço de compra válido.');
  db.destilados.unshift({id:id(),nome,marca,volumeMl:volume,preco,categoria,custoMl:preco/volume,criadoEm:new Date().toISOString()});
  registrarAuditoria('Bebidas','Cadastrou destilado',`${nome}${marca?' · '+marca:''} · ${volume} ml · ${moedaBebida(preco)}`);
  document.getElementById('bebDestNome').value='';document.getElementById('bebDestMarca').value='';document.getElementById('bebDestVolume').value='';document.getElementById('bebDestPreco').value='';
  save();
}
function deleteDestilado(i){
  if(!canDelete()){denyDelete();return;}
  const d=db.destilados.find(x=>String(x.id)===String(i));if(!d)return;
  if(db.drinks.some(dr=>(dr.ingredientes||[]).some(it=>it.tipo==='destilado'&&String(it.refId)===String(i))))return alert('Este destilado está sendo usado em uma ou mais fichas técnicas. Remova-o das fichas antes de excluir.');
  if(!confirm(`Excluir o destilado "${d.nome}"?`))return;
  db.destilados=db.destilados.filter(x=>String(x.id)!==String(i));registrarAuditoria('Bebidas','Excluiu destilado',d.nome);save();
}
function updateBebIngredientFields(){
  const tipo=document.getElementById('bebIngTipo')?.value||'destilado',sel=document.getElementById('bebIngDestilado'),nome=document.getElementById('bebIngNome'),custo=document.getElementById('bebIngCusto'),un=document.getElementById('bebIngUn');
  if(tipo==='destilado'){
    sel.style.display='';nome.style.display='none';custo.style.display='none';un.value='ml';
  }else{
    sel.style.display='none';nome.style.display='';custo.style.display='';un.value='un';
  }
}
function renderBebDestSelect(){
  const sel=document.getElementById('bebIngDestilado');if(!sel)return;const old=sel.value;
  sel.innerHTML='<option value="">Selecione o destilado...</option>'+db.destilados.map(d=>`<option value="${d.id}">${esc(d.nome)}${d.marca?' · '+esc(d.marca):''} — ${d.volumeMl} ml</option>`).join('');if(db.destilados.some(d=>String(d.id)===String(old)))sel.value=old;
}
function addBebIngredient(){
  if(!canOperateStock()){denyOperate();return;}
  const tipo=document.getElementById('bebIngTipo').value,qtd=bebidaNumero(document.getElementById('bebIngQtd').value),un=document.getElementById('bebIngUn').value;
  if(qtd<=0)return alert('Informe uma quantidade válida.');
  let item;
  if(tipo==='destilado'){
    const refId=document.getElementById('bebIngDestilado').value,d=db.destilados.find(x=>String(x.id)===String(refId));if(!d)return alert('Selecione um destilado.');
    if(un!=='ml')return alert('Destilados devem ser medidos em ml para o cálculo automático.');
    item={id:id(),tipo:'destilado',refId:d.id,nome:d.nome,marca:d.marca||'',qtd,un,custoUnitario:bebidaCustoMl(d),custo:qtd*bebidaCustoMl(d)};
  }else{
    const nome=(document.getElementById('bebIngNome').value||'').trim(),custoUnit=bebidaNumero(document.getElementById('bebIngCusto').value);if(!nome)return alert('Informe o nome do insumo.');if(custoUnit<0)return alert('Informe um custo unitário válido.');
    item={id:id(),tipo:'insumo',nome,qtd,un,custoUnitario:custoUnit,custo:qtd*custoUnit};
  }
  bebidaIngredientes.push(item);document.getElementById('bebIngQtd').value='';document.getElementById('bebIngNome').value='';document.getElementById('bebIngCusto').value='';renderBebIngredientes();renderDrinkPreview();
}
function removeBebIngredient(i){bebidaIngredientes=bebidaIngredientes.filter(x=>String(x.id)!==String(i));renderBebIngredientes();renderDrinkPreview();}
function custoDrinkIngredientes(itens=bebidaIngredientes){return itens.reduce((s,x)=>s+bebidaNumero(x.custo),0);}
function renderBebIngredientes(){
  const box=document.getElementById('bebDrinkIngredientes');if(!box)return;
  box.innerHTML=bebidaIngredientes.length?bebidaIngredientes.map(it=>`<div class="drink-ingredient-row"><div><strong>${esc(it.nome)}</strong><small>${it.tipo==='destilado'?'Destilado':'Insumo'}${it.marca?' · '+esc(it.marca):''}</small></div><div><strong>${it.qtd} ${esc(it.un)}</strong><small>Custo ${moedaBebida(it.custo)}</small></div><button type="button" class="drink-remove" onclick="removeBebIngredient('${it.id}')">Excluir</button></div>`).join(''):'<div class="drink-empty">Nenhum ingrediente adicionado à ficha.</div>';
}
function drinkCalculos(dr){
  const custoFicha=custoDrinkIngredientes(dr?.ingredientes||[]),rendimento=Math.max(1,bebidaNumero(dr?.rendimento)||1),custo=custoFicha/rendimento,venda=bebidaNumero(dr?.precoVenda),lucro=venda-custo,margem=venda>0?(lucro/venda)*100:0,alvo=Math.min(99.99,Math.max(0,bebidaNumero(dr?.margemAlvo)||70)),precoSugerido=alvo<100?custo/(1-alvo/100):0;
  return {custoFicha,custo,rendimento,venda,lucro,margem,alvo,precoSugerido};
}
function renderDrinkPreview(){
  const box=document.getElementById('bebDrinkPreview');if(!box)return;const venda=bebidaNumero(document.getElementById('bebDrinkVenda')?.value),alvo=Math.min(99.99,Math.max(0,bebidaNumero(document.getElementById('bebDrinkMargemAlvo')?.value)||70)),rendimento=Math.max(1,bebidaNumero(document.getElementById('bebDrinkRendimento')?.value)||1),custoFicha=custoDrinkIngredientes(),custo=custoFicha/rendimento,lucro=venda-custo,margem=venda>0?lucro/venda*100:0,precoSugerido=alvo<100?custo/(1-alvo/100):0;
  box.innerHTML=`<div><span>Custo por drink</span><strong>${moedaBebida(custo)}</strong><small style="display:block;color:#7b8492;margin-top:4px">Ficha: ${moedaBebida(custoFicha)} · ${rendimento} un.</small></div><div><span>Preço de venda</span><strong>${moedaBebida(venda)}</strong></div><div><span>Lucro bruto</span><strong class="${lucro>=0?'profit-positive':'profit-negative'}">${moedaBebida(lucro)}</strong></div><div><span>Margem</span><strong class="${margem>=0?'profit-positive':'profit-negative'}">${margem.toFixed(2).replace('.',',')}%</strong></div><div class="drink-suggested-price"><span>Preço sugerido</span><strong>${moedaBebida(precoSugerido)}</strong><small>para margem de ${alvo.toFixed(2).replace('.',',')}%</small><button type="button" class="secondary" onclick="usarPrecoSugerido()">Usar preço sugerido</button></div>`;
}
function usarPrecoSugerido(){const alvo=Math.min(99.99,Math.max(0,bebidaNumero(document.getElementById('bebDrinkMargemAlvo')?.value)||70)),rendimento=Math.max(1,bebidaNumero(document.getElementById('bebDrinkRendimento')?.value)||1),custo=custoDrinkIngredientes()/rendimento,preco=alvo<100?custo/(1-alvo/100):0;const campo=document.getElementById('bebDrinkVenda');if(campo&&preco>0){campo.value=preco.toFixed(2);renderDrinkPreview();}}
function saveDrink(){
  if(!canOperateStock()){denyOperate();return;}
  const nome=(document.getElementById('bebDrinkNome').value||'').trim(),categoria=document.getElementById('bebDrinkCategoria').value,precoVenda=bebidaNumero(document.getElementById('bebDrinkVenda').value),margemAlvo=Math.min(99.99,Math.max(0,bebidaNumero(document.getElementById('bebDrinkMargemAlvo').value)||70)),rendimento=Math.max(1,bebidaNumero(document.getElementById('bebDrinkRendimento').value)||1),descricao=(document.getElementById('bebDrinkDescricao').value||'').trim();
  if(!nome)return alert('Informe o nome do drink.');if(!bebidaIngredientes.length)return alert('Adicione pelo menos um ingrediente.');if(precoVenda<=0)return alert('Informe o preço de venda.');
  const dados={nome,categoria,precoVenda,margemAlvo,rendimento,descricao,ingredientes:bebidaIngredientes.map(x=>({...x})),atualizadoEm:new Date().toISOString()};
  if(editingDrinkId){const dr=db.drinks.find(x=>String(x.id)===String(editingDrinkId));if(dr)Object.assign(dr,dados);registrarAuditoria('Bebidas','Editou ficha técnica',nome);}else{db.drinks.unshift({id:id(),...dados,criadoEm:new Date().toISOString()});registrarAuditoria('Bebidas','Cadastrou ficha técnica',nome);}
  cancelDrinkEdit(true);save();
}
function editDrink(i){const dr=db.drinks.find(x=>String(x.id)===String(i));if(!dr)return;editingDrinkId=dr.id;bebidaIngredientes=(dr.ingredientes||[]).map(x=>({...x}));document.getElementById('bebDrinkNome').value=dr.nome||'';document.getElementById('bebDrinkCategoria').value=dr.categoria||'Outro';document.getElementById('bebDrinkVenda').value=dr.precoVenda||'';document.getElementById('bebDrinkMargemAlvo').value=dr.margemAlvo??70;document.getElementById('bebDrinkRendimento').value=dr.rendimento||1;document.getElementById('bebDrinkDescricao').value=dr.descricao||'';document.getElementById('bebDrinkSaveBtn').textContent='💾 Salvar alterações';document.getElementById('bebDrinkCancelBtn').style.display='inline-block';renderBebIngredientes();renderDrinkPreview();document.getElementById('bebDrinkNome').focus();}
function cancelDrinkEdit(silent=false){editingDrinkId=null;bebidaIngredientes=[];['bebDrinkNome','bebDrinkVenda','bebDrinkDescricao'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});const alvo=document.getElementById('bebDrinkMargemAlvo');if(alvo)alvo.value=70;const rend=document.getElementById('bebDrinkRendimento');if(rend)rend.value=1;const btn=document.getElementById('bebDrinkSaveBtn');if(btn)btn.textContent='🍸 Salvar ficha técnica';const cancel=document.getElementById('bebDrinkCancelBtn');if(cancel)cancel.style.display='none';renderBebIngredientes();renderDrinkPreview();if(!silent)renderBebidas();}
function deleteDrink(i){if(!canDelete()){denyDelete();return;}const dr=db.drinks.find(x=>String(x.id)===String(i));if(!dr)return;if(!confirm(`Excluir a ficha técnica de "${dr.nome}"?`))return;db.drinks=db.drinks.filter(x=>String(x.id)!==String(i));registrarAuditoria('Bebidas','Excluiu ficha técnica',dr.nome);save();}
function renderBebidas(){
  renderBebDestSelect();updateBebIngredientFields();updateBebDestCost();
  const dt=document.getElementById('bebDestTable'),ds=db.destilados||[];if(dt)dt.innerHTML=ds.length?`<div class="drink-table-title">Destilados cadastrados</div><div class="drink-mini-table"><div class="drink-mini-head"><span>Destilado</span><span>Volume</span><span>Compra</span><span>Custo/ml</span><span>Ação</span></div>${ds.map(d=>`<div class="drink-mini-row"><span><strong>${esc(d.nome)}</strong><small>${esc(d.marca||d.categoria||'')}</small></span><span>${d.volumeMl} ml</span><span>${moedaBebida(d.preco)}</span><span>${moedaBebida(bebidaCustoMl(d))}</span><span>${canDelete()?`<button class="drink-remove" onclick="deleteDestilado('${d.id}')">Excluir</button>`:'—'}</span></div>`).join('')}</div>`:'<div class="drink-empty">Nenhum destilado cadastrado.</div>';
  const q=(document.getElementById('bebDrinkBusca')?.value||'').toLowerCase().trim(),all=(db.drinks||[]).filter(d=>!q||`${d.nome} ${d.categoria}`.toLowerCase().includes(q));
  const count=document.getElementById('bebDrinksCountLabel');if(count)count.textContent=`${all.length} drink(s)`;
  const dc=document.getElementById('bebDrinksTable');if(dc)dc.innerHTML=all.length?all.map(dr=>{const c=drinkCalculos(dr);return `<article class="drink-card"><div class="drink-card-top"><div><h4>${esc(dr.nome)}</h4><span>${esc(dr.categoria||'Outro')} · Rendimento: ${dr.rendimento||1}</span></div><span class="drink-margin-badge">Margem ${c.margem.toFixed(2).replace('.',',')}%</span></div><div class="drink-card-desc">${esc(dr.descricao||'Sem descrição.')}</div><div class="drink-card-metrics"><div><small>Custo</small><strong>${moedaBebida(c.custo)}</strong></div><div><small>Venda</small><strong>${moedaBebida(c.venda)}</strong></div><div><small>Lucro</small><strong class="${c.lucro>=0?'profit-positive':'profit-negative'}">${moedaBebida(c.lucro)}</strong></div><div><small>Ingredientes</small><strong>${(dr.ingredientes||[]).length}</strong></div></div><div class="drink-card-ingredients">${(dr.ingredientes||[]).map(it=>`<span>${esc(it.nome)} · ${it.qtd} ${esc(it.un)}</span>`).join('')}</div><div class="drink-card-actions"><button class="secondary" onclick="editDrink('${dr.id}')">✏️ Editar</button>${canDelete()?`<button class="drink-remove" onclick="deleteDrink('${dr.id}')">🗑️ Excluir</button>`:''}</div></article>`}).join(''):'<div class="drink-empty">Nenhuma ficha técnica cadastrada.</div>';
  const s1=document.getElementById('bebidasDestiladosCount'),s2=document.getElementById('bebidasDrinksCount'),s3=document.getElementById('bebidasMargemMedia');if(s1)s1.textContent=ds.length;if(s2)s2.textContent=(db.drinks||[]).length;const marg=(db.drinks||[]).map(dr=>drinkCalculos(dr).margem);if(s3)s3.textContent=(marg.length?marg.reduce((a,b)=>a+b,0)/marg.length:0).toFixed(2).replace('.',',')+'%';
}

function deleteAllMovements(){
 if(!isAdmin())return denyDelete();
 if(!Array.isArray(db.mov)||!db.mov.length)return alert("Não há entradas ou saídas para apagar.");
 const qtd=db.mov.length;
 if(!confirm("ATENÇÃO!\n\nTodas as entradas e saídas serão apagadas e seus efeitos serão revertidos no estoque.\n\nAs requisições que tiveram movimentações apagadas voltarão para Pendente.\n\nTotal de movimentações: "+qtd+"\n\nEsta ação não pode ser desfeita."))return;
 const reqIds=[...new Set(db.mov.filter(isReqMovement).map(m=>m.reqId).filter(Boolean))];
 db.mov.slice().forEach(reverseMovement);
 reqIds.forEach(reopenRequisition);
 db.mov=[];
 registrarAuditoria("Sistema","Apagou todas as movimentações",`Total: ${qtd}`);
 save(); render(); alert("Todas as entradas e saídas foram apagadas e o estoque foi ajustado.");
}

function resetData(){
 if(!canDelete()){denyDelete();return;}
 if(!confirm("Isso apagará todos os produtos, requisições, movimentações e anotações. O usuário administrador principal será mantido. Continuar?"))return;
 const admin=db.users.find(u=>u.login==="admin")||{id:id(),nome:"Administrador",login:"admin",senha:"1234",perfil:"Administrador"};
 db={produtos:[],req:[],mov:[],users:[admin],anotacoes:[],comprasEspeciais:[],auditoria:[],inventarios:[],emprestimos:[],destilados:[],drinks:[],categorias:[...CATEGORIAS_PADRAO]};
 db.auditoria.unshift({id:id(),dataHora:new Date().toISOString(),data:hojeISO(),usuario:usuarioAtualNome(),tipo:"Sistema",acao:"Resetou dados",detalhes:"Todos os dados operacionais foram removidos."});
 save();
}
document.querySelectorAll("nav button").forEach(b=>{ b.setAttribute("type","button"); b.onclick=()=>{
  if(b.dataset.adminOnly==="1" && !isAdmin()){ alert("🔒 Acesso restrito ao Administrador."); return; }
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  const view=document.getElementById(b.dataset.view);
  if(!view)return;
  view.classList.add("active");
  document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  if(b.dataset.view==="relatorios" && !isAdmin()){return;}
  if(b.dataset.view==="auditoria" && !isAdmin()){return;}
}; });
render();
console.info("O Estoquista iniciado: dados locais carregados com sucesso.");
if(document.getElementById("mData")) document.getElementById("mData").value=new Date().toISOString().slice(0,10);
if(document.getElementById("eData")) document.getElementById("eData").value=hojeISO();
updateEmprestimoUnit();renderEmprestimoDraft();
if(document.getElementById("inventarioData")) document.getElementById("inventarioData").value=hojeISO();
if(document.getElementById("relatorioMes")) document.getElementById("relatorioMes").value=mesAtualISO();

document.addEventListener("DOMContentLoaded",async function(){
  try{
    ensureAdmin();
    if(document.getElementById("noteData"))document.getElementById("noteData").value=hojeISO();
    if(document.getElementById("bebDestVolume")){
      ["bebDestVolume","bebDestPreco"].forEach(x=>document.getElementById(x).addEventListener("input",updateBebDestCost));
      updateBebDestCost();
      updateBebIngredientFields();
      renderBebIngredientes();
      renderDrinkPreview();
    }
    const logged=await checkLogin();
    if(logged){
      setInterval(refreshCloudSilently,30000);
    }
  }catch(e){console.error("Falha ao iniciar O Estoquista:",e);}
});


/* =========================================================
   MELHORIAS VISUAIS — LOGIN E IMPRESSÃO DO INVENTÁRIO
   ========================================================= */
function toggleLoginPassword(){
  const input=document.getElementById("loginPass");
  const button=document.querySelector(".password-toggle");
  if(!input)return;
  const mostrar=input.type==="password";
  input.type=mostrar?"text":"password";
  if(button){
    button.setAttribute("aria-label",mostrar?"Ocultar senha":"Mostrar senha");
    button.setAttribute("title",mostrar?"Ocultar senha":"Mostrar senha");
  }
}

function atualizarCategoriasImpressao(){
  const select=document.getElementById("inventarioCategoriaImpressao");
  if(!select || !Array.isArray(db?.produtos))return;
  const atual=select.value;
  const categorias=[...new Set(db.produtos.map(p=>String(p.categoria||"Sem categoria").trim()||"Sem categoria"))]
    .sort((a,b)=>a.localeCompare(b,"pt-BR"));
  select.innerHTML='<option value="">Todas as categorias</option>'+
    categorias.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if(categorias.includes(atual))select.value=atual;
}

function imprimirInventarioCategoria(){
  const select=document.getElementById("inventarioCategoriaImpressao");
  const categoria=select?.value||"";
  imprimirInventarioProfissional(categoria);
}

function imprimirInventarioProfissional(categoriaFiltro=""){
  const data=document.getElementById("inventarioData")?.value||hojeISO();
  const dataBR=data.split("-").reverse().join("/");
  const agora=new Date();
  const hora=agora.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  const lista=(Array.isArray(db?.produtos)?db.produtos:[])
    .filter(p=>{
      const cat=String(p.categoria||"Sem categoria").trim()||"Sem categoria";
      return !categoriaFiltro || cat===categoriaFiltro;
    })
    .slice()
    .sort((a,b)=>String(a.nome||"").localeCompare(String(b.nome||""),"pt-BR"));

  if(!lista.length){
    alert(categoriaFiltro
      ? `Não há produtos cadastrados na categoria "${categoriaFiltro}".`
      : "Não há produtos cadastrados para impressão.");
    return;
  }

  const old=document.getElementById("inventarioPrintSheet");
  if(old)old.remove();

  const escPrint=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
  const qtd=v=>{
    const n=Number(v);
    if(!Number.isFinite(n))return "";
    return Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,"").replace(/\.$/,"").replace(".",",");
  };

  const rows=lista.map(p=>{
    const input=document.querySelector(`.inventory-count-input[data-prod-id="${CSS.escape(String(p.id))}"]`);
    const contagem=input?.value??"";
    const sistema=Number(p.estoque||0);
    const diferenca=contagem===""?"":Number(contagem)-sistema;
    const categoria=String(p.categoria||"Sem categoria").trim()||"Sem categoria";
    return `<tr>
      <td class="print-product"><strong>${escPrint(p.nome)}</strong><small>${escPrint(p.cod||categoria)}</small></td>
      <td class="print-center">${qtd(sistema)}</td>
      <td class="print-count">${contagem===""?"":escPrint(contagem)}</td>
      <td class="print-center">${diferenca===""?"":(diferenca>0?"+":"")+qtd(diferenca)}</td>
    </tr>`;
  }).join("");

  const sheet=document.createElement("div");
  sheet.id="inventarioPrintSheet";
  sheet.innerHTML=`
    <div class="print-sheet-header">
      <div class="print-brand">O ESTOQUISTA</div>
      <div class="print-title">CONTAGEM DE INVENTÁRIO</div>
      <div class="print-meta">
        <span><b>Categoria:</b> ${escPrint(categoriaFiltro||"Todas as categorias")}</span>
        <span><b>Data:</b> ${escPrint(dataBR)}</span>
        <span><b>Hora da impressão:</b> ${escPrint(hora)}</span>
        <span><b>Responsável:</b> ${escPrint(usuarioAtualNome())}</span>
      </div>
    </div>
    <div class="print-instructions">
      <b>Conferência de estoque</b>
      <span>Compare o estoque do sistema com a contagem física e registre a diferença.</span>
    </div>
    <table class="print-inventory-table">
      <thead>
        <tr>
          <th class="col-product">PRODUTO</th>
          <th class="col-system">ESTOQUE<br>DO SISTEMA</th>
          <th class="col-count">CONTAGEM<br>FÍSICA</th>
          <th class="col-diff">DIFERENÇA</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="print-sheet-footer">
      <div>Documento de conferência de estoque — O Estoquista</div>
      <div class="print-signatures">
        <span>Responsável: ____________________________________</span>
        <span>Conferente: ____________________________________</span>
      </div>
    </div>`;

  document.body.appendChild(sheet);

  if(categoriaFiltro){
    sheet.classList.add("print-single-page");
    const qtdItens=lista.length;
    if(qtdItens>18){
      const escala=Math.max(0.60,Math.min(1,18/qtdItens));
      sheet.style.zoom=String(escala);
    }
  }

  document.body.classList.add("imprimindo-inventario");
  setTimeout(()=>{
    window.print();
    setTimeout(()=>{
      document.body.classList.remove("imprimindo-inventario");
      sheet.remove();
    },700);
  },180);
}

(function(){
  function initImpressaoInventario(){
    atualizarCategoriasImpressao();
  }
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",initImpressaoInventario);
  }else{
    initImpressaoInventario();
  }
  setInterval(atualizarCategoriasImpressao,2000);
})();
