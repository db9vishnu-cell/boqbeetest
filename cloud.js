(() => {
  const TOKEN_KEY = 'boqbee_access_token_v2';
  const STATE_KEY = 'interior_boq_mvp_v1';
  let cloudVersion = null;
  let saveTimer = null;
  let saveInFlight = false;
  let saveQueued = false;
  let suppressMirror = false;
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const nativeGetItem = Storage.prototype.getItem;

  async function api(path, options={}) {
    const headers = {'Content-Type':'application/json', ...(options.headers||{})};
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, {...options, headers});
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function mirrorState() {
    try {
      suppressMirror = true;
      nativeSetItem.call(localStorage, STATE_KEY, JSON.stringify(window.db || {}));
    } finally { suppressMirror = false; }
  }

  async function refreshFromServer({showConflict=false}={}) {
    const data = await api('/api/state');
    window.db = data.state;
    cloudVersion = Number(data.version);
    mirrorState();
    if (typeof window.applyAccessV6 === 'function') window.applyAccessV6();
    if (typeof window.renderAll === 'function') window.renderAll();
    if (showConflict) alert('BOQBEE data was changed by another user. The latest server data has been loaded.');
    return data;
  }

  async function flushSave() {
    if (!sessionStorage.getItem(TOKEN_KEY) || cloudVersion === null || !window.db) return;
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;
    try {
      const snapshot = JSON.parse(JSON.stringify(window.db));
      const data = await api('/api/state', {
        method:'PUT',
        body:JSON.stringify({state:snapshot, expectedVersion:cloudVersion})
      });
      cloudVersion = Number(data.version);
      window.db = data.state;
      mirrorState();
    } catch (err) {
      if (err.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        alert('Your BOQBEE session has expired. Please log in again.');
        location.reload();
      } else if (err.status === 409) {
        if (err.data?.state) {
          window.db = err.data.state;
          cloudVersion = Number(err.data.version);
          window.db.currentUserId = (window.db.users||[]).find(u=>u.username===JSON.parse(sessionStorage.getItem('boqbee_user_v2')||'null')?.username)?.id || window.db.currentUserId;
          mirrorState();
          if (typeof window.applyAccessV6 === 'function') window.applyAccessV6();
          if (typeof window.renderAll === 'function') window.renderAll();
        }
        alert('Another user saved changes while you were editing. Your unsaved change was not overwritten onto the server. Please review the latest data and save again.');
      } else {
        console.error('BOQBEE cloud save failed', err);
        alert(`Cloud save failed: ${err.message}`);
      }
    } finally {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; queueSave(50); }
    }
  }
  function queueSave(delay=300) {
    if (!sessionStorage.getItem(TOKEN_KEY)) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, delay);
  }

  // Redirect all existing save paths in the legacy V13 UI into the central API.
  window.save = function saveCloud(){
    if (typeof window.renderAll === 'function') window.renderAll();
    queueSave();
  };

  // Some legacy actions write directly to localStorage. Mirror those writes into the API too.
  Storage.prototype.setItem = function(key, value) {
    nativeSetItem.call(this, key, value);
    if (this === localStorage && key === STATE_KEY && !suppressMirror && sessionStorage.getItem(TOKEN_KEY)) queueSave();
  };
  Storage.prototype.removeItem = function(key) {
    nativeRemoveItem.call(this, key);
  };

  window.loginV6 = async function loginCloud(){
    const username = document.getElementById('loginUsernameV6')?.value.trim().toLowerCase() || '';
    const password = document.getElementById('loginPasswordV6')?.value || '';
    const err = document.getElementById('loginErrorV6');
    const btn = document.getElementById('loginBtnV6');
    if (err) err.style.display='none'; if (btn) btn.disabled=true;
    try {
      const data = await api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})});
      sessionStorage.setItem(TOKEN_KEY,data.token);
      sessionStorage.setItem('boqbee_user_v2',JSON.stringify(data.user));
      cloudVersion = Number(data.version);
      window.db = data.state;
      mirrorState();
      if (typeof window.applyAccessV6 === 'function') window.applyAccessV6();
      if (typeof window.showView === 'function') window.showView('dashboard');
      if (typeof window.renderAll === 'function') window.renderAll();
    } catch(e) {
      if (err) { err.textContent=e.message || 'Unable to sign in.'; err.style.display='block'; }
    } finally { if (btn) btn.disabled=false; }
  };

  window.logoutV6 = function logoutCloud(){
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('boqbee_user_v2');
    clearTimeout(saveTimer); saveTimer=null; cloudVersion=null;
    if (typeof nativeRemoveItem === 'function') nativeRemoveItem.call(localStorage, STATE_KEY);
    location.reload();
  };

  window.exportData = function exportCloudData(){
    const safe = JSON.parse(JSON.stringify(window.db||{}));
    if (Array.isArray(safe.users)) safe.users = safe.users.map(u=>({...u, passwordHash:undefined}));
    const blob = new Blob([JSON.stringify(safe,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`boqbee-cloud-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  };

  // Server-side user administration. Passwords never enter the browser state or get hashed client-side.
  window.saveNewUserV15 = async function saveNewUserCloud(){
    if (!window.isSuperAdminV6?.()) return;
    const displayName=document.getElementById('newDisplayV15')?.value.trim()||'';
    const username=document.getElementById('newUsernameV15')?.value.trim().toLowerCase()||'';
    const password=document.getElementById('newPasswordV15')?.value||'';
    const active=document.getElementById('newActiveV15')?.value==='1';
    if(!username)return alert('Enter a User ID / Username.');
    if(!/^[a-z0-9._-]{3,40}$/.test(username))return alert('User ID can use 3-40 characters: letters, numbers, dot, underscore or hyphen.');
    if(password.length<6)return alert('Password must be at least 6 characters.');
    const permissions={};
    ['dashboard','clients','projects','accounts','boq','rates','materials','finishes','cabinets','quotation','settings','hardware'].forEach(k=>permissions[k]=!!document.getElementById(`newPermV15_${k}`)?.checked);
    try {
      const out=await api('/api/users',{method:'POST',body:JSON.stringify({displayName,username,password,active,permissions})});
      window.db.users=[...(window.db.users||[]),out.user];
      if(typeof window.renderAll==='function')window.renderAll();
      if(typeof window.closeModal==='function')window.closeModal();
      if(typeof window.showView==='function')window.showView('users');
    } catch(e){alert(e.message);}
  };

  window.saveUserV6 = async function saveUserCloud(id){
    if (!window.isSuperAdminV6?.()) return;
    const current=(window.db.users||[]).find(u=>u.id===id); if(!current)return;
    const username=document.getElementById('uUsernameV6')?.value.trim().toLowerCase()||'';
    const displayName=document.getElementById('uDisplayV6')?.value.trim()||current.displayName;
    const active=document.getElementById('uActiveV6')?.value==='1';
    const password=document.getElementById('uPasswordV6')?.value||'';
    if(!/^[a-z0-9._-]{3,40}$/.test(username))return alert('User ID can use 3-40 characters: letters, numbers, dot, underscore or hyphen.');
    if(password && password.length<6)return alert('Password must be at least 6 characters.');
    const permissions={};
    ['dashboard','clients','projects','accounts','boq','rates','materials','finishes','cabinets','quotation','settings','hardware'].forEach(k=>permissions[k]=!!document.getElementById(`permV6_${k}`)?.checked);
    try {
      const out=await api(`/api/users/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({displayName,username,active,password,permissions})});
      window.db.users=(window.db.users||[]).map(u=>u.id===id?out.user:u);
      if(typeof window.renderAll==='function')window.renderAll();
      if(typeof window.closeModal==='function')window.closeModal();
      if(typeof window.showView==='function')window.showView('users');
    } catch(e){alert(e.message);}
  };

  window.removeUserV15 = async function removeUserCloud(id){
    if (!window.isSuperAdminV6?.()) return;
    const u=(window.db.users||[]).find(x=>x.id===id); if(!u)return;
    if(!confirm(`Remove user @${u.username}? Project and BOQ data will be kept.`))return;
    try {
      await api(`/api/users/${encodeURIComponent(id)}`,{method:'DELETE'});
      window.db.users=(window.db.users||[]).filter(x=>x.id!==id);
      if(typeof window.renderAll==='function')window.renderAll();
      if(typeof window.showView==='function')window.showView('users');
    } catch(e){alert(e.message);}
  };

  async function bootCloudSession(){
    const token=sessionStorage.getItem(TOKEN_KEY); if(!token) return;
    try {
      const data=await api('/api/auth/me');
      cloudVersion=Number(data.version);
      window.db=data.state;
      mirrorState();
      if(typeof window.applyAccessV6==='function')window.applyAccessV6();
      if(typeof window.renderAll==='function')window.renderAll();
      if(typeof window.showView==='function')window.showView('dashboard');
    } catch(e) {
      sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem('boqbee_user_v2');
    }
  }

  window.BOQBEE_CLOUD = { api, refreshFromServer, queueSave, flushSave };
  window.addEventListener('beforeunload',()=>{ if(sessionStorage.getItem(TOKEN_KEY)) flushSave(); });
  window.addEventListener('load',()=>{ setTimeout(bootCloudSession,50); });
})();
