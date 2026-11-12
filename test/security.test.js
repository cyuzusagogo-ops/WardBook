import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, client, asAppRole, nextCode, PASSWORD } from './helpers.js';

let env;
before(async () => { env = await startTestEnv(); });
after(async () => { await env?.close(); });

const ids = () => env.ids;

test('sign-in needs the password and a two-step code; nothing is readable before both', async () => {
  const c = client(env.base);
  const r = await c.post('/api/auth/login', { email: ids().users.hod.email, password: PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.body.stage, 'two_step');
  assert.equal((await c.get('/api/patients')).status, 401);
  assert.equal((await c.post('/api/auth/two-step/verify', { code: '000000' })).status, 400);
  const ok = await c.post('/api/auth/two-step/verify', { code: nextCode('hod') });
  assert.equal(ok.body.stage, 'ready');
  assert.equal((await c.get('/api/patients')).status, 200);
});

test('a used two-step code cannot be replayed', async () => {
  const code = nextCode('peds');
  const a = client(env.base);
  await a.post('/api/auth/login', { email: ids().users.peds.email, password: PASSWORD });
  assert.equal((await a.post('/api/auth/two-step/verify', { code })).status, 200);
  const b = client(env.base);
  await b.post('/api/auth/login', { email: ids().users.peds.email, password: PASSWORD });
  const replay = await b.post('/api/auth/two-step/verify', { code });
  assert.equal(replay.status, 400);
});

test('five wrong passwords lock the account, even for the right password', async () => {
  const c = client(env.base);
  const email = ids().users.districtadmin.email;
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { email, password: 'wrong-password' })).status, 401);
  const locked = await c.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(locked.status, 423);
});

test('state-changing requests without the WardBook header are refused (cross-site protection)', async () => {
  const c = await env.as('intern');
  const r = await c.post('/api/patients', { name: 'X (demo)', department: 'IM' }, { 'x-wardbook': '' });
  assert.equal(r.status, 403);
});

test('hospitals are isolated: Hospital A staff never see Hospital B patients', async () => {
  const c = await env.as('attending');
  const list = (await c.get('/api/patients')).body;
  assert.ok(list.length >= 5);
  assert.ok(!list.some(p => p.id === ids().patients.district));
  assert.equal((await c.get(`/api/patients/${ids().patients.district}`)).status, 404);

  const d = await env.as('district');
  const dl = (await d.get('/api/patients')).body;
  assert.deepEqual(dl.map(p => p.id), [ids().patients.district]);
  assert.equal((await d.get(`/api/patients/${ids().patients.im}`)).status, 404);
});

test('the database itself refuses a forged hospital or a missing identity', async () => {
  const resident = ids().users.resident.id;
  const forged = await asAppRole(env.appUrl, { userId: resident, hospitalId: ids().hospitalB }, 'SELECT id FROM patients');
  assert.equal(forged.rowCount, 0);
  const anon = await asAppRole(env.appUrl, {}, 'SELECT id FROM patients');
  assert.equal(anon.rowCount, 0);
  await assert.rejects(asAppRole(env.appUrl, {}, 'SELECT * FROM auth.users'), /permission denied/);
  await assert.rejects(asAppRole(env.appUrl, { userId: resident, hospitalId: ids().hospitalA },
    "INSERT INTO patients (hospital_id, name, department, created_by) VALUES ($1, 'x', 'IM', $2)", [ids().hospitalB, resident]),
    /row-level security/);
});

test('a person in two hospitals sees only the chosen hospital and their departments there', async () => {
  const c = await env.login('intern', { hospital: 'B' });
  const me = (await c.get('/api/auth/me')).body;
  assert.equal(me.current.hospitalId, ids().hospitalB);
  // In Hospital B this intern is on ER only; the B patient is in IM.
  assert.deepEqual((await c.get('/api/patients')).body, []);
  assert.equal((await c.post('/api/auth/hospital', { hospitalId: ids().hospitalA })).status, 200);
  assert.ok((await c.get('/api/patients')).body.some(p => p.id === ids().patients.im));
  assert.equal((await c.post('/api/auth/hospital', { hospitalId: '00000000-0000-0000-0000-000000000000' })).status, 403);
});

