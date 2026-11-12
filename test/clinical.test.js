import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/clinical.js';

const C = globalThis.WBClinical;

test('age is read from common ways of writing it', () => {
  assert.equal(C.ageYears('54'), 54);
  assert.equal(C.ageYears('54y'), 54);
  assert.equal(C.ageYears('3 years'), 3);
  assert.equal(C.ageYears('8 months'), 8 / 12);
  assert.equal(C.ageYears('8 mo'), 8 / 12);
  assert.equal(C.ageYears('2 weeks'), 2 / 52);
  assert.equal(C.ageYears('10 days'), 10 / 365);
  assert.equal(C.ageYears(''), null);
  assert.ok(Math.abs(C.ageYears(null, '2016-11-12', '2026-11-12') - 10) < 0.01);
});

test('NEWS2 scores each parameter as the RCP 2017 chart does', () => {
  // All normal on air: 0.
  assert.equal(C.news2({ rr: 16, spo2: 97, on_oxygen: false, sbp: 120, hr: 80, avpu: 'A', temp: 37 }).score, 0);
  // Boundaries.
  const p = s => C.news2({ rr: 16, spo2: 97, on_oxygen: false, sbp: 120, hr: 80, avpu: 'A', temp: 37, ...s }).score;
  assert.equal(p({ rr: 8 }), 3); assert.equal(p({ rr: 9 }), 1); assert.equal(p({ rr: 20 }), 0); assert.equal(p({ rr: 21 }), 2); assert.equal(p({ rr: 25 }), 3);
  assert.equal(p({ spo2: 91 }), 3); assert.equal(p({ spo2: 93 }), 2); assert.equal(p({ spo2: 95 }), 1); assert.equal(p({ spo2: 96 }), 0);
  assert.equal(p({ on_oxygen: true }), 2);
  assert.equal(p({ sbp: 90 }), 3); assert.equal(p({ sbp: 100 }), 2); assert.equal(p({ sbp: 110 }), 1); assert.equal(p({ sbp: 219 }), 0); assert.equal(p({ sbp: 220 }), 3);
  assert.equal(p({ hr: 40 }), 3); assert.equal(p({ hr: 50 }), 1); assert.equal(p({ hr: 90 }), 0); assert.equal(p({ hr: 110 }), 1); assert.equal(p({ hr: 130 }), 2); assert.equal(p({ hr: 131 }), 3);
  assert.equal(p({ temp: 35 }), 3); assert.equal(p({ temp: 36 }), 1); assert.equal(p({ temp: 38 }), 0); assert.equal(p({ temp: 39 }), 1); assert.equal(p({ temp: 39.1 }), 2);
  assert.equal(p({ avpu: 'C' }), 3);
});

test('NEWS2 risk bands and the single-3 rule', () => {
  assert.equal(C.news2({ rr: 16, spo2: 97, on_oxygen: false, sbp: 120, hr: 80, avpu: 'A', temp: 37 }).risk, 'none');
  assert.equal(C.news2({ rr: 22, spo2: 97, on_oxygen: false, sbp: 120, hr: 80, avpu: 'A', temp: 37 }).risk, 'low');
  assert.equal(C.news2({ rr: 26, spo2: 97, on_oxygen: false, sbp: 120, hr: 80, avpu: 'A', temp: 37 }).risk, 'low-medium');
  // The demo pneumonia patient: RR 24 (2), SpO2 92 (2), oxygen (2), SBP 104 (1), HR 108 (1), alert (0), T 38.6 (1) = 9.
  const r = C.news2({ rr: 24, spo2: 92, on_oxygen: true, sbp: 104, hr: 108, avpu: 'A', temp: 38.6 });
  assert.equal(r.score, 9);
  assert.equal(r.risk, 'high');
});

test('an incomplete set is reported as incomplete, never as reassuring', () => {
  const a = C.assess({ department: 'IM', age: '67y' }, { sbp: 128, dbp: 76, hr: 96, spo2: 95 });
  assert.equal(a.scheme, 'NEWS2');
  assert.match(a.badge, /\+$/);
  assert.match(a.detail, /missing resp\. rate.*temperature/);
});

