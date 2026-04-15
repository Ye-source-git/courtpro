// Credentials are set in app.html before this script loads
// Edit SUPABASE_URL and SUPABASE_ANON_KEY in app.html
const SUPABASE_URL = window.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';
const { createClient } = supabase;

// Persistent session client -- refresh tokens are stored in localStorage
// and auto-rotated so users stay signed in across browser restarts.
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'courtpro_auth',    // namespaced key in localStorage
    storage: window.localStorage,  // explicit -- avoids cookie conflicts
  }
});

let currentUser = null;
let currentProfile = null;
let selectedRole = null;
let sidebarOpen = false;
let _busy = {};
let _cache = {}; // session cache to avoid redundant queries
let _realtimeSub = null; // Supabase realtime subscription
let _activeRole = null; // for manager/pro dual-role toggle
let _navStack  = [];   // page history for back navigation

// -- Session cache helpers ------------------------------------
function cacheSet(key, val, ttlMs = 30000) {
  _cache[key] = { val, expires: Date.now() + ttlMs };
}
function cacheGet(key) {
  const c = _cache[key];
  if (!c || Date.now() > c.expires) return null;
  return c.val;
}
function cacheClear(prefix) {
  Object.keys(_cache).forEach(k => { if (!prefix || k.startsWith(prefix)) delete _cache[k]; });
}

// ============================================================
// TRUSTED DEVICE SYSTEM
// ============================================================
const TRUSTED_KEY   = 'courtpro_trusted_device';
const TRUSTED_DAYS  = 30;

/** Build a stable device fingerprint from browser properties */
function getDeviceId() {
  const raw = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || '',
    navigator.platform || '',
  ].join('|');
  // Simple deterministic hash -- not crypto, just enough for fingerprinting
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return 'cp_' + Math.abs(h).toString(36);
}

/** Save a trusted device record after successful sign-in */
function saveTrustedDevice(user, profile) {
  const record = {
    userId:   user.id,
    email:    user.email,
    name:     profile.full_name,
    role:     profile.role,
    club:     profile.club_name || '',
    deviceId: getDeviceId(),
    savedAt:  Date.now(),
    expires:  Date.now() + TRUSTED_DAYS * 86400 * 1000,
  };
  try {
    localStorage.setItem(TRUSTED_KEY, JSON.stringify(record));
  } catch(e) {
    // Private browsing or storage blocked -- fail silently
  }
}

/** Read the trusted device record if it's valid and not expired */
function getTrustedDevice() {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record?.userId || !record?.expires) return null;
    if (Date.now() > record.expires) {
      localStorage.removeItem(TRUSTED_KEY);
      return null;
    }
    if (record.deviceId !== getDeviceId()) return null; // different device
    return record;
  } catch(e) {
    return null;
  }
}

/** Clear the trusted device record (on sign out) */
function clearTrustedDevice() {
  try { localStorage.removeItem(TRUSTED_KEY); } catch(e) {}
}

/** Refresh the expiry on each successful session restore (rolling window) */
function refreshTrustedDevice() {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY);
    if (!raw) return;
    const record = JSON.parse(raw);
    record.expires = Date.now() + TRUSTED_DAYS * 86400 * 1000;
    localStorage.setItem(TRUSTED_KEY, JSON.stringify(record));
  } catch(e) {}
}



// ============================================================
// SMARTSEARCH ENGINE
// ============================================================
function smartScore(text, query) {
  if (!text || !query) return 0;
  const t = text.toLowerCase(), q = query.toLowerCase().trim();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.split(/\s+/).some(w => w.startsWith(q))) return 80;
  if (t.includes(q)) return 70;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => t.includes(w))) return 60;
  if (q.length >= 3) {
    let matched = 0;
    for (const ch of q) if (t.includes(ch)) matched++;
    const ratio = matched / q.length;
    if (ratio >= 0.8) return Math.round(ratio * 50);
  }
  return 0;
}
function rankResult(obj, query, fields) {
  let best = 0;
  for (const { key, weight = 1 } of fields) {
    const val = key.split('.').reduce((o, k) => o?.[k], obj);
    const score = smartScore(String(val || ''), query) * weight;
    if (score > best) best = score;
  }
  return best;
}
function debounce(fn, ms = 280) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
function highlight(text, query) {
  if (!text || !query?.trim()) return text || '';
  const idx = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (idx === -1) return text;
  return text.slice(0, idx) + `<mark>${text.slice(idx, idx + query.trim().length)}</mark>` + text.slice(idx + query.trim().length);
}
function doSearch(inputId) {
  const q = (document.getElementById(inputId)?.value || '').toLowerCase().trim();
  const clearBtn = document.getElementById(`${inputId}-clear`);
  if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
  const status = document.getElementById(`${inputId}-status`);
  document.querySelectorAll('.s-row').forEach(row => {
    const score = q ? smartScore(row.textContent.toLowerCase(), q) : 100;
    row.style.display = score > 15 ? '' : 'none';
  });
  if (status) {
    if (q) {
      const visible = [...document.querySelectorAll('.s-row')].filter(r => r.style.display !== 'none').length;
      status.style.display = 'block';
      status.textContent = `${visible} result${visible !== 1 ? 's' : ''}`;
    } else { status.style.display = 'none'; }
  }
}
function searchBar(id, placeholder = 'Search...') {
  return `<div class="smart-search-wrap" style="padding:10px 16px;border-bottom:1px solid var(--border);">
    <div style="position:relative;">
      <div style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-tertiary);pointer-events:none;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <input class="search-input" id="${id}" type="text" placeholder="${placeholder}" autocomplete="off" style="padding-left:30px;" oninput="doSearch('${id}')" onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"/>
      <button id="${id}-clear" onclick="document.getElementById('${id}').value='';doSearch('${id}');this.style.display='none';" style="display:none;position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-tertiary);font-size:15px;padding:2px 4px;line-height:1;">X</button>
    </div>
    <div id="${id}-status" style="display:none;font-size:11px;color:var(--text-tertiary);padding:4px 2px 0;"></div>
  </div>`;
}

async function smartSearchPros(query, containerEl, options = {}) {
  const { showAddBtn = false, showBookBtn = false } = options;
  if (!query) {
    containerEl.innerHTML = '<div style="font-size:13px;color:var(--text-tertiary);padding:8px 0;">Search by name, city, certification, or specialty...</div>';
    return;
  }
  containerEl.innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row" style="width:70%;"></div>`;
  const cacheKey = `pros_search_${query}`;
  let results = cacheGet(cacheKey);
  if (!results) {
    const [r1,r2,r3,r4,r5] = await Promise.all([
      db.from('profiles').select('*, pro_profile:pro_profiles(*)').eq('role','pro').ilike('full_name',`%${query}%`),
      db.from('profiles').select('*, pro_profile:pro_profiles(*)').eq('role','pro').ilike('certification',`%${query}%`),
      db.from('profiles').select('*, pro_profile:pro_profiles(*)').eq('role','pro').ilike('club_name',`%${query}%`),
      db.from('pro_profiles').select('*, pro:pro_id(*)').ilike('specialties',`%${query}%`),
      db.from('pro_profiles').select('*, pro:pro_id(*)').or(`location_city.ilike.%${query}%,location_state.ilike.%${query}%`),
    ]);
    const seen = new Set();
    results = [];
    const fields = [{key:'full_name',weight:3},{key:'certification',weight:2},{key:'club_name',weight:1.5}];
    for (const r of [r1,r2,r3]) for (const p of r.data||[]) if (!seen.has(p.id)) { seen.add(p.id); results.push({...p,_score:rankResult(p,query,fields)}); }
    for (const r of [r4,r5]) for (const pp of r.data||[]) { const pro=pp.pro; if (pro&&!seen.has(pro.id)) { seen.add(pro.id); results.push({...pro,pro_profile:[pp],_score:rankResult(pp,query,[{key:'specialties',weight:2},{key:'location_city',weight:1.5},{key:'location_state',weight:1.5}])}); } }
    results.sort((a,b)=>b._score-a._score);
    cacheSet(cacheKey, results, 15000);
  }
  if (!results.length) {
    containerEl.innerHTML = `<div style="padding:20px 0;text-align:center;"><div style="font-size:22px;margin-bottom:6px;">[*]</div><div style="font-size:13.5px;font-weight:500;margin-bottom:3px;">No pros found for "${query}"</div><div style="font-size:12px;color:var(--text-tertiary);">Try name, city, state, or certification (USPTA, PTR)</div></div>`;
    return;
  }
  containerEl.innerHTML = `<div style="font-size:11px;color:var(--text-tertiary);padding:5px 0 8px;">${results.length} result${results.length!==1?'s':''}</div>` +
    results.slice(0,12).map(p => {
      const pp = Array.isArray(p.pro_profile) ? p.pro_profile[0] : p.pro_profile;
      const isMyClub = currentProfile?.club_name && p.club_name === currentProfile.club_name;
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;flex-shrink:0;border:1.5px solid var(--border);">
          ${pp?.portrait_url?`<img src="${pp.portrait_url}" style="width:100%;height:100%;object-fit:cover;"/>`:`<div style="width:100%;height:100%;background:var(--brand-dim);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--brand-text);">${fmt.initials(p.full_name)}</div>`}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:500;">${highlight(p.full_name,query)}</div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:1px;">${highlight(p.certification||'Tennis Pro',query)}${p.club_name?' . '+highlight(p.club_name,query):''}${pp?.location_city?' . '+highlight(pp.location_city,query)+(pp.location_state?', '+pp.location_state:''):''}</div>
          ${pp?.specialties?`<div style="font-size:11px;color:var(--brand);margin-top:2px;">${highlight(pp.specialties,query)}</div>`:''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;">
          ${p.private_rate?`<div style="font-size:12px;font-weight:500;">${fmt.money(p.private_rate)}/hr</div>`:''}
          ${isMyClub?'<span class="badge badge-green" style="font-size:10px;">Your club</span>':''}
          ${showAddBtn&&!isMyClub?`<button class="btn btn-sm btn-primary" onclick="addProToClub('${p.id}','${encodeURIComponent(p.full_name)}')">Add</button>`:''}
          ${showBookBtn?`<button class="btn btn-sm btn-primary" onclick="openProRequestModal('${p.id}','${encodeURIComponent(p.full_name)}',${p.private_rate||120})">Request</button>`:''}
        </div>
      </div>`;
    }).join('');
}

async function smartSearchJobs(query, containerEl) {
  if (!query) {
    const { data } = await db.from('job_postings').select('*, manager:manager_id(full_name)').eq('active',true).order('created_at',{ascending:false});
    renderJobList(data||[], '', containerEl); return;
  }
  containerEl.innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row" style="width:60%"></div>`;
  const [r1,r2,r3,r4] = await Promise.all([
    db.from('job_postings').select('*, manager:manager_id(full_name)').eq('active',true).ilike('title',`%${query}%`),
    db.from('job_postings').select('*, manager:manager_id(full_name)').eq('active',true).ilike('club_name',`%${query}%`),
    db.from('job_postings').select('*, manager:manager_id(full_name)').eq('active',true).ilike('location',`%${query}%`),
    db.from('job_postings').select('*, manager:manager_id(full_name)').eq('active',true).ilike('description',`%${query}%`),
  ]);
  const typeMap = {'full time':'full_time','full-time':'full_time','part time':'part_time','part-time':'part_time','summer':'summer'};
  const typeMatch = typeMap[query.toLowerCase()];
  let r5 = {data:[]};
  if (typeMatch) r5 = await db.from('job_postings').select('*, manager:manager_id(full_name)').eq('active',true).eq('job_type',typeMatch);
  const seen = new Set(); const results = [];
  const fields = [{key:'title',weight:3},{key:'club_name',weight:2.5},{key:'location',weight:2},{key:'description',weight:1}];
  for (const r of [r1,r2,r3,r4,r5]) for (const j of r.data||[]) if (!seen.has(j.id)) { seen.add(j.id); results.push({...j,_score:rankResult(j,query,fields)}); }
  results.sort((a,b)=>b._score-a._score);
  renderJobList(results, query, containerEl);
}

function renderJobList(jobs, query, containerEl) {
  const typeLabels = {full_time:'Full-time',part_time:'Part-time',summer:'Summer'};
  const typeColors = {full_time:'badge-blue',part_time:'badge-green',summer:'badge-amber'};
  if (!jobs.length) {
    containerEl.innerHTML = `<div style="padding:32px 16px;text-align:center;"><div style="font-size:22px;margin-bottom:6px;">[work]</div><div style="font-size:13.5px;font-weight:500;margin-bottom:3px;">${query?`No jobs matching "${query}"`:'No open positions'}</div><div style="font-size:12px;color:var(--text-tertiary);">Try club name, city, or position type</div></div>`;
    return;
  }
  containerEl.innerHTML = jobs.map(j=>`
    <div class="s-row" style="padding:18px 16px;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
        <div style="flex:1;"><div style="font-size:15px;font-weight:600;margin-bottom:4px;">${highlight(j.title,query)}</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:3px;">${highlight(j.club_name,query)} . ${highlight(j.location||'Location not specified',query)}</div>
          ${j.rate_range?`<div style="font-size:13px;color:var(--brand);font-weight:500;">${j.rate_range}</div>`:''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <span class="badge ${typeColors[j.job_type]||'badge-gray'}">${typeLabels[j.job_type]||j.job_type}</span>
          <div style="font-size:11px;color:var(--text-tertiary);">${fmt.relativeDate(j.created_at)}</div>
        </div>
      </div>
      ${j.description?`<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:10px;">${highlight(j.description,query)}</div>`:''}
      ${j.requirements?`<div style="background:var(--bg);border-radius:6px;padding:9px 12px;font-size:12.5px;margin-bottom:10px;"><span style="font-weight:500;">Requirements: </span>${highlight(j.requirements,query)}</div>`:''}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="font-size:12px;color:var(--text-tertiary);">Posted by ${j.manager?.full_name||'Club manager'}</div>
      </div>
    </div>`).join('');
}

// ============================================================
// TENNIS CONSTANTS
// ============================================================
// ============================================================
// SPORT SYSTEM - multi-sport constants
// ============================================================
const SPORTS = {
  tennis: {
    label: 'Tennis',
    icon: '[T]',
    color: 'var(--brand)',
    skills: [
      {id:'first_serve',label:'First serve',cat:'Technique'},
      {id:'second_serve',label:'Second serve',cat:'Technique'},
      {id:'forehand',label:'Forehand',cat:'Technique'},
      {id:'backhand',label:'Backhand',cat:'Technique'},
      {id:'forehand_slice',label:'Forehand slice',cat:'Technique'},
      {id:'backhand_slice',label:'Backhand slice',cat:'Technique'},
      {id:'forehand_volley',label:'Forehand volley',cat:'Net game'},
      {id:'backhand_volley',label:'Backhand volley',cat:'Net game'},
      {id:'overhead',label:'Overhead / smash',cat:'Net game'},
      {id:'return_first',label:'Return of first serve',cat:'Return'},
      {id:'return_second',label:'Return of second serve',cat:'Return'},
      {id:'approach_shot',label:'Approach shot',cat:'Tactics'},
      {id:'passing_shot',label:'Passing shot',cat:'Tactics'},
      {id:'serve_tactics',label:'Serve tactics',cat:'Tactics'},
      {id:'court_positioning',label:'Court positioning',cat:'Tactics'},
      {id:'footwork',label:'Footwork',cat:'Physical'},
      {id:'split_step',label:'Split step',cat:'Physical'},
      {id:'recovery',label:'Court recovery',cat:'Physical'},
      {id:'mental_pressure',label:'Playing under pressure',cat:'Mental'},
      {id:'concentration',label:'Concentration',cat:'Mental'},
      {id:'match_play',label:'Match play tactics',cat:'Mental'},
    ],
    focusAreas: ['First serve mechanics','Second serve kick','Forehand technique','Backhand technique',
      'Forehand slice','Backhand slice','Net approach','Volley technique','Overhead','Return of serve',
      'Baseline tactics','Serve and volley','Mental game','Match play','Footwork','Physical conditioning','General lesson'],
    drills: [
      {name:'Cross-court forehand rally',cat:'Groundstrokes',level:'Beginner',dur:'10 min',desc:'Rally cross-court forehands focusing on topspin, consistency and depth.',skills:['forehand'],videoUrl:'https://www.youtube.com/results?search_query=cross+court+forehand+tennis+drill'},
      {name:'Down-the-line backhand',cat:'Groundstrokes',level:'Beginner',dur:'10 min',desc:'Hit backhand groundstrokes down the line to a target. Focus on shoulder rotation.',skills:['backhand'],videoUrl:''},
      {name:'Serve and first ball',cat:'Serve',level:'Intermediate',dur:'15 min',desc:'Serve then play the next ball aggressively. Connect serve direction with first ball pattern.',skills:['first_serve','forehand'],videoUrl:''},
      {name:'Second serve targets',cat:'Serve',level:'Intermediate',dur:'15 min',desc:'Hit 50 second serves to a target cone. Track % in - aim for 80%+.',skills:['second_serve'],videoUrl:''},
      {name:'Figure 8 rally',cat:'Groundstrokes',level:'Intermediate',dur:'12 min',desc:'Alternate cross-court forehand then cross-court backhand in a figure-8 pattern.',skills:['forehand','backhand'],videoUrl:''},
      {name:'Approach shot and volley',cat:'Net game',level:'Intermediate',dur:'15 min',desc:'Coach feeds short ball. Hit approach down the line, close net and put away the volley.',skills:['approach_shot','forehand_volley','backhand_volley'],videoUrl:''},
      {name:'Kick serve recovery',cat:'Serve',level:'Advanced',dur:'15 min',desc:'Serve kick serve to backhand then immediately recover to center mark and play the point.',skills:['second_serve','recovery','footwork'],videoUrl:''},
      {name:'Inside-out forehand',cat:'Tactics',level:'Advanced',dur:'15 min',desc:'Run around the backhand and hit inside-out forehand to the opponent\'s backhand corner.',skills:['forehand','footwork','court_positioning'],videoUrl:''},
      {name:'Return and rally',cat:'Return',level:'Intermediate',dur:'15 min',desc:'Partner serves at 75%. Neutralize return cross-court and build from defensive position.',skills:['return_first','return_second'],videoUrl:''},
      {name:'Net pressure drill',cat:'Net game',level:'Advanced',dur:'10 min',desc:'Two at net, one feeds volleys. First-volley placement then put away.',skills:['forehand_volley','backhand_volley','overhead'],videoUrl:''},
      {name:'Pressure points (5-5 tiebreak)',cat:'Mental',level:'All levels',dur:'20 min',desc:'Play tiebreaks from 5-5. Every point is pressure. Focus on breathing and percentage tennis.',skills:['mental_pressure','concentration','match_play'],videoUrl:''},
      {name:'Spider / cone sprint',cat:'Physical',level:'All levels',dur:'8 min',desc:'Set 5 balls at corners and center. Sprint to each. 5 reps.',skills:['footwork','recovery','split_step'],videoUrl:''},
      {name:'Split step timing',cat:'Physical',level:'Beginner',dur:'10 min',desc:'Partner feeds randomly. Player must split step as partner contacts ball. 50 reps.',skills:['split_step','footwork','recovery'],videoUrl:''},
      {name:'Short court mini-rally',cat:'Touch',level:'All levels',dur:'10 min',desc:'Both players inside service boxes. Rally using slice, touch, and angle.',skills:['forehand_slice','backhand_slice','forehand_volley'],videoUrl:''},
    ],
  },
  pickleball: {
    label: 'Pickleball',
    icon: '[PK]',
    color: 'var(--info)',
    skills: [
      {id:'serve_pb',label:'Serve accuracy',cat:'Technique'},
      {id:'return_pb',label:'Return of serve',cat:'Technique'},
      {id:'forehand_drive',label:'Forehand drive',cat:'Technique'},
      {id:'backhand_drive',label:'Backhand drive',cat:'Technique'},
      {id:'dink_cross',label:'Cross-court dink',cat:'Kitchen game'},
      {id:'dink_line',label:'Down-the-line dink',cat:'Kitchen game'},
      {id:'third_shot_drop',label:'Third shot drop',cat:'Strategy'},
      {id:'third_shot_drive',label:'Third shot drive',cat:'Strategy'},
      {id:'atp',label:'Around-the-post (ATP)',cat:'Advanced'},
      {id:'erne',label:'Erne',cat:'Advanced'},
      {id:'reset',label:'Reset / neutralize',cat:'Defense'},
      {id:'block_volley',label:'Block volley',cat:'Defense'},
      {id:'speed_up',label:'Speed-up attack',cat:'Offense'},
      {id:'overhead_pb',label:'Overhead smash',cat:'Offense'},
      {id:'movement_pb',label:'Court movement',cat:'Physical'},
      {id:'kitchen_footwork',label:'Kitchen line footwork',cat:'Physical'},
      {id:'stacking',label:'Stacking (doubles)',cat:'Strategy'},
      {id:'poaching',label:'Poaching',cat:'Strategy'},
    ],
    focusAreas: ['Serve mechanics','Third shot drop','Dinking consistency','Kitchen line play','Attacking from mid-court',
      'Reset game','Speed-ups & counters','Movement & positioning','Doubles strategy','Mental toughness','General lesson'],
    drills: [
      {name:'Cross-court dink rally',cat:'Kitchen game',level:'Beginner',dur:'10 min',desc:'Rally cross-court dinks from kitchen line to kitchen line. Focus on arc and consistency.',skills:['dink_cross'],videoUrl:''},
      {name:'Third shot drop practice',cat:'Strategy',level:'Intermediate',dur:'15 min',desc:'Feed from transition zone, hit third shot drop to land in kitchen. 30 reps per side.',skills:['third_shot_drop'],videoUrl:''},
      {name:'Dink-to-speed-up drill',cat:'Offense',level:'Intermediate',dur:'15 min',desc:'Rally dinks until partner lifts ball, then attack with speed-up. Focus on compact swing.',skills:['dink_cross','speed_up'],videoUrl:''},
      {name:'Reset from bangers',cat:'Defense',level:'Intermediate',dur:'15 min',desc:'Partner drives hard. Focus on soft hands to neutralize and reset to kitchen.',skills:['reset','block_volley'],videoUrl:''},
      {name:'Erne practice',cat:'Advanced',level:'Advanced',dur:'10 min',desc:'Practice the Erne from both sides. Time the jump to volley from outside the kitchen.',skills:['erne'],videoUrl:''},
      {name:'Serve target practice',cat:'Technique',level:'Beginner',dur:'10 min',desc:'Serve to cones placed in deep corners. Track percentage hitting target.',skills:['serve_pb'],videoUrl:''},
      {name:'Stacking drill (doubles)',cat:'Strategy',level:'Intermediate',dur:'20 min',desc:'Practice stacking formation with partner to keep stronger player on forehand side.',skills:['stacking'],videoUrl:''},
      {name:'Kitchen line footwork',cat:'Physical',level:'All levels',dur:'8 min',desc:'Lateral shuffle along kitchen line, maintaining ready position. React to ball feeds.',skills:['kitchen_footwork','movement_pb'],videoUrl:''},
    ],
  },
  padel: {
    label: 'Padel',
    icon: '[PD]',
    color: 'var(--pkl)',
    skills: [
      {id:'serve_padel',label:'Serve',cat:'Technique'},
      {id:'bandeja',label:'Bandeja',cat:'Overhead'},
      {id:'vibora',label:'Vibora',cat:'Overhead'},
      {id:'bajada_wall',label:'Bajada de pared',cat:'Wall shots'},
      {id:'off_back_wall',label:'Off-back-wall play',cat:'Wall shots'},
      {id:'lob_padel',label:'Lob',cat:'Defensive'},
      {id:'chiquita',label:'Chiquita',cat:'Net play'},
      {id:'volley_padel',label:'Volley at net',cat:'Net play'},
      {id:'globo',label:'Globo',cat:'Defensive'},
      {id:'position_net',label:'Net position dominance',cat:'Tactics'},
      {id:'side_wall',label:'Side wall reading',cat:'Wall shots'},
      {id:'movement_padel',label:'Court movement',cat:'Physical'},
    ],
    focusAreas: ['Serve & third ball','Wall play fundamentals','Net dominance','Overhead weapons','Lob & defense',
      'Side wall reading','Back wall baseline play','Partner coordination','General lesson'],
    drills: [
      {name:'Back wall rally',cat:'Wall shots',level:'Beginner',dur:'10 min',desc:'Allow ball to bounce off back wall and play the return. Focus on reading the rebound angle.',skills:['off_back_wall'],videoUrl:''},
      {name:'Bandeja practice',cat:'Overhead',level:'Intermediate',dur:'15 min',desc:'Coach lobs from baseline. Hit bandeja overhead with topspin back toward baseline corners.',skills:['bandeja'],videoUrl:''},
      {name:'Net dominance drill',cat:'Net play',level:'Intermediate',dur:'15 min',desc:'Both players at net, rally and practice put-away volleys when opportunity arises.',skills:['volley_padel','position_net'],videoUrl:''},
      {name:'Lob and recover',cat:'Defensive',level:'Beginner',dur:'10 min',desc:'Practice defensive lob to buy time, then recover to back of court and prepare for return.',skills:['lob_padel'],videoUrl:''},
    ],
  },
  squash: {
    label: 'Squash',
    icon: '[SQ]',
    color: 'var(--danger)',
    skills: [
      {id:'serve_squash',label:'Serve',cat:'Technique'},
      {id:'forehand_drive',label:'Forehand drive',cat:'Technique'},
      {id:'backhand_drive',label:'Backhand drive',cat:'Technique'},
      {id:'forehand_drop',label:'Forehand drop',cat:'Short game'},
      {id:'backhand_drop',label:'Backhand drop',cat:'Short game'},
      {id:'boast',label:'Boast',cat:'Short game'},
      {id:'lob_squash',label:'Lob',cat:'Defensive'},
      {id:'volley_squash',label:'Volley',cat:'Attacking'},
      {id:'nick',label:'Nick shot',cat:'Attacking'},
      {id:'tee_movement',label:'T-position movement',cat:'Footwork'},
      {id:'ghosting',label:'Ghosting',cat:'Footwork'},
      {id:'retrieval',label:'Ball retrieval',cat:'Physical'},
    ],
    focusAreas: ['Straight drives','Cross-court patterns','Short game & drops','Volley game','Movement from T',
      'Boast & counter drop','Lob defense','Match tactics','General lesson'],
    drills: [
      {name:'Straight drive rally',cat:'Technique',level:'Beginner',dur:'10 min',desc:'Both players rally straight drives down the wall. Ball should die in back corner.',skills:['forehand_drive','backhand_drive'],videoUrl:''},
      {name:'Boast and cross-court',cat:'Short game',level:'Intermediate',dur:'15 min',desc:'One player boasts, other hits cross-court. Continuous pattern. Focus on width.',skills:['boast','forehand_drive'],videoUrl:''},
      {name:'Drop and lob',cat:'Short game',level:'Intermediate',dur:'12 min',desc:'Alternate drop shot and lob from front of court. Practice disguise on both shots.',skills:['forehand_drop','lob_squash'],videoUrl:''},
      {name:'Ghosting drill',cat:'Footwork',level:'All levels',dur:'8 min',desc:'Move to all 4 corners then T without ball, maintaining split step and recovery.',skills:['ghosting','tee_movement'],videoUrl:''},
    ],
  },
  badminton: {
    label: 'Badminton',
    icon: '[BD]',
    color: 'var(--warning)',
    skills: [
      {id:'serve_bad',label:'Serve (short & long)',cat:'Technique'},
      {id:'clear',label:'Clear',cat:'Rear court'},
      {id:'smash',label:'Smash',cat:'Attacking'},
      {id:'drop_shot',label:'Drop shot',cat:'Net play'},
      {id:'net_shot',label:'Net shot / tumble',cat:'Net play'},
      {id:'lift_bad',label:'Lift',cat:'Defensive'},
      {id:'block_bad',label:'Block',cat:'Defensive'},
      {id:'drive',label:'Drive',cat:'Mid-court'},
      {id:'footwork_bad',label:'Footwork & split step',cat:'Physical'},
      {id:'jump_smash',label:'Jump smash',cat:'Attacking'},
      {id:'deception',label:'Deception',cat:'Tactics'},
      {id:'doubles_rotation',label:'Doubles rotation',cat:'Tactics'},
    ],
    focusAreas: ['Serve accuracy','Smash power & direction','Net play','Clear & drop combination',
      'Footwork patterns','Drive game','Defensive lifting','Doubles rotation','General lesson'],
    drills: [
      {name:'Multi-shuttle smash',cat:'Attacking',level:'Intermediate',dur:'10 min',desc:'Coach feeds shuttles to rear court. Hit continuous smashes focusing on wrist snap and direction.',skills:['smash'],videoUrl:''},
      {name:'Net tumble practice',cat:'Net play',level:'Intermediate',dur:'12 min',desc:'Partner feeds to net. Practice tight tumbling net shots that clip the tape.',skills:['net_shot'],videoUrl:''},
      {name:'Clear and drop pattern',cat:'Rear court',level:'Beginner',dur:'15 min',desc:'Alternate clear and drop from rear court. Focus on disguising intention until last moment.',skills:['clear','drop_shot'],videoUrl:''},
      {name:'4-corner footwork',cat:'Physical',level:'All levels',dur:'8 min',desc:'Move to all 4 corners using split step and lunge technique. 10 sets of 4 corners.',skills:['footwork_bad'],videoUrl:''},
    ],
  },
};

// Active sport - derived from user profile
function getActiveSport() {
  return currentProfile?.sport || 'tennis';
}
function getSportConfig() {
  return SPORTS[getActiveSport()] || SPORTS.tennis;
}
function getSportSkills() { return getSportConfig().skills; }
function getSportDrills() { return getSportConfig().drills; }
function getSportFocusAreas() { return getSportConfig().focusAreas; }

// Legacy aliases for backward compatibility
const TENNIS_SKILLS = SPORTS.tennis.skills.map(s => ({...s, category: s.cat}));
const DRILL_LIBRARY = SPORTS.tennis.drills;
const LESSON_FOCUS_AREAS = SPORTS.tennis.focusAreas;





// ============================================================
// INIT & AUTH
// ============================================================
async function init() {
  injectGlobalStyles();
  showSplash(); // Show loading screen while we check session

  if (SUPABASE_URL === 'YOUR_SUPABASE_URL' || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
    hideSplash();
    document.body.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:Inter,sans-serif;padding:24px;background:#F8F9FA;"><div style="max-width:480px;text-align:center;"><div style="font-size:40px;margin-bottom:16px;">[!]</div><div style="font-size:22px;font-weight:700;margin-bottom:10px;color:#111;">Setup required</div><div style="font-size:14px;color:#555;line-height:1.8;margin-bottom:24px;">Open <code style="background:#E5E7EB;padding:2px 8px;border-radius:4px;font-family:monospace;">app.js</code> and replace <strong>lines 1 and 2</strong> with your actual Supabase credentials.</div><div style="background:#FEF3C7;border:1px solid #D97706;border-radius:10px;padding:16px;font-size:13px;color:#92400E;text-align:left;line-height:1.8;"><strong>Line 1:</strong> const SUPABASE_URL = "https://yourproject.supabase.co";<br/><strong>Line 2:</strong> const SUPABASE_ANON_KEY = "eyJyour-actual-key";</div></div></div>`;
    return;
  }

  // Handle manager invite URL params before anything else
  const params = new URLSearchParams(window.location.search);
  const mgrId = params.get('mgr_invite');
  if (mgrId) { sessionStorage.setItem('mgr_invite_id', mgrId); window.history.replaceState({}, '', window.location.pathname); }

  // -- Step 1: Try to restore existing Supabase session ------
  // With persistSession:true + autoRefreshToken:true, Supabase
  // will silently refresh expired tokens from localStorage.
  // Test Supabase connectivity - show user-friendly error if unreachable
  let session = null;
  try {
    const { data, error: sessionError } = await db.auth.getSession();
    if (sessionError) {
      console.error('Supabase session error:', sessionError);
      // Show a visible warning but don't block the auth screen
    }
    session = data?.session || null;
  } catch(e) {
    console.error('Supabase connectivity error:', e);
    hideSplash();
    const authScreen = document.getElementById('auth-screen');
    if (authScreen) {
      authScreen.style.display = 'flex';
      const errBanner = document.createElement('div');
      errBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#FEE2E2;border-bottom:2px solid #DC2626;padding:12px 20px;font-size:13px;color:#991B1B;font-family:Inter,sans-serif;z-index:999;text-align:center;';
      errBanner.textContent = 'Cannot connect to CourtPro servers. Check your internet connection.';
      document.body.prepend(errBanner);
    }
    const trusted = getTrustedDevice();
    showAuth(trusted);
    return;
  }
  const hasSession = session?.user;

  if (hasSession) {
    // Active session -- go straight to the app
    currentUser = session.user;
    refreshTrustedDevice(); // Extend 30-day rolling window
    const ok = await loadProfile();
    hideSplash();
    if (ok) {
      showApp();
      scheduleReminders();
      requestNotificationPermission();
      startRealtimeNotifications();
    } else {
      showAuth();
    }
  } else {
    // -- Step 2: No active session -- check trusted device --
    hideSplash();
    const trusted = getTrustedDevice();
    showAuth(trusted); // Pass trusted record to pre-fill email
  }

  // -- Auth state listener ------------------------------------
  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      currentProfile = null;
      _activeRole = null;
      cacheClear();
      if (_realtimeSub) { _realtimeSub.unsubscribe(); _realtimeSub = null; }
      showAuth();
    }
    if (event === 'TOKEN_REFRESHED' && session) {
      // Token silently refreshed -- update currentUser in case it changed
      currentUser = session.user;
    }
  });
}

