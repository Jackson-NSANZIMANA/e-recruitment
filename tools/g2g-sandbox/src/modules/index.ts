import type { SimulatorModule } from '../module.js';
import { iremboCertificatesMount, smsTwilioMount } from './empty-mounts.js';
import { nesaSdmsModule } from './nesa-sdms.js';
import { nidaIremboModule } from './nida-irembo.js';

/** Every mounted simulator, in match order. S12b replaces the two empty mounts. */
export const MODULES: readonly SimulatorModule[] = [nidaIremboModule, nesaSdmsModule, iremboCertificatesMount, smsTwilioMount];
