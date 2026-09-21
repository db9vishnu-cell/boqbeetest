import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

const pool = new Pool({ connectionString: DATABASE_URL, max: 15, idleTimeoutMillis: 30000 });
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

const MATERIALS = ['MR Ply', 'BWP Ply', 'Marine Board'];
const FINISHES = ['Laminate', 'Acrylic', 'PU Paint Finish', 'Membrane', 'Veneer'];
const CABINET_TYPES = ['Base Cabinet', 'Wall Cabinet', 'Tall Unit', 'Wardrobe', 'TV Unit', 'Loft'];
const HARDWARE = [
  {id:'h1',category:'Hinges',name:'Soft Close Hinge',brand:'Standard',unit:'Nos',rate:0},
  {id:'h2',category:'Hinges',name:'Blum Clip Top Hinge',brand:'Blum',unit:'Nos',rate:0},
  {id:'h3',category:'Drawer Channels',name:'Soft Close Drawer Channel 450mm',brand:'Standard',unit:'Pair',rate:0},
  {id:'h4',category:'Drawer Systems',name:'Tandem Drawer Box 500mm',brand:'Blum',unit:'Set',rate:0},
  {id:'h5',category:'Handles',name:'Handle',brand:'Standard',unit:'Nos',rate:0},
  {id:'h6',category:'Lift Up',name:'Lift-Up Stay',brand:'Standard',unit:'Pair',rate:0},
  {id:'h7',category:'Pull Outs',name:'Bottle Pull Out',brand:'Standard',unit:'Set',rate:0},
  {id:'h8',category:'Accessories',name:'Shelf Support',brand:'Standard',unit:'Nos',rate:0},
  {id:'h9',category:'Accessories',name:'Magnetic Catch',brand:'Standard',unit:'Nos',rate:0}
];
const PANEL_LABELS = {
  dashboard:'Dashboard',clients:'Clients',projects:'Projects',accounts:'Accounts & Payments',boq:'BOQ Builder',
  rates:'Rate Master',materials:'Material Master',finishes:'Finish Master',cabinets:'Cabinet Master',
  quotation:'Quotation',settings:'Settings',hardware:'Hardware Master'
};

function buildDefaultRates() {
  const formulas = {
    'Base Cabinet':{unit:'Rft',formula:'width/304.8'},
    'Wall Cabinet':{unit:'Rft',formula:'width/304.8'},
    'Tall Unit':{unit:'Nos',formula:'qty'},
    'Wardrobe':{unit:'Sqft',formula:'width*height/92903.04'},
    'TV Unit':{unit:'Sqft',formula:'width*height/92903.04'},
    'Loft':{unit:'Sqft',formula:'width*depth/92903.04'}
  };
  const arr=[]; let n=1;
  for (const type of CABINET_TYPES) for (const finish of FINISHES) for (const materialGrade of MATERIALS) {
    arr.push({id:`r${n++}`,type,finish,materialGrade,unit:formulas[type].unit,formula:formulas[type].formula,rate:0});
  }
  return arr;
}
function defaultCompany() {
  return {
    name:'Your Company Name', address:'Your Company Address', phone:'', email:'', gst:'', logo:'', logoScale:64,
    showName:true, logoX:0, logoY:0, detailsX:0, detailsY:0,
    terms:[
      'Quantities are based on the dimensions entered in the BOQ Builder and may be reconciled with actual site measurements.',
      'Payment terms and project conditions may be specified by the company before final issue.',
      'Any addition or variation to the scope of work will be billed under a separate Change Order approval.'
    ]
  };
}
function defaultState() {
  return {
    clients:[{id:'c1',name:'Demo Client',company:'',phone:'',email:'',address:''}],
    projects:[{id:'p1',clientId:'c1',name:'Demo Residence',type:'Residential',address:'Bengaluru',status:'Estimation',rooms:['Kitchen','Master Bedroom','Living Room'],boqGSTRate:0,boqDiscountRate:0,boqApprovalStatus:'Draft'}],
    boq:[], rates:buildDefaultRates(), materials:[...MATERIALS], finishes:[...FINISHES], cabinetTypes:[...CABINET_TYPES], hardware:[...HARDWARE],
    boqHardware:[], boqHardwareStandalone:[], projectAccounts:[], selectedProjectId:'p1', selectedRoom:'Kitchen', boqProjectSearch:'', company:defaultCompany(),
    boqPrefix:'BOQ', boqNext:1, currency:'₹', projectArea:''
  };
}

