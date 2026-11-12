import Anthropic from '@anthropic-ai/sdk';
import { DEPARTMENTS } from './permissions.js';
import '../public/clinical.js';

const WB = globalThis.WBClinical;

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
let client = null;
export function aiConfigured() {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  client ||= new Anthropic();
  return true;
}

export const SUMMARY_KINDS = {
  attending: 'Presentation to attending',
  handover: 'Handover (I-PASS)',
  sbar: 'Call a senior (SBAR)',
  discharge: 'Discharge summary draft',
};

const INSTRUCTIONS = {
  attending: 'Write the oral case presentation an intern gives the attending on a ward round. Order: one-line summary; relevant history; key examination findings; key investigations with abnormal values called out; assessment by problem; plan by problem; decisions or questions for the attending. About 60 to 90 seconds when spoken.',
  handover: 'Write an I-PASS handover for the on-call team: Illness severity (stable, watcher or unstable); Patient summary; Action list (what, when); Situation awareness and contingency ("if X, then do Y"); Synthesis prompt for the receiver.',
  sbar: 'Write an SBAR script for calling a senior about this patient now: Situation, Background, Assessment, Recommendation or request. Under 120 words, leading with the most worrying finding.',
  discharge: 'Draft a discharge summary: diagnosis, presentation, hospital course by problem, key results, procedures, condition at discharge, discharge medications if documented, follow-up and pending results, and warning signs for the patient.',
};

const SYSTEM = `You help hospital doctors summarise one patient's record for colleagues.
Use only facts in the record you are given. Never invent values, doses, results, dates or history.
Where something the format needs is missing, write "not documented".
Write plain text with short headings in capitals and short lines; no markdown symbols such as ** or #.
End with a section "CHECK BEFORE PRESENTING" listing at most four gaps, inconsistencies or safety points in the record (for example an allergy that conflicts with a medication, an abnormal vital sign without a plan, a pending result). Keep them factual.
The record has been de-identified: [patient], [number] and [date] are placeholders; keep them as they are.`;

// ---------------------------------------------------------------------------
// De-identification: what leaves the hospital's server for the AI provider.
// Structured identifiers are never included; free text is scrubbed of the patient's
// name parts, hospital number, phone-like numbers, emails and calendar dates; dates
// become "day N" of the admission.
// ---------------------------------------------------------------------------

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeScrubber(patient) {
  const nameParts = String(patient.name || '').split(/[\s,.\-']+/).filter(w => w.length >= 2);
  const nameRe = nameParts.length ? new RegExp(`\\b(${nameParts.map(escapeRe).join('|')})\\b`, 'gi') : null;
  const numRe = patient.hospital_number ? new RegExp(escapeRe(String(patient.hospital_number)), 'gi') : null;
  return text => {
    let t = String(text ?? '');
    if (nameRe) t = t.replace(nameRe, '[patient]');
    if (numRe) t = t.replace(numRe, '[number]');
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
    t = t.replace(/\+?\d[\d\s-]{7,}\d/g, '[number]');
    t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[date]');
    t = t.replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, '[date]');
    return t;
  };
}

const dayOf = (admitted, d) => {
  if (!admitted || !d) return null;
  const a = Date.parse(String(admitted).slice(0, 10));
  const b = Date.parse(String(d instanceof Date ? d.toISOString() : d).slice(0, 10));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 864e5) + 1 : null;
};

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

// Builds the plain-text record. With deidentify=false it is for the local template only.
export function caseText({ patient, vitals = [], notes = [], tasks = [] }, { deidentify = true } = {}) {
  const c = patient.clinical || {};
  const sp = c.sp || {};
  const scrub = deidentify ? makeScrubber(patient) : t => String(t ?? '');
  const L = [];
  const add = (k, v) => { if (v != null && String(v).trim()) L.push(`${k}: ${scrub(v)}`); };
  const admitted = iso(patient.admitted_at);
  const today = new Date().toISOString().slice(0, 10);

  L.push(`Department: ${DEPARTMENTS[patient.department] || patient.department}`);
  if (!deidentify) { add('Name', patient.name); add('Hospital number', patient.hospital_number); }
  add('Age', patient.age); add('Sex', patient.sex);
  if (admitted) L.push(`Hospital day: ${dayOf(admitted, today)}`);
  add('Status', String(patient.status || '').replace(/_/g, ' '));
  add('Allergies', patient.allergies);
  add('Presenting complaint', c.complaint); add('History of presenting illness', c.hpi);
  add('Past medical history', c.pmh); add('Medications', c.meds); add('Surgical history', c.psh);
  add('Social history', c.social); add('Family history', c.family);
  if (patient.department === 'OBGYN') {
    add('Gravida', sp.gravida); add('Para', sp.para);
    if (sp.lmp) {
      const days = Math.round((Date.parse(today) - Date.parse(sp.lmp)) / 864e5);
      if (days >= 0 && days < 320) L.push(`Gestational age today: ${Math.floor(days / 7)}+${days % 7} weeks`);
    }
    add('Antenatal care', sp.anc); add('Fetal status', sp.fetal);
  }
  if (patient.department === 'PEDS') { add('Birth history', sp.birthHx); add('Immunisation', sp.immun); add('Feeding and growth', sp.feeding); add('Development', sp.dev); }
  if (patient.department === 'SURGERY') {
    add('Procedure', sp.procedure);
    if (sp.opDate) L.push(`Post-operative day: ${dayOf(sp.opDate, today) - 1}`);
    add('Operative findings', sp.opFindings); add('Drains and lines', sp.drains);
  }
  if (patient.department === 'ER') { add('Triage', sp.triage); add('Given in ER', sp.erTx); add('Disposition', sp.dispo); }
  add('Examination', c.exam); add('Laboratory results', c.labs); add('Imaging and other tests', c.imaging);
  add('Working diagnosis', c.dx); add('Differential diagnoses', c.ddx); add('Problem list', c.problems); add('Plan', c.plan);

  const vs = vitals.slice(0, 6).map(v => {
    const parts = [v.sbp && v.dbp ? `BP ${v.sbp}/${v.dbp}` : null, v.hr && `HR ${v.hr}`, v.rr && `RR ${v.rr}`,
      v.temp && `T ${v.temp}`, v.spo2 && `SpO2 ${v.spo2}%`, v.gcs && `GCS ${v.gcs}`, v.glucose && `glucose ${v.glucose}`,
      v.urine && `urine ${v.urine}`, v.avpu && `ACVPU ${v.avpu}`, v.on_oxygen === true ? 'on oxygen' : v.on_oxygen === false ? 'on air' : null].filter(Boolean).join(', ');
    const when = deidentify ? `day ${dayOf(admitted, v.recorded_at) ?? '?'} ${new Date(v.recorded_at).toISOString().slice(11, 16)}` : new Date(v.recorded_at).toISOString().slice(0, 16).replace('T', ' ');
    return parts ? `- ${when}: ${parts}` : null;
  }).filter(Boolean);
  if (vs.length) L.push('Vital signs, newest first:\n' + vs.join('\n'));
  const warn = warningLine(patient, vitals);
  if (warn) L.push('Early warning on newest observations: ' + warn);

  const open = tasks.filter(t => !t.done).map(t => scrub(t.text));
  if (open.length) L.push('Pending tasks: ' + open.join('; '));

  const ns = notes.filter(n => n.kind !== 'addendum').slice(0, 5).map(n => {
    const when = deidentify ? `day ${dayOf(admitted, n.note_date) ?? '?'}` : iso(n.note_date);
    return `[${when}, ${n.kind}] S: ${scrub(n.s) || '-'} | O: ${scrub(n.o) || '-'} | A: ${scrub(n.a) || '-'} | P: ${scrub(n.p) || '-'}`;
  });
  if (ns.length) L.push('Daily notes, newest first:\n' + ns.join('\n'));
  return L.join('\n');
}