test('departments limit what staff see', async () => {
  const intern = await env.as('intern');               // IM + ER
  const seen = (await intern.get('/api/patients')).body.map(p => p.id);
  assert.ok(seen.includes(ids().patients.im) && seen.includes(ids().patients.er));
  assert.ok(!seen.includes(ids().patients.surgery) && !seen.includes(ids().patients.peds));
  assert.equal((await intern.get(`/api/patients/${ids().patients.surgery}`)).status, 404);
  const r = await intern.post('/api/patients', { name: 'Test (demo)', department: 'SURGERY' });
  assert.equal(r.status, 403);
});

test('students see only assigned patients, de-identified, and cannot change the record', async () => {
  const s = await env.as('student');
  const list = (await s.get('/api/patients')).body;
  assert.deepEqual(list.map(p => p.id), [ids().patients.im]);
  assert.equal(list[0].hospital_number, null);
  assert.ok(!list[0].name.includes('Amani'));
  const file = (await s.get(`/api/patients/${ids().patients.im}`)).body;
  assert.ok(!JSON.stringify(file.patient).includes('Amani'));
  assert.equal((await s.post('/api/patients', { name: 'X', department: 'IM' })).status, 403);
  assert.equal((await s.patch(`/api/patients/${ids().patients.im}`, { version: file.patient.version, allergies: 'none' })).status, 403);
  const note = await s.post(`/api/patients/${ids().patients.im}/notes`, { s: 'Learning note' });
  assert.equal(note.status, 201);
  assert.equal(note.body.kind, 'student');
});

test('nurses record vitals and tasks but cannot edit the medical file', async () => {
  const n = await env.as('nurse');
  const file = (await n.get(`/api/patients/${ids().patients.im}`)).body;
  assert.equal((await n.post(`/api/patients/${ids().patients.im}/vitals`, { sbp: 120, dbp: 70, hr: 90 })).status, 201);
  assert.equal((await n.post(`/api/patients/${ids().patients.im}/tasks`, { text: 'Turn every 2 hours' })).status, 201);
  assert.equal((await n.patch(`/api/patients/${ids().patients.im}`, { version: file.patient.version, clinical: { dx: 'changed' } })).status, 403);
  const direct = await asAppRole(env.appUrl, { userId: ids().users.nurse.id, hospitalId: ids().hospitalA },
    "UPDATE patients SET allergies = 'none' WHERE id = $1", [ids().patients.im]);
  assert.equal(direct.rowCount, 0);
});

test('auditors can read everything in their hospital but change nothing', async () => {
  const a = await env.as('auditor');
  const list = (await a.get('/api/patients')).body;
  assert.equal(list.length, 5);
  assert.equal((await a.post(`/api/patients/${ids().patients.im}/vitals`, { hr: 80 })).status, 403);
  assert.equal((await a.post(`/api/patients/${ids().patients.im}/notes`, { s: 'x' })).status, 403);
  assert.equal((await a.get('/api/audit')).status, 200);
});

test('hospital admins manage staff but see no clinical records and cannot change their own access', async () => {
  const adm = await env.as('admin');
  assert.equal((await adm.get('/api/patients')).status, 403);
  const direct = await asAppRole(env.appUrl, { userId: ids().users.admin.id, hospitalId: ids().hospitalA }, 'SELECT id FROM patients');
  assert.equal(direct.rowCount, 0);
  const staff = (await adm.get('/api/admin/staff')).body;
  const own = staff.find(s => s.user_id === ids().users.admin.id);
  assert.equal((await adm.patch(`/api/admin/memberships/${own.membership_id}`, { role: 'attending', departments: ['ALL'] })).status, 403);
  const added = await adm.post('/api/admin/staff', { email: 'new.intern@demo.wardbook.test', fullName: 'New Intern', role: 'intern', departments: ['PEDS'] });
  assert.equal(added.status, 201);
  assert.ok(added.body.tempPassword.length >= 12);
  // New staff must change the temporary password, then set up two-step sign-in.
  const c = client(env.base);
  const r = await c.post('/api/auth/login', { email: 'new.intern@demo.wardbook.test', password: added.body.tempPassword });
  assert.equal(r.body.stage, 'change_password');
  assert.equal((await c.get('/api/patients')).status, 401);
  const r2 = await c.post('/api/auth/password', { current: added.body.tempPassword, next: 'a long new passphrase' });
  assert.equal(r2.body.stage, 'setup_two_step');
  const setup = await c.post('/api/auth/two-step/setup');
  assert.match(setup.body.qrSvg, /<svg/);
});

