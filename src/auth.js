import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { withContext } from './db.js';
import { HttpError } from './http.js';
import { permissionsFor, ROLES } from './permissions.js';

export const COOKIE = 'wb_session';
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
export const hashPassword = pw => bcrypt.hash(pw, BCRYPT_COST);

export function tempPassword() {
  // 14 characters without look-alikes (0/O, 1/l/I), easy to read out over the phone.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(14);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
  if (pw.length > 200) throw new HttpError(400, 'That password is too long.');
  if (/^(.)\1+$/.test(pw) || /^(password|wardbook|1234567890)/i.test(pw)) {
    throw new HttpError(400, 'That password is too easy to guess. Try a short sentence.');
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`);
}

// Small in-memory limiter for sign-in attempts per IP (the per-account lock lives in the database).
const attempts = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.reset < now) { attempts.set(key, { n: 1, reset: now + windowMs }); return false; }
  rec.n += 1;
  return rec.n > max;
}

export function stageOf(s) {
  if (!s) return 'signed_out';
  if (s.must_change_password) return 'change_password';
  if (!s.totp_enabled) return 'setup_two_step';
  if (!s.mfa_passed) return 'two_step';
  if (!s.hospital_id) return 'choose_hospital';
  return 'ready';
}

// Loads the session (if any) on every request. Idle and expired sessions come back empty.
export function sessionLoader(pool) {
  return async (req, _res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      req.sessionHash = token ? hashToken(token) : null;
      req.auth = null;
      if (req.sessionHash) {
        const { rows } = await pool.query('SELECT * FROM auth.session_lookup($1)', [req.sessionHash]);
        req.auth = rows[0] || null;
      }
      next();
    } catch (e) { next(e); }
  };
}

// For clinical routes: fully signed in, and an active member of the chosen hospital.
export function requireMember(pool) {
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new HttpError(401, 'Your session has ended. Sign in again.', { stage: 'signed_out' });
      const stage = stageOf(req.auth);
      if (stage !== 'ready') throw new HttpError(401, 'Finish signing in first.', { stage });
      const ctx = { userId: req.auth.user_id, hospitalId: req.auth.hospital_id };
      const m = await withContext(pool, ctx, async db =>
        (await db.query('SELECT app.role() AS role, app.depts() AS departments, (SELECT ai_enabled FROM hospitals WHERE id = app.hid()) AS ai_enabled')).rows[0]);
      if (!m.role) throw new HttpError(403, 'You no longer have access to this hospital. Choose another hospital or ask its admin.', { stage: 'choose_hospital' });
      req.ctx = ctx;
      req.member = { role: m.role, departments: m.departments, aiEnabled: m.ai_enabled, perms: permissionsFor(m.role) };
      next();
    } catch (e) { next(e); }
  };
}

export function need(perm, message) {
  return (req, _res, next) => next(req.member?.perms[perm] ? undefined : new HttpError(403, message || 'Your role does not allow this.'));
}

export function authRoutes(pool, { idleMinutes }) {
  const r = express.Router();

  r.post('/login', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
      const password = String(req.body?.password || '');
      const ip = req.ip;
      if (limited('ip:' + ip, 30, 15 * 60e3)) throw new HttpError(429, 'Too many sign-in attempts from this network. Wait 15 minutes.');
      const { rows } = await pool.query('SELECT * FROM auth.get_login($1)', [email]);
      const u = rows[0];
      const ok = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
      if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
        await pool.query('SELECT auth.record_login($1,$2,$3,$4)', [email, u.id, 'locked', ip]);
        throw new HttpError(423, 'This account is locked for 15 minutes after too many wrong passwords. Your hospital admin can unlock it sooner.');
      }
      if (!u || !ok || !u.is_active) {
        await pool.query('SELECT auth.record_login($1,$2,$3,$4)', [email, u?.id || null, !u ? 'unknown_email' : !ok ? 'bad_password' : 'inactive', ip]);
        throw new HttpError(401, 'Email or password is not right.');
      }
      await pool.query('SELECT auth.record_login($1,$2,$3,$4)', [email, u.id, 'password_ok', ip]);
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('SELECT auth.create_session($1,$2,$3)', [u.id, hashToken(token), idleMinutes]);
      setCookie(res, token, 12 * 3600);
      const s = (await pool.query('SELECT * FROM auth.session_lookup($1)', [hashToken(token)])).rows[0];
      res.json({ stage: stageOf(s) });
    } catch (e) { next(e); }
  });

  r.post('/logout', async (req, res, next) => {
    try {
      if (req.sessionHash) await pool.query('SELECT auth.session_delete($1)', [req.sessionHash]);
      setCookie(res, '', 0);
      res.json({ stage: 'signed_out' });
    } catch (e) { next(e); }
  });

  r.post('/password', async (req, res, next) => {
    try {
      if (!req.auth) throw new HttpError(401, 'Sign in first.', { stage: 'signed_out' });
      const { current, next: pw } = req.body || {};
      const hash = (await pool.query('SELECT auth.password_hash($1) AS h', [req.auth.user_id])).rows[0].h;
      if (!(await bcrypt.compare(String(current || ''), hash))) throw new HttpError(400, 'Your current password is not right.');
      validatePassword(pw);
      if (pw === current) throw new HttpError(400, 'Choose a new password that differs from the current one.');
      await pool.query('SELECT auth.set_own_password($1,$2)', [req.auth.user_id, await hashPassword(pw)]);
      await pool.query('SELECT auth.session_delete_others($1,$2)', [req.auth.user_id, req.sessionHash]);
      const s = (await pool.query('SELECT * FROM auth.session_lookup($1)', [req.sessionHash])).rows[0];
      res.json({ stage: stageOf(s) });
    } catch (e) { next(e); }
  });

  r.post('/two-step/setup', async (req, res, next) => {
    try {
      if (stageOf(req.auth) !== 'setup_two_step') throw new HttpError(400, 'Two-step sign-in is already set up for this account.');
      const secret = new OTPAuth.Secret({ size: 20 });
      const totp = new OTPAuth.TOTP({ issuer: 'WardBook', label: req.auth.email, secret, algorithm: 'SHA1', digits: 6, period: 30 });
      await pool.query('SELECT auth.totp_begin($1,$2)', [req.auth.user_id, secret.base32]);
      const uri = totp.toString();
      res.json({ secret: secret.base32, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1 }) });
    } catch (e) { next(e); }
  });

  r.post('/two-step/verify', async (req, res, next) => {
    try {
      const stage = stageOf(req.auth);
      if (stage !== 'two_step' && stage !== 'setup_two_step') throw new HttpError(400, 'No code is needed right now.', { stage });
      if (limited('totp:' + req.sessionHash, 8, 15 * 60e3)) {
        await pool.query('SELECT auth.session_delete($1)', [req.sessionHash]);
        throw new HttpError(429, 'Too many wrong codes. Sign in again.', { stage: 'signed_out' });
      }
      const code = String(req.body?.code || '').replace(/\s/g, '');
      const secret = (await pool.query('SELECT auth.totp_secret($1) AS s', [req.auth.user_id])).rows[0].s;
      if (!secret) throw new HttpError(400, 'Start two-step setup first.');
      const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
      const delta = /^\d{6}$/.test(code) ? totp.validate({ token: code, window: 1 }) : null;
      if (delta === null) throw new HttpError(400, 'That code is not right. Check the time on your phone and use the newest code.');
      const step = Math.floor(Date.now() / 30000) + delta;
      const ok = (await pool.query('SELECT auth.totp_accept($1,$2,$3) AS ok', [req.auth.user_id, req.sessionHash, step])).rows[0].ok;
      if (!ok) throw new HttpError(400, 'That code was already used. Wait for the next one.');
      // One hospital: pick it straight away.
      const hs = (await pool.query('SELECT * FROM auth.my_hospitals($1)', [req.auth.user_id])).rows;
      if (hs.length === 1) await pool.query('SELECT auth.session_set_hospital($1,$2)', [req.sessionHash, hs[0].hospital_id]);
      const s = (await pool.query('SELECT * FROM auth.session_lookup($1)', [req.sessionHash])).rows[0];
      res.json({ stage: stageOf(s) });
    } catch (e) { next(e); }
  });

  r.post('/hospital', async (req, res, next) => {
    try {
      const stage = stageOf(req.auth);
      if (stage !== 'choose_hospital' && stage !== 'ready') throw new HttpError(401, 'Finish signing in first.', { stage });
      const ok = (await pool.query('SELECT auth.session_set_hospital($1,$2) AS ok', [req.sessionHash, String(req.body?.hospitalId || '')]).catch(() => ({ rows: [{ ok: false }] }))).rows[0].ok;
      if (!ok) throw new HttpError(403, 'You are not a member of that hospital.');
      res.json({ stage: 'ready' });
    } catch (e) { next(e); }
  });

  r.get('/me', async (req, res, next) => {
    try {
      const stage = stageOf(req.auth);
      if (stage === 'signed_out') return res.json({ stage });
      const out = { stage, user: { id: req.auth.user_id, email: req.auth.email, fullName: req.auth.full_name }, idleMinutes };
      if (['choose_hospital', 'ready'].includes(stage)) {
        const hs = (await pool.query('SELECT * FROM auth.my_hospitals($1)', [req.auth.user_id])).rows;
        out.hospitals = hs.map(h => ({ id: h.hospital_id, name: h.name, role: h.role, roleLabel: ROLES[h.role] }));
        const cur = hs.find(h => h.hospital_id === req.auth.hospital_id);
        if (stage === 'ready' && !cur) out.stage = 'choose_hospital';
        if (cur) {
          out.current = {
            hospitalId: cur.hospital_id, name: cur.name, role: cur.role, roleLabel: ROLES[cur.role],
            departments: cur.departments, aiEnabled: cur.ai_enabled, aiConfigured: !!process.env.ANTHROPIC_API_KEY,
          };
          out.perms = permissionsFor(cur.role);
        }
      }
      res.json(out);
    } catch (e) { next(e); }
  });

  return r;
}
