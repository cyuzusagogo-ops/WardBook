-- WardBook schema.
-- Security model: the application connects as role `wardbook_app`, which does not own any
-- table and cannot bypass row-level security. Every request runs in a transaction that sets
-- `app.user_id` and `app.hospital_id`; the policies below decide what that person may read or
-- write. Account data (password hashes, TOTP secrets, sessions) lives in schema `auth`, which
-- the app role cannot read directly; it is reached only through the SECURITY DEFINER
-- functions at the end of this file.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE hospitals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  ai_enabled  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name             text NOT NULL,
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  totp_secret           text,
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_last_step        bigint NOT NULL DEFAULT 0,
  is_active             boolean NOT NULL DEFAULT true,
  failed_logins         int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.sessions (
  token_hash    text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hospital_id   uuid REFERENCES hospitals(id),
  mfa_passed    boolean NOT NULL DEFAULT false,
  idle_minutes  int NOT NULL DEFAULT 15,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);
CREATE INDEX ON auth.sessions (user_id);

CREATE TABLE auth.login_events (
  id        bigserial PRIMARY KEY,
  email     text NOT NULL,
  user_id   uuid,
  outcome   text NOT NULL,
  ip        text,
  at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  role         text NOT NULL CHECK (role IN ('intern','resident','attending','head_of_department',
                                             'nurse','student','hospital_admin','auditor')),
  departments  text[] NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  valid_until  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, hospital_id)
);

CREATE TABLE patients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id      uuid NOT NULL REFERENCES hospitals(id),
  hospital_number  text,
  name             text NOT NULL,
  sex              text,
  age              text,
  dob              date,
  department       text NOT NULL CHECK (department IN ('IM','SURGERY','PEDS','ER','OBGYN')),
  ward             text,
  bed              text,
  status           text NOT NULL DEFAULT 'stable'
                   CHECK (status IN ('stable','improving','watch','critical','ready_for_discharge','discharged')),
  admitted_at      date NOT NULL DEFAULT current_date,
  discharged_at    date,
  allergies        text,
  clinical         jsonb NOT NULL DEFAULT '{}'::jsonb,
  version          int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON patients (hospital_id, department);
CREATE UNIQUE INDEX patients_hosp_number ON patients (hospital_id, hospital_number) WHERE hospital_number IS NOT NULL;

CREATE TABLE assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  user_id      uuid NOT NULL REFERENCES auth.users(id),
  reason       text NOT NULL DEFAULT 'consult',
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, user_id)
);

CREATE TABLE vitals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  sbp int, dbp int, hr int, rr int,
  temp numeric(4,1), spo2 int, gcs int,
  glucose text, weight_kg numeric(5,1), urine text,
  recorded_by  uuid NOT NULL
);
CREATE INDEX ON vitals (patient_id, recorded_at DESC);

CREATE TABLE notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  kind         text NOT NULL CHECK (kind IN ('soap','nursing','student','addendum')),
  note_date    date NOT NULL DEFAULT current_date,
  s text, o text, a text, p text,
  addendum_of  uuid REFERENCES notes(id),
  author_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  signed_by    uuid,
  signed_at    timestamptz
);
CREATE INDEX ON notes (patient_id, note_date DESC);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  text         text NOT NULL,
  due_at       timestamptz,
  done         boolean NOT NULL DEFAULT false,
  done_by      uuid,
  done_at      timestamptz,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tasks (patient_id) WHERE NOT done;

CREATE TABLE transfers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  from_dept    text NOT NULL,
  to_dept      text NOT NULL,
  note         text,
  by_user      uuid NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE summaries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  kind         text NOT NULL,
  source       text NOT NULL CHECK (source IN ('ai','template')),
  text         text NOT NULL,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_by  uuid,
  accepted_at  timestamptz
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  hospital_id  uuid,
  actor_id     uuid,
  action       text NOT NULL,
  entity       text NOT NULL,
  entity_id    uuid,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (hospital_id, at DESC);
CREATE INDEX ON audit_log (entity_id);

-- ---------------------------------------------------------------------------
-- Request context helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.hid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.hospital_id', true), '')::uuid $$;

-- The caller's active membership in the current hospital. Inactive accounts, inactive or
-- expired memberships, and a hospital the caller does not belong to all give NULL.
CREATE FUNCTION app.role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
  SELECT m.role FROM memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE m.user_id = app.uid() AND m.hospital_id = app.hid()
    AND m.active AND u.is_active
    AND (m.valid_until IS NULL OR m.valid_until >= current_date)
