/**
 * FUSION IMS v2.1 — Backend Server
 * Node.js + Express + SQLite + Anthropic Claude AI
 * 
 * FIXES: 
 *   - All API routes return JSON (never HTML)
 *   - Login wrapped in try-catch
 *   - Global error handler
 *   - Database columns checked before query
 * 
 * NEW:
 *   - Job Order: Supervisor create/close + Technician accept/turnover/assistant
 *   - Job Comments with AI achievement capture
 *   - Multi-technician accomplishment tracking
 *   - Shift-based assignment tracking
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

let Database;
try { Database = require('better-sqlite3'); }
catch(e) { console.error('better-sqlite3 not installed. Run: npm install'); process.exit(1); }

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); }
catch(e) { console.warn('Anthropic SDK not installed — AI features disabled'); }

const app = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fusion-ims-secret-key-2025';
const API_KEY    = process.env.ANTHROPIC_API_KEY || '';

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Ensure db directory exists
const fs = require('fs');
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Serve frontend ONLY for non-API routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    express.static(path.join(__dirname, 'public'))(req, res, next);
  } else {
    next();
  }
});

// ── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(dbDir, 'fusion.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // OFF to allow migrations

function safeExec(sql) {
  try { db.exec(sql); } catch(e) { console.warn('[DB WARN]', e.message.slice(0,80)); }
}

function initDB() {
  // USERS
  safeExec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'technician',
    department TEXT, nc_level TEXT, employee_id TEXT,
    performance_score REAL DEFAULT 85, jos_closed INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, last_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Migrate ALL potentially missing columns in users table
  [
    'attendance_rate REAL DEFAULT 100',
    'shift TEXT DEFAULT "Day"',
    'jos_closed INTEGER DEFAULT 0',
    'nc_level TEXT',
    'employee_id TEXT',
    'performance_score REAL DEFAULT 85',
    'last_login TEXT',
    'is_active INTEGER DEFAULT 1'
  ].forEach(col => { safeExec(`ALTER TABLE users ADD COLUMN ${col}`); });

  // JOB ORDERS
  // ── JOB ORDERS — Based on DAESANG RICOR / FUSION IMS Official Form ──────────
  safeExec(`CREATE TABLE IF NOT EXISTS job_orders (
    id TEXT PRIMARY KEY,
    job_number TEXT UNIQUE,

    -- PART I: REQUESTOR SECTION
    requestor_name TEXT,
    plant_section TEXT,
    equipment_description TEXT NOT NULL,
    equipment_number TEXT,
    description_of_defect TEXT NOT NULL,
    date_created TEXT DEFAULT (datetime('now')),
    maintenance_incharge TEXT,
    required_plant_shutdown INTEGER DEFAULT 0,
    approved_by_name TEXT,
    approved_by_role TEXT DEFAULT 'Production Manager',
    category TEXT DEFAULT 'Repair/Replace/Servicing',
    priority_number INTEGER DEFAULT 1,
    back_job_reporting INTEGER DEFAULT 0,

    -- Legacy / system fields
    title TEXT,
    department TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    risk_level TEXT DEFAULT 'normal',
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),

    -- PART II: MAINTENANCE SECTION
    personnel_1 TEXT, personnel_2 TEXT,
    personnel_3 TEXT, personnel_4 TEXT,
    materials_used TEXT,
    hours_completed REAL DEFAULT 0,
    date_repair_started TEXT,
    date_repair_completed TEXT,
    task_performed TEXT,
    maintenance_remarks TEXT,
    maint_approved_by TEXT,
    maint_approved_role TEXT DEFAULT 'Maintenance Supervisor',
    downtime_minutes INTEGER DEFAULT 0,
    root_cause TEXT,
    resolution TEXT,
    assigned_to TEXT,
    accepted_at TEXT,
    turnover_count INTEGER DEFAULT 0,
    closed_at TEXT, closed_by TEXT,

    -- PART III: REQUESTOR ACCEPTANCE CHECKLIST
    accept_task_completed TEXT DEFAULT 'NO',
    accept_quality_satisfactory TEXT DEFAULT 'NO',
    accept_parts_reinstalled TEXT DEFAULT 'NO',
    accept_tools_removed TEXT DEFAULT 'NO',
    accept_direct_contact TEXT DEFAULT 'NO',
    acceptance_remarks TEXT,
    inspected_by_requestor TEXT,

    -- PART IV: FSMS ACCEPTANCE
    fsms_welding_required TEXT DEFAULT 'NA',
    fsms_welding_quality TEXT DEFAULT 'NA',
    fsms_product_affected TEXT DEFAULT 'NA',
    fsms_remarks TEXT,
    fsms_overall_remarks TEXT,
    fsms_approved_by TEXT,

    -- PART V: QA/QC ACCEPTANCE
    qa_area_clean TEXT DEFAULT 'NA',
    qa_atp_validation TEXT DEFAULT 'NA',
    qa_product_segregated TEXT DEFAULT 'NA',
    qa_atp_result TEXT,
    qa_overall_remarks TEXT,
    qa_inspected_by TEXT,

    -- Approvals
    approved_at TEXT,
    supervisor_id TEXT
  )`);

  // ALTER TABLE migrations — add any missing columns to existing DB
  [
    'job_number TEXT',
    'requestor_name TEXT', 'plant_section TEXT',
    'equipment_description TEXT', 'equipment_number TEXT',
    'description_of_defect TEXT', 'maintenance_incharge TEXT',
    'required_plant_shutdown INTEGER DEFAULT 0',
    'approved_by_name TEXT', 'approved_by_role TEXT',
    'category TEXT DEFAULT "Repair/Replace/Servicing"',
    'priority_number INTEGER DEFAULT 1',
    'back_job_reporting INTEGER DEFAULT 0',
    'title TEXT', 'risk_level TEXT DEFAULT "normal"',
    'personnel_1 TEXT','personnel_2 TEXT','personnel_3 TEXT','personnel_4 TEXT',
    'materials_used TEXT',
    'hours_completed REAL DEFAULT 0',
    'date_repair_started TEXT','date_repair_completed TEXT',
    'task_performed TEXT','maintenance_remarks TEXT',
    'maint_approved_by TEXT','maint_approved_role TEXT',
    'downtime_minutes INTEGER DEFAULT 0',
    'root_cause TEXT','resolution TEXT',
    'assigned_to TEXT','accepted_at TEXT',
    'turnover_count INTEGER DEFAULT 0',
    'closed_at TEXT','closed_by TEXT',
    'accept_task_completed TEXT DEFAULT "NO"',
    'accept_quality_satisfactory TEXT DEFAULT "NO"',
    'accept_parts_reinstalled TEXT DEFAULT "NO"',
    'accept_tools_removed TEXT DEFAULT "NO"',
    'accept_direct_contact TEXT DEFAULT "NO"',
    'acceptance_remarks TEXT','inspected_by_requestor TEXT',
    'fsms_welding_required TEXT DEFAULT "NA"',
    'fsms_welding_quality TEXT DEFAULT "NA"',
    'fsms_product_affected TEXT DEFAULT "NA"',
    'fsms_remarks TEXT','fsms_overall_remarks TEXT','fsms_approved_by TEXT',
    'qa_area_clean TEXT DEFAULT "NA"',
    'qa_atp_validation TEXT DEFAULT "NA"',
    'qa_product_segregated TEXT DEFAULT "NA"',
    'qa_atp_result TEXT','qa_overall_remarks TEXT','qa_inspected_by TEXT',
    'approved_at TEXT','supervisor_id TEXT','updated_at TEXT'
  ].forEach(col => { safeExec(`ALTER TABLE job_orders ADD COLUMN ${col}`); });

  // JOB ASSIGNMENTS (tracks all technicians per job incl turnover)
  safeExec(`CREATE TABLE IF NOT EXISTS job_assignments (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, technician_id TEXT,
    technician_name TEXT, role TEXT DEFAULT 'primary',
    assigned_at TEXT DEFAULT (datetime('now')),
    accepted_at TEXT, completed_at TEXT,
    turnover_from TEXT, turnover_reason TEXT,
    status TEXT DEFAULT 'active'
  )`);

  // JOB COMMENTS
  safeExec(`CREATE TABLE IF NOT EXISTS job_comments (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
    user_id TEXT, user_name TEXT, comment TEXT NOT NULL,
    image_path TEXT, ai_detected_names TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // JOB ASSISTANTS
  safeExec(`CREATE TABLE IF NOT EXISTS job_assistants (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
    technician_id TEXT, technician_name TEXT,
    added_by TEXT, added_at TEXT DEFAULT (datetime('now'))
  )`);

  // JOB ACCOMPLISHMENTS (AI credit tracking)
  safeExec(`CREATE TABLE IF NOT EXISTS job_accomplishments (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
    technician_id TEXT, technician_name TEXT,
    role_type TEXT DEFAULT 'PRIMARY',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // INVENTORY
  safeExec(`CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY, part_number TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, category TEXT, brand TEXT, model TEXT,
    quantity INTEGER DEFAULT 0, min_quantity INTEGER DEFAULT 5,
    unit_cost REAL DEFAULT 0, location TEXT,
    last_updated TEXT DEFAULT (datetime('now'))
  )`);

  // STOCKROOM TRANSACTION HISTORY (delivery + withdrawal log)
  safeExec(`CREATE TABLE IF NOT EXISTS stockroom_transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    item_id TEXT, item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    supplier TEXT, dr_number TEXT,
    department TEXT, technician TEXT,
    purpose TEXT, job_order_id TEXT,
    image_path TEXT,
    ai_extracted_data TEXT,
    ai_confidence TEXT,
    processed_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // OCR RECORDS (AI vision processing log)
  safeExec(`CREATE TABLE IF NOT EXISTS ocr_records (
    id TEXT PRIMARY KEY,
    image_path TEXT,
    document_type TEXT,
    raw_ai_response TEXT,
    extracted_json TEXT,
    confidence_score REAL DEFAULT 0,
    verified_by TEXT,
    auto_applied INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // PURCHASE REQUESTS
  safeExec(`CREATE TABLE IF NOT EXISTS purchase_requests (
    id TEXT PRIMARY KEY, item_id TEXT, item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1, unit TEXT DEFAULT 'pcs',
    estimated_cost REAL DEFAULT 0, reason TEXT,
    priority TEXT DEFAULT 'med', status TEXT DEFAULT 'pending',
    requested_by TEXT, approved_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // PRODUCTION LOGS
  safeExec(`CREATE TABLE IF NOT EXISTS production_logs (
    id TEXT PRIMARY KEY, shift TEXT, production_volume REAL DEFAULT 0,
    efficiency REAL DEFAULT 0, downtime_minutes INTEGER DEFAULT 0,
    remarks TEXT, logged_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Migrate production_logs columns
  ['logged_by TEXT', 'downtime_minutes INTEGER DEFAULT 0', 'efficiency REAL DEFAULT 0'].forEach(col => {
    safeExec(`ALTER TABLE production_logs ADD COLUMN ${col}`);
  });

  // KPI
  safeExec(`CREATE TABLE IF NOT EXISTS kpi_records (
    id TEXT PRIMARY KEY, date TEXT NOT NULL,
    oee REAL, availability REAL, performance REAL, quality REAL,
    production_volume REAL DEFAULT 0, downtime_minutes INTEGER DEFAULT 0,
    period TEXT DEFAULT 'monthly',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  ['production_volume REAL DEFAULT 0','downtime_minutes INTEGER DEFAULT 0','period TEXT DEFAULT "monthly"'].forEach(col => {
    safeExec(`ALTER TABLE kpi_records ADD COLUMN ${col}`);
  });

  // CALIBRATION
  safeExec(`CREATE TABLE IF NOT EXISTS calibration_records (
    id TEXT PRIMARY KEY, instrument_tag TEXT NOT NULL,
    instrument_type TEXT, location TEXT,
    as_found_zero REAL DEFAULT 0, as_found_span REAL DEFAULT 0,
    as_left_zero REAL DEFAULT 0, as_left_span REAL DEFAULT 0,
    error_pct REAL DEFAULT 0, pass_fail TEXT DEFAULT 'PASS',
    calibrated_by TEXT, calibration_date TEXT,
    next_due TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // AI KNOWLEDGE
  safeExec(`CREATE TABLE IF NOT EXISTS ai_knowledge (
    id TEXT PRIMARY KEY, question TEXT NOT NULL,
    answer TEXT NOT NULL, category TEXT,
    tags TEXT, source TEXT DEFAULT 'ai',
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // NOTIFICATIONS
  safeExec(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT, user_role TEXT,
    title TEXT NOT NULL, message TEXT, type TEXT DEFAULT 'info',
    job_id TEXT, is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ASSETS
  safeExec(`CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, asset_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, category TEXT, brand TEXT, model TEXT,
    serial_number TEXT, department TEXT, location TEXT,
    status TEXT DEFAULT 'available', condition TEXT DEFAULT 'good',
    purchase_cost REAL DEFAULT 0, assigned_to TEXT,
    created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ASSET TRANSFERS
  safeExec(`CREATE TABLE IF NOT EXISTS asset_transfers (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL,
    asset_name TEXT, from_department TEXT, to_department TEXT,
    from_person TEXT, to_person TEXT, reason TEXT,
    status TEXT DEFAULT 'pending', requested_by TEXT,
    approved_by TEXT, approved_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  seedData();
}

function seedData() {
  // Seed users
  const uc = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (uc === 0) {
    const h = p => bcrypt.hashSync(p, 10);
    const ins = db.prepare(`INSERT OR IGNORE INTO users (id,name,email,password_hash,role,department,nc_level,employee_id,performance_score,jos_closed) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    [
      ['usr-001','Arnold Padernal','admin@fusion.com',h('Admin@123'),'manager','Management',null,'EMP-001',96,45],
      ['usr-002','Juan Santos','juan@fusion.com',h('Admin@123'),'instrumentation','Instrumentation','NC3','EMP-002',94,38],
      ['usr-003','Maria Reyes','maria@fusion.com',h('Admin@123'),'electrical','Electrical','NC3','EMP-003',91,29],
      ['usr-004','Roberto Cruz','roberto@fusion.com',h('Admin@123'),'instrumentation','Instrumentation','NC2','EMP-004',88,22],
      ['usr-005','Antonio Garcia','antonio@fusion.com',h('Admin@123'),'mechanical','Mechanical','NC3','EMP-005',87,31],
      ['usr-006','Pedro Supervisor','super@fusion.com',h('Admin@123'),'supervisor','Maintenance',null,'EMP-006',92,0],
      ['usr-007','Plant Operator','operator@fusion.com',h('Admin@123'),'operator','Production',null,'EMP-007',89,0],
      ['usr-008','Stock Personnel','stock@fusion.com',h('Admin@123'),'stockroom','Stockroom',null,'EMP-008',85,0],
    ].forEach(u => { try { ins.run(...u); } catch(e) {} });
  }

  // Seed inventory
  const ic = db.prepare('SELECT COUNT(*) as c FROM inventory').get().c;
  if (ic === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO inventory (id,part_number,name,category,brand,quantity,min_quantity,unit_cost) VALUES (?,?,?,?,?,?,?,?)`);
    [
      ['inv-001','SMC-VX2120','Solenoid Valve 24VDC 1/2"','Actuators','SMC',1,4,1800],
      ['inv-002','CABLE-CAT6-100','Ethernet Cable Cat6 100m','Cables','Generic',2,1,1800],
      ['inv-003','HART-375-FLD','HART 375 Field Communicator','Calibration Tools','Emerson',1,1,45000],
      ['inv-004','SCHE-LC1D80','3-Phase Contactor 75A AC','Electrical','Schneider',0,2,3200],
      ['inv-005','EH-PMC71-AAA','4-20mA Pressure Transmitter 0-10 bar','Instruments','Endress+Hauser',5,3,4200],
      ['inv-006','YOK-EJX110A','Yokogawa EJX110A DP Transmitter','Instruments','Yokogawa',4,2,22000],
      ['inv-007','SIE-6ES7-214','Siemens S7-1200 CPU 1214C','PLC Parts','Siemens',3,2,18500],
      ['inv-008','ABB-ACS580-75','ABB ACS580 Control Panel 75kW','VFD Parts','ABB',2,1,12000],
      ['inv-009','OM-E5CN-R','Omron Temperature Controller E5CN','Instruments','Omron',6,3,2800],
      ['inv-010','PHX-D1-001','pH Electrode Replacement','Instruments','Mettler-Toledo',2,5,3500],
      ['inv-011','FUSE-3A-GL','3A Glass Fuse 5x20mm','Electrical','Bussmann',8,50,25],
      ['inv-012','CABLE-SHD-2P','2-Pair Shielded Instrument Cable per meter','Cables','Belden',45,20,85],
    ].forEach(r => { try { ins.run(...r); } catch(e) {} });
  }

  // Seed KPI
  const kc = db.prepare('SELECT COUNT(*) as c FROM kpi_records').get().c;
  if (kc === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO kpi_records (id,date,oee,availability,performance,quality,production_volume,period) VALUES (?,?,?,?,?,?,?,'monthly')`);
    const months = ['2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02'];
    const vals   = [[82,91,92,98,1850],[84,92,93,98,1920],[86,93,94,98,2010],[88,94,94,99,2080],[87,93,95,99,2050],[89,95,95,99,2150],[91,96,96,99,2240]];
    months.forEach((m,i) => {
      const [o,a,p,q,v] = vals[i];
      try { ins.run(`kpi-${i}`,m+'-01',o,a,p,q,v); } catch(e) {}
    });
  }

  // Seed job orders
  const jc = db.prepare('SELECT COUNT(*) as c FROM job_orders').get().c;
  if (jc === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO job_orders (id,title,type,department,priority,equipment,tag_number,location,description,status,created_by,assigned_to) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    [
      ['jo-001','Pressure Transmitter Fault — Production Line 2','Corrective','Instrumentation','high','Pressure Transmitter','PT-201','Production Line 2','PT-201 showing 0mA signal. Line 2 halted.','open','Plant Operator',null],
      ['jo-002','VFD Fault Code F0022 — Pump Motor 3','Corrective','Electrical','high','ABB VFD ACS580','VFD-03','Motor Control Center A','VFD showing F0022 overcurrent fault. Pump 3 offline.','progress','Plant Operator','Maria Reyes'],
      ['jo-003','Annual PM — pH Transmitter AT-301','Preventive','Instrumentation','low','pH Transmitter','AT-301','Effluent Tank','Annual calibration and cleaning of pH sensor.','open','Pedro Supervisor',null],
      ['jo-004','Flow Meter Zeroing Required','Corrective','Instrumentation','med','EM Flow Meter','FT-101','Raw Water Line','FT-101 showing negative flow during no-flow condition.','done','Plant Operator','Juan Santos'],
      ['jo-005','Replace Contactor — MCC Panel B3','Corrective','Electrical','med','Motor Contactor','K-B3','MCC Panel Room B','Contactor K-B3 burned. Motor 5 not starting.','done','Plant Operator','Maria Reyes'],
    ].forEach(r => { try { ins.run(...r); } catch(e) {} });
  }
}

initDB();
console.log('[DB] Database initialized');

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : h;
    if (!token) return res.status(401).json({ error: 'No token provided' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid or expired token. Please login again.' }); }
}

// Helper: send notification
function notify(title, message, type, jobId, targetRole) {
  try {
    db.prepare(`INSERT INTO notifications (id,user_role,title,message,type,job_id) VALUES (?,?,?,?,?,?)`).run(
      'notif-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),
      targetRole, title, message, type, jobId
    );
  } catch(e) {}
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', version: '2.1.0', db: 'connected', ai: API_KEY ? 'configured' : 'not configured', timestamp: new Date().toISOString() });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  try {
    const email    = (req.body?.email || '').toLowerCase().trim();
    const password = req.body?.password || '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    let user;
    try {
      user = db.prepare('SELECT * FROM users WHERE LOWER(email)=? AND is_active=1').get(email);
    } catch(e) {
      try { user = db.prepare('SELECT * FROM users WHERE LOWER(email)=?').get(email); }
      catch(e2) { return res.status(500).json({ error: 'Database error: ' + e2.message }); }
    }

    if (!user)                              return res.status(401).json({ error: 'No account found for: ' + email });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect password' });

    try { db.prepare('UPDATE users SET last_login=datetime("now") WHERE id=?').run(user.id); } catch(e) {}

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '12h' }
    );

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, nc_level: user.nc_level } });
  } catch(err) {
    console.error('[LOGIN ERROR]', err.message);
    res.status(500).json({ error: 'Login server error: ' + err.message });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  try {
    let u;
    try { u = db.prepare('SELECT id,name,email,role,department,nc_level,performance_score,jos_closed,last_login FROM users WHERE id=?').get(req.user.id); }
    catch(e) { u = db.prepare('SELECT id,name,email,role,department,last_login FROM users WHERE id=?').get(req.user.id); }
    res.json(u || req.user);
  } catch(e) { res.json(req.user); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
app.get('/api/notifications', auth, (req, res) => {
  try {
    const n = db.prepare('SELECT * FROM notifications WHERE (user_id=? OR user_role=?) AND is_read=0 ORDER BY created_at DESC LIMIT 20')
      .all(req.user.id, req.user.role);
    res.json(n);
  } catch(e) { res.json([]); }
});

app.patch('/api/notifications/:id/read', auth, (req, res) => {
  try { db.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(req.params.id); res.json({success:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ── JOB ORDERS ────────────────────────────────────────────────────────────────
app.get('/api/joborders', auth, (req, res) => {
  try {
    const limit  = parseInt(req.query.limit) || 100;
    const dept   = req.query.department;
    const status = req.query.status;
    let q = 'SELECT * FROM job_orders WHERE 1=1';
    const p = [];
    if (dept)   { q += ' AND department=?';  p.push(dept); }
    if (status) { q += ' AND status=?'; p.push(status); }
    // Technicians see their dept only
    if (['instrumentation','electrical','mechanical','qa'].includes(req.user.role)) {
      q += ' AND (department=? OR assigned_to=? OR created_by=?)';
      const d = req.user.role.charAt(0).toUpperCase()+req.user.role.slice(1);
      p.push(d, req.user.name, req.user.name);
    }
    q += " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END, created_at DESC LIMIT ?";
    p.push(limit);
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/joborders/:id', auth, (req, res) => {
  try {
    const jo = db.prepare('SELECT * FROM job_orders WHERE id=?').get(req.params.id);
    if (!jo) return res.status(404).json({error:'Not found'});
    const assignments = db.prepare('SELECT * FROM job_assignments WHERE job_id=? ORDER BY assigned_at ASC').all(req.params.id);
    const comments    = db.prepare('SELECT * FROM job_comments WHERE job_id=? ORDER BY created_at ASC').all(req.params.id);
    const assistants  = db.prepare('SELECT * FROM job_assistants WHERE job_id=?').all(req.params.id);
    const accomplishments = db.prepare('SELECT * FROM job_accomplishments WHERE job_id=?').all(req.params.id);
    res.json({...jo, assignments, comments, assistants, accomplishments});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/joborders', auth, (req, res) => {
  const allowed = ['supervisor','manager','instrumentation','electrical','mechanical','qa','operator'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({error:'Not authorized to create job orders'});
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM job_orders').get().c + 1;
    const num   = 'JO-' + String(count).padStart(5,'0');
    const id    = 'jo-' + Date.now();

    const {
      equipment_description, equipment_number, description_of_defect,
      requestor_name, plant_section, maintenance_incharge,
      required_plant_shutdown, approved_by_name, approved_by_role,
      category, priority_number, back_job_reporting, risk_level,
      department, title,
      personnel_1, personnel_2, personnel_3, personnel_4,
      materials_used, task_performed, hours_completed,
      date_repair_started, date_repair_completed,
      maintenance_remarks, maint_approved_by, assigned_to
    } = req.body;

    const equip = equipment_description || title || '';
    const dept  = department || maintenance_incharge || 'Maintenance';
    if (!equip) return res.status(400).json({error:'Equipment Description is required'});

    db.prepare(`INSERT INTO job_orders (
      id, job_number, title, department, status, created_by, created_at, updated_at,
      requestor_name, plant_section, equipment_description, equipment_number,
      description_of_defect, maintenance_incharge, required_plant_shutdown,
      approved_by_name, approved_by_role, category, priority_number, back_job_reporting,
      risk_level, personnel_1, personnel_2, personnel_3, personnel_4,
      materials_used, task_performed, hours_completed,
      date_repair_started, date_repair_completed,
      maintenance_remarks, maint_approved_by, assigned_to
    ) VALUES (?,?,?,?,'open',?,datetime('now'),datetime('now'),
      ?,?,?,?, ?,?,?, ?,?,?,?,?,
      ?,?,?,?,?, ?,?,?, ?,?,?,?,?)`)
    .run(
      id, num, equip, dept, req.user.name,
      requestor_name||req.user.name, plant_section||null, equip, equipment_number||null,
      description_of_defect||null, maintenance_incharge||dept, required_plant_shutdown?1:0,
      approved_by_name||null, approved_by_role||'Production Manager',
      category||'Repair/Replace/Servicing', parseInt(priority_number)||1, back_job_reporting?1:0,
      risk_level||'normal',
      personnel_1||null, personnel_2||null, personnel_3||null, personnel_4||null,
      materials_used ? JSON.stringify(materials_used) : null,
      task_performed||null, hours_completed||0,
      date_repair_started||null, date_repair_completed||null,
      maintenance_remarks||null, maint_approved_by||null, assigned_to||null
    );
    const pn = parseInt(priority_number)||1;
    const pLabel = pn===1?'PRIORITY 1 — 1 Day':pn===2?'PRIORITY 2 — 1 Week':pn===3?'PRIORITY 3 — 1 Month':'PRIORITY 4 — Project';
    notify(`🔧 New Job Order ${num}`, `${equip} | ${dept} | ${pLabel} | By: ${req.user.name}`, 'job', id, dept.toLowerCase());
    notify(`New JO: ${num}`, `${equip} — ${description_of_defect||''}`, 'job', id, 'supervisor');
    notify(`New JO: ${num}`, `${equip} | ${dept}`, 'job', id, 'manager');
    res.json({id, job_number: num, message: `Job Order ${num} created. ${dept} department notified.`});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Accept JO (technician on duty)
app.patch('/api/joborders/:id/accept', auth, (req, res) => {
  try {
    const jo = db.prepare('SELECT * FROM job_orders WHERE id=?').get(req.params.id);
    if (!jo) return res.status(404).json({error:'Not found'});
    db.prepare(`UPDATE job_orders SET status='progress', assigned_to=?, accepted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .run(req.user.name, req.params.id);
    // Create primary assignment record
    db.prepare(`INSERT INTO job_assignments (id,job_id,technician_id,technician_name,role,accepted_at,status) VALUES (?,?,?,?,'primary',datetime('now'),'active')`)
      .run('asn-'+Date.now(), req.params.id, req.user.id, req.user.name);
    notify('JO Accepted', `${req.user.name} accepted: ${jo.title}`, 'info', req.params.id, 'supervisor');
    notify('JO Accepted', `${req.user.name} accepted: ${jo.title}`, 'info', req.params.id, 'manager');
    res.json({success:true, message:'Job accepted'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Add comment to JO
app.post('/api/joborders/:id/comments', auth, (req, res) => {
  try {
    const {comment, image_path} = req.body;
    if (!comment) return res.status(400).json({error:'Comment required'});
    // AI detect names mentioned in comment
    const namePattern = /(?:help from|assisted by|with|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;
    const detected = [];
    let m;
    while((m = namePattern.exec(comment)) !== null) { detected.push(m[1]); }
    const id = 'cmt-'+Date.now();
    db.prepare(`INSERT INTO job_comments (id,job_id,user_id,user_name,comment,image_path,ai_detected_names) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.params.id, req.user.id, req.user.name, comment, image_path||null, detected.join(','));
    // Auto-credit detected names
    if (detected.length > 0) {
      detected.forEach(nm => {
        try {
          const u = db.prepare("SELECT * FROM users WHERE name LIKE ?").get('%'+nm+'%');
          const uid = u ? u.id : null;
          const existing = db.prepare('SELECT id FROM job_assistants WHERE job_id=? AND technician_name=?').get(req.params.id, nm);
          if (!existing) {
            db.prepare(`INSERT INTO job_assistants (id,job_id,technician_id,technician_name,added_by) VALUES (?,?,?,?,?)`)
              .run('ast-'+Date.now()+'-'+Math.random().toString(36).slice(2,5), req.params.id, uid, nm, 'AI Capture');
          }
        } catch(e) {}
      });
    }
    res.json({id, detected_names: detected, message:'Comment added'+(detected.length>0 ? '. AI detected: '+detected.join(', '):'')});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Add assistant technician manually
app.post('/api/joborders/:id/assistants', auth, (req, res) => {
  try {
    const {technician_name, technician_id} = req.body;
    if (!technician_name) return res.status(400).json({error:'Technician name required'});
    const existing = db.prepare('SELECT id FROM job_assistants WHERE job_id=? AND technician_name=?').get(req.params.id, technician_name);
    if (existing) return res.json({message:'Already added as assistant'});
    db.prepare(`INSERT INTO job_assistants (id,job_id,technician_id,technician_name,added_by) VALUES (?,?,?,?,?)`)
      .run('ast-'+Date.now(), req.params.id, technician_id||null, technician_name, req.user.name);
    res.json({success:true, message:technician_name+' added as assistant'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Turnover JO to next shift
app.patch('/api/joborders/:id/turnover', auth, (req, res) => {
  try {
    const jo = db.prepare('SELECT * FROM job_orders WHERE id=?').get(req.params.id);
    if (!jo) return res.status(404).json({error:'Not found'});
    const {to_technician, reason} = req.body;
    // Mark current assignment as turned over
    db.prepare(`UPDATE job_assignments SET status='turned-over', completed_at=datetime('now') WHERE job_id=? AND status='active'`).run(req.params.id);
    // Create new assignment for next tech
    db.prepare(`INSERT INTO job_assignments (id,job_id,technician_name,role,status,turnover_from,turnover_reason) VALUES (?,?,?,'turnover','active',?,?)`)
      .run('asn-'+Date.now(), req.params.id, to_technician||'Next Shift', req.user.name, reason||'Shift end');
    // Update JO
    db.prepare(`UPDATE job_orders SET assigned_to=?, turnover_count=COALESCE(turnover_count,0)+1, updated_at=datetime('now') WHERE id=?`)
      .run(to_technician||'Next Shift', req.params.id);
    notify('JO Turnover', `${req.user.name} turned over "${jo.title}" to ${to_technician||'next shift'}`, 'warning', req.params.id, 'supervisor');
    res.json({success:true, message:'Job turned over to '+to_technician});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Close JO — supervisor/manager only
app.patch('/api/joborders/:id/close', auth, (req, res) => {
  const allowed = ['supervisor','manager'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({error:'Only supervisors and managers can close job orders'});
  try {
    const jo = db.prepare('SELECT * FROM job_orders WHERE id=?').get(req.params.id);
    if (!jo) return res.status(404).json({error:'Not found'});
    const {
      root_cause, resolution, downtime_minutes,
      task_performed, hours_completed,
      personnel_1, personnel_2, personnel_3, personnel_4,
      materials_used, maintenance_remarks, maint_approved_by,
      date_repair_started, date_repair_completed,
      accept_task_completed, accept_quality_satisfactory,
      accept_parts_reinstalled, accept_tools_removed, accept_direct_contact,
      acceptance_remarks, inspected_by_requestor,
      fsms_welding_required, fsms_welding_quality, fsms_product_affected,
      fsms_remarks, fsms_overall_remarks, fsms_approved_by,
      qa_area_clean, qa_atp_validation, qa_product_segregated,
      qa_atp_result, qa_overall_remarks, qa_inspected_by
    } = req.body;
    db.prepare(`UPDATE job_orders SET
      status='done', closed_by=?, closed_at=datetime('now'), updated_at=datetime('now'),
      root_cause=?, resolution=?, downtime_minutes=?,
      task_performed=COALESCE(?,task_performed), hours_completed=COALESCE(?,hours_completed),
      personnel_1=COALESCE(?,personnel_1), personnel_2=COALESCE(?,personnel_2),
      personnel_3=COALESCE(?,personnel_3), personnel_4=COALESCE(?,personnel_4),
      materials_used=COALESCE(?,materials_used), maintenance_remarks=COALESCE(?,maintenance_remarks),
      maint_approved_by=COALESCE(?,maint_approved_by),
      date_repair_started=COALESCE(?,date_repair_started), date_repair_completed=COALESCE(?,date_repair_completed),
      accept_task_completed=?, accept_quality_satisfactory=?,
      accept_parts_reinstalled=?, accept_tools_removed=?, accept_direct_contact=?,
      acceptance_remarks=?, inspected_by_requestor=?,
      fsms_welding_required=?, fsms_welding_quality=?, fsms_product_affected=?,
      fsms_remarks=?, fsms_overall_remarks=?, fsms_approved_by=?,
      qa_area_clean=?, qa_atp_validation=?, qa_product_segregated=?,
      qa_atp_result=?, qa_overall_remarks=?, qa_inspected_by=?
      WHERE id=?`)
    .run(
      req.user.name, root_cause||null, resolution||null, downtime_minutes||0,
      task_performed||null, hours_completed||null,
      personnel_1||null, personnel_2||null, personnel_3||null, personnel_4||null,
      materials_used?JSON.stringify(materials_used):null, maintenance_remarks||null,
      maint_approved_by||null, date_repair_started||null, date_repair_completed||null,
      accept_task_completed||'NO', accept_quality_satisfactory||'NO',
      accept_parts_reinstalled||'NO', accept_tools_removed||'NO', accept_direct_contact||'NO',
      acceptance_remarks||null, inspected_by_requestor||null,
      fsms_welding_required||'NA', fsms_welding_quality||'NA', fsms_product_affected||'NA',
      fsms_remarks||null, fsms_overall_remarks||null, fsms_approved_by||null,
      qa_area_clean||'NA', qa_atp_validation||'NA', qa_product_segregated||'NA',
      qa_atp_result||null, qa_overall_remarks||null, qa_inspected_by||null,
      req.params.id
    );
    // Record accomplishments for ALL involved
    const primary = jo.assigned_to;
    const assistants = db.prepare('SELECT * FROM job_assistants WHERE job_id=?').all(req.params.id);
    const assignments = db.prepare("SELECT * FROM job_assignments WHERE job_id=?").all(req.params.id);
    const allTechs = new Map();
    if (primary) {
      const u = db.prepare('SELECT * FROM users WHERE name=?').get(primary);
      allTechs.set(primary, {id: u?.id, name: primary, role: 'PRIMARY'});
    }
    assistants.forEach(a => { if (!allTechs.has(a.technician_name)) allTechs.set(a.technician_name, {id: a.technician_id, name: a.technician_name, role: 'ASSISTANT'}); });
    assignments.forEach(a => {
      if (a.technician_name && !allTechs.has(a.technician_name)) allTechs.set(a.technician_name, {id: a.technician_id, name: a.technician_name, role: a.role==='turnover'?'TURNOVER':'PRIMARY'});
    });
    allTechs.forEach((t, name) => {
      db.prepare(`INSERT OR IGNORE INTO job_accomplishments (id,job_id,technician_id,technician_name,role_type) VALUES (?,?,?,?,?)`)
        .run('acc-'+Date.now()+'-'+Math.random().toString(36).slice(2,5), req.params.id, t.id||null, name, t.role);
      // Update performance
      try { db.prepare('UPDATE users SET jos_closed=COALESCE(jos_closed,0)+1 WHERE name=?').run(name); } catch(e) {}
    });
    notify('JO Closed', `"${jo.title}" closed by ${req.user.name}`, 'success', req.params.id, 'manager');
    res.json({success:true, technicians_credited: [...allTechs.keys()]});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// General PATCH for status/assignment
app.patch('/api/joborders/:id', auth, (req, res) => {
  try {
    const {status, assigned_to, approved_by, priority} = req.body;
    if (status) db.prepare(`UPDATE job_orders SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, req.params.id);
    if (assigned_to) db.prepare(`UPDATE job_orders SET assigned_to=?, updated_at=datetime('now') WHERE id=?`).run(assigned_to, req.params.id);
    if (approved_by) db.prepare(`UPDATE job_orders SET approved_by=?, approved_at=datetime('now'), status='approved' WHERE id=?`).run(approved_by, req.params.id);
    if (priority) db.prepare(`UPDATE job_orders SET priority=? WHERE id=?`).run(priority, req.params.id);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── AI ASSISTANT ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are FUSION AI, an expert industrial automation assistant for FUSION IMS.
You specialize in:

INSTRUMENTATION & CONTROL (Philippines NC2/NC3/NC4):
- PLC/DCS: Siemens S7-1200/1500, Allen-Bradley ControlLogix/CompactLogix, Yokogawa CENTUM VP, Mitsubishi iQ-R/F, Omron Sysmac NJ/NX, ABB System 800xA, Schneider Modicon M580, Beckhoff TwinCAT, LS Electric XGT, Delta AH500, Inovance H5U, SUPCON Webfield, HollySys
- Field Instruments: pressure transmitters (Yokogawa EJX, Rosemount 3051), flow meters (EM, Coriolis, ultrasonic), pH/ORP/conductivity/TDS/Brix, DP transmitters, level (radar, ultrasonic), RTD, thermocouple
- Calibration procedures per ISA and IEC standards, 4-20mA loop troubleshooting, HART configuration
- TESDA NC2/NC3/NC4 competencies for Philippines
- Solenoid valves, electro-pneumatic positioners, control valves

ELECTRICAL:
- VFD troubleshooting (ABB, Siemens, Allen-Bradley fault codes)
- Motor wiring (3-phase, star/delta, DOL, VFD)
- MCC panels, contactors, overloads
- Solar PV systems, CCTV, access control

MECHANICAL:
- Pumps, compressors, hydraulics, pneumatics
- Gearboxes, bearings, couplings
- Welding: SMAW, GTAW, GMAW procedures

INDUSTRIAL PROCESSES:
- Reverse Osmosis (RO) systems
- Glucose processing, Palm oil, Corn flour mill
- Oil & Gas upstream/downstream

SAFETY: IOSH, OSHA 1910, IEC 61511 (SIS/SIL), DOLE RA 11058, LOTO

Always give step-by-step practical answers. Archive knowledge for future queries.`;

app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    const { message, session_id, history } = req.body;
    if (!message) return res.status(400).json({error:'Message required'});

    // Check archive first
    const archived = db.prepare(`SELECT * FROM ai_knowledge WHERE question LIKE ? OR tags LIKE ? ORDER BY use_count DESC LIMIT 1`)
      .get('%'+message.slice(0,40)+'%', '%'+message.slice(0,30)+'%');
    
    if (archived && message.length < 100) {
      db.prepare('UPDATE ai_knowledge SET use_count=use_count+1 WHERE id=?').run(archived.id);
      return res.json({answer: archived.answer, session_id: session_id||'arc', from_archive: true, category: archived.category});
    }

    const ALIBABA_KEY = process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY || '';
    
    // ── TRY ALIBABA QWEN FIRST ─────────────────────────────────────────────
    if (ALIBABA_KEY) {
      try {
        const chatModel = process.env.QWEN_CHAT_MODEL || 'qwen-max';
        const msgs = [];
        if (history && Array.isArray(history)) {
          history.slice(-8).forEach(h => { if(h.role && h.content) msgs.push({role:h.role, content:h.content}); });
        }
        msgs.push({role:'user', content: message});

        const aliResp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer '+ALIBABA_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chatModel,
            input: { messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...msgs] },
            parameters: { max_tokens: 2048, result_format: 'message' }
          })
        });
        const aliData = await aliResp.json();
        if (!aliData.code) {
          const answer = aliData.output?.choices?.[0]?.message?.content || 'No response';
          const sid = session_id || ('sess-'+Date.now());
          try {
            const category = detectCategory(message);
            db.prepare('INSERT OR IGNORE INTO ai_knowledge (id,question,answer,category,tags,source) VALUES (?,?,?,?,?,?)')
              .run('ai-'+Date.now(), message, answer, category, message.slice(0,80), 'qwen');
          } catch(e) {}
          return res.json({answer, session_id: sid, from_archive: false, category: detectCategory(message), provider: 'alibaba-qwen'});
        }
      } catch(aliErr) {
        console.error('[ALIBABA AI ERROR]', aliErr.message);
        // Fall through to Anthropic
      }
    }

    // ── FALLBACK TO ANTHROPIC ──────────────────────────────────────────────
    if (!API_KEY || !Anthropic) {
      const fallback = getFallback(message);
      return res.json({answer: fallback, session_id: 'demo', from_archive: false});
    }

    const client = new Anthropic({ apiKey: API_KEY });
    const msgs = [];
    if (history && Array.isArray(history)) {
      history.slice(-8).forEach(h => { if(h.role && h.content) msgs.push({role:h.role, content:h.content}); });
    }
    msgs.push({role:'user', content: message});

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1024,
      system: SYSTEM_PROMPT, messages: msgs
    });

    const answer = resp.content[0]?.text || 'No response';
    const sid = session_id || ('sess-'+Date.now());

    try {
      const category = detectCategory(message);
      db.prepare('INSERT OR IGNORE INTO ai_knowledge (id,question,answer,category,tags,source) VALUES (?,?,?,?,?,?)')
        .run('ai-'+Date.now(), message, answer, category, message.slice(0,80), 'anthropic');
    } catch(e) {}

    res.json({answer, session_id: sid, from_archive: false, category: detectCategory(message), provider: 'anthropic'});
  } catch(e) {
    console.error('[AI ERROR]', e.message);
    res.status(500).json({error: 'AI error: ' + e.message, answer: getFallback(req.body?.message||'')});
  }
});

function detectCategory(q) {
  const lq = q.toLowerCase();
  if (/plc|dcs|siemens|allen.bradley|yokogawa|mitsubishi|omron|profibus|profinet|ladder|fbd|scl/.test(lq)) return 'PLC/DCS';
  if (/transmitter|calibrat|4-20|hart|ph|orp|conductivity|brix|flow|level|pressure/.test(lq)) return 'Instrumentation';
  if (/vfd|motor|wiring|contactor|mcc|electrical|kwh|ampere/.test(lq)) return 'Electrical';
  if (/nc2|nc3|nc4|tesda|competency|assessment/.test(lq)) return 'NC Certification';
  if (/safety|osha|loto|lockout|iosh|iec 61511|sil/.test(lq)) return 'Safety';
  if (/pump|compressor|hydraulic|pneumatic|bearing|weld/.test(lq)) return 'Mechanical';
  if (/ro|reverse osmosis|glucose|palm oil|corn|flour|boiler/.test(lq)) return 'Process';
  return 'General';
}

function getFallback(msg) {
  const lm = msg.toLowerCase();
  if (/siemens.*s7-1200|s7-1200/.test(lm)) return 'Siemens S7-1200 Setup:\n1. Install TIA Portal V16+\n2. Create new project → Add CPU 1214C\n3. Configure IP: 192.168.0.1 (default)\n4. PROFINET device name assignment via TIA\n5. Program in LAD/FBD/SCL\n6. Download via Ethernet to PLC\n\nCommon issues: Wrong subnet? Check PC IP same range. CPU in STOP? Check OB1 exists.';
  if (/4-20|loop|transmitter/.test(lm)) return '4-20mA Loop Troubleshooting:\n• 0 mA = Open circuit (check wiring)\n• 4 mA = Instrument at 0% (normal minimum)\n• 20 mA = 100% output or fault\n\nSteps:\n1. Measure mA at transmitter terminals\n2. Check supply voltage (typically 24VDC)\n3. Verify loop resistance <600Ω\n4. Check HART configuration if applicable\n5. Use HART communicator for diagnostics';
  if (/vfd|fault/.test(lm)) return 'VFD Fault Troubleshooting:\nABB ACS580 common faults:\n• F0001 Overcurrent: Check motor cables, reduce acceleration time\n• F0002 Overvoltage: Add braking resistor, increase decel time\n• F0009 Underload: Check mechanical load, belts\n• F0022 Overcurrent on accel: Increase ramp time (Par 23.12)\n\nGeneral: Check motor insulation first (>1 MΩ to ground)';
  if (/nc2|nc3|nc4/.test(lm)) return 'TESDA NC Certification — Philippines:\n\nNC2 - Instrumentation & Control Servicing:\n• Install instruments\n• Basic calibration\n• Preventive maintenance\n• 4-20mA loop work\n\nNC3 - Commission & Advanced:\n• Full PLC programming (LAD, FBD, STL)\n• PROFIBUS, Foundation Fieldbus, HART\n• DCS configuration\n• ISA-5.1 loop drawings\n\nNC4 - Design & Lead:\n• System design\n• SIL/SIS (IEC 61511)\n• Lead FAT, SAT, commissioning\n• ISO 17025 calibration management';
  if (/calibrat|pressure/.test(lm)) return 'Pressure Transmitter Calibration:\n1. Isolate transmitter (LOTO)\n2. Connect dead weight tester or calibrator\n3. Apply 5-point test: 0%, 25%, 50%, 75%, 100%\n4. Record As-Found values\n5. Adjust Zero and Span\n6. Re-test As-Left values\n7. Error must be within ±0.1% of span\n8. Record in calibration certificate\n\nHART trim: Use HART communicator → Calibrate → Trim (Lower/Upper)';
  return 'FUSION AI — Industrial Knowledge Base\n\nI can help with:\n• PLC/DCS configuration (16+ brands)\n• Instrument calibration procedures\n• VFD and motor troubleshooting\n• NC2/NC3/NC4 TESDA Philippines\n• Process systems (RO, Glucose, Palm Oil)\n• Safety standards (OSHA, IOSH, IEC 61511)\n\nNote: Add ANTHROPIC_API_KEY to .env for full AI capability.\nGet free key at: https://console.anthropic.com';
}

// ── INVENTORY & STOCK ─────────────────────────────────────────────────────────
app.get('/api/inventory', auth, (req, res) => {
  try { res.json(db.prepare('SELECT * FROM inventory ORDER BY category, name').all()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/inventory', auth, (req, res) => {
  try {
    const {part_number, name, category, brand, quantity, min_quantity, unit_cost, location} = req.body;
    const id = 'inv-'+Date.now();
    db.prepare(`INSERT INTO inventory (id,part_number,name,category,brand,quantity,min_quantity,unit_cost,location) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, part_number||'PN-'+Date.now(), name, category||'General', brand||'', quantity||0, min_quantity||5, unit_cost||0, location||'');
    res.json({id, message:'Item added'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/inventory/:id', auth, (req, res) => {
  try {
    const {quantity, min_quantity} = req.body;
    if (quantity !== undefined) db.prepare("UPDATE inventory SET quantity=?, last_updated=datetime('now') WHERE id=?").run(quantity, req.params.id);
    if (min_quantity !== undefined) db.prepare('UPDATE inventory SET min_quantity=? WHERE id=?').run(min_quantity, req.params.id);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── STOCKROOM TRANSACTIONS ─────────────────────────────────────────────────────
app.get('/api/stockroom/transactions', auth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const type  = req.query.type;
    let q = 'SELECT * FROM stockroom_transactions WHERE 1=1';
    const p = [];
    if (type) { q += ' AND type=?'; p.push(type); }
    q += ' ORDER BY created_at DESC LIMIT ?'; p.push(limit);
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── AI OCR: ANALYZE RECEIPT / WITHDRAWAL SLIP IMAGE ────────────────────────────
app.post('/api/stockroom/ocr', auth, async (req, res) => {
  try {
    const { image_base64, image_type, document_type } = req.body;
    // document_type: 'delivery' | 'withdrawal'
    if (!image_base64) return res.status(400).json({error:'image_base64 required'});

    const mediaType = image_type || 'image/jpeg';
    const docType   = document_type || 'delivery';

    const systemPrompt = `You are an AI assistant for FUSION IMS industrial stockroom management system in the Philippines.
Your job is to read photos of documents (delivery receipts, withdrawal slips, purchase invoices, handwritten forms) and extract structured data.

You must respond ONLY with valid JSON — no markdown, no explanation, no backticks.

For DELIVERY RECEIPT, extract:
{
  "document_type": "delivery",
  "supplier": "supplier name or null",
  "dr_number": "delivery receipt number or null",
  "date": "date found or null",
  "items": [
    {"name": "item name", "model": "model number or null", "brand": "brand or null", "quantity": 1, "unit": "pcs", "unit_cost": 0}
  ],
  "remarks": "any notes or null",
  "confidence": "high|medium|low"
}

For WITHDRAWAL SLIP, extract:
{
  "document_type": "withdrawal",
  "department": "department name or null",
  "technician": "technician name or null",
  "job_order": "job order number or null",
  "date": "date found or null",
  "items": [
    {"name": "item name", "model": "model or null", "quantity": 1, "unit": "pcs", "purpose": "purpose or null"}
  ],
  "remarks": "any notes or null",
  "confidence": "high|medium|low"
}

If you cannot read the image clearly, return:
{"error": "Cannot read document clearly", "confidence": "low"}

Extract ALL items found. For handwritten text, do your best to interpret it.`;

    const userPrompt = `Please read this ${docType === 'delivery' ? 'DELIVERY RECEIPT' : 'WITHDRAWAL SLIP'} image and extract all information as JSON.
Look for: item names, quantities, supplier/technician name, dates, document numbers.
For handwritten text, interpret carefully. Return ONLY valid JSON.`;

    let aiResult = null;
    let rawResponse = '';

    // ── DETERMINE WHICH AI PROVIDER TO USE ──────────────────────────────────
    // Priority: 1) Alibaba Qwen-VL  2) Anthropic Claude  3) Demo mode
    const ALIBABA_KEY = process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY;
    const ALIBABA_OCR = process.env.ALIBABA_OCR_KEY; // optional dedicated OCR key

    if (ALIBABA_KEY) {
      // ── ALIBABA DASHSCOPE — Qwen-VL Vision Model ──────────────────────────
      try {
        const qwenModel = process.env.QWEN_MODEL || 'qwen-vl-max'; // or qwen-vl-plus (cheaper)
        const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + ALIBABA_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: qwenModel,
            input: {
              messages: [
                { role: 'system', content: [{ text: systemPrompt }] },
                {
                  role: 'user',
                  content: [
                    { image: 'data:' + mediaType + ';base64,' + image_base64 },
                    { text: userPrompt }
                  ]
                }
              ]
            },
            parameters: { max_tokens: 1024, result_format: 'message' }
          })
        });

        const data = await response.json();
        if (data.code) throw new Error('Alibaba API error: ' + data.message);
        rawResponse = data.output?.choices?.[0]?.message?.content?.[0]?.text || '{}';

        const clean = rawResponse.replace(/```json|```/g,'').trim();
        try { aiResult = JSON.parse(clean); } catch(e) {
          const match = clean.match(/\{[\s\S]*\}/);
          if (match) { try { aiResult = JSON.parse(match[0]); } catch(e2) {} }
        }
        if (aiResult) aiResult._provider = 'alibaba-qwen-vl';
      } catch(aliErr) {
        console.error('[ALIBABA OCR ERROR]', aliErr.message);
        // Fall through to Anthropic if available
      }
    }

    if (!aiResult && API_KEY && Anthropic) {
      // ── ANTHROPIC CLAUDE VISION (fallback) ────────────────────────────────
      try {
        const client = new Anthropic({ apiKey: API_KEY });
        const response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: image_base64 } },
              { type: 'text', text: userPrompt }
            ]
          }]
        });
        rawResponse = response.content[0]?.text || '{}';
        const clean = rawResponse.replace(/```json|```/g,'').trim();
        try { aiResult = JSON.parse(clean); } catch(e) {
          const match = clean.match(/\{[\s\S]*\}/);
          if (match) { try { aiResult = JSON.parse(match[0]); } catch(e2) {} }
        }
        if (aiResult) aiResult._provider = 'anthropic-claude';
      } catch(antErr) {
        console.error('[ANTHROPIC OCR ERROR]', antErr.message);
      }
    }

    if (!aiResult) {
      // ── DEMO MODE — no AI configured ──────────────────────────────────────
      aiResult = {
        document_type: docType,
        supplier: docType==='delivery' ? 'Demo Supplier (No AI key configured)' : null,
        department: docType==='withdrawal' ? 'Instrumentation' : null,
        technician: docType==='withdrawal' ? 'Demo Technician' : null,
        items: [{ name: 'Sample Item — add ALIBABA_API_KEY or ANTHROPIC_API_KEY to .env', quantity: 1, unit: 'pcs' }],
        confidence: 'low',
        demo_mode: true
      };
    }

    if (!aiResult) return res.status(422).json({error:'Could not parse AI response', raw: rawResponse});

    // Save OCR record
    const ocrId = 'ocr-'+Date.now();
    try {
      db.prepare(`INSERT INTO ocr_records (id,document_type,raw_ai_response,extracted_json,confidence_score) VALUES (?,?,?,?,?)`)
        .run(ocrId, docType, rawResponse, JSON.stringify(aiResult), aiResult.confidence==='high'?0.9:aiResult.confidence==='medium'?0.7:0.4);
    } catch(e) {}

    // Match items against existing inventory
    const inventory = db.prepare('SELECT * FROM inventory').all();
    const matchedItems = (aiResult.items||[]).map(item => {
      const matches = inventory.filter(inv => {
        const invName = inv.name.toLowerCase();
        const itemName = (item.name||'').toLowerCase();
        const itemModel = (item.model||'').toLowerCase();
        return invName.includes(itemName.slice(0,10)) || 
               itemName.includes(invName.slice(0,10)) ||
               (itemModel && (inv.model||'').toLowerCase().includes(itemModel.slice(0,8))) ||
               (item.brand && (inv.brand||'').toLowerCase().includes((item.brand||'').toLowerCase().slice(0,5)));
      });
      return { ...item, inventory_matches: matches.slice(0,3), ocr_id: ocrId };
    });

    res.json({ 
      success: true, 
      ocr_id: ocrId,
      extracted: aiResult,
      matched_items: matchedItems,
      total_items: (aiResult.items||[]).length,
      unmatched: matchedItems.filter(m=>m.inventory_matches.length===0).length
    });

  } catch(e) {
    console.error('[OCR ERROR]', e.message);
    res.status(500).json({error: 'OCR error: '+e.message});
  }
});

// ── APPLY OCR RESULT TO INVENTORY ─────────────────────────────────────────────
app.post('/api/stockroom/apply-ocr', auth, (req, res) => {
  try {
    const { ocr_id, document_type, items, supplier, department, technician, 
            job_order_id, dr_number, remarks } = req.body;
    
    const results = [];
    const applied = [];

    (items||[]).forEach(item => {
      if (!item.inventory_id || !item.quantity) return;
      
      const inv = db.prepare('SELECT * FROM inventory WHERE id=?').get(item.inventory_id);
      if (!inv) { results.push({item: item.name, error:'Not found in inventory'}); return; }

      const oldQty = inv.quantity;
      const newQty = document_type === 'delivery' 
        ? oldQty + parseInt(item.quantity)
        : Math.max(0, oldQty - parseInt(item.quantity));

      db.prepare("UPDATE inventory SET quantity=?, last_updated=datetime('now') WHERE id=?").run(newQty, inv.id);

      // Log transaction
      const txId = 'TX-'+Date.now()+'-'+Math.random().toString(36).slice(2,5);
      db.prepare(`INSERT INTO stockroom_transactions (id,type,item_id,item_name,quantity,supplier,dr_number,department,technician,purpose,job_order_id,ai_extracted_data,processed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(txId, document_type, inv.id, inv.name, item.quantity, 
             supplier||null, dr_number||null, department||null, 
             technician||null, item.purpose||null, job_order_id||null,
             JSON.stringify(item), req.user.name);

      applied.push({ 
        item: inv.name, 
        old_qty: oldQty, 
        new_qty: newQty, 
        change: document_type==='delivery' ? '+'+item.quantity : '-'+item.quantity 
      });
      results.push({ item: inv.name, success: true, old_qty: oldQty, new_qty: newQty });
    });

    // Mark OCR as applied
    try { db.prepare('UPDATE ocr_records SET auto_applied=1, verified_by=? WHERE id=?').run(req.user.name, ocr_id); } catch(e) {}

    // Notify manager
    if (applied.length > 0) {
      notify(`Stockroom ${document_type} Applied`, 
        `${applied.length} item(s) updated by ${req.user.name}. ${document_type==='delivery'?'Supplier: '+(supplier||'?'):'Dept: '+(department||'?')}`,
        'info', null, 'manager');
    }

    res.json({ success:true, applied, results, total_applied: applied.length });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ADD ITEM FROM OCR (new item not in inventory) ─────────────────────────────
app.post('/api/stockroom/add-from-ocr', auth, (req, res) => {
  try {
    const {name, brand, model, category, quantity, unit_cost, part_number} = req.body;
    if (!name) return res.status(400).json({error:'Name required'});
    const id  = 'inv-'+Date.now();
    const pn  = part_number || (brand?brand.slice(0,3).toUpperCase()+'-':'')+Date.now().toString().slice(-6);
    db.prepare(`INSERT INTO inventory (id,part_number,name,category,brand,model,quantity,min_quantity,unit_cost) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, pn, name, category||'General', brand||'', model||'', quantity||0, 2, unit_cost||0);
    res.json({id, part_number:pn, message:'New item added to inventory from OCR'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PURCHASE REQUESTS ─────────────────────────────────────────────────────────
app.get('/api/purchase-requests', auth, (req, res) => {
  try { res.json(db.prepare('SELECT * FROM purchase_requests ORDER BY created_at DESC').all()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/purchase-requests', auth, (req, res) => {
  try {
    const id = 'PR-'+Date.now();
    const cnt = db.prepare('SELECT COUNT(*) as c FROM purchase_requests').get().c + 1;
    const prid = 'PR-' + String(cnt).padStart(4,'0') + '-' + new Date().getFullYear();
    const {item_id, item_name, quantity, estimated_cost, reason, priority} = req.body;
    db.prepare(`INSERT INTO purchase_requests (id,item_id,item_name,quantity,estimated_cost,reason,priority,requested_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(prid, item_id||null, item_name, quantity||1, estimated_cost||0, reason||'', priority||'med', req.user.name);
    notify('Purchase Request', `PR for ${item_name} submitted by ${req.user.name}`, 'info', null, 'manager');
    res.json({id:prid, message:'Purchase request submitted'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/purchase-requests/:id/approve', auth, (req, res) => {
  const allowed = ['manager','finance'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({error:'Not authorized'});
  try {
    db.prepare(`UPDATE purchase_requests SET status='approved', approved_by=? WHERE id=?`).run(req.user.name, req.params.id);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PRODUCTION LOGS ───────────────────────────────────────────────────────────
app.get('/api/production/logs', auth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json(db.prepare('SELECT * FROM production_logs ORDER BY created_at DESC LIMIT ?').all(limit));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/production/log', auth, (req, res) => {
  try {
    const {shift, production_volume, efficiency, downtime_minutes, remarks} = req.body;
    const id = 'pl-'+Date.now();
    db.prepare(`INSERT INTO production_logs (id,shift,production_volume,efficiency,downtime_minutes,remarks,logged_by) VALUES (?,?,?,?,?,?,?)`)
      .run(id, shift, production_volume||0, efficiency||0, downtime_minutes||0, remarks||'', req.user.name);
    notify('Production Log', `Shift log submitted by ${req.user.name}`, 'info', null, 'manager');
    res.json({id, message:'Production log saved'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── KPI ───────────────────────────────────────────────────────────────────────
app.get('/api/kpi', auth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 12;
    const kpi = db.prepare('SELECT * FROM kpi_records ORDER BY date DESC LIMIT ?').all(limit);
    res.json({kpi, total: kpi.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/kpi/summary', auth, (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM kpi_records ORDER BY date DESC LIMIT 1').get();
    const joStats = db.prepare('SELECT status, COUNT(*) as count FROM job_orders GROUP BY status').all();
    const ls = db.prepare('SELECT COUNT(*) as c FROM inventory WHERE quantity<=min_quantity AND quantity>0').get().c;
    const os = db.prepare('SELECT COUNT(*) as c FROM inventory WHERE quantity=0').get().c;
    const ap = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active=1').get().c;
    res.json({latest_kpi: latest||{oee:0,availability:0,performance:0,quality:0}, job_order_stats: joStats, low_stock: ls, out_of_stock: os, active_personnel: ap});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CALIBRATION ───────────────────────────────────────────────────────────────
app.get('/api/calibration', auth, (req, res) => {
  try { res.json(db.prepare('SELECT * FROM calibration_records ORDER BY created_at DESC').all()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/calibration', auth, (req, res) => {
  try {
    const id = 'cal-'+Date.now();
    const {instrument_tag,instrument_type,location,as_found_zero,as_found_span,as_left_zero,as_left_span,error_pct,pass_fail,next_due,notes} = req.body;
    db.prepare(`INSERT INTO calibration_records (id,instrument_tag,instrument_type,location,as_found_zero,as_found_span,as_left_zero,as_left_span,error_pct,pass_fail,calibrated_by,calibration_date,next_due,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,date('now'),?,?)`)
      .run(id,instrument_tag,instrument_type||'',location||'',as_found_zero||0,as_found_span||0,as_left_zero||0,as_left_span||0,error_pct||0,pass_fail||'PASS',req.user.name,next_due||'',notes||'');
    res.json({id, message:'Calibration record saved'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── USERS / HR ────────────────────────────────────────────────────────────────
app.get('/api/users', auth, (req, res) => {
  try {
    const allowed = ['manager','supervisor','hr','admin'];
    if (!allowed.includes(req.user.role)) return res.status(403).json({error:'Not authorized'});
    // Use safe column list - fall back if new columns don't exist yet
    let users;
    try {
      users = db.prepare('SELECT id,name,email,role,department,nc_level,employee_id,performance_score,jos_closed,is_active,last_login FROM users ORDER BY department,name').all();
    } catch(e) {
      // Fallback for old schema without jos_closed
      users = db.prepare('SELECT id,name,email,role,department,is_active,last_login FROM users ORDER BY department,name').all();
    }
    res.json(users);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ASSETS ────────────────────────────────────────────────────────────────────
app.get('/api/assets', auth, (req, res) => {
  try {
    let q = 'SELECT * FROM assets WHERE 1=1'; const p = [];
    if (req.query.department) { q+=' AND department=?'; p.push(req.query.department); }
    if (req.query.status)     { q+=' AND status=?'; p.push(req.query.status); }
    q += ' ORDER BY created_at DESC';
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/assets/stats', auth, (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
    const totalVal = db.prepare('SELECT COALESCE(SUM(purchase_cost),0) as v FROM assets').get().v;
    const pending = db.prepare("SELECT COUNT(*) as c FROM asset_transfers WHERE status='pending'").get().c;
    const byDept = db.prepare('SELECT department, COUNT(*) as count FROM assets GROUP BY department').all();
    res.json({total, total_value: totalVal, pending_transfers: pending, by_department: byDept});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/assets', auth, (req, res) => {
  const allowed = ['admin','manager','stockroom'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({error:'Not authorized'});
  try {
    const id = 'ast-'+Date.now();
    const cnt = db.prepare('SELECT COUNT(*) as c FROM assets').get().c + 1;
    const code = 'AST-'+String(cnt).padStart(4,'0');
    const {name,category,brand,model,serial_number,department,location,purchase_cost,assigned_to,notes} = req.body;
    db.prepare(`INSERT INTO assets (id,asset_code,name,category,brand,model,serial_number,department,location,purchase_cost,assigned_to,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,code,name,category||'',brand||'',model||'',serial_number||'',department||'',location||'',purchase_cost||0,assigned_to||null,req.user.name);
    res.json({id,asset_code:code,message:'Asset registered'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/assets/:id', auth, (req, res) => {
  try {
    const {status,department,assigned_to,location} = req.body;
    const sets = []; const p = [];
    if (status)      { sets.push('status=?');      p.push(status); }
    if (department)  { sets.push('department=?');  p.push(department); }
    if (assigned_to) { sets.push('assigned_to=?'); p.push(assigned_to); }
    if (location)    { sets.push('location=?');    p.push(location); }
    if (sets.length) { p.push(req.params.id); db.prepare(`UPDATE assets SET ${sets.join(',')} WHERE id=?`).run(...p); }
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/asset-transfers', auth, (req, res) => {
  try {
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.body.asset_id);
    if (!asset) return res.status(404).json({error:'Asset not found'});
    const id = 'TRF-'+Date.now();
    db.prepare(`INSERT INTO asset_transfers (id,asset_id,asset_name,from_department,to_department,from_person,to_person,reason,requested_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id,asset.id,asset.name,asset.department,req.body.to_department,asset.assigned_to,req.body.to_person,req.body.reason||'',req.user.name);
    notify('Asset Transfer Request',`Transfer of ${asset.name} requested by ${req.user.name}`,'info',null,'manager');
    res.json({id,message:'Transfer request submitted'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/asset-transfers', auth, (req, res) => {
  try { res.json(db.prepare('SELECT * FROM asset_transfers ORDER BY created_at DESC').all()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/asset-transfers/:id/approve', auth, (req, res) => {
  const allowed = ['admin','manager','stockroom'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({error:'Not authorized'});
  try {
    const t = db.prepare('SELECT * FROM asset_transfers WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({error:'Not found'});
    db.prepare(`UPDATE asset_transfers SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(req.user.name, req.params.id);
    db.prepare(`UPDATE assets SET department=?, assigned_to=? WHERE id=?`).run(t.to_department, t.to_person, t.asset_id);
    res.json({success:true,message:'Transfer approved'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── API 404 — must be before frontend catch-all ───────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({error:'API endpoint not found: '+req.method+' '+req.originalUrl});
});

// ── GLOBAL ERROR HANDLER — ensures JSON for API errors ───────────────────────
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(500).json({error: err.message||'Server error'});
  }
  next(err);
});

// ── SPA FALLBACK — only for non-API routes ────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║       FUSION IMS v2.1 — Server Started        ║
╠═══════════════════════════════════════════════╣
║  Local:   http://localhost:${PORT}              ║
║  Network: http://[YOUR-LAN-IP]:${PORT}          ║
║  DB:      fusion.db (SQLite)                  ║
║  AI:      ${API_KEY ? 'Anthropic Claude Connected ✓  ' : 'Set ANTHROPIC_API_KEY in .env  '}  ║
║  Status:  ONLINE                              ║
╚═══════════════════════════════════════════════╝
`);
});

module.exports = app;
