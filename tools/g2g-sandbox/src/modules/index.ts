import type { SimulatorModule } from '../module.js';
import { iremboCertificatesModule } from './irembo-certificates.js';
import { nesaSdmsModule } from './nesa-sdms.js';
import { nidaIremboModule } from './nida-irembo.js';
import { createSmsTwilioModule, type SmsTwilioOptions } from './sms-twilio.js';

/** The four simulators, in match order. The SMS emulator holds state, so it is built per server. */
export function buildModules(sms: SmsTwilioOptions = {}): readonly SimulatorModule[] {
  return [nidaIremboModule, nesaSdmsModule, iremboCertificatesModule, createSmsTwilioModule(sms)];
}

/** Default set (development credentials, no inbox file). */
export const MODULES: readonly SimulatorModule[] = buildModules();