function scryptHash(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('base64url');
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$16384$8$1$${salt}$${Buffer.from(derivedKey).toString('base64url')}`);
    });
  });
}
function scryptVerify(password, encoded) {
  return new Promise((resolve, reject) => {
    try {
      const [, n, r, p, salt, expected] = String(encoded).split('$');
      crypto.scrypt(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p) }, (err, derivedKey) => {
        if (err) return reject(err);
        const a = Buffer.from(derivedKey).toString('base64url');
        resolve(a.length === expected.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(expected)));
      });
    } catch { resolve(false); }
  });
}
function sign(user) { return jwt.sign({ sub:user.id, role:user.role }, JWT_SECRET, { expiresIn:'12h' }); }
function sanitizeUser(u) { return { id:u.id, username:u.username, displayName:u.display_name, role:u.role, active:u.active, permissions:u.permissions || {} }; }
function reqUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try { return jwt.verify(header.slice(7), JWT_SECRET); } catch { return null; }
}
async function getUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  return rows[0] || null;
}
function isAdmin(user) { return user?.role === 'superadmin'; }
function hasPermission(user, view) { return isAdmin(user) || !!(user?.permissions || {})[view]; }
function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
function changed(a,b,key){ return JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]); }

async function stateRow() {
  const { rows } = await pool.query('SELECT state, version FROM app_state WHERE id=1');
  if (!rows[0]) throw new Error('Application state is not initialized');
  return rows[0];
}
async function publicStateFor(user) {
  const row = await stateRow();
  const state = deepClone(row.state);
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at, id');
  // Keep user directory in frontend state but never ship password hashes.
  state.users = rows.map(sanitizeUser);
  state.currentUserId = user.id;
  return { state, version:Number(row.version) };
}

function enforceUpdate(current, incoming, user) {
  const next = deepClone(current);
  const coreGated = {
    clients:'clients', projects:'projects', projectAccounts:'accounts',
    boq:'boq', boqHardware:'boq', boqHardwareStandalone:'boq', selectedProjectId:'boq', selectedRoom:'boq', boqProjectSearch:'boq', projectArea:'boq',
    currency:'settings'
  };
  const masterGated = { rates:'rates', materials:'materials', finishes:'finishes', cabinetTypes:'cabinets', hardware:'hardware', company:'settings', boqPrefix:'settings', boqNext:'settings' };
  for (const [key,perm] of Object.entries(coreGated)) if (key in incoming && hasPermission(user,perm)) next[key] = incoming[key];
  for (const [key,perm] of Object.entries(masterGated)) if (key in incoming && hasPermission(user,perm)) next[key] = incoming[key];

  // Users are always maintained through /api/users so password hashes are never client controlled.
  // Normal users may submit/revert their own BOQ, but cannot approve/reject from the client.
  const oldProjects = current.projects || [], newProjects = next.projects || [];
  if (!isAdmin(user)) {
    const oldMap = Object.fromEntries(oldProjects.map(p=>[p.id,p]));
    next.projects = newProjects.map(p=>{
      const old = oldMap[p.id];
      if (!old) return p;
      const out = {...p};
      const oldStatus = old.boqApprovalStatus || 'Draft';
      const newStatus = p.boqApprovalStatus || 'Draft';
      if (newStatus === 'Approved' || newStatus === 'Rejected') {
        out.boqApprovalStatus = oldStatus;
        out.boqApprovedBy = old.boqApprovedBy || null;
        out.boqApprovedAt = old.boqApprovedAt || null;
        out.boqApprovalNote = old.boqApprovalNote || '';
      }
      return out;
    });
  }
  return next;
}

async function initDb() {
  const schema = fs.readFileSync(path.join(root,'db','schema.sql'),'utf8');
  await pool.query(schema);
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (count.rows[0].n === 0) {
    const defaults = [
      {id:'u-admin',username:'superadmin',displayName:'Super Admin',role:'superadmin',active:true,permissions:{} , password:'Admin@123'},
      {id:'u-user1',username:'user1',displayName:'Normal User 1',role:'user',active:true,permissions:{dashboard:true,clients:true,projects:true,boq:true,quotation:true},password:'User1@123'},
      {id:'u-user2',username:'user2',displayName:'Normal User 2',role:'user',active:true,permissions:{dashboard:true,clients:true,projects:true,boq:true,quotation:true},password:'User2@123'},
      {id:'u-user3',username:'user3',displayName:'Normal User 3',role:'user',active:true,permissions:{dashboard:true,clients:true,projects:true,boq:true,quotation:true},password:'User3@123'}
    ];
    for (const u of defaults) {
      await pool.query(`INSERT INTO users(id,username,display_name,password_hash,role,active,permissions) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [u.id,u.username,u.displayName,await scryptHash(u.password),u.role,u.active,JSON.stringify(u.permissions)]);
    }
    await pool.query('INSERT INTO app_state(id,state,version) VALUES(1,$1,1) ON CONFLICT (id) DO NOTHING',[JSON.stringify(defaultState())]);
  } else {
    const s = await pool.query('SELECT 1 FROM app_state WHERE id=1');
    if (!s.rows[0]) await pool.query('INSERT INTO app_state(id,state,version) VALUES(1,$1,1)',[JSON.stringify(defaultState())]);
  }
}