test('removing someone from a hospital cuts them off on their very next request', async () => {
  const doc = await env.login('hod');
  assert.equal((await doc.get('/api/patients')).status, 200);
  const adm = await env.as('admin');
  const m = (await adm.get('/api/admin/staff')).body.find(s => s.user_id === ids().users.hod.id);
  assert.equal((await adm.patch(`/api/admin/memberships/${m.membership_id}`, { active: false })).status, 200);
  assert.equal((await doc.get('/api/patients')).status, 401);
  await adm.patch(`/api/admin/memberships/${m.membership_id}`, { active: true });
});

test('two people saving the same file: the second save is refused, nothing is overwritten', async () => {
  const a = await env.as('intern');
  const b = await env.as('attending');
  const id = ids().patients.er;
  const v = (await a.get(`/api/patients/${id}`)).body.patient.version;
  const first = await a.patch(`/api/patients/${id}`, { version: v, bed: 'R2' });
  assert.equal(first.status, 200);
  const second = await b.patch(`/api/patients/${id}`, { version: v, bed: 'R3' });
  assert.equal(second.status, 409);
  assert.equal(second.body.currentVersion, first.body.version);
  assert.equal((await b.get(`/api/patients/${id}`)).body.patient.bed, 'R2');
});

test('notes: interns cannot sign; signed notes cannot change; corrections are addenda', async () => {
  const intern = await env.as('intern');
  const resident = await env.as('resident');
  const id = ids().patients.im;
  const note = (await intern.post(`/api/patients/${id}/notes`, { s: 'Feels better', p: 'Continue' })).body;
  assert.equal((await intern.post(`/api/notes/${note.id}/sign`)).status, 403);
  assert.equal((await intern.patch(`/api/notes/${note.id}`, { s: 'Feels much better', p: 'Continue' })).status, 200);
  assert.equal((await resident.patch(`/api/notes/${note.id}`, { s: 'rewritten by someone else' })).status, 404);
  const signed = await resident.post(`/api/notes/${note.id}/sign`);
  assert.equal(signed.status, 200);
  assert.equal(signed.body.signed_by, ids().users.resident.id);
  assert.equal((await intern.patch(`/api/notes/${note.id}`, { s: 'changed after signing' })).status, 403);
  const add = await intern.post(`/api/notes/${note.id}/addendum`, { text: 'Correction: temperature was 37.8' });
  assert.equal(add.status, 201);
  assert.equal(add.body.addendum_of, note.id);
});

test('interns cannot discharge; residents can', async () => {
  const intern = await env.as('intern');
  const resident = await env.as('resident');
  const id = ids().patients.im;
  let v = (await intern.get(`/api/patients/${id}`)).body.patient.version;
  assert.equal((await intern.post(`/api/patients/${id}/discharge`, { version: v })).status, 403);
  const direct = asAppRole(env.appUrl, { userId: ids().users.intern.id, hospitalId: ids().hospitalA },
    "UPDATE patients SET status = 'discharged' WHERE id = $1", [id]);
  await assert.rejects(direct, /only a resident/);
  v = (await resident.get(`/api/patients/${id}`)).body.patient.version;
  assert.equal((await resident.post(`/api/patients/${id}/discharge`, { version: v })).status, 200);
  const dc = (await resident.get('/api/patients?status=discharged')).body;
  assert.ok(dc.some(p => p.id === id));
  v = (await resident.get(`/api/patients/${id}`)).body.patient.version;
  assert.equal((await resident.post(`/api/patients/${id}/readmit`, { version: v })).status, 200);
});