/** Lightweight splash screen shown during session restore */
function showSplash() {
  const s = document.getElementById('auth-screen');
  const a = document.getElementById('app-screen');
  if (s) s.style.display = 'none';
  if (a) a.style.display = 'none';
  let splash = document.getElementById('cp-splash');
  if (!splash) {
    splash = document.createElement('div');
    splash.id = 'cp-splash';
    splash.style.cssText = "position:fixed;inset:0;background:#F0F0EC;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;font-family:Inter,sans-serif;";
    splash.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--brand,#0F7B5F);display:flex;align-items:center;justify-content:center;">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="white" stroke-width="1.5"/>
            <path d="M8 1.5C8 1.5 11 5 11 8C11 11 8 14.5 8 14.5" stroke="white" stroke-width="1.2"/>
            <path d="M8 1.5C8 1.5 5 5 5 8C5 11 8 14.5 8 14.5" stroke="white" stroke-width="1.2"/>
            <path d="M1.5 8H14.5" stroke="white" stroke-width="1.2"/>
          </svg>
        </div>
        <span style="font-size:22px;font-weight:600;color:#1A1A1A;">Court<span style="color:var(--brand,#0F7B5F);">Pro</span></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <div class="splash-dot"></div>
        <div class="splash-dot" style="animation-delay:0.15s;"></div>
        <div class="splash-dot" style="animation-delay:0.3s;"></div>
      </div>`;
    // Inject splash dot animation
    const style = document.createElement('style');
    style.textContent = '.splash-dot{width:7px;height:7px;border-radius:50%;background:var(--brand,#0F7B5F);opacity:0.3;animation:splash-pulse 0.9s ease-in-out infinite;} @keyframes splash-pulse{0%,100%{opacity:0.3;transform:scale(1);}50%{opacity:1;transform:scale(1.3);}}';
    document.head.appendChild(style);
    document.body.appendChild(splash);
  }
  splash.style.display = 'flex';
}

function hideSplash() {
  const splash = document.getElementById('cp-splash');
  if (splash) {
    splash.style.transition = 'opacity 0.2s';
    splash.style.opacity = '0';
    setTimeout(() => splash.remove(), 220);
  }
}

async function loadProfile() {
  const { data, error } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
  if (error || !data) return false;
  currentProfile = data;
  return true;
}

function showAuth(trusted = null) {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
  showPanel('signin');

  // If this is a trusted device, pre-fill the email and show a warm greeting
  if (trusted?.email) {
    const emailInput = document.getElementById('si-email');
    const passwordInput = document.getElementById('si-password');
    const heading = document.querySelector('#panel-signin .auth-heading');
    const subtext = document.querySelector('#panel-signin .auth-sub');

    if (emailInput) {
      emailInput.value = trusted.email;
      // Move focus to password since email is already filled
      setTimeout(() => passwordInput?.focus(), 100);
    }

    // Personalise the heading
    if (heading && trusted.name) {
      heading.textContent = `Welcome back, ${trusted.name.split(' ')[0]}!`;
    }
    if (subtext && trusted.club) {
      subtext.textContent = `${trusted.club}`;
    }

    // Show a "Not you?" link so a different user can clear it
    const errEl = document.getElementById('si-error');
    if (errEl) {
      errEl.style.color = 'var(--brand)';
      errEl.innerHTML = `Signed in as <strong>${trusted.email}</strong> . <a href="#" onclick="clearTrustedDeviceAndReset();return false;" style="color:var(--text-tertiary);font-size:12px;">Not you?</a>`;
    }
  }
}

function clearTrustedDeviceAndReset() {
  clearTrustedDevice();
  const emailInput   = document.getElementById('si-email');
  const heading      = document.querySelector('#panel-signin .auth-heading');
  const subtext      = document.querySelector('#panel-signin .auth-sub');
  const errEl        = document.getElementById('si-error');
  if (emailInput) emailInput.value = '';
  if (heading)   heading.textContent = 'Welcome back';
  if (subtext)   subtext.textContent = 'Sign in to your CourtPro account';
  if (errEl)     errEl.textContent = '';
  document.getElementById('si-email')?.focus();
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  _activeRole = currentProfile.role;
  buildSidebar();
  if (!currentProfile.onboarding_done) { runOnboarding(); return; }
  go('dashboard');
}

function showPanel(name) {
  document.getElementById('panel-signin').style.display = name === 'signin' ? 'block' : 'none';
  document.getElementById('panel-signup').style.display = name === 'signup' ? 'block' : 'none';
  const siErr = document.getElementById('si-error');
  const suErr = document.getElementById('su-error');
  if (siErr) siErr.textContent = '';
  if (suErr) suErr.textContent = '';
  if (name === 'signup') {
    const mgrId = sessionStorage.getItem('mgr_invite_id');
    if (mgrId) {
      setTimeout(() => { selectRole('pro'); }, 50);
      db.from('profiles').select('club_name,full_name').eq('id', mgrId).single().then(({ data }) => {
        if (data?.club_name) {
          const ci = document.getElementById('su-club');
          if (ci) { ci.value = data.club_name; ci.readOnly = true; }
          const err = document.getElementById('su-error');
          if (err) { err.style.color = 'var(--brand)'; err.textContent = `Invited to join ${data.club_name} by ${data.full_name || 'the manager'}.`; }
        }
      });
    }
  }
}

function selectRole(role) {
  selectedRole = role;
  document.querySelectorAll('.role-option').forEach(el => el.classList.toggle('selected', el.dataset.role === role));
  document.getElementById('su-pro-fields').style.display = role === 'pro' ? 'block' : 'none';
}

async function doSignIn() {
  const email    = document.getElementById('si-email').value.trim();
  const password = document.getElementById('si-password').value;
  const remember = document.getElementById('si-remember')?.checked ?? true;
  const errEl    = document.getElementById('si-error');
  const btn      = document.getElementById('si-btn');

  errEl.style.color = '';
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Please enter your email and password.'; return; }

  btn.disabled = true;
  btn.innerHTML = '<span style="display:flex;align-items:center;gap:8px;justify-content:center;"><span class="spinner" style="border-top-color:white;border-color:rgba(255,255,255,0.3);"></span>Signing in...</span>';

  const { data, error } = await db.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (error) {
    console.error('Sign in error:', error);
    errEl.style.color = 'var(--danger)';
    errEl.style.background = 'var(--danger-dim)';
    errEl.style.padding = '8px 12px';
    errEl.style.borderRadius = '8px';
    errEl.style.marginBottom = '8px';
    if (error.message.includes('Invalid') || error.message.includes('invalid')) {
      errEl.textContent = 'Incorrect email or password.';
    } else if (error.message.includes('Email not confirmed')) {
      errEl.textContent = 'Please confirm your email address first. Check your inbox.';
    } else if (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('Failed')) {
      errEl.textContent = 'Connection error - check your internet connection and try again.';
    } else {
      errEl.textContent = error.message;
    }
    return;
  }

  currentUser = data.user;
  const ok = await loadProfile();
  if (!ok) { errEl.textContent = 'Profile not found. Please sign up.'; return; }

  // Save or clear the trusted device record based on checkbox
  if (remember) {
    saveTrustedDevice(data.user, currentProfile);
  } else {
    clearTrustedDevice();
  }

  showApp();
  scheduleReminders();
  requestNotificationPermission();
  startRealtimeNotifications();
}

async function doSignUp() {
  const name = document.getElementById('su-name').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-password').value;
  const club = document.getElementById('su-club').value.trim();
  const errEl = document.getElementById('su-error');
  const btn = document.getElementById('su-btn');
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Please enter your full name.'; return; }
  if (!email) { errEl.textContent = 'Please enter your email.'; return; }
  if (!password || password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (!selectedRole) { errEl.textContent = 'Please select your role.'; return; }
  // Club is optional -- defaults to 'Independent' if not provided
  btn.disabled = true; btn.textContent = 'Creating account...';
  const { data, error } = await db.auth.signUp({ email, password });
  if (error) {
    btn.disabled = false; btn.textContent = 'Create account';
    console.error('Sign up error:', error);
    errEl.style.color = 'var(--danger)';
    if (error.message.includes('already registered') || error.message.includes('already been registered')) {
      errEl.textContent = 'An account with this email already exists. Try signing in instead.';
    } else if (error.message.includes('Password')) {
      errEl.textContent = 'Password must be at least 6 characters.';
    } else {
      errEl.textContent = error.message;
    }
    return;
  }
  const profileData = {
    id: data.user.id, full_name: name, role: selectedRole, club_name: club.trim() || null, sport: (document.getElementById('su-sport')?.value || 'tennis'), onboarding_done: false,
    certification: document.getElementById('su-cert')?.value.trim() || null,
    private_rate: selectedRole === 'pro' ? parseFloat(document.getElementById('su-private-rate')?.value) || 120 : null,
    clinic_rate: selectedRole === 'pro' ? parseFloat(document.getElementById('su-clinic-rate')?.value) || 30 : null,
  };
  const mgrInviteId = sessionStorage.getItem('mgr_invite_id');
  if (mgrInviteId && selectedRole === 'pro') {
    sessionStorage.removeItem('mgr_invite_id');
    const { data: mgr } = await db.from('profiles').select('club_name').eq('id', mgrInviteId).single();
    if (mgr?.club_name) profileData.club_name = mgr.club_name;
  }
  await db.from('profiles').insert(profileData);
  btn.disabled = false; btn.textContent = 'Create account';
  currentUser = data.user; currentProfile = profileData;
  saveTrustedDevice(data.user, currentProfile); // auto-trust device on signup
  showApp(); requestNotificationPermission();
}

async function doSignOut() {
  _activeRole = null;
  clearTrustedDevice(); // Remove "stay signed in" for this device
  await db.auth.signOut();
}

// -- Onboarding wizard --------------------------------------
function runOnboarding() {
  const role = currentProfile.role;
  const steps = {
    pro: [
      { icon: '[T]', title: `Welcome, ${currentProfile.full_name.split(' ')[0]}!`, body: 'CourtPro helps you manage lessons, track earnings, and grow your coaching career.', btn: 'Get started' },
      { icon: 'CAL', title: 'Log your first lesson', body: 'Record a lesson to start tracking your earnings and client history.', btn: 'Log a lesson', action: () => { completeOnboarding(); modalLogLesson(); } },
      { icon: '[user]', title: 'Complete your pro profile', body: 'Add a photo and bio so clubs can find you on the job board.', btn: 'Set up profile', action: () => { completeOnboarding(); go('myprofile'); } },
    ],
    manager: [
      { icon: '[club]', title: `Welcome to ${currentProfile.club_name}!`, body: 'CourtPro helps you manage your pros, schedule lessons, and track club performance.', btn: 'Get started' },
      { icon: '[T]', title: 'Add your first pro', body: 'Share your invite link with pros at your club to get them on the platform.', btn: 'Add a pro', action: () => { completeOnboarding(); go('addpro'); } },
      { icon: 'CAL', title: 'Assign your first lesson', body: 'Schedule a lesson between a pro and a member to start tracking activity.', btn: 'Assign lesson', action: () => { completeOnboarding(); modalAssignLesson(); } },
    ],
    client: [
      { icon: '[wave]', title: `Welcome, ${currentProfile.full_name.split(' ')[0]}!`, body: 'Track your lessons, see notes from your coach, and follow your progress -- all in one place.', btn: 'Get started' },
      { icon: 'CAL', title: 'Book your first lesson', body: 'Browse available pros and request a lesson directly from the app.', btn: 'Request a lesson', action: () => { completeOnboarding(); go('book'); } },
      { icon: '[T]', title: 'Log a match', body: 'Track your match results to build your stats and appear on the club leaderboard.', btn: 'Log a match', action: () => { completeOnboarding(); modalLogMatch(); } },
    ],
  };
  let stepIdx = 0;
  const roleSteps = steps[role] || steps.client;
  function showStep(i) {
    const s = roleSteps[i];
    const isLast = i === roleSteps.length - 1;
    openModal(`
      <div style="text-align:center;padding:8px 0 4px;">
        <div style="font-size:40px;margin-bottom:14px;">${s.icon}</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;">${s.title}</div>
        <div style="font-size:13.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:24px;max-width:320px;margin-left:auto;margin-right:auto;">${s.body}</div>
        <div style="display:flex;gap:6px;justify-content:center;margin-bottom:20px;">
          ${roleSteps.map((_,j)=>`<div style="width:7px;height:7px;border-radius:50%;background:${j===i?'var(--brand)':'var(--border)'};transition:background 0.2s;"></div>`).join('')}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button class="btn btn-primary" onclick="${s.action ? 'onboardingAction()' : i < roleSteps.length-1 ? `onboardingNext()` : `completeOnboarding()`}">${s.btn}</button>
          ${i > 0 ? `<button class="btn" onclick="onboardingSkip()">Skip for now</button>` : `<button class="btn" onclick="onboardingNext()">Next</button>`}
        </div>
      </div>`);
    window.onboardingNext = () => { stepIdx++; if (stepIdx < roleSteps.length) showStep(stepIdx); else completeOnboarding(); };
    window.onboardingAction = () => { if (s.action) s.action(); };
    window.onboardingSkip = () => completeOnboarding();
  }
  showStep(0);
}

async function completeOnboarding() {
  closeModal();
  await db.from('profiles').update({ onboarding_done: true }).eq('id', currentProfile.id);
  currentProfile.onboarding_done = true;
  go('dashboard');
}

// -- Notifications ------------------------------------------
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
}

function sendPushNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(title, { body, icon: '/favicon.ico' });
}

async function startRealtimeNotifications() {
  if (!currentProfile) return;
  if (_realtimeSub) _realtimeSub.unsubscribe();
  _realtimeSub = db.channel('notifications')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'notifications',
      filter: `user_id=eq.${currentProfile.id}`
    }, (payload) => {
      const n = payload.new;
      showInAppBanner(n.title, n.body || '', 'info');
      sendPushNotification(n.title, n.body || '');
      updateNotificationBadge();
    })
    .subscribe();
}

async function createNotification(userId, type, title, body, linkPage) {
  await db.from('notifications').insert({ user_id: userId, type, title, body: body || null, link_page: linkPage || null });
}

async function updateNotificationBadge() {
  const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', currentProfile.id).eq('read', false);
  const badge = document.getElementById('notif-badge');
  if (badge) { badge.textContent = count || ''; badge.style.display = count > 0 ? 'flex' : 'none'; }
}

async function markNotificationsRead() {
  await db.from('notifications').update({ read: true }).eq('user_id', currentProfile.id).eq('read', false);
  updateNotificationBadge();
}

async function scheduleReminders() {
  if (!currentProfile || currentProfile.role === 'manager') return;
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 3600000).toISOString();
  const field = currentProfile.role === 'pro' ? 'pro_id' : 'client_id';
  const { data: lessons } = await db.from('lessons').select('*').eq(field, currentProfile.id).in('status', ['upcoming', 'confirmed']).gte('scheduled_at', now.toISOString()).lte('scheduled_at', in48h);
  if (!lessons?.length) return;
  lessons.forEach(lesson => {
    const lessonTime = new Date(lesson.scheduled_at);
    const msUntil = lessonTime - now;
    const timeStr = lessonTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const dateStr = lessonTime.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    if (msUntil > 0) {
      const t24 = msUntil - 86400000, t1h = msUntil - 3600000, t15 = msUntil - 900000;
      if (t24 > 0) setTimeout(() => showInAppBanner('Lesson tomorrow', `${lesson.type} at ${timeStr} . ${lesson.court || 'TBD'} . ${dateStr}`, 'info'), t24);
      if (t1h > 0) setTimeout(() => showInAppBanner('Lesson in 1 hour', `${lesson.type} at ${timeStr} . ${lesson.court || 'TBD'}`, 'warning'), t1h);
      if (t15 > 0) setTimeout(() => { showInAppBanner('Lesson starting soon!', `${lesson.type} at ${timeStr} . Head to ${lesson.court || 'your court'}`, 'warning'); sendPushNotification('CourtPro -- 15 minutes!', `Your lesson starts at ${timeStr}`); }, t15);
    } else if (msUntil > -86400000) {
      // lesson within last 24h and upcoming status -- show reminder now
      if (msUntil > -7200000) showInAppBanner('Lesson soon', `${lesson.type} at ${timeStr} . ${lesson.court || 'TBD'}`, 'warning');
    }
  });
}

function showInAppBanner(title, body, type = 'info') {
  const colors = { info: { bg:'#E6F1FB', border:'#185FA5', text:'#0C447C' }, warning: { bg:'#FAEEDA', border:'#EF9F27', text:'#633806' }, success: { bg:'#E1F5EE', border:'#1D9E75', text:'#085041' } };
  const c = colors[type] || colors.info;
  const b = document.createElement('div');
  b.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);background:${c.bg};border:1.5px solid ${c.border};color:${c.text};padding:13px 18px;border-radius:10px;font-size:13.5px;font-weight:500;font-family:'Inter',sans-serif;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.12);max-width:400px;width:90%;display:flex;align-items:center;gap:12px;`;
  b.innerHTML = `<div style="flex:1;"><div style="font-weight:600;margin-bottom:2px;">${title}</div><div style="font-size:12.5px;opacity:0.85;">${body}</div></div><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;font-size:16px;color:${c.text};padding:0 4px;opacity:0.7;line-height:1;">X</button>`;
  document.body.appendChild(b);
  setTimeout(() => { if (b.parentElement) b.remove(); }, 7000);
}

function injectGlobalStyles() {
  const saved = localStorage.getItem('cp_theme');
  if (saved === 'dark') document.documentElement.setAttribute('data-theme','dark');
  if (document.getElementById('cp-injected-styles')) return;
  const s = document.createElement('style');
  s.id = 'cp-injected-styles';
  s.textContent = `
    /* Legacy skeleton */
    .skeleton-row { height: 14px; background: linear-gradient(90deg, var(--bg-sunken) 25%, var(--surface-hover) 50%, var(--bg-sunken) 75%); background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: 6px; margin-bottom: 10px; }
    /* Legacy quick-action fallback */
    .quick-action { display:flex;flex-direction:column;align-items:center;gap:7px;padding:16px 10px;background:var(--bg-sunken);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:all 0.15s;font-family:'Inter',sans-serif; }
    .quick-action:hover { background:var(--brand-dim);border-color:var(--brand);transform:translateY(-1px); }
    .quick-action-icon { width:38px;height:38px;border-radius:10px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 1px 3px rgba(0,0,0,0.07); }
    .quick-action-label { font-size:11.5px;font-weight:500;color:var(--text-secondary);text-align:center;line-height:1.3; }
    .quick-actions { display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:16px 20px; }
    /* Payment pill */
    .payment-pill { display:inline-flex;align-items:center;gap:4px;border-radius:20px;padding:3px 10px;font-size:11px;font-weight:500; }
    .payment-paid { background:var(--success-dim);color:var(--success); }
    .payment-unpaid { background:var(--warning-dim);color:var(--warning); }
    /* Calendar */
    .cal-grid { display:grid;grid-template-columns:repeat(7,1fr);gap:2px; }
    .cal-day { padding:5px;min-height:66px;background:var(--bg-sunken);border-radius:8px;font-size:11px;cursor:pointer;transition:background 0.1s;border:1px solid transparent; }
    .cal-day:hover { background:var(--brand-dim);border-color:var(--brand); }
    .cal-day.today { background:var(--brand-dim);border-color:var(--brand); }
    .cal-day-num { font-size:12px;font-weight:600;color:var(--text-tertiary);line-height:1;margin-bottom:3px; }
    .cal-day.today .cal-day-num { color:var(--brand);font-weight:700; }
    .cal-event { background:var(--brand);color:white;border-radius:3px;padding:2px 5px;font-size:9.5px;font-weight:500;margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis; }
    .cal-event.pkl { background:var(--pkl); }
    /* Info grid */
    .info-grid { display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:0; }
    .info-box { padding:12px 20px;background:var(--surface); }
    .info-lbl { font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:500;margin-bottom:3px; }
    .info-val { font-size:14px;font-weight:600;color:var(--text-primary); }
    /* Right stack */
    .right-stack { display:flex;flex-direction:column;gap:14px; }
    /* s-row flex */
    .s-row { display:flex;align-items:center;gap:10px;flex-wrap:wrap; }
    /* Status dot */
    .list-status-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0; }
    .list-status-dot.green { background:var(--success); }
    .list-status-dot.red { background:var(--danger); }
    .list-status-dot.blue { background:var(--info); }
    /* Mono */
    .mono { font-family:'JetBrains Mono',monospace;font-size:12.5px;font-weight:500; }
    /* Streak badge */
    .streak-badge { display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#FF6B35,#F7931A);color:white;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600; }
    /* Notif panel */
    .notif-panel { position:fixed;top:calc(var(--topbar-h) + 8px);right:16px;width:360px;max-height:480px;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-xl);z-index:200;overflow:hidden;display:flex;flex-direction:column; }
    /* Card header (legacy alias) */
    .card-head { padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border); }
    .card-title { font-size:14px;font-weight:600;color:var(--text-primary);letter-spacing:-0.2px; }
    .card-action { font-size:12.5px;font-weight:500;color:var(--brand);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:4px 8px;border-radius:6px; }
    .card-action:hover { background:var(--brand-dim); }
    /* Two col */
    .two-col { display:grid;grid-template-columns:1fr 360px;gap:16px;align-items:start; }
    @media(max-width:1100px){ .two-col { grid-template-columns:1fr; } }
    /* Legacy dot */
    .dot { width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--text-tertiary); }
    /* Drill filter */
    .drill-filter { font-size:12.5px;font-weight:500; }
    .drill-filter.btn-primary { background:var(--brand);color:white;border-color:var(--brand); }
    /* Search bar */
    .search-bar-wrap { position:relative;padding:14px 20px;border-bottom:1px solid var(--border); }
    .search-bar-wrap input { background:var(--bg-sunken);border-color:transparent;padding-left:34px;border-radius:20px;font-size:13.5px; }
    .search-bar-wrap input:focus { background:var(--surface);border-color:var(--brand);border-radius:8px; }
    .search-bar-icon { position:absolute;left:32px;top:50%;transform:translateY(-50%);color:var(--text-quaternary);pointer-events:none; }
    /* Misc mobile */
    @media(max-width:768px){ .quick-actions{grid-template-columns:repeat(3,1fr);gap:8px;} .two-col{grid-template-columns:1fr;} .page-container{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px));} }
    @media(max-width:480px){ .quick-actions{grid-template-columns:repeat(3,1fr);gap:6px;} .quick-action{padding:12px 8px;} }
  `;
  document.head.appendChild(s);
}


// -- Session cache helpers ------------------------------------


// -- Swipe back gesture (mobile) ----------------------------
function setupSwipeBack() {
  const el = document.getElementById('page-container');
  if (!el) return;
  let startX = 0, startY = 0;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = Math.abs(e.changedTouches[0].clientY - startY);
    if (dx > 60 && dy < 60 && startX < 40) goBack();
  }, { passive: true });
}
function buildSidebar() {
  const role = _activeRole || currentProfile.role;
  const dbRole = currentProfile.role;
  const initials = currentProfile.full_name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);

  // Update role pill
  const pill = document.getElementById('role-pill');
  if (pill) {
    pill.className = 'sidebar-role-pill ' + role;
    pill.textContent = role==='pro' ? 'Pro' : role==='manager' ? 'Manager' : 'Member';
  }

  // Update avatar + footer
  const av = document.getElementById('profile-avatar');
  if (av) {
    av.textContent = initials;
    const avatarColors = { pro: ['var(--brand-dim)','var(--brand-text)'], manager: ['var(--info-dim)','var(--info)'], client: ['var(--pkl-dim)','var(--pkl-text)'] };
    const [bg, color] = avatarColors[role] || avatarColors.client;
    av.style.background = bg;
    av.style.color = color;
  }

  const nameEl = document.getElementById('profile-name');
  const clubEl = document.getElementById('profile-club');
  if (nameEl) nameEl.textContent = currentProfile.full_name;
  if (clubEl) clubEl.textContent = currentProfile.club_name || 'Independent';

  const nav = document.getElementById('main-nav');
  if (!nav) return;
  nav.innerHTML = '';

  // Portal toggle for dual-role (manager who coaches)
  if (dbRole === 'manager') {
    const isProMode = role === 'pro';
    const toggleDiv = document.createElement('div');
    toggleDiv.style.cssText = 'padding:6px 10px 8px;border-bottom:1px solid var(--sidebar-border);margin-bottom:4px;';
    toggleDiv.innerHTML = `
      <div style="font-size:10px;font-weight:600;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;padding:0 2px;">View as</div>
      <div class="portal-toggle">
        <button class="portal-toggle-btn ${!isProMode?'active':''}" onclick="switchPortalRole('manager')">Manager</button>
        <button class="portal-toggle-btn ${isProMode?'active':''}" onclick="switchPortalRole('pro')">Pro</button>
      </div>`;
    nav.appendChild(toggleDiv);
  }

  // Build nav sections
  const sections = NAV_STRUCTURE[role] || [];
  sections.forEach(section => {
    const label = document.createElement('span');
    label.className = 'nav-section-label';
    label.textContent = section.label;
    nav.appendChild(label);

    section.items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'nav-btn';
      btn.dataset.page = item.id;
      const icon = NAV_ICONS[item.id] || NAV_ICONS.dashboard;
      btn.innerHTML = `${icon}<span>${item.text}</span>`;
      btn.onclick = () => { go(item.id); toggleSidebar(false); };
      nav.appendChild(btn);
    });
  });

  setActiveNav(_navStack[_navStack.length-1] || 'dashboard');
}

function switchPortalRole(role) {
  _activeRole = role;
  _navStack = [];
  cacheClear();
  buildSidebar();
  buildBottomNav();
  setupSwipeBack();
  go('dashboard');
}

function setActiveNav(pageId) {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.page===pageId));
}
function toggleSidebar(force) {
  const sidebar = document.getElementById('sidebar');
  sidebarOpen = force!==undefined?force:!sidebarOpen;
  sidebar.classList.toggle('open', sidebarOpen);
}

function go(pageId, pushHistory = true) {
  // Track navigation stack for back button
  const currentPage = _navStack.length ? _navStack[_navStack.length - 1] : null;
  if (pushHistory && currentPage && currentPage !== pageId) {
    _navStack.push(pageId);
  } else if (!pushHistory) {
    // Called from goBack -- stack already managed
  } else {
    if (!_navStack.length) _navStack.push(pageId);
    else _navStack[_navStack.length - 1] = pageId;
  }
  setActiveNav(pageId);
  updateBottomNav(pageId);
  document.getElementById('topbar-title').textContent = PAGE_TITLES[pageId]||'';
  document.getElementById('topbar-actions').innerHTML = '';
  // Show/hide back button in topbar
  const backBtn = document.getElementById('topbar-back');
  if (backBtn) backBtn.style.display = _navStack.length > 1 ? 'flex' : 'none';
  const el = document.getElementById('page-container');
  el.innerHTML = `<div style="padding:24px 16px;"><div class="skeleton-row" style="width:60%;height:18px;margin-bottom:16px;"></div><div class="skeleton-row" style="width:100%;height:80px;margin-bottom:12px;"></div><div class="skeleton-row" style="width:100%;height:80px;"></div></div>`;
  const role = _activeRole || currentProfile.role;
  const map = {
    pro:{dashboard:pgProDashboard,lessons:pgProLessons,clinics:pgProClinics,calendar:pgCalendar,earnings:pgProEarnings,notes:pgProNotes,clients:pgProClients,invite:pgProInvite,availability:pgProAvailability,myprofile:pgProMyProfile,jobs:pgJobBoard,invoices:pgProInvoices,community:pgCommunity,proboard:pgProBoard,settings:pgSettings,recurring:pgRecurring,courts:pgCourtBooking},
    manager:{dashboard:pgMgrDashboard,schedule:pgMgrSchedule,calendar:pgCalendar,pros:pgMgrPros,addpro:pgMgrAddPro,feedback:pgMgrFeedback,rates:pgMgrRates,announce:pgMgrAnnounce,postjob:pgMgrPostJob,jobs:pgMgrBrowsePros,applications:pgMgrApplications,messages:pgMgrMessages,community:pgCommunity,mgrboard:pgMgrBoard,settings:pgSettings,analytics:pgMgrAnalytics,courts:pgCourtBooking},
    client:{dashboard:pgClientDashboard,upcoming:pgClientUpcoming,book:pgClientBook,notes:pgClientNotes,devplan:pgClientDevPlan,matchlog:pgClientMatchLog,mypro:pgClientMyPro,findpro:pgClientFindPro,history:pgClientHistory,progress:pgClientProgress,drills:pgClientDrills,leaderboard:pgClientLeaderboard,family:pgFamilyMembers,community:pgCommunity,settings:pgSettings,courts:pgCourtBooking},
  };
  if (map[role]?.[pageId]) map[role][pageId](el);
}

function goBack() {
  if (_navStack.length <= 1) return;
  _navStack.pop();
  const prev = _navStack[_navStack.length - 1];
  if (prev) go(prev, false);
}

function updateBottomNav(pageId) {
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
}

function buildBottomNav() {
  let existing = document.getElementById('bottom-nav');
  if (existing) existing.remove();
  const role = _activeRole || currentProfile.role;
  // Define the 5 most important pages per role for bottom nav
  const tabs = {
    pro:     [{id:'dashboard',icon:'#',label:'Home'},{id:'lessons',icon:'CAL',label:'Lessons'},{id:'calendar',icon:'CAL',label:'Calendar'},{id:'notes',icon:'NOTE',label:'Notes'},{id:'recurring',icon:'RPT',label:'Recurring'}],
    manager: [{id:'dashboard',icon:'#',label:'Home'},{id:'schedule',icon:'CAL',label:'Schedule'},{id:'analytics',icon:'STAT',label:'Analytics'},{id:'pros',icon:'PPL',label:'Pros'},{id:'applications',icon:'LIST',label:'Hiring'}],
    client:  [{id:'dashboard',icon:'#',label:'Home'},{id:'upcoming',icon:'CAL',label:'Lessons'},{id:'book',icon:'[*]',label:'Request'},{id:'notes',icon:'NOTE',label:'Notes'},{id:'progress',icon:'[chart]',label:'Progress'}],
  };
  const roleTabs = tabs[role] || [];
  const nav = document.createElement('nav');
  nav.id = 'bottom-nav';
  nav.className = 'bottom-nav';
  roleTabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'bottom-nav-btn';
    btn.dataset.page = tab.id;
    btn.innerHTML = `<span class="bnav-icon">${tab.icon}</span><span class="bnav-label">${tab.label}</span>`;
    btn.onclick = () => { go(tab.id); if (sidebarOpen) toggleSidebar(false); };
    nav.appendChild(btn);
  });
  document.getElementById('app-screen')?.appendChild(nav);
}

// -- Core helpers --------------------------------------------
const fmt = {
  date: ts => ts?new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'--',
  time: ts => ts?new Date(ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'',
  money: n => '$'+Math.round(n||0).toLocaleString(),
  initials: name => name?.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2)||'?',
  dayName: d => ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d],
  relativeDate: ts => { if(!ts)return'--'; const diff=(new Date()-new Date(ts))/1000; if(diff<3600)return`${Math.round(diff/60)}m ago`; if(diff<86400)return`${Math.round(diff/3600)}h ago`; if(diff<604800)return`${Math.round(diff/86400)}d ago`; return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'}); },
};

// ============================================================
// CORE UI UTILITIES
// ============================================================

function toast(msg, type) {
  var c = document.getElementById('toast-container');
  if (!c) return;
  var t = document.createElement('div');
  t.className = 'toast' + (type ? ' toast-' + type : '');
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 3400);
}

function openModal(html) {
  var mc = document.getElementById('modal-container');
  if (!mc) return;
  mc.innerHTML = '<div class="modal-overlay" onclick="handleOverlayClick(event)">' +
    '<div class="modal-box" onclick="event.stopPropagation()">' + html + '</div></div>';
  document.body.style.overflow = 'hidden';
}

function handleOverlayClick(e) {
  if (e.target.classList.contains('modal-overlay')) closeModal();
}

function closeModal() {
  var mc = document.getElementById('modal-container');
  if (mc) mc.innerHTML = '';
  document.body.style.overflow = '';
}

function saveBusy(btnId, busy, label) {
  var btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = busy;
  if (label) btn.textContent = label;
}

function emptyState(icon, title, desc, btnText, btnAction) {
  return '<div class="empty-state">' +
    '<span class="empty-state-icon">' + icon + '</span>' +
    '<div class="empty-state-title">' + title + '</div>' +
    '<div class="empty-state-desc">' + desc + '</div>' +
    (btnText && btnAction ? '<button class="btn btn-primary btn-sm" onclick="' + btnAction + '">' + btnText + '</button>' : '') +
    '</div>';
}

function paymentPill(s) {
  if (s === 'paid')   return '<span class="badge badge-paid"   style="font-size:11px;">Paid</span>';
  if (s === 'waived') return '<span class="badge badge-neutral" style="font-size:11px;">Waived</span>';
  return '<span class="badge badge-unpaid" style="font-size:11px;">Unpaid</span>';
}

function skillBar(skill, value) {
  var pct = Math.round((value / 10) * 100);
  var color = value >= 7 ? 'var(--success)' : value >= 4 ? 'var(--brand)' : 'var(--warning)';
  return '<div class="skill-bar-wrap">' +
    '<div class="skill-bar-header">' +
    '<span class="skill-bar-label">' + (skill.label || skill.id || '') + '</span>' +
    '<span class="skill-bar-value" style="color:' + color + ';">' + (value > 0 ? value + '/10' : 'Not rated') + '</span>' +
    '</div>' +
    '<div class="skill-bar-track">' +
    '<div class="skill-bar-fill" style="width:' + pct + '%;background:' + color + ';"></div>' +
    '</div></div>';
}

function actionBtn(label, cls, action) {
  var ta = document.getElementById('topbar-actions');
  if (!ta) return;
  // Remove previous action buttons (not the theme/notif/signout ones)
  ta.querySelectorAll('.topbar-action-btn').forEach(function(b) { b.remove(); });
  var btn = document.createElement('button');
  btn.className = 'btn ' + (cls || '') + ' topbar-action-btn';
  btn.textContent = label;
  btn.onclick = function() { eval(action); };
  ta.insertBefore(btn, ta.firstChild);
}

function markInvoicePaid(id) {
  db.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', id)
    .then(function(result) {
      if (result.error) { toast('Error: ' + result.error.message, 'error'); return; }
      toast('Marked as paid!');
      cacheClear();
      go('invoices');
    });
}


function statusBadge(s) {
  const map = {
    confirmed: 'badge-confirmed',
    pending: 'badge-pending',
    declined: 'badge-declined',
    completed: 'badge-brand',
    upcoming: 'badge-upcoming',
    cancelled: 'badge-neutral',
  };
  return `<span class="badge ${map[s]||'badge-neutral'}">${s}</span>`;
}