async function auth(req,res,next){
  const tokenUser=reqUser(req); if(!tokenUser) return res.status(401).json({error:'Authentication required'});
  const user=await getUser(tokenUser.sub); if(!user || !user.active) return res.status(401).json({error:'User is inactive or missing'});
  const issuedAt=Number(tokenUser.iat||0);
  const changedAt=Math.floor(new Date(user.updated_at).getTime()/1000);
  if(changedAt>issuedAt) return res.status(401).json({error:'Your account was changed. Please log in again.'});
  req.user=user; next();
}
function requireAdmin(req,res,next){ if(!isAdmin(req.user)) return res.status(403).json({error:'Super Admin access required'}); next(); }

app.get('/api/health', async (_req,res)=>res.json({ok:true,service:'BOQBEE',version:'2.0.0'}));
app.post('/api/auth/login', async (req,res)=>{
  const username=String(req.body?.username||'').trim().toLowerCase(); const password=String(req.body?.password||'');
  const {rows}=await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)',[username]); const u=rows[0];
  if(!u) return res.status(401).json({error:'Invalid username or password.'});
  if(!u.active) return res.status(403).json({error:'This user is inactive.'});
  if(!(await scryptVerify(password,u.password_hash))) return res.status(401).json({error:'Invalid username or password.'});
  const {state,version}=await publicStateFor(u);
  res.json({token:sign(u),user:sanitizeUser(u),state,version});
});
app.get('/api/auth/me', auth, async (req,res)=>{ const {state,version}=await publicStateFor(req.user); res.json({user:sanitizeUser(req.user),state,version}); });

app.get('/api/state',auth,async(req,res)=>{ const {state,version}=await publicStateFor(req.user); res.json({state,version}); });
app.put('/api/state',auth,async(req,res)=>{
  const incoming=req.body?.state; const expected=Number(req.body?.expectedVersion);
  if(!incoming || !Number.isFinite(expected)) return res.status(400).json({error:'state and expectedVersion are required'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT state,version FROM app_state WHERE id=1 FOR UPDATE');
    const current=rows[0];
    if(Number(current.version)!==expected){ await client.query('ROLLBACK'); return res.status(409).json({error:'State changed by another user',version:Number(current.version),state:current.state}); }
    const merged=enforceUpdate(current.state,incoming,req.user);
    const newVersion=Number(current.version)+1;
    await client.query('INSERT INTO state_backups(version,state,created_by) VALUES($1,$2,$3)',[newVersion,current.state,req.user.id]);
    await client.query('UPDATE app_state SET state=$1,version=$2,updated_at=now() WHERE id=1',[JSON.stringify(merged),newVersion]);
    await client.query('COMMIT');
    const out=await publicStateFor(req.user); res.json(out);
  }catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:e.message}); }finally{client.release();}
});

