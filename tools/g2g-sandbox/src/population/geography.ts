// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — geography (ADR-047 §3.4)
//
// The 5 provinces and 30 districts are AUTHORITATIVE (shared-types). Province
// names are rendered the way the Irembo identity record renders them, in
// Kinyarwanda. Sector, cell and village names are SYNTHETIC and say so
// ("Synthetic sector 3"), until the official administrative-division dataset
// is imported (ADR-047 §5).
// ══════════════════════════════════════════════════════════════════

import { DISTRICTS, DISTRICT_TO_PROVINCE, type District, type Province } from '@usrp/shared-types';
import type { Rng } from '../prng.js';

/** Kinyarwanda province names as rendered on the identity record. */
export const PROVINCE_LABEL_RW: Readonly<Record<Province, string>> = {
  KIGALI_CITY: 'Umujyi wa Kigali',
  NORTHERN_PROVINCE: 'Amajyaruguru',
  SOUTHERN_PROVINCE: 'Amajyepfo',
  EASTERN_PROVINCE: 'Iburasirazuba',
  WESTERN_PROVINCE: 'Iburengerazuba',
};

export function districtLabel(district: District): string {
  return district.charAt(0) + district.slice(1).toLowerCase();
}

export interface SyntheticAddress {
  readonly province: Province;
  readonly district: District;
  readonly sector: string;
  readonly cell: string;
  readonly village: string;
  /** 10 digits, like the observed villageId; synthetic. */
  readonly villageId: string;
}

export function syntheticAddress(rng: Rng, district?: District): SyntheticAddress {
  const d = district ?? rng.pick(DISTRICTS);
  const districtIndex = DISTRICTS.indexOf(d) + 1;
  const sector = rng.int(1, 9);
  const cell = rng.int(1, 6);
  const village = rng.int(1, 8);
  return {
    province: DISTRICT_TO_PROVINCE[d],
    district: d,
    sector: `Synthetic sector ${String(sector)}`,
    cell: `Synthetic cell ${String(cell)}`,
    village: `Synthetic village ${String(village)}`,
    villageId: `99${String(districtIndex).padStart(2, '0')}${String(sector).padStart(2, '0')}${String(cell).padStart(2, '0')}${String(village).padStart(2, '0')}`,
  };
}
