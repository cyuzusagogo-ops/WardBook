# WardBook

A ward rounds system for hospital clinical teams. Interns, residents, attendings, nurses and
students work on the same patient files; each hospital's data is kept apart; and every
permission is enforced inside the database, not just in the screens.

- **Departments:** Internal Medicine, Surgery, Pediatrics, Emergency, Obstetrics & Gynecology.
- **Patient file on one page:** allergies banner, history, vital signs with abnormal values
  flagged and a trend table, examination, results, diagnosis, problem list, plan, tasks, care team.
  Department extras: gestational age and EDD (OBGYN), maintenance fluids from weight (Pediatrics),
  post-op day (Surgery), triage and ER course (ER).
- **Early warning on every vital signs set:** NEWS2 for adults, age-banded ranges and WHO fast
  breathing for children, MEOWS-style triggers for obstetric patients. Shown on the patient file
  and the department list, with the recommended response.
- **Daily SOAP notes** with sign-off: interns write, a resident or attending signs; signed notes
  can't change, and corrections are added as addenda.
- **Tasks** per patient, collected on one Tasks page.
- **Summaries** for the attending, I-PASS handover, SBAR calls and discharge drafts: built on the
  server from the file, or drafted by AI from a de-identified copy if the hospital turns that on.
  A clinician accepts a summary before it counts as part of the record.
- **Transfers, consults, discharge and readmission**, all recorded.
- **Audit log** of every file opened and every change, append-only.

## Who can do what

| Role | Sees | Edits file / admits | Notes | Vitals | Signs notes | Discharges | Summaries |
|---|---|---|---|---|---|---|---|
| Intern | Own departments + consults | Yes | Yes | Yes | No | No | Yes |
| Resident | Own departments + consults | Yes | Yes | Yes | Yes | Yes | Yes |
| Attending / consultant | Own departments + consults | Yes | Yes | Yes | Yes | Yes | Yes |
| Head of department | Own departments + audit log | Yes | Yes | Yes | Yes | Yes | Yes |
| Nurse | Own departments | No | Nursing notes | Yes | No | No | No |
| Medical student | Assigned patients only, initials, no hospital number | No | Student notes | No | No | No | Yes |
| Hospital admin | Staff list and audit log, no clinical records | No | No | No | No | No | No |
| Auditor | Everything in the hospital, read-only, audit log | No | No | No | No | No | No |

Departments can be set to "All". A person can belong to several hospitals with a different role in
each, and only ever sees the hospital they chose at sign-in.

## Early warning rules

All thresholds live in one file, `public/clinical.js`, used by both the screens and the summaries.

| Patients | Chart | Triggers shown |
|---|---|---|
| Adults 16+ (not obstetric) | NEWS2, Royal College of Physicians 2017, SpO₂ scale 1 | Score with risk band and response; any single parameter scoring 3 |
| Under 16, or in Pediatrics | Age-banded normal ranges (APLS-style) for heart rate, respiratory rate and systolic BP; WHO fast breathing; SpO₂ below 92% at any age | Signs outside the range for the child's age |
| Obstetrics & Gynecology | MEOWS-style (after Singh et al. 2012) | One red or two yellows |

A NEWS2 score from an incomplete set is marked with `+` and lists what is missing, so it never looks
reassuring. The vitals card shows the latest value of each sign with its own time, and greys values
older than 6 hours.

**Before go-live, your senior clinicians must check these thresholds against the charts your hospital
uses.** The tool supports clinical judgement; it does not replace it.

## How the security works

- The web server connects to PostgreSQL as `wardbook_app`, a role that owns nothing and cannot
  bypass **row-level security**. Each request runs in a transaction tagged with the user and
  hospital; the policies in `db/migrations/001_schema.sql` decide what that person can read or
  write. A bug in the web code, or a forged request, still gets nothing the person is not allowed.
