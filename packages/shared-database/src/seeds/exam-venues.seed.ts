// ══════════════════════════════════════════════════════════════════
// USRP — Exam Venue Seed Data
// Source: Official recruitment announcements (2025-2026)
// This data is seeded once per recruitment cycle by administrators
// NOT hardcoded in application logic — updateable via admin panel
// ══════════════════════════════════════════════════════════════════

export interface ExamVenueSeed {
  district: string;
  province: string;
  venueName: string;
  examDateStart: string;    // ISO date
  examDateEnd: string;
  reportingTimeHour: number;
  agency: string;
  campaignLabel: string;
}

// ── RDF Exam Venues (June 2026) ───────────────────────────────────
// Source: RDF May 2026 announcement, exams June 02-17 2026, 8:00 AM

export const RDF_EXAM_VENUES_2026: ExamVenueSeed[] = [
  // Kigali City
  { district: 'KICUKIRO',   province: 'KIGALI_CITY',       venueName: 'IPRC Kicukiro Stadium',      examDateStart: '2026-06-02', examDateEnd: '2026-06-03', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'GASABO',     province: 'KIGALI_CITY',       venueName: 'ULK Stadium',                examDateStart: '2026-06-04', examDateEnd: '2026-06-05', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NYARUGENGE', province: 'KIGALI_CITY',       venueName: 'Kigali Pelé Stadium (Nyamirambo)', examDateStart: '2026-06-06', examDateEnd: '2026-06-07', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  // Northern Province
  { district: 'GICUMBI',   province: 'NORTHERN_PROVINCE',  venueName: 'Gicumbi Stadium',            examDateStart: '2026-06-02', examDateEnd: '2026-06-03', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'BURERA',    province: 'NORTHERN_PROVINCE',  venueName: 'District Headquarters',      examDateStart: '2026-06-04', examDateEnd: '2026-06-05', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'MUSANZE',   province: 'NORTHERN_PROVINCE',  venueName: 'Ubworoherane Stadium',       examDateStart: '2026-06-06', examDateEnd: '2026-06-07', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'GAKENKE',   province: 'NORTHERN_PROVINCE',  venueName: 'Ngando Football Pitch',      examDateStart: '2026-06-08', examDateEnd: '2026-06-09', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'RULINDO',   province: 'NORTHERN_PROVINCE',  venueName: 'Gasiza Pitch',               examDateStart: '2026-06-10', examDateEnd: '2026-06-11', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  // Southern Province
  { district: 'NYAMAGABE', province: 'SOUTHERN_PROVINCE',  venueName: 'Nyamagabe Stadium',          examDateStart: '2026-06-02', examDateEnd: '2026-06-03', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NYARUGURU', province: 'SOUTHERN_PROVINCE',  venueName: 'Ndago Football Pitch',       examDateStart: '2026-06-04', examDateEnd: '2026-06-05', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'GISAGARA',  province: 'SOUTHERN_PROVINCE',  venueName: 'District Headquarters',      examDateStart: '2026-06-06', examDateEnd: '2026-06-07', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'HUYE',      province: 'SOUTHERN_PROVINCE',  venueName: 'Huye Stadium',               examDateStart: '2026-06-08', examDateEnd: '2026-06-09', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NYANZA',    province: 'SOUTHERN_PROVINCE',  venueName: 'Nyanza Stadium',             examDateStart: '2026-06-10', examDateEnd: '2026-06-11', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'RUHANGO',   province: 'SOUTHERN_PROVINCE',  venueName: 'District Headquarters',      examDateStart: '2026-06-12', examDateEnd: '2026-06-13', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'MUHANGA',   province: 'SOUTHERN_PROVINCE',  venueName: 'Muhanga Stadium',            examDateStart: '2026-06-14', examDateEnd: '2026-06-15', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'KAMONYI',   province: 'SOUTHERN_PROVINCE',  venueName: 'District Headquarters',      examDateStart: '2026-06-16', examDateEnd: '2026-06-17', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  // Eastern Province
  { district: 'KIREHE',    province: 'EASTERN_PROVINCE',   venueName: 'District Headquarters',      examDateStart: '2026-06-02', examDateEnd: '2026-06-03', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NGOMA',     province: 'EASTERN_PROVINCE',   venueName: 'Ngoma Football Pitch',       examDateStart: '2026-06-04', examDateEnd: '2026-06-05', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NYAGATARE', province: 'EASTERN_PROVINCE',   venueName: 'Nyagatare Stadium',          examDateStart: '2026-06-06', examDateEnd: '2026-06-07', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'GATSIBO',   province: 'EASTERN_PROVINCE',   venueName: 'District Headquarters',      examDateStart: '2026-06-08', examDateEnd: '2026-06-09', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'KAYONZA',   province: 'EASTERN_PROVINCE',   venueName: 'District Headquarters',      examDateStart: '2026-06-10', examDateEnd: '2026-06-11', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'RWAMAGANA', province: 'EASTERN_PROVINCE',   venueName: 'District Headquarters',      examDateStart: '2026-06-12', examDateEnd: '2026-06-13', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'BUGESERA',  province: 'EASTERN_PROVINCE',   venueName: 'Bugesera Stadium',           examDateStart: '2026-06-14', examDateEnd: '2026-06-15', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  // Western Province
  { district: 'RUSIZI',    province: 'WESTERN_PROVINCE',   venueName: 'Rusizi Stadium',             examDateStart: '2026-06-02', examDateEnd: '2026-06-03', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NYAMASHEKE',province: 'WESTERN_PROVINCE',   venueName: 'District Headquarters',      examDateStart: '2026-06-04', examDateEnd: '2026-06-05', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'KARONGI',   province: 'WESTERN_PROVINCE',   venueName: 'Mbonwa Pitch',               examDateStart: '2026-06-06', examDateEnd: '2026-06-07', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'RUTSIRO',   province: 'WESTERN_PROVINCE',   venueName: 'Rutsiro Stadium',            examDateStart: '2026-06-08', examDateEnd: '2026-06-09', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'RUBAVU',    province: 'WESTERN_PROVINCE',   venueName: 'Rubavu Stadium',             examDateStart: '2026-06-10', examDateEnd: '2026-06-11', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NYABIHU',   province: 'WESTERN_PROVINCE',   venueName: 'Mukamira Military Barracks', examDateStart: '2026-06-12', examDateEnd: '2026-06-13', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
  { district: 'NGORORERO', province: 'WESTERN_PROVINCE',   venueName: 'Ngororero Stadium',          examDateStart: '2026-06-14', examDateEnd: '2026-06-15', reportingTimeHour: 8, agency: 'RDF', campaignLabel: 'RDF-2026' },
];

// ── RCS General Enlistee Exam Venues (August 2025) ────────────────
// Source: RCS Aug 2025 announcement, exams Aug 25-31 2025, 9:00 AM

export const RCS_GENERAL_EXAM_VENUES_2025: ExamVenueSeed[] = [
  // Northern Province
  { district: 'GICUMBI',   province: 'NORTHERN_PROVINCE', venueName: 'Gicumbi District Hall',       examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'MUSANZE',   province: 'NORTHERN_PROVINCE', venueName: 'Ubworoherane Stadium',        examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'BURERA',    province: 'NORTHERN_PROVINCE', venueName: 'Kirambo Stadium',             examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'GAKENKE',   province: 'NORTHERN_PROVINCE', venueName: 'Gakenke District Hall',       examDateStart: '2025-08-26', examDateEnd: '2025-08-26', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'RULINDO',   province: 'NORTHERN_PROVINCE', venueName: 'Gasiza Pitch',                examDateStart: '2025-08-27', examDateEnd: '2025-08-27', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  // Eastern Province
  { district: 'RWAMAGANA', province: 'EASTERN_PROVINCE',  venueName: 'Rwamagana District HQ',      examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NGOMA',     province: 'EASTERN_PROVINCE',  venueName: 'Ngoma Stadium',               examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NYAGATARE', province: 'EASTERN_PROVINCE',  venueName: 'Nyagatare Stadium',           examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'BUGESERA',  province: 'EASTERN_PROVINCE',  venueName: 'Bugesera Stadium',            examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'GATSIBO',   province: 'EASTERN_PROVINCE',  venueName: 'Gatsibo District HQ',         examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'KAYONZA',   province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District HQ',         examDateStart: '2025-08-26', examDateEnd: '2025-08-26', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'KIREHE',    province: 'EASTERN_PROVINCE',  venueName: 'Kirehe District Hall',         examDateStart: '2025-08-27', examDateEnd: '2025-08-27', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  // Southern Province
  { district: 'NYAMAGABE', province: 'SOUTHERN_PROVINCE', venueName: 'Nyamagabe Stadium',           examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NYANZA',    province: 'SOUTHERN_PROVINCE', venueName: 'Nyanza Stadium',              examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'HUYE',      province: 'SOUTHERN_PROVINCE', venueName: 'Huye Prison (Correctional Facility)', examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'MUHANGA',   province: 'SOUTHERN_PROVINCE', venueName: 'Muhanga Stadium',             examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NYARUGURU', province: 'SOUTHERN_PROVINCE', venueName: 'Ndago Football Pitch',        examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'GISAGARA',  province: 'SOUTHERN_PROVINCE', venueName: 'District Headquarters',       examDateStart: '2025-08-26', examDateEnd: '2025-08-26', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'RUHANGO',   province: 'SOUTHERN_PROVINCE', venueName: 'District Headquarters',       examDateStart: '2025-08-27', examDateEnd: '2025-08-27', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'KAMONYI',   province: 'SOUTHERN_PROVINCE', venueName: 'District Headquarters',       examDateStart: '2025-08-28', examDateEnd: '2025-08-28', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  // Western Province
  { district: 'RUBAVU',    province: 'WESTERN_PROVINCE',  venueName: 'Rubavu Stadium',              examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'RUSIZI',    province: 'WESTERN_PROVINCE',  venueName: 'Rusizi Stadium',              examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NYAMASHEKE',province: 'WESTERN_PROVINCE',  venueName: 'District Headquarters',       examDateStart: '2025-08-25', examDateEnd: '2025-08-25', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'KARONGI',   province: 'WESTERN_PROVINCE',  venueName: 'District Youth Center Hall',  examDateStart: '2025-08-26', examDateEnd: '2025-08-26', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'RUTSIRO',   province: 'WESTERN_PROVINCE',  venueName: 'Rutsiro Stadium',             examDateStart: '2025-08-27', examDateEnd: '2025-08-27', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NGORORERO', province: 'WESTERN_PROVINCE',  venueName: 'District Stadium',            examDateStart: '2025-08-28', examDateEnd: '2025-08-28', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'NYABIHU',   province: 'WESTERN_PROVINCE',  venueName: 'Nyabihu Stadium',             examDateStart: '2025-08-29', examDateEnd: '2025-08-29', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  // Kigali City (all three districts share one venue)
  { district: 'NYARUGENGE', province: 'KIGALI_CITY',      venueName: 'Gasabo District HQ',          examDateStart: '2025-08-28', examDateEnd: '2025-08-28', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'KICUKIRO',   province: 'KIGALI_CITY',      venueName: 'Gasabo District HQ',          examDateStart: '2025-08-28', examDateEnd: '2025-08-28', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
  { district: 'GASABO',     province: 'KIGALI_CITY',      venueName: 'Gasabo District HQ',          examDateStart: '2025-08-28', examDateEnd: '2025-08-28', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-GENERAL-2025' },
];

// ── RCS Officer Exam Venues (June-July 2026) ──────────────────────
// Source: RCS Jun 2026 announcement, exams Jun 30 - Jul 02 2026, 9:00 AM
// Note: Multi-district groupings — applicants go to regional consolidation points

export const RCS_OFFICER_EXAM_VENUES_2026: ExamVenueSeed[] = [
  // Northern: All 5 districts → Ubworoherane Stadium
  { district: 'GICUMBI',    province: 'NORTHERN_PROVINCE', venueName: 'Ubworoherane Stadium',  examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'MUSANZE',    province: 'NORTHERN_PROVINCE', venueName: 'Ubworoherane Stadium',  examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'BURERA',     province: 'NORTHERN_PROVINCE', venueName: 'Ubworoherane Stadium',  examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'GAKENKE',    province: 'NORTHERN_PROVINCE', venueName: 'Ubworoherane Stadium',  examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'RULINDO',    province: 'NORTHERN_PROVINCE', venueName: 'Ubworoherane Stadium',  examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  // Western Group 1: 4 districts → Rubavu Stadium
  { district: 'RUBAVU',     province: 'WESTERN_PROVINCE',  venueName: 'Rubavu Stadium',        examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NYABIHU',    province: 'WESTERN_PROVINCE',  venueName: 'Rubavu Stadium',        examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NGORORERO',  province: 'WESTERN_PROVINCE',  venueName: 'Rubavu Stadium',        examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'RUTSIRO',    province: 'WESTERN_PROVINCE',  venueName: 'Rubavu Stadium',        examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  // Western Group 2: 3 districts → Rusizi Stadium
  { district: 'RUSIZI',     province: 'WESTERN_PROVINCE',  venueName: 'Rusizi Stadium',        examDateStart: '2026-07-02', examDateEnd: '2026-07-02', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NYAMASHEKE', province: 'WESTERN_PROVINCE',  venueName: 'Rusizi Stadium',        examDateStart: '2026-07-02', examDateEnd: '2026-07-02', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'KARONGI',    province: 'WESTERN_PROVINCE',  venueName: 'Rusizi Stadium',        examDateStart: '2026-07-02', examDateEnd: '2026-07-02', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  // Eastern: 6 districts → Kayonza District Office
  { district: 'RWAMAGANA',  province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District Office', examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'KAYONZA',    province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District Office', examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NGOMA',      province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District Office', examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'KIREHE',     province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District Office', examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'GATSIBO',    province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District Office', examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NYAGATARE',  province: 'EASTERN_PROVINCE',  venueName: 'Kayonza District Office', examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  // Southern Group 1: 4 districts → Huye Stadium
  { district: 'HUYE',       province: 'SOUTHERN_PROVINCE', venueName: 'Huye Stadium',          examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NYAMAGABE',  province: 'SOUTHERN_PROVINCE', venueName: 'Huye Stadium',          examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NYARUGURU',  province: 'SOUTHERN_PROVINCE', venueName: 'Huye Stadium',          examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'GISAGARA',   province: 'SOUTHERN_PROVINCE', venueName: 'Huye Stadium',          examDateStart: '2026-06-30', examDateEnd: '2026-06-30', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  // Southern Group 2: 4 districts → Muhanga Stadium
  { district: 'MUHANGA',    province: 'SOUTHERN_PROVINCE', venueName: 'Muhanga Stadium',       examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'NYANZA',     province: 'SOUTHERN_PROVINCE', venueName: 'Muhanga Stadium',       examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'RUHANGO',    province: 'SOUTHERN_PROVINCE', venueName: 'Muhanga Stadium',       examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'KAMONYI',    province: 'SOUTHERN_PROVINCE', venueName: 'Muhanga Stadium',       examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  // Kigali + Bugesera → Gasabo District Office
  { district: 'NYARUGENGE', province: 'KIGALI_CITY',       venueName: 'Gasabo District Office', examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'KICUKIRO',   province: 'KIGALI_CITY',       venueName: 'Gasabo District Office', examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'GASABO',     province: 'KIGALI_CITY',       venueName: 'Gasabo District Office', examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
  { district: 'BUGESERA',   province: 'EASTERN_PROVINCE',  venueName: 'Gasabo District Office', examDateStart: '2026-07-01', examDateEnd: '2026-07-01', reportingTimeHour: 9, agency: 'RCS', campaignLabel: 'RCS-OFFICER-2026' },
];

// ── All venues combined (for seeding) ────────────────────────────
export const ALL_EXAM_VENUES: ExamVenueSeed[] = [
  ...RDF_EXAM_VENUES_2026,
  ...RCS_GENERAL_EXAM_VENUES_2025,
  ...RCS_OFFICER_EXAM_VENUES_2026,
  // RNP venues: Registration at DPU — no centralized exam venue list
  // published in available announcements. Seeded when RNP provides data.
];