$$;

CREATE FUNCTION app.depts() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
  SELECT m.departments FROM memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE m.user_id = app.uid() AND m.hospital_id = app.hid()
    AND m.active AND u.is_active
    AND (m.valid_until IS NULL OR m.valid_until >= current_date)
$$;

CREATE FUNCTION app.in_dept(d text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(d = ANY(app.depts()) OR 'ALL' = ANY(app.depts()), false) $$;

CREATE FUNCTION app.is_clinician() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(app.role() IN ('intern','resident','attending','head_of_department'), false) $$;

CREATE FUNCTION app.can_sign() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(app.role() IN ('resident','attending','head_of_department'), false) $$;

CREATE FUNCTION app.is_assigned(p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
  SELECT EXISTS (SELECT 1 FROM assignments a WHERE a.patient_id = p_patient AND a.user_id = app.uid())
$$;

-- Who may see a patient: auditors see the whole hospital; students only patients assigned to
-- them; hospital admins no clinical records; everyone else their departments plus patients
-- they were assigned to (consults).
CREATE FUNCTION app.can_see_patient(p_hospital uuid, p_dept text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(p_hospital = app.hid() AND CASE app.role()
      WHEN 'auditor'        THEN true
      WHEN 'hospital_admin' THEN false
      WHEN 'student'        THEN app.is_assigned(p_id)
      ELSE (app.role() IS NOT NULL AND (app.in_dept(p_dept) OR app.is_assigned(p_id)))
    END, false)
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE hospitals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients    ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vitals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;

CREATE POLICY hospitals_read ON hospitals FOR SELECT USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.hospital_id = hospitals.id AND m.user_id = app.uid() AND m.active));
CREATE POLICY hospitals_admin ON hospitals FOR UPDATE
  USING (id = app.hid() AND app.role() = 'hospital_admin')
  WITH CHECK (id = app.hid() AND app.role() = 'hospital_admin');

CREATE POLICY memberships_read ON memberships FOR SELECT USING (
  user_id = app.uid() OR (hospital_id = app.hid() AND app.role() = 'hospital_admin'));
-- Admins manage other people's memberships, never their own.
CREATE POLICY memberships_admin ON memberships FOR UPDATE
  USING (hospital_id = app.hid() AND app.role() = 'hospital_admin' AND user_id <> app.uid())
  WITH CHECK (hospital_id = app.hid() AND app.role() = 'hospital_admin' AND user_id <> app.uid());

CREATE POLICY patients_read ON patients FOR SELECT
  USING (app.can_see_patient(hospital_id, department, id));
CREATE POLICY patients_insert ON patients FOR INSERT
  WITH CHECK (hospital_id = app.hid() AND app.is_clinician() AND app.in_dept(department) AND created_by = app.uid());
CREATE POLICY patients_update ON patients FOR UPDATE
  USING (app.can_see_patient(hospital_id, department, id) AND app.is_clinician())
  WITH CHECK (hospital_id = app.hid() AND app.is_clinician());

-- Child tables: visible when the patient is visible (the sub-select runs under patients_read).
CREATE POLICY assignments_read ON assignments FOR SELECT USING (
  hospital_id = app.hid() AND (user_id = app.uid() OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id)));
CREATE POLICY assignments_insert ON assignments FOR INSERT WITH CHECK (
  hospital_id = app.hid() AND app.is_clinician() AND created_by = app.uid()
  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id AND p.hospital_id = app.hid()));
CREATE POLICY assignments_delete ON assignments FOR DELETE USING (
  hospital_id = app.hid() AND app.is_clinician() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));

CREATE POLICY vitals_read ON vitals FOR SELECT USING (
  hospital_id = app.hid() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY vitals_insert ON vitals FOR INSERT WITH CHECK (
  hospital_id = app.hid() AND recorded_by = app.uid()
  AND (app.is_clinician() OR app.role() = 'nurse')
  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id AND p.hospital_id = app.hid()));

CREATE POLICY notes_read ON notes FOR SELECT USING (
  hospital_id = app.hid() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY notes_insert ON notes FOR INSERT WITH CHECK (
  hospital_id = app.hid() AND author_id = app.uid() AND signed_at IS NULL
  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id AND p.hospital_id = app.hid())
  AND ((kind IN ('soap','addendum') AND app.is_clinician())
    OR (kind IN ('nursing','addendum') AND app.role() = 'nurse')
    OR (kind = 'student' AND app.role() = 'student')));
