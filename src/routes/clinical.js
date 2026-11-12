import express from 'express';
import { withContext } from '../db.js';
import { HttpError, clean } from '../http.js';
import { need } from '../auth.js';
import { DEPARTMENTS, noteKindFor } from '../permissions.js';
import { SUMMARY_KINDS, aiConfigured, aiSummary, templateSummary, aiErrorMessage } from '../summaries.js';

const STATUSES = ['stable', 'improving', 'watch', 'critical', 'ready_for_discharge'];
const CLINICAL_KEYS = ['complaint', 'hpi', 'pmh', 'psh', 'meds', 'social', 'family', 'exam', 'labs', 'imaging',
  'dx', 'ddx', 'problems', 'plan'];
const SPECIALTY_KEYS = ['gravida', 'para', 'lmp', 'anc', 'fetal', 'birthHx', 'immun', 'feeding', 'dev',
  'procedure', 'opDate', 'opFindings', 'drains', 'triage', 'arrival', 'erTx', 'dispo'];

function cleanClinical(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object') throw new HttpError(400, 'Clinical details must be an object.');
  const out = {};
  for (const k of CLINICAL_KEYS) { const v = clean.text(input[k]); if (v) out[k] = v; }
  const sp = {};
  for (const k of SPECIALTY_KEYS) {
    const v = k === 'lmp' || k === 'opDate' ? clean.date(input.sp?.[k]) : clean.str(input.sp?.[k], 4000);
    if (v) sp[k] = v;
  }
  out.sp = sp;
  return out;
}

const initials = name => String(name || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + '.').join('') || '—';

// Students see initials only and no hospital number; the same applies when de-identified view is on.
function present(p, member) {
  if (!member.perms.deidentified) return p;
  return { ...p, name: initials(p.name), hospital_number: null, dob: null };
}

