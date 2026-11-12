'use strict';
(() => {
  // ---------------------------------------------------------------------------
  // Basics
  // ---------------------------------------------------------------------------
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = {
    me: null, meta: null, list: [], listLoaded: false, discharged: [], showDc: false, file: null,
    view: null, q: '', sumKind: 'attending', busy: false, notice: null, lastActivity: Date.now(),
    deid: (() => { try { return localStorage.getItem('wb_deid') === '1'; } catch { return false; } })(),
    setup: null, staff: null, audit: null, tasks: null, people: null,
  };
  const STATUS = { stable: 'Stable', improving: 'Improving', watch: 'Watch', critical: 'Critical', ready_for_discharge: 'Ready for discharge', discharged: 'Discharged' };
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const iso = d => (d ? String(d).slice(0, 10) : '');
  const fmtDate = d => { if (!d) return ''; const x = new Date(iso(d) + 'T00:00:00'); return isNaN(x) ? d : x.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
  const fmtTime = d => new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const daysBetween = (a, b) => Math.floor((new Date(iso(b) + 'T00:00:00') - new Date(iso(a) + 'T00:00:00')) / 864e5);
  const hospDay = p => { if (!p.admitted_at) return null; const n = daysBetween(p.admitted_at, today()); return n >= 0 ? n + 1 : null; };
  const firstLine = t => String(t || '').split('\n')[0].trim().replace(/[.;,]$/, '');
  const initials = n => String(n || '').split(/\s+/).filter(w => /[A-Za-z]/.test(w[0] || '')).map(w => w[0].toUpperCase() + '.').join('') || '—';
  const showName = p => (S.deid ? initials(p.name) : p.name || 'Unnamed');
  const showNo = p => (S.deid ? '' : p.hospital_number || '');
  const perms = () => S.me?.perms || {};
  const deptName = d => S.meta?.departments?.[d] || d;

  class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
  async function api(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-wardbook': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && data?.stage) {
      const wasReady = S.me?.stage === 'ready';
      S.me = { ...(S.me || {}), stage: data.stage };
      if (data.stage === 'signed_out' && wasReady) S.notice = 'You were signed out. Sessions end after a period without activity, or when your access changes.';
      clearClinical();
      render();
      throw new ApiError(data.error || 'Signed out', 401, data);
    }
    if (!res.ok) throw new ApiError(data?.error || `The server returned an error (${res.status}).`, res.status, data);
    return data;
  }
  function clearClinical() { S.list = []; S.listLoaded = false; S.discharged = []; S.file = null; S.staff = null; S.audit = null; S.tasks = null; S.people = null; closeModal(); }

  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3200);
  }
  const fail = e => { if (e.status !== 401) toast(e.message); };

  // ---------------------------------------------------------------------------
  // Clinical helpers
  // ---------------------------------------------------------------------------
  function flag(key, v, dept) {
    if (dept === 'PEDS' || v == null || v === '') return '';
    const n = Number(v);
    switch (key) {
      case 'sbp': return n < 90 || n >= 180 ? 'crit' : n >= 140 || n < 100 ? 'warn' : '';
      case 'dbp': return n >= 120 ? 'crit' : n >= 90 ? 'warn' : '';
      case 'hr': return n < 40 || n > 130 ? 'crit' : n < 50 || n > 100 ? 'warn' : '';
      case 'rr': return n < 8 || n >= 25 ? 'crit' : n > 20 ? 'warn' : '';
      case 'temp': return n >= 39 || n < 35 ? 'crit' : n >= 38 || n < 36 ? 'warn' : '';
      case 'spo2': return n < 90 ? 'crit' : n < 94 ? 'warn' : '';
      case 'gcs': return n <= 8 ? 'crit' : n < 15 ? 'warn' : '';
      default: return '';
    }
  }
  const worst = (...f) => (f.includes('crit') ? 'crit' : f.includes('warn') ? 'warn' : '');
  function gaFromLmp(lmp) { if (!lmp) return null; const n = daysBetween(lmp, today()); return n < 0 || n > 320 ? null : { w: Math.floor(n / 7), d: n % 7 }; }
  function edd(lmp) { const d = new Date(lmp + 'T00:00:00'); d.setDate(d.getDate() + 280); return d.toISOString().slice(0, 10); }
  function maintFluid(kg) { kg = Number(kg); if (!(kg > 0)) return null; const ml = kg <= 10 ? kg * 100 : kg <= 20 ? 1000 + (kg - 10) * 50 : 1500 + (kg - 20) * 20; return { day: Math.round(ml), hr: Math.round(ml / 24) }; }
  const statusChip = s => `<span class="chip s-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
  const noAllergy = a => !String(a || '').trim() || /^(nkda|nka|none|no known)/i.test(String(a).trim());

  // ---------------------------------------------------------------------------
  // Boot and routing
  // ---------------------------------------------------------------------------
  async function boot() {
    try {
      S.meta = await api('GET', '/api/meta');
      await refreshMe();
    } catch (e) {
      $('#root').innerHTML = `<div class="auth gut"><div class="panel"><h1>WardBook</h1><div class="error">Cannot reach the server. Check the network and reload.</div></div></div>`;
      return;
    }
    route();
  }
  async function refreshMe() {
    S.me = await api('GET', '/api/auth/me');
  }

  function defaultView() {
    if (!S.me?.perms) return 'account';
    if (S.me.perms.manageStaff && !S.me.perms.seePatients) return 'staff';
    const d = visibleDepts();
    return d.length ? 'dept-' + d[0] : 'tasks';
  }
  function visibleDepts() {
    const cur = S.me?.current; if (!cur) return [];
    if (!S.me.perms.seePatients) return [];
    if (cur.role === 'student') return ['MINE'];
    if (cur.role === 'auditor' || (cur.departments || []).includes('ALL')) return Object.keys(S.meta.departments);
    return (cur.departments || []).filter(d => S.meta.departments[d]);
  }
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    S.view = h || defaultView();
    if (S.me?.stage === 'ready') loadView();
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  function go(view) { if (location.hash.slice(1) === view) route(); else location.hash = view; }

  async function loadView() {
    const v = S.view;
    try {
      if (perms().seePatients && (!S.listLoaded || v.startsWith('dept-'))) await loadList();
      if (v.startsWith('dept-') && S.showDc) S.discharged = await api('GET', '/api/patients?status=discharged');
      if (v.startsWith('p-')) { S.file = null; render(); S.file = await api('GET', '/api/patients/' + v.slice(2)); }
      if (v === 'tasks') S.tasks = await api('GET', '/api/tasks');
      if (v === 'staff') S.staff = await api('GET', '/api/admin/staff');
      if (v === 'audit') S.audit = await api('GET', '/api/audit?limit=300' + (S.auditPatient ? '&patient=' + S.auditPatient : ''));
    } catch (e) {
      if (e.status === 404 && v.startsWith('p-')) S.file = { missing: true, message: e.message };
      else fail(e);
    }
    if (S.view === v) render();
  }
  async function loadList() { S.list = await api('GET', '/api/patients'); S.listLoaded = true; }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function render() {
    const stage = S.me?.stage || 'signed_out';
    if (stage !== 'ready') { renderAuth(stage); return; }
    if (!$('#shell')) $('#root').innerHTML = `<div id="shell"><header class="top gut"><div class="wrap" id="hdr"></div></header><main class="gut"><div class="wrap" id="main"></div></main></div>`;
    renderHeader();
    keepInputs(() => { $('#main').innerHTML = renderMain(); });
  }

  // Keeps what someone is typing when the page refreshes underneath them.
  function keepInputs(fn) {
    const saved = {};
    document.querySelectorAll('#main [data-keep]').forEach(el => { saved[el.dataset.keep] = el.value; });
    const ae = document.activeElement, aid = ae?.dataset?.keep;
    fn();
    document.querySelectorAll('#main [data-keep]').forEach(el => { if (saved[el.dataset.keep] != null) el.value = saved[el.dataset.keep]; });
    if (aid) document.querySelector(`#main [data-keep="${CSS.escape(aid)}"]`)?.focus();
  }

  function renderAuth(stage) {
    const notice = S.notice ? `<div class="notice info">${esc(S.notice)}</div>` : '';
    const brand = `<div class="brand"><div class="mark">W</div><div><h1>WardBook</h1><div class="muted">Ward rounds, notes and handover</div></div></div>`;
    let body = '';
    if (stage === 'signed_out') {
      body = `<form id="f-login" class="panel" autocomplete="on">${brand}${notice}
        <label class="f"><span class="lbl">Work email</span><input id="email" name="email" type="email" autocomplete="username" required></label>
        <label class="f"><span class="lbl">Password</span><input id="password" name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" id="err" hidden></div>
        <button class="btn primary">Sign in</button>
        <p class="muted" style="font-size:13px;margin:0">Forgot your password or lost your phone? Ask your hospital's WardBook admin to reset it.</p></form>`;
    } else if (stage === 'change_password') {
      body = `<form id="f-pw" class="panel">${brand}<h2>Choose your own password</h2>
        <p class="muted" style="margin:0">You signed in with a temporary password. Pick one only you know: at least 10 characters. A short sentence works well.</p>
        <label class="f"><span class="lbl">Temporary password</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="f"><span class="lbl">New password</span><input name="next" type="password" autocomplete="new-password" minlength="10" required></label>
        <label class="f"><span class="lbl">New password again</span><input name="again" type="password" autocomplete="new-password" minlength="10" required></label>
        <div class="error" id="err" hidden></div><button class="btn primary">Save password</button>
        <button type="button" class="btn ghost" data-act="logout">Sign out</button></form>`;
    } else if (stage === 'setup_two_step') {
      if (!S.setup) { body = `<div class="panel">${brand}<p class="muted">Preparing two-step sign-in…</p></div>`; startSetup(); }
      else body = `<form id="f-code" class="panel">${brand}<h2>Set up two-step sign-in</h2>
        <p class="muted" style="margin:0">Each sign-in needs your password and a 6-digit code from your phone. Install an authenticator app (Google Authenticator, Microsoft Authenticator or similar), then scan this code.</p>
        <div class="qr">${S.setup.qrSvg}</div>
        <details><summary class="muted">Can't scan? Enter this key instead</summary><div class="secret">${esc(S.setup.secret)}</div></details>
        <label class="f"><span class="lbl">6-digit code from the app</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required></label>
        <div class="error" id="err" hidden></div><button class="btn primary">Confirm</button>
        <button type="button" class="btn ghost" data-act="logout">Sign out</button></form>`;
    } else if (stage === 'two_step') {
      body = `<form id="f-code" class="panel">${brand}<h2>Enter your code</h2>
        <p class="muted" style="margin:0">Open your authenticator app and type the 6-digit code for WardBook.</p>
        <label class="f"><span class="lbl">6-digit code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required></label>
        <div class="error" id="err" hidden></div><button class="btn primary">Continue</button>
        <button type="button" class="btn ghost" data-act="logout">Use a different account</button></form>`;
    } else if (stage === 'choose_hospital') {
      const hs = S.me?.hospitals || [];
      body = `<div class="panel">${brand}<h2>Choose a hospital</h2>
        ${hs.length ? `<div class="hosp-choice">${hs.map(h => `<button data-hosp="${esc(h.id)}"><b>${esc(h.name)}</b><br><span class="muted">${esc(h.roleLabel)}</span></button>`).join('')}</div>`
          : `<p>Your account is not active in any hospital right now. Ask your hospital's WardBook admin to add you.</p>`}
        <button class="btn ghost" data-act="logout">Sign out</button></div>`;
    }
    $('#root').innerHTML = `<div class="auth gut">${body}</div>`;
    const first = $('#root input'); if (first) first.focus();
  }

  async function startSetup() {
    if (S.setupPending) return;
    S.setupPending = true;
    try { S.setup = await api('POST', '/api/auth/two-step/setup'); render(); }
    catch (e) { if (e.status !== 401) { S.notice = e.message; await refreshMe(); render(); } }
    finally { S.setupPending = false; }
  }

  function renderHeader() {
    const cur = S.me.current, p = perms();
    const counts = {};
    for (const x of S.list) counts[x.department] = (counts[x.department] || 0) + 1;
    const crit = d => S.list.filter(x => x.department === d && x.status === 'critical').length;
    const tabs = visibleDepts().map(d => {
      const view = 'dept-' + d, curTab = S.view === view || (S.view.startsWith('p-') && S.file?.patient?.department === d);
      const label = d === 'MINE' ? 'My patients' : d === 'IM' ? 'IM' : d === 'PEDS' ? 'Pediatrics' : d === 'SURGERY' ? 'Surgery' : d;
      const n = d === 'MINE' ? S.list.length : counts[d] || 0;
      return `<a class="tab" href="#${view}" style="--tc:var(--${d === 'MINE' ? 'accent' : d})" aria-current="${curTab ? 'page' : 'false'}"><span class="dot"></span>${esc(label)}<span class="n">${n}</span>${crit(d) ? `<span style="color:var(--crit);font-size:12px" title="critical">●${crit(d)}</span>` : ''}</a>`;
    });
    if (p.seePatients) tabs.push(`<a class="tab" href="#tasks" aria-current="${S.view === 'tasks' ? 'page' : 'false'}">Tasks</a>`);
    if (p.manageStaff) tabs.push(`<a class="tab" href="#staff" aria-current="${S.view === 'staff' ? 'page' : 'false'}">Staff</a>`);
    if (p.viewAudit) tabs.push(`<a class="tab" href="#audit" aria-current="${S.view === 'audit' ? 'page' : 'false'}">Audit log</a>`);
    const multi = (S.me.hospitals || []).length > 1;
    $('#hdr').innerHTML = `<div class="bar">
      <div class="brand-line"><div class="mark">W</div><div style="min-width:0"><h1>WardBook</h1><div class="hosp" title="${esc(cur.name)}">${esc(cur.name)}</div></div><span class="rolechip">${esc(cur.roleLabel)}</span></div>
      ${p.seePatients ? `<input class="search" id="q" type="search" placeholder="Search name, bed, number, diagnosis" aria-label="Search patients" value="${esc(S.q)}">` : ''}
      ${p.admit ? `<button class="btn primary" data-act="admit">+ Admit</button>` : ''}
      <div class="menu"><button class="btn" data-act="menu" aria-haspopup="true" aria-expanded="${!!S.menuOpen}">${esc(initials(S.me.user.fullName))} ▾</button>
        ${S.menuOpen ? `<div class="menu-pop" role="menu">
          <div class="who"><b>${esc(S.me.user.fullName)}</b><br><span class="muted">${esc(S.me.user.email)}</span></div>
          ${p.seePatients && !p.deidentified ? `<button data-act="deid">${S.deid ? 'Show full names' : 'Hide names (teaching / screen sharing)'}</button>` : ''}
          ${multi ? `<button data-act="switch">Switch hospital</button>` : ''}
          <a href="#account">Account and password</a>
          <button data-act="logout">Sign out</button></div>` : ''}
      </div></div>
      <nav class="tabs" aria-label="Sections">${tabs.join('')}</nav>`;
  }

  function renderMain() {
    const v = S.view;
    if (v.startsWith('dept-')) return viewDept(v.slice(5));
    if (v.startsWith('p-')) return viewFile();
    if (v === 'tasks') return viewTasks();
    if (v === 'staff') return viewStaff();
    if (v === 'audit') return viewAudit();
    if (v === 'account') return viewAccount();
    return `<div class="empty"><p>Page not found.</p><a class="btn" href="#">Go to start</a></div>`;
  }

  // ---------------------------------------------------------------------------
  // Department view
  // ---------------------------------------------------------------------------
  function matches(p) {
    if (!S.q) return true;
    const q = S.q.toLowerCase();
    return [p.name, p.bed, p.hospital_number, p.dx, p.complaint, p.ward].some(v => String(v || '').toLowerCase().includes(q));
  }
  function viewDept(d) {
    if (!S.listLoaded) return `<p class="muted">Loading patients…</p>`;
    const mine = d === 'MINE';
    const all = S.showDc ? S.discharged : S.list;
    const list = all.filter(p => (mine || p.department === d) && matches(p));
    const act = S.list.filter(p => mine || p.department === d);
    const canAdmit = perms().admit && !mine && (S.me.current.departments.includes(d) || S.me.current.departments.includes('ALL'));
    let h = `<div class="head" style="--tc:var(--${mine ? 'accent' : d})"><div><div class="lbl" style="color:var(--tc)">${mine ? 'Assigned to you' : 'Department'}</div><h2>${esc(mine ? 'My patients' : deptName(d))}</h2></div>
      <div class="acts"><button class="btn sm" data-act="toggleDc">${S.showDc ? 'Show current patients' : 'Show discharged'}</button>${canAdmit ? `<button class="btn sm primary" data-act="admit" data-dept="${d}">+ Admit to ${esc(deptName(d))}</button>` : ''}</div></div>`;
    if (!S.showDc && act.length) {
      const tasks = act.reduce((n, p) => n + (p.open_tasks || 0), 0);
      const noNote = act.filter(p => iso(p.last_note) !== today()).length;
      h += `<div class="stats"><span><b>${act.length}</b>patients</span><span style="color:var(--crit)"><b>${act.filter(p => p.status === 'critical').length}</b>critical</span><span style="color:var(--warn)"><b>${act.filter(p => p.status === 'watch').length}</b>on watch</span><span><b>${tasks}</b>open tasks</span><span class="muted"><b>${noNote}</b>without a note today</span></div>`;
    }
    if (!list.length) {
      if (S.q) return h + `<div class="empty"><p>No patient matches “${esc(S.q)}”.</p></div>`;
      if (S.showDc) return h + `<div class="empty"><p>No discharged patients here.</p></div>`;
      return h + `<div class="empty"><h3>No patients here yet</h3><p>${canAdmit ? 'Admit a patient to start their file. Everyone on this team will see it.' : mine ? 'Patients you are assigned to will appear here.' : 'When the team admits patients they will appear here.'}</p>${canAdmit ? `<button class="btn primary" data-act="admit" data-dept="${d}">+ Admit patient</button>` : ''}</div>`;
    }
    return h + `<div class="grid">${list.map(pcard).join('')}</div>`;
  }
  function pcard(p) {
    const sc = p.status === 'discharged' ? 'var(--line)' : p.status === 'critical' ? 'var(--crit)' : p.status === 'watch' ? 'var(--warn)' : 'var(--ok)';
    const hd = hospDay(p), lv = p.last_vitals;
    const vf = lv ? worst(flag('sbp', lv.sbp, p.department), flag('hr', lv.hr, p.department), flag('rr', lv.rr, p.department), flag('temp', lv.temp, p.department), flag('spo2', lv.spo2, p.department)) : '';
    const ga = p.department === 'OBGYN' && gaFromLmp(p.sp?.lmp);
    return `<a class="pcard" href="#p-${esc(p.id)}" style="--sc:${sc}">
      <div class="r1">${p.bed ? `<span class="bed">${esc(p.bed)}</span>` : ''}<span class="pname">${esc(showName(p))}</span><span style="margin-left:auto">${statusChip(p.status)}</span></div>
      <div class="meta"><span>${esc([p.age, p.sex].filter(Boolean).join(' · '))}</span>${hd ? `<span class="mono">Day ${hd}</span>` : ''}${ga ? `<span class="mono">${ga.w}+${ga.d} wks</span>` : ''}${p.ward ? `<span>${esc(p.ward)}</span>` : ''}</div>
      <div>${p.dx ? esc(firstLine(p.dx)) : `<span class="muted">${esc(firstLine(p.complaint) || 'No diagnosis yet')}</span>`}</div>
      <div class="meta">${p.open_tasks ? `<span style="color:var(--accent)">${p.open_tasks} task${p.open_tasks > 1 ? 's' : ''} open</span>` : '<span>No open tasks</span>'}<span>${p.last_note ? 'Last note ' + fmtDate(p.last_note) : 'No notes yet'}</span>${vf ? `<span style="color:var(--${vf});font-weight:600">${vf === 'crit' ? 'Abnormal vitals' : 'Vitals to watch'}</span>` : ''}${!noAllergy(p.allergies) ? `<span style="color:var(--crit);font-weight:600">Allergy</span>` : ''}</div></a>`;
  }

  // ---------------------------------------------------------------------------
  // Patient file
  // ---------------------------------------------------------------------------
  const card = (title, body, { w = '', edit } = {}) => `<div class="card ${w}"><div class="ch"><h3>${title}</h3>${edit && perms().editClinical ? `<button class="btn ghost sm" data-edit="${edit}">Edit</button>` : ''}</div>${body}</div>`;
  const txt = (v, empty = 'Not documented') => (String(v || '').trim() ? `<div class="txt">${esc(v)}</div>` : `<div class="none">${empty}</div>`);
  const kv = pairs => { const f = pairs.filter(([, v]) => String(v ?? '').trim()); return f.length ? `<dl class="kv">${f.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : `<div class="none">Not documented</div>`; };
  const nameOf = id => S.file?.people?.[id]?.name || 'Former staff';

  function viewFile() {
    const F = S.file;
    if (!F) return `<p class="muted">Opening patient file…</p>`;
    if (F.missing) return `<div class="empty"><p>${esc(F.message)}</p><a class="btn" href="#${defaultView()}">Back to patients</a></div>`;
    const p = F.patient, c = p.clinical || {}, sp = c.sp || {}, P = perms();
    const hd = hospDay(p), v0 = F.vitals[0];
    const pod = p.department === 'SURGERY' && sp.opDate ? daysBetween(sp.opDate, today()) : null;
    const ga = p.department === 'OBGYN' && gaFromLmp(sp.lmp);
    const weight = F.vitals.find(v => v.weight_kg)?.weight_kg;
    const back = visibleDepts().includes('MINE') ? 'dept-MINE' : 'dept-' + p.department;
    const one = [p.age, p.sex].filter(Boolean).join(' ') + (c.pmh ? ` with ${firstLine(c.pmh)}` : '') + (c.complaint ? `, presenting with ${firstLine(c.complaint)}` : '') + (hd ? `. Hospital day ${hd}` : '') + (c.dx ? `. Working diagnosis: ${firstLine(c.dx)}.` : '');

    let h = `<a class="btn ghost no-print" href="#${back}" style="margin-bottom:10px">← ${esc(visibleDepts().includes('MINE') ? 'My patients' : deptName(p.department))}</a>
    <div class="banner" style="--tc:var(--${p.department})">
      <div class="row">${p.bed ? `<span class="bed">Bed ${esc(p.bed)}</span>` : ''}<h2>${esc(showName(p))}</h2>${statusChip(p.status)}
        <div class="row no-print" style="margin-left:auto">
          ${P.editClinical && p.status !== 'discharged' ? `<select id="statusSel" class="btn sm" aria-label="Status" style="width:auto">${Object.entries(STATUS).filter(([k]) => k !== 'discharged').map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
          ${P.editClinical ? `<button class="btn sm" data-edit="id">Edit file</button>` : ''}
          <button class="btn sm" data-act="print">Print</button>
        </div></div>
      <div class="idrow">
        ${p.age ? `<span><b>Age</b> ${esc(p.age)}</span>` : ''}${p.sex ? `<span><b>Sex</b> ${esc(p.sex)}</span>` : ''}
        ${showNo(p) ? `<span><b>Hosp. no.</b> <span class="mono">${esc(showNo(p))}</span></span>` : ''}
        <span><b>Dept</b> ${esc(deptName(p.department))}${p.ward ? ' · ' + esc(p.ward) : ''}</span>
        ${p.admitted_at ? `<span><b>Admitted</b> ${fmtDate(p.admitted_at)}${hd ? ` <span class="mono">(day ${hd})</span>` : ''}</span>` : ''}
        ${pod !== null && pod >= 0 ? `<span><b>Post-op day</b> <span class="mono">${pod}</span></span>` : ''}
        ${ga ? `<span><b>GA</b> <span class="mono">${ga.w}+${ga.d}</span></span>` : ''}
        ${weight ? `<span><b>Weight</b> <span class="mono">${esc(weight)} kg</span></span>` : ''}
        ${p.discharged_at ? `<span><b>Discharged</b> ${fmtDate(p.discharged_at)}</span>` : ''}
      </div>
      <div class="allergy ${noAllergy(p.allergies) ? 'none' : ''}">${!String(p.allergies || '').trim() ? 'Allergies not documented' : noAllergy(p.allergies) ? 'No known drug allergies' : 'Allergies: ' + esc(p.allergies)}</div>
      ${one.trim() ? `<div style="max-width:80ch">${esc(one.charAt(0).toUpperCase() + one.slice(1))}</div>` : ''}
    </div>`;

    // vitals
    const vitBody = v0 ? (() => {
      const items = [['BP', v0.sbp && v0.dbp ? `${v0.sbp}/${v0.dbp}` : '', worst(flag('sbp', v0.sbp, p.department), flag('dbp', v0.dbp, p.department)), 'mmHg'],
        ['HR', v0.hr, flag('hr', v0.hr, p.department), '/min'], ['RR', v0.rr, flag('rr', v0.rr, p.department), '/min'],
        ['Temp', v0.temp, flag('temp', v0.temp, p.department), '°C'], ['SpO₂', v0.spo2, flag('spo2', v0.spo2, p.department), '%'],
        ['GCS', v0.gcs, flag('gcs', v0.gcs, p.department), '/15'], ['Glucose', v0.glucose, '', ''], ['Urine', v0.urine, '', '']].filter(x => x[1] != null && x[1] !== '');
      return `<div class="vitals">${items.map(([l, v, f, u]) => `<div class="vt ${f}"><div class="lbl">${l}</div><div class="v">${esc(v)}</div><div class="muted" style="font-size:11px">${u}</div></div>`).join('')}</div>
        <div class="muted" style="font-size:12.5px">${fmtTime(v0.recorded_at)} by ${esc(nameOf(v0.recorded_by))}. ${p.department === 'PEDS' ? 'Paediatric ranges depend on age, so values are not flagged.' : 'Flags use adult ranges.'}</div>
        ${F.vitals.length > 1 ? `<details><summary class="muted">Trend (${F.vitals.length} sets)</summary><div class="scroll-x"><table class="t"><thead><tr><th>Time</th><th>BP</th><th>HR</th><th>RR</th><th>T</th><th>SpO₂</th><th>GCS</th></tr></thead><tbody>
          ${F.vitals.slice(0, 20).map(v => `<tr><td>${fmtTime(v.recorded_at)}</td><td class="n ${worst(flag('sbp', v.sbp, p.department), flag('dbp', v.dbp, p.department))}">${v.sbp ? `${v.sbp}/${v.dbp ?? ''}` : ''}</td><td class="n ${flag('hr', v.hr, p.department)}">${v.hr ?? ''}</td><td class="n ${flag('rr', v.rr, p.department)}">${v.rr ?? ''}</td><td class="n ${flag('temp', v.temp, p.department)}">${v.temp ?? ''}</td><td class="n ${flag('spo2', v.spo2, p.department)}">${v.spo2 ?? ''}</td><td class="n ${flag('gcs', v.gcs, p.department)}">${v.gcs ?? ''}</td></tr>`).join('')}
          </tbody></table></div></details>` : ''}`;
    })() : `<div class="none">No vital signs recorded yet</div>`;

    const labs = String(c.labs || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
    const probs = String(c.problems || '').split('\n').map(s => s.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);

    let spec;
    if (p.department === 'OBGYN') spec = card('Obstetric', kv([['G / P', sp.gravida || sp.para ? `G${sp.gravida || '?'} P${sp.para || '?'}` : ''], ['LMP', sp.lmp ? fmtDate(sp.lmp) : ''], ['GA today', ga ? `${ga.w} weeks + ${ga.d} days` : ''], ['EDD', sp.lmp ? fmtDate(edd(sp.lmp)) : ''], ['Antenatal', sp.anc], ['Fetal', sp.fetal]]), { edit: 'spec' });
    else if (p.department === 'PEDS') { const mf = maintFluid(weight); spec = card('Paediatric', kv([['Birth history', sp.birthHx], ['Immunisation', sp.immun], ['Feeding / growth', sp.feeding], ['Development', sp.dev]]) + (mf ? `<div class="calc">Maintenance fluid (Holliday–Segar, ${esc(weight)} kg): <b class="mono">${mf.day} mL/day ≈ ${mf.hr} mL/h</b></div>` : `<div class="calc">Record a weight with the vitals to see maintenance fluids.</div>`), { edit: 'spec' }); }
    else if (p.department === 'SURGERY') spec = card('Operative', kv([['Procedure', sp.procedure], ['Date', sp.opDate ? fmtDate(sp.opDate) + (pod !== null && pod >= 0 ? ` (post-op day ${pod})` : '') : ''], ['Findings', sp.opFindings], ['Drains / lines', sp.drains]]), { edit: 'spec' });
    else if (p.department === 'ER') spec = card('ER course', kv([['Triage', sp.triage], ['Arrived', sp.arrival], ['Given in ER', sp.erTx], ['Disposition', sp.dispo]]), { edit: 'spec' });
    else spec = card('Background', kv([['Surgical history', c.psh], ['Social', c.social], ['Family', c.family]]), { edit: 'hx' });

    const open = F.tasks.filter(t => !t.done).length;
    const team = F.assignments.map(a => `<div class="person"><span class="grow">${esc(nameOf(a.user_id))} <span class="muted">· ${esc(a.reason)}</span></span>${P.assign ? `<button class="btn ghost sm" data-unassign="${a.id}" aria-label="Remove">Remove</button>` : ''}</div>`).join('');

    h += `<div class="facts">
      ${card('Presenting complaint & history', (c.complaint ? `<div style="font-weight:600">${esc(c.complaint)}</div>` : '') + txt(c.hpi, c.complaint ? '' : 'Not documented'), { w: 'w2', edit: 'hx' })}
      ${card('Vital signs' + (P.recordVitals ? '' : ''), vitBody + (P.recordVitals && p.status !== 'discharged' ? `<div><button class="btn sm no-print" data-act="vitals">+ Record vitals</button></div>` : ''), { w: 'w2' })}
      ${card('Past history & medications', kv([['PMH', c.pmh], ['Medications', c.meds], ...(p.department === 'IM' ? [] : [['Surgical', c.psh], ['Social', c.social]])]), { edit: 'hx' })}
      ${card('Examination', txt(c.exam), { edit: 'exam' })}
      ${card('Investigations', (labs.length ? `<div class="labs">${labs.map(l => `<span class="lab">${esc(l)}</span>`).join('')}</div>` : `<div class="none">No results recorded</div>`) + (c.imaging ? `<div class="lbl">Imaging / other</div>${txt(c.imaging)}` : ''), { w: 'w2', edit: 'inv' })}
      ${card('Diagnosis', (c.dx ? `<div style="font-weight:600">${esc(c.dx)}</div>` : `<div class="none">No working diagnosis yet</div>`) + (c.ddx ? `<div class="lbl">Differentials</div>${txt(c.ddx)}` : ''), { edit: 'dx' })}
      ${card('Problem list', probs.length ? `<ol class="probs">${probs.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : `<div class="none">No problems listed</div>`, { edit: 'dx' })}
      ${spec}
      ${card('Care team', (team || `<div class="none">Department team only</div>`) + (P.assign ? `<div class="no-print"><button class="btn sm" data-act="assign">+ Add consultant or student</button></div>` : ''))}
      ${card('Management plan', txt(c.plan), { w: 'w2', edit: 'plan' })}
      ${card(`Tasks <span class="muted mono" style="font-weight:400;font-size:13px">${open} open</span>`,
        (F.tasks.length ? F.tasks.map(t => `<label class="todo ${t.done ? 'done' : ''}"><input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''} ${P.manageTasks ? '' : 'disabled'}><span>${esc(t.text)}${t.done && t.done_by ? ` <span class="muted" style="font-size:12px">· ${esc(nameOf(t.done_by))}</span>` : ''}</span></label>`).join('') : `<div class="none">Nothing pending</div>`) +
        (P.manageTasks && p.status !== 'discharged' ? `<form class="row no-print" data-form="task"><input class="grow" data-keep="task-${p.id}" name="t" placeholder="e.g. Chase blood culture" aria-label="New task"><button class="btn sm">Add</button></form>` : ''), { w: 'w2' })}
    </div>`;

    // notes
    const addenda = {};
    F.notes.filter(n => n.kind === 'addendum').forEach(n => { (addenda[n.addendum_of] ||= []).push(n); });
    const mainNotes = F.notes.filter(n => n.kind !== 'addendum');
    const last = mainNotes[0];
    h += `<section class="block"><div class="h"><h3>Daily notes</h3><span class="muted" style="font-size:13px">${mainNotes.length} note${mainNotes.length === 1 ? '' : 's'}</span></div>`;
    if (P.writeNotes && p.status !== 'discharged') {
      h += `<form class="panel-form no-print" data-form="note">
        <div class="row"><label class="lbl" for="noteDate">Date</label><input id="noteDate" type="date" data-keep="nd-${p.id}" value="${today()}" style="width:auto">
          ${last?.p ? `<button type="button" class="btn ghost sm" data-act="carry">Copy last plan</button>` : ''}
          <span class="muted" style="font-size:13px">${S.me.current.role === 'nurse' ? 'Nursing note' : S.me.current.role === 'student' ? 'Student note (marked as such)' : S.me.perms.sign ? 'Your notes count as signed when you sign them' : 'An attending or resident signs your note'}</span></div>
        <div class="soap">
          <label class="f"><span class="lbl">S · Subjective</span><textarea data-keep="ns-${p.id}" name="s" placeholder="Symptoms, overnight events"></textarea></label>
          <label class="f"><span class="lbl">O · Objective</span><textarea data-keep="no-${p.id}" name="o" placeholder="Exam, vitals, new results"></textarea></label>
          <label class="f"><span class="lbl">A · Assessment</span><textarea data-keep="na-${p.id}" name="a" placeholder="Better, same or worse, and why"></textarea></label>
          <label class="f"><span class="lbl">P · Plan</span><textarea data-keep="np-${p.id}" name="p" placeholder="Changes to management"></textarea></label>
        </div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary">Save note</button></div></form>`;
    }
    h += `<div class="timeline">${mainNotes.map(n => {
      const d = p.admitted_at ? daysBetween(p.admitted_at, n.note_date) + 1 : null;
      const own = n.author_id === S.me.user.id;
      const kindLabel = n.kind === 'soap' ? '' : `<span class="badge kind">${n.kind === 'nursing' ? 'Nursing' : 'Student'}</span>`;
      return `<div class="entry"><div class="when"><div class="d">${fmtDate(n.note_date)}</div>${d && d > 0 ? `<div class="hd">Day ${d}</div>` : ''}</div>
        <div class="body ${n.signed_at ? '' : 'unsigned'}">
          ${[['S', n.s], ['O', n.o], ['A', n.a], ['P', n.p]].filter(([, x]) => String(x || '').trim()).map(([k, x]) => `<div class="sl"><b>${k}</b><div>${esc(x)}</div></div>`).join('')}
          ${(addenda[n.id] || []).reverse().map(a => `<div class="addendum"><b>Addendum</b> · ${esc(nameOf(a.author_id))}, ${fmtTime(a.created_at)}<br>${esc(a.s)}</div>`).join('')}
          <div class="foot"><span class="sp">${esc(nameOf(n.author_id))} · ${fmtTime(n.created_at)} ${kindLabel} ${n.signed_at ? `<span class="badge signed">Signed by ${esc(nameOf(n.signed_by))}</span>` : `<span class="badge pending">Not signed</span>`}</span>
            <span class="no-print">${!n.signed_at && own ? `<button class="btn ghost sm" data-note-edit="${n.id}">Edit</button>` : ''}${!n.signed_at && P.sign ? `<button class="btn ghost sm" data-note-sign="${n.id}">Sign</button>` : ''}${P.writeNotes ? `<button class="btn ghost sm" data-note-add="${n.id}">Addendum</button>` : ''}</span></div>
        </div></div>`;
    }).join('') || `<p class="muted">No notes yet.</p>`}</div></section>`;

    // summaries
    const cur = S.me.current;
    const aiOn = cur.aiEnabled && cur.aiConfigured;
    const sums = F.summaries;
    h += `<section class="block no-print-ok"><div class="h"><h3>Summary for presentation or handover</h3></div>
      <div class="panel-form">
        ${P.summarize ? `<div class="seg" role="group" aria-label="Summary type">${Object.entries(S.meta.summaryKinds).map(([k, l]) => `<button aria-pressed="${S.sumKind === k}" data-kind="${k}">${esc(l)}</button>`).join('')}</div>
        <div class="row"><button class="btn primary" data-act="summarize" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Writing…' : aiOn ? 'Write with AI' : 'Build summary'}</button>${aiOn ? `<button class="btn" data-act="summarize-template" ${S.busy ? 'disabled' : ''}>Template only</button>` : ''}
          <span class="muted" style="font-size:13px">${aiOn ? 'Names, hospital numbers and dates are removed before the record is sent to the AI service. Check every line before you use it.' : `Built on this server from the file and recent notes. ${cur.aiEnabled ? 'AI summaries are allowed here, but this server has no AI key set.' : 'AI summaries are off for this hospital.'}`}</span></div>` : ''}
        ${sums.length ? sums.slice(0, 3).map((s, i) => `<div style="display:grid;gap:8px;${i ? 'opacity:.85' : ''}">
          <div class="row"><b>${esc(S.meta.summaryKinds[s.kind] || s.kind)}</b><span class="badge kind">${s.source === 'ai' ? 'AI draft' : 'Template'}</span>${s.accepted_at ? `<span class="badge signed">Accepted by ${esc(nameOf(s.accepted_by))}</span>` : ''}<span class="muted" style="font-size:12.5px">${esc(nameOf(s.created_by))}, ${fmtTime(s.created_at)}</span>
            <span class="row no-print" style="margin-left:auto"><button class="btn ghost sm" data-copy="${s.id}">Copy</button>${!s.accepted_at && P.acceptSummary ? `<button class="btn ghost sm" data-accept="${s.id}">Accept into record</button>` : ''}</span></div>
          ${i === 0 ? `<div class="sumtext" id="sum-${s.id}">${esc(s.text)}</div>` : `<details><summary class="muted">Show</summary><div class="sumtext" id="sum-${s.id}">${esc(s.text)}</div></details>`}</div>`).join('') : `<div class="none">No summaries yet.</div>`}
      </div></section>`;

    // history and disposition
    if (F.transfers.length) {
      h += `<section class="block"><div class="h"><h3>Transfers</h3></div><div class="scroll-x"><table class="t"><thead><tr><th>When</th><th>From</th><th>To</th><th>By</th><th>Note</th></tr></thead><tbody>
        ${F.transfers.map(t => `<tr><td>${fmtTime(t.at)}</td><td>${esc(deptName(t.from_dept))}</td><td>${esc(deptName(t.to_dept))}</td><td>${esc(nameOf(t.by_user))}</td><td>${esc(t.note || '')}</td></tr>`).join('')}</tbody></table></div></section>`;
    }
    if (P.transfer || P.discharge || P.viewAudit) {
      h += `<section class="block no-print"><div class="h"><h3>Disposition</h3></div><div class="row">
        ${P.transfer && p.status !== 'discharged' ? `<button class="btn" data-act="transfer">Transfer to another department</button>` : ''}
        ${P.discharge && p.status !== 'discharged' ? `<button class="btn" data-act="discharge">Discharge</button>` : ''}
        ${P.admit && p.status === 'discharged' ? `<button class="btn" data-act="readmit">Readmit</button>` : ''}
        ${!P.discharge && P.transfer && p.status !== 'discharged' ? `<span class="muted" style="font-size:13px">A resident or attending discharges patients.</span>` : ''}
        ${P.viewAudit ? `<button class="btn ghost" data-act="patient-audit">Who opened or changed this file</button>` : ''}
      </div></section>`;
    }
    return h;
  }

  // ---------------------------------------------------------------------------
  // Other views
  // ---------------------------------------------------------------------------
  function viewTasks() {
    if (!S.tasks) return `<p class="muted">Loading tasks…</p>`;
    let h = `<div class="head"><div><div class="lbl">Across your patients</div><h2>Open tasks</h2></div></div>`;
    if (!S.tasks.length) return h + `<div class="empty"><p>No open tasks. Tasks added in a patient's file are collected here so you can work through them in one pass.</p></div>`;
    const groups = {};
    S.tasks.forEach(t => (groups[t.department] ||= []).push(t));
    for (const [d, rows] of Object.entries(groups)) {
      h += `<section class="block"><div class="h"><h3 style="font-size:16px">${esc(deptName(d))}</h3></div>${rows.map(t => `
        <label class="todo card" style="flex-direction:row;padding:10px 14px;margin-bottom:6px"><input type="checkbox" data-task-list="${t.id}" ${perms().manageTasks ? '' : 'disabled'}><span class="grow">${esc(t.text)}</span>
        <a class="muted" style="font-size:13px;white-space:nowrap" href="#p-${t.patient_id}">${t.bed ? 'Bed ' + esc(t.bed) + ' · ' : ''}${esc(S.deid ? initials(t.name) : t.name)}</a></label>`).join('')}</section>`;
    }
    return h;
  }

  function viewStaff() {
    if (!S.staff) return `<p class="muted">Loading staff…</p>`;
    const cur = S.me.current;
    const roles = S.meta.roles;
    let h = `<div class="head"><div><div class="lbl">${esc(cur.name)}</div><h2>Staff and access</h2></div><div class="acts"><button class="btn primary" data-act="add-staff">+ Add staff</button></div></div>
      <div class="panel-form" style="margin-bottom:18px"><div class="row"><b class="grow">AI summaries</b>${statusChip(cur.aiEnabled ? 'stable' : 'discharged').replace(/>(Stable|Discharged)</, `>${cur.aiEnabled ? 'On' : 'Off'}<`)}
        <button class="btn sm" data-act="toggle-ai">${cur.aiEnabled ? 'Turn off' : 'Turn on'}</button></div>
        <p class="muted" style="margin:0;font-size:13.5px">When on, clinicians can send a de-identified copy of a patient record to the AI service to draft a summary. Turn it on only after your data protection officer has approved the provider and where it processes data. ${cur.aiConfigured ? '' : '<b>The server has no AI key set, so summaries stay template-only either way.</b>'}</p></div>
      <div class="scroll-x"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Departments</th><th>Access</th><th>Two-step</th><th>Last active</th><th></th></tr></thead><tbody>
      ${S.staff.map(s => `<tr style="${s.active ? '' : 'opacity:.6'}"><td><b>${esc(s.full_name)}</b><br><span class="muted">${esc(s.email)}</span></td>
        <td>${esc(roles[s.role] || s.role)}</td><td>${esc((s.departments || []).map(d => d === 'ALL' ? 'All' : d).join(', ') || '—')}</td>
        <td>${s.active ? (s.valid_until ? 'Until ' + fmtDate(s.valid_until) : 'Active') : 'Removed'}${s.account_active ? '' : ' · account disabled'}</td>
        <td>${s.totp_enabled ? 'Set up' : '<span class="muted">Not yet</span>'}</td><td>${s.last_seen ? fmtTime(s.last_seen) : '—'}</td>
        <td>${s.user_id === S.me.user.id ? '<span class="muted">You</span>' : `<button class="btn sm" data-staff="${s.membership_id}">Manage</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
    return h;
  }

  function viewAudit() {
    if (!S.audit) return `<p class="muted">Loading audit log…</p>`;
    const ppl = S.audit.people || {};
    const label = r => {
      const what = { patients: 'patient file', vitals: 'vital signs', notes: 'note', tasks: 'task', transfers: 'transfer', summaries: 'summary', assignments: 'care team', memberships: 'staff access', hospitals: 'hospital settings', account: 'account' }[r.entity] || r.entity;
      const verb = { view: 'Opened', insert: 'Added', update: 'Changed', delete: 'Removed', reset: 'Reset' }[r.action] || r.action;
      return `${verb} ${what}`;
    };
    let h = `<div class="head"><div><div class="lbl">Append-only: nobody can edit or delete entries</div><h2>Audit log</h2></div>
      ${S.auditPatient ? `<div class="acts"><button class="btn sm" data-act="audit-all">Show all activity</button></div>` : ''}</div>
      ${S.auditPatient ? `<div class="notice info">Showing activity for one patient file.</div>` : ''}
      <div class="scroll-x"><table class="t"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>Record</th></tr></thead><tbody>
      ${S.audit.rows.map(r => `<tr><td class="n">${fmtTime(r.at)}</td><td>${esc(r.actor_id ? ppl[r.actor_id]?.name || 'Former staff' : 'System')}</td><td>${esc(label(r))}</td>
        <td class="muted">${esc(r.detail?.changed ? 'Fields: ' + r.detail.changed.join(', ') : '')}</td>
        <td>${r.entity === 'patients' && r.entity_id ? `<a href="#p-${r.entity_id}">Open</a>` : r.detail?.patient_id ? `<a href="#p-${esc(r.detail.patient_id)}">Patient</a>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    return h;
  }

  function viewAccount() {
    return `<div class="head"><div><div class="lbl">${esc(S.me.user.email)}</div><h2>Account</h2></div></div>
      <form class="panel-form" id="f-pw2" style="max-width:480px">
        <h3>Change password</h3>
        <label class="f"><span class="lbl">Current password</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="f"><span class="lbl">New password (10+ characters)</span><input name="next" type="password" autocomplete="new-password" minlength="10" required></label>
        <label class="f"><span class="lbl">New password again</span><input name="again" type="password" autocomplete="new-password" minlength="10" required></label>
        <div class="row"><button class="btn primary">Save new password</button></div>
        <p class="muted" style="margin:0;font-size:13px">Saving signs you out on your other devices. Lost your phone with the authenticator app? Ask your hospital admin to reset two-step sign-in.</p>
      </form>
      <p class="muted" style="margin-top:16px;font-size:13px">For safety, WardBook signs you out after ${S.me.idleMinutes} minutes without activity.</p>`;
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------
  function openModal(title, body, footer, { narrow = false } = {}) {
    $('#modal').innerHTML = `<div class="scrim" id="scrim"><div class="modal ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <div class="mh"><h2 id="mTitle">${title}</h2><button class="btn ghost" data-close aria-label="Close">✕</button></div>
      <div class="mb">${body}</div><div class="mf"><span class="err" id="mErr"></span>${footer}</div></div></div>`;
    setTimeout(() => $('#modal input:not([type=hidden]), #modal textarea, #modal select')?.focus(), 20);
  }
  function closeModal() { const m = $('#modal'); if (m) m.innerHTML = ''; }
  const modalError = msg => { const e = $('#mErr'); if (e) e.textContent = msg; };
  const fld = (name, label, val, { type = 'text', cls = '', ph = '', opts, req = false } = {}) => {
    const id = 'f_' + name.replace(/\./g, '_');
    if (type === 'textarea') return `<label class="f ${cls}" for="${id}"><span class="lbl">${label}</span><textarea id="${id}" name="${name}" placeholder="${esc(ph)}">${esc(val)}</textarea></label>`;
    if (type === 'select') return `<label class="f ${cls}" for="${id}"><span class="lbl">${label}</span><select id="${id}" name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(val ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    return `<label class="f ${cls}" for="${id}"><span class="lbl">${label}</span><input id="${id}" type="${type}" name="${name}" value="${esc(val)}" placeholder="${esc(ph)}" ${req ? 'required' : ''}></label>`;
  };
  function formData(sel) {
    const o = {};
    new FormData($(sel)).forEach((v, k) => {
      const parts = k.split('.');
      let t = o; while (parts.length > 1) { const pk = parts.shift(); t = t[pk] ||= {}; }
      t[parts[0]] = typeof v === 'string' ? v.trim() : v;
    });
    return o;
  }

  function specFields(dept, sp) {
    if (dept === 'OBGYN') return fld('clinical.sp.gravida', 'Gravida', sp.gravida) + fld('clinical.sp.para', 'Para', sp.para) + fld('clinical.sp.lmp', 'Last menstrual period', sp.lmp, { type: 'date' }) + '<span class="muted" style="align-self:end;font-size:13px;padding-bottom:10px">GA and EDD are calculated</span>' + fld('clinical.sp.anc', 'Antenatal care', sp.anc, { type: 'textarea', cls: 's2' }) + fld('clinical.sp.fetal', 'Fetal status', sp.fetal, { type: 'textarea', cls: 's2', ph: 'FHR, movements, presentation' });
    if (dept === 'PEDS') return fld('clinical.sp.birthHx', 'Birth history', sp.birthHx, { type: 'textarea', cls: 's2' }) + fld('clinical.sp.immun', 'Immunisation', sp.immun, { type: 'textarea', cls: 's2' }) + fld('clinical.sp.feeding', 'Feeding / growth', sp.feeding, { type: 'textarea', cls: 's2' }) + fld('clinical.sp.dev', 'Development', sp.dev, { type: 'textarea', cls: 's2' });
    if (dept === 'SURGERY') return fld('clinical.sp.procedure', 'Procedure', sp.procedure, { cls: 's2' }) + fld('clinical.sp.opDate', 'Date of surgery', sp.opDate, { type: 'date' }) + '<span></span>' + fld('clinical.sp.opFindings', 'Operative findings', sp.opFindings, { type: 'textarea', cls: 's2' }) + fld('clinical.sp.drains', 'Drains, lines, catheter', sp.drains, { type: 'textarea', cls: 's2' });
    if (dept === 'ER') return fld('clinical.sp.triage', 'Triage category', sp.triage) + fld('clinical.sp.arrival', 'Arrival time', sp.arrival) + fld('clinical.sp.erTx', 'Given in ER', sp.erTx, { type: 'textarea', cls: 's2' }) + fld('clinical.sp.dispo', 'Disposition', sp.dispo, { cls: 's4' });
    return `<p class="muted s4" style="margin:0">No extra fields for Internal Medicine.</p>`;
  }

  function openFileForm(p, section) {
    const isNew = !p;
    const myDepts = S.me.current.departments.includes('ALL') ? Object.keys(S.meta.departments) : S.me.current.departments;
    p = p || { department: section && S.meta.departments[section] ? section : myDepts[0], status: 'stable', admitted_at: today(), clinical: { sp: {} } };
    const c = p.clinical || {}, sp = c.sp || {};
    const deptOpts = Object.entries(S.meta.departments).filter(([k]) => myDepts.includes(k));
    openModal(isNew ? 'Admit patient' : 'Edit ' + esc(showName(p)), `<form id="pform">
      <fieldset id="sec-id"><legend>Patient</legend><div class="fg">
        ${fld('name', 'Name', p.name, { cls: 's2', req: true })}${fld('hospital_number', 'Hospital number', p.hospital_number)}${fld('bed', 'Bed', p.bed)}
        ${fld('age', 'Age', p.age, { ph: 'e.g. 54y or 3 months' })}${fld('sex', 'Sex', p.sex, { type: 'select', opts: [['', '—'], ['Female', 'Female'], ['Male', 'Male']] })}
        ${fld('admitted_at', 'Admission date', iso(p.admitted_at), { type: 'date' })}${fld('ward', 'Ward', p.ward)}
        ${isNew ? fld('department', 'Department', p.department, { type: 'select', opts: deptOpts }) : ''}
        ${fld('status', 'Status', p.status, { type: 'select', opts: Object.entries(STATUS).filter(([k]) => k !== 'discharged') })}
        ${fld('allergies', 'Allergies', p.allergies, { cls: isNew ? 's2' : 's4', ph: 'Drug and reaction, or "No known drug allergies"' })}
      </div></fieldset>
      <fieldset id="sec-hx"><legend>History</legend><div class="fg">
        ${fld('clinical.complaint', 'Presenting complaint', c.complaint, { cls: 's4' })}
        ${fld('clinical.hpi', 'History of presenting illness', c.hpi, { type: 'textarea', cls: 's4' })}
        ${fld('clinical.pmh', 'Past medical history', c.pmh, { type: 'textarea', cls: 's2' })}${fld('clinical.meds', 'Medications', c.meds, { type: 'textarea', cls: 's2' })}
        ${fld('clinical.psh', 'Surgical history', c.psh, { type: 'textarea', cls: 's2' })}${fld('clinical.social', 'Social history', c.social, { type: 'textarea', cls: 's2' })}
        ${fld('clinical.family', 'Family history', c.family, { type: 'textarea', cls: 's4' })}
      </div></fieldset>
      <fieldset id="sec-spec"><legend id="specLegend">${esc(deptName(p.department))} details</legend><div class="fg" id="specBox">${specFields(p.department, sp)}</div></fieldset>
      <fieldset id="sec-exam"><legend>Examination</legend><div class="fg">${fld('clinical.exam', 'Findings', c.exam, { type: 'textarea', cls: 's4' })}</div></fieldset>
      <fieldset id="sec-inv"><legend>Investigations</legend><div class="fg">
        ${fld('clinical.labs', 'Laboratory results (one per line, or separated by ;)', c.labs, { type: 'textarea', cls: 's4', ph: 'Hb 9.8 g/dL; WBC 14.2; Na 131' })}
        ${fld('clinical.imaging', 'Imaging, ECG and other tests', c.imaging, { type: 'textarea', cls: 's4' })}</div></fieldset>
      <fieldset id="sec-dx"><legend>Assessment</legend><div class="fg">
        ${fld('clinical.dx', 'Working diagnosis', c.dx, { cls: 's4' })}
        ${fld('clinical.ddx', 'Differential diagnoses', c.ddx, { type: 'textarea', cls: 's2' })}${fld('clinical.problems', 'Problem list (one per line)', c.problems, { type: 'textarea', cls: 's2' })}</div></fieldset>
      <fieldset id="sec-plan"><legend>Plan</legend><div class="fg">${fld('clinical.plan', 'Management plan', c.plan, { type: 'textarea', cls: 's4' })}</div></fieldset>
    </form>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveFile">${isNew ? 'Admit' : 'Save changes'}</button>`);
    const ds = $('#f_department');
    if (ds) ds.addEventListener('change', () => { $('#specBox').innerHTML = specFields(ds.value, {}); $('#specLegend').textContent = deptName(ds.value) + ' details'; });
    $('#saveFile').onclick = async () => {
      const d = formData('#pform');
      if (!d.name) return modalError('Add the patient’s name.');
      d.clinical = d.clinical || {};
      d.clinical.sp = d.clinical.sp || {};
      try {
        $('#saveFile').disabled = true;
        if (isNew) {
          const r = await api('POST', '/api/patients', d);
          closeModal(); toast('Patient admitted'); S.listLoaded = false; go('p-' + r.id);
        } else {
          const merged = { ...p.clinical, ...d.clinical, sp: { ...(p.clinical?.sp || {}), ...d.clinical.sp } };
          await api('PATCH', '/api/patients/' + p.id, { ...d, clinical: merged, version: p.version });
          closeModal(); toast('File saved'); await reloadFile();
        }
      } catch (e) {
        $('#saveFile').disabled = false;
        if (e.status === 409) modalError(e.message + ' Your edits are still in this form: copy what you need first.');
        else modalError(e.message);
      }
    };
    if (section && section !== 'id' && !isNew) setTimeout(() => $('#sec-' + section)?.scrollIntoView({ block: 'start' }), 40);
  }

  function openVitals() {
    const p = S.file.patient;
    openModal('Record vital signs', `<form id="vform"><div class="fg">
      ${fld('bp', 'Blood pressure', '', { ph: '120/80' })}${fld('hr', 'Heart rate', '', { type: 'number' })}${fld('rr', 'Respiratory rate', '', { type: 'number' })}${fld('temp', 'Temperature °C', '', { type: 'number' })}
      ${fld('spo2', 'SpO₂ %', '', { type: 'number' })}${fld('gcs', 'GCS', '', { type: 'number' })}${fld('weight_kg', 'Weight kg', '', { type: 'number' })}${fld('glucose', 'Glucose', '', { ph: 'e.g. 7.2 mmol/L' })}
      ${fld('urine', 'Urine output', '', { cls: 's2', ph: 'e.g. 0.6 mL/kg/h' })}${fld('recorded_at', 'Time taken', new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16), { type: 'datetime-local', cls: 's2' })}
    </div></form>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveV">Save</button>`, { narrow: false });
    $('#f_temp').step = '0.1'; $('#f_weight_kg').step = '0.1';
    $('#saveV').onclick = async () => {
      const d = formData('#vform');
      const bp = String(d.bp || '').match(/^(\d{2,3})\s*\/\s*(\d{2,3})$/);
      if (d.bp && !bp) return modalError('Write blood pressure as systolic/diastolic, for example 120/80.');
      const body = { hr: d.hr, rr: d.rr, temp: d.temp, spo2: d.spo2, gcs: d.gcs, weight_kg: d.weight_kg, glucose: d.glucose, urine: d.urine,
        sbp: bp?.[1], dbp: bp?.[2], recorded_at: d.recorded_at ? new Date(d.recorded_at).toISOString() : undefined };
      try { await api('POST', `/api/patients/${p.id}/vitals`, body); closeModal(); toast('Vital signs saved'); await reloadFile(); } catch (e) { modalError(e.message); }
    };
  }

  async function openAssign() {
    const p = S.file.patient;
    try { S.people = S.people || await api('GET', '/api/people'); } catch (e) { return fail(e); }
    const have = new Set(S.file.assignments.map(a => a.user_id));
    const opts = S.people.filter(x => !have.has(x.id) && !['hospital_admin', 'auditor'].includes(x.role)).map(x => [x.id, `${x.full_name} · ${S.meta.roles[x.role]}${x.departments?.length ? ' (' + x.departments.join(', ') + ')' : ''}`]);
    openModal('Add to care team', `<form id="aform"><p class="muted" style="margin:0 0 8px">The person gets access to this patient's file only, on top of their own department.</p><div class="fg">
      ${fld('userId', 'Person', '', { type: 'select', cls: 's4', opts: [['', 'Choose…'], ...opts] })}
      ${fld('reason', 'Reason', 'consult', { type: 'select', cls: 's4', opts: [['consult', 'Consult'], ['student', 'Student following the case'], ['cover', 'Covering doctor']] })}
    </div></form>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveA">Add</button>`, { narrow: true });
    $('#saveA').onclick = async () => {
      const d = formData('#aform');
      if (!d.userId) return modalError('Choose a person.');
      try { await api('POST', `/api/patients/${p.id}/assignments`, d); closeModal(); toast('Added to care team'); await reloadFile(); } catch (e) { modalError(e.message); }
    };
  }

  function openTransfer() {
    const p = S.file.patient;
    openModal('Transfer patient', `<form id="tform"><div class="fg">
      ${fld('to', 'To department', '', { type: 'select', cls: 's4', opts: [['', 'Choose…'], ...Object.entries(S.meta.departments).filter(([k]) => k !== p.department)] })}
      ${fld('ward', 'New ward', '', { cls: 's2' })}${fld('bed', 'New bed', '', { cls: 's2' })}
      ${fld('note', 'Reason / handover note', '', { type: 'textarea', cls: 's4' })}
    </div><p class="muted" style="margin:8px 0 0;font-size:13px">If you are not on the receiving team, you will lose access to this file after the transfer.</p></form>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveT">Transfer</button>`, { narrow: true });
    $('#saveT').onclick = async () => {
      const d = formData('#tform');
      if (!d.to) return modalError('Choose the receiving department.');
      try {
        await api('POST', `/api/patients/${p.id}/transfer`, { ...d, version: p.version });
        closeModal(); toast('Transferred to ' + deptName(d.to)); S.listLoaded = false; await loadList();
        if (S.list.some(x => x.id === p.id)) await reloadFile(); else go('dept-' + p.department);
      } catch (e) { modalError(e.message); }
    };
  }

  function confirmModal(title, text, label, fn, danger = false) {
    openModal(title, `<p style="margin:0">${text}</p>`, `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="okBtn">${label}</button>`, { narrow: true });
    $('#okBtn').onclick = async () => { try { $('#okBtn').disabled = true; await fn(); closeModal(); } catch (e) { $('#okBtn').disabled = false; modalError(e.message); } };
  }

  function openNoteEdit(n) {
    openModal('Edit your note', `<form id="nform"><div class="soap">
      ${fld('s', 'S · Subjective', n.s, { type: 'textarea' })}${fld('o', 'O · Objective', n.o, { type: 'textarea' })}${fld('a', 'A · Assessment', n.a, { type: 'textarea' })}${fld('p', 'P · Plan', n.p, { type: 'textarea' })}
    </div></form>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveN">Save</button>`);
    $('#saveN').onclick = async () => {
      try { await api('PATCH', '/api/notes/' + n.id, formData('#nform')); closeModal(); toast('Note updated'); await reloadFile(); } catch (e) { modalError(e.message); }
    };
  }
  function openAddendum(n) {
    openModal('Add an addendum', `<form id="adform"><p class="muted" style="margin:0 0 8px">The original note stays as it is. Your addendum is added under it with your name and the time.</p>
      ${fld('text', 'Addendum', '', { type: 'textarea' })}</form>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveAd">Add</button>`, { narrow: true });
    $('#saveAd').onclick = async () => {
      try { await api('POST', `/api/notes/${n.id}/addendum`, formData('#adform')); closeModal(); toast('Addendum added'); await reloadFile(); } catch (e) { modalError(e.message); }
    };
  }

  const roleOpts = () => Object.entries(S.meta.roles);
  const deptChecks = (sel = []) => `<div class="checks">${[['ALL', 'All departments'], ...Object.entries(S.meta.departments)].map(([k, l]) => `<label><input type="checkbox" name="dept" value="${k}" ${sel.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
  const checkedDepts = () => [...document.querySelectorAll('#modal input[name=dept]:checked')].map(i => i.value);

  function openAddStaff() {
    openModal('Add staff', `<form id="sform"><div class="fg">
      ${fld('fullName', 'Full name', '', { cls: 's2', req: true })}${fld('email', 'Work email', '', { type: 'email', cls: 's2', req: true })}
      ${fld('role', 'Role', 'intern', { type: 'select', cls: 's2', opts: roleOpts() })}${fld('validUntil', 'Access ends (optional)', '', { type: 'date', cls: 's2' })}
      <div class="s4"><span class="lbl">Departments</span>${deptChecks()}</div></div>
      <p class="muted" style="margin:10px 0 0;font-size:13px">Interns and students rotate: set an end date and access stops automatically. Students see only patients a clinician assigns to them.</p></form>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveS">Add</button>`);
    $('#saveS').onclick = async () => {
      const d = formData('#sform'); delete d.dept;
      try {
        const r = await api('POST', '/api/admin/staff', { ...d, departments: checkedDepts() });
        S.staff = await api('GET', '/api/admin/staff'); render();
        showTemp(r.tempPassword ? `${esc(d.fullName)} can now sign in with this temporary password. Give it to them in person; it is shown only once. They will choose their own password and set up two-step sign-in.` : `${esc(d.fullName)} already has a WardBook account from another hospital. They keep their password and now also have access here.`, r.tempPassword);
      } catch (e) { modalError(e.message); }
    };
  }
  function showTemp(text, pw) {
    openModal('Done', `<p style="margin:0 0 10px">${text}</p>${pw ? `<div class="temp">${esc(pw)}</div>` : ''}`, `<button class="btn primary" data-close>Close</button>`, { narrow: true });
  }
  function openStaff(id) {
    const s = S.staff.find(x => x.membership_id === id);
    if (!s) return;
    openModal(esc(s.full_name), `<form id="eform"><div class="fg">
      ${fld('role', 'Role', s.role, { type: 'select', cls: 's2', opts: roleOpts() })}${fld('validUntil', 'Access ends', iso(s.valid_until), { type: 'date', cls: 's2' })}
      <div class="s4"><span class="lbl">Departments</span>${deptChecks(s.departments || [])}</div></div></form>
      <div class="row" style="margin-top:16px"><button class="btn sm" id="rPw">Reset password</button><button class="btn sm" id="rTotp">Reset two-step (lost phone)</button>
      <button class="btn sm ${s.active ? 'danger' : ''}" id="tAct">${s.active ? 'Remove access to this hospital' : 'Restore access'}</button></div>
      <p class="muted" style="margin:8px 0 0;font-size:13px">Any change signs the person out everywhere at once.</p>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveE">Save</button>`);
    const done = async msg => { S.staff = await api('GET', '/api/admin/staff'); render(); toast(msg); };
    $('#saveE').onclick = async () => {
      const d = formData('#eform');
      try { await api('PATCH', '/api/admin/memberships/' + id, { role: d.role, validUntil: d.validUntil || null, departments: checkedDepts() }); closeModal(); await done('Access updated'); } catch (e) { modalError(e.message); }
    };
    $('#tAct').onclick = async () => {
      try { await api('PATCH', '/api/admin/memberships/' + id, { active: !s.active }); closeModal(); await done(s.active ? 'Access removed' : 'Access restored'); } catch (e) { modalError(e.message); }
    };
    $('#rPw').onclick = async () => {
      try { const r = await api('POST', `/api/admin/users/${s.user_id}/reset`, { password: true }); await done('Password reset'); showTemp(`New temporary password for ${esc(s.full_name)}. Give it to them in person; it is shown only once.`, r.tempPassword); } catch (e) { modalError(e.message); }
    };
    $('#rTotp').onclick = async () => {
      try { await api('POST', `/api/admin/users/${s.user_id}/reset`, { twoStep: true }); closeModal(); await done('Two-step reset: they set it up again at next sign-in'); } catch (e) { modalError(e.message); }
    };
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function reloadFile() {
    if (!S.file?.patient) return;
    try { S.file = await api('GET', '/api/patients/' + S.file.patient.id); loadList().then(() => renderHeader()).catch(() => {}); } catch (e) { fail(e); }
    render();
  }

  async function summarize(source) {
    const p = S.file.patient;
    S.busy = true; render();
    try { await api('POST', `/api/patients/${p.id}/summaries`, { kind: S.sumKind, source }); await reloadFile(); }
    catch (e) { fail(e); }
    finally { S.busy = false; render(); }
  }

  function copyText(text, el) {
    const ok = () => toast('Copied');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, sel); else sel();
    function sel() { if (!el) return; const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected. Press Ctrl+C to copy.'); }
  }

  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    S.me = { stage: 'signed_out' }; S.setup = null; S.notice = null; S.menuOpen = false; clearClinical();
    history.replaceState(null, '', location.pathname); render();
  }

  document.addEventListener('click', async e => {
    S.lastActivity = Date.now();
    const t = e.target.closest('[data-act],[data-edit],[data-close],[data-kind],[data-hosp],[data-note-sign],[data-note-edit],[data-note-add],[data-copy],[data-accept],[data-unassign],[data-staff]');
    if (!t) {
      if (e.target.id === 'scrim') closeModal();
      if (S.menuOpen && !e.target.closest('.menu')) { S.menuOpen = false; renderHeader(); }
      return;
    }
    const F = S.file, p = F?.patient;
    if (t.hasAttribute('data-close')) return closeModal();
    if (t.dataset.hosp) {
      try { await api('POST', '/api/auth/hospital', { hospitalId: t.dataset.hosp }); clearClinical(); await refreshMe(); history.replaceState(null, '', location.pathname); route(); } catch (err) { fail(err); }
      return;
    }
    if (t.dataset.edit) return openFileForm(p, t.dataset.edit);
    if (t.dataset.kind) { S.sumKind = t.dataset.kind; return render(); }
    if (t.dataset.noteSign) {
      return confirmModal('Sign this note?', 'After signing, the note cannot be changed. Corrections are added as addenda.', 'Sign note', async () => { await api('POST', `/api/notes/${t.dataset.noteSign}/sign`); toast('Note signed'); await reloadFile(); });
    }
    if (t.dataset.noteEdit) return openNoteEdit(F.notes.find(n => n.id === t.dataset.noteEdit));
    if (t.dataset.noteAdd) return openAddendum(F.notes.find(n => n.id === t.dataset.noteAdd));
    if (t.dataset.copy) { const s = F.summaries.find(x => x.id === t.dataset.copy); return copyText(s.text, $('#sum-' + s.id)); }
    if (t.dataset.accept) {
      return confirmModal('Accept this summary?', 'Accepting records that you checked it. It is saved with your name and can no longer change.', 'Accept', async () => { await api('POST', `/api/summaries/${t.dataset.accept}/accept`); toast('Summary accepted'); await reloadFile(); });
    }
    if (t.dataset.unassign) {
      return confirmModal('Remove from care team?', 'They lose access to this file unless it is in their own department.', 'Remove', async () => { await api('DELETE', '/api/assignments/' + t.dataset.unassign); await reloadFile(); }, true);
    }
    if (t.dataset.staff) return openStaff(t.dataset.staff);
    switch (t.dataset.act) {
      case 'logout': return logout();
      case 'menu': S.menuOpen = !S.menuOpen; return renderHeader();
      case 'deid': S.deid = !S.deid; try { localStorage.setItem('wb_deid', S.deid ? '1' : '0'); } catch { /* ignore */ } S.menuOpen = false; return render();
      case 'switch': S.menuOpen = false; S.me.stage = 'choose_hospital'; clearClinical(); return render();
      case 'admit': return openFileForm(null, t.dataset.dept);
      case 'toggleDc': S.showDc = !S.showDc; return loadView();
      case 'print': return window.print();
      case 'vitals': return openVitals();
      case 'assign': return openAssign();
      case 'transfer': return openTransfer();
      case 'summarize': return summarize('auto');
      case 'summarize-template': return summarize('template');
      case 'carry': { const el = document.querySelector(`[data-keep="np-${p.id}"]`); const last = F.notes.find(n => n.kind !== 'addendum'); if (el && last) { el.value = last.p || ''; el.focus(); } return; }
      case 'discharge':
        return confirmModal('Discharge this patient?', `${esc(showName(p))} moves to the discharged list. The file stays readable and can be readmitted.`, 'Discharge', async () => {
          await api('POST', `/api/patients/${p.id}/discharge`, { version: p.version }); toast('Discharged'); S.listLoaded = false; await reloadFile();
        });
      case 'readmit':
        return confirmModal('Readmit this patient?', 'The patient returns to the current list as stable.', 'Readmit', async () => {
          await api('POST', `/api/patients/${p.id}/readmit`, { version: p.version }); toast('Readmitted'); S.listLoaded = false; await reloadFile();
        });
      case 'patient-audit': S.auditPatient = p.id; return go('audit');
      case 'audit-all': S.auditPatient = null; return loadView();
      case 'add-staff': return openAddStaff();
      case 'toggle-ai': {
        const on = !S.me.current.aiEnabled;
        return confirmModal(on ? 'Turn on AI summaries?' : 'Turn off AI summaries?',
          on ? 'Confirm that your data protection officer approved sending de-identified patient records to the AI provider. Every summary request is recorded in the audit log.' : 'Clinicians will only be able to build template summaries on this server.',
          on ? 'Turn on' : 'Turn off', async () => { await api('PATCH', '/api/admin/hospital', { aiEnabled: on }); await refreshMe(); render(); toast(on ? 'AI summaries on' : 'AI summaries off'); });
      }
    }
  });

  document.addEventListener('change', async e => {
    S.lastActivity = Date.now();
    const p = S.file?.patient;
    try {
      if (e.target.id === 'statusSel' && p) {
        await api('PATCH', '/api/patients/' + p.id, { status: e.target.value, version: p.version }); toast('Status updated'); await reloadFile();
      } else if (e.target.dataset.task) {
        await api('PATCH', '/api/tasks/' + e.target.dataset.task, { done: e.target.checked }); await reloadFile();
      } else if (e.target.dataset.taskList) {
        await api('PATCH', '/api/tasks/' + e.target.dataset.taskList, { done: true }); toast('Task done'); S.tasks = await api('GET', '/api/tasks'); render();
      }
    } catch (err) { fail(err); if (err.status === 409) await reloadFile(); }
  });

  document.addEventListener('input', e => {
    S.lastActivity = Date.now();
    if (e.target.id === 'q') { S.q = e.target.value.trim(); if (S.view.startsWith('dept-')) keepInputs(() => { $('#main').innerHTML = renderMain(); }); else if (S.q) go(defaultView()); }
  });
  document.addEventListener('keydown', e => { S.lastActivity = Date.now(); if (e.key === 'Escape') { if ($('#modal').innerHTML) closeModal(); else if (S.menuOpen) { S.menuOpen = false; renderHeader(); } } });

  document.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = $('#err');
    const showErr = m => { if (err) { err.textContent = m; err.hidden = false; } else toast(m); };
    try {
      if (f.id === 'f-login') {
        const r = await api('POST', '/api/auth/login', { email: f.email.value, password: f.password.value });
        S.notice = null; S.me.stage = r.stage; if (r.stage !== 'setup_two_step') S.setup = null;
        await refreshMe(); route();
      } else if (f.id === 'f-pw' || f.id === 'f-pw2') {
        if (f.next.value !== f.again.value) return showErr('The two new passwords are not the same.');
        await api('POST', '/api/auth/password', { current: f.current.value, next: f.next.value });
        await refreshMe(); if (f.id === 'f-pw2') { toast('Password changed. Other devices are signed out.'); f.reset(); } else route();
      } else if (f.id === 'f-code') {
        await api('POST', '/api/auth/two-step/verify', { code: f.code.value });
        S.setup = null; await refreshMe(); route();
      } else if (f.dataset.form === 'task') {
        const text = f.t.value.trim(); if (!text) return;
        await api('POST', `/api/patients/${S.file.patient.id}/tasks`, { text });
        f.t.value = ''; await reloadFile(); document.querySelector(`[data-keep="task-${S.file.patient.id}"]`)?.focus();
      } else if (f.dataset.form === 'note') {
        const body = { note_date: $('#noteDate').value, s: f.s.value, o: f.o.value, a: f.a.value, p: f.p.value };
        if (![body.s, body.o, body.a, body.p].some(x => x.trim())) return toast('Write at least one of S, O, A or P.');
        await api('POST', `/api/patients/${S.file.patient.id}/notes`, body);
        ['s', 'o', 'a', 'p'].forEach(k => { f[k].value = ''; });
        toast('Note saved'); await reloadFile();
      }
    } catch (ex) { if (ex.status !== 401 || f.id === 'f-login') showErr(ex.message); }
  });

  // Hide patient data from an unattended screen once the session's idle limit passes.
  setInterval(async () => {
    if (S.me?.stage !== 'ready') return;
    const idleMs = (S.me.idleMinutes || 15) * 60e3;
    if (Date.now() - S.lastActivity > idleMs) {
      S.notice = 'You were signed out after a period without activity.';
      S.me = { stage: 'signed_out' }; clearClinical(); render();
    }
  }, 30e3);

  // Pick up colleagues' changes when coming back to the tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.me?.stage === 'ready' && !$('#modal').innerHTML) {
      S.lastActivity = Date.now(); loadView();
    }
  });

  boot();
})();