CREATE POLICY notes_update ON notes FOR UPDATE
  USING (hospital_id = app.hid() AND (author_id = app.uid() OR app.can_sign())
         AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id))
  WITH CHECK (hospital_id = app.hid());

CREATE POLICY tasks_read ON tasks FOR SELECT USING (
  hospital_id = app.hid() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (
  hospital_id = app.hid() AND created_by = app.uid() AND (app.is_clinician() OR app.role() = 'nurse')
  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id AND p.hospital_id = app.hid()));
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (hospital_id = app.hid() AND (app.is_clinician() OR app.role() = 'nurse')
         AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id))
  WITH CHECK (hospital_id = app.hid());

CREATE POLICY transfers_read ON transfers FOR SELECT USING (
  hospital_id = app.hid() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY transfers_insert ON transfers FOR INSERT WITH CHECK (
  hospital_id = app.hid() AND by_user = app.uid() AND app.is_clinician());

CREATE POLICY summaries_read ON summaries FOR SELECT USING (
  hospital_id = app.hid() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY summaries_insert ON summaries FOR INSERT WITH CHECK (
  hospital_id = app.hid() AND created_by = app.uid() AND accepted_by IS NULL
  AND (app.is_clinician() OR app.role() = 'student')
  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY summaries_accept ON summaries FOR UPDATE
  USING (hospital_id = app.hid() AND app.is_clinician() AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id))
  WITH CHECK (hospital_id = app.hid() AND accepted_by = app.uid());

CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (
  actor_id = app.uid() AND hospital_id = app.hid() AND app.role() IS NOT NULL);
CREATE POLICY audit_read ON audit_log FOR SELECT USING (
  hospital_id = app.hid() AND app.role() IN ('hospital_admin','head_of_department','auditor'));

-- ---------------------------------------------------------------------------
-- Integrity triggers (rules that row policies cannot express)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.patients_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hospital_id <> OLD.hospital_id OR NEW.created_by <> OLD.created_by OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'hospital and creator of a patient record cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'discharged' AND OLD.status <> 'discharged' AND NOT app.can_sign() THEN
    RAISE EXCEPTION 'only a resident, attending or head of department can discharge' USING ERRCODE = '42501';
  END IF;
  NEW.version    := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := app.uid();
  RETURN NEW;
END $$;
CREATE TRIGGER patients_guard BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION app.patients_guard();

CREATE FUNCTION app.notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'signed notes cannot be changed; add an addendum' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.author_id <> OLD.author_id OR NEW.kind <> OLD.kind
     OR NEW.hospital_id <> OLD.hospital_id OR NEW.addendum_of IS DISTINCT FROM OLD.addendum_of THEN
    RAISE EXCEPTION 'note ownership fields cannot change' USING ERRCODE = '42501';
  END IF;
  IF (NEW.s, NEW.o, NEW.a, NEW.p, NEW.note_date) IS DISTINCT FROM (OLD.s, OLD.o, OLD.a, OLD.p, OLD.note_date) THEN
    IF OLD.author_id <> app.uid() THEN
      RAISE EXCEPTION 'only the author can edit an unsigned note' USING ERRCODE = '42501';
    END IF;
    IF NEW.signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'edit and sign-off must be separate steps' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.signed_at IS NOT NULL THEN
    IF NOT app.can_sign() OR NEW.signed_by IS DISTINCT FROM app.uid() THEN
      RAISE EXCEPTION 'only a resident, attending or head of department can sign notes' USING ERRCODE = '42501';
    END IF;
    NEW.signed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notes_guard BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION app.notes_guard();

CREATE FUNCTION app.tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.text <> OLD.text OR NEW.patient_id <> OLD.patient_id OR NEW.created_by <> OLD.created_by
     OR NEW.hospital_id <> OLD.hospital_id THEN
    RAISE EXCEPTION 'only the done state of a task can change' USING ERRCODE = '42501';
  END IF;
  IF NEW.done AND NOT OLD.done THEN NEW.done_by := app.uid(); NEW.done_at := now(); END IF;
  IF NOT NEW.done THEN NEW.done_by := NULL; NEW.done_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.tasks_guard();

CREATE FUNCTION app.summaries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'this summary was already accepted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.text, NEW.kind, NEW.source, NEW.patient_id, NEW.created_by)
     IS DISTINCT FROM (OLD.text, OLD.kind, OLD.source, OLD.patient_id, OLD.created_by) THEN
    RAISE EXCEPTION 'summaries can only be accepted, not edited' USING ERRCODE = '42501';
  END IF;
  NEW.accepted_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER summaries_guard BEFORE UPDATE ON summaries FOR EACH ROW EXECUTE FUNCTION app.summaries_guard();

-- The audit log is append-only for everyone, including the table owner.
CREATE FUNCTION app.audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION app.audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION app.audit_immutable();

-- Every write to clinical and access tables is logged by the database itself, so no code path
-- can skip it. Only column names are logged, never their clinical content.
CREATE FUNCTION app.audit_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
DECLARE
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  rec jsonb := CASE WHEN TG_OP = 'DELETE' THEN o ELSE n END;
  changed text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
    FROM jsonb_object_keys(n) k
    WHERE n -> k IS DISTINCT FROM o -> k AND k NOT IN ('version','updated_at','updated_by','last_seen');
  END IF;
  INSERT INTO audit_log (hospital_id, actor_id, action, entity, entity_id, detail)
  VALUES (
    coalesce((rec ->> 'hospital_id')::uuid, CASE WHEN TG_TABLE_NAME = 'hospitals' THEN (rec ->> 'id')::uuid END),
    app.uid(), lower(TG_OP), TG_TABLE_NAME, (rec ->> 'id')::uuid,
    CASE WHEN changed IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('changed', to_jsonb(changed)) END
      || CASE WHEN rec ? 'patient_id' THEN jsonb_build_object('patient_id', rec -> 'patient_id') ELSE '{}'::jsonb END);
  RETURN NULL;
END $$;

CREATE TRIGGER audit_patients    AFTER INSERT OR UPDATE ON patients    FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_vitals      AFTER INSERT OR UPDATE ON vitals      FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_notes       AFTER INSERT OR UPDATE ON notes       FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_tasks       AFTER INSERT OR UPDATE ON tasks       FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_transfers   AFTER INSERT ON transfers             FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_summaries   AFTER INSERT OR UPDATE ON summaries   FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_assignments AFTER INSERT OR DELETE ON assignments FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_memberships AFTER INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION app.audit_write();
CREATE TRIGGER audit_hospitals   AFTER UPDATE ON hospitals             FOR EACH ROW EXECUTE FUNCTION app.audit_write();

-- Removing or changing someone's membership signs them out everywhere at once.
CREATE FUNCTION app.membership_revoke_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
BEGIN
  IF (NOT NEW.active AND OLD.active) OR NEW.role <> OLD.role OR NEW.departments <> OLD.departments THEN
    DELETE FROM auth.sessions WHERE user_id = NEW.user_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER membership_revoke_sessions AFTER UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION app.membership_revoke_sessions();

-- ---------------------------------------------------------------------------
-- Account functions (the only way the app role reaches schema auth)
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth.get_login(p_email text)
RETURNS TABLE (id uuid, password_hash text, is_active boolean, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  SELECT id, password_hash, is_active, locked_until FROM auth.users WHERE email = lower(p_email)
$$;

-- Five failed passwords lock the account for 15 minutes.
CREATE FUNCTION auth.record_login(p_email text, p_user uuid, p_outcome text, p_ip text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
BEGIN
  INSERT INTO auth.login_events (email, user_id, outcome, ip) VALUES (lower(p_email), p_user, p_outcome, p_ip);
  IF p_user IS NULL THEN RETURN; END IF;
  IF p_outcome = 'bad_password' THEN
    UPDATE auth.users SET failed_logins = failed_logins + 1,
      locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
    WHERE id = p_user;
  ELSIF p_outcome = 'password_ok' THEN
    UPDATE auth.users SET failed_logins = 0, locked_until = NULL WHERE id = p_user;
  END IF;
END $$;

CREATE FUNCTION auth.create_session(p_user uuid, p_hash text, p_idle int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  DELETE FROM auth.sessions WHERE user_id = p_user AND expires_at < now();
  INSERT INTO auth.sessions (token_hash, user_id, idle_minutes) VALUES (p_hash, p_user, p_idle);
$$;

-- Returns the session only while the account is active, the session is unexpired and the
-- idle limit has not passed; each successful lookup counts as activity.
CREATE FUNCTION auth.session_lookup(p_hash text)
RETURNS TABLE (user_id uuid, hospital_id uuid, mfa_passed boolean, email text, full_name text,
               totp_enabled boolean, must_change_password boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
BEGIN
  RETURN QUERY
  UPDATE auth.sessions s SET last_seen = now()
  FROM auth.users u
  WHERE s.token_hash = p_hash AND u.id = s.user_id AND u.is_active
    AND s.expires_at > now() AND s.last_seen > now() - make_interval(mins => s.idle_minutes)
  RETURNING s.user_id, s.hospital_id, s.mfa_passed, u.email, u.full_name, u.totp_enabled, u.must_change_password;
END $$;

CREATE FUNCTION auth.session_delete(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  DELETE FROM auth.sessions WHERE token_hash = p_hash
$$;

CREATE FUNCTION auth.session_delete_others(p_user uuid, p_keep text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  DELETE FROM auth.sessions WHERE user_id = p_user AND token_hash <> p_keep
$$;

CREATE FUNCTION auth.session_set_hospital(p_hash text, p_hospital uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
DECLARE ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM auth.sessions s JOIN memberships m ON m.user_id = s.user_id
    WHERE s.token_hash = p_hash AND s.mfa_passed AND m.hospital_id = p_hospital AND m.active
      AND (m.valid_until IS NULL OR m.valid_until >= current_date)) INTO ok;
  IF ok THEN UPDATE auth.sessions SET hospital_id = p_hospital WHERE token_hash = p_hash; END IF;
  RETURN ok;
END $$;

CREATE FUNCTION auth.my_hospitals(p_user uuid)
RETURNS TABLE (hospital_id uuid, name text, role text, departments text[], ai_enabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth AS $$
  SELECT h.id, h.name, m.role, m.departments, h.ai_enabled
  FROM memberships m JOIN hospitals h ON h.id = m.hospital_id JOIN auth.users u ON u.id = m.user_id
  WHERE m.user_id = p_user AND m.active AND u.is_active
    AND (m.valid_until IS NULL OR m.valid_until >= current_date)
  ORDER BY h.name
$$;

-- TOTP enrolment. A secret can be replaced only while two-step sign-in is not yet enabled.
CREATE FUNCTION auth.totp_begin(p_user uuid, p_secret text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
BEGIN
  UPDATE auth.users SET totp_secret = p_secret WHERE id = p_user AND NOT totp_enabled;
  RETURN FOUND;
END $$;

CREATE FUNCTION auth.totp_secret(p_user uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  SELECT totp_secret FROM auth.users WHERE id = p_user
$$;

-- Accepts a verified code's time step once only, then enables TOTP and marks the session.
CREATE FUNCTION auth.totp_accept(p_user uuid, p_hash text, p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
BEGIN
  UPDATE auth.users SET totp_last_step = p_step, totp_enabled = true
  WHERE id = p_user AND totp_last_step < p_step AND totp_secret IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE auth.sessions SET mfa_passed = true WHERE token_hash = p_hash AND user_id = p_user;
  RETURN true;
END $$;

CREATE FUNCTION auth.password_hash(p_user uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  SELECT password_hash FROM auth.users WHERE id = p_user
$$;

CREATE FUNCTION auth.set_own_password(p_user uuid, p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth AS $$
  UPDATE auth.users SET password_hash = p_hash, must_change_password = false WHERE id = p_user
$$;

-- Names of people who share the caller's current hospital (for note authors, assignments).
CREATE FUNCTION app.people()
RETURNS TABLE (id uuid, full_name text, role text, departments text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
  SELECT u.id, u.full_name, m.role, m.departments
  FROM memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE app.role() IS NOT NULL AND m.hospital_id = app.hid() AND m.active AND u.is_active
  ORDER BY u.full_name
$$;

-- Hospital admin: staff list with account state.
CREATE FUNCTION app.admin_staff()
RETURNS TABLE (membership_id uuid, user_id uuid, email text, full_name text, role text, departments text[],
               active boolean, valid_until date, account_active boolean, totp_enabled boolean, last_seen timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
BEGIN
  IF app.role() IS DISTINCT FROM 'hospital_admin' THEN
    RAISE EXCEPTION 'only a hospital admin can list staff accounts' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.id, u.id, u.email, u.full_name, m.role, m.departments, m.active, m.valid_until, u.is_active, u.totp_enabled,
         (SELECT max(s.last_seen) FROM auth.sessions s WHERE s.user_id = u.id)
  FROM memberships m JOIN auth.users u ON u.id = m.user_id
  WHERE m.hospital_id = app.hid()
  ORDER BY m.active DESC, u.full_name;
END $$;

-- Hospital admin: add a person to this hospital. A new account gets the temporary password
-- hash given; an existing account (from another hospital) keeps its own password.
CREATE FUNCTION app.admin_add_staff(p_email text, p_name text, p_hash text, p_role text, p_depts text[], p_until date)
RETURNS TABLE (user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
DECLARE v_user uuid; v_created boolean := false;
BEGIN
  IF app.role() IS DISTINCT FROM 'hospital_admin' THEN
    RAISE EXCEPTION 'only a hospital admin can add staff' USING ERRCODE = '42501';
  END IF;
  SELECT u.id INTO v_user FROM auth.users u WHERE u.email = lower(p_email);
  IF v_user IS NULL THEN
    INSERT INTO auth.users (email, full_name, password_hash, must_change_password)
    VALUES (lower(p_email), p_name, p_hash, true) RETURNING id INTO v_user;
    v_created := true;
  END IF;
  IF v_user = app.uid() THEN
    RAISE EXCEPTION 'admins cannot change their own membership' USING ERRCODE = '42501';
  END IF;
  INSERT INTO memberships (user_id, hospital_id, role, departments, valid_until)
  VALUES (v_user, app.hid(), p_role, p_depts, p_until)
  ON CONFLICT ON CONSTRAINT memberships_user_id_hospital_id_key
  DO UPDATE SET role = EXCLUDED.role, departments = EXCLUDED.departments,
                valid_until = EXCLUDED.valid_until, active = true;
  RETURN QUERY SELECT v_user, v_created;
END $$;

-- Hospital admin: reset a staff member's password and/or two-step sign-in (lost phone).
CREATE FUNCTION app.admin_reset_account(p_user uuid, p_hash text, p_reset_totp boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
BEGIN
  IF app.role() IS DISTINCT FROM 'hospital_admin' OR p_user = app.uid() OR NOT EXISTS (
       SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.hospital_id = app.hid()) THEN
    RAISE EXCEPTION 'you can only reset accounts of other staff in this hospital' USING ERRCODE = '42501';
  END IF;
  IF p_hash IS NOT NULL THEN
    UPDATE auth.users SET password_hash = p_hash, must_change_password = true, failed_logins = 0, locked_until = NULL
    WHERE id = p_user;
  END IF;
  IF p_reset_totp THEN
    UPDATE auth.users SET totp_enabled = false, totp_secret = NULL WHERE id = p_user;
  END IF;
  DELETE FROM auth.sessions WHERE user_id = p_user;
  INSERT INTO audit_log (hospital_id, actor_id, action, entity, entity_id, detail)
  VALUES (app.hid(), app.uid(), 'reset', 'account', p_user,
          jsonb_build_object('password', p_hash IS NOT NULL, 'two_step', p_reset_totp));
END $$;

-- ---------------------------------------------------------------------------
-- Privileges for the application role
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

GRANT USAGE ON SCHEMA public, app, auth TO wardbook_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO wardbook_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO wardbook_app;

GRANT SELECT ON hospitals TO wardbook_app;
GRANT UPDATE (ai_enabled) ON hospitals TO wardbook_app;
GRANT SELECT ON memberships TO wardbook_app;
GRANT UPDATE (role, departments, active, valid_until) ON memberships TO wardbook_app;
GRANT SELECT, INSERT ON patients TO wardbook_app;
GRANT UPDATE (hospital_number, name, sex, age, dob, department, ward, bed, status, admitted_at,
              discharged_at, allergies, clinical, version) ON patients TO wardbook_app;
GRANT SELECT, INSERT, DELETE ON assignments TO wardbook_app;
GRANT SELECT, INSERT ON vitals TO wardbook_app;
GRANT SELECT, INSERT ON notes TO wardbook_app;
GRANT UPDATE (s, o, a, p, note_date, signed_by, signed_at) ON notes TO wardbook_app;
GRANT SELECT, INSERT ON tasks TO wardbook_app;
GRANT UPDATE (done) ON tasks TO wardbook_app;
GRANT SELECT, INSERT ON transfers TO wardbook_app;
GRANT SELECT, INSERT ON summaries TO wardbook_app;
GRANT UPDATE (accepted_by, accepted_at) ON summaries TO wardbook_app;
GRANT SELECT, INSERT ON audit_log TO wardbook_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO wardbook_app;