- Passwords are hashed with bcrypt. Accounts lock for 15 minutes after 5 wrong passwords.
- **Two-step sign-in (authenticator app) is required for everyone.** Codes can't be reused.
- Sessions end after 15 minutes idle (configurable) and 12 hours at most. The screen also clears
  itself when idle, for shared ward computers.
- Removing someone or changing their role signs them out everywhere at once. Access can have an
  end date (rotations).
- Two people editing the same file: the second save is refused instead of overwriting.
- The audit log is written by database triggers and can't be edited or deleted, even by the owner.
- Cookies are HttpOnly and SameSite=Strict, writes need a custom header, and the pages are served
  with a strict Content Security Policy. Nothing loads from outside the server.

`npm test` runs 37 automated tests (24 of them against a real database, 10 on the early warning rules) that try to break these rules:
cross-hospital access, forged hospital IDs, department limits, students, nurses, auditors,
admins, suspension, concurrent edits, note signing, discharge rights, transfers, consults,
audit immutability, idle timeout, code replay, lockout and de-identification.

## Requirements

- Linux server, Node.js 20 or newer, PostgreSQL 14 or newer (developed and tested on Ubuntu 24.04, Node.js 22, PostgreSQL 16).
- HTTPS in front of it (nginx example below). Never run it over plain HTTP outside a test machine.
- Where the server and backups are hosted must be approved by your hospital and data protection
  officer (in Rwanda, Law No. 058/2021 expects personal data to be stored in Rwanda unless NCSA
  authorises otherwise).

## Install

```bash
git clone <this repository> /opt/wardbook && cd /opt/wardbook
npm ci --omit=dev
cp .env.example .env    # then edit: passwords, URLs
npm run db:setup        # creates the two database roles, the database and the tables
```

After setup, remove `ADMIN_DATABASE_URL` from `.env` on the production server.

Create the first hospital and its admin (the admin adds everyone else from the Staff page):

```bash
npm run create-hospital -- "Example Teaching Hospital"
npm run create-admin -- <hospital-id> admin@hospital.example "Full Name"
```

The admin signs in with the temporary password shown, chooses their own password and sets up
two-step sign-in.

Start the server (example systemd unit):

```ini
# /etc/systemd/system/wardbook.service
[Unit]
Description=WardBook
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/wardbook
ExecStart=/usr/bin/node src/server.js
Restart=always
User=wardbook
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

nginx in front, with HTTPS:

```nginx
server {
  listen 443 ssl http2;
  server_name wardbook.hospital.example;
  ssl_certificate     /etc/letsencrypt/live/wardbook.hospital.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/wardbook.hospital.example/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000" always;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

## Backups

```bash
./scripts/backup.sh        # nightly from cron; keeps BACKUP_KEEP_DAYS days
./scripts/restore-test.sh  # monthly: restores the newest backup into a scratch database and counts records
```

Keep backups on an encrypted disk and copy them to a second approved location. Record each
monthly restore check.

## AI summaries (optional)

Off by default. To use them:

1. Your data protection officer approves the AI provider and where it processes data.
2. Set `ANTHROPIC_API_KEY` in `.env` and restart.
3. The hospital admin turns AI on under Staff.

Before anything is sent, the server removes the patient's name, hospital number, date of birth,
phone numbers, email addresses and calendar dates (dates become "day 3 of admission"). Free text
is scrubbed for the patient's name, but a name typed in an unusual form could still get through, so
staff should keep names out of free-text fields. Summaries are drafts until a clinician accepts them.

## Try it with demo data

```bash
npm run seed:demo   # only into an empty, non-production database
npm start
```

All demo accounts use password `demo-pass-2026`. For the two-step code, add the secret the seed
prints to an authenticator app, or run `node scripts/totp-code.js <secret>`.

## Development

```bash
npm test          # needs ADMIN_DATABASE_URL in .env; creates and drops the wardbook_test database
npm run dev       # restarts on file changes
npm run db:migrate
```

Schema changes go in a new numbered file in `db/migrations/`. Never edit an applied migration.
