-- Transfers move a patient out of the sending team's view, which a plain UPDATE under
-- row-level security cannot do (PostgreSQL requires the updated row to stay visible to the
-- person updating it). This function performs the same checks explicitly instead.
CREATE FUNCTION app.transfer_patient(p_id uuid, p_version int, p_to text, p_ward text, p_bed text, p_note text)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app AS $$
DECLARE v_from text; v_version int;
BEGIN
  IF NOT app.is_clinician() THEN
    RAISE EXCEPTION 'your role cannot transfer patients' USING ERRCODE = '42501';
  END IF;
  SELECT department INTO v_from FROM patients
  WHERE id = p_id AND app.can_see_patient(hospital_id, department, id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_to NOT IN ('IM','SURGERY','PEDS','ER','OBGYN') OR p_to = v_from THEN
    RAISE EXCEPTION 'choose a different department to transfer to' USING ERRCODE = '22023';
  END IF;
  UPDATE patients SET department = p_to, ward = p_ward, bed = p_bed
  WHERE id = p_id AND version = p_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN RETURN -1; END IF;
  INSERT INTO transfers (hospital_id, patient_id, from_dept, to_dept, note, by_user)
  VALUES (app.hid(), p_id, v_from, p_to, p_note, app.uid());
  RETURN v_version;
END $$;

REVOKE ALL ON FUNCTION app.transfer_patient(uuid, int, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.transfer_patient(uuid, int, text, text, text, text) TO wardbook_app;
