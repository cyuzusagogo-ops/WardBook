// What each role may do. The database policies are the authority; this table only decides
// which buttons the interface shows and lets the API refuse early with a clear message.
export const ROLES = {
  intern:             'Intern',
  resident:           'Resident',
  attending:          'Attending / consultant',
  head_of_department: 'Head of department',
  nurse:              'Nurse',
  student:            'Medical student',
  hospital_admin:     'Hospital admin',
  auditor:            'Auditor',
};

export const DEPARTMENTS = {
  IM: 'Internal Medicine',
  SURGERY: 'Surgery',
  PEDS: 'Pediatrics',
  ER: 'Emergency',
  OBGYN: 'Obstetrics & Gynecology',
};

const CLINICIANS = ['intern', 'resident', 'attending', 'head_of_department'];
const SIGNERS = ['resident', 'attending', 'head_of_department'];

export function permissionsFor(role) {
  const clin = CLINICIANS.includes(role);
  return {
    seePatients: clin || ['nurse', 'student', 'auditor'].includes(role),
    admit: clin,
    editClinical: clin,
    sign: SIGNERS.includes(role),
    discharge: SIGNERS.includes(role),
    transfer: clin,
    assign: clin,
    recordVitals: clin || role === 'nurse',
    writeNotes: clin || role === 'nurse' || role === 'student',
    manageTasks: clin || role === 'nurse',
    summarize: clin || role === 'student',
    acceptSummary: clin,
    viewAudit: ['hospital_admin', 'head_of_department', 'auditor'].includes(role),
    manageStaff: role === 'hospital_admin',
    deidentified: role === 'student',
  };
}

export const noteKindFor = role =>
  CLINICIANS.includes(role) ? 'soap' : role === 'nurse' ? 'nursing' : role === 'student' ? 'student' : null;
