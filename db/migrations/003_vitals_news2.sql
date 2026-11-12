-- NEWS2 needs two more observations: whether the patient is on supplemental oxygen, and
-- consciousness on the ACVPU scale (Alert, new Confusion, Voice, Pain, Unresponsive).
ALTER TABLE vitals ADD COLUMN on_oxygen boolean;
ALTER TABLE vitals ADD COLUMN avpu text CHECK (avpu IN ('A','C','V','P','U'));
GRANT INSERT (on_oxygen, avpu) ON vitals TO wardbook_app;
