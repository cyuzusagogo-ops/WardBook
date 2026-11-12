import express from 'express';
import { withContext } from '../db.js';
import { HttpError, clean } from '../http.js';
import { need, hashPassword, tempPassword } from '../auth.js';
import { ROLES, DEPARTMENTS } from '../permissions.js';

function cleanDepartments(list) {
  const arr = Array.isArray(list) ? list : [];
  return [...new Set(arr.filter(d => d === 'ALL' || DEPARTMENTS[d]))];
}

export function adminRoutes(pool) {
  const r = express.Router();
  const tx = (req, fn) => withContext(pool, req.ctx, fn);
  r.use(need('manageStaff', 'Only a hospital admin can manage staff.'));

  r.get('/staff', async (req, res, next) => {
    try { res.json(await tx(req, async db => (await db.query('SELECT * FROM app.admin_staff()')).rows)); } catch (e) { next(e); }
  });

  r.post('/staff', async (req, res, next) => {
    try {
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      const fullName = clean.short(b.fullName);
      if (!fullName) throw new HttpError(400, 'Enter the person’s full name.');
      if (!ROLES[b.role]) throw new HttpError(400, 'Choose a role.');
      const departments = cleanDepartments(b.departments);
      if (!['hospital_admin', 'auditor', 'student'].includes(b.role) && !departments.length) {
        throw new HttpError(400, 'Choose at least one department for this role.');
      }
      const pw = tempPassword();
      const row = await tx(req, async db => (await db.query('SELECT * FROM app.admin_add_staff($1,$2,$3,$4,$5,$6)',
        [email, fullName, await hashPassword(pw), b.role, departments, clean.date(b.validUntil)])).rows[0]);
      res.status(201).json({ userId: row.user_id, created: row.created, tempPassword: row.created ? pw : null });
    } catch (e) { next(e); }
  });

  r.patch('/memberships/:id', async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const b = req.body || {};
      const sets = [], values = [];
      if ('role' in b) { if (!ROLES[b.role]) throw new HttpError(400, 'Choose a role.'); sets.push('role'); values.push(b.role); }
      if ('departments' in b) { sets.push('departments'); values.push(cleanDepartments(b.departments)); }
      if ('active' in b) { sets.push('active'); values.push(!!b.active); }
      if ('validUntil' in b) { sets.push('valid_until'); values.push(clean.date(b.validUntil)); }
      if (!sets.length) throw new HttpError(400, 'Nothing to change.');
      const n = await tx(req, async db => (await db.query(
        `UPDATE memberships SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...values])).rowCount);
      if (!n) throw new HttpError(403, 'You cannot change this membership (it may be your own).');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/users/:id/reset', async (req, res, next) => {
    try {
      const id = clean.uuid(req.params.id);
      const pw = req.body?.password ? tempPassword() : null;
      const hash = pw ? await hashPassword(pw) : null;
      await tx(req, db => db.query('SELECT app.admin_reset_account($1,$2,$3)', [id, hash, !!req.body?.twoStep]));
      res.json({ tempPassword: pw });
    } catch (e) { next(e); }
  });

  r.patch('/hospital', async (req, res, next) => {
    try {
      await tx(req, db => db.query('UPDATE hospitals SET ai_enabled = $1 WHERE id = app.hid()', [!!req.body?.aiEnabled]));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