async function addClientToPro(clientId, clientName) {
  const btn = document.getElementById('add-client-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
  const { error } = await db.from('lessons').insert({
    pro_id: currentProfile.id,
    client_id: clientId,
    client_name: clientName,
    type: 'private',
    scheduled_at: new Date().toISOString(),
    status: 'completed',
    rate: 0,
    duration_minutes: 0,
    notes: 'Client linked by pro'
  });
  if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  cacheClear('pro_clients');
  toast(clientName + ' added to your clients!');
  closeModal();
  go('clients');
}

async function modalAddClientToPro() {
  var r = await db.from('profiles')
    .select('id, full_name, club_name')
    .eq('role', 'client')
    .order('full_name');
  var members = (r.data || []);
  var list = members.filter(function(m) {
    return m.club_name === currentProfile.club_name || !m.club_name;
  });

  // Build list HTML safely - no inline onclick with string args
  var listHtml;
  if (list.length === 0) {
    listHtml = '<div style="text-align:center;padding:20px;color:var(--text-tertiary);">No members found. Share your invite link to get clients on the platform.</div>';
  } else {
    listHtml = list.map(function(m, idx) {
      var initials = (m.full_name || '?').split(' ').map(function(n){ return n[0]; }).join('').toUpperCase().slice(0,2);
      var name = (m.full_name || 'Unknown').replace(/"/g, '');
      var club = (m.club_name || 'Independent');
      return '<div class="list-item" style="cursor:pointer;" data-cid="' + m.id + '" data-cname="' + name + '" onclick="pickClientFromList(this)">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:var(--brand-dim);color:var(--brand-text);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;">' + initials + '</div>' +
        '<div class="list-item-info"><div class="list-item-title">' + name + '</div>' +
        '<div class="list-item-meta">' + club + '</div></div>' +
        '<span class="badge badge-brand">Add</span></div>';
    }).join('');
  }

  openModal(
    '<div class="modal-title">Add a client</div>' +
    '<div class="form-group"><label class="form-label">Search members</label>' +
    '<input type="text" id="client-search" placeholder="Type a name..." oninput="filterClientList(this.value)" style="margin-bottom:8px;"/></div>' +
    '<div id="client-search-list" style="max-height:300px;overflow-y:auto;">' + listHtml + '</div>' +
    '<div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button></div>'
  );
}

function pickClientFromList(el) {
  var cid = el.getAttribute('data-cid');
  var cname = el.getAttribute('data-cname');
  if (cid && cname) addClientToPro(cid, cname);
}


function filterClientList(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#client-search-list .list-item').forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ============================================================
// PRO PORTAL PAGES (rebuilt clean)
// ============================================================

async function pgProDashboard(el) {
  const sport = getActiveSport();
  const sc = getSportConfig();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const weekStart = new Date(now); weekStart.setDate(now.getDate()-now.getDay()); weekStart.setHours(0,0,0,0);
  const [{ data: lessons }, { data: bookingReqs }, { data: notifs }] = await Promise.all([
    db.from('lessons').select('*, client:client_id(full_name)').eq('pro_id', currentProfile.id).order('scheduled_at', { ascending: true }),
    db.from('booking_requests').select('*, client:client_id(full_name)').eq('pro_id', currentProfile.id).eq('status', 'pending'),
    db.from('notifications').select('*').eq('user_id', currentProfile.id).eq('read', false).limit(5),
  ]);
  const completed = (lessons||[]).filter(l => l.status === 'completed');
  const monthDone = completed.filter(l => l.scheduled_at >= monthStart);
  const weekDone  = completed.filter(l => new Date(l.scheduled_at) >= weekStart);
  const earnings  = monthDone.reduce((s,l) => s+(l.rate||0), 0);
  const weekEarn  = weekDone.reduce((s,l) => s+(l.rate||0), 0);
  const hours     = monthDone.reduce((s,l) => s+(l.duration_minutes||60)/60, 0);
  const pending   = (lessons||[]).filter(l => l.status === 'pending');
  const upcoming  = (lessons||[]).filter(l => (l.status==='upcoming'||l.status==='confirmed') && new Date(l.scheduled_at) > now);
  const nextLesson = upcoming.sort((a,b) => new Date(a.scheduled_at)-new Date(b.scheduled_at))[0];
  const requests  = pending.length + (bookingReqs?.length||0);
  const unread    = notifs?.length || 0;

  actionBtn('+ Log lesson', 'btn-primary', 'modalLogLesson()');

  // Sport switcher tabs
  const sportTabsHtml = `<div class="sport-tabs">
    ${Object.entries(SPORTS).map(([key,s]) => `<button class="sport-tab ${(currentProfile.sport||'tennis')===key?'active':''} ${key==='pickleball'?'pkl':''}" onclick="saveUserSport('${key}')">${s.icon} ${s.label}</button>`).join('')}
  </div>`;

  el.innerHTML = `
    ${sportTabsHtml}
    <div style="padding:20px 24px 0;">

    ${nextLesson ? `
    <div class="hero-card" style="margin-bottom:20px;">
      <div class="hero-label">Next lesson</div>
      <div class="hero-title">${nextLesson.client?.full_name||nextLesson.client_name||'Client'} . ${nextLesson.type}</div>
      <div class="hero-sub">${fmt.date(nextLesson.scheduled_at)} . ${fmt.time(nextLesson.scheduled_at)} . ${nextLesson.court||'TBD'}</div>
      <div style="margin-top:14px;display:flex;gap:8px;">
        <button class="btn btn-sm" style="background:rgba(255,255,255,0.2);color:white;border-color:rgba(255,255,255,0.3);" onclick="markComplete('${nextLesson.id}')">Mark done OK</button>
        <button class="btn btn-sm" style="background:rgba(255,255,255,0.15);color:white;border-color:rgba(255,255,255,0.25);" onclick="go('lessons')">View all</button>
      </div>
    </div>` : ''}

    ${unread > 0 ? `<div style="background:var(--info-dim);border:1px solid var(--info);border-radius:12px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13.5px;font-weight:500;color:var(--info);">[bell] ${unread} new notification${unread!==1?'s':''}</div><button class="btn btn-sm" style="border-color:var(--info);color:var(--info);" onclick="showNotifications()">View</button></div>` : ''}

    <div class="stats-grid" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">This month</div><div class="stat-value">${fmt.money(earnings)}</div><div class="stat-sub">${fmt.money(weekEarn)} this week</div></div>
      <div class="stat-card"><div class="stat-label">Lessons done</div><div class="stat-value">${completed.length}</div><div class="stat-sub">${weekDone.length} this week</div></div>
      <div class="stat-card"><div class="stat-label">Hours on court</div><div class="stat-value">${hours.toFixed(1)}h</div><div class="stat-sub">this month</div></div>
      <div class="stat-card"><div class="stat-label">Requests</div><div class="stat-value" style="${requests>0?'color:var(--warning);':''}">${requests}</div><div class="stat-sub">awaiting you</div></div>
    </div>

    <div class="two-col">
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">Upcoming lessons</div><button class="card-action" onclick="go('lessons')">View all</button></div>
          ${upcoming.length === 0 ? emptyState('CAL','No upcoming lessons','Set your availability so clients can find and book you.','Set availability','go("availability")')
          : upcoming.slice(0,5).map(l => `
            <div class="list-item">
              <div class="list-item-icon" style="background:var(--brand-dim);">[cal]</div>
              <div class="list-item-info">
                <div class="list-item-title">${l.client?.full_name||l.client_name||'Client'} . ${l.type}${l.focus_area?' . '+l.focus_area:''}</div>
                <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${fmt.time(l.scheduled_at)} . ${l.court||'TBD'} . ${fmt.money(l.rate)}</div>
              </div>
              ${statusBadge(l.status)}
              <button class="btn btn-sm btn-primary" onclick="markComplete('${l.id}')">Done</button>
            </div>`).join('')}
        </div>
      </div>
      <div class="right-stack">
        ${requests > 0 ? `<div class="card">
          <div class="card-header"><div class="card-title">Lesson requests</div><span class="badge badge-warning">${requests}</span></div>
          ${[...pending.slice(0,2).map(l => `
            <div style="padding:13px 20px;border-bottom:1px solid var(--border);">
              <div style="font-size:13.5px;font-weight:500;margin-bottom:3px;">${l.client_name||'Lesson request'}</div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">${fmt.date(l.scheduled_at)} . ${fmt.time(l.scheduled_at)}</div>
              <div style="display:flex;gap:6px;"><button class="btn btn-sm btn-primary" onclick="respondLesson('${l.id}','confirmed')">Accept</button><button class="btn btn-sm btn-danger" onclick="respondLesson('${l.id}','declined')">Decline</button></div>
            </div>`),
          ...(bookingReqs||[]).slice(0,2).map(r => `
            <div style="padding:13px 20px;border-bottom:1px solid var(--border);">
              <div style="font-size:13.5px;font-weight:500;margin-bottom:3px;">${r.client?.full_name||'Booking request'}</div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">${fmt.date(r.requested_date)} . ${r.requested_time} . ${r.lesson_type}</div>
              <div style="display:flex;gap:6px;"><button class="btn btn-sm btn-primary" onclick="acceptBooking('${r.id}')">Accept</button><button class="btn btn-sm btn-danger" onclick="declineBooking('${r.id}')">Decline</button></div>
            </div>`)
          ].join('')}
        </div>` : ''}
        <div class="card">
          <div class="card-header"><div class="card-title">Quick actions</div></div>
          <div class="quick-actions" style="grid-template-columns:repeat(3,1fr);">
            <button class="quick-action" onclick="modalScheduleLesson()"><div class="quick-action-icon">[cal]</div><div class="quick-action-label">Schedule</div></button>
            <button class="quick-action" onclick="go('notes')"><div class="quick-action-icon">[note]</div><div class="quick-action-label">Add note</div></button>
            <button class="quick-action" onclick="go('calendar')"><div class="quick-action-icon">[date]</div><div class="quick-action-label">Calendar</div></button>
            <button class="quick-action" onclick="go('earnings')"><div class="quick-action-icon">[$]</div><div class="quick-action-label">Earnings</div></button>
            <button class="quick-action" onclick="go('clients')"><div class="quick-action-icon">[people]</div><div class="quick-action-label">Clients</div></button>
            <button class="quick-action" onclick="exportCalendar()"><div class="quick-action-icon">[export]</div><div class="quick-action-label">Export</div></button>
          </div>
        </div>
      </div>
    </div>
    </div>`;
}

async function pgCalendar(el) {
  const now = new Date();
  const role = _activeRole || currentProfile.role;
  const viewMonth = parseInt(el.dataset.month || now.getMonth());
  const viewYear  = parseInt(el.dataset.year  || now.getFullYear());
  el.dataset.month = viewMonth; el.dataset.year = viewYear;
  const monthStart = new Date(viewYear, viewMonth, 1);
  const monthEnd   = new Date(viewYear, viewMonth+1, 0);
  const field = role==='pro' ? 'pro_id' : role==='client' ? 'client_id' : null;
  let lessons = [];
  if (field) {
    const { data } = await db.from('lessons').select('*, client:client_id(full_name), pro:pro_id(full_name)')
      .eq(field, currentProfile.id).gte('scheduled_at', monthStart.toISOString()).lte('scheduled_at', monthEnd.toISOString()).order('scheduled_at');
    lessons = data || [];
  } else {
    const proIds = await getClubProIds();
    if (proIds.length) {
      const { data } = await db.from('lessons').select('*, client:client_id(full_name), pro:pro_id(full_name)')
        .in('pro_id', proIds).gte('scheduled_at', monthStart.toISOString()).lte('scheduled_at', monthEnd.toISOString()).order('scheduled_at');
      lessons = data || [];
    }
  }
  const byDay = {};
  lessons.forEach(l => { const d = new Date(l.scheduled_at).getDate(); if (!byDay[d]) byDay[d]=[]; byDay[d].push(l); });
  const startDow = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const monthName = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  actionBtn('+ Schedule', 'btn-primary', role==='pro' ? 'modalScheduleLesson()' : role==='manager' ? 'modalAssignLesson()' : 'go("book")');
  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <button class="btn btn-sm btn-icon" onclick="calNav(-1)"></button>
        <div class="card-title" style="flex:1;text-align:center;">${monthName}</div>
        <button class="btn btn-sm btn-icon" onclick="calNav(1)"></button>
      </div>
      <div style="padding:16px;">
        <div class="cal-grid" style="margin-bottom:6px;">
          ${['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div style="text-align:center;font-size:11px;font-weight:600;color:var(--text-quaternary);padding:4px 0;">${d}</div>`).join('')}
        </div>
        <div class="cal-grid">
          ${Array(startDow).fill('<div></div>').join('')}
          ${Array.from({length:daysInMonth},(_,i) => {
            const day = i+1;
            const isToday = day===now.getDate() && viewMonth===now.getMonth() && viewYear===now.getFullYear();
            const dayLessons = byDay[day] || [];
            return `<div class="cal-day${isToday?' today':''}" onclick="showDayDetail(${day},${viewMonth},${viewYear})">
              <div class="cal-day-num">${day}</div>
              ${dayLessons.slice(0,2).map(l => `<div class="cal-event ${(l.sport||'tennis')==='pickleball'?'pkl':''}">${fmt.time(l.scheduled_at)} ${l.client?.full_name||l.client_name||''}</div>`).join('')}
              ${dayLessons.length > 2 ? `<div style="font-size:9px;color:var(--text-quaternary);padding:1px 4px;">+${dayLessons.length-2}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="card-footer">
        <div style="font-size:13px;color:var(--text-tertiary);">${lessons.length} lesson${lessons.length!==1?'s':''} this month</div>
      </div>
    </div>`;
  window._calLessons = lessons; window._calMonth = viewMonth; window._calYear = viewYear;
}

function calNav(dir) {
  const el = document.getElementById('page-container');
  let m = parseInt(el.dataset.month||new Date().getMonth()), y = parseInt(el.dataset.year||new Date().getFullYear());
  m += dir; if(m>11){m=0;y++;} if(m<0){m=11;y--;}
  el.dataset.month=m; el.dataset.year=y; pgCalendar(el);
}

function showDayDetail(day, month, year) {
  const date = new Date(year,month,day);
  const dateStr = date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const dayLessons = (window._calLessons||[]).filter(l=>new Date(l.scheduled_at).getDate()===day);
  openModal(`<div class="modal-title">${dateStr}</div>
    ${!dayLessons.length ? `<div style="text-align:center;padding:20px;color:var(--text-tertiary);">No lessons scheduled</div>`
    : dayLessons.map(l=>`<div style="padding:12px;background:var(--bg-sunken);border-radius:10px;margin-bottom:8px;">
      <div style="font-size:13.5px;font-weight:600;">${l.client?.full_name||l.client_name||'Client'} . ${l.type}</div>
      <div style="font-size:12.5px;color:var(--text-tertiary);margin-top:3px;">${fmt.time(l.scheduled_at)} . ${l.court||'TBD'} . ${l.duration_minutes||60}min . ${fmt.money(l.rate)}</div>
      ${statusBadge(l.status)}
    </div>`).join('')}
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

async function pgProLessons(el) {
  actionBtn('+ Schedule', 'btn-primary', 'modalScheduleLesson()');
  const { data: lessons } = await db.from('lessons')
    .select('*, client:client_id(full_name)')
    .eq('pro_id', currentProfile.id)
    .order('scheduled_at', { ascending: false });
  const now = new Date().toISOString();
  const upcoming  = (lessons||[]).filter(l => l.status==='upcoming'  && l.scheduled_at >= now);
  const confirmed = (lessons||[]).filter(l => l.status==='confirmed' && l.scheduled_at >= now);
  const pending   = (lessons||[]).filter(l => l.status==='pending');
  const completed = (lessons||[]).filter(l => l.status==='completed');
  const declined  = (lessons||[]).filter(l => l.status==='declined' || l.status==='cancelled');

  function lessonRow(l) {
    return `<div class="list-item s-row" style="flex-wrap:wrap;gap:6px;">
      <div class="list-item-info">
        <div class="list-item-title">${l.client?.full_name||l.client_name||'Client'} . ${l.type}${l.focus_area?' . '+l.focus_area:''}</div>
        <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${fmt.time(l.scheduled_at)} . ${l.court||'TBD'} . ${fmt.money(l.rate)}</div>
      </div>
      ${statusBadge(l.status)}
      ${l.status==='upcoming'||l.status==='confirmed' ? `<button class="btn btn-sm btn-primary" onclick="markComplete('${l.id}')">Done OK</button>` : ''}
      ${l.status==='completed' ? `<button class="btn btn-sm" onclick="markPaid('${l.id}')">Mark paid</button><button class="btn btn-sm" onclick="modalAddNoteForLesson('${l.id}','${l.client_id||''}','${encodeURIComponent(l.client?.full_name||l.client_name||'')}')">+ Note</button>` : ''}
      ${l.status==='pending' ? `<button class="btn btn-sm btn-primary" onclick="respondLesson('${l.id}','confirmed')">Accept</button><button class="btn btn-sm btn-danger" onclick="respondLesson('${l.id}','declined')">Decline</button>` : ''}
    </div>`;
  }

  el.innerHTML = `
    ${upcoming.length+confirmed.length+pending.length > 0 ? `<div class="card" style="margin-bottom:14px;">
      <div class="card-header"><div class="card-title">Upcoming & pending</div><span class="badge badge-info">${upcoming.length+confirmed.length+pending.length}</span></div>
      ${[...pending,...upcoming,...confirmed].sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).map(lessonRow).join('')}
    </div>` : ''}
    <div class="card">
      <div class="card-header"><div class="card-title">Completed</div><span class="badge badge-brand">${completed.length}</span></div>
      ${!completed.length ? emptyState('[T]','No completed lessons','Mark upcoming lessons as done to track your progress.',null,null) : completed.slice(0,20).map(lessonRow).join('')}
    </div>
    ${declined.length ? `<div class="card" style="margin-top:14px;">
      <div class="card-header"><div class="card-title" style="color:var(--text-tertiary);">Declined / Cancelled</div></div>
      ${declined.slice(0,5).map(lessonRow).join('')}
    </div>` : ''}`;
}

async function pgProClinics(el) {
  actionBtn('+ Log clinic', 'btn-primary', 'modalLogClinic()');
  const { data: clinics } = await db.from('clinics').select('*').eq('pro_id', currentProfile.id).order('scheduled_at', { ascending: false });
  const upcoming  = (clinics||[]).filter(c => c.status==='upcoming'  && new Date(c.scheduled_at) > new Date());
  const completed = (clinics||[]).filter(c => c.status==='completed');

  function clinicRow(c) {
    return `<div class="list-item s-row">
      <div class="list-item-icon" style="background:var(--pkl-dim);">[grad]</div>
      <div class="list-item-info">
        <div class="list-item-title">${c.title||'Clinic'}</div>
        <div class="list-item-meta">${fmt.date(c.scheduled_at)} . ${fmt.time(c.scheduled_at)} . ${c.max_students||0} students . ${fmt.money(c.rate_per_student)}/student</div>
      </div>
      ${statusBadge(c.status)}
      ${c.status==='upcoming' ? `<button class="btn btn-sm btn-primary" onclick="markClinicComplete('${c.id}')">Done OK</button>` : ''}
      <button class="btn btn-sm btn-ghost" onclick="modalEditClinic('${c.id}')">Edit</button>
    </div>`;
  }

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total clinics</div><div class="stat-value">${clinics?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">Total students</div><div class="stat-value">${(clinics||[]).reduce((s,c)=>s+(c.max_students||0),0)}</div></div>
      <div class="stat-card"><div class="stat-label">Clinic earnings</div><div class="stat-value">${fmt.money((completed||[]).reduce((s,c)=>s+((c.rate_per_student||0)*(c.max_students||1)),0))}</div></div>
      <div class="stat-card"><div class="stat-label">Upcoming</div><div class="stat-value">${upcoming.length}</div></div>
    </div>
    ${upcoming.length ? `<div class="card" style="margin-bottom:14px;"><div class="card-header"><div class="card-title">Upcoming clinics</div></div>${upcoming.map(clinicRow).join('')}</div>` : ''}
    <div class="card">
      <div class="card-header"><div class="card-title">Completed clinics</div></div>
      ${!completed.length ? emptyState('[grad]','No clinics yet','Log your first group clinic to start tracking.',null,null) : completed.map(clinicRow).join('')}
    </div>`;
}

async function pgProNotes(el) {
  actionBtn('+ Add note', 'btn-primary', 'modalAddNote()');
  const dpBtn = document.createElement('button');
  dpBtn.className = 'btn';
  dpBtn.textContent = '+ Dev plan';
  dpBtn.onclick = modalCreateDevPlan;
  document.getElementById('topbar-actions')?.appendChild(dpBtn);

  const { data: notes } = await db.from('session_notes')
    .select('*, client:client_id(full_name)')
    .eq('pro_id', currentProfile.id)
    .order('created_at', { ascending: false });

  el.innerHTML = `
    ${searchBar('notes-search', 'Search notes...')}
    <div id="notes-list">
      ${!notes?.length ? emptyState('NOTE','No session notes yet','Add a note after each lesson to track client progress and share feedback.','Add first note','modalAddNote()')
      : notes.map(n => `
        <div class="card" style="margin-bottom:10px;" id="note-${n.id}">
          <div class="card-header">
            <div>
              <div class="card-title">${n.client?.full_name||n.client_name||'Client'}</div>
              <div class="card-subtitle">${fmt.date(n.created_at)}${n.focus_area?' . '+n.focus_area:''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${n.category ? `<span class="badge badge-neutral">${n.category}</span>` : ''}
              <span class="badge ${n.shared_with_client?'badge-success':'badge-neutral'}">${n.shared_with_client?'Shared':'Private'}</span>
            </div>
          </div>
          <div style="padding:14px 20px;">
            ${n.what_worked ? `<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:var(--success);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">OK What worked</div><div style="font-size:13.5px;color:var(--text-secondary);line-height:1.6;">${n.what_worked}</div></div>` : ''}
            ${n.pro_notes ? `<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Areas to develop</div><div style="font-size:13.5px;color:var(--text-secondary);line-height:1.6;">${n.pro_notes}</div></div>` : ''}
            ${n.homework ? `<div style="background:var(--pkl-dim);border-radius:8px;padding:10px 14px;margin-bottom:8px;"><div style="font-size:11px;font-weight:600;color:var(--pkl-text);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">[workout] Homework</div><div style="font-size:13px;color:var(--pkl-text);line-height:1.5;">${n.homework}</div></div>` : ''}
            ${n.video_url ? `<div style="margin-top:8px;"><div style="font-size:11px;font-weight:600;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">[video] Reference video</div><a href="${n.video_url}" target="_blank" rel="noopener" style="font-size:13px;color:var(--brand);word-break:break-all;">${n.video_url.length>60?n.video_url.slice(0,57)+'...':n.video_url}</a></div>` : ''}
          </div>
          <div class="card-footer" style="display:flex;gap:8px;">
            <button class="btn btn-sm" onclick="toggleShare('${n.id}',${n.shared_with_client})">${n.shared_with_client?'Unshare':'Share with client'}</button>
            <button class="btn btn-sm btn-ghost" onclick="modalEditNote('${n.id}')">Edit</button>
          </div>
        </div>`).join('')}
    </div>`;
}

async function pgProInvoices(el) {
  const { data: invoices } = await db.from('invoices')
    .select('*, client:client_id(full_name)')
    .eq('pro_id', currentProfile.id)
    .order('created_at', { ascending: false });
  const unpaidTotal = (invoices||[]).filter(i=>i.status!=='paid').reduce((s,i)=>s+(i.amount||0),0);
  const total = (invoices||[]).reduce((s,i)=>s+(i.amount||0),0);

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total invoiced</div><div class="stat-value">${fmt.money(total)}</div></div>
      <div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value" style="color:var(--warning);">${fmt.money(unpaidTotal)}</div></div>
      <div class="stat-card"><div class="stat-label">Invoices</div><div class="stat-value">${invoices?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">Paid</div><div class="stat-value">${(invoices||[]).filter(i=>i.status==='paid').length}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">All invoices</div><button class="btn btn-sm btn-primary" onclick="modalCreateInvoice()">+ Create invoice</button></div>
      ${!invoices?.length ? emptyState('[card]','No invoices yet','Create invoices to track lesson payments professionally.','Create invoice','modalCreateInvoice()')
      : invoices.map(i => `
        <div class="list-item s-row">
          <div class="list-item-info">
            <div class="list-item-title">${i.client?.full_name||'Client'} . ${fmt.money(i.amount)}</div>
            <div class="list-item-meta">Due ${fmt.date(i.due_date)} . Created ${fmt.date(i.created_at)}</div>
          </div>
          ${paymentPill(i.status)}
          ${i.status!=='paid' ? `<button class="btn btn-sm btn-primary" onclick="markInvoicePaid('${i.id}')">Mark paid</button>` : ''}
        </div>`).join('')}
    </div>`;
}

async function pgJobBoard(el) {
  const sport = getActiveSport();
  const sc = getSportConfig();
  const { data: jobs } = await db.from('job_postings').select('*').eq('active', true).order('created_at', { ascending: false });
  const { data: myApps } = await db.from('job_applications').select('job_id').eq('pro_id', currentProfile.id);
  const appliedIds = new Set((myApps||[]).map(a=>a.job_id));
  const sportJobs = (jobs||[]).filter(j => !j.sport || j.sport === sport || j.sport === 'any');

  el.innerHTML = `
    <div class="sport-tabs">
      ${Object.entries(SPORTS).slice(0,2).map(([key,s]) => `<button class="sport-tab ${(currentProfile.sport||'tennis')===key?'active':''}" onclick="saveUserSport('${key}')">${s.icon} ${s.label} Jobs</button>`).join('')}
    </div>
    <div style="padding:20px 24px 0;">
    <div class="card">
      <div class="card-header"><div class="card-title">${sc.icon} ${sportJobs.length} open position${sportJobs.length!==1?'s':''}</div></div>
      ${!sportJobs.length ? emptyState('[work]','No open positions','Check back soon or update your profile to be found by clubs.','Update profile','go("myprofile")')
      : sportJobs.map(j => {
        const applied = appliedIds.has(j.id);
        const tl = {full_time:'Full-time',part_time:'Part-time',summer:'Summer',contract:'Contract'};
        return `<div style="padding:18px 20px;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap;">
            <div>
              <div style="font-size:14px;font-weight:600;letter-spacing:-0.2px;">${j.title}</div>
              <div style="font-size:12.5px;color:var(--text-tertiary);margin-top:2px;">${j.club_name||'Club'} . ${j.location||'Location TBD'}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
              <span class="badge badge-info">${tl[j.job_type]||j.job_type}</span>
              ${applied ? '<span class="badge badge-success">Applied OK</span>' : ''}
            </div>
          </div>
          ${j.rate_range ? `<div style="font-size:13px;color:var(--brand);font-weight:500;margin-bottom:8px;">[$] ${j.rate_range}</div>` : ''}
          ${j.description ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:10px;">${j.description.slice(0,200)}${j.description.length>200?'...':''}</div>` : ''}
          ${!applied ? `<button class="btn btn-sm btn-primary" onclick="modalApplyJob('${j.id}','${encodeURIComponent(j.title)}','${encodeURIComponent(j.club_name||'')}')">Apply now</button>` : ''}
        </div>`;
      }).join('')}
    </div>
    </div>`;
}

async function pgProMyProfile(el) {
  const { data: profile } = await db.from('pro_profiles').select('*').eq('pro_id', currentProfile.id).maybeSingle();
  const strength = [
    !!profile?.portrait_url,
    !!(profile?.bio && profile.bio.length > 50),
    !!(profile?.location_city && profile?.location_state),
    !!profile?.specialties,
    !!profile?.years_experience,
  ];
  const pct = Math.round(strength.filter(Boolean).length / strength.length * 100);

  el.innerHTML = `
    <div class="two-col">
      <div>
        <div class="card" style="margin-bottom:14px;">
          <div class="card-header">
            <div class="card-title">Profile completeness</div>
            <span class="badge ${pct===100?'badge-success':pct>=60?'badge-warning':'badge-danger'}">${pct}%</span>
          </div>
          <div style="padding:14px 20px;">
            <div class="skill-bar-track"><div class="skill-bar-fill" style="width:${pct}%;background:${pct===100?'var(--success)':pct>=60?'var(--warning)':'var(--danger)'};"></div></div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">Complete your profile to get discovered by clubs and members</div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Edit profile</div></div>
          <div style="padding:20px;">
            <div class="form-group">
              <label class="form-label">Sports you coach</label>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${Object.entries(SPORTS).map(([key,s]) => `<label style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:20px;border:1.5px solid ${(currentProfile.sport||'tennis')===key?'var(--brand)':'var(--border)'};background:${(currentProfile.sport||'tennis')===key?'var(--brand-dim)':'transparent'};cursor:pointer;font-size:12.5px;font-weight:500;font-family:'Inter',sans-serif;color:${(currentProfile.sport||'tennis')===key?'var(--brand-text)':'var(--text-secondary)'};">
                  <input type="radio" name="pp-sport" value="${key}" ${(currentProfile.sport||'tennis')===key?'checked':''} style="display:none;" onchange="saveUserSport('${key}')"/>
                  ${s.icon} ${s.label}
                </label>`).join('')}
              </div>
            </div>
            <div class="form-group"><label class="form-label">Professional bio</label><textarea id="pp-bio" rows="4" placeholder="Describe your coaching style, experience, and what makes your lessons unique. Mention all the sports you coach.">${profile?.bio||''}</textarea></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">City</label><input type="text" id="pp-city" value="${profile?.location_city||''}"/></div>
              <div class="form-group"><label class="form-label">State</label><input type="text" id="pp-state" value="${profile?.location_state||''}"/></div>
            </div>
            <div class="form-group"><label class="form-label">Specialties</label><input type="text" id="pp-spec" value="${profile?.specialties||''}" placeholder="e.g. Junior development, Competitive adults, Beginner adults"/></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">Years experience</label><input type="number" id="pp-exp" value="${profile?.years_experience||''}"/></div>
              <div class="form-group"><label class="form-label">Available for hire?</label><select id="pp-available"><option value="true" ${profile?.available!==false?'selected':''}>Yes - actively seeking</option><option value="false" ${profile?.available===false?'selected':''}>No - not available</option></select></div>
            </div>
            <div class="form-group"><label class="form-label">Certification</label><input type="text" id="pp-cert" value="${currentProfile.certification||''}" placeholder="e.g. USPTA, PTR, IPTPA, PPTA"/></div>
            <div class="form-group"><label class="form-label">Portrait photo URL</label><input type="url" id="pp-portrait" value="${profile?.portrait_url||''}" placeholder="https://..."/></div>
            <button class="btn btn-primary" id="pp-save-btn" onclick="saveProProfile()">Save profile</button>
          </div>
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">Preview</div></div>
          <div style="padding:20px;text-align:center;">
            ${profile?.portrait_url ? `<img src="${profile.portrait_url}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin-bottom:12px;"/>` : avatar(currentProfile.full_name, 72)}
            <div style="font-size:16px;font-weight:700;margin:8px 0 4px;letter-spacing:-0.3px;">${currentProfile.full_name}</div>
            <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:8px;">${currentProfile.certification||'Tennis Pro'}</div>
            ${profile?.location_city ? `<div style="font-size:13px;color:var(--text-tertiary);">[*] ${profile.location_city}, ${profile.location_state||''}</div>` : ''}
            ${profile?.specialties ? `<div style="font-size:12.5px;color:var(--brand);margin-top:6px;">${profile.specialties}</div>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Rate settings</div></div>
          <div style="padding:16px 20px;">
            <div class="form-group"><label class="form-label">Private lesson rate ($/hr)</label><input type="number" id="pp-rate" value="${currentProfile.private_rate||120}"/></div>
            <div class="form-group"><label class="form-label">Clinic rate ($/student)</label><input type="number" id="pp-clinic" value="${currentProfile.clinic_rate||30}"/></div>
            <button class="btn btn-sm btn-primary" onclick="saveProRates()">Save rates</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function pgProClients(el) {
  actionBtn('+ Add client', 'btn-primary', 'modalAddClientToPro()');
  const proId = currentProfile.id;
  const { data: lessons } = await db.from('lessons').select('client_id, client_name').eq('pro_id', proId);
  const ids = [...new Set((lessons||[]).map(l=>l.client_id).filter(Boolean))];
  const unlinked = [...new Set((lessons||[]).filter(l=>!l.client_id&&l.client_name).map(l=>l.client_name))];
  let clients = [];
  if (ids.length) {
    const { data } = await db.from('profiles').select('*').in('id', ids);
    clients = data || [];
  }
  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Your clients</div>
        <span class="badge badge-brand">${clients.length} on app${unlinked.length?' . '+unlinked.length+' unlinked':''}</span>
      </div>
      <div style="padding:10px 20px;border-bottom:1px solid var(--border);">
        <input type="text" placeholder="Search clients..." oninput="filterMyClients(this.value)"
          style="background:var(--bg-sunken);border-color:transparent;border-radius:20px;"/>
      </div>
      <div id="cli-list">
        ${!clients.length && !unlinked.length ? emptyState('PPL','No clients yet','Add your clients from the + Add client button or log a lesson with their name.','Invite clients','go("invite")')
        : [...clients.map(c => `
            <div class="list-item cli-row" data-name="${c.full_name.toLowerCase()}" style="cursor:pointer;" onclick="openClientSheet('${c.id}','${encodeURIComponent(c.full_name)}')">
              ${avatar(c.full_name, 40)}
              <div class="list-item-info">
                <div class="list-item-title">${c.full_name}</div>
                <div class="list-item-meta">${c.club_name||'Member'} . <span style="color:var(--success);font-weight:500;">On app OK</span></div>
              </div>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="color:var(--text-quaternary);"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>`),
          ...unlinked.map(name => `
            <div class="list-item cli-row" data-name="${name.toLowerCase()}">
              ${avatar(name, 40, 'var(--bg-sunken)', 'var(--text-quaternary)')}
              <div class="list-item-info">
                <div class="list-item-title">${name}</div>
                <div class="list-item-meta" style="color:var(--text-quaternary);">Not on app . <a href="#" onclick="go('invite');return false;" style="color:var(--brand);">Send invite</a></div>
              </div>
            </div>`)
        ].join('')}
      </div>
    </div>`;
}




async function saveProProfile() {
  if (_busy.pp) return; _busy.pp = true; saveBusy('pp-save-btn', true, 'Saving...');
  const { error } = await db.from('pro_profiles').upsert({
    pro_id: currentProfile.id,
    bio: document.getElementById('pp-bio')?.value.trim() || null,
    location_city: document.getElementById('pp-city')?.value.trim() || null,
    location_state: document.getElementById('pp-state')?.value.trim() || null,
    specialties: document.getElementById('pp-spec')?.value.trim() || null,
    years_experience: parseInt(document.getElementById('pp-exp')?.value) || null,
    available: document.getElementById('pp-available')?.value === 'true',
    portrait_url: document.getElementById('pp-portrait')?.value.trim() || null,
    sports: currentProfile.sport || 'tennis',
  }, { onConflict: 'pro_id' });
  _busy.pp = false; saveBusy('pp-save-btn', false, 'Save profile');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  // Save certification to profiles
  const cert = document.getElementById('pp-cert')?.value.trim();
  if (cert !== undefined) {
    await db.from('profiles').update({ certification: cert }).eq('id', currentProfile.id);
    currentProfile.certification = cert;
  }
  cacheClear(); toast('Profile saved!');
}

async function saveProRates() {
  const rate = parseFloat(document.getElementById('pp-rate')?.value) || 120;
  const clinic = parseFloat(document.getElementById('pp-clinic')?.value) || 30;
  const { error } = await db.from('profiles').update({ private_rate: rate, clinic_rate: clinic }).eq('id', currentProfile.id);
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  currentProfile.private_rate = rate;
  currentProfile.clinic_rate = clinic;
  toast('Rates saved!'); cacheClear();
}

async function modalApplyJob(jobId, jobTitle, clubName) {
  jobTitle = decodeURIComponent(jobTitle || '');
  clubName = decodeURIComponent(clubName || '');
  const { data: pp } = await db.from('pro_profiles').select('*').eq('pro_id', currentProfile.id).maybeSingle();
  openModal(\`
    <div class="modal-title">Apply - \${jobTitle}</div>
    <div style="background:var(--brand-dim);border-radius:10px;padding:12px 16px;margin-bottom:18px;">
      <div style="font-size:13.5px;font-weight:600;color:var(--brand-text);">\${clubName}</div>
    </div>
    <div class="form-group"><label class="form-label">Cover note</label>
      <textarea id="apply-note" rows="4" placeholder="Tell the club manager why you're a great fit..."></textarea>
    </div>
    <div class="form-group"><label class="form-label">Rate expectation ($/hr)</label>
      <input type="number" id="apply-rate" value="\${currentProfile.private_rate||120}"/>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="apply-btn" onclick="submitJobApplication('\${jobId}')">Submit application</button>
    </div>\`);
}

async function submitJobApplication(jobId) {
  if (_busy.apply) return; _busy.apply = true; saveBusy('apply-btn', true, 'Submitting...');
  const { data: pp } = await db.from('pro_profiles').select('*').eq('pro_id', currentProfile.id).maybeSingle();
  const { data: job } = await db.from('job_postings').select('manager_id').eq('id', jobId).single();
  const { error } = await db.from('job_applications').insert({
    job_id: jobId,
    pro_id: currentProfile.id,
    manager_id: job?.manager_id || null,
    cover_note: document.getElementById('apply-note')?.value.trim() || null,
    rate_expectation: parseFloat(document.getElementById('apply-rate')?.value) || null,
    pro_name: currentProfile.full_name,
    pro_certification: currentProfile.certification,
    pro_club: currentProfile.club_name,
    pro_bio: pp?.bio,
    pro_specialties: pp?.specialties,
    pro_location: pp?.location_city ? pp.location_city + (pp.location_state?', '+pp.location_state:'') : null,
    pro_portrait: pp?.portrait_url,
    status: 'new',
  });
  _busy.apply = false; saveBusy('apply-btn', false, 'Submit application');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  closeModal(); toast('Application submitted!'); cacheClear(); go('jobs');
}

async function pgProInvite(el) {
  const url=`${window.location.origin}?invite=${currentProfile.id}`;
  el.innerHTML=`<div class="card" style="max-width:520px;">
    <div class="card-header"><div class="card-title">Your client invite link</div></div>
    <div style="padding:24px;">
      <p style="font-size:13.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:20px;">Share this link with your clients. When they sign up through it they are automatically connected to you.</p>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="flex:1;font-size:12px;color:var(--text-secondary);word-break:break-all;font-family:'JetBrains Mono',monospace;">${url}</div>
        <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('${url}').then(()=>toast('Link copied!'))">Copy</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <button class="btn" onclick="window.open('https://wa.me/?text='+encodeURIComponent('Join me on CourtPro! ${url}'),'_blank')">WhatsApp</button>
        <button class="btn" onclick="window.open('mailto:?subject=Join me on CourtPro&body=Join here: ${url}','_blank')">Email</button>
      </div>
    </div>
  </div>`;
}

async function pgProAvailability(el) {
  const{data:slots}=await db.from('availability').select('*').eq('pro_id',currentProfile.id).order('day_of_week').order('start_time');
  const slotsByDay={};[0,1,2,3,4,5,6].forEach(d=>{slotsByDay[d]=(slots||[]).filter(s=>s.day_of_week===d);});
  el.innerHTML=`<div class="two-col">
    <div><div class="card">
      <div class="card-header"><div class="card-title">Weekly availability</div><button class="card-action" onclick="modalAddSlot()">+ Add slot</button></div>
      <div style="padding:16px;">
        <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px;line-height:1.6;">Club members can browse these slots and send you booking requests directly.</p>
        ${[0,1,2,3,4,5,6].map(d=>`<div style="margin-bottom:14px;">
          <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">${fmt.dayName(d)}</div>
          ${slotsByDay[d].length===0?`<div style="font-size:12.5px;color:var(--text-tertiary);">No slots -- <a href="#" onclick="modalAddSlot(${d});return false;" style="color:var(--brand);">Add one</a></div>`
          :slotsByDay[d].map(s=>`<span style="display:inline-flex;align-items:center;gap:6px;background:var(--brand-dim);color:var(--brand-text);border-radius:6px;padding:5px 10px;font-size:12.5px;font-weight:500;margin-right:6px;margin-bottom:6px;">${s.start_time} - ${s.end_time}<button onclick="deleteSlot('${s.id}')" style="background:none;border:none;cursor:pointer;color:var(--brand-text);font-size:14px;padding:0;opacity:0.6;line-height:1;">X</button></span>`).join('')}
        </div>`).join('')}
      </div>
    </div></div>
    <div class="right-stack"><div class="card">
      <div class="card-header"><div class="card-title">Booking requests</div></div>
      <div id="booking-req-list"><div style="padding:16px;font-size:13px;color:var(--text-tertiary);">Loading...</div></div>
    </div></div>
  </div>`;
  loadBookingRequests();
}

async function loadBookingRequests(){const el=document.getElementById('booking-req-list');if(!el)return;const{data}=await db.from('booking_requests').select('*, client:client_id(full_name)').eq('pro_id',currentProfile.id).eq('status','pending').order('created_at',{ascending:false});if(!data?.length){el.innerHTML='<div style="padding:16px;font-size:13px;color:var(--text-tertiary);">No booking requests right now.</div>';return;}el.innerHTML=data.map(r=>`<div style="padding:13px 16px;border-bottom:1px solid var(--border);"><div style="font-size:13.5px;font-weight:500;margin-bottom:3px;">${r.client?.full_name||'Client'}</div><div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">${fmt.date(r.requested_date)} . ${r.requested_time} . ${r.lesson_type} . ${fmt.money(r.rate)}</div>${r.notes?`<div style="font-size:12px;color:var(--text-secondary);font-style:italic;margin-bottom:8px;">"${r.notes}"</div>`:''}<div style="display:flex;gap:6px;"><button class="btn btn-sm btn-accept" onclick="acceptBooking('${r.id}')">Accept</button><button class="btn btn-sm btn-decline" onclick="declineBooking('${r.id}')">Decline</button></div></div>`).join('');}
async function acceptBooking(id) {
  const { data: r, error: fetchErr } = await db
    .from('booking_requests')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !r) {
    toast('Could not load request. Try refreshing.', 'error');
    return;
  }

  // Normalise time to HH:MM
  const timeStr = (r.requested_time || '09:00').slice(0, 5);
  const scheduledAt = r.requested_date + 'T' + timeStr + ':00';

  // Insert the lesson
  const { data: newLesson, error: insertErr } = await db.from('lessons').insert({
    pro_id: currentProfile.id,
    client_id: r.client_id || null,
    client_name: r.client_id ? null : (r.client_name || null),
    type: r.lesson_type || 'private',
    scheduled_at: scheduledAt,
    duration_minutes: 60,
    court: r.court || null,
    rate: r.rate || currentProfile.private_rate || 120,
    status: 'upcoming',
    payment_status: 'unpaid'
  }).select().single();

  if (insertErr) {
    console.error('acceptBooking insert error:', insertErr);
    toast('Error: ' + insertErr.message, 'error');
    return;
  }

  // Mark request as accepted
  await db.from('booking_requests')
    .update({ status: 'accepted' })
    .eq('id', id);

  // Notify the client
  if (r.client_id) {
    await createNotification(
      r.client_id,
      'booking_accepted',
      'Lesson confirmed!',
      'Your lesson request has been accepted. Check Upcoming Lessons.',
      'upcoming'
    );
  }

  toast('Lesson accepted and scheduled!');
  loadBookingRequests();
  cacheClear();
}
async function declineBooking(id){await db.from('booking_requests').update({status:'declined'}).eq('id',id);toast('Booking declined.');loadBookingRequests();}
function modalAddSlot(preDay){openModal(`<div class="modal-title">Add availability slot</div><div class="form-group"><label class="form-label">Day</label><select id="slot-day">${[0,1,2,3,4,5,6].map(d=>`<option value="${d}" ${preDay===d?'selected':''}>${fmt.dayName(d)}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label class="form-label">Start time</label><input type="time" id="slot-start" value="08:00"/></div><div class="form-group"><label class="form-label">End time</label><input type="time" id="slot-end" value="12:00"/></div></div><div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="slot-btn" onclick="saveSlot()">Add slot</button></div>`);}
async function saveSlot(){if(_busy.slot)return;_busy.slot=true;saveBusy('slot-btn',true,'Add slot');const{error}=await db.from('availability').insert({pro_id:currentProfile.id,day_of_week:parseInt(document.getElementById('slot-day').value),start_time:document.getElementById('slot-start').value,end_time:document.getElementById('slot-end').value});_busy.slot=false;saveBusy('slot-btn',false,'Add slot');if(error){toast('Error: '+error.message,'error');return;}closeModal();toast('Slot added!');go('availability');}
async function deleteSlot(id){await db.from('availability').delete().eq('id',id);toast('Slot removed.');go('availability');}


async function pgProDevPlanBuilder(el) {
  actionBtn('+ New Plan', 'btn-primary', 'modalCreateDevPlan()');
  // Load existing dev plan notes for this pro
  const { data: plans } = await db.from('session_notes')
    .select('*, client:client_id(full_name)')
    .eq('pro_id', currentProfile.id)
    .not('dev_plan', 'is', null)
    .order('created_at', { ascending: false });

  el.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">Development Plans</div><div style="font-size:12px;color:var(--text-tertiary);">${plans?.length||0} active plans</div></div>
      ${!plans?.length ? emptyState('[target]','No development plans yet','Create a structured development plan for any of your clients.',null,null)
      : plans.map(p => {
        const plan = p.dev_plan || {};
        return `<div style="padding:16px;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <div>
              <div style="font-size:14px;font-weight:600;">${p.client?.full_name||p.client_name||'Client'}</div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">${fmt.date(p.created_at)} . ${plan.focus||'General development'}</div>
            </div>
            <span class="badge badge-green">${plan.timeline||'Ongoing'}</span>
          </div>
          ${plan.goal ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:6px;"><strong>Goal:</strong> ${plan.goal}</div>` : ''}
          ${plan.milestone ? `<div style="background:var(--pkl-dim);border-radius:6px;padding:7px 10px;font-size:12.5px;color:var(--pkl-text);margin-bottom:6px;"><strong>Milestone:</strong> ${plan.milestone}</div>` : ''}
          ${plan.notes ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;">${plan.notes}</div>` : ''}
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button class="btn btn-sm" onclick="toggleShare('${p.id}',${p.shared_with_client})">${p.shared_with_client?'Unshare':'Share with client'}</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

async function modalCreateDevPlan() {
  const clients = await getClientsForPro();
  openModal(`
    <div class="modal-title">Create development plan</div>
    ${clientSelect(clients,'dp-client','For client')}
    <div class="form-group">
      <label class="form-label">Training focus</label>
      <select id="dp-focus" onchange="applyDevPlanTemplate(this.value)">
        <option value="">Choose a focus area...</option>
        ${DEV_PLAN_FOCUSES.map(f=>`<option value="${f}">${f}</option>`).join('')}
      </select>
    </div>
    <div id="dp-template-hint" style="display:none;background:var(--info-dim);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12.5px;color:var(--info);">
      Template loaded -- review and customise below.
    </div>
    <div class="form-group">
      <label class="form-label">Goal</label>
      <textarea id="dp-goal" rows="2" placeholder="What do you want this player to achieve?"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Timeline</label>
        <select id="dp-timeline">
          <option value="1 week">1 week</option>
          <option value="2 weeks" selected>2 weeks</option>
          <option value="3 weeks">3 weeks</option>
          <option value="4 weeks">4 weeks</option>
          <option value="6 weeks">6 weeks</option>
          <option value="8 weeks">8 weeks</option>
          <option value="3 months">3 months</option>
          <option value="Ongoing">Ongoing</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Level</label>
        <select id="dp-level">
          <option value="Beginner">Beginner</option>
          <option value="Intermediate" selected>Intermediate</option>
          <option value="Advanced">Advanced</option>
          <option value="Tournament">Tournament</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Key milestone (measurable achievement)</label>
      <input type="text" id="dp-milestone" placeholder="e.g. Sustain 20-ball cross-court rally at 75% pace"/>
    </div>
    <div class="form-group">
      <label class="form-label">Recommended drills</label>
      <div id="dp-drills-tags" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;min-height:24px;"></div>
      <select id="dp-drill-add" onchange="addDrillToPlan(this.value);this.value='';">
        <option value="">+ Add drill from library...</option>
        ${DRILL_LIBRARY.map(d=>`<option value="${d.name}">${d.name}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Practice frequency</label>
      <select id="dp-freq">
        <option value="Daily">Daily (15-20 min)</option>
        <option value="3x per week" selected>3x per week</option>
        <option value="2x per week">2x per week</option>
        <option value="Each session">Each session only</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Coach's notes (technical cues, patterns to work on)</label>
      <textarea id="dp-notes" rows="3" placeholder="Specific technical points, areas to focus on, what to avoid..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Share with client immediately?</label>
      <select id="dp-share"><option value="true">Yes -- share now</option><option value="false">No -- save as draft</option></select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="dp-save-btn" onclick="saveDevPlan()">Save plan</button>
    </div>`);
}

function addDrillToPlan(drillName) {
  if (!drillName) return;
  const container = document.getElementById('dp-drills-tags');
  if (!container) return;
  const existing = [...container.querySelectorAll('.drill-tag')].map(t=>t.dataset.name);
  if (existing.includes(drillName)) return;
  const tag = document.createElement('span');
  tag.className = 'drill-tag';
  tag.dataset.name = drillName;
  tag.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:var(--brand-dim);color:var(--brand-text);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:500;';
  tag.innerHTML = `[tennis] ${drillName}<button onclick="this.closest('.drill-tag').remove()" style="background:none;border:none;cursor:pointer;color:var(--brand-text);font-size:13px;padding:0;opacity:0.7;line-height:1;">X</button>`;
  container.appendChild(tag);
}

function applyDevPlanTemplate(focus) {
  const template = DEV_PLAN_TEMPLATES[focus];
  const hint = document.getElementById('dp-template-hint');
  if (!template) { if (hint) hint.style.display='none'; return; }
  if (hint) hint.style.display='block';
  const goal = document.getElementById('dp-goal'); if (goal) goal.value = template.goal;
  const milestone = document.getElementById('dp-milestone'); if (milestone) milestone.value = template.milestone;
  const timeline = document.getElementById('dp-timeline'); if (timeline) timeline.value = template.timeline;
  // Add recommended drills
  const container = document.getElementById('dp-drills-tags');
  if (container) { container.innerHTML=''; template.drills.forEach(d => addDrillToPlan(d)); }
}

async function saveDevPlan() {
  if (_busy.dp) return; _busy.dp = true; saveBusy('dp-save-btn', true, 'Saving...');
  const clientId = document.getElementById('dp-client')?.value || null;
  const clientName = clientId
    ? (document.getElementById('dp-client')?.selectedOptions[0]?.text || null)
    : (document.getElementById('dp-client-name')?.value.trim() || null);
  const drills = [...(document.querySelectorAll('.drill-tag')||[])].map(t=>t.dataset.name).filter(Boolean);
  const plan = {
    focus:     document.getElementById('dp-focus')?.value || '',
    goal:      document.getElementById('dp-goal')?.value.trim() || '',
    milestone: document.getElementById('dp-milestone')?.value.trim() || '',
    timeline:  document.getElementById('dp-timeline')?.value || '4 weeks',
    level:     document.getElementById('dp-level')?.value || 'Intermediate',
    frequency: document.getElementById('dp-freq')?.value || '3x per week',
    drills,
    notes:     document.getElementById('dp-notes')?.value.trim() || '',
  };
  const shared = document.getElementById('dp-share')?.value === 'true';
  const { error } = await db.from('session_notes').insert({
    pro_id: currentProfile.id,
    client_id: clientId,
    client_name: clientName,
    focus_area: plan.focus,
    pro_notes: plan.notes,
    homework: drills.join(', '),
    objectives: `Goal: ${plan.goal}\nMilestone: ${plan.milestone}\nTimeline: ${plan.timeline} . ${plan.frequency}`,
    shared_with_client: shared,
    dev_plan: plan,
    category: 'Development Plan',
  });
  _busy.dp = false; saveBusy('dp-save-btn', false, 'Save plan');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  closeModal(); toast('Development plan saved! OK');
  cacheClear(); go('notes');
}

async function modalDevPlanForClient(clientId, clientName) {
  window._preselectedClient = { id: clientId, name: clientName };
  await modalCreateDevPlan();
}
async function pgMgrDashboard(el) {
  actionBtn('+ Assign Lesson', 'btn-blue', 'modalAssignLesson()');
  const proIds = await getClubProIds();
  const [{ data: pros }, { data: clients }, { data: lessons }, { data: newApps }] = await Promise.all([
    db.from('profiles').select('*').eq('role','pro').eq('club_name',currentProfile.club_name),
    db.from('profiles').select('*').eq('role','client').eq('club_name',currentProfile.club_name),
    proIds.length ? db.from('lessons').select('*, pro:pro_id(full_name), client:client_id(full_name)').in('pro_id',proIds).order('scheduled_at',{ascending:false}) : Promise.resolve({data:[]}),
    db.from('job_applications').select('id').eq('manager_id',currentProfile.id).eq('status','new')
  ]);
  const unassigned = (lessons||[]).filter(l=>!l.pro_id);
  const revenue = (lessons||[]).filter(l=>l.status==='completed'&&(l.rate||0)>0&&(l.duration_minutes||0)>0).reduce((s,l)=>s+(l.rate||0),0);
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Club pros</div><div class="stat-value">${pros?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">Club members</div><div class="stat-value">${clients?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">Unassigned</div><div class="stat-value" style="color:var(--danger)">${unassigned.length}</div><div class="stat-sub">need a pro</div></div>
      <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">${fmt.money(revenue)}</div><div class="stat-sub">completed</div></div>
    </div>
    ${(newApps?.length||0)>0?`<div style="background:var(--info-dim);border:1px solid var(--info);border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13.5px;font-weight:500;color:var(--info);">[list] You have ${newApps.length} new job application${newApps.length>1?'s':''}</div><button class="btn btn-sm btn-blue" onclick="go('applications')">Review applications</button></div>`:''}
    <div class="two-col">
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">Recent lessons . ${currentProfile.club_name}</div></div>
          ${!lessons?.length?emptyState('CAL','No lessons yet','Assign a lesson to get started.',null,null)
            :lessons.slice(0,10).map(l=>`
              <div class="list-item s-row">
                <div class="dot ${l.pro_id?'':''}"></div>
                <div class="list-item-info">
                  <div class="list-item-title">${l.client?.full_name||l.client_name||'No client'} . ${l.type}</div>
                  <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${l.pro?.full_name||'Unassigned'} . ${l.court||'TBD'}</div>
                </div>
                ${statusBadge(l.status)}
                ${!l.pro_id?`<button class="btn btn-sm btn-accept" onclick="modalAssignPro('${l.id}')">Assign pro</button>`:''}
              </div>`).join('')}
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">Your pros</div><button class="card-action" onclick="go('addpro')">+ Add pro</button></div>
          ${!pros?.length?emptyState('[T]','No pros yet','Add pros to get started.','Add a Pro','go("addpro")')
            :pros.map(p=>`
              <div class="list-item">
                ${avatar(p.full_name)}
                <div class="list-item-info">
                  <div class="list-item-title">${p.full_name}</div>
                  <div class="list-item-meta">${p.certification||'Pro'} . ${fmt.money(p.private_rate)}/hr</div>
                </div>
              </div>`).join('')}
        </div>
      </div>
    </div>`;
}

async function pgMgrSchedule(el) {
  actionBtn('+ Assign Lesson', 'btn-blue', 'modalAssignLesson()');
  const proIds = await getClubProIds();
  const { data: lessons } = proIds.length ? await db.from('lessons').select('*, pro:pro_id(full_name), client:client_id(full_name)').in('pro_id',proIds).order('scheduled_at',{ascending:true}) : {data:[]};
  el.innerHTML = `<div class="card">
    ${searchBar('sch-search','Search lessons, pros, clients...')}
    <div id="sch-list">
      ${!lessons?.length?emptyState('CAL','No lessons scheduled','Assign lessons to see them here.','Assign Lesson','modalAssignLesson()')
        :lessons.map(l=>`
          <div class="list-item s-row">
            <div class="dot ${l.status==='confirmed'||l.status==='upcoming'?'':l.status==='pending'?'dot-amber':''}"></div>
            <div class="list-item-info">
              <div class="list-item-title">${l.client?.full_name||l.client_name||'No client'} . ${l.type} . ${l.court||'TBD'}</div>
              <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${fmt.time(l.scheduled_at)} . ${l.pro?.full_name||'Unassigned'}</div>
            </div>
            ${statusBadge(l.status)}
            <div class="mono">${fmt.money(l.rate)}</div>
            ${!l.pro_id?`<button class="btn btn-sm btn-accept" onclick="modalAssignPro('${l.id}')">Assign pro</button>`:''}
          </div>`).join('')}
    </div>
  </div>`;
}

async function pgMgrPros(el) {
  const { data: pros } = await db.from('profiles').select('*').eq('role','pro').eq('club_name',currentProfile.club_name);
  el.innerHTML = `<div class="card">
    ${searchBar('pr-search','Search pros...')}
    <div id="pr-list">
      ${!pros?.length?emptyState('[T]','No pros yet','Pros who sign up with your club name appear here automatically.','Add a Pro','go("addpro")')
        :pros.map(p=>`
          <div class="list-item s-row">
            ${avatar(p.full_name)}
            <div class="list-item-info">
              <div class="list-item-title">${p.full_name}</div>
              <div class="list-item-meta">${p.certification||'USPTA'} . Private ${fmt.money(p.private_rate)}/hr . Clinic ${fmt.money(p.clinic_rate)}/student</div>
            </div>
            <button class="btn btn-sm btn-decline" onclick="removeProFromClub('${p.id}','${p.full_name}')">Remove</button>
          </div>`).join('')}
    </div>
  </div>`;
}

async function pgMgrAddPro(el) {
  const inviteUrl = `${window.location.origin}?mgr_invite=${currentProfile.id}`;
  el.innerHTML = `
    <div class="two-col">
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">Your club invite link</div><span class="badge badge-green">Shareable</span></div>
          <div style="padding:16px 16px 20px;">
            <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px;">Share this link with any pro. When they sign up through it they are automatically added to <strong>${currentProfile.club_name}</strong> -- no manual club entry needed.</p>
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:10px;margin-bottom:12px;">
              <div style="flex:1;font-size:12px;color:var(--text-secondary);word-break:break-all;font-family:'JetBrains Mono',monospace;">${inviteUrl}</div>
              <button class="btn btn-sm btn-primary" onclick="navigator.clipboard.writeText('${inviteUrl}').then(()=>toast('Link copied!'))">Copy</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <button class="btn btn-sm" onclick="window.open('https://wa.me/?text='+encodeURIComponent('Hi! I\'d like you to join ${currentProfile.club_name} on CourtPro. Sign up here and you\'ll be added to our team automatically: ${inviteUrl}'),'_blank')">Share via WhatsApp</button>
              <button class="btn btn-sm" onclick="showMgrEmailModal('${inviteUrl}')">Send via Email</button>
            </div>
          </div>
        </div>
        <div class="card" style="margin-top:16px;">
          <div class="card-header"><div class="card-title">Search for a pro already on CourtPro</div></div>
          <div style="padding:16px;">
            <div style="display:flex;gap:8px;margin-bottom:16px;">
              <input type="text" id="pro-search-input" placeholder="Search by name, certification, city, or specialty..." style="flex:1;" oninput="proSearchDebounced(this.value)" onkeydown="if(event.key==='Enter')searchForPro()"/>
              <button class="btn btn-blue" onclick="searchForPro()">Search</button>
            </div>
            <div id="pro-search-results"><div style="font-size:13px;color:var(--text-tertiary);padding:4px 0;">Search by name, city, certification, or specialty...</div></div>
          </div>
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">How pros join your club</div></div>
          <div style="padding:16px;">
            ${[
              ['Share invite link','Copy your unique link and send to any pro -- they join your club on sign up automatically.'],
              ['Auto-join','Pros who sign up and enter your exact club name also appear automatically.'],
              ['Search & add','Find a pro already on CourtPro and add them directly.'],
              ['Job board','Post a position to attract new pros.'],
            ].map(([t,d])=>`<div style="margin-bottom:12px;"><div style="font-size:13px;font-weight:500;margin-bottom:2px;">${t}</div><div style="font-size:12px;color:var(--text-tertiary);line-height:1.5;">${d}</div></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  window.proSearchDebounced = debounce(async (q) => {
    const el = document.getElementById('pro-search-results');
    if (el) await smartSearchPros(q, el, { showAddBtn: true });
  }, 300);

}

function showMgrEmailModal(inviteUrl) {
  const clubName = currentProfile.club_name || 'our club';
  const subject = 'Join our coaching team at ' + clubName + ' on CourtPro';
  const body = 'Hi,\n\nI\'d like to invite you to join ' + clubName + ' on CourtPro.\n\nSign up via this link and you\'ll be added to our team automatically:\n' + inviteUrl + '\n\nLooking forward to working with you!';
  openModal(`
    <div class="modal-title">Email invite . ${clubName}</div>
    <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px;line-height:1.5;">Copy these details into Gmail, Outlook, or any email you use.</p>
    <div class="form-group">
      <label class="form-label">Subject</label>
      <div style="display:flex;gap:8px;">
        <input id="mgr-inv-subj" type="text" readonly value="${subject}" style="flex:1;background:var(--bg);font-size:13px;"/>
        <button class="btn btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('mgr-inv-subj').value).then(()=>toast('Copied!'))">Copy</button>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Message</label>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <textarea id="mgr-inv-body" rows="8" readonly style="background:var(--bg);font-size:12.5px;line-height:1.7;">${body}</textarea>
        <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('mgr-inv-body').value).then(()=>toast('Message copied!'))">Copy full message</button>
      </div>
    </div>
    <div style="background:var(--info-dim);border-radius:8px;padding:11px 14px;margin-top:4px;">
      <div style="font-size:12.5px;color:var(--info);line-height:1.6;">The pro just needs to click the link to sign up -- they will be added to <strong>${clubName}</strong> automatically. No club name entry required.</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Done</button>
      <a href="mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}" class="btn btn-blue" target="_blank">Try email app</a>
    </div>`);
}

async function searchForPro() {
  const q = document.getElementById('pro-search-input')?.value.trim() || '';
  const el = document.getElementById('pro-search-results');
  if (!el) return;
  await smartSearchPros(q, el, { showAddBtn: true });
}

async function addProToClub(id, name) {
  name = decodeURIComponent(name || '');
  const { error } = await db.from('profiles').update({ club_name: currentProfile.club_name }).eq('id', id);
  if (error) { toast('Error adding pro.', 'error'); return; }
  toast(`${name} added to ${currentProfile.club_name}!`);
  go('addpro');
}

async function removeProFromClub(id, name) {
  if (!confirm(`Remove ${name} from your club?`)) return;
  await db.from('profiles').update({ club_name: '' }).eq('id', id);
  toast(`${name} removed.`);
  go('pros');
}

function sendProInviteEmail() {
  const email = document.getElementById('invite-pro-email').value.trim();
  const msg = document.getElementById('invite-pro-msg').value.trim();
  if (!email) { toast('Please enter an email address.','error'); return; }
  const subject = `Join our coaching team at ${currentProfile.club_name} on CourtPro`;
  const body = `${msg?msg+'\n\n':''}Hi,\n\nI'd like to invite you to join ${currentProfile.club_name} on CourtPro.\n\nTo join:\n1. Go to ${window.location.origin}\n2. Create a free account as a Tennis Pro\n3. Enter club name: ${currentProfile.club_name}\n\nYou'll appear in our roster automatically.\n\nLooking forward to working with you!`;
  openModal(`
    <div class="modal-title">Ready to send</div>
    <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px;line-height:1.6;">Copy and paste these details into Gmail, Outlook, or any email you use.</p>
    <div class="form-group"><label class="form-label">To</label>
      <div style="display:flex;gap:8px;">
        <input type="text" value="${email}" readonly style="flex:1;background:var(--bg);"/>
        <button class="btn btn-sm" onclick="navigator.clipboard.writeText('${email}').then(()=>toast('Copied!'))">Copy</button>
      </div>
    </div>
    <div class="form-group"><label class="form-label">Subject</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="inv-subject" value="${subject}" readonly style="flex:1;background:var(--bg);"/>
        <button class="btn btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('inv-subject').value).then(()=>toast('Copied!'))">Copy</button>
      </div>
    </div>
    <div class="form-group"><label class="form-label">Message</label>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <textarea id="inv-body" rows="7" readonly style="background:var(--bg);font-size:12.5px;line-height:1.6;">${body}</textarea>
        <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('inv-body').value).then(()=>toast('Message copied!'))">Copy full message</button>
      </div>
    </div>
    <div style="background:var(--info-dim);border-radius:8px;padding:12px 14px;margin-top:8px;">
      <div style="font-size:12.5px;color:var(--info);line-height:1.6;">The pro just needs to sign up and enter club name <strong>${currentProfile.club_name}</strong> -- they appear in your roster automatically.</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Done</button>
      <a href="mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}" class="btn btn-blue" target="_blank">Try email app</a>
    </div>`);
}

async function pgMgrFeedback(el) {
  const proIds = await getClubProIds();
  const { data: ratings } = proIds.length
    ? await db.from('ratings').select('*, pro:pro_id(full_name), client:client_id(full_name)').in('pro_id', proIds).order('created_at', { ascending: false })
    : { data: [] };
  const avg = ratings?.length ? (ratings.reduce((s,r)=>s+(r.stars||0),0)/ratings.length).toFixed(1) : '--';
  el.innerHTML = `
    <div class="stats-grid" style="margin-bottom:16px;">
      <div class="stat-card"><div class="stat-label">Total reviews</div><div class="stat-value">${ratings?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">Average rating</div><div class="stat-value">${avg}${avg!=='--'?'[star]':''}</div></div>
      <div class="stat-card"><div class="stat-label">5-star reviews</div><div class="stat-value">${(ratings||[]).filter(r=>r.stars===5).length}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">All feedback</div></div>
      ${searchBar('fb-search','Search feedback...')}
      <div id="fb-list">
        ${!ratings?.length ? emptyState('[star]','No reviews yet','Feedback from clients appears here after lessons.', null, null)
        : ratings.map(r => `
          <div class="list-item s-row" style="flex-wrap:wrap;gap:8px;align-items:flex-start;">
            <div style="flex:1;min-width:200px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
                <div style="font-size:13.5px;font-weight:500;">${r.client?.full_name||'Client'}</div>
                <div style="font-size:14px;">${'[*]'.repeat(r.stars||0)}${'[*]'.repeat(5-(r.stars||0))}</div>
                <div style="font-size:11px;color:var(--text-tertiary);">${fmt.relativeDate(r.created_at)}</div>
              </div>
              <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:4px;">For: ${r.pro?.full_name||'Pro'}</div>
              ${r.feedback?`<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;font-style:italic;">"${r.feedback}"</div>`:'<div style="font-size:12.5px;color:var(--text-tertiary);">No written feedback</div>'}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}


async function pgMgrRates(el) {
  const proIds = await getClubProIds();
  const { data: pros } = proIds.length ? await db.from('profiles').select('id,full_name,private_rate,clinic_rate').in('id', proIds) : { data: [] };
  el.innerHTML = `
    <div class="card" style="max-width:540px;">
      <div class="card-header"><div class="card-title">Lesson rates . ${currentProfile.club_name}</div></div>
      <div style="padding:20px;">
        <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:18px;line-height:1.6;">Set default rates for your club. Individual pro rates can also be updated here.</p>
        <div class="form-group"><label class="form-label">Default private lesson ($/hr)</label><input type="number" id="r-private" value="120" style="max-width:180px;"/></div>
        <div class="form-group"><label class="form-label">Default clinic rate ($/student)</label><input type="number" id="r-clinic" value="30" style="max-width:180px;"/></div>
        <div class="form-group"><label class="form-label">Semi-private ($/hr)</label><input type="number" id="r-semi" value="75" style="max-width:180px;"/></div>
        <button class="btn btn-blue" id="rates-save-btn" onclick="saveClubRates()">Save rates</button>
        ${pros?.length ? `<div style="margin-top:24px;border-top:1px solid var(--border);padding-top:18px;">
          <div style="font-size:13px;font-weight:500;margin-bottom:12px;">Individual pro rates</div>
          ${pros.map(p => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
            ${avatar(p.full_name)}
            <div style="flex:1;font-size:13.5px;">${p.full_name}</div>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="number" value="${p.private_rate||120}" id="pro-rate-${p.id}" style="width:80px;font-size:13px;"/>
              <span style="font-size:12px;color:var(--text-tertiary);">/hr</span>
              <button class="btn btn-sm btn-accept" onclick="saveProRate('${p.id}')">Save</button>
            </div>
          </div>`).join('')}
        </div>` : ''}
      </div>
    </div>`;
}

async function saveClubRates() {
  saveBusy('rates-save-btn', true, 'Save rates');
  toast('Default rates saved!');
  saveBusy('rates-save-btn', false, 'Save rates');
}

async function saveProRate(proId) {
  const rate = parseFloat(document.getElementById(`pro-rate-${proId}`)?.value) || 120;
  const { error } = await db.from('profiles').update({ private_rate: rate }).eq('id', proId);
  if (error) { toast('Error saving rate.', 'error'); return; }
  toast('Rate updated!');
}

async function pgMgrAnnounce(el) {
  el.innerHTML = `
    <div class="card" style="max-width:580px;">
      <div class="card-header"><div class="card-title">Send an announcement</div></div>
      <div style="padding:20px;">
        <div class="form-group"><label class="form-label">Send to</label><select id="ann-to"><option value="all">Everyone</option><option value="pros">Pros only</option><option value="clients">Members only</option></select></div>
        <div class="form-group"><label class="form-label">Subject</label><input type="text" id="ann-subject" placeholder="e.g. Court closure this Saturday"/></div>
        <div class="form-group"><label class="form-label">Message</label><textarea id="ann-body" rows="5" placeholder="Write your announcement..."></textarea></div>
        <button class="btn btn-blue" onclick="sendAnnouncement()">Send announcement</button>
      </div>
    </div>`;
}

async function sendAnnouncement() {
  const subject = document.getElementById('ann-subject').value.trim();
  const body = document.getElementById('ann-body').value.trim();
  const to = document.getElementById('ann-to').value;
  if (!subject || !body) { toast('Please fill in subject and message.','error'); return; }
  // Fan out notification to relevant users
  let targets = [];
  if (to === 'all' || to === 'pros') {
    const proIds = await getClubProIds();
    targets = [...targets, ...proIds];
  }
  if (to === 'all' || to === 'clients') {
    const { data: clients } = await db.from('profiles').select('id').eq('role','client').eq('club_name', currentProfile.club_name);
    targets = [...targets, ...(clients||[]).map(c=>c.id)];
  }
  // Insert a notification row for each target (batch)
  if (targets.length > 0) {
    const rows = targets.map(uid => ({ user_id: uid, type: 'announcement', title: subject, body: body, link_page: 'dashboard' }));
    await db.from('notifications').insert(rows);
  }
  toast(`Announcement sent to ${targets.length} member${targets.length!==1?'s':''}!`);
  document.getElementById('ann-subject').value = '';
  document.getElementById('ann-body').value = '';
}

async function pgMgrPostJob(el) {
  const { data: jobs } = await db.from('job_postings').select('*').eq('manager_id', currentProfile.id).order('created_at',{ascending:false});
  const typeLabels = { full_time:'Full-time', part_time:'Part-time', summer:'Summer' };
  el.innerHTML = `
    <div class="two-col">
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">Post a new job opening</div></div>
          <div style="padding:20px;">
            <div class="form-group"><label class="form-label">Job title</label><input type="text" id="jb-title" placeholder="e.g. Head Tennis Pro, Junior Coach, Assistant Pro"/></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">Position type</label><select id="jb-type"><option value="full_time">Full-time</option><option value="part_time">Part-time</option><option value="summer">Summer</option><option value="contract">Contract</option></select></div>
              <div class="form-group"><label class="form-label">Location</label><input type="text" id="jb-location" value="${currentProfile.club_name||''}" placeholder="City, State"/></div>
            </div>
            <div class="form-group"><label class="form-label">Compensation range</label><input type="text" id="jb-rate" placeholder="e.g. $60-$80/hr, $55,000-$75,000/yr"/></div>
            <div class="form-group"><label class="form-label">Job description</label><textarea id="jb-desc" rows="4" placeholder="Describe the role, responsibilities, club culture..."></textarea></div>
            <div class="form-group"><label class="form-label">Requirements</label><textarea id="jb-req" rows="3" placeholder="e.g. USPTA or PTR certified, 3+ years experience, experience with juniors..."></textarea></div>
            <div class="form-group"><label class="form-label">Contact email for applications</label><input type="email" id="jb-email" placeholder="hiring@yourclub.com"/></div>
            <button class="btn btn-blue" id="jb-btn" onclick="saveJobPosting()">Post job opening</button>
          </div>
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">Your active postings</div><button class="card-action" onclick="go('applications')">View applications</button></div>
          ${!jobs?.length?'<div style="padding:16px;font-size:13px;color:var(--text-tertiary);">No job postings yet.</div>'
            :jobs.map(j=>`
              <div style="padding:13px 16px;border-bottom:1px solid var(--border);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                  <div style="font-size:13.5px;font-weight:500;">${j.title}</div>
                  <span class="badge ${j.active?'badge-green':'badge-gray'}">${j.active?'Active':'Closed'}</span>
                </div>
                <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">${typeLabels[j.job_type]||j.job_type} . Posted ${fmt.date(j.created_at)}</div>
                <button class="btn btn-sm btn-decline" onclick="closeJobPosting('${j.id}')">Close posting</button>
              </div>`).join('')}
        </div>
      </div>
    </div>`;
}

async function saveJobPosting() {
  if (_busy.job) return; _busy.job=true; saveBusy('jb-btn',true,'Posting...');
  const title = document.getElementById('jb-title').value.trim();
  if (!title) { toast('Please enter a job title.','error'); _busy.job=false; saveBusy('jb-btn',false,'Post job opening'); return; }
  const { error } = await db.from('job_postings').insert({ manager_id:currentProfile.id, club_name:currentProfile.club_name, title, job_type:document.getElementById('jb-type').value, location:document.getElementById('jb-location').value.trim(), rate_range:document.getElementById('jb-rate').value.trim(), description:document.getElementById('jb-desc').value.trim(), requirements:document.getElementById('jb-req').value.trim(), contact_email:document.getElementById('jb-email').value.trim(), active:true });
  _busy.job=false; saveBusy('jb-btn',false,'Post job opening');
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Job posted! Pros across the platform can now see it.'); go('postjob');
}

async function closeJobPosting(id) {
  await db.from('job_postings').update({active:false}).eq('id',id);
  toast('Posting closed.'); go('postjob');
}

async function pgMgrBrowsePros(el) {
  const { data: proProfiles } = await db.from('pro_profiles').select('*, pro:pro_id(full_name, certification, private_rate, club_name)').eq('available',true).order('created_at',{ascending:false});
  // Load average ratings for each pro
  const proIds = (proProfiles||[]).map(p=>p.pro_id).filter(Boolean);
  let ratingMap = {};
  if (proIds.length) {
    const { data: ratings } = await db.from('ratings').select('pro_id, stars').in('pro_id', proIds);
    (ratings||[]).forEach(r => {
      if (!ratingMap[r.pro_id]) ratingMap[r.pro_id] = { sum: 0, count: 0 };
      ratingMap[r.pro_id].sum += r.stars;
      ratingMap[r.pro_id].count++;
    });
  }
  const seekingLabels = { full_time:'Seeking full-time', part_time:'Seeking part-time', summer:'Seeking summer', any:'Open to anything' };
  const seekingColors = { full_time:'badge-blue', part_time:'badge-green', summer:'badge-amber', any:'badge-purple' };
  el.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
      <input type="text" id="mgr-pro-filter" placeholder="Filter by city, state, or specialty..." style="flex:1;min-width:200px;" oninput="filterProProfiles()"/>
      <select id="mgr-seeking-filter" style="min-width:160px;" onchange="filterProProfiles()">
        <option value="">All position types</option>
        <option value="full_time">Full-time</option>
        <option value="part_time">Part-time</option>
        <option value="summer">Summer</option>
        <option value="any">Open to anything</option>
      </select>
    </div>
    <div id="pro-profiles-list">
      ${!proProfiles?.length?emptyState('[T]','No pros looking right now','Check back as more pros update their career profiles.',null,null)
        :proProfiles.map(p=>`
          <div class="s-pro" data-city="${(p.location_city||'').toLowerCase()}" data-state="${(p.location_state||'').toLowerCase()}" data-spec="${(p.specialties||'').toLowerCase()}" data-seeking="${p.seeking_type||''}"
            style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:14px;">
            <div style="display:flex;gap:16px;margin-bottom:14px;">
              <div style="width:68px;height:68px;border-radius:50%;overflow:hidden;flex-shrink:0;border:2px solid var(--border);">
                ${p.portrait_url?`<img src="${p.portrait_url}" style="width:100%;height:100%;object-fit:cover;"/>`:`<div style="width:100%;height:100%;background:var(--brand-dim);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;color:var(--brand-text);">${fmt.initials(p.pro?.full_name||'Pro')}</div>`}
              </div>
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
                  <div style="font-size:16px;font-weight:600;">${p.pro?.full_name||'Pro'}</div>
                  ${p.seeking_type?`<span class="badge ${seekingColors[p.seeking_type]||'badge-gray'}">${seekingLabels[p.seeking_type]||p.seeking_type}</span>`:''}
                </div>
                <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:3px;">${p.pro?.certification||'Tennis Pro'} . ${p.years_experience?p.years_experience+' yrs exp . ':''} ${[p.location_city,p.location_state].filter(Boolean).join(', ')||'Location not set'}</div>
                ${p.specialties?`<div style="font-size:12.5px;color:var(--brand);font-weight:500;">${p.specialties}</div>`:''}
                ${ratingMap[p.pro_id]?.count ? `<div style="font-size:12.5px;color:var(--warning);margin-top:2px;">${'[*]'.repeat(Math.round(ratingMap[p.pro_id].sum/ratingMap[p.pro_id].count))} ${(ratingMap[p.pro_id].sum/ratingMap[p.pro_id].count).toFixed(1)} (${ratingMap[p.pro_id].count} review${ratingMap[p.pro_id].count!==1?'s':''})</div>` : ''}
              </div>
            </div>
            ${p.bio?`<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">${p.bio}</div>`:''}
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <div style="font-size:12.5px;color:var(--text-tertiary);">Rate: ${fmt.money(p.pro?.private_rate)}/hr . Currently: ${p.pro?.club_name||'Independent'}</div>
              <button class="btn btn-sm btn-blue" onclick="contactProManager('${p.pro?.full_name||'Pro'}','${p.pro_id}')">Contact pro</button>
            </div>
          </div>`).join('')}
    </div>`;
}

function filterProProfiles() {
  const q = (document.getElementById('mgr-pro-filter')?.value||'').toLowerCase();
  const seeking = document.getElementById('mgr-seeking-filter')?.value||'';
  document.querySelectorAll('.s-pro').forEach(card => {
    const matchesQ = !q || card.textContent.toLowerCase().includes(q);
    const matchesSeeking = !seeking || card.dataset.seeking===seeking || card.dataset.seeking==='any';
    card.style.display = matchesQ && matchesSeeking ? '' : 'none';
  });
}

function contactProManager(name, proId) {
  openModal(`
    <div class="modal-title">Contact ${name}</div>
    <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px;line-height:1.5;">Send a message to this pro through CourtPro. They will receive a notification.</p>
    <div class="form-group"><label class="form-label">Your message</label><textarea id="contact-msg" rows="4" placeholder="Hi ${name}, I came across your profile and I'd like to discuss a position at ${currentProfile.club_name}..."></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-blue" id="contact-btn" onclick="sendContactMessage('${proId}','${name}')">Send message</button>
    </div>`);
}

async function sendContactMessage(proId, proName) {
  const msg = document.getElementById('contact-msg')?.value.trim();
  if (!msg) { toast('Please write a message.','error'); return; }
  saveBusy('contact-btn', true, 'Send message');
  const { error } = await db.from('messages').insert({ from_id: currentProfile.id, to_id: proId, body: msg });
  if (!error) await createNotification(proId, 'message', `Message from ${currentProfile.full_name}`, msg.slice(0,100), 'dashboard');
  saveBusy('contact-btn', false, 'Send message');
  if (error) { toast('Error sending message.', 'error'); return; }
  toast(`Message sent to ${proName}!`); closeModal();
}

// --- MANAGER: APPLICATIONS -------------------------------
async function pgMgrApplications(el) {
  const { data: apps } = await db.from('job_applications').select('*, job:job_id(title, job_type)').eq('manager_id', currentProfile.id).order('created_at', { ascending: false });
  const typeLabels = { full_time:'Full-time', part_time:'Part-time', summer:'Summer' };

  // mark new ones as seen
  if (apps?.some(a=>a.status==='new')) {
    await db.from('job_applications').update({status:'viewed'}).eq('manager_id',currentProfile.id).eq('status','new');
  }

  el.innerHTML = `
    <div style="margin-bottom:12px;font-size:13.5px;color:var(--text-secondary);">${apps?.length||0} application${apps?.length!==1?'s':''} received across all your job postings.</div>
    <div class="card">
      ${searchBar('app-search','Search applicants...')}
      <div id="app-list">
        ${!apps?.length?emptyState('LIST','No applications yet','Post a job opening to start receiving applications.','Post a Job','go("postjob")')
          :apps.map(a=>`
            <div class="s-row" style="padding:18px 16px;border-bottom:1px solid var(--border);">
              <div style="display:flex;gap:14px;margin-bottom:12px;">
                <div style="width:56px;height:56px;border-radius:50%;overflow:hidden;flex-shrink:0;border:2px solid var(--border);">
                  ${a.pro_portrait?`<img src="${a.pro_portrait}" style="width:100%;height:100%;object-fit:cover;"/>`:`<div style="width:100%;height:100%;background:var(--brand-dim);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:var(--brand-text);">${fmt.initials(a.pro_name||'Pro')}</div>`}
                </div>
                <div style="flex:1;">
                  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                    <div>
                      <div style="font-size:15px;font-weight:600;">${a.pro_name||'Applicant'}</div>
                      <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">${a.pro_certification||'Tennis Pro'} . ${a.pro_location||'Location not provided'}</div>
                    </div>
                    <div style="text-align:right;">
                      <div style="font-size:13px;font-weight:500;color:var(--brand);">${fmt.money(a.rate_expectation)}/hr</div>
                      <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">${fmt.relativeDate(a.created_at)}</div>
                    </div>
                  </div>
                  ${a.pro_specialties?`<div style="font-size:12.5px;color:var(--brand);margin-top:3px;font-weight:500;">${a.pro_specialties}</div>`:''}
                </div>
              </div>
              <div style="background:var(--bg);border-radius:7px;padding:10px 12px;margin-bottom:10px;">
                <div style="font-size:11px;font-weight:500;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Applied for: ${a.job?.title||'Position'}</div>
                ${a.pro_bio?`<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">${a.pro_bio.slice(0,200)}${a.pro_bio.length>200?'...':''}</div>`:''}
                ${a.cover_note?`<div style="font-size:13px;color:var(--text-primary);line-height:1.6;font-style:italic;">"${a.cover_note}"</div>`:''}
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-sm btn-primary" onclick="addProToClub('${a.pro_id}','${a.pro_name}')">Add to your club</button>
                <button class="btn btn-sm" onclick="updateApplicationStatus('${a.id}','shortlisted')">Shortlist</button>
                <button class="btn btn-sm btn-decline" onclick="updateApplicationStatus('${a.id}','rejected')">Decline</button>
              </div>
            </div>`).join('')}
      </div>
    </div>`;
}

async function updateApplicationStatus(id, status) {
  await db.from('job_applications').update({ status }).eq('id', id);
  toast(status === 'shortlisted' ? 'Applicant shortlisted!' : 'Application declined.');
  go('applications');
}

// --- CLIENT PAGES ----------------------------------------
async function pgClientDashboard(el) {
  actionBtn('+ Log Match', 'btn-purple', 'modalLogMatch()');
  const [{ data: lessons }, { data: notes }, { data: matches }] = await Promise.all([
    db.from('lessons').select('*').eq('client_id',currentProfile.id).order('scheduled_at',{ascending:true}),
    db.from('session_notes').select('*').eq('client_id',currentProfile.id).eq('shared_with_client',true).order('created_at',{ascending:false}),
    db.from('match_logs').select('*').eq('client_id',currentProfile.id).order('match_date',{ascending:false})
  ]);
  const upcoming = (lessons||[]).filter(l=>(l.status==='confirmed'||l.status==='upcoming')&&new Date(l.scheduled_at)>new Date());
  const next = upcoming[0];
  const wins = (matches||[]).filter(m=>m.result==='win').length;
  const total = matches?.length||0;
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total lessons</div><div class="stat-value">${lessons?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">Coach notes</div><div class="stat-value">${notes?.length||0}</div><div class="stat-sub">shared with you</div></div>
      <div class="stat-card"><div class="stat-label">Matches</div><div class="stat-value">${total}</div></div>
      <div class="stat-card"><div class="stat-label">Win rate</div><div class="stat-value">${total>0?Math.round(wins/total*100):0}%</div></div>
    </div>
    ${lessons?.length===0&&notes?.length===0?`<div class="card" style="margin-bottom:16px;">
      <div class="card-header"><div class="card-title">What would you like to do?</div></div>
      <div class="quick-actions">
        <button class="quick-action" onclick="go('book')"><div class="quick-action-icon">[cal]</div><div class="quick-action-label">Request lesson</div></button>
        <button class="quick-action" onclick="modalLogMatch()"><div class="quick-action-icon">[tennis]</div><div class="quick-action-label">Log a match</div></button>
        <button class="quick-action" onclick="go('findpro')"><div class="quick-action-icon">[user]</div><div class="quick-action-label">Find a pro</div></button>
      </div>
    </div>`:``}
    <div class="two-col">
      <div>
        ${next?`
          <div class="card" style="margin-bottom:16px;">
            <div class="card-header"><div class="card-title">Next lesson</div><span class="badge badge-purple">${fmt.date(next.scheduled_at)} . ${fmt.time(next.scheduled_at)}</span></div>
            <div class="info-grid">
              <div class="info-box"><div class="info-lbl">Court</div><div class="info-val">${next.court||'TBD'}</div></div>
              <div class="info-box"><div class="info-lbl">Duration</div><div class="info-val">${next.duration_minutes||60} min</div></div>
            </div>
            ${next.client_confirmed?'<div style="padding:0 16px 14px;"><span class="badge badge-green">Attendance confirmed OK</span></div>':`<div style="padding:0 16px 14px;"><button class="btn btn-accept" onclick="confirmAttendance('${next.id}')">Confirm my attendance</button></div>`}
          </div>`:''}
        <div class="card">
          <div class="card-header"><div class="card-title">Latest coach notes</div><button class="card-action" onclick="go('notes')">View all</button></div>
          ${!notes?.length?emptyState('NOTE','No notes yet','Your coach will share session notes here after each lesson.',null,null)
            :notes.slice(0,2).map(n=>`
              <div style="padding:14px 16px;border-bottom:1px solid var(--border);">
                <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:5px;">${fmt.date(n.created_at)} ${n.focus_area?'. '+n.focus_area:''}</div>
                <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;">${n.pro_notes||n.what_worked||'--'}</div>
              </div>`).join('')}
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">Recent matches</div><button class="card-action" onclick="go('matchlog')">View all</button></div>
          ${!matches?.length?emptyState('[T]','No matches logged','Track your results here.','Log a Match','modalLogMatch()')
            :matches.slice(0,5).map(m=>`
              <div class="list-item">
                <div class="list-item-info">
                  <div class="list-item-title">vs. ${m.opponent_name||'Opponent'}</div>
                  <div class="list-item-meta">${m.score||'--'} . ${fmt.date(m.match_date)}</div>
                </div>
                <span class="badge ${m.result==='win'?'badge-green':'badge-red'}">${m.result}</span>
              </div>`).join('')}
        </div>
      </div>
    </div>`;
}

async function pgClientUpcoming(el) {
  const now = new Date().toISOString();
  const { data: lessons } = await db.from('lessons').select('*, pro:pro_id(full_name)').eq('client_id',currentProfile.id).in('status',['upcoming','confirmed','pending']).order('scheduled_at',{ascending:true});
  const future = (lessons||[]).filter(l=>l.scheduled_at>=now);
  const past = (lessons||[]).filter(l=>l.scheduled_at<now);
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><div class="card-title">Upcoming lessons</div><span class="badge badge-${future.length>0?'purple':'gray'}">${future.length} scheduled</span></div>
      ${!future.length?emptyState('CAL','No upcoming lessons','Your coach or manager will schedule lessons. You can also book directly.','Request a Lesson','go("book")')
        :future.map(l=>`
          <div class="list-item s-row" style="flex-wrap:wrap;gap:8px;">
            <div class="list-status-dot blue"></div>
            <div class="list-item-info">
              <div class="list-item-title">${l.type} lesson . ${l.court||'TBD'}</div>
              <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${fmt.time(l.scheduled_at)} . ${l.pro?.full_name||'Pro TBD'} . ${l.duration_minutes||60} min . ${fmt.money(l.rate)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              ${statusBadge(l.status)}
              ${l.client_confirmed?'<span class="badge badge-green">Confirmed OK</span>':`<button class="btn btn-sm btn-accept" onclick="confirmAttendance('${l.id}')">Confirm attendance</button>`}
            </div>
          </div>`).join('')}
    </div>
    ${past.length>0?`
    <div class="card">
      <div class="card-header"><div class="card-title">Recently passed</div></div>
      ${past.slice(0,3).map(l=>`
        <div class="list-item s-row">
          <div class="list-status-dot amber"></div>
          <div class="list-item-info">
            <div class="list-item-title">${l.type} lesson . ${l.court||'TBD'}</div>
            <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${l.pro?.full_name||'Pro'}</div>
          </div>
          ${statusBadge(l.status)}
        </div>`).join('')}
    </div>`:''}`;
}

async function confirmAttendance(id) {
  const { error } = await db.from('lessons').update({client_confirmed:true}).eq('id',id);
  if (error) { toast('Error.','error'); return; }
  toast('Attendance confirmed! Your pro has been notified.'); go('upcoming');
}

async function pgClientBook(el) {
  el.innerHTML = '<div class="page-loading">Loading pros...</div>';
  const [{ data: clubPros }, { data: allPros }] = await Promise.all([
    db.from('profiles').select('*').eq('role','pro').eq('club_name', currentProfile.club_name || '__none__'),
    db.from('profiles').select('*').eq('role','pro').neq('club_name', currentProfile.club_name || '__none__').limit(50)
  ]);

  function proCard(p) {
    return `
      <div style="border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden;">
        <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;">
          ${avatar(p.full_name,42)}
          <div style="flex:1;">
            <div style="font-size:14px;font-weight:500;">${p.full_name}</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">${p.certification||'Tennis Pro'} . ${p.club_name||'Independent'}</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openProRequestModal('${p.id}','${p.full_name}',${p.private_rate||120})">Request lesson</button>
        </div>
        <div id="avail-${p.id}" style="width:100%;"></div>
      </div>`;
  }

  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <div class="card-title">Pros at ${currentProfile.club_name||'your club'}</div>
        <span class="badge badge-green">${clubPros?.length||0} pros</span>
      </div>
      <div style="padding:16px;">
        ${!clubPros?.length
          ? emptyState('[T]','No pros at your club yet','Book with any pro below, or ask your manager to add pros to your club.',null,null)
          : (clubPros||[]).map(proCard).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title">All pros on CourtPro</div>
        <span class="badge badge-gray">${allPros?.length||0} available</span>
      </div>
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);">
        <input type="text" id="all-pros-search" placeholder="Search by name, certification..." style="width:100%;" oninput="filterAllPros()"/>
      </div>
      <div id="all-pros-list" style="padding:16px;">
        ${!allPros?.length
          ? '<div style="font-size:13px;color:var(--text-tertiary);">No other pros found on the platform yet.</div>'
          : (allPros||[]).map(p => `<div class="all-pro-row" data-name="${p.full_name.toLowerCase()}" data-cert="${(p.certification||'').toLowerCase()}" data-club="${(p.club_name||'').toLowerCase()}">${proCard(p)}</div>`).join('')}
      </div>
    </div>`;
}

function filterAllPros() {
  const q = (document.getElementById('all-pros-search')?.value || '').trim();
  const el = document.getElementById('all-pros-list');
  if (!el) return;
  if (!q) {
    document.querySelectorAll('.all-pro-row').forEach(r => r.style.display = '');
    return;
  }
  document.querySelectorAll('.all-pro-row').forEach(row => {
    const score = Math.max(
      smartScore(row.dataset.name || '', q),
      smartScore(row.dataset.cert || '', q),
      smartScore(row.dataset.club || '', q),
      smartScore(row.textContent, q)
    );
    row.style.display = score > 15 ? '' : 'none';
  });
}

async function showProAvailability(proId, proName, rate) {
  const el = document.getElementById(`avail-${proId}`);
  if (el.innerHTML !== '') { el.innerHTML = ''; return; }
  el.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--text-tertiary);">Loading availability...</div>';
  const { data: slots } = await db.from('availability').select('*').eq('pro_id',proId).order('day_of_week').order('start_time');
  if (!slots?.length) { el.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--text-tertiary);">No availability set. Contact your pro directly.</div>'; return; }
  el.innerHTML = `
    <div style="border-top:1px solid var(--border);padding:12px 16px;background:var(--bg);">
      <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Available slots -- click to request</div>
      ${[0,1,2,3,4,5,6].map(d=>{
        const ds = slots.filter(s=>s.day_of_week===d);
        if (!ds.length) return '';
        return `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div style="font-size:12px;color:var(--text-tertiary);width:80px;flex-shrink:0;">${fmt.dayName(d)}</div>
          ${ds.map(s=>`<button class="btn btn-sm btn-accept" onclick="modalRequestBooking('${proId}','${proName}',${rate},${d},'${s.start_time}','${s.end_time}')">${s.start_time}-${s.end_time}</button>`).join('')}
        </div>`;
      }).join('')}
    </div>`;
}

function modalRequestBooking(proId, proName, rate, day, startTime, endTime) {
  const today = new Date();
  const daysUntil = (day - today.getDay() + 7) % 7 || 7;
  const nextDate = new Date(today);
  nextDate.setDate(today.getDate() + daysUntil);
  const dateStr = nextDate.toISOString().split('T')[0];
  openModal(`
    <div class="modal-title">Request lesson with ${proName}</div>
    <div style="background:var(--brand-dim);border-radius:8px;padding:12px 14px;margin-bottom:18px;">
      <div style="font-size:13.5px;font-weight:500;color:var(--brand-text);">${fmt.dayName(day)} . ${startTime} - ${endTime}</div>
      <div style="font-size:12px;color:var(--brand-text);opacity:0.8;margin-top:2px;">Next available: ${fmt.date(dateStr)}</div>
    </div>
    <div class="form-group"><label class="form-label">Preferred date</label><input type="date" id="br-date" value="${dateStr}"/></div>
    <div class="form-group"><label class="form-label">Lesson type</label><select id="br-type"><option value="private">Private (1 on 1)</option><option value="semi-private">Semi-private</option></select></div>
    <div class="form-group"><label class="form-label">Court preference (optional)</label><input type="text" id="br-court" placeholder="e.g. Court 2, any court"/></div>
    <div class="form-group"><label class="form-label">What would you like to focus on?</label>
      <select id="br-focus">
        <option value="">No preference</option>
        ${LESSON_FOCUS_AREAS.map(f=>`<option value="${f}">${f}</option>`).join('')}
      </select>
    </div>
    <div class="form-group"><label class="form-label">Message to pro (optional)</label><textarea id="br-notes" rows="2" placeholder="Any specific goals or things to mention?"></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="br-btn" onclick="submitBookingRequest('${proId}',${rate},'${startTime}')">Send request</button>
    </div>`);
}

async function openProRequestModal(proId, proName, rate) {
  proName = decodeURIComponent(proName || '');
  openModal(`<div class="modal-title">Request lesson . ${proName}</div>
    <div style="display:flex;flex-direction:column;align-items:center;padding:24px;gap:8px;">
      <div class="spinner"></div><div style="font-size:13px;color:var(--text-tertiary);">Loading availability...</div>
    </div>`);
  const [{ data: slots }, { data: ratingRows }] = await Promise.all([
    db.from('availability').select('*').eq('pro_id', proId).order('day_of_week').order('start_time'),
    db.from('ratings').select('stars').eq('pro_id', proId)
  ]);
  const avgRating = ratingRows?.length ? (ratingRows.reduce((s,r)=>s+(r.stars||0),0)/ratingRows.length) : 0;
  const ratingHtml = avgRating > 0
    ? `<div style="font-size:12.5px;color:var(--warning);margin-top:3px;">${'[*]'.repeat(Math.round(avgRating))}${'[*]'.repeat(5-Math.round(avgRating))} ${avgRating.toFixed(1)} (${ratingRows.length} review${ratingRows.length!==1?'s':''})</div>`
    : '';
  const today = new Date();
  function nextDateForDay(dow) {
    const d = new Date(today);
    const diff = (dow - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().split('T')[0];
  }
  const slotsByDay = {};
  (slots||[]).forEach(s => { if (!slotsByDay[s.day_of_week]) slotsByDay[s.day_of_week] = []; slotsByDay[s.day_of_week].push(s); });
  const slotsHtml = slots?.length
    ? `<div style="margin-bottom:16px;"><div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Available slots -- click to pre-fill</div>
        ${[0,1,2,3,4,5,6].map(d => {
          const ds = slotsByDay[d] || [];
          if (!ds.length) return '';
          return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
            <div style="font-size:12px;color:var(--text-tertiary);width:72px;flex-shrink:0;">${fmt.dayName(d)}</div>
            ${ds.map(s => `<button class="btn btn-sm" style="font-size:11px;" onclick="preFillSlot('${s.start_time}','${nextDateForDay(d)}',this)">${s.start_time}-${s.end_time}</button>`).join('')}
          </div>`;
        }).join('')}</div>`
    : `<div style="background:var(--warning-dim);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12.5px;color:var(--warning);">[warn] No weekly slots set yet. Enter any date and time below.</div>`;
  openModal(`
    <div class="modal-title">Request lesson . ${proName}</div>
    <div style="background:var(--brand-dim);border-radius:8px;padding:10px 14px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:500;color:var(--brand-text);">${proName}</div>
      ${ratingHtml}
    </div>
    ${slotsHtml}
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date</label><input type="date" id="br-date" value="${today.toISOString().split('T')[0]}" min="${today.toISOString().split('T')[0]}"/></div>
      <div class="form-group"><label class="form-label">Time</label><input type="time" id="br-time" value="09:00"/></div>
    </div>
    <div class="form-group"><label class="form-label">Lesson type</label>
      <select id="br-type"><option value="private">Private (1 on 1)</option><option value="semi-private">Semi-private</option></select>
    </div>
    <div class="form-group"><label class="form-label">Focus area (optional)</label>
      <select id="br-focus"><option value="">No preference</option>${LESSON_FOCUS_AREAS.map(f=>`<option value="${f}">${f}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label class="form-label">Court preference (optional)</label><input type="text" id="br-court" placeholder="e.g. Court 2, any"/></div>
    <div class="form-group"><label class="form-label">Message (optional)</label><textarea id="br-notes" rows="2" placeholder="Goals, skill level, anything to mention..."></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="br-btn" onclick="submitBookingRequest('${proId}',${rate},null)">Send request</button>
    </div>`);
}

function preFillSlot(startTime, dateStr, btn) {
  const dateInput = document.getElementById('br-date');
  const timeInput = document.getElementById('br-time');
  if (dateInput) dateInput.value = dateStr;
  if (timeInput) timeInput.value = startTime;
  document.querySelectorAll('#modal-container .btn-sm').forEach(b => { b.style.background=''; b.style.borderColor=''; });
  if (btn) { btn.style.background='var(--brand-dim)'; btn.style.borderColor='var(--brand)'; }
}

async function submitBookingRequest(proId, rate, startTime) {
  if (_busy.booking) return; _busy.booking = true; saveBusy('br-btn', true, 'Sending...');
  const reqDate = document.getElementById('br-date')?.value;
  const reqTime = startTime || document.getElementById('br-time')?.value || '09:00';
  if (!reqDate) { toast('Please choose a date.', 'error'); _busy.booking = false; saveBusy('br-btn', false, 'Send request'); return; }
  const { error } = await db.from('booking_requests').insert({
    pro_id: proId,
    client_id: currentProfile.id,
    requested_date: reqDate,
    requested_time: reqTime,
    lesson_type: document.getElementById('br-type')?.value || 'private',
    court: document.getElementById('br-court')?.value || null,
    notes: document.getElementById('br-notes')?.value || null,
    rate: parseFloat(rate) || 0,
    status: 'pending'
  });
  _busy.booking = false; saveBusy('br-btn', false, 'Send request');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  await createNotification(proId, 'booking_request', `Lesson request from ${currentProfile.full_name}`, `${fmt.date(reqDate)} at ${reqTime}`, 'availability');
  closeModal(); toast('Request sent! Your coach will confirm shortly. OK');
}



async function pgClientDevPlan(el) {
  const { data: notes } = await db.from('session_notes').select('objectives, homework, created_at, focus_area, category').eq('client_id',currentProfile.id).eq('shared_with_client',true).order('created_at',{ascending:false});
  const withObjectives = (notes||[]).filter(n=>n.objectives||n.homework);
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><div class="card-title">My development plan</div><div style="font-size:12px;color:var(--text-tertiary);">Built from your coach's session notes</div></div>
      ${!withObjectives.length?emptyState('[target]','No plan items yet',notes?.length?'Your coach has shared notes but hasn\'t added specific objectives yet. Ask them to add next-session goals.':'Your coach will add objectives and homework after sessions and share them with you. They build your plan automatically.',null,null)
        :withObjectives.map((n,i)=>`
          <div style="display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);">
            <div style="width:26px;height:26px;border-radius:50%;background:var(--pkl-dim);color:var(--pkl-text);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;margin-top:2px;">${i+1}</div>
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
                <div style="font-size:12px;color:var(--text-tertiary);">${fmt.date(n.created_at)}</div>
                ${n.focus_area?`<span class="badge badge-gray">${n.focus_area}</span>`:''}
                ${n.category?`<span class="badge badge-blue">${n.category}</span>`:''}
              </div>
              ${n.objectives?`<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:6px;">${n.objectives}</div>`:''}
              ${n.homework?`<div style="background:var(--pkl-dim);border-radius:6px;padding:7px 10px;font-size:12.5px;color:var(--pkl-text);">Drill: ${n.homework}</div>`:''}
            </div>
          </div>`).join('')}
    </div>`;
}

async function pgClientHistory(el) {
  const { data: lessons } = await db.from('lessons').select('*, pro:pro_id(full_name)').eq('client_id',currentProfile.id).order('scheduled_at',{ascending:false});
  el.innerHTML = `<div class="card">
    ${searchBar('hist-search','Search lesson history...')}
    <div id="hist-list">
      ${!lessons?.length?emptyState('CAL','No lesson history yet','Your lessons will appear here.',null,null)
        :lessons.map(l=>`
          <div class="list-item s-row">
            <div class="dot ${l.status==='completed'?'':l.status==='upcoming'?'dot-blue':'dot-amber'}"></div>
            <div class="list-item-info">
              <div class="list-item-title">${l.type} lesson . ${l.court||'TBD'}${l.focus_area?' . '+l.focus_area:''}</div>
              <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${l.pro?.full_name||'Pro'} . ${l.duration_minutes||60} min</div>
            </div>
            ${statusBadge(l.status)}
          </div>`).join('')}
    </div>
  </div>`;
}

async function pgClientMatchLog(el) {
  actionBtn('+ Log Match', 'btn-purple', 'modalLogMatch()');
  const { data: matches } = await db.from('match_logs').select('*').eq('client_id',currentProfile.id).order('match_date',{ascending:false});
  const wins = (matches||[]).filter(m=>m.result==='win').length;
  const losses = (matches||[]).filter(m=>m.result==='loss').length;
  const total = matches?.length||0;
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Matches</div><div class="stat-value">${total}</div></div>
      <div class="stat-card"><div class="stat-label">Wins</div><div class="stat-value" style="color:var(--brand)">${wins}</div></div>
      <div class="stat-card"><div class="stat-label">Losses</div><div class="stat-value" style="color:var(--danger)">${losses}</div></div>
      <div class="stat-card"><div class="stat-label">Win rate</div><div class="stat-value">${total>0?Math.round(wins/total*100):0}%</div></div>
    </div>
    <div class="card">
      ${searchBar('ml-search','Search matches...')}
      <div id="ml-list">
        ${!matches?.length?emptyState('[T]','No matches yet','Log your first match to start tracking your progress.','Log a Match','modalLogMatch()')
          :matches.map(m=>`
            <div class="s-row" style="padding:13px 16px;border-bottom:1px solid var(--border);">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:3px;">
                <div style="font-size:13.5px;font-weight:500;">vs. ${m.opponent_name||'Opponent'}</div>
                <span class="badge ${m.result==='win'?'badge-green':'badge-red'}">${m.result}</span>
              </div>
              <div style="font-size:12px;color:var(--text-tertiary);">${m.score||'--'} . ${m.match_type||'Match'} . ${fmt.date(m.match_date)}</div>
              ${m.notes?`<div style="font-size:12.5px;color:var(--text-secondary);margin-top:5px;line-height:1.5;">${m.notes}</div>`:''}
            </div>`).join('')}
      </div>
    </div>`;
}

async function pgClientProgress(el) {
  // Load skill ratings from DB (not localStorage)
  const { data: ratings } = await db.from('skill_ratings').select('*').eq('client_id', currentProfile.id).order('created_at', { ascending: false });
  // Get latest rating per skill
  const latestBySkill = {};
  (ratings||[]).forEach(r => { if (!latestBySkill[r.skill_id]) latestBySkill[r.skill_id] = r.rating; });
  const { data: matches } = await db.from('match_logs').select('result').eq('client_id', currentProfile.id);
  const wins = (matches||[]).filter(m=>m.result==='win').length;
  const total = matches?.length||0;
  el.innerHTML = `
    <div class="two-col">
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">Skill ratings</div><div style="font-size:12px;color:var(--text-tertiary);">Updated by your coach after sessions</div></div>
          <div style="padding:16px;">
            ${['Technique','Net game','Return','Tactics','Physical','Mental'].map(cat=>`
              <div style="margin-bottom:20px;">
                <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">${cat}</div>
                ${sportSkills.filter(s=>(s.cat||s.category)===cat).map(skill => skillBar(skill, latestBySkill[skill.id]||0)).join('')}
              </div>`).join('')}
            <p style="font-size:12.5px;color:var(--text-tertiary);line-height:1.5;margin-top:8px;">Ask your coach to rate your skills after your next session. Ratings are stored in the cloud, not just on this device.</p>
          </div>
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">Match stats</div></div>
          <div style="padding:16px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
              <div style="background:var(--bg);border-radius:8px;padding:12px;text-align:center;"><div style="font-size:24px;font-weight:600;color:var(--brand);">${wins}</div><div style="font-size:12px;color:var(--text-tertiary);">Wins</div></div>
              <div style="background:var(--bg);border-radius:8px;padding:12px;text-align:center;"><div style="font-size:24px;font-weight:600;">${total>0?Math.round(wins/total*100):0}%</div><div style="font-size:12px;color:var(--text-tertiary);">Win rate</div></div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">How to improve faster</div></div>
          <div style="padding:16px;">
            ${[['Attend lessons regularly','Consistency is the fastest route to improvement.'],['Log your matches','Spot patterns in wins and losses.'],['Practice your homework drills','Short daily practice compounds quickly.'],['Read your session notes','Re-read what your coach wrote after every lesson.']].map(([t,d])=>`<div style="margin-bottom:12px;"><div style="font-size:13px;font-weight:500;margin-bottom:2px;">${t}</div><div style="font-size:12px;color:var(--text-tertiary);line-height:1.5;">${d}</div></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
}

// pgClientDrills + filterDrills replaced -- see new_features

async function pgClientLeaderboard(el) {
  const club = currentProfile.club_name;
  if (!club) { el.innerHTML = `<div class="card">${emptyState('[trophy]','No club set','Update your profile with your club name to see the leaderboard.',null,null)}</div>`; return; }
  // Single query for all members + join match_logs aggregated
  const [{ data: members }, { data: allMatches }] = await Promise.all([
    db.from('profiles').select('id,full_name').eq('role','client').eq('club_name',club),
    db.from('match_logs').select('client_id,result').in('client_id',
      (await db.from('profiles').select('id').eq('role','client').eq('club_name',club)).data?.map(m=>m.id)||[]
    )
  ]);
  if (!members?.length) { el.innerHTML = `<div class="card">${emptyState('[trophy]','No members yet','Club members appear here once they join.',null,null)}</div>`; return; }
  const matchMap = {};
  (allMatches||[]).forEach(m => {
    if (!matchMap[m.client_id]) matchMap[m.client_id] = { wins:0, total:0 };
    matchMap[m.client_id].total++;
    if (m.result === 'win') matchMap[m.client_id].wins++;
  });
  const ranked = members.map(m => {
    const s = matchMap[m.id] || { wins:0, total:0 };
    return { ...m, wins:s.wins, total:s.total, winRate:s.total>0?Math.round(s.wins/s.total*100):0 };
  }).sort((a,b) => b.wins - a.wins || b.winRate - a.winRate || a.full_name.localeCompare(b.full_name));
  const medals = ['[*]','[*]','[*]'];
  const myRank = ranked.findIndex(r=>r.id===currentProfile.id)+1;
  el.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">Club leaderboard . ${club}</div><div style="font-size:12px;color:var(--text-tertiary);">Based on match wins</div></div>
      ${myRank>0?`<div style="background:var(--pkl-dim);border-radius:8px;margin:12px 16px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13.5px;font-weight:600;color:var(--pkl-text);">Your rank: #${myRank} of ${ranked.length}</div><button class="btn btn-sm" onclick="modalLogMatch()">+ Log match</button></div>`:''}
      ${ranked.map((m,i) => {
        const isMe = m.id === currentProfile.id;
        return `<div class="list-item" style="background:${isMe?'var(--pkl-dim)':''};">
          <div style="width:28px;text-align:center;font-size:${i<3?'18':'13'}px;flex-shrink:0;">${medals[i]||`<span style="color:var(--text-tertiary);font-weight:600;">${i+1}</span>`}</div>
          <div style="width:34px;height:34px;border-radius:50%;background:var(--brand-dim);color:var(--brand-text);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;">${fmt.initials(m.full_name)}</div>
          <div class="list-item-info">
            <div class="list-item-title" style="${isMe?'color:var(--pkl-text);font-weight:600;':''}">
              ${m.full_name}${isMe?' (you)':''}
            </div>
            <div class="list-item-meta">${m.wins} win${m.wins!==1?'s':''} . ${m.total} match${m.total!==1?'es':''} . ${m.total>0?m.winRate+'% win rate':'No matches logged yet'}</div>
          </div>
          ${i===0&&m.total>0?'<span style="font-size:16px;">[*]</span>':''}
        </div>`;
      }).join('')}
      ${ranked.every(m=>m.total===0)?`<div style="padding:16px;font-size:13px;color:var(--text-tertiary);text-align:center;border-top:1px solid var(--border);">No matches logged yet -- be the first!</div>`:''}
    </div>`;
}

async function pgClientMyPro(el) {
  const { data: lessons } = await db.from('lessons').select('pro_id').eq('client_id',currentProfile.id).not('pro_id','is',null).order('scheduled_at',{ascending:false}).limit(5);
  if (!lessons?.length) { el.innerHTML = `<div class="card">${emptyState('[T]','No pro assigned yet','Book a lesson or ask your club manager.','Find a Pro','go("findpro")')}</div>`; return; }
  const { data: pro } = await db.from('profiles').select('*').eq('id',lessons[0].pro_id).single();
  if (!pro) { el.innerHTML = `<div class="card">${emptyState('[T]','Pro not found','Please contact your club manager.',null,null)}</div>`; return; }
  el.innerHTML = `
    <div class="card" style="max-width:480px;">
      <div style="padding:20px 16px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--border);">
        ${avatar(pro.full_name,52)}
        <div>
          <div style="font-size:17px;font-weight:600;">${pro.full_name}</div>
          <div style="font-size:13px;color:var(--text-tertiary);margin-top:3px;">${pro.certification||'Tennis Pro'} . ${pro.club_name}</div>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-box"><div class="info-lbl">Private rate</div><div class="info-val">${fmt.money(pro.private_rate)}/hr</div></div>
        <div class="info-box"><div class="info-lbl">Clinic rate</div><div class="info-val">${fmt.money(pro.clinic_rate)}/student</div></div>
      </div>
      <div style="padding:14px 16px;border-top:1px solid var(--border);">
        <button class="btn btn-primary btn-full" onclick="openProRequestModal('${pro.id}','${pro.full_name}',${pro.private_rate||120})" style="margin-bottom:10px;">Request another lesson</button>
        <button class="btn btn-full" onclick="modalAddProForClient()" style="margin-bottom:0;">+ Add another pro</button>
      </div>
      <div style="padding:0 16px 16px;">
        <label class="form-label">Rate your last lesson</label>
        <div id="star-row" style="display:flex;gap:7px;margin:8px 0 14px;">
          ${[1,2,3,4,5].map(s=>`<div onclick="setStars(${s})" data-star="${s}" style="width:34px;height:34px;border-radius:7px;background:var(--bg);cursor:pointer;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:17px;transition:all 0.12s;">[*]</div>`).join('')}
        </div>
        <div class="form-group"><label class="form-label">Feedback (visible to manager only)</label><textarea id="feedback-text" rows="3" placeholder="Share your thoughts..."></textarea></div>
        <button class="btn btn-purple btn-full" onclick="submitRating('${pro.id}')">Submit feedback</button>
      </div>
    </div>`;
}


async function modalAddProForClient() {
  openModal(`
    <div class="modal-title">Add a pro to your account</div>
    <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:14px;line-height:1.5;">Find any pro on CourtPro and add them so you can request lessons directly from them.</p>
    <div style="position:relative;margin-bottom:8px;">
      <div style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-tertiary);pointer-events:none;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <input id="add-pro-search" type="text" placeholder="Search by name, club, or certification..." autocomplete="off"
        style="width:100%;padding:9px 12px 9px 30px;border:1.5px solid var(--border);border-radius:8px;font-size:13.5px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);outline:none;box-sizing:border-box;"
        onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"
        oninput="searchProsToAdd(this.value)"/>
    </div>
    <div id="add-pro-results" style="min-height:80px;max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">
      <div style="text-align:center;padding:24px;color:var(--text-tertiary);font-size:13px;">Type to search pros</div>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal();go('mypro')">Done</button></div>`);
  window._addProDebounced = debounce(async (q) => {
    const res = document.getElementById('add-pro-results');
    if (!res) return;
    if (!q || q.length < 2) { res.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-tertiary);font-size:13px;">Type at least 2 characters</div>'; return; }
    res.innerHTML = `<div style="padding:16px;display:flex;gap:8px;align-items:center;color:var(--text-tertiary);font-size:13px;"><div class="spinner"></div>Searching...</div>`;
    const [r1,r2] = await Promise.all([
      db.from('profiles').select('id,full_name,club_name,certification,private_rate').eq('role','pro').ilike('full_name',`%${q}%`).limit(10),
      db.from('profiles').select('id,full_name,club_name,certification,private_rate').eq('role','pro').ilike('club_name',`%${q}%`).limit(8),
    ]);
    const seen = new Set(); const results = [];
    for (const r of [r1,r2]) for (const p of r.data||[]) if (!seen.has(p.id)) { seen.add(p.id); results.push(p); }
    if (!results.length) { res.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-tertiary);font-size:13px;">No pros found for "${q}"</div>`; return; }
    res.innerHTML = results.map(p => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);">
        ${avatar(p.full_name, 36)}
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:500;">${highlight(p.full_name,q)}</div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:1px;">${p.certification||'Tennis Pro'} . ${p.club_name||'Independent'}</div>
        </div>
        <button class="btn btn-sm btn-primary" id="addpro-btn-${p.id}" onclick="linkProToClient('${p.id}','${encodeURIComponent(p.full_name)}')">Add</button>
      </div>`).join('');
  }, 300);
}

function searchProsToAdd(q) { window._addProDebounced && window._addProDebounced(q); }

async function linkProToClient(proId, proName) {
  proName = decodeURIComponent(proName || '');
  const btn = document.getElementById(`addpro-btn-${proId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
  const { error } = await db.from('client_pros').insert({ client_id: currentProfile.id, pro_id: proId });
  if (error && !error.message.includes('unique')) {
    toast('Error: ' + error.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
    return;
  }
  if (btn) { btn.textContent = 'Added OK'; btn.style.background='var(--brand-dim)'; btn.style.color='var(--brand-text)'; }
  cacheClear();
  toast(`${proName} added to your pros! OK`);
}

async function pgFamilyMembers(el) {
  actionBtn('+ Link member','btn-primary','modalLinkFamilyMember()');
  const { data: links } = await db.from('linked_members')
    .select('*, child:child_id(id,full_name,club_name,role)')
    .eq('parent_id', currentProfile.id);

  el.innerHTML = `
    <div style="background:var(--info-dim);border-radius:10px;padding:14px 18px;margin-bottom:16px;">
      <div style="font-size:13.5px;font-weight:600;color:var(--info);margin-bottom:4px;">[family] Family & linked members</div>
      <div style="font-size:12.5px;color:var(--info);opacity:0.85;line-height:1.6;">Link other members to your account -- children, partners, or anyone you manage. You can book lessons for them, see their coach notes and progress, and manage their schedule.</div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Linked members</div><span class="badge badge-blue">${links?.length||0}</span></div>
      ${!links?.length ? emptyState('[child]','No linked members yet','Use the + Link member button to add family members who are on CourtPro.',null,null)
      : links.map(l => {
        const child = l.child;
        if (!child) return '';
        return `<div class="list-item">
          ${avatar(child.full_name, 40, 'var(--pkl-dim)', 'var(--pkl-text)')}
          <div class="list-item-info">
            <div class="list-item-title">${child.full_name}</div>
            <div class="list-item-meta">${l.relationship} . ${child.club_name||'No club'}</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-primary" onclick="viewLinkedMember('${child.id}','${encodeURIComponent(child.full_name)}')">Manage</button>
            <button class="btn btn-sm btn-decline" onclick="unlinkMember('${l.id}')">Remove</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

async function modalLinkFamilyMember() {
  openModal(`
    <div class="modal-title">Link a family member</div>
    <p style="font-size:13px;color:var(--text-tertiary);margin-bottom:14px;line-height:1.5;">Search for a CourtPro member to link to your account. They need to have an account already. If they don't, send them an invite link first.</p>
    <div class="form-group">
      <label class="form-label">Relationship</label>
      <select id="link-rel"><option value="child">My child</option><option value="partner">My partner</option><option value="other">Other</option></select>
    </div>
    <div style="position:relative;margin-bottom:8px;">
      <div style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-tertiary);pointer-events:none;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <input id="link-search" type="text" placeholder="Search by name..."
        style="width:100%;padding:9px 12px 9px 30px;border:1.5px solid var(--border);border-radius:8px;font-size:13.5px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);outline:none;box-sizing:border-box;"
        onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"
        oninput="searchFamilyMembers(this.value)"/>
    </div>
    <div id="link-results" style="min-height:60px;max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">
      <div style="text-align:center;padding:20px;color:var(--text-tertiary);font-size:13px;">Type to search</div>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal();go('family')">Done</button></div>`);
  window._linkMemberDebounced = debounce(async (q) => {
    const res = document.getElementById('link-results');
    if (!res) return;
    if (!q || q.length < 2) { res.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-tertiary);font-size:13px;">Type at least 2 characters</div>'; return; }
    res.innerHTML='<div style="padding:14px;display:flex;gap:8px;align-items:center;color:var(--text-tertiary);font-size:13px;"><div class="spinner"></div>Searching...</div>';
    const { data } = await db.from('profiles').select('id,full_name,club_name,role').ilike('full_name',`%${q}%`).neq('id',currentProfile.id).limit(10);
    if (!data?.length) { res.innerHTML=`<div style="text-align:center;padding:20px;color:var(--text-tertiary);font-size:13px;">No members found for "${q}"</div>`; return; }
    res.innerHTML = data.map(p => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);">
        ${avatar(p.full_name, 34)}
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:500;">${highlight(p.full_name,q)}</div>
          <div style="font-size:12px;color:var(--text-tertiary);">${p.role} . ${p.club_name||'No club'}</div>
        </div>
        <button class="btn btn-sm btn-primary" id="link-btn-${p.id}" onclick="confirmLinkMember('${p.id}','${encodeURIComponent(p.full_name)}')">Link</button>
      </div>`).join('');
  }, 300);
}

function searchFamilyMembers(q) { window._linkMemberDebounced && window._linkMemberDebounced(q); }

async function confirmLinkMember(memberId, memberName) {
  memberName = decodeURIComponent(memberName || '');
  const rel = document.getElementById('link-rel')?.value || 'child';
  const btn = document.getElementById(`link-btn-${memberId}`);
  if (btn) { btn.disabled=true; btn.textContent='Linking...'; }
  const { error } = await db.from('linked_members').insert({ parent_id: currentProfile.id, child_id: memberId, relationship: rel });
  if (error && !error.message.includes('unique')) {
    toast('Error: ' + error.message, 'error');
    if (btn) { btn.disabled=false; btn.textContent='Link'; }
    return;
  }
  if (btn) { btn.textContent='Linked OK'; btn.style.background='var(--brand-dim)'; btn.style.color='var(--brand-text)'; }
  cacheClear(); toast(`${memberName} linked to your account! OK`);
}

async function unlinkMember(linkId) {
  if (!confirm('Remove this linked member?')) return;
  await db.from('linked_members').delete().eq('id', linkId);
  toast('Member removed.'); cacheClear(); go('family');
}

async function viewLinkedMember(memberId, memberName) {
  memberName = decodeURIComponent(memberName || '');
  // Load the member's data and show management options
  const [{ data: upcoming }, { data: notes }, { data: progress }] = await Promise.all([
    db.from('lessons').select('*').eq('client_id', memberId).in('status',['upcoming','confirmed']).order('scheduled_at'),
    db.from('session_notes').select('*').eq('client_id', memberId).eq('shared_with_client', true).order('created_at',{ascending:false}).limit(3),
    db.from('skill_ratings').select('*').eq('client_id', memberId).order('created_at',{ascending:false}),
  ]);
  const latestSkills = {};
  (progress||[]).forEach(r => { if (!latestSkills[r.skill_id]) latestSkills[r.skill_id] = r.rating; });
  openModal(`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
      ${avatar(memberName, 44, 'var(--pkl-dim)', 'var(--pkl-text)')}
      <div><div style="font-size:16px;font-weight:600;">${memberName}</div><div style="font-size:12.5px;color:var(--text-tertiary);margin-top:2px;">Linked member</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;">
      <div style="background:var(--bg);border-radius:8px;padding:10px 12px;"><div style="font-size:11px;color:var(--text-tertiary);">Upcoming</div><div style="font-size:20px;font-weight:600;">${upcoming?.length||0}</div><div style="font-size:11px;color:var(--text-tertiary);">lessons</div></div>
      <div style="background:var(--bg);border-radius:8px;padding:10px 12px;"><div style="font-size:11px;color:var(--text-tertiary);">Coach notes</div><div style="font-size:20px;font-weight:600;">${notes?.length||0}</div><div style="font-size:11px;color:var(--text-tertiary);">shared</div></div>
    </div>
    ${upcoming?.length ? `<div style="margin-bottom:14px;"><div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">Upcoming lessons</div>${upcoming.slice(0,2).map(l=>`<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">${fmt.date(l.scheduled_at)} . ${fmt.time(l.scheduled_at)} . ${l.type}</div>`).join('')}</div>`:``}
    ${notes?.length ? `<div style="margin-bottom:14px;"><div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">Latest coach notes</div>${notes.slice(0,2).map(n=>`<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-secondary);">${fmt.date(n.created_at)} . ${n.focus_area||'General'}</div>`).join('')}</div>`:``}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <button class="quick-action" onclick="closeModal();openProRequestModalForMember('${memberId}','${memberName}')"><div class="quick-action-icon">[cal]</div><div class="quick-action-label">Book lesson</div></button>
      <button class="quick-action" onclick="closeModal();viewMemberProgress('${memberId}','${memberName}')"><div class="quick-action-icon">[chart]</div><div class="quick-action-label">Progress</div></button>
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

async function openProRequestModalForMember(memberId, memberName) {
  // Store who we're booking FOR
  window._bookingForMemberId = memberId;
  window._bookingForMemberName = memberName;
  go('book');
}

async function viewMemberProgress(memberId, memberName) {
  const { data: ratings } = await db.from('skill_ratings').select('*').eq('client_id', memberId).order('created_at',{ascending:false});
  const latestSkills = {};
  (ratings||[]).forEach(r => { if (!latestSkills[r.skill_id]) latestSkills[r.skill_id] = r.rating; });
  openModal(`
    <div class="modal-title">${memberName} -- Skills</div>
    <div style="max-height:400px;overflow-y:auto;">
      ${Object.keys(latestSkills).length ? TENNIS_SKILLS.map(s => latestSkills[s.id] ? skillBar(s, latestSkills[s.id]) : '').filter(Boolean).join('') : '<div style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:13px;">No skill ratings yet. Ask their coach to rate their skills after a session.</div>'}
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}
async function pgClientFindPro(el) {
  const { data: pros } = await db.from('profiles').select('*').eq('role','pro').eq('club_name',currentProfile.club_name);
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header"><div class="card-title">Search all pros</div></div>
      <div style="padding:16px;">
        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <input type="text" id="find-pro-input" placeholder="Name, certification, city, specialty..." style="flex:1;" oninput="findProDebounced(this.value)"/>
          <button class="btn btn-primary" onclick="searchProForClient()">Search</button>
        </div>
        <div id="find-pro-results"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Pros at ${currentProfile.club_name||'your club'}</div></div>
      ${!pros?.length?emptyState('[T]','No pros at your club yet','Pros who join will appear here.',null,null)
        :pros.map(p=>`
          <div class="list-item">
            ${avatar(p.full_name)}
            <div class="list-item-info">
              <div class="list-item-title">${p.full_name}</div>
              <div class="list-item-meta">${p.certification||'Tennis Pro'} . ${fmt.money(p.private_rate)}/hr</div>
            </div>
            <button class="btn btn-sm btn-primary" onclick="openProRequestModal('${p.id}','${p.full_name}',${p.private_rate||120})">Request</button>
          </div>`).join('')}
    </div>`;
  window.findProDebounced = debounce(async (q) => {
    const el = document.getElementById('find-pro-results');
    if (el) await smartSearchPros(q, el, { showBookBtn: true });
  }, 300);
}

async function searchProForClient() {
  const q = document.getElementById('find-pro-input')?.value.trim() || '';
  const el = document.getElementById('find-pro-results');
  if (!el) return;
  await smartSearchPros(q, el, { showBookBtn: true });
}


async function modalRateClientSkills(clientId, clientName) {
  if (!clientId) { toast('No client linked to rate skills. Add the client to the app first.', 'error'); return; }
  const { data: existing } = await db.from('skill_ratings').select('*').eq('client_id', clientId).order('created_at', { ascending: false });
  const latestBySkill = {};
  (existing||[]).forEach(r => { if (!latestBySkill[r.skill_id]) latestBySkill[r.skill_id] = r.rating; });
  const sportSkills = getSportSkills();
  const cats = [...new Set(sportSkills.map(s=>s.cat||s.category))];
  openModal(`
    <div class="modal-title">Rate ${clientName || 'client'}'s skills</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <span style="font-size:20px;">${getSportConfig().icon}</span>
      <span style="font-size:13px;font-weight:500;">${getSportConfig().label} skills</span>
      <span style="font-size:12px;color:var(--text-tertiary);">. Change sport in Settings</span>
    </div>
    <div style="max-height:360px;overflow-y:auto;">
      ${cats.map(cat=>`
        <div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${cat}</div>
          ${sportSkills.filter(s=>(s.cat||s.category)===cat).map(skill=>`
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <div style="flex:1;font-size:13px;">${skill.label}</div>
              <div style="display:flex;gap:3px;">
                ${[1,2,3,4,5,6,7,8,9,10].map(v=>`<button class="skill-dot" data-skill="${skill.id}" data-val="${v}" onclick="setSkillDot('${skill.id}',${v})" style="width:18px;height:18px;border-radius:50%;border:1.5px solid var(--border);background:${latestBySkill[skill.id]>=v?'var(--brand)':'var(--bg)'};cursor:pointer;padding:0;transition:all 0.1s;"></button>`).join('')}
              </div>
            </div>`).join('')}
        </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="rate-save-btn" onclick="saveSkillRatings('${clientId}')">Save ratings</button>
    </div>`);
  // Store initial values
  window._skillRatings = {}; // reset each time
  Object.assign(window._skillRatings, latestBySkill);
}

function setSkillDot(skillId, val) {
  window._skillRatings = window._skillRatings || {};
  window._skillRatings[skillId] = val;
  document.querySelectorAll(`.skill-dot[data-skill="${skillId}"]`).forEach(dot => {
    dot.style.background = parseInt(dot.dataset.val) <= val ? 'var(--brand)' : 'var(--bg)';
  });
}

async function saveSkillRatings(clientId) {
  if (_busy.skillRate) return; _busy.skillRate = true; saveBusy('rate-save-btn', true, 'Save ratings');
  const ratings = window._skillRatings || {};
  const rows = Object.entries(ratings).map(([skill_id, rating]) => ({
    pro_id: currentProfile.id, client_id: clientId, skill_id, rating: parseInt(rating)
  }));
  if (!rows.length) { toast('No ratings set.', 'error'); _busy.skillRate = false; return; }
  const { error } = await db.from('skill_ratings').insert(rows);
  _busy.skillRate = false; saveBusy('rate-save-btn', false, 'Save ratings');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  closeModal(); toast('Skill ratings saved to player profile!');
}

// --- SHARED ACTIONS --------------------------------------
let selectedStars = 0;
function setStars(n) {
  selectedStars = n;
  document.querySelectorAll('#star-row div').forEach(el => {
    const s = parseInt(el.dataset.star);
    el.textContent = s<=n?'[*]':'[*]';
    el.style.background = s<=n?'var(--warning-dim)':'var(--bg)';
    el.style.borderColor = s<=n?'var(--warning)':'var(--border)';
  });
}

async function submitRating(proId) {
  const feedback = document.getElementById('feedback-text')?.value.trim();
  if (!selectedStars) { toast('Please select a star rating.','error'); return; }
  const { error } = await db.from('ratings').insert({ pro_id:proId, client_id:currentProfile.id, stars:selectedStars, feedback });
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Feedback submitted!'); selectedStars=0;
  document.getElementById('feedback-text').value='';
  document.querySelectorAll('#star-row div').forEach(el=>{el.textContent='[*]';el.style.background='var(--bg)';el.style.borderColor='var(--border)';});
}


async function markPaid(lessonId) {
  const { error } = await db.from('lessons').update({ payment_status: 'paid' }).eq('id', lessonId);
  if (error) { toast('Error.', 'error'); return; }
  toast('Marked as paid!'); cacheClear(); go('lessons');
}

async function respondLesson(id, status) {
  // First check what the lesson looks like
  const { data: lesson, error: fetchErr } = await db
    .from('lessons')
    .select('id, pro_id, client_id, status')
    .eq('id', id)
    .single();

  if (fetchErr || !lesson) {
    toast('Lesson not found. Refresh and try again.', 'error');
    return;
  }

  // Update using the lesson id - RLS policy allows update when
  // pro_id = auth.uid() OR manager owns the club
  const { error } = await db
    .from('lessons')
    .update({ status })
    .eq('id', id);

  if (error) {
    console.error('respondLesson error:', error);
    // Last resort: the RLS lessons_update policy may need adjusting
    // Show the exact error so it's debuggable
    toast('Error: ' + (error.message || 'Could not update lesson'), 'error');
    return;
  }

  // Notify client if they exist
  if (lesson.client_id && status === 'confirmed') {
    await createNotification(
      lesson.client_id,
      'lesson_confirmed',
      'Lesson confirmed!',
      'Your lesson request has been accepted by your coach.',
      'upcoming'
    );
  }

  toast(status === 'confirmed' ? 'Lesson accepted! OK' : 'Lesson declined.');
  cacheClear();
  go('lessons');
}

async function markComplete(id) {
  const { data: lesson } = await db.from('lessons').select('client_id,type,scheduled_at').eq('id',id).single();
  const { error } = await db.from('lessons').update({status:'completed'}).eq('id',id);
  if (error) { toast('Error.','error'); return; }
  if (lesson?.client_id) {
    await createNotification(lesson.client_id,'lesson_complete','Lesson complete!',
      'Your coach may share session notes soon. Check the Coach Notes page.','notes');
  }
  cacheClear(); toast('Lesson marked as complete! OK'); go('lessons');
}

async function markClinicComplete(id) {
  await db.from('clinics').update({status:'completed'}).eq('id',id);
  toast('Clinic marked as completed!'); go('clinics');
}

async function toggleShare(id, current) {
  await db.from('session_notes').update({shared_with_client:!current}).eq('id',id);
  toast(current?'Note set to private.':'Shared with client!'); go('notes');
}

async function saveClientNote(id, text) { await db.from('session_notes').update({client_notes:text}).eq('id',id); }

async function modalAssignPro(lessonId) {
  const { data: pros } = await db.from('profiles').select('*').eq('role','pro').eq('club_name',currentProfile.club_name);
  openModal(`
    <div class="modal-title">Assign a pro</div>
    <div class="form-group"><label class="form-label">Select pro</label>
      <select id="ap-pro">${(pros||[]).map(p=>`<option value="${p.id}">${p.full_name} -- ${fmt.money(p.private_rate)}/hr</option>`).join('')}</select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-blue" onclick="doAssignPro('${lessonId}')">Assign</button>
    </div>`);
}

async function doAssignPro(id) {
  const proId = document.getElementById('ap-pro').value;
  await db.from('lessons').update({pro_id:proId,status:'pending'}).eq('id',id);
  closeModal(); toast('Pro assigned!'); go('schedule');
}

// --- MODALS ---------------------------------------------


async function modalScheduleLesson(preClientId, preClientName) {
  if (preClientName) preClientName = decodeURIComponent(preClientName);
  const clients = await getClientsForPro();
  openModal(`
    <div class="modal-title">Schedule upcoming lesson</div>
    ${clientSelect(clients,'sl-client')}
    <div class="form-group"><label class="form-label">Focus area</label>
      <select id="sl-focus"><option value="">General lesson</option>${LESSON_FOCUS_AREAS.map(f=>`<option value="${f}">${f}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label class="form-label">Type</label><select id="sl-type"><option value="private">Private</option><option value="semi-private">Semi-private</option></select></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date and time</label><input type="datetime-local" id="sl-date"/></div>
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="sl-dur" value="60"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Court</label><input type="text" id="sl-court" placeholder="Court 2"/></div>
      <div class="form-group"><label class="form-label">Rate ($)</label><input type="number" id="sl-rate" value="${currentProfile.private_rate||120}"/></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="sl-btn" onclick="saveScheduledLesson()">Schedule lesson</button>
    </div>`);
}

async function saveScheduledLesson() {
  const dt = document.getElementById('sl-date').value;
  if (!dt) { toast('Please select a date and time.','error'); return; }
  const clientId = document.getElementById('sl-client')?.value||null;
  const clientNameField = document.getElementById('sl-client-name')?.value.trim()||null;
  const clientName = clientId
    ? (document.getElementById('sl-client')?.selectedOptions[0]?.text||null)
    : clientNameField;
  if (_busy.sl) return; _busy.sl=true; saveBusy('sl-btn',true,'Schedule lesson');
  const { error } = await db.from('lessons').insert({
    pro_id:currentProfile.id,
    client_id:clientId||null,
    client_name:clientName,
    type:document.getElementById('sl-type').value,
    focus_area:document.getElementById('sl-focus').value||null,
    scheduled_at:dt,
    duration_minutes:parseInt(document.getElementById('sl-dur').value)||60,
    court:document.getElementById('sl-court').value||null,
    rate:parseFloat(document.getElementById('sl-rate').value)||0,
    status:'upcoming'
  });
  _busy.sl=false; saveBusy('sl-btn',false,'Schedule lesson');
  if (error) { toast('Error: '+error.message,'error'); return; }
  cacheClear(); closeModal(); toast('Lesson scheduled! OK'); go('lessons');
}

async function modalLogLesson() {
  const clients = await getClientsForPro();
  openModal(`
    <div class="modal-title">Log completed lesson</div>
    ${clientSelect(clients,'ml-client')}
    <div class="form-group"><label class="form-label">Focus area</label>
      <select id="ml-focus"><option value="">General lesson</option>${LESSON_FOCUS_AREAS.map(f=>`<option value="${f}">${f}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label class="form-label">Type</label><select id="ml-type"><option value="private">Private</option><option value="semi-private">Semi-private</option></select></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date and time</label><input type="datetime-local" id="ml-date"/></div>
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="ml-dur" value="60"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Court</label><input type="text" id="ml-court" placeholder="Court 2"/></div>
      <div class="form-group"><label class="form-label">Rate ($)</label><input type="number" id="ml-rate" value="${currentProfile.private_rate||120}"/></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="ml-btn" onclick="saveLesson()">Save lesson</button>
    </div>`);
}

async function saveLesson() {
  const dt = document.getElementById('ml-date').value;
  if (!dt) { toast('Please select a date and time.','error'); return; }
  const clientId = document.getElementById('ml-client')?.value||null;
  const clientName = clientId
    ? (document.getElementById('ml-client')?.selectedOptions[0]?.text||null)
    : (document.getElementById('ml-client-name')?.value.trim()||null);
  if (_busy.lesson) return; _busy.lesson=true; saveBusy('ml-btn',true,'Save lesson');
  const { error } = await db.from('lessons').insert({
    pro_id:currentProfile.id,
    client_id:clientId||null,
    client_name:clientName,
    type:document.getElementById('ml-type').value,
    focus_area:document.getElementById('ml-focus').value||null,
    scheduled_at:dt,
    duration_minutes:parseInt(document.getElementById('ml-dur').value)||60,
    court:document.getElementById('ml-court').value||null,
    rate:parseFloat(document.getElementById('ml-rate').value)||0,
    status:'completed',
    payment_status:'unpaid'
  });
  _busy.lesson=false; saveBusy('ml-btn',false,'Save lesson');
  if (error) { toast('Error: '+error.message,'error'); return; }
  cacheClear(); closeModal(); toast('Lesson logged! OK'); go('lessons');
}

async function modalEditLesson(lessonId) {
  const { data: l } = await db.from('lessons').select('*').eq('id',lessonId).single();
  if (!l) return;
  const clients = await getClientsForPro();
  openModal(`
    <div class="modal-title">Edit lesson</div>
    <div class="form-group"><label class="form-label">Client (on app)</label>
      <select id="el-client"><option value="">No client linked</option>${clients.map(c=>`<option value="${c.id}" ${c.id===l.client_id?'selected':''}>${c.full_name}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label class="form-label">Client name (if not on app)</label><input type="text" id="el-client-name" value="${l.client_name||''}"/></div>
    <div class="form-group"><label class="form-label">Focus area</label>
      <select id="el-focus"><option value="">General lesson</option>${LESSON_FOCUS_AREAS.map(f=>`<option value="${f}" ${f===l.focus_area?'selected':''}>${f}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label class="form-label">Status</label>
      <select id="el-status">
        <option value="upcoming" ${l.status==='upcoming'?'selected':''}>Upcoming</option>
        <option value="confirmed" ${l.status==='confirmed'?'selected':''}>Confirmed</option>
        <option value="completed" ${l.status==='completed'?'selected':''}>Completed</option>
        <option value="pending" ${l.status==='pending'?'selected':''}>Pending</option>
        <option value="cancelled" ${l.status==='cancelled'?'selected':''}>Cancelled</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date and time</label><input type="datetime-local" id="el-date" value="${l.scheduled_at?l.scheduled_at.slice(0,16):''}"/></div>
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="el-dur" value="${l.duration_minutes||60}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Court</label><input type="text" id="el-court" value="${l.court||''}"/></div>
      <div class="form-group"><label class="form-label">Rate ($)</label><input type="number" id="el-rate" value="${l.rate||0}"/></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-decline" onclick="deleteLesson('${lessonId}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="el-btn" onclick="updateLesson('${lessonId}')">Save changes</button>
    </div>`);
}

async function updateLesson(id) {
  if (_busy.el) return; _busy.el=true; saveBusy('el-btn',true,'Save changes');
  const { error } = await db.from('lessons').update({
    client_id:document.getElementById('el-client').value||null,
    client_name:document.getElementById('el-client-name').value.trim()||null,
    focus_area:document.getElementById('el-focus').value||null,
    status:document.getElementById('el-status').value,
    scheduled_at:document.getElementById('el-date').value,
    duration_minutes:parseInt(document.getElementById('el-dur').value)||60,
    court:document.getElementById('el-court').value,
    rate:parseFloat(document.getElementById('el-rate').value)||0,
  }).eq('id',id);
  _busy.el=false; saveBusy('el-btn',false,'Save changes');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Lesson updated!'); go('lessons');
}

async function deleteLesson(id) {
  if (!confirm('Delete this lesson? This cannot be undone.')) return;
  await db.from('lessons').delete().eq('id',id);
  closeModal(); toast('Lesson deleted.'); go('lessons');
}

async function modalLogClinic() {
  openModal(`
    <div class="modal-title">Add clinic</div>
    <div class="form-group"><label class="form-label">Title</label><input type="text" id="mc-title" placeholder="e.g. Junior Clinic Ages 10-14"/></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date and time</label><input type="datetime-local" id="mc-date"/></div>
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="mc-dur" value="90"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Court</label><input type="text" id="mc-court" placeholder="Courts 3-4"/></div>
      <div class="form-group"><label class="form-label">Max students</label><input type="number" id="mc-students" value="8"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Rate per student ($)</label><input type="number" id="mc-rate" value="${currentProfile.clinic_rate||30}"/></div>
      <div class="form-group"><label class="form-label">Status</label><select id="mc-status"><option value="upcoming">Upcoming</option><option value="completed">Completed</option></select></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mc-btn" onclick="saveClinic()">Save clinic</button>
    </div>`);
}

async function saveClinic() {
  const dt = document.getElementById('mc-date')?.value;
  if (!dt) { toast('Please select a date and time.','error'); return; }
  if (_busy.clinic) return; _busy.clinic=true; saveBusy('mc-btn',true,'Save clinic');
  const { error } = await db.from('clinics').insert({
    pro_id:currentProfile.id, title:document.getElementById('mc-title').value,
    scheduled_at:document.getElementById('mc-date').value,
    duration_minutes:parseInt(document.getElementById('mc-dur').value)||90,
    court:document.getElementById('mc-court').value,
    max_students:parseInt(document.getElementById('mc-students').value)||1,
    rate_per_student:parseFloat(document.getElementById('mc-rate').value)||0,
    status:document.getElementById('mc-status').value
  });
  _busy.clinic=false; saveBusy('mc-btn',false,'Save clinic');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Clinic saved!'); go('clinics');
}

async function modalEditClinic(clinicId) {
  const { data: c } = await db.from('clinics').select('*').eq('id',clinicId).single();
  if (!c) return;
  openModal(`
    <div class="modal-title">Edit clinic</div>
    <div class="form-group"><label class="form-label">Title</label><input type="text" id="ec-title" value="${c.title||''}"/></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date and time</label><input type="datetime-local" id="ec-date" value="${c.scheduled_at?c.scheduled_at.slice(0,16):''}"/></div>
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="ec-dur" value="${c.duration_minutes||90}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Court</label><input type="text" id="ec-court" value="${c.court||''}"/></div>
      <div class="form-group"><label class="form-label">Max students</label><input type="number" id="ec-students" value="${c.max_students||8}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Rate per student ($)</label><input type="number" id="ec-rate" value="${c.rate_per_student||30}"/></div>
      <div class="form-group"><label class="form-label">Status</label>
        <select id="ec-status">
          <option value="upcoming" ${c.status==='upcoming'?'selected':''}>Upcoming</option>
          <option value="completed" ${c.status==='completed'?'selected':''}>Completed</option>
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-decline" onclick="deleteClinic('${clinicId}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="ec-btn" onclick="updateClinic('${clinicId}')">Save changes</button>
    </div>`);
}

async function updateClinic(id) {
  if (_busy.ec) return; _busy.ec=true; saveBusy('ec-btn',true,'Save changes');
  const { error } = await db.from('clinics').update({
    title:document.getElementById('ec-title').value,
    scheduled_at:document.getElementById('ec-date').value,
    duration_minutes:parseInt(document.getElementById('ec-dur').value)||90,
    court:document.getElementById('ec-court').value,
    max_students:parseInt(document.getElementById('ec-students').value)||1,
    rate_per_student:parseFloat(document.getElementById('ec-rate').value)||0,
    status:document.getElementById('ec-status').value
  }).eq('id',id);
  _busy.ec=false; saveBusy('ec-btn',false,'Save changes');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Clinic updated!'); go('clinics');
}

async function deleteClinic(id) {
  if (!confirm('Delete this clinic?')) return;
  await db.from('clinics').delete().eq('id',id);
  closeModal(); toast('Clinic deleted.'); go('clinics');
}




async function modalEditNote(noteId) {
  const { data: n } = await db.from('session_notes').select('*').eq('id',noteId).single();
  if (!n) return;
  const clients = await getClientsForPro();
  openModal(`
    <div class="modal-title">Edit session note</div>
    <div class="form-group"><label class="form-label">Client (on app)</label>
      <select id="en-client"><option value="">No client</option>${clients.map(c=>`<option value="${c.id}" ${c.id===n.client_id?'selected':''}>${c.full_name}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label class="form-label">Client name</label><input type="text" id="en-client-name" value="${n.client_name||''}"/></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Focus area</label>
        <select id="en-focus"><option value="">General</option>${LESSON_FOCUS_AREAS.map(f=>`<option value="${f}" ${f===n.focus_area?'selected':''}>${f}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label class="form-label">Category</label>
        <select id="en-category">
          <option value="">Select</option>
          ${['Technique','Tactics','Physical','Mental'].map(c=>`<option value="${c}" ${c===n.category?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group"><label class="form-label">What worked well</label><textarea id="en-worked" rows="3">${n.what_worked||''}</textarea></div>
    <div class="form-group"><label class="form-label">Areas to develop</label><textarea id="en-notes" rows="3">${n.pro_notes||''}</textarea></div>
    <div class="form-group"><label class="form-label">Objectives for next session</label><textarea id="en-obj" rows="2">${n.objectives||''}</textarea></div>
    <div class="form-group"><label class="form-label">Homework / drills</label><textarea id="en-hw" rows="2">${n.homework||''}</textarea></div>
    <div class="form-group"><label class="form-label">Share with client?</label>
      <select id="en-share"><option value="false" ${!n.shared_with_client?'selected':''}>No -- keep private</option><option value="true" ${n.shared_with_client?'selected':''}>Yes -- share with client</option></select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="en-btn" onclick="updateNote('${noteId}')">Save changes</button>
    </div>`);
}

async function updateNote(id) {
  if (_busy.en) return; _busy.en=true; saveBusy('en-btn',true,'Save changes');
  const { error } = await db.from('session_notes').update({
    client_id:document.getElementById('en-client').value||null,
    client_name:document.getElementById('en-client-name').value.trim()||null,
    focus_area:document.getElementById('en-focus').value||null,
    category:document.getElementById('en-category').value||null,
    what_worked:document.getElementById('en-worked').value,
    pro_notes:document.getElementById('en-notes').value,
    objectives:document.getElementById('en-obj').value,
    homework:document.getElementById('en-hw').value,
    shared_with_client:document.getElementById('en-share').value==='true'
  }).eq('id',id);
  _busy.en=false; saveBusy('en-btn',false,'Save changes');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Note updated!'); go('notes');
}

function modalLogMatch() {
  openModal(`
    <div class="modal-title">Log a match</div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Opponent</label><input type="text" id="mm-opp" placeholder="e.g. Karen Lewis"/></div>
      <div class="form-group"><label class="form-label">Score</label><input type="text" id="mm-score" placeholder="6-3, 6-4"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Result</label><select id="mm-result"><option value="win">Win</option><option value="loss">Loss</option></select></div>
      <div class="form-group"><label class="form-label">Date</label><input type="date" id="mm-date"/></div>
    </div>
    <div class="form-group"><label class="form-label">Match type</label><input type="text" id="mm-type" placeholder="Club ladder, Friendly, Tournament, League"/></div>
    <div class="form-group"><label class="form-label">Notes (strengths, weaknesses, patterns observed)</label><textarea id="mm-notes" rows="3" placeholder="What went well? What let you down? What patterns emerged?"></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-purple" id="mm-btn" onclick="saveMatch()">Save match</button>
    </div>`);
}

async function saveMatch() {
  if (_busy.match) return; _busy.match=true; saveBusy('mm-btn',true,'Save match');
  const { error } = await db.from('match_logs').insert({
    client_id:currentProfile.id, opponent_name:document.getElementById('mm-opp').value,
    score:document.getElementById('mm-score').value, result:document.getElementById('mm-result').value,
    match_type:document.getElementById('mm-type').value, match_date:document.getElementById('mm-date').value,
    notes:document.getElementById('mm-notes').value
  });
  _busy.match=false; saveBusy('mm-btn',false,'Save match');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Match logged!'); go('matchlog');
}

async function modalAssignLesson() {
  const [{ data: pros }, { data: clients }] = await Promise.all([
    db.from('profiles').select('id,full_name,private_rate').eq('role','pro').eq('club_name',currentProfile.club_name),
    db.from('profiles').select('id,full_name').eq('role','client').eq('club_name',currentProfile.club_name)
  ]);
  openModal(`
    <div class="modal-title">Assign lesson</div>
    <div class="form-group"><label class="form-label">Assign to pro</label><select id="al-pro"><option value="">Unassigned for now</option>${(pros||[]).map(p=>`<option value="${p.id}">${p.full_name} -- ${fmt.money(p.private_rate)}/hr</option>`).join('')}</select></div>
    <div class="form-group"><label class="form-label">Client</label><select id="al-client"><option value="">Select client</option>${(clients||[]).map(c=>`<option value="${c.id}">${c.full_name}</option>`).join('')}</select></div>
    <div class="form-group"><label class="form-label">Type</label><select id="al-type"><option value="private">Private</option><option value="semi-private">Semi-private</option></select></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date and time</label><input type="datetime-local" id="al-date"/></div>
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="al-dur" value="60"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Court</label><input type="text" id="al-court" placeholder="Court 1"/></div>
      <div class="form-group"><label class="form-label">Rate ($)</label><input type="number" id="al-rate" value="120"/></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-blue" id="al-btn" onclick="saveAssign()">Create lesson</button>
    </div>`);
}

async function saveAssign() {
  const dt = document.getElementById('al-date').value;
  const clientId = document.getElementById('al-client').value;
  if (!dt) { toast('Please select a date and time.','error'); return; }
  if (!clientId) { toast('Please select a client.','error'); return; }
  if (_busy.assign) return; _busy.assign=true; saveBusy('al-btn',true,'Create lesson');
  const proId = document.getElementById('al-pro').value||null;
  const clientName = document.getElementById('al-client')?.selectedOptions[0]?.text||null;
  const { error } = await db.from('lessons').insert({
    pro_id:proId,
    client_id:clientId,
    client_name:clientName,
    type:document.getElementById('al-type').value,
    scheduled_at:dt,
    duration_minutes:parseInt(document.getElementById('al-dur').value)||60,
    court:document.getElementById('al-court').value||null,
    rate:parseFloat(document.getElementById('al-rate').value)||0,
    status:'upcoming'
  });
  _busy.assign=false; saveBusy('al-btn',false,'Create lesson');
  if (error) { toast('Error: '+error.message,'error'); return; }
  // Notify pro and client
  if (proId) await createNotification(proId,'lesson_assigned','New lesson assigned',`${clientName||'Client'} . ${dt.split('T')[0]}`,'lessons');
  await createNotification(clientId,'lesson_assigned','Lesson scheduled for you',`${dt.split('T')[0]}`,'upcoming');
  cacheClear(); closeModal(); toast('Lesson created and notifications sent! OK'); go('schedule');
}



// 
// SETTINGS PAGE
// 
async function pgSettings(el) {
  const role = _activeRole || currentProfile.role;
  el.innerHTML = `
    <div style="max-width:520px;">

      <!-- Profile summary -->
      <div class="card" style="margin-bottom:14px;">
        <div style="padding:18px 20px;display:flex;align-items:center;gap:14px;">
          ${avatar(currentProfile.full_name, 52)}
          <div style="flex:1;min-width:0;">
            <div style="font-size:17px;font-weight:600;">${currentProfile.full_name}</div>
            <div style="font-size:13px;color:var(--text-tertiary);margin-top:2px;">${currentProfile.club_name || 'No club set'}</div>
            <div style="font-size:12px;margin-top:4px;">
              <span class="badge ${role === 'pro' ? 'badge-green' : role === 'manager' ? 'badge-blue' : 'badge-purple'}">${role === 'pro' ? 'Tennis Pro' : role === 'manager' ? 'Club Manager' : 'Club Member'}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Sport selector -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header"><div class="card-title">My sport</div></div>
        <div style="padding:16px;">
          <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:12px;line-height:1.5;">Choose your primary sport. This changes your drill library, skill ratings, session note focus areas, and job board.</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
            ${Object.entries(SPORTS).map(([key,s])=>`
              <button onclick="saveUserSport('${key}')"
                style="padding:12px 6px;border-radius:10px;border:2px solid ${(currentProfile.sport||'tennis')===key?'var(--brand)':'var(--border)'};background:${(currentProfile.sport||'tennis')===key?'var(--brand-dim)':'var(--surface)'};cursor:pointer;font-family:'Inter',sans-serif;display:flex;flex-direction:column;align-items:center;gap:4px;transition:all 0.15s;">
                <div style="font-size:22px;">${s.icon}</div>
                <div style="font-size:11.5px;font-weight:600;color:${(currentProfile.sport||'tennis')===key?'var(--brand-text)':'var(--text-secondary)'};">${s.label}</div>
              </button>`).join('')}
          </div>
        </div>
      </div>

      <!-- Account settings -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header"><div class="card-title">Account</div></div>

        <!-- Change club name -->
        <div style="padding:16px;border-bottom:1px solid var(--border);">
          <div style="font-size:13.5px;font-weight:500;margin-bottom:10px;">Club name</div>
          <div style="display:flex;gap:8px;">
            <input type="text" id="settings-club" value="${currentProfile.club_name || ''}"
              placeholder="Enter your club name"
              style="flex:1;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13.5px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);outline:none;"
              onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"/>
            <button class="btn btn-primary btn-sm" onclick="saveClubName()">Save</button>
          </div>
        </div>

        <!-- Change full name -->
        <div style="padding:16px;border-bottom:1px solid var(--border);">
          <div style="font-size:13.5px;font-weight:500;margin-bottom:10px;">Display name</div>
          <div style="display:flex;gap:8px;">
            <input type="text" id="settings-name" value="${currentProfile.full_name || ''}"
              placeholder="Your full name"
              style="flex:1;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13.5px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);outline:none;"
              onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"/>
            <button class="btn btn-primary btn-sm" onclick="saveDisplayName()">Save</button>
          </div>
        </div>

        <!-- Notification preferences -->
        <div style="padding:16px;">
          <div style="font-size:13.5px;font-weight:500;margin-bottom:12px;">Notifications</div>
          ${[
            ['notify_booking', 'New lesson bookings'],
            ['notify_lesson', 'Lesson reminders'],
            ['notify_note', 'New session notes'],
          ].map(([key, label]) => `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div style="font-size:13.5px;">${label}</div>
              <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;">
                <input type="checkbox" id="notif-${key}" ${currentProfile[key] !== false ? 'checked' : ''}
                  style="opacity:0;width:0;height:0;" onchange="saveNotifPref('${key}',this.checked)"/>
                <span style="position:absolute;inset:0;background:${currentProfile[key] !== false ? 'var(--brand)' : 'var(--border)'};border-radius:22px;transition:0.2s;" id="toggle-${key}"></span>
                <span style="position:absolute;top:3px;left:3px;width:16px;height:16px;background:white;border-radius:50%;transition:0.2s;transform:${currentProfile[key] !== false ? 'translateX(18px)' : 'none'}" id="thumb-${key}"></span>
              </label>
            </div>`).join('')}
        </div>
      </div>

      <!-- Sign out -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header"><div class="card-title">Session</div></div>
        <div style="padding:16px;">
          <button class="btn btn-full" onclick="doSignOut()" style="margin-bottom:10px;">
            Sign out of this device
          </button>
          <button class="btn btn-full" style="color:var(--text-tertiary);font-size:12.5px;background:none;border:none;cursor:pointer;padding:4px 0;" onclick="doSignOutAll()">
            Sign out of all devices
          </button>
        </div>
      </div>

      <!-- Danger zone -->
      <div class="card" style="border:1.5px solid var(--danger-dim);">
        <div class="card-header">
          <div class="card-title" style="color:var(--danger);">Danger zone</div>
        </div>
        <div style="padding:16px;">
          <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px;">
            Deleting your account is <strong>permanent and cannot be undone</strong>. All your lessons, notes, session history, ratings, and profile data will be permanently removed from CourtPro.
          </div>
          <button class="btn btn-full" onclick="confirmDeleteAccount()"
            style="background:var(--danger-dim);color:var(--danger);border:1.5px solid var(--danger);font-weight:600;">
            Delete my account
          </button>
        </div>
      </div>

    </div>`;
}

async function saveUserSport(sport) {
  const { error } = await db.from('profiles').update({ sport }).eq('id', currentProfile.id);
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  currentProfile.sport = sport;
  cacheClear();
  toast(SPORTS[sport]?.label + ' selected as your sport!');
  go('settings'); // re-render to show updated selection
}

async function saveClubName() {
  const val = document.getElementById('settings-club')?.value.trim();
  const { error } = await db.from('profiles').update({ club_name: val || null }).eq('id', currentProfile.id);
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  currentProfile.club_name = val || null;
  cacheClear();
  toast('Club name updated!');
  buildSidebar(); // refresh sidebar club name
}

async function saveDisplayName() {
  const val = document.getElementById('settings-name')?.value.trim();
  if (!val) { toast('Name cannot be empty.', 'error'); return; }
  const { error } = await db.from('profiles').update({ full_name: val }).eq('id', currentProfile.id);
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  currentProfile.full_name = val;
  cacheClear();
  toast('Name updated!');
  buildSidebar();
}

async function saveNotifPref(key, value) {
  await db.from('profiles').update({ [key]: value }).eq('id', currentProfile.id);
  currentProfile[key] = value;
  // Update toggle visual
  const track = document.getElementById('toggle-' + key);
  const thumb = document.getElementById('thumb-' + key);
  if (track) track.style.background = value ? 'var(--brand)' : 'var(--border)';
  if (thumb) thumb.style.transform = value ? 'translateX(18px)' : 'none';
  toast(value ? 'Notifications on' : 'Notifications off');
}

async function doSignOutAll() {
  clearTrustedDevice();
  await db.auth.signOut({ scope: 'global' });
}

function confirmDeleteAccount() {
  openModal(`
    <div style="text-align:center;padding:8px 0;">
      <div style="font-size:36px;margin-bottom:14px;">[warn]</div>
      <div style="font-size:18px;font-weight:700;color:var(--danger);margin-bottom:10px;">Delete your account?</div>
      <div style="font-size:13.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:20px;max-width:320px;margin-left:auto;margin-right:auto;">
        This will permanently delete your profile, all lessons, session notes, ratings, and every other piece of data associated with your account.<br/><br/>
        <strong>This cannot be undone.</strong>
      </div>
      <div class="form-group" style="text-align:left;">
        <label class="form-label">Type <strong>DELETE</strong> to confirm</label>
        <input type="text" id="delete-confirm-input" placeholder="Type DELETE here"
          style="width:100%;padding:10px 12px;border:2px solid var(--danger);border-radius:8px;font-size:14px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);outline:none;box-sizing:border-box;text-transform:uppercase;"/>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
        <button class="btn btn-full" id="delete-confirm-btn"
          onclick="executeDeleteAccount()"
          style="background:var(--danger);color:white;font-weight:600;border:none;">
          Permanently delete my account
        </button>
        <button class="btn btn-full" onclick="closeModal()">Cancel - keep my account</button>
      </div>
    </div>`);
}

async function executeDeleteAccount() {
  const input = document.getElementById('delete-confirm-input')?.value.trim().toUpperCase();
  if (input !== 'DELETE') {
    toast('Please type DELETE to confirm.', 'error');
    document.getElementById('delete-confirm-input')?.focus();
    return;
  }

  const btn = document.getElementById('delete-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

  const userId = currentProfile.id;

  try {
    // Delete all user data in the right order (respecting FK constraints)
    await Promise.all([
      db.from('notifications').delete().eq('user_id', userId),
      db.from('linked_members').delete().eq('parent_id', userId),
      db.from('linked_members').delete().eq('child_id', userId),
      db.from('client_pros').delete().eq('client_id', userId),
      db.from('community_posts').delete().eq('author_id', userId),
      db.from('messages').delete().eq('from_id', userId),
      db.from('messages').delete().eq('to_id', userId),
      db.from('match_logs').delete().eq('client_id', userId),
      db.from('ratings').delete().eq('client_id', userId),
      db.from('ratings').delete().eq('pro_id', userId),
      db.from('skill_ratings').delete().eq('client_id', userId),
      db.from('skill_ratings').delete().eq('pro_id', userId),
      db.from('invoices').delete().eq('pro_id', userId),
      db.from('invoices').delete().eq('client_id', userId),
      db.from('booking_requests').delete().eq('client_id', userId),
      db.from('booking_requests').delete().eq('pro_id', userId),
      db.from('availability').delete().eq('pro_id', userId),
      db.from('session_notes').delete().eq('pro_id', userId),
      db.from('session_notes').delete().eq('client_id', userId),
      db.from('job_applications').delete().eq('pro_id', userId),
      db.from('job_postings').delete().eq('manager_id', userId),
      db.from('clinics').delete().eq('pro_id', userId),
      db.from('lessons').delete().eq('pro_id', userId),
      db.from('lessons').delete().eq('client_id', userId),
    ]);

    // Delete pro profile if exists
    await db.from('pro_profiles').delete().eq('pro_id', userId);

    // Delete the profile row
    await db.from('profiles').delete().eq('id', userId);

    // Sign out of Supabase auth (triggers auth state change -> showAuth)
    clearTrustedDevice();
    await db.auth.signOut();

    // Show farewell message
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:'Inter',sans-serif;padding:24px;background:#F0F0EC;">
        <div style="max-width:380px;text-align:center;">
          <div style="font-size:40px;margin-bottom:16px;">[wave]</div>
          <div style="font-size:20px;font-weight:600;margin-bottom:8px;">Account deleted</div>
          <div style="font-size:14px;color:#555;line-height:1.7;margin-bottom:24px;">
            Your account and all associated data have been permanently removed from CourtPro. We're sorry to see you go.
          </div>
          <a href="/" style="display:inline-block;background:#1D9E75;color:white;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">
            Back to CourtPro
          </a>
        </div>
      </div>`;

  } catch(e) {
    console.error('Delete account error:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Permanently delete my account'; }
    toast('Error deleting account: ' + e.message, 'error');
  }
}
// ============================================================
// NEW FEATURES MODULE
// Recurring lessons, earnings chart, enhanced drills,
// court booking, analytics, enhanced session notes
// ============================================================

//  RECURRING LESSONS 
async function pgRecurring(el) {
  actionBtn('+ New Recurring','btn-primary','modalAddRecurring()');
  const { data: recurring } = await db.from('recurring_lessons')
    .select('*, client:client_id(full_name)')
    .eq('pro_id', currentProfile.id)
    .order('day_of_week');
  const active = (recurring||[]).filter(r=>r.active);
  const inactive = (recurring||[]).filter(r=>!r.active);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  el.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <div class="card-header"><div class="card-title">Active recurring lessons</div><span class="badge badge-green">${active.length}</span></div>
      ${!active.length ? emptyState('RPT','No recurring lessons set','Add a recurring lesson and generate sessions for the whole term.','Add recurring','modalAddRecurring()')
      : active.map(r => `
        <div class="list-item" style="flex-wrap:wrap;gap:8px;">
          <div style="width:42px;height:42px;border-radius:10px;background:var(--brand-dim);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-text);flex-shrink:0;">${days[r.day_of_week]}</div>
          <div class="list-item-info">
            <div class="list-item-title">${r.client?.full_name||r.client_name||'Client'} . ${r.type}</div>
            <div class="list-item-meta">${days[r.day_of_week]}s at ${r.start_time} . ${r.duration_minutes||60}min . ${r.court||'TBD'} . ${fmt.money(r.rate)}/session</div>
            ${r.focus_area?`<div style="font-size:11.5px;color:var(--brand);margin-top:2px;">${r.focus_area}</div>`:''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-primary" onclick="generateRecurringSessions('${r.id}')">Generate sessions</button>
            <button class="btn btn-sm btn-decline" onclick="deactivateRecurring('${r.id}')">Deactivate</button>
          </div>
        </div>`).join('')}
    </div>
    ${inactive.length ? `<div class="card">
      <div class="card-header"><div class="card-title" style="color:var(--text-tertiary);">Inactive</div></div>
      ${inactive.map(r=>`<div class="list-item"><div class="list-item-info"><div class="list-item-title" style="color:var(--text-tertiary);">${r.client?.full_name||r.client_name||'Client'} . ${days[r.day_of_week]}s at ${r.start_time}</div></div><button class="btn btn-sm" onclick="reactivateRecurring('${r.id}')">Reactivate</button></div>`).join('')}
    </div>`:``}`;
}

async function modalAddRecurring() {
  const clients = await getClientsForPro();
  const sport = getActiveSport();
  const focusAreas = getSportFocusAreas();
  openModal(`
    <div class="modal-title">New recurring lesson</div>
    ${clientSelect(clients,'rc-client')}
    <div class="form-row">
      <div class="form-group"><label class="form-label">Day of week</label>
        <select id="rc-day">
          ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d,i)=>`<option value="${i}">${d}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Time</label><input type="time" id="rc-time" value="09:00"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Duration (min)</label><input type="number" id="rc-dur" value="60"/></div>
      <div class="form-group"><label class="form-label">Rate ($/session)</label><input type="number" id="rc-rate" value="${currentProfile.private_rate||120}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Start date</label><input type="date" id="rc-start" value="${new Date().toISOString().split('T')[0]}"/></div>
      <div class="form-group"><label class="form-label">End date (optional)</label><input type="date" id="rc-end"/></div>
    </div>
    <div class="form-group"><label class="form-label">Court</label><input type="text" id="rc-court" placeholder="Court 2"/></div>
    <div class="form-group"><label class="form-label">Focus area</label>
      <select id="rc-focus"><option value="">General</option>${focusAreas.map(f=>`<option value="${f}">${f}</option>`).join('')}</select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="rc-save-btn" onclick="saveRecurring()">Save recurring</button>
    </div>`);
}

async function saveRecurring() {
  if (_busy.rc) return; _busy.rc = true; saveBusy('rc-save-btn',true,'Saving...');
  const clientId = document.getElementById('rc-client')?.value||null;
  const clientName = clientId
    ? (document.getElementById('rc-client')?.selectedOptions[0]?.text||null)
    : (document.getElementById('rc-client-name')?.value.trim()||null);
  const { error } = await db.from('recurring_lessons').insert({
    pro_id: currentProfile.id,
    client_id: clientId, client_name: clientName,
    sport: getActiveSport(),
    day_of_week: parseInt(document.getElementById('rc-day').value),
    start_time: document.getElementById('rc-time').value,
    duration_minutes: parseInt(document.getElementById('rc-dur').value)||60,
    rate: parseFloat(document.getElementById('rc-rate').value)||0,
    court: document.getElementById('rc-court').value||null,
    focus_area: document.getElementById('rc-focus').value||null,
    start_date: document.getElementById('rc-start').value||null,
    end_date: document.getElementById('rc-end').value||null,
    active: true,
  });
  _busy.rc = false; saveBusy('rc-save-btn',false,'Save recurring');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Recurring lesson saved!'); cacheClear(); go('recurring');
}

async function generateRecurringSessions(recurringId) {
  const { data: r } = await db.from('recurring_lessons').select('*').eq('id',recurringId).single();
  if (!r) return;
  const start = r.start_date ? new Date(r.start_date) : new Date();
  const end = r.end_date ? new Date(r.end_date) : new Date(Date.now() + 12*7*86400000); // 12 weeks default
  const sessions = [];
  let d = new Date(start);
  // Move to first occurrence of the target day
  while (d.getDay() !== r.day_of_week) d.setDate(d.getDate()+1);
  while (d <= end) {
    const [h,m] = r.start_time.split(':').map(Number);
    const scheduled = new Date(d);
    scheduled.setHours(h, m, 0, 0);
    sessions.push({
      pro_id: r.pro_id, client_id: r.client_id, client_name: r.client_name,
      type: 'private', sport: r.sport||'tennis', focus_area: r.focus_area,
      scheduled_at: scheduled.toISOString(), duration_minutes: r.duration_minutes,
      court: r.court, rate: r.rate, status: 'upcoming', payment_status: 'unpaid',
      is_recurring: true,
    });
    d.setDate(d.getDate()+7);
  }
  if (!sessions.length) { toast('No sessions to generate for that date range.','error'); return; }
  const { error } = await db.from('lessons').insert(sessions);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast(`${sessions.length} sessions generated!`); cacheClear(); go('lessons');
}

async function deactivateRecurring(id) {
  await db.from('recurring_lessons').update({active:false}).eq('id',id);
  toast('Recurring lesson deactivated.'); cacheClear(); go('recurring');
}
async function reactivateRecurring(id) {
  await db.from('recurring_lessons').update({active:true}).eq('id',id);
  toast('Recurring lesson reactivated!'); cacheClear(); go('recurring');
}

//  EARNINGS CHART 
async function pgProEarnings(el) {
  const [{ data: lessons }, { data: clinics }] = await Promise.all([
    db.from('lessons').select('*').eq('pro_id',currentProfile.id).eq('status','completed').order('scheduled_at',{ascending:true}),
    db.from('clinics').select('*').eq('pro_id',currentProfile.id).eq('status','completed'),
  ]);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();

  const realLessons = (lessons||[]).filter(l => (l.rate||0)>0 && (l.duration_minutes||0)>0);
  const totalEarned = realLessons.reduce((s,l)=>s+(l.rate||0),0)
    + (clinics||[]).reduce((s,c)=>s+((c.rate_per_student||0)*(c.max_students||1)),0);
  const monthEarnings = realLessons.filter(l=>l.scheduled_at>=monthStart).reduce((s,l)=>s+(l.rate||0),0);
  const yearEarnings  = realLessons.filter(l=>l.scheduled_at>=yearStart).reduce((s,l)=>s+(l.rate||0),0);
  const unpaid = realLessons.filter(l=>l.payment_status!=='paid').reduce((s,l)=>s+(l.rate||0),0);
  const totalHours = realLessons.reduce((s,l)=>s+(l.duration_minutes||60)/60,0);
  const avgRate = realLessons.length ? (realLessons.reduce((s,l)=>s+(l.rate||0),0)/realLessons.length).toFixed(0) : 0;

  // Build last 6 months chart data
  const monthData = {};
  for (let i=5; i>=0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const key = d.toLocaleDateString('en-US',{month:'short',year:'2-digit'});
    monthData[key] = 0;
  }
  realLessons.forEach(l => {
    const d = new Date(l.scheduled_at);
    const key = d.toLocaleDateString('en-US',{month:'short',year:'2-digit'});
    if (key in monthData) monthData[key] += (l.rate||0);
  });
  const maxVal = Math.max(...Object.values(monthData), 1);

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">This month</div><div class="stat-value">${fmt.money(monthEarnings)}</div></div>
      <div class="stat-card"><div class="stat-label">This year</div><div class="stat-value">${fmt.money(yearEarnings)}</div></div>
      <div class="stat-card"><div class="stat-label">Unpaid</div><div class="stat-value" style="color:var(--warning)">${fmt.money(unpaid)}</div></div>
      <div class="stat-card"><div class="stat-label">Avg rate</div><div class="stat-value">${fmt.money(avgRate)}</div><div class="stat-sub">per session</div></div>
    </div>

    <!-- 6-month bar chart -->
    <div class="card" style="margin-bottom:14px;">
      <div class="card-header"><div class="card-title">Earnings trend - last 6 months</div><div style="font-size:13px;font-weight:500;color:var(--brand);">${fmt.money(yearEarnings)} this year</div></div>
      <div style="padding:20px 16px 10px;display:flex;align-items:flex-end;gap:8px;height:140px;">
        ${Object.entries(monthData).map(([month, val]) => {
          const pct = Math.round((val/maxVal)*100);
          const isCurrentMonth = month === now.toLocaleDateString('en-US',{month:'short',year:'2-digit'});
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
            <div style="font-size:11px;font-weight:500;color:var(--text-secondary);">${val>0?fmt.money(val):''}</div>
            <div style="width:100%;border-radius:6px 6px 0 0;min-height:4px;background:${isCurrentMonth?'var(--brand)':'var(--brand-dim)'};height:${Math.max(pct,4)}px;transition:height 0.6s;"></div>
            <div style="font-size:10.5px;color:var(--text-tertiary);text-align:center;">${month}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Breakdown -->
    <div class="two-col">
      <div class="card">
        <div class="card-header"><div class="card-title">By lesson type</div></div>
        <div style="padding:16px;">
          ${(() => {
            const byType = {};
            realLessons.forEach(l => { byType[l.type||'private'] = (byType[l.type||'private']||0) + (l.rate||0); });
            const total = Object.values(byType).reduce((s,v)=>s+v,1);
            return Object.entries(byType).map(([type,val])=>`
              <div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                  <div style="font-size:13px;font-weight:500;text-transform:capitalize;">${type}</div>
                  <div style="font-size:13px;color:var(--text-secondary);">${fmt.money(val)}</div>
                </div>
                <div style="height:5px;background:var(--bg);border-radius:3px;overflow:hidden;">
                  <div style="height:100%;width:${Math.round(val/total*100)}%;background:var(--brand);border-radius:3px;"></div>
                </div>
              </div>`).join('') || '<div style="color:var(--text-tertiary);font-size:13px;">No data yet</div>';
          })()}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Stats</div></div>
        <div style="padding:16px;">
          ${[
            ['Total lessons', realLessons.length],
            ['Hours on court', totalHours.toFixed(1)+'h'],
            ['All-time earned', fmt.money(totalEarned)],
            ['Sessions unpaid', realLessons.filter(l=>l.payment_status!=='paid').length],
          ].map(([l,v])=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><div style="color:var(--text-tertiary);">${l}</div><div style="font-weight:500;">${v}</div></div>`).join('')}
        </div>
      </div>
    </div>

    <!-- Lesson list -->
    <div class="card" style="margin-top:14px;">
      <div class="card-header"><div class="card-title">Completed lessons</div></div>
      ${searchBar('earn-search','Search by client, focus area...')}
      <div id="earn-list">
        ${!realLessons.length ? emptyState('$','No earnings yet','Complete lessons to track your income.',null,null)
        : [...realLessons].reverse().map(l=>`
          <div class="list-item s-row">
            <div class="dot "></div>
            <div class="list-item-info">
              <div class="list-item-title">${l.client_name||'Client'} . ${l.type}${l.focus_area?' . '+l.focus_area:''}</div>
              <div class="list-item-meta">${fmt.date(l.scheduled_at)} . ${l.duration_minutes||60}min . ${l.court||'TBD'}</div>
            </div>
            <div class="mono">${fmt.money(l.rate)}</div>${paymentPill(l.payment_status)}
            ${l.payment_status!=='paid'?`<button class="btn btn-sm btn-accept" onclick="markPaid('${l.id}')">Mark paid</button>`:''}
          </div>`).join('')}
      </div>
    </div>`;
}

//  ENHANCED DRILL LIBRARY with video + sport awareness 
async function pgClientDrills(el) {
  const sport = getActiveSport();
  const sportConfig = getSportConfig();
  const drills = getSportDrills();
  const cats = ['All', ...new Set(drills.map(d=>d.cat))];

  // Load coach-assigned homework
  const { data: notes } = await db.from('session_notes')
    .select('homework, objectives, created_at, focus_area, pro_id')
    .eq('client_id', currentProfile.id)
    .eq('shared_with_client', true)
    .not('homework','is',null)
    .order('created_at',{ascending:false})
    .limit(5);

  el.innerHTML = `
    ${notes?.length ? `
    <div class="card" style="margin-bottom:14px;">
      <div class="card-header"><div class="card-title">Assigned by your coach</div><span class="badge badge-purple">Do these first</span></div>
      ${notes.map((n,i)=>`
        <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;gap:12px;">
          <div style="width:26px;height:26px;border-radius:50%;background:var(--pkl-dim);color:var(--pkl-text);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;margin-top:2px;">${i+1}</div>
          <div style="flex:1;">
            <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:3px;">${fmt.date(n.created_at)}${n.focus_area?' . '+n.focus_area:''}</div>
            <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;">${n.homework}</div>
          </div>
        </div>`).join('')}
    </div>`:``}

    <!-- Sport selector -->
    <div class="card" style="margin-bottom:14px;">
      <div style="padding:12px 16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border);">
        <div style="font-size:13px;font-weight:500;color:var(--text-tertiary);">Sport:</div>
        ${Object.entries(SPORTS).map(([key,s])=>`
          <button onclick="changeSport('${key}')" style="padding:5px 12px;border-radius:20px;border:1.5px solid ${sport===key?'var(--brand)':'var(--border)'};background:${sport===key?'var(--brand-dim)':'transparent'};font-size:12.5px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;color:${sport===key?'var(--brand-text)':'var(--text-secondary)'};">
            ${s.icon} ${s.label}
          </button>`).join('')}
      </div>
      <div class="card-header" style="border-bottom:1px solid var(--border);">
        <div class="card-title">${sportConfig.icon} ${sportConfig.label} Drill Library</div>
      </div>
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;">
        ${cats.map(cat=>`<button class="btn btn-sm drill-filter ${cat==='All'?'btn-primary':''}" onclick="filterDrills('${cat}',this)">${cat}</button>`).join('')}
      </div>
      <div id="drill-list">
        ${drills.map(d=>`
          <div class="drill-item" data-cat="${d.cat}" style="padding:14px 16px;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
              <div style="font-size:13.5px;font-weight:500;">${d.name}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <span class="badge badge-gray">${d.level}</span>
                <span class="badge badge-blue">${d.dur}</span>
              </div>
            </div>
            <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:8px;">${d.desc}</div>
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                ${(d.skills||[]).map(sid=>{ const sk=getSportSkills().find(s=>s.id===sid); return sk?`<span class="badge badge-green" style="font-size:10px;">${sk.label}</span>`:''; }).join('')}
              </div>
              ${d.videoUrl ? `<a href="${d.videoUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;background:var(--danger-dim);color:var(--danger);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:500;text-decoration:none;">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm-1.5 9.5V5.5l5 3-5 3z" fill="currentColor"/></svg>
                Watch video
              </a>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

async function changeSport(sport) {
  const { error } = await db.from('profiles').update({ sport }).eq('id', currentProfile.id);
  if (error) { toast('Error updating sport.','error'); return; }
  currentProfile.sport = sport;
  cacheClear();
  go('drills');
}

//  MANAGER ANALYTICS 
async function pgMgrAnalytics(el) {
  const proIds = await getClubProIds();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const yearStart  = new Date(now.getFullYear(), 0, 1).toISOString();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString();

  const [{ data: allLessons }, { data: members }, { data: pros }] = await Promise.all([
    proIds.length ? db.from('lessons').select('*').in('pro_id',proIds).order('scheduled_at',{ascending:true}) : { data: [] },
    db.from('profiles').select('id,full_name,created_at').eq('role','client').eq('club_name',currentProfile.club_name),
    db.from('profiles').select('id,full_name,private_rate').eq('role','pro').eq('club_name',currentProfile.club_name),
  ]);

  const completed = (allLessons||[]).filter(l=>l.status==='completed'&&(l.rate||0)>0&&(l.duration_minutes||0)>0);
  const monthRevenue = completed.filter(l=>l.scheduled_at>=monthStart).reduce((s,l)=>s+(l.rate||0),0);
  const prevRevenue  = completed.filter(l=>l.scheduled_at>=prevMonthStart&&l.scheduled_at<monthStart).reduce((s,l)=>s+(l.rate||0),0);
  const yearRevenue  = completed.filter(l=>l.scheduled_at>=yearStart).reduce((s,l)=>s+(l.rate||0),0);
  const revChange = prevRevenue > 0 ? Math.round(((monthRevenue-prevRevenue)/prevRevenue)*100) : null;

  // Monthly data for chart
  const monthlyRev = {};
  for (let i=5; i>=0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    monthlyRev[d.toLocaleDateString('en-US',{month:'short'})] = 0;
  }
  completed.forEach(l=>{
    const key = new Date(l.scheduled_at).toLocaleDateString('en-US',{month:'short'});
    if (key in monthlyRev) monthlyRev[key] += (l.rate||0);
  });
  const maxRev = Math.max(...Object.values(monthlyRev), 1);

  // Top pros by revenue
  const proRevenue = {};
  completed.forEach(l=>{ proRevenue[l.pro_id] = (proRevenue[l.pro_id]||0)+(l.rate||0); });
  const topPros = (pros||[]).map(p=>({...p,revenue:proRevenue[p.id]||0})).sort((a,b)=>b.revenue-a.revenue);

  // New members this month
  const newMembers = (members||[]).filter(m=>m.created_at>=monthStart).length;

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">This month</div>
        <div class="stat-value">${fmt.money(monthRevenue)}</div>
        <div class="stat-sub" style="color:${revChange!==null?(revChange>=0?'var(--brand)':'var(--danger)'):'var(--text-tertiary)'}">
          ${revChange!==null?(revChange>=0?'':'')+Math.abs(revChange)+'% vs last month':'First month'}
        </div>
      </div>
      <div class="stat-card"><div class="stat-label">This year</div><div class="stat-value">${fmt.money(yearRevenue)}</div></div>
      <div class="stat-card"><div class="stat-label">Active pros</div><div class="stat-value">${pros?.length||0}</div></div>
      <div class="stat-card"><div class="stat-label">New members</div><div class="stat-value">${newMembers}</div><div class="stat-sub">this month</div></div>
    </div>

    <div class="two-col">
      <div>
        <div class="card" style="margin-bottom:14px;">
          <div class="card-header"><div class="card-title">Revenue - last 6 months</div></div>
          <div style="padding:20px 16px 10px;display:flex;align-items:flex-end;gap:8px;height:130px;">
            ${Object.entries(monthlyRev).map(([month,val])=>`
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;">
                <div style="font-size:10px;font-weight:500;">${val>0?fmt.money(val):''}</div>
                <div style="width:100%;border-radius:6px 6px 0 0;min-height:4px;background:var(--info-dim);height:${Math.max(Math.round((val/maxRev)*100),4)}px;border-top:2px solid var(--info);"></div>
                <div style="font-size:10.5px;color:var(--text-tertiary);">${month}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Top pros by revenue</div></div>
          ${topPros.slice(0,5).map((p,i)=>`
            <div class="list-item">
              <div style="width:22px;text-align:center;font-size:13px;font-weight:700;color:var(--text-tertiary);">${i+1}</div>
              ${avatar(p.full_name,36)}
              <div class="list-item-info"><div class="list-item-title">${p.full_name}</div></div>
              <div class="mono">${fmt.money(p.revenue)}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="right-stack">
        <div class="card">
          <div class="card-header"><div class="card-title">Lessons this month</div></div>
          <div style="padding:16px;">
            ${[
              ['Completed',(allLessons||[]).filter(l=>l.status==='completed'&&l.scheduled_at>=monthStart).length],
              ['Upcoming',(allLessons||[]).filter(l=>l.status==='upcoming'&&l.scheduled_at>=monthStart).length],
              ['Pending approval',(allLessons||[]).filter(l=>l.status==='pending').length],
              ['Cancelled',(allLessons||[]).filter(l=>(l.status==='cancelled'||l.status==='declined')&&l.scheduled_at>=monthStart).length],
            ].map(([l,v])=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><div style="color:var(--text-tertiary);">${l}</div><div style="font-weight:600;">${v}</div></div>`).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Members</div></div>
          <div style="padding:16px;">
            ${[
              ['Total members', members?.length||0],
              ['New this month', newMembers],
              ['With lessons', new Set((allLessons||[]).filter(l=>l.client_id).map(l=>l.client_id)).size],
            ].map(([l,v])=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><div style="color:var(--text-tertiary);">${l}</div><div style="font-weight:600;">${v}</div></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
}

//  ENHANCED SESSION NOTES with video/YouTube 
async function modalAddNoteWithMedia() {
  const clients = await getClientsForPro();
  const focusAreas = getSportFocusAreas();
  const drills = getSportDrills();
  const preselectCli = window._preselectedClient;
  const preselectCliId = preselectCli?.id || null;
  window._preselectedClient = null;

  openModal(`
    <div class="modal-title">Add session note</div>
    ${clientSelect(clients,'mn-client')}
    <div class="form-row">
      <div class="form-group"><label class="form-label">Focus area</label>
        <select id="mn-focus"><option value="">General lesson</option>${focusAreas.map(f=>`<option value="${f}">${f}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label class="form-label">Category</label>
        <select id="mn-category"><option value="">Select</option><option value="Technique">Technique</option><option value="Tactics">Tactics</option><option value="Physical">Physical</option><option value="Mental">Mental</option></select>
      </div>
    </div>
    <div class="form-group"><label class="form-label">What worked well OK</label>
      <textarea id="mn-worked" rows="2" placeholder="Describe the positives and improvements you observed..."></textarea>
    </div>
    <div class="form-group"><label class="form-label">Areas to develop</label>
      <textarea id="mn-notes" rows="2" placeholder="What needs more work? What patterns did you notice?"></textarea>
    </div>
    <div class="form-group"><label class="form-label">Objectives for next session</label>
      <textarea id="mn-obj" rows="2" placeholder="Specific goals for the next lesson..."></textarea>
    </div>
    <div class="form-group"><label class="form-label">Homework / drills to practice</label>
      <select id="mn-drill-select" onchange="if(this.value){const hw=document.getElementById('mn-hw');hw.value=(hw.value?hw.value+', ':'')+this.value;this.value='';}">
        <option value="">+ Add a drill from library...</option>
        ${drills.map(d=>`<option value="${d.name}">${d.name}</option>`).join('')}
      </select>
      <textarea id="mn-hw" rows="2" placeholder="Drills and exercises to practice..." style="margin-top:6px;"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Video reference (YouTube link or URL)</label>
      <input type="url" id="mn-video" placeholder="https://youtube.com/watch?v=... or any video URL"/>
      <div style="font-size:11.5px;color:var(--text-tertiary);margin-top:4px;">Add a YouTube link to a drill, technique tip, or match example for the client to study.</div>
    </div>
    <div class="form-group"><label class="form-label">Share with client?</label>
      <select id="mn-share"><option value="false">No -- keep private</option><option value="true">Yes -- share with client</option></select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mn-btn" onclick="saveNoteWithMedia()">Save note</button>
    </div>`);

  if (preselectCliId) {
    setTimeout(()=>{
      const sel = document.getElementById('mn-client');
      if (sel) sel.value = preselectCliId;
      const nm = document.getElementById('mn-client-name');
      if (nm && preselectCli?.name) nm.value = preselectCli.name;
    }, 30);
  }
}

async function saveNoteWithMedia() {
  if (_busy.note) return; _busy.note=true; saveBusy('mn-btn',true,'Saving...');
  const clientId = document.getElementById('mn-client')?.value||null;
  const clientName = clientId
    ? (document.getElementById('mn-client')?.selectedOptions[0]?.text||null)
    : (document.getElementById('mn-client-name')?.value.trim()||null);
  const videoUrl = document.getElementById('mn-video')?.value.trim()||null;
  const { error } = await db.from('session_notes').insert({
    pro_id: currentProfile.id,
    client_id: clientId, client_name: clientName,
    sport: getActiveSport(),
    focus_area: document.getElementById('mn-focus')?.value||null,
    category: document.getElementById('mn-category')?.value||null,
    what_worked: document.getElementById('mn-worked')?.value||null,
    pro_notes: document.getElementById('mn-notes')?.value||null,
    objectives: document.getElementById('mn-obj')?.value||null,
    homework: document.getElementById('mn-hw')?.value||null,
    video_url: videoUrl,
    shared_with_client: document.getElementById('mn-share')?.value==='true',
  });
  _busy.note = false; saveBusy('mn-btn',false,'Save note');
  if (error) { toast('Error: '+error.message,'error'); return; }
  if (clientId) {
    const shared = document.getElementById('mn-share')?.value==='true';
    if (shared) await createNotification(clientId,'new_note','Your coach added a session note','Check your Coach Notes for feedback from your latest session.','notes');
  }
  closeModal(); toast('Session note saved!'); cacheClear(); go('notes');
}

//  VIDEO DISPLAY in client notes 
function renderVideoEmbed(url) {
  if (!url) return '';
  // Extract YouTube video ID
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) {
    const videoId = ytMatch[1];
    return `<div style="margin-top:10px;border-radius:10px;overflow:hidden;aspect-ratio:16/9;background:#000;">
      <iframe src="https://www.youtube.com/embed/${videoId}?rel=0" frameborder="0" allowfullscreen
        style="width:100%;height:100%;border:none;" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
      </iframe>
    </div>`;
  }
  // Generic video link
  return `<a href="${url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:var(--danger-dim);color:var(--danger);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:500;text-decoration:none;margin-top:8px;">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm-1.5 9.5V5.5l5 3-5 3z" fill="currentColor"/></svg>
    Watch reference video
  </a>`;
}

//  COURT BOOKING (basic) 
async function pgCourtBooking(el) {
  actionBtn('+ Book court','btn-primary','modalBookCourt()');
  const { data: bookings } = await db.from('court_bookings')
    .select('*')
    .eq('club_name', currentProfile.club_name)
    .gte('start_at', new Date().toISOString())
    .order('start_at');
  const courts = [...new Set((bookings||[]).map(b=>b.court_name).filter(Boolean)), 'Court 1','Court 2','Court 3'].filter((v,i,a)=>a.indexOf(v)===i);
  el.innerHTML = `
    <div style="background:var(--info-dim);border-radius:10px;padding:14px 18px;margin-bottom:16px;">
      <div style="font-size:14px;font-weight:600;color:var(--info);margin-bottom:3px;">Court Reservations . ${currentProfile.club_name||'Your club'}</div>
      <div style="font-size:12.5px;color:var(--info);opacity:0.85;">Book courts for lessons, clinics, or practice. All members can see court availability.</div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Upcoming bookings</div></div>
      ${!bookings?.length ? emptyState('[T]','No court bookings','Book a court for your next lesson or practice session.','Book court','modalBookCourt()')
      : bookings.map(b=>`
        <div class="list-item" style="flex-wrap:wrap;gap:8px;">
          <div style="width:42px;height:42px;border-radius:10px;background:var(--brand-dim);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-text);flex-shrink:0;">${(b.court_name||'').slice(-1)||'C'}</div>
          <div class="list-item-info">
            <div class="list-item-title">${b.court_name||'Court'}</div>
            <div class="list-item-meta">${fmt.date(b.start_at)} . ${fmt.time(b.start_at)} - ${fmt.time(b.end_at)}</div>
          </div>
          ${b.booked_by===currentProfile.id?`<button class="btn btn-sm btn-decline" onclick="cancelCourtBooking('${b.id}')">Cancel</button>`:'<span class="badge badge-gray">Reserved</span>'}
        </div>`).join('')}
    </div>`;
}

async function modalBookCourt() {
  const { data: existingBookings } = await db.from('court_bookings')
    .select('court_name,start_at,end_at')
    .eq('club_name', currentProfile.club_name)
    .gte('start_at', new Date().toISOString());
  openModal(`
    <div class="modal-title">Book a court</div>
    <div class="form-group"><label class="form-label">Court</label>
      <input type="text" id="cb-court" placeholder="e.g. Court 1, Centre Court"/>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date</label><input type="date" id="cb-date" min="${new Date().toISOString().split('T')[0]}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Start time</label><input type="time" id="cb-start" value="09:00"/></div>
      <div class="form-group"><label class="form-label">End time</label><input type="time" id="cb-end" value="10:00"/></div>
    </div>
    <div class="form-group"><label class="form-label">Purpose</label>
      <select id="cb-purpose"><option value="lesson">Lesson</option><option value="clinic">Clinic</option><option value="practice">Practice</option><option value="match">Match play</option></select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="cb-btn" onclick="saveCourtBooking()">Book court</button>
    </div>`);
}

async function saveCourtBooking() {
  if (_busy.cb) return; _busy.cb=true; saveBusy('cb-btn',true,'Booking...');
  const date = document.getElementById('cb-date').value;
  const start = document.getElementById('cb-start').value;
  const end = document.getElementById('cb-end').value;
  const court = document.getElementById('cb-court').value.trim();
  if (!date||!start||!end||!court) { toast('Please fill all fields.','error'); _busy.cb=false; saveBusy('cb-btn',false,'Book court'); return; }
  const startAt = date+'T'+start+':00';
  const endAt   = date+'T'+end+':00';
  if (endAt <= startAt) { toast('End time must be after start time.','error'); _busy.cb=false; saveBusy('cb-btn',false,'Book court'); return; }
  // Check for conflicts
  const { data: conflicts } = await db.from('court_bookings')
    .select('id')
    .eq('club_name', currentProfile.club_name)
    .eq('court_name', court)
    .eq('status', 'confirmed')
    .lt('start_at', endAt)
    .gt('end_at', startAt);
  if (conflicts?.length) { toast('This court is already booked for that time.','error'); _busy.cb=false; saveBusy('cb-btn',false,'Book court'); return; }
  const { error } = await db.from('court_bookings').insert({
    club_name: currentProfile.club_name,
    court_name: court,
    booked_by: currentProfile.id,
    start_at: startAt,
    end_at: endAt,
    status: 'confirmed',
  });
  _busy.cb=false; saveBusy('cb-btn',false,'Book court');
  if (error) { toast('Error: '+error.message,'error'); return; }
  closeModal(); toast('Court booked!'); cacheClear(); go('courts');
}

async function cancelCourtBooking(id) {
  if (!confirm('Cancel this court booking?')) return;
  await db.from('court_bookings').update({status:'cancelled'}).eq('id',id);
  toast('Booking cancelled.'); cacheClear(); go('courts');
}

//  iCAL EXPORT 
async function exportCalendar() {
  const field = currentProfile.role==='pro'?'pro_id':'client_id';
  const { data: lessons } = await db.from('lessons')
    .select('*')
    .eq(field, currentProfile.id)
    .in('status',['upcoming','confirmed'])
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at');
  if (!lessons?.length) { toast('No upcoming lessons to export.','error'); return; }
  let ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CourtPro//CourtPro Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n';
  lessons.forEach(l => {
    const start = new Date(l.scheduled_at);
    const end   = new Date(start.getTime() + (l.duration_minutes||60)*60000);
    const fmt8601 = d => d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
    ical += `BEGIN:VEVENT\r\nUID:${l.id}@courtpro\r\nDTSTART:${fmt8601(start)}\r\nDTEND:${fmt8601(end)}\r\nSUMMARY:${(l.type||'Lesson')+' lesson'+(l.client_name?' with '+l.client_name:'')}\r\nLOCATION:${l.court||'TBD'}\r\nDESCRIPTION:${l.focus_area||'General lesson'}\r\nEND:VEVENT\r\n`;
  });
  ical += 'END:VCALENDAR';
  const blob = new Blob([ical], {type:'text/calendar'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'courtpro-lessons.ics'; a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${lessons.length} lessons to calendar!`);
}


async function showNotifications() {
  const { data: notifs } = await db.from('notifications').select('*').eq('user_id', currentProfile.id).order('created_at', { ascending: false }).limit(20);
  markNotificationsRead();
  openModal(`
    <div class="modal-title">Notifications</div>
    ${!notifs?.length ? '<div style="text-align:center;padding:24px;color:var(--text-tertiary);">No notifications yet.</div>'
    : notifs.map(n => `
      <div style="padding:12px;border-bottom:1px solid var(--border);${!n.read?'background:var(--info-dim);border-radius:8px;margin-bottom:4px;':''}">
        <div style="font-size:13.5px;font-weight:500;">${n.title}</div>
        ${n.body ? `<div style="font-size:12.5px;color:var(--text-secondary);margin-top:2px;line-height:1.5;">${n.body}</div>` : ''}
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">${fmt.relativeDate(n.created_at)}</div>
        ${n.link_page ? `<button class="btn btn-sm" style="margin-top:6px;" onclick="closeModal();go('${n.link_page}');">View</button>` : ''}
      </div>`).join('')}
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`);
}

async function pgMgrMessages(el) {
  const { data: msgs } = await db.from('messages').select('*, from:from_id(full_name)').eq('to_id', currentProfile.id).order('created_at', { ascending: false });
  el.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">Messages from pros</div></div>
      ${!msgs?.length ? emptyState('[chat]','No messages yet','Messages from pros you contact will appear here.',null,null)
      : msgs.map(m => `
        <div style="padding:14px 16px;border-bottom:1px solid var(--border);${!m.read?'background:var(--info-dim);':''}">
          <div style="font-size:13.5px;font-weight:500;">${m.from?.full_name||'Pro'}</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;line-height:1.6;">${m.body}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">${fmt.relativeDate(m.created_at)}</div>
        </div>`).join('')}
    </div>`;
  if (msgs?.some(m => !m.read)) await db.from('messages').update({ read: true }).eq('to_id', currentProfile.id).eq('read', false);
}


// ============================================================
// COMMUNITY BOARDS
// ============================================================
async function pgCommunity(el) { await renderBoard(el, 'general', 'Community Discussion', '[globe]', 'Ask questions, share tips, and connect with players and coaches.'); }
async function pgProBoard(el)   { await renderBoard(el, 'pros', 'Pro Forum', '[T]', 'A space for teaching pros to connect, share ideas, and discuss coaching.', 'pro'); }
async function pgMgrBoard(el)   { await renderBoard(el, 'managers', 'Manager Forum', '[club]', 'A private space for club managers to share resources and coordinate.', 'manager'); }

async function renderBoard(el, board, title, icon, subtitle, requiredRole) {
  const role = _activeRole || currentProfile.role;
  if (requiredRole && role !== requiredRole) {
    el.innerHTML = `<div class="card">${emptyState(icon,'Members only','This board is for ${requiredRole}s only.',null,null)}</div>`;
    return;
  }
  el.innerHTML = `<div style="padding:16px 0 8px;"><div class="skeleton-row" style="width:60%;margin-bottom:12px;"></div><div class="skeleton-row" style="width:100%;height:60px;"></div></div>`;
  const { data: posts } = await db.from('community_posts')
    .select('*, replies:community_posts(count)')
    .eq('board', board)
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .limit(40);

  actionBtn('+ New post','btn-primary',`modalNewPost('${board}')`);
  el.innerHTML = `
    <div style="background:var(--bg);border-radius:10px;padding:14px 18px;margin-bottom:16px;border:1px solid var(--border);">
      <div style="font-size:16px;font-weight:600;margin-bottom:2px;">${icon} ${title}</div>
      <div style="font-size:12.5px;color:var(--text-tertiary);">${subtitle}</div>
    </div>
    <div id="board-posts">
      ${!posts?.length ? emptyState('[chat]','No posts yet','Be the first to start a conversation!',null,null)
      : posts.map(p => renderPostRow(p, board)).join('')}
    </div>`;
}

function renderPostRow(p, board) {
  const replyCount = p.replies?.[0]?.count || 0;
  const timeAgo = fmt.relativeDate(p.created_at);
  const roleColors = { pro:'var(--brand-text)', manager:'var(--info)', client:'var(--pkl-text)' };
  const roleBgs   = { pro:'var(--brand-dim)', manager:'var(--info-dim)', client:'var(--pkl-dim)' };
  return `<div class="card" style="margin-bottom:10px;cursor:pointer;" onclick="openPost('${p.id}','${board}')">
    <div style="padding:14px 16px;">
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <div style="width:34px;height:34px;border-radius:50%;background:${roleBgs[p.author_role]||'var(--bg)'};color:${roleColors[p.author_role]||'var(--text-tertiary)'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;">${fmt.initials(p.author_name||'?')}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:500;margin-bottom:4px;line-height:1.4;">${p.body.slice(0,120)}${p.body.length>120?'...':''}</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:11.5px;color:var(--text-tertiary);">${p.author_name||'Member'}</div>
            <div style="font-size:11px;color:var(--text-tertiary);">${timeAgo}</div>
            ${replyCount > 0 ? `<div style="font-size:11.5px;color:var(--brand);">[chat] ${replyCount} repl${replyCount===1?'y':'ies'}</div>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

async function openPost(postId, board) {
  const [{ data: post }, { data: replies }] = await Promise.all([
    db.from('community_posts').select('*').eq('id', postId).single(),
    db.from('community_posts').select('*').eq('parent_id', postId).order('created_at', { ascending: true }),
  ]);
  if (!post) return;
  const roleColors = { pro:'var(--brand-text)', manager:'var(--info)', client:'var(--pkl-text)' };
  const roleBgs   = { pro:'var(--brand-dim)', manager:'var(--info-dim)', client:'var(--pkl-dim)' };
  function msgBubble(p, isReply) {
    return `<div style="display:flex;gap:10px;margin-bottom:14px;${isReply?'padding-left:10px;':''}">
      <div style="width:${isReply?28:36}px;height:${isReply?28:36}px;border-radius:50%;background:${roleBgs[p.author_role]||'var(--bg)'};color:${roleColors[p.author_role]||'var(--text-tertiary)'};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;">${fmt.initials(p.author_name||'?')}</div>
      <div style="flex:1;background:${isReply?'var(--bg)':'var(--surface)'};border-radius:10px;padding:10px 14px;border:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
          <div style="font-size:12.5px;font-weight:600;">${p.author_name||'Member'}</div>
          <div style="font-size:10.5px;color:var(--text-tertiary);">${fmt.relativeDate(p.created_at)}</div>
          ${p.author_role?`<span style="font-size:10px;padding:1px 7px;border-radius:10px;background:${roleBgs[p.author_role]};color:${roleColors[p.author_role]};font-weight:600;">${p.author_role}</span>`:''}
        </div>
        <div style="font-size:13.5px;line-height:1.6;color:var(--text-primary);">${p.body}</div>
      </div>
    </div>`;
  }
  openModal(`
    <div style="max-height:60vh;overflow-y:auto;margin:-4px -4px 0;">
      ${msgBubble(post, false)}
      ${(replies||[]).map(r => msgBubble(r, true)).join('')}
      <div id="reply-area" style="padding:0 0 4px;">
        <textarea id="reply-text" rows="2" placeholder="Write a reply..." style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13.5px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);resize:none;outline:none;box-sizing:border-box;" onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"></textarea>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn btn-primary" id="reply-btn" onclick="submitReply('${postId}','${board}')">Reply</button>
    </div>`);
}

async function submitReply(parentId, board) {
  const text = document.getElementById('reply-text')?.value.trim();
  if (!text) { toast('Please write something first.','error'); return; }
  saveBusy('reply-btn', true, 'Posting...');
  const { error } = await db.from('community_posts').insert({
    author_id: currentProfile.id,
    author_name: currentProfile.full_name,
    author_role: _activeRole || currentProfile.role,
    body: text,
    parent_id: parentId,
    board,
    club_name: currentProfile.club_name || null,
  });
  saveBusy('reply-btn', false, 'Reply');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  toast('Reply posted! OK'); closeModal();
  await openPost(parentId, board);
}

function modalNewPost(board) {
  openModal(`
    <div class="modal-title">New post</div>
    <div class="form-group">
      <label class="form-label">What's on your mind?</label>
      <textarea id="new-post-text" rows="5" placeholder="Share a tip, ask a question, or start a discussion..." style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13.5px;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-primary);resize:none;outline:none;box-sizing:border-box;" onfocus="this.style.borderColor='var(--brand)'" onblur="this.style.borderColor=''"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="post-btn" onclick="submitPost('${board}')">Post</button>
    </div>`);
}

async function submitPost(board) {
  const text = document.getElementById('new-post-text')?.value.trim();
  if (!text || text.length < 3) { toast('Please write something first.','error'); return; }
  saveBusy('post-btn', true, 'Posting...');
  const { error } = await db.from('community_posts').insert({
    author_id: currentProfile.id,
    author_name: currentProfile.full_name,
    author_role: _activeRole || currentProfile.role,
    body: text,
    board,
    club_name: currentProfile.club_name || null,
  });
  saveBusy('post-btn', false, 'Post');
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  toast('Posted! OK'); closeModal(); cacheClear();
  // Re-render the board
  const el = document.getElementById('page-container');
  if (el) {
    if (board==='general') pgCommunity(el);
    else if (board==='pros') pgProBoard(el);
    else if (board==='managers') pgMgrBoard(el);
  }
}function avatar(name, size = 36, bg, color) {
  const initials = name ? name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2) : '?';
  const colors = [
    ['var(--brand-dim)','var(--brand-text)'],
    ['var(--pkl-dim)','var(--pkl-text)'],
    ['var(--info-dim)','var(--info)'],
    ['var(--warning-dim)','var(--warning)'],
    ['var(--danger-dim)','var(--danger)'],
  ];
  const [defaultBg, defaultColor] = colors[(name||'').charCodeAt(0) % colors.length];
  const bgColor = bg || defaultBg;
  const textColor = color || defaultColor;
  const fontSize = Math.round(size * 0.38);
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bgColor};color:${textColor};display:flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:700;flex-shrink:0;font-family:'Inter',sans-serif;">${initials}</div>`;
}




function filterMyClients(val) {
  const q = (val || '').toLowerCase();
  document.querySelectorAll('#cli-list .cli-row').forEach(function(el) {
    el.style.display = (el.dataset.name || '').includes(q) ? '' : 'none';
  });
}

function filterDrills(cat) {
  document.querySelectorAll('.drill-filter').forEach(function(btn) {
    btn.classList.toggle('btn-primary', btn.textContent.trim() === cat);
  });
  document.querySelectorAll('.drill-item').forEach(function(el) {
    el.style.display = (cat === 'All' || el.dataset.cat === cat) ? '' : 'none';
  });
}

async function modalCreateInvoice() {
  var clients = [];
  try {
    var r = await db.from('profiles').select('id, full_name').eq('role','client').order('full_name');
    clients = r.data || [];
  } catch(e) {}
  var opts = clients.map(function(c){ return '<option value="' + c.id + '">' + (c.full_name||'Client') + '</option>'; }).join('');
  var dueDate = new Date(Date.now()+7*86400000).toISOString().split('T')[0];
  openModal(
    '<div class="modal-title">Create invoice</div>' +
    '<div class="form-group"><label class="form-label">Client</label><select id="inv-client">' + opts + '</select></div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label class="form-label">Amount ($)</label><input type="number" id="inv-amount" value="120" min="0"/></div>' +
    '<div class="form-group"><label class="form-label">Due date</label><input type="date" id="inv-due" value="' + dueDate + '"/></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Description (optional)</label><input type="text" id="inv-desc" placeholder="e.g. 4 private lessons - June"/></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="inv-save-btn" onclick="saveInvoice()">Create invoice</button>' +
    '</div>'
  );
}

async function saveInvoice() {
  if (_busy.invoice) return;
  _busy.invoice = true;
  saveBusy('inv-save-btn', true, 'Saving...');
  var sel = document.getElementById('inv-client');
  var clientId = sel ? sel.value : null;
  var clientName = sel ? sel.options[sel.selectedIndex].text : '';
  var amount = parseFloat(document.getElementById('inv-amount').value) || 0;
  var due = document.getElementById('inv-due').value;
  var desc = (document.getElementById('inv-desc').value || '').trim();
  var result = await db.from('invoices').insert({
    pro_id: currentProfile.id,
    client_id: clientId,
    client_name: clientName,
    amount: amount,
    due_date: due,
    description: desc || null,
    status: 'unpaid'
  });
  _busy.invoice = false;
  saveBusy('inv-save-btn', false, 'Create invoice');
  if (result.error) { toast('Error: ' + result.error.message, 'error'); return; }
  toast('Invoice created!');
  closeModal();
  cacheClear();
  go('invoices');
}



// ============================================================
// VOICE RECORDER UTILITY
// Web Speech API - works on Chrome/Edge/Safari iOS 14.5+
// Falls back gracefully on unsupported browsers
// ============================================================

var _voiceRecognition = null;
var _voiceActive = false;
var _voiceTargetId = null;

function startVoiceRecorder(targetInputId, statusId) {
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('Voice input is not supported in this browser. Try Chrome or Safari.', 'error');
    return;
  }

  if (_voiceActive) {
    stopVoiceRecorder(statusId);
    return;
  }

  _voiceTargetId = targetInputId;
  _voiceActive = true;

  var btn = document.getElementById(statusId);
  if (btn) {
    btn.textContent = 'Stop recording';
    btn.style.background = 'var(--danger)';
    btn.style.color = 'white';
    btn.style.borderColor = 'var(--danger)';
  }

  _voiceRecognition = new SpeechRecognition();
  _voiceRecognition.continuous = true;
  _voiceRecognition.interimResults = true;
  _voiceRecognition.lang = 'en-US';
  _voiceRecognition.maxAlternatives = 1;

  var finalTranscript = '';
  var existingText = '';
  var ta = document.getElementById(targetInputId);
  if (ta) existingText = ta.value ? ta.value + ' ' : '';

  _voiceRecognition.onresult = function(event) {
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + ' ';
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    var ta2 = document.getElementById(targetInputId);
    if (ta2) ta2.value = existingText + finalTranscript + interim;
  };

  _voiceRecognition.onerror = function(event) {
    stopVoiceRecorder(statusId);
    if (event.error === 'not-allowed') {
      toast('Microphone access denied. Please allow microphone access and try again.', 'error');
    } else if (event.error === 'no-speech') {
      toast('No speech detected. Try speaking louder.', 'info');
    } else {
      toast('Voice error: ' + event.error, 'error');
    }
  };

  _voiceRecognition.onend = function() {
    if (_voiceActive) {
      try { _voiceRecognition.start(); } catch(e) {}
    }
  };

  try {
    _voiceRecognition.start();
  } catch(e) {
    toast('Could not start voice recorder: ' + e.message, 'error');
    _voiceActive = false;
  }
}

function stopVoiceRecorder(statusId) {
  _voiceActive = false;
  if (_voiceRecognition) {
    try { _voiceRecognition.stop(); } catch(e) {}
    _voiceRecognition = null;
  }
  var btn = document.getElementById(statusId);
  if (btn) {
    btn.textContent = '[mic] Voice input';
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

function voiceBtn(targetId, btnId, label) {
  label = label || 'Voice input';
  return '<button type="button" id="' + btnId + '" class="btn btn-sm" ' +
    'onclick="startVoiceRecorder('' + targetId + '','' + btnId + '')" ' +
    'style="display:inline-flex;align-items:center;gap:5px;">' +
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">' +
    '<rect x="5" y="1" width="6" height="9" rx="3" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M2 8c0 3.3 2.7 6 6 6s6-2.7 6-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<line x1="8" y1="14" x2="8" y2="16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</svg>' + label + '</button>';
}

// ============================================================
// PRO SESSION NOTE MODAL WITH VOICE RECORDER
// ============================================================

async function modalAddNote() {
  var clients = [];
  try {
    var r = await db.from('lessons')
      .select('client_id, client_name, client:client_id(full_name)')
      .eq('pro_id', currentProfile.id)
      .order('scheduled_at', { ascending: false })
      .limit(50);
    var seen = {};
    (r.data || []).forEach(function(l) {
      var id = l.client_id;
      var name = (l.client && l.client.full_name) || l.client_name || '';
      if (id && !seen[id]) { seen[id] = true; clients.push({ id: id, name: name }); }
    });
  } catch(e) {}

  var sport = getActiveSport();
  var focusAreas = getSportFocusAreas() || [];
  var cats = ['General','Technique','Tactics','Fitness','Mental','Serve','Return','Net play','Groundstrokes'];
  var focusOpts = cats.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
  var clientOpts = clients.map(function(c) { return '<option value="' + c.id + '" data-name="' + c.name + '">' + c.name + '</option>'; }).join('');

  openModal(
    '<div class="modal-title">Add session note</div>' +
    '<div class="form-group"><label class="form-label">Client</label>' +
    '<select id="sn-client">' + (clientOpts || '<option value="">No clients yet</option>') + '</select></div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label class="form-label">Focus area</label><select id="sn-focus">' + focusOpts + '</select></div>' +
    '<div class="form-group"><label class="form-label">Rating (1-10)</label><input type="number" id="sn-rating" min="1" max="10" value="" placeholder="Optional"/></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">' +
    'What worked well ' + voiceBtn('sn-worked','sn-worked-mic','[mic] Dictate') + '</label>' +
    '<textarea id="sn-worked" rows="2" placeholder="Describe what the student did well this session..."></textarea></div>' +
    '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">' +
    'Areas to develop ' + voiceBtn('sn-develop','sn-develop-mic','[mic] Dictate') + '</label>' +
    '<textarea id="sn-develop" rows="2" placeholder="What needs more work? Be specific..."></textarea></div>' +
    '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">' +
    'Homework & drills ' + voiceBtn('sn-homework','sn-homework-mic','[mic] Dictate') + '</label>' +
    '<textarea id="sn-homework" rows="2" placeholder="Drills or exercises to practice before next session..."></textarea></div>' +
    '<div class="form-group"><label class="form-label">Reference video URL (YouTube)</label>' +
    '<input type="url" id="sn-video" placeholder="https://youtube.com/..."/></div>' +
    '<div style="display:flex;align-items:center;gap:9px;margin-bottom:16px;">' +
    '<input type="checkbox" id="sn-share" checked style="width:16px;height:16px;accent-color:var(--brand);"/>' +
    '<label for="sn-share" style="font-size:13.5px;cursor:pointer;">Share with client immediately</label></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="stopVoiceRecorder('sn-worked-mic');stopVoiceRecorder('sn-develop-mic');stopVoiceRecorder('sn-homework-mic');closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="sn-save-btn" onclick="saveNote()">Save note</button>' +
    '</div>'
  );
}

async function modalAddNoteForLesson(lessonId, clientId, clientNameEncoded) {
  await modalAddNote();
  var clientName = decodeURIComponent(clientNameEncoded || '');
  var sel = document.getElementById('sn-client');
  if (sel && clientId) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === clientId) {
        sel.selectedIndex = i;
        break;
      }
    }
  }
}

async function saveNote() {
  if (_busy.note) return;
  _busy.note = true;
  saveBusy('sn-save-btn', true, 'Saving...');

  stopVoiceRecorder('sn-worked-mic');
  stopVoiceRecorder('sn-develop-mic');
  stopVoiceRecorder('sn-homework-mic');

  var clientId = document.getElementById('sn-client') ? document.getElementById('sn-client').value : null;
  var clientName = document.getElementById('sn-client') ?
    (document.getElementById('sn-client').options[document.getElementById('sn-client').selectedIndex] || {}).text || '' : '';
  var worked = (document.getElementById('sn-worked') || {}).value || '';
  var develop = (document.getElementById('sn-develop') || {}).value || '';
  var homework = (document.getElementById('sn-homework') || {}).value || '';
  var videoUrl = (document.getElementById('sn-video') || {}).value || '';
  var focusArea = (document.getElementById('sn-focus') || {}).value || '';
  var rating = parseInt((document.getElementById('sn-rating') || {}).value) || null;
  var shared = document.getElementById('sn-share') ? document.getElementById('sn-share').checked : false;

  if (!worked && !develop && !homework) {
    toast('Please add at least one note.', 'error');
    _busy.note = false;
    saveBusy('sn-save-btn', false, 'Save note');
    return;
  }

  var payload = {
    pro_id: currentProfile.id,
    client_id: clientId || null,
    client_name: clientName || null,
    what_worked: worked.trim() || null,
    pro_notes: develop.trim() || null,
    homework: homework.trim() || null,
    video_url: videoUrl.trim() || null,
    focus_area: focusArea || null,
    rating: rating,
    shared_with_client: shared,
    sport: getActiveSport(),
  };

  var result = await db.from('session_notes').insert(payload);
  _busy.note = false;
  saveBusy('sn-save-btn', false, 'Save note');

  if (result.error) {
    toast('Error saving note: ' + result.error.message, 'error');
    return;
  }

  if (shared && clientId) {
    await createNotification(
      clientId, 'new_note', 'New session note from your coach',
      'Your coach added a session note. Check your Coach Notes.',
      'notes'
    );
  }

  toast('Session note saved!' + (shared ? ' Shared with client.' : ''));
  closeModal();
  cacheClear();
  go('notes');
}

// ============================================================
// CLIENT SESSION NOTES WITH VOICE RECORDER
// ============================================================

async function pgClientNotes(el) {
  var [notesRes, clientNotesRes] = await Promise.all([
    db.from('session_notes')
      .select('*, pro:pro_id(full_name)')
      .eq('client_id', currentProfile.id)
      .eq('shared_with_client', true)
      .order('created_at', { ascending: false }),
    db.from('client_notes')
      .select('*')
      .eq('client_id', currentProfile.id)
      .order('created_at', { ascending: false }),
  ]);

  var coachNotes = notesRes.data || [];
  var myNotes = clientNotesRes.data || [];

  el.innerHTML =
    '<div style="display:flex;gap:8px;padding:16px 24px 0;border-bottom:1px solid var(--border);margin-bottom:0;">' +
    '<button class="btn btn-sm ' + (true ? 'btn-primary' : '') + '" id="tab-coach" onclick="switchNotesTab('coach')">Coach notes (' + coachNotes.length + ')</button>' +
    '<button class="btn btn-sm" id="tab-mine" onclick="switchNotesTab('mine')">My notes (' + myNotes.length + ')' +
    '<span style="margin-left:6px;background:var(--brand);color:white;border-radius:10px;padding:1px 7px;font-size:10px;">NEW</span></button>' +
    '</div>' +
    '<div id="notes-tab-coach">' +
    renderCoachNotes(coachNotes) +
    '</div>' +
    '<div id="notes-tab-mine" style="display:none;">' +
    renderMyNotes(myNotes) +
    '</div>';

  actionBtn('+ Add my note', 'btn-primary', 'modalAddClientNote()');
}

function switchNotesTab(tab) {
  var coachTab = document.getElementById('notes-tab-coach');
  var mineTab = document.getElementById('notes-tab-mine');
  var btnCoach = document.getElementById('tab-coach');
  var btnMine = document.getElementById('tab-mine');
  if (!coachTab || !mineTab) return;

  if (tab === 'coach') {
    coachTab.style.display = '';
    mineTab.style.display = 'none';
    if (btnCoach) { btnCoach.classList.add('btn-primary'); }
    if (btnMine) { btnMine.classList.remove('btn-primary'); }
  } else {
    coachTab.style.display = 'none';
    mineTab.style.display = '';
    if (btnMine) { btnMine.classList.add('btn-primary'); }
    if (btnCoach) { btnCoach.classList.remove('btn-primary'); }
  }
}

function renderCoachNotes(notes) {
  if (!notes.length) {
    return emptyState('[note]', 'No coach notes yet',
      'Your coach will share session notes here after each lesson. Notes include what you worked on, areas to improve, and homework drills.',
      null, null);
  }
  return notes.map(function(n) {
    var videoHtml = '';
    if (n.video_url) {
      var ytMatch = n.video_url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
      if (ytMatch) {
        videoHtml = '<div class="video-embed" style="margin-top:10px;">' +
          '<iframe src="https://www.youtube.com/embed/' + ytMatch[1] + '" allowfullscreen loading="lazy"></iframe>' +
          '</div>';
      } else {
        videoHtml = '<a href="' + n.video_url + '" target="_blank" rel="noopener" ' +
          'style="font-size:13px;color:var(--brand);display:block;margin-top:8px;">[video] Watch reference video</a>';
      }
    }
    return '<div class="card" style="margin-bottom:12px;">' +
      '<div class="card-header">' +
      '<div><div class="card-title">' + (n.pro && n.pro.full_name ? n.pro.full_name : 'Your coach') + '</div>' +
      '<div class="card-subtitle">' + (n.created_at ? new Date(n.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '') +
      (n.focus_area ? ' - ' + n.focus_area : '') + '</div></div>' +
      (n.rating ? '<span class="badge badge-brand">' + n.rating + '/10</span>' : '') +
      '</div>' +
      '<div style="padding:14px 20px;">' +
      (n.what_worked ? '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:var(--success);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">[OK] What worked</div>' +
        '<div style="font-size:13.5px;line-height:1.7;">' + n.what_worked + '</div></div>' : '') +
      (n.pro_notes ? '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Areas to develop</div>' +
        '<div style="font-size:13.5px;line-height:1.7;">' + n.pro_notes + '</div></div>' : '') +
      (n.homework ? '<div style="background:var(--pkl-dim);border-radius:8px;padding:10px 14px;margin-bottom:8px;">' +
        '<div style="font-size:11px;font-weight:600;color:var(--pkl-text);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">[workout] Homework</div>' +
        '<div style="font-size:13px;color:var(--pkl-text);line-height:1.6;">' + n.homework + '</div></div>' : '') +
      videoHtml +
      '</div></div>';
  }).join('');
}

function renderMyNotes(notes) {
  var addBtn = '<div style="padding:16px 20px 0;">' +
    '<button class="btn btn-primary" onclick="modalAddClientNote()" style="width:100%;">+ Add session note</button>' +
    '</div>';

  if (!notes.length) {
    return addBtn + emptyState('[note]', 'No personal notes yet',
      'Add your own notes after each lesson. Reflect on what you learned, what felt good, and what to practice. You can dictate by voice.',
      null, null);
  }

  return addBtn + notes.map(function(n) {
    return '<div class="card" style="margin:12px 20px;">' +
      '<div class="card-header">' +
      '<div><div class="card-title">' + (n.lesson_date ? new Date(n.lesson_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'My note') + '</div>' +
      (n.mood ? '<div class="card-subtitle">Felt: ' + n.mood + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;">' +
      (n.shared_with_pro ? '<span class="badge badge-brand" style="font-size:10.5px;">Shared with coach</span>' : '<span class="badge badge-neutral" style="font-size:10.5px;">Private</span>') +
      '<button class="btn btn-sm btn-ghost" onclick="deleteClientNote('' + n.id + '')">Delete</button>' +
      '</div></div>' +
      '<div style="padding:14px 20px;">' +
      (n.reflection ? '<div style="font-size:13.5px;line-height:1.7;margin-bottom:8px;">' + n.reflection + '</div>' : '') +
      (n.goals_next ? '<div style="background:var(--brand-dim);border-radius:8px;padding:10px 14px;">' +
        '<div style="font-size:11px;font-weight:600;color:var(--brand-text);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Goals for next session</div>' +
        '<div style="font-size:13px;color:var(--brand-text);line-height:1.6;">' + n.goals_next + '</div></div>' : '') +
      '</div></div>';
  }).join('');
}

function modalAddClientNote() {
  var today = new Date().toISOString().split('T')[0];
  openModal(
    '<div class="modal-title">Add my session note</div>' +
    '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px;">Your personal reflection on today's lesson. Use voice dictation or type.</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label class="form-label">Lesson date</label>' +
    '<input type="date" id="cn-date" value="' + today + '"/></div>' +
    '<div class="form-group"><label class="form-label">How did it feel?</label>' +
    '<select id="cn-mood"><option value="">Select...</option>' +
    '<option value="Great">Great</option><option value="Good">Good</option>' +
    '<option value="OK">OK</option><option value="Tough">Tough</option><option value="Struggled">Struggled</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">' +
    'My reflection ' + voiceBtn('cn-reflection','cn-refl-mic','[mic] Dictate') + '</label>' +
    '<textarea id="cn-reflection" rows="3" placeholder="What did you work on? What clicked? What was hard? Speak freely..."></textarea></div>' +
    '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">' +
    'Goals for next session ' + voiceBtn('cn-goals','cn-goals-mic','[mic] Dictate') + '</label>' +
    '<textarea id="cn-goals" rows="2" placeholder="What do you want to focus on next time?"></textarea></div>' +
    '<div style="display:flex;align-items:center;gap:9px;margin-bottom:16px;">' +
    '<input type="checkbox" id="cn-share-coach" style="width:16px;height:16px;accent-color:var(--brand);"/>' +
    '<label for="cn-share-coach" style="font-size:13.5px;cursor:pointer;">Share this note with my coach</label>' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="stopVoiceRecorder('cn-refl-mic');stopVoiceRecorder('cn-goals-mic');closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="cn-save-btn" onclick="saveClientNote2()">Save note</button>' +
    '</div>'
  );
}

async function saveClientNote2() {
  if (_busy.clientNote) return;
  _busy.clientNote = true;
  saveBusy('cn-save-btn', true, 'Saving...');

  stopVoiceRecorder('cn-refl-mic');
  stopVoiceRecorder('cn-goals-mic');

  var date = (document.getElementById('cn-date') || {}).value || new Date().toISOString().split('T')[0];
  var mood = (document.getElementById('cn-mood') || {}).value || null;
  var reflection = ((document.getElementById('cn-reflection') || {}).value || '').trim();
  var goals = ((document.getElementById('cn-goals') || {}).value || '').trim();

  if (!reflection && !goals) {
    toast('Please add at least a reflection.', 'error');
    _busy.clientNote = false;
    saveBusy('cn-save-btn', false, 'Save note');
    return;
  }

  var shareCoach = document.getElementById('cn-share-coach') ? document.getElementById('cn-share-coach').checked : false;

  var result = await db.from('client_notes').insert({
    client_id: currentProfile.id,
    lesson_date: date,
    mood: mood || null,
    reflection: reflection || null,
    goals_next: goals || null,
    shared_with_pro: shareCoach,
  });

  // If sharing with coach, notify them
  if (shareCoach && currentProfile.role === 'client') {
    // Find the client's pro to notify
    try {
      var proRes = await db.from('client_pros').select('pro_id').eq('client_id', currentProfile.id).limit(1).single();
      if (proRes.data && proRes.data.pro_id) {
        await createNotification(
          proRes.data.pro_id,
          'client_note',
          currentProfile.full_name + ' shared a session note',
          'Your student added a note about their last session.',
          'clients'
        );
      }
    } catch(e) {}
  }

  _busy.clientNote = false;
  saveBusy('cn-save-btn', false, 'Save note');

  if (result.error) {
    // Table might not exist yet - try graceful fallback
    if (result.error.message && result.error.message.includes('does not exist')) {
      toast('Please run the database migration first. See SCHEMA.sql.', 'error');
    } else {
      toast('Error: ' + result.error.message, 'error');
    }
    return;
  }

  toast('Note saved!');
  closeModal();
  cacheClear();
  go('notes');
}

async function deleteClientNote(id) {
  if (!confirm('Delete this note?')) return;
  var result = await db.from('client_notes').delete().eq('id', id).eq('client_id', currentProfile.id);
  if (result.error) { toast('Error: ' + result.error.message, 'error'); return; }
  toast('Note deleted.');
  cacheClear();
  go('notes');
}


init();
