// Demo hospitals, staff and fake patients. Used by `npm run seed:demo` and by the tests.
// Every demo patient name ends in "(demo)"; never load this into a database with real data.
import pg from 'pg';
import { hashPassword } from '../src/auth.js';

export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const STAFF = [
  ['admin',     'Demo Admin',            'hospital_admin',     []],
  ['intern',    'Dr. Demo Intern',       'intern',             ['IM', 'ER']],
  ['resident',  'Dr. Demo Resident',     'resident',           ['IM', 'SURGERY', 'ER']],
  ['attending', 'Dr. Demo Attending',    'attending',          ['ALL']],
  ['hod',       'Dr. Demo Head of IM',   'head_of_department', ['IM']],
  ['nurse',     'Demo Nurse',            'nurse',              ['IM']],
  ['student',   'Demo Student',          'student',            []],
  ['auditor',   'Demo Auditor',          'auditor',            []],
  ['peds',      'Dr. Demo Paediatrician','attending',          ['PEDS', 'OBGYN']],
];

const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

export async function seedDemo(ownerUrl, { password, domain = 'demo.wardbook.test', log = console.log } = {}) {
  const db = new pg.Client({ connectionString: ownerUrl });
  await db.connect();
  const ids = { users: {}, patients: {} };
  try {
    await db.query('BEGIN');
    const hash = await hashPassword(password);
    const hA = (await db.query("INSERT INTO hospitals (name, ai_enabled) VALUES ('Demo Teaching Hospital', true) RETURNING id")).rows[0].id;
    const hB = (await db.query("INSERT INTO hospitals (name) VALUES ('Demo District Hospital') RETURNING id")).rows[0].id;
    ids.hospitalA = hA; ids.hospitalB = hB;

    const addUser = async (key, name) => {
      const email = `${key}@${domain}`;
      const id = (await db.query(`INSERT INTO auth.users (email, full_name, password_hash, must_change_password, totp_secret, totp_enabled)
        VALUES ($1,$2,$3,false,$4,true) RETURNING id`, [email, name, hash, DEMO_TOTP_SECRET])).rows[0].id;
      ids.users[key] = { id, email };
      return id;
    };
    for (const [key, name, role, depts] of STAFF) {
      const id = await addUser(key, name);
      await db.query('INSERT INTO memberships (user_id, hospital_id, role, departments) VALUES ($1,$2,$3,$4)', [id, hA, role, depts]);
    }
    // A member of Hospital B only, and the A intern also covering shifts at B.
    const bId = await addUser('district', 'Dr. Demo District Intern');
    await db.query("INSERT INTO memberships (user_id, hospital_id, role, departments) VALUES ($1,$2,'intern','{IM,ER}')", [bId, hB]);
    await db.query("INSERT INTO memberships (user_id, hospital_id, role, departments) VALUES ($1,$2,'intern','{ER}')", [ids.users.intern.id, hB]);
    const bAdmin = await addUser('districtadmin', 'Demo District Admin');
    await db.query("INSERT INTO memberships (user_id, hospital_id, role) VALUES ($1,$2,'hospital_admin')", [bAdmin, hB]);

    const by = ids.users.intern.id;
    const addPatient = async (key, hospital, p) => {
      const id = (await db.query(`INSERT INTO patients (hospital_id, hospital_number, name, sex, age, department, ward, bed, status,
          admitted_at, allergies, clinical, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [hospital, p.no, p.name, p.sex, p.age, p.dept, p.ward, p.bed, p.status, p.admitted, p.allergies, p.clinical, by])).rows[0].id;
      ids.patients[key] = id;
      for (const v of p.vitals || []) {
        const [hours, sbp, dbp, hr, rr, temp, spo2, gcs, weight, onOxygen = null, avpu = null] = v;
        await db.query(`INSERT INTO vitals (hospital_id, patient_id, recorded_at, sbp, dbp, hr, rr, temp, spo2, gcs, weight_kg, on_oxygen, avpu, recorded_by)
          VALUES ($1,$2,now() - make_interval(hours => $3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [hospital, id, hours, sbp, dbp, hr, rr, temp, spo2, gcs, weight, onOxygen, avpu, by]);
      }
      for (const t of p.tasks || []) await db.query('INSERT INTO tasks (hospital_id, patient_id, text, created_by) VALUES ($1,$2,$3,$4)', [hospital, id, t, by]);
      for (const n of p.notes || []) {
        await db.query('INSERT INTO notes (hospital_id, patient_id, kind, note_date, s, o, a, p, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [hospital, id, 'soap', n.date, n.s, n.o, n.a, n.p, by]);
      }
      return id;
    };

    await addPatient('im', hA, {
      no: 'DEMO-1042', name: 'Amani K. (demo)', sex: 'Male', age: '67y', dept: 'IM', ward: 'Medical 1', bed: '4', status: 'watch',
      admitted: daysAgo(2), allergies: 'Penicillin (rash)',
      clinical: { complaint: 'Fever and productive cough for 4 days', hpi: 'Worsening breathlessness, rusty sputum and right-sided pleuritic chest pain. No haemoptysis.',
        pmh: 'Type 2 diabetes\nHypertension', meds: 'Metformin 1 g twice daily\nAmlodipine 5 mg daily', social: 'Retired teacher, lives with his wife, non-smoker',
        exam: 'Bronchial breathing and crackles right lower zone. Dry mucous membranes.', labs: 'WBC 16.4; CRP 182; Urea 9.1; Creatinine 128; Glucose 14.2',
        imaging: 'Chest X-ray: right lower lobe consolidation', dx: 'Community-acquired pneumonia, CURB-65 score 3', ddx: 'Pulmonary embolism\nLung abscess',
        problems: 'Pneumonia\nHyperglycaemia\nRisk of acute kidney injury', plan: 'Ceftriaxone and azithromycin (penicillin allergy noted)\nIV fluids, fluid balance chart\nInsulin sliding scale, hold metformin\nRepeat urea and electrolytes tomorrow', sp: {} },
      vitals: [[2, 104, 62, 108, 24, 38.6, 92, 15, 78, true, 'A'], [14, 110, 68, 112, 26, 38.9, 91, 15, null, true, 'A']],
      tasks: ['Chase blood cultures', 'Repeat urea and electrolytes in the morning'],
      notes: [{ date: daysAgo(1), s: 'Slept poorly, still breathless.', o: 'T 38.9, SpO2 91% on 2 L.', a: 'Not yet improving on day 1 of antibiotics.', p: 'Continue antibiotics, oxygen to target 94-98%, review cultures.' }],
    });
    await addPatient('surgery', hA, {
      no: 'DEMO-2088', name: 'Grace U. (demo)', sex: 'Female', age: '24y', dept: 'SURGERY', ward: 'Surgical 2', bed: 'S2', status: 'improving',
      admitted: daysAgo(1), allergies: 'No known drug allergies',
      clinical: { complaint: 'Right iliac fossa pain for 1 day', pmh: 'None', exam: 'Soft abdomen, mild port-site tenderness.', labs: 'Hb 12.6; WBC 11.0',
        dx: 'Acute appendicitis, after laparoscopic appendicectomy', plan: 'Oral diet as tolerated\nOral analgesia\nMobilise\nDischarge tomorrow if tolerating diet',
        sp: { procedure: 'Laparoscopic appendicectomy', opDate: daysAgo(1), opFindings: 'Inflamed, non-perforated appendix' } },
      vitals: [[3, 118, 74, 86, 16, 37.4, 99, 15, 61, false, 'A']],
    });
    await addPatient('er', hA, {
      no: 'DEMO-3015', name: 'Eric M. (demo)', sex: 'Male', age: '35y', dept: 'ER', ward: 'Resus', bed: 'R1', status: 'critical',
      admitted: daysAgo(0), allergies: 'No known drug allergies',
      clinical: { complaint: 'Road traffic accident, motorcycle rider', exam: 'GCS 13, tender left upper quadrant, abrasions to left arm.',
        dx: 'Blunt abdominal trauma, suspected splenic injury', plan: 'Two large-bore IV lines, crossmatch 4 units\nFAST scan\nSurgical review now',
        sp: { triage: 'Red', arrival: '02:40', erTx: '1 L Ringer lactate, IV paracetamol' } },
      vitals: [[1, 92, 58, 124, 24, 36.4, 96, 13, null, false, 'C']],
      tasks: ['Surgical review', 'FAST scan result'],
    });
    await addPatient('peds', hA, {
      no: 'DEMO-4011', name: 'Baby Keza (demo)', sex: 'Female', age: '8 months', dept: 'PEDS', ward: 'Paediatrics', bed: 'P7', status: 'watch',
      admitted: daysAgo(1), allergies: 'No known drug allergies',
      clinical: { complaint: 'Cough and fast breathing for 2 days', exam: 'Subcostal recession, bilateral wheeze.', dx: 'Bronchiolitis',
        plan: 'Nasal oxygen to keep SpO2 above 92%\nNasogastric feeds if poor intake', sp: { birthHx: 'Term, vaginal delivery, 3.1 kg', immun: 'Up to date for age' } },
      vitals: [[2, null, null, 156, 58, 37.9, 91, null, 7.8, false, 'A']],
    });
    await addPatient('obgyn', hA, {
      no: 'DEMO-5004', name: 'Diane M. (demo)', sex: 'Female', age: '31y', dept: 'OBGYN', ward: 'Maternity', bed: 'L7', status: 'watch',
      admitted: daysAgo(0), allergies: 'No known drug allergies',
      clinical: { complaint: 'Headache and leg swelling', labs: 'Urine protein 2+; Platelets 168; ALT 32', dx: 'Pre-eclampsia without severe features',
        plan: 'BP every 4 hours\nPre-eclampsia bloods daily\nFetal monitoring\nDiscuss timing of delivery with consultant',
        sp: { gravida: '2', para: '1', lmp: daysAgo(255), fetal: 'FHR 140, active movements, cephalic' } },
      vitals: [[1, 152, 98, 88, 18, 36.8, 98, 15, null, false, 'A']],
    });
    await addPatient('district', hB, {
      no: 'DEMO-9001', name: 'Samuel H. (demo)', sex: 'Male', age: '61y', dept: 'IM', ward: 'Medical', bed: 'B4', status: 'stable',
      admitted: daysAgo(1), allergies: 'No known drug allergies',
      clinical: { complaint: 'Hypoglycaemia and cough', dx: 'Community-acquired pneumonia with hypoglycaemia', sp: {} },
    });
    // The student follows the IM patient for teaching.
    await db.query('INSERT INTO assignments (hospital_id, patient_id, user_id, reason, created_by) VALUES ($1,$2,$3,$4,$5)',
      [hA, ids.patients.im, ids.users.student.id, 'student', ids.users.attending.id]);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
  log(`Demo data loaded: 2 hospitals, ${Object.keys(ids.users).length} staff, ${Object.keys(ids.patients).length} patients.`);
  return ids;
}