app.get('/api/users',auth,requireAdmin,async(_req,res)=>{ const {rows}=await pool.query('SELECT * FROM users ORDER BY created_at,id'); res.json({users:rows.map(sanitizeUser)}); });
app.post('/api/users',auth,requireAdmin,async(req,res)=>{
  const username=String(req.body?.username||'').trim().toLowerCase(); const password=String(req.body?.password||'');
  const displayName=String(req.body?.displayName||username).trim()||username; const active=req.body?.active!==false;
  const permissions=req.body?.permissions||{};
  if(!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({error:'Invalid User ID'});
  if(password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  try{
    const id='u-'+crypto.randomBytes(8).toString('hex');
    const ph=await scryptHash(password);
    await pool.query('INSERT INTO users(id,username,display_name,password_hash,role,active,permissions) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,username,displayName,ph,'user',active,JSON.stringify(permissions)]);
    const {rows}=await pool.query('SELECT * FROM users WHERE id=$1',[id]); res.status(201).json({user:sanitizeUser(rows[0])});
  }catch(e){ res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'That User ID is already in use.':e.message}); }
});
app.patch('/api/users/:id',auth,requireAdmin,async(req,res)=>{
  const id=req.params.id; const target=await getUser(id); if(!target) return res.status(404).json({error:'User not found'});
  const username=String(req.body?.username||target.username).trim().toLowerCase(); const displayName=String(req.body?.displayName||target.display_name).trim()||username;
  const active=target.role==='superadmin'?true:req.body?.active!==false; const permissions=target.role==='superadmin'?{}:(req.body?.permissions||{}); const password=String(req.body?.password||'');
  try{
    let passwordHash=target.password_hash; if(password){ if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'}); passwordHash=await scryptHash(password); }
    await pool.query('UPDATE users SET username=$1,display_name=$2,active=$3,permissions=$4,password_hash=$5,updated_at=now() WHERE id=$6',[username,displayName,active,JSON.stringify(permissions),passwordHash,id]);
    const updated=await getUser(id); res.json({user:sanitizeUser(updated)});
  }catch(e){ res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'That User ID is already in use.':e.message}); }
});
app.delete('/api/users/:id',auth,requireAdmin,async(req,res)=>{
  const target=await getUser(req.params.id); if(!target) return res.status(404).json({error:'User not found'});
  if(target.role==='superadmin') return res.status(400).json({error:'The Super Admin account cannot be removed.'});
  await pool.query('DELETE FROM users WHERE id=$1',[target.id]); res.status(204).end();
});

app.post('/api/admin/backup',auth,requireAdmin,async(req,res)=>{
  const row=await stateRow(); const backup=await pool.query('INSERT INTO state_backups(version,state,created_by) VALUES($1,$2,$3) RETURNING id,version,created_at',[row.version,row.state,req.user.id]); res.json(backup.rows[0]);
});
app.get('/api/admin/backups',auth,requireAdmin,async(_req,res)=>{ const {rows}=await pool.query('SELECT id,version,created_at,created_by FROM state_backups ORDER BY created_at DESC LIMIT 100'); res.json({backups:rows}); });
app.get('/api/admin/backup/:id',auth,requireAdmin,async(req,res)=>{ const {rows}=await pool.query('SELECT id,version,state,created_at FROM state_backups WHERE id=$1',[req.params.id]); if(!rows[0])return res.status(404).json({error:'Backup not found'}); res.setHeader('Content-Disposition',`attachment; filename="boqbee-backup-${rows[0].id}.json"`); res.json(rows[0]); });

app.use(express.static(publicDir, { maxAge: '1h' }));
app.get(/.*/, (_req,res)=>res.sendFile(path.join(publicDir,'index.html')));

initDb().then(()=>app.listen(PORT,()=>console.log(`BOQBEE v2 running on http://localhost:${PORT}`))).catch(err=>{console.error(err); process.exit(1);});