test('transfers move the patient and are recorded; the new team gets access', async () => {
  const intern = await env.as('intern');      // IM + ER
  const resident = await env.as('resident');  // IM + SURGERY + ER
  const created = await intern.post('/api/patients', { name: 'Transfer Test (demo)', department: 'ER', bed: 'R5' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const v = (await intern.get(`/api/patients/${id}`)).body.patient.version;
  assert.equal((await intern.post(`/api/patients/${id}/transfer`, { to: 'SURGERY', version: v, note: 'For laparotomy' })).status, 200);
  assert.equal((await intern.get(`/api/patients/${id}`)).status, 404);
  const file = (await resident.get(`/api/patients/${id}`)).body;
  assert.equal(file.patient.department, 'SURGERY');
  assert.equal(file.transfers[0].from_dept, 'ER');
});

test('consults: assigning a doctor from another department gives them access to that patient only', async () => {
  const attending = await env.as('attending');
  const peds = await env.as('peds');          // PEDS + OBGYN
  assert.equal((await peds.get(`/api/patients/${ids().patients.er}`)).status, 404);
  const a = await attending.post(`/api/patients/${ids().patients.er}/assignments`, { userId: ids().users.peds.id, reason: 'consult' });
  assert.equal(a.status, 201);
  assert.equal((await peds.get(`/api/patients/${ids().patients.er}`)).status, 200);
  assert.equal((await peds.get(`/api/patients/${ids().patients.surgery}`)).status, 404);
  const outsider = await attending.post(`/api/patients/${ids().patients.er}/assignments`, { userId: ids().users.district.id });
  assert.equal(outsider.status, 400);
});

test('the audit log records views and edits, and nobody can change or delete it', async () => {
  const hod = await env.login('attending');
  await hod.get(`/api/patients/${ids().patients.peds}`);
  const auditor = await env.as('auditor');
  const log = (await auditor.get(`/api/audit?patient=${ids().patients.peds}`)).body.rows;
  assert.ok(log.some(r => r.action === 'view' && r.actor_id === ids().users.attending.id));
  const edits = (await auditor.get(`/api/audit?patient=${ids().patients.er}`)).body.rows;
  assert.ok(edits.some(r => r.action === 'update' && r.entity === 'patients'));
  await assert.rejects(asAppRole(env.appUrl, { userId: ids().users.auditor.id, hospitalId: ids().hospitalA }, 'DELETE FROM audit_log'), /permission denied/);
  await assert.rejects(env.owner.query("UPDATE audit_log SET action = 'x'"), /append-only/);
  await assert.rejects(env.owner.query('DELETE FROM audit_log'), /append-only/);
  const nurse = await env.as('nurse');
  assert.equal((await nurse.get('/api/audit')).status, 403);
});

test('sessions end after the idle limit', async () => {
  const c = await env.login('resident');
  assert.equal((await c.get('/api/patients')).status, 200);
  await env.owner.query("UPDATE auth.sessions SET last_seen = now() - interval '16 minutes' WHERE user_id = $1", [ids().users.resident.id]);
  assert.equal((await c.get('/api/patients')).status, 401);
});

test('summaries: template when AI is unavailable; acceptance is recorded and final', async () => {
  const intern = await env.login('intern');
  const r = await intern.post(`/api/patients/${ids().patients.er}/summaries`, { kind: 'handover' });
  assert.equal(r.status, 201);
  assert.equal(r.body.source, 'template');
  assert.match(r.body.text, /ONE-LINER/);
  const acc = await intern.post(`/api/summaries/${r.body.id}/accept`);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.accepted_by, ids().users.intern.id);
  assert.equal((await intern.post(`/api/summaries/${r.body.id}/accept`)).status, 403);
});

test('the web app is served with a strict content security policy', async () => {
  const res = await fetch(env.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await res.text(), /<title>WardBook<\/title>/);
});