async function audit(db, ctx, action, entity, entityId, detail = {}) {
  await db.query('INSERT INTO audit_log (hospital_id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [ctx.hospitalId, ctx.userId, action, entity, entityId, detail]);
}

async function loadRecord(db, id) {
  const p = (await db.query('SELECT * FROM patients WHERE id = $1', [id])).rows[0];
  if (!p) throw new HttpError(404, 'This patient is not in your list. They may be in another department, or you may not have access.');
  // One connection runs one query at a time, so these run in sequence.
  const rows = async (sql) => (await db.query(sql, [id])).rows;
  const vitals = await rows('SELECT * FROM vitals WHERE patient_id = $1 ORDER BY recorded_at DESC LIMIT 60');
  const notes = await rows('SELECT * FROM notes WHERE patient_id = $1 ORDER BY note_date DESC, created_at DESC');
  const tasks = await rows('SELECT * FROM tasks WHERE patient_id = $1 ORDER BY done, created_at');
  const transfers = await rows('SELECT * FROM transfers WHERE patient_id = $1 ORDER BY at DESC');
  const assignments = await rows('SELECT * FROM assignments WHERE patient_id = $1 ORDER BY created_at');
  const summaries = await rows('SELECT * FROM summaries WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10');
  return { patient: p, vitals, notes, tasks, transfers, assignments, summaries };
}

async function people(db) {
  const rows = (await db.query('SELECT * FROM app.people()')).rows;
  return Object.fromEntries(rows.map(r => [r.id, { name: r.full_name, role: r.role }]));
}

// Optimistic concurrency: the update only applies if nobody saved since this person loaded the file.
async function updateWithVersion(db, id, version, sets, values) {
  if (!Number.isInteger(version)) throw new HttpError(400, 'Missing the version of the file you edited. Reload and try again.');
  const r = await db.query(
    `UPDATE patients SET ${sets.map((s, i) => `${s} = $${i + 3}`).join(', ')} WHERE id = $1 AND version = $2`,
    [id, version, ...values]);
  if (r.rowCount === 0) {
    const cur = (await db.query('SELECT version FROM patients WHERE id = $1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'This patient is not in your list.');
    throw new HttpError(409, 'Someone else saved this file after you opened it. Reload to see their changes, then make yours again.', { currentVersion: cur.version });
  }
}

export function clinicalRoutes(pool) {
  const r = express.Router();
  const tx = (req, fn) => withContext(pool, req.ctx, fn);

  r.get('/people', async (req, res, next) => {
    try { res.json(await tx(req, async db => (await db.query('SELECT * FROM app.people()')).rows)); } catch (e) { next(e); }
  });

  r.get('/patients', need('seePatients', 'Your role does not include patient records.'), async (req, res, next) => {
    try {
      const discharged = req.query.status === 'discharged';
      const dept = req.query.department && DEPARTMENTS[req.query.department] ? req.query.department : null;
      const rows = await tx(req, async db => (await db.query(`
        SELECT p.id, p.name, p.hospital_number, p.sex, p.age, p.department, p.ward, p.bed, p.status, p.admitted_at,
               p.discharged_at, p.allergies, p.version, p.updated_at,
               p.clinical->>'dx' AS dx, p.clinical->>'complaint' AS complaint, p.clinical->'sp' AS sp,
               (SELECT count(*)::int FROM tasks t WHERE t.patient_id = p.id AND NOT t.done) AS open_tasks,
               (SELECT max(n.note_date) FROM notes n WHERE n.patient_id = p.id) AS last_note,
               (SELECT row_to_json(v) FROM (SELECT sbp, dbp, hr, rr, temp, spo2, recorded_at FROM vitals v
                  WHERE v.patient_id = p.id ORDER BY recorded_at DESC LIMIT 1) v) AS last_vitals
        FROM patients p
        WHERE (p.status = 'discharged') = $1 AND ($2::text IS NULL OR p.department = $2)
        ORDER BY CASE p.status WHEN 'critical' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, p.bed NULLS LAST, p.name
        LIMIT 500`, [discharged, dept])).rows);
      res.json(rows.map(p => present(p, req.member)));
    } catch (e) { next(e); }
  });

  r.post('/patients', need('admit', 'Your role cannot admit patients.'), async (req, res, next) => {
    try {
      const b = req.body || {};
      const name = clean.short(b.name);
      if (!name) throw new HttpError(400, 'Add the patient’s name or initials.');
      if (!DEPARTMENTS[b.department]) throw new HttpError(400, 'Choose a department.');
      if (!req.member.departments.includes(b.department) && !req.member.departments.includes('ALL')) {
        throw new HttpError(403, `You are not on the ${DEPARTMENTS[b.department]} team in this hospital.`);
      }
      const status = STATUSES.includes(b.status) ? b.status : 'stable';
      const id = await tx(req, async db => (await db.query(`
        INSERT INTO patients (hospital_id, hospital_number, name, sex, age, dob, department, ward, bed, status,
                              admitted_at, allergies, clinical, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::date, current_date),$12,$13,$14) RETURNING id`,
        [req.ctx.hospitalId, clean.short(b.hospital_number), name, clean.short(b.sex), clean.short(b.age), clean.date(b.dob),
          b.department, clean.short(b.ward), clean.short(b.bed), status, clean.date(b.admitted_at), clean.str(b.allergies, 2000),
          cleanClinical(b.clinical) || { sp: {} }, req.ctx.userId])).rows[0].id);
      res.status(201).json({ id });
    } catch (e) { next(e); }
  });

  r.get('/patients/:id', need('seePatients'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const out = await tx(req, async db => {
        const rec = await loadRecord(db, id);
        await audit(db, req.ctx, 'view', 'patients', id);
        return { ...rec, people: await people(db) };
      });
      out.patient = present(out.patient, req.member);
      res.json(out);
    } catch (e) { next(e); }
  });

  r.patch('/patients/:id', need('editClinical', 'Your role cannot edit patient files.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const b = req.body || {};
      const sets = [], values = [];
      const put = (col, v) => { sets.push(col); values.push(v); };
      if ('name' in b) { const n = clean.short(b.name); if (!n) throw new HttpError(400, 'The name cannot be empty.'); put('name', n); }
      for (const k of ['hospital_number', 'sex', 'age', 'ward', 'bed']) if (k in b) put(k, clean.short(b[k]));
      if ('allergies' in b) put('allergies', clean.str(b.allergies, 2000));
      if ('dob' in b) put('dob', clean.date(b.dob));
      if ('admitted_at' in b) put('admitted_at', clean.date(b.admitted_at));
      if ('status' in b) {
        if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Use Discharge to discharge a patient.');
        put('status', b.status);
      }
      if ('clinical' in b) put('clinical', cleanClinical(b.clinical));
      if (!sets.length) throw new HttpError(400, 'Nothing to save.');
      const version = await tx(req, async db => {
        await updateWithVersion(db, id, b.version, sets, values);
        return (await db.query('SELECT version FROM patients WHERE id = $1', [id])).rows[0]?.version;
      });
      res.json({ version });
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/transfer', need('transfer', 'Your role cannot transfer patients.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const to = req.body?.to;
      if (!DEPARTMENTS[to]) throw new HttpError(400, 'Choose the department to transfer to.');
      const version = req.body?.version;
      if (!Number.isInteger(version)) throw new HttpError(400, 'Missing the version of the file you edited. Reload and try again.');
      const v = await tx(req, async db => (await db.query('SELECT app.transfer_patient($1,$2,$3,$4,$5,$6) AS v',
        [id, version, to, clean.short(req.body?.ward), clean.short(req.body?.bed), clean.str(req.body?.note, 2000)])).rows[0].v);
      if (v === -1) throw new HttpError(409, 'Someone else saved this file after you opened it. Reload, then transfer again.');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/discharge', need('discharge', 'Only a resident, attending or head of department can discharge.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      await tx(req, db => updateWithVersion(db, id, req.body?.version, ['status', 'discharged_at'], ['discharged', new Date().toISOString().slice(0, 10)]));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/readmit', need('admit', 'Your role cannot readmit patients.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      await tx(req, db => updateWithVersion(db, id, req.body?.version, ['status', 'discharged_at'], ['stable', null]));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/vitals', need('recordVitals', 'Your role cannot record vital signs.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const b = req.body || {};
      const v = {
        sbp: clean.num(b.sbp, 30, 300, 'Systolic BP'), dbp: clean.num(b.dbp, 10, 200, 'Diastolic BP'),
        hr: clean.num(b.hr, 10, 300, 'Heart rate'), rr: clean.num(b.rr, 2, 120, 'Respiratory rate'),
        temp: clean.num(b.temp, 25, 45, 'Temperature'), spo2: clean.num(b.spo2, 30, 100, 'SpO2'),
        gcs: clean.num(b.gcs, 3, 15, 'GCS'), weight_kg: clean.num(b.weight_kg, 0.2, 400, 'Weight'),
        glucose: clean.short(b.glucose), urine: clean.short(b.urine),
      };
      if (Object.values(v).every(x => x == null)) throw new HttpError(400, 'Enter at least one vital sign.');
      const recorded = b.recorded_at ? new Date(b.recorded_at) : new Date();
      if (Number.isNaN(recorded.getTime()) || recorded > new Date(Date.now() + 5 * 60e3)) throw new HttpError(400, 'The time recorded cannot be in the future.');
      const row = await tx(req, async db => (await db.query(`
        INSERT INTO vitals (hospital_id, patient_id, recorded_at, sbp, dbp, hr, rr, temp, spo2, gcs, weight_kg, glucose, urine, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [req.ctx.hospitalId, id, recorded, v.sbp, v.dbp, v.hr, v.rr, v.temp, v.spo2, v.gcs, v.weight_kg, v.glucose, v.urine, req.ctx.userId])).rows[0]);
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/notes', need('writeNotes', 'Your role cannot write notes.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const b = req.body || {};
      const n = { s: clean.text(b.s), o: clean.text(b.o), a: clean.text(b.a), p: clean.text(b.p) };
      if (!n.s && !n.o && !n.a && !n.p) throw new HttpError(400, 'Write at least one of S, O, A or P.');
      const row = await tx(req, async db => (await db.query(`
        INSERT INTO notes (hospital_id, patient_id, kind, note_date, s, o, a, p, author_id)
        VALUES ($1,$2,$3,coalesce($4::date, current_date),$5,$6,$7,$8,$9) RETURNING *`,
        [req.ctx.hospitalId, id, noteKindFor(req.member.role), clean.date(b.note_date), n.s, n.o, n.a, n.p, req.ctx.userId])).rows[0]);
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  r.patch('/notes/:id', need('writeNotes'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const b = req.body || {};
      const row = await tx(req, async db => (await db.query(
        `UPDATE notes SET s = $2, o = $3, a = $4, p = $5 WHERE id = $1 AND author_id = app.uid() RETURNING *`,
        [id, clean.text(b.s), clean.text(b.o), clean.text(b.a), clean.text(b.p)])).rows[0]);
      if (!row) throw new HttpError(404, 'You can only edit your own notes.');
      res.json(row);
    } catch (e) { next(e); }
  });

  r.post('/notes/:id/sign', need('sign', 'Only a resident, attending or head of department can sign notes.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const row = await tx(req, async db => (await db.query(
        'UPDATE notes SET signed_by = app.uid(), signed_at = now() WHERE id = $1 RETURNING *', [id])).rows[0]);
      if (!row) throw new HttpError(404, 'Note not found.');
      res.json(row);
    } catch (e) { next(e); }
  });

  r.post('/notes/:id/addendum', need('writeNotes'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const text = clean.text(req.body?.text);
      if (!text) throw new HttpError(400, 'Write the addendum text.');
      const row = await tx(req, async db => {
        const parent = (await db.query('SELECT patient_id FROM notes WHERE id = $1', [id])).rows[0];
        if (!parent) throw new HttpError(404, 'Note not found.');
        return (await db.query(`INSERT INTO notes (hospital_id, patient_id, kind, s, addendum_of, author_id)
          VALUES ($1,$2,'addendum',$3,$4,$5) RETURNING *`, [req.ctx.hospitalId, parent.patient_id, text, id, req.ctx.userId])).rows[0];
      });
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/tasks', need('manageTasks', 'Your role cannot add tasks.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const text = clean.str(req.body?.text, 1000);
      if (!text) throw new HttpError(400, 'Write the task.');
      const row = await tx(req, async db => (await db.query(
        'INSERT INTO tasks (hospital_id, patient_id, text, due_at, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.ctx.hospitalId, id, text, req.body?.due_at ? new Date(req.body.due_at) : null, req.ctx.userId])).rows[0]);
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  r.patch('/tasks/:id', need('manageTasks', 'Your role cannot change tasks.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const row = await tx(req, async db => (await db.query('UPDATE tasks SET done = $2 WHERE id = $1 RETURNING *', [id, !!req.body?.done])).rows[0]);
      if (!row) throw new HttpError(404, 'Task not found.');
      res.json(row);
    } catch (e) { next(e); }
  });

  r.get('/tasks', need('seePatients'), async (req, res, next) => {
    try {
      const rows = await tx(req, async db => (await db.query(`
        SELECT t.id, t.text, t.due_at, t.created_at, p.id AS patient_id, p.name, p.bed, p.department, p.status
        FROM tasks t JOIN patients p ON p.id = t.patient_id
        WHERE NOT t.done AND p.status <> 'discharged'
        ORDER BY p.department, t.due_at NULLS LAST, t.created_at`)).rows);
      res.json(req.member.perms.deidentified ? rows.map(r => ({ ...r, name: initials(r.name) })) : rows);
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/assignments', need('assign', 'Your role cannot add people to a patient.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const userId = clean.uuid(req.body?.userId);
      const reason = ['consult', 'student', 'cover'].includes(req.body?.reason) ? req.body.reason : 'consult';
      const row = await tx(req, async db => {
        const member = (await db.query('SELECT 1 FROM app.people() WHERE id = $1', [userId])).rowCount;
        if (!member) throw new HttpError(400, 'That person is not staff at this hospital.');
        return (await db.query('INSERT INTO assignments (hospital_id, patient_id, user_id, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [req.ctx.hospitalId, id, userId, reason, req.ctx.userId])).rows[0];
      });
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  r.delete('/assignments/:id', need('assign'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const n = await tx(req, async db => (await db.query('DELETE FROM assignments WHERE id = $1', [id])).rowCount);
      if (!n) throw new HttpError(404, 'Not found.');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/patients/:id/summaries', need('summarize', 'Your role cannot create summaries.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const kind = SUMMARY_KINDS[req.body?.kind] ? req.body.kind : 'attending';
      const useAi = req.body?.source !== 'template' && req.member.aiEnabled && aiConfigured();
      const record = await tx(req, db => loadRecord(db, id));
      let text, source = 'template';
      if (useAi) {
        try { text = await aiSummary(kind, record); source = 'ai'; }
        catch (err) { const m = aiErrorMessage(err); throw new HttpError(m.status, m.message); }
      } else {
        text = templateSummary(record);
      }
      const row = await tx(req, async db => (await db.query(
        'INSERT INTO summaries (hospital_id, patient_id, kind, source, text, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [req.ctx.hospitalId, id, kind, source, text, req.ctx.userId])).rows[0]);
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  r.post('/summaries/:id/accept', need('acceptSummary', 'Only clinicians can accept a summary into the record.'), async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const row = await tx(req, async db => (await db.query('UPDATE summaries SET accepted_by = app.uid() WHERE id = $1 RETURNING *', [id])).rows[0]);
      if (!row) throw new HttpError(404, 'Summary not found.');
      res.json(row);
    } catch (e) { next(e); }
  });

  r.get('/audit', need('viewAudit', 'Your role cannot view the audit log.'), async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const patient = req.query.patient ? clean.uuid(req.query.patient) : null;
      const out = await tx(req, async db => {
        const rows = (await db.query(`
          SELECT id, actor_id, action, entity, entity_id, detail, at FROM audit_log
          WHERE ($1::uuid IS NULL OR entity_id = $1 OR detail->>'patient_id' = $1::text)
          ORDER BY at DESC, id DESC LIMIT $2`, [patient, limit])).rows;
        return { rows, people: await people(db) };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

  return r;
}