test('children: an 8-month-old with SpO2 91 and RR 58 is flagged (finding F1)', () => {
  const a = C.assess({ department: 'PEDS', age: '8 months' }, { hr: 156, rr: 58, temp: 37.9, spo2: 91 });
  assert.equal(a.scheme, 'PAEDS');
  assert.equal(a.flags.spo2, 'crit');
  assert.equal(a.flags.rr, 'warn');
  assert.equal(a.flags.hr, undefined);           // 156 is normal under 1 year
  assert.equal(a.level, 'crit');
  assert.ok(a.reasons.some(r => /fast breathing by WHO/.test(r)));
});

test('children: ranges move with age, and age under 16 outside Pediatrics still uses child ranges', () => {
  assert.equal(C.assess({ department: 'PEDS', age: '10y' }, { hr: 130 }).flags.hr, 'warn');
  assert.equal(C.assess({ department: 'PEDS', age: '6 months' }, { hr: 130 }).flags.hr, undefined);
  assert.equal(C.assess({ department: 'ER', age: '7y' }, { hr: 90 }).scheme, 'PAEDS');
  assert.equal(C.assess({ department: 'PEDS', age: '4y' }, { sbp: 70 }).flags.sbp, 'crit');
  const noAge = C.assess({ department: 'PEDS', age: '' }, { spo2: 90 });
  assert.equal(noAge.flags.spo2, 'crit');
  assert.match(noAge.badge, /add age/);
});

test('obstetrics: pre-eclampsia BP 152/98 gives two yellows and triggers review (finding F3)', () => {
  const a = C.assess({ department: 'OBGYN', age: '31y' }, { sbp: 152, dbp: 98, hr: 88, rr: 18, temp: 36.8, spo2: 98, avpu: 'A' });
  assert.equal(a.scheme, 'MEOWS');
  assert.equal(a.flags.sbp, 'warn');
  assert.equal(a.flags.dbp, 'warn');
  assert.equal(a.level, 'crit');
  assert.match(a.action, /obstetric/);
  assert.equal(C.assess({ department: 'OBGYN' }, { sbp: 162, dbp: 85 }).flags.sbp, 'crit');
  assert.equal(C.assess({ department: 'OBGYN' }, { sbp: 120, dbp: 75, spo2: 98 }).level, 'ok');
});

test('the latest value of each sign survives a partial newest set (finding F2)', () => {
  const v = [
    { recorded_at: '2026-11-12T10:00:00Z', sbp: 128, dbp: 76, hr: 96, spo2: 95 },
    { recorded_at: '2026-11-12T06:00:00Z', sbp: 104, dbp: 62, hr: 108, rr: 24, temp: 38.6, spo2: 92 },
  ];
  const l = C.latestBySign(v);
  assert.equal(l.hr.value, 96);
  assert.equal(l.rr.value, 24);
  assert.equal(l.rr.at, '2026-11-12T06:00:00Z');
  assert.equal(l.sbp.dbpWith, 76);
});

test('initials skip titles and bracketed text (findings F4, F5)', () => {
  assert.equal(C.initials('Amani K. (demo)'), 'A.K.');
  assert.equal(C.initials('Dr. Demo Intern'), 'D.I.');
  assert.equal(C.initials("Jean-Paul N'Dayisaba"), 'J.N.');
  assert.equal(C.initials('Prof. Uwase'), 'U.');
  assert.equal(C.initials(''), '—');
});

test('the one-liner reads as a sentence (finding F6)', () => {
  const s = C.oneLiner({ age: '35y', sex: 'Male', admitted_at: '2026-11-12', clinical: { complaint: 'Road traffic accident', dx: 'Blunt abdominal trauma', pmh: 'HIV on ART' } }, '2026-11-12');
  assert.equal(s, '35y male with HIV on ART, presenting with road traffic accident. Hospital day 1. Working diagnosis: blunt abdominal trauma.');
  assert.equal(C.plural(1, 'patient'), '1 patient');
  assert.equal(C.plural(3, 'patient'), '3 patients');
});
