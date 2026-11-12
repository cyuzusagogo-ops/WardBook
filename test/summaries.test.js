import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseText, templateSummary, makeScrubber } from '../src/summaries.js';

const patient = {
  name: 'Jean Uwimana', hospital_number: 'KUTH-77812', age: '54y', sex: 'Male', department: 'IM',
  admitted_at: '2026-11-10', status: 'watch', allergies: 'Penicillin',
  clinical: {
    complaint: 'Chest pain', hpi: 'Jean says pain began 2026-11-09; wife (call +250 788 123 456) brought him in. Email jean@example.com',
    dx: 'Unstable angina', plan: 'Aspirin, review by Uwimana family on 11/11/2026',
  },
};

test('the text sent to the AI carries no name, hospital number, phone, email or calendar date', () => {
  const text = caseText({ patient, vitals: [{ recorded_at: '2026-11-11T06:00:00Z', sbp: 150, dbp: 90, hr: 98 }], notes: [], tasks: [] });
  for (const leak of ['Jean', 'Uwimana', 'KUTH-77812', '788 123', 'jean@example.com', '2026-11-09', '11/11/2026', '2026-11-11']) {
    assert.ok(!text.includes(leak), `leaked ${leak}:\n${text}`);
  }
  assert.match(text, /\[patient\] says pain/);
  assert.match(text, /day 2 06:00: BP 150\/90/);
  assert.match(text, /Unstable angina/);
});

test('scrubber leaves clinical numbers alone', () => {
  const s = makeScrubber(patient);
  assert.equal(s('Hb 9.8; WBC 14.2; Na 131'), 'Hb 9.8; WBC 14.2; Na 131');
});

test('template summary uses only recorded facts and marks gaps', () => {
  const t = templateSummary({ patient: { ...patient, clinical: { complaint: 'Chest pain' } }, vitals: [], notes: [], tasks: [{ text: 'ECG', done: false }] });
  assert.match(t, /PLAN\nnot documented/);
  assert.match(t, /PENDING\n- ECG/);
});
