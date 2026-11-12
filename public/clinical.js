// WardBook clinical rules, shared by the browser and the server.
// Loaded as a plain script in the browser and as a side-effect import on the server;
// both read it from globalThis.WBClinical.
//
// IMPORTANT: these thresholds are starting points taken from published charts. Each hospital's
// senior clinicians must confirm them against the charts used on their wards before go-live.
// They support clinical judgement; they never replace it.
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Age
  // ---------------------------------------------------------------------------
  // Accepts "54", "54y", "3 years", "8 months", "8 mo", "2 weeks", "10 days", or a date of birth.
  function ageYears(age, dob, onDate) {
    if (dob) {
      const born = Date.parse(String(dob).slice(0, 10));
      const now = onDate ? Date.parse(String(onDate).slice(0, 10)) : Date.now();
      if (Number.isFinite(born) && now >= born) return (now - born) / (365.25 * 864e5);
    }
    const s = String(age ?? '').toLowerCase().trim();
    const m = s.match(/(\d+(?:\.\d+)?)\s*(years?|yrs?|y|months?|mos?|m|weeks?|wks?|w|days?|d)?\b/);
    if (!m) return null;
    const n = Number(m[1]);
    const u = m[2] || 'y';
    if (/^(months?|mos?|m)$/.test(u)) return n / 12;
    if (/^(weeks?|wks?|w)$/.test(u)) return n / 52;
    if (/^(days?|d)$/.test(u)) return n / 365;
    return n;
  }

  // ---------------------------------------------------------------------------
  // NEWS2 (Royal College of Physicians, 2017), adults 16+ and not pregnant.
  // SpO2 scale 1 only (scale 2 is for confirmed hypercapnic respiratory failure).
  // ---------------------------------------------------------------------------
  const NEWS2_PARTS = {
    rr: v => (v <= 8 ? 3 : v <= 11 ? 1 : v <= 20 ? 0 : v <= 24 ? 2 : 3),
    spo2: v => (v <= 91 ? 3 : v <= 93 ? 2 : v <= 95 ? 1 : 0),
    sbp: v => (v <= 90 ? 3 : v <= 100 ? 2 : v <= 110 ? 1 : v <= 219 ? 0 : 3),
    hr: v => (v <= 40 ? 3 : v <= 50 ? 1 : v <= 90 ? 0 : v <= 110 ? 1 : v <= 130 ? 2 : 3),
    temp: v => (v <= 35 ? 3 : v <= 36 ? 1 : v <= 38 ? 0 : v <= 39 ? 1 : 2),
  };
  const has = v => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));

  function consciousness(set) {
    if (set.avpu) return { alert: set.avpu === 'A', from: 'ACVPU' };
    if (has(set.gcs)) return { alert: Number(set.gcs) >= 15, from: 'GCS' };
    return null;
  }

  function news2(set) {
    const parts = {}, missing = [];
    let score = 0;
    for (const [k, f] of Object.entries(NEWS2_PARTS)) {
      if (has(set[k])) { parts[k] = f(Number(set[k])); score += parts[k]; } else missing.push(k);
    }
    if (set.on_oxygen === true || set.on_oxygen === false) { parts.o2 = set.on_oxygen ? 2 : 0; score += parts.o2; } else missing.push('o2');
    const c = consciousness(set);
    if (c) { parts.avpu = c.alert ? 0 : 3; score += parts.avpu; } else missing.push('avpu');
    const anyThree = Object.values(parts).some(p => p === 3);
    let risk, action;
    if (score >= 7) { risk = 'high'; action = 'High risk: emergency assessment by a team with critical care skills; continuous monitoring.'; }
    else if (score >= 5) { risk = 'medium'; action = 'Medium risk: urgent review by a clinician competent in acute illness; observations at least hourly.'; }
    else if (anyThree) { risk = 'low-medium'; action = 'One parameter scores 3: urgent ward-based review by a doctor.'; }
    else if (score >= 1) { risk = 'low'; action = 'Low risk: inform the nurse in charge; observations at least every 4 to 6 hours.'; }
    else { risk = 'none'; action = 'Continue routine observations (at least every 12 hours).'; }
    return { score, parts, missing, anyThree, risk, action };
  }

  // ---------------------------------------------------------------------------
  // Children under 16: age-banded normal ranges (APLS-style) plus WHO fast breathing.
  // ---------------------------------------------------------------------------
  const PAEDS_BANDS = [
    { max: 1,  label: 'under 1 year', hr: [110, 160], rr: [30, 40], sbpMin: 70 },
    { max: 2,  label: '1 to 2 years', hr: [100, 150], rr: [25, 35], sbpMin: 80 },
    { max: 5,  label: '2 to 5 years', hr: [95, 140],  rr: [25, 30], sbpMin: 80 },
    { max: 12, label: '5 to 12 years', hr: [80, 120], rr: [20, 25], sbpMin: 90 },
    { max: 16, label: '12 to 16 years', hr: [60, 100], rr: [15, 20], sbpMin: 90 },
  ];
  // WHO IMCI fast breathing: 60+/min under 2 months, 50+ from 2 to 12 months, 40+ from 1 to 5 years.
  const whoFast = y => (y < 2 / 12 ? 60 : y < 1 ? 50 : y < 5 ? 40 : null);

  function paeds(set, years) {
    const flags = {}, reasons = [];
    const band = years == null ? null : PAEDS_BANDS.find(b => years < b.max) || null;
    const put = (k, lvl, why) => { if (lvl === 'crit' || !flags[k]) flags[k] = lvl; reasons.push(why); };
    if (has(set.spo2)) {
      const s = Number(set.spo2);
      if (s < 92) put('spo2', 'crit', `SpO₂ ${s}% is below 92%`);
      else if (s < 95) put('spo2', 'warn', `SpO₂ ${s}% is below 95%`);
    }
    if (has(set.temp)) {
      const t = Number(set.temp);
      if (t < 35) put('temp', 'crit', `temperature ${t}°C is below 35°C`);
      else if (t >= 38 || t < 36) put('temp', 'warn', `temperature ${t}°C is outside 36 to 37.9°C`);
    }
    if (band) {
      if (has(set.hr)) {
        const h = Number(set.hr), [lo, hi] = band.hr;
        if (h >= hi + 30 || h <= lo - 20) put('hr', 'crit', `heart rate ${h} is far outside ${lo} to ${hi} for ${band.label}`);
        else if (h > hi || h < lo) put('hr', 'warn', `heart rate ${h} is outside ${lo} to ${hi} for ${band.label}`);
      }
      if (has(set.rr)) {
        const r = Number(set.rr), [lo, hi] = band.rr;
        if (r >= hi + 20 || r <= lo - 10) put('rr', 'crit', `respiratory rate ${r} is far outside ${lo} to ${hi} for ${band.label}`);
        else if (r > hi || r < lo) put('rr', 'warn', `respiratory rate ${r} is outside ${lo} to ${hi} for ${band.label}`);
        const fast = whoFast(years);
        if (fast && r >= fast) reasons.push(`fast breathing by WHO criteria (${fast}+/min at this age)`);
      }
      if (has(set.sbp) && Number(set.sbp) < band.sbpMin) put('sbp', 'crit', `systolic BP ${set.sbp} is below ${band.sbpMin} for ${band.label}`);
    }
    if (has(set.gcs) && Number(set.gcs) < 15) put('gcs', Number(set.gcs) <= 8 ? 'crit' : 'warn', `GCS ${set.gcs}`);
    if (set.avpu && set.avpu !== 'A') put('gcs', 'crit', `not alert (${set.avpu})`);
    const level = Object.values(flags).includes('crit') ? 'crit' : Object.keys(flags).length >= 2 ? 'crit' : Object.keys(flags).length ? 'warn' : 'ok';
    return { band, flags, reasons, level };
  }

  // ---------------------------------------------------------------------------
  // Obstetric patients: MEOWS-style triggers (after Singh et al., 2012).
  // One red or two yellows triggers an urgent review.
  // ---------------------------------------------------------------------------
  function meows(set) {
    const flags = {}, reasons = [];
    const red = (k, why) => { flags[k] = 'crit'; reasons.push(why + ' (red)'); };
    const yellow = (k, why) => { if (!flags[k]) flags[k] = 'warn'; reasons.push(why + ' (yellow)'); };
    const n = k => Number(set[k]);
    if (has(set.temp)) { if (n('temp') < 35 || n('temp') >= 38) red('temp', `temperature ${set.temp}°C`); else if (n('temp') < 36) yellow('temp', `temperature ${set.temp}°C`); }
    if (has(set.sbp)) { if (n('sbp') < 90 || n('sbp') >= 160) red('sbp', `systolic BP ${set.sbp}`); else if (n('sbp') >= 150 || n('sbp') < 100) yellow('sbp', `systolic BP ${set.sbp}`); }
    if (has(set.dbp)) { if (n('dbp') >= 100) red('dbp', `diastolic BP ${set.dbp}`); else if (n('dbp') >= 90) yellow('dbp', `diastolic BP ${set.dbp}`); }
    if (has(set.hr)) { if (n('hr') < 40 || n('hr') >= 120) red('hr', `heart rate ${set.hr}`); else if (n('hr') >= 100 || n('hr') < 50) yellow('hr', `heart rate ${set.hr}`); }
    if (has(set.rr)) { if (n('rr') < 10 || n('rr') >= 30) red('rr', `respiratory rate ${set.rr}`); else if (n('rr') >= 21) yellow('rr', `respiratory rate ${set.rr}`); }
    if (has(set.spo2) && n('spo2') < 95) red('spo2', `SpO₂ ${set.spo2}%`);
    const c = consciousness(set);
    if (c && !c.alert) red('gcs', `not alert (${set.avpu || 'GCS ' + set.gcs})`);
    const reds = reasons.filter(r => r.endsWith('(red)')).length;
    const yellows = reasons.length - reds;
    const trigger = reds >= 1 || yellows >= 2;
    return { flags, reasons, reds, yellows, trigger, level: trigger ? 'crit' : yellows ? 'warn' : 'ok' };
  }

  // ---------------------------------------------------------------------------
  // One entry point: which chart applies, per-sign flags, and a badge for the screens.
  // ---------------------------------------------------------------------------
  const LABELS = { rr: 'resp. rate', spo2: 'SpO₂', sbp: 'systolic BP', hr: 'heart rate', temp: 'temperature', o2: 'oxygen yes/no', avpu: 'consciousness' };

  function assess(patient, set) {
    if (!set) return null;
    const years = ageYears(patient.age, patient.dob, set.recorded_at);
    if (patient.department === 'PEDS' || (years != null && years < 16)) {
      const r = paeds(set, years);
      const n = Object.keys(r.flags).length;
      return {
        scheme: 'PAEDS', flags: r.flags, level: r.level, reasons: r.reasons,
        badge: r.band ? (n ? `Paeds: ${n} sign${n > 1 ? 's' : ''} abnormal for age` : 'Paeds: normal for age') : 'Paeds: add age to check ranges',
        detail: r.band ? `Ranges for ${r.band.label}.` : 'Age is missing or unreadable, so only SpO₂, temperature and consciousness are checked.',
        action: r.level === 'crit' ? 'Urgent review by a doctor.' : r.level === 'warn' ? 'Repeat observations and inform the nurse in charge.' : '',
      };
    }
    if (patient.department === 'OBGYN') {
      const r = meows(set);
      return {
        scheme: 'MEOWS', flags: r.flags, level: r.level, reasons: r.reasons,
        badge: r.trigger ? `MEOWS: trigger (${r.reds} red, ${r.yellows} yellow)` : r.yellows ? 'MEOWS: 1 yellow' : 'MEOWS: no triggers',
        detail: 'Obstetric early warning: one red or two yellows trigger a review.',
        action: r.trigger ? 'Urgent review by the obstetric doctor.' : '',
      };
    }
    const r = news2(set);
    const flags = {};
    for (const [k, p] of Object.entries(r.parts)) {
      const key = k === 'avpu' ? 'gcs' : k;
      if (p >= 3) flags[key] = 'crit'; else if (p >= 1 && k !== 'o2') flags[key] = 'warn';
    }
    if (has(set.dbp) && Number(set.dbp) >= 120) flags.dbp = 'crit';
    const level = r.risk === 'high' || r.risk === 'medium' || r.risk === 'low-medium' ? 'crit' : r.risk === 'low' ? 'warn' : 'ok';
    return {
      scheme: 'NEWS2', flags, level, score: r.score, risk: r.risk, missing: r.missing,
      badge: `NEWS2 ${r.score}${r.missing.length ? '+' : ''}`,
      detail: r.missing.length ? `Incomplete: missing ${r.missing.map(m => LABELS[m]).join(', ')}. The real score may be higher; record a full set.` : '',
      action: r.action,
      reasons: Object.entries(r.parts).filter(([, p]) => p > 0).map(([k, p]) => `${LABELS[k]} +${p}`),
    };
  }

  // Latest recorded value of each sign, each with its own time (the newest set may be partial).
  const SIGNS = ['sbp', 'dbp', 'hr', 'rr', 'temp', 'spo2', 'gcs', 'avpu', 'on_oxygen', 'glucose', 'urine', 'weight_kg'];
  function latestBySign(vitals) {
    const out = {};
    for (const v of vitals || []) for (const k of SIGNS) {
      if (out[k] === undefined && v[k] !== null && v[k] !== undefined && v[k] !== '') out[k] = { value: v[k], at: v.recorded_at, dbpWith: k === 'sbp' ? v.dbp : undefined };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Names and wording
  // ---------------------------------------------------------------------------
  const TITLES = /^(dr|doctor|prof|professor|mr|mrs|ms|miss|mx|sr|sister|rev|nurse)\.?$/i;
  function initials(name) {
    const words = String(name || '').replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean).filter(w => !TITLES.test(w));
    const letters = words.map(w => (w.match(/\p{L}/u) || [''])[0].toUpperCase()).filter(Boolean);
    return letters.length ? letters.map(l => l + '.').join('') : '—';
  }

  const firstLine = t => String(t || '').split('\n')[0].trim().replace(/[.;,]$/, '');
  // Lower-case the first letter of a phrase placed mid-sentence, but keep acronyms (HIV, CAP).
  const mid = t => { const s = firstLine(t); return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; };

  function oneLiner(p, onDate) {
    const c = p.clinical || {};
    let s = [p.age, p.sex ? String(p.sex).toLowerCase() : ''].filter(Boolean).join(' ');
    if (c.pmh) s += ` with ${mid(c.pmh)}`;
    if (c.complaint) s += `${s ? ', ' : ''}presenting with ${mid(c.complaint)}`;
    if (p.admitted_at) {
      const d = Math.floor((Date.parse(String(onDate || new Date().toISOString()).slice(0, 10)) - Date.parse(String(p.admitted_at).slice(0, 10))) / 864e5) + 1;
      if (d > 0) s += `. Hospital day ${d}`;
    }
    if (c.dx) s += `. Working diagnosis: ${mid(c.dx)}`;
    s = s.trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : '';
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

  globalThis.WBClinical = { ageYears, news2, paeds, meows, assess, latestBySign, initials, oneLiner, firstLine, plural, PAEDS_BANDS };
})();