export const oneLiner = p => WB.oneLiner(p);

// The early warning line, e.g. "NEWS2 6 (medium risk) ...", from the newest set of observations.
export function warningLine(patient, vitals) {
  const a = WB.assess(patient, vitals?.[0]);
  if (!a) return '';
  return [a.badge, a.reasons?.length ? '(' + a.reasons.join('; ') + ')' : '', a.detail, a.action].filter(Boolean).join(' ');
}

// Used when the AI is off for the hospital or not configured: built locally, nothing leaves.
export function templateSummary(record) {
  const { patient, vitals = [], notes = [], tasks = [] } = record;
  const c = patient.clinical || {};
  const L = [];
  L.push('ONE-LINER\n' + (oneLiner(patient) || 'not documented'));
  if (c.hpi) L.push('HISTORY\n' + c.hpi);
  const v = vitals[0];
  const vline = v ? [v.sbp && v.dbp ? `BP ${v.sbp}/${v.dbp}` : null, v.hr && `HR ${v.hr}`, v.rr && `RR ${v.rr}`,
    v.temp && `T ${v.temp}`, v.spo2 && `SpO2 ${v.spo2}%`].filter(Boolean).join(', ') : '';
  L.push('EXAMINATION\n' + ([vline, c.exam].filter(Boolean).join('\n') || 'not documented'));
  const warn = warningLine(patient, vitals);
  if (warn) L.push('EARLY WARNING\n' + warn);
  if (c.labs || c.imaging) L.push('INVESTIGATIONS\n' + [c.labs, c.imaging].filter(Boolean).join('\n'));
  L.push('ASSESSMENT\n' + (c.dx || 'not documented') + (c.problems ? '\n' + c.problems : ''));
  const last = notes.find(n => n.kind !== 'addendum');
  if (last) L.push(`LATEST NOTE (${iso(last.note_date)})\n` + [['S', last.s], ['O', last.o], ['A', last.a], ['P', last.p]].filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join('\n'));
  L.push('PLAN\n' + (c.plan || 'not documented'));
  const open = tasks.filter(t => !t.done);
  if (open.length) L.push('PENDING\n' + open.map(t => '- ' + t.text).join('\n'));
  L.push('ALLERGIES\n' + (patient.allergies || 'not documented'));
  return L.join('\n\n');
}

export async function aiSummary(kind, record) {
  if (!aiConfigured()) throw new Error('AI is not configured');
  const text = caseText(record, { deidentify: true });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${INSTRUCTIONS[kind]}\n\nPATIENT RECORD\n${text}` }],
  });
  if (response.stop_reason === 'refusal') {
    const err = new Error('The AI declined to summarise this record. Use the template summary instead.');
    err.status = 422;
    throw err;
  }
  const out = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!out) throw Object.assign(new Error('The AI returned an empty summary. Try again.'), { status: 502 });
  return out + (response.stop_reason === 'max_tokens' ? '\n\n[Summary cut short: it reached the length limit.]' : '');
}

export function aiErrorMessage(err) {
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: 'The AI service is busy. Wait a minute and try again.' };
  if (err instanceof Anthropic.AuthenticationError) return { status: 503, message: 'The AI service key is not valid. Tell your hospital admin.' };
  if (err instanceof Anthropic.APIConnectionError) return { status: 503, message: 'The server cannot reach the AI service. Use the template summary.' };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `The AI service returned an error (${err.status}). Try again or use the template summary.` };
  return { status: err.status || 500, message: err.message };
}
