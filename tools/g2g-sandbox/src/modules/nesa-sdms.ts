// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — nesa-sdms: NESA results in the SDMS wire format
//
//   GET /api/v1/public/results/by-index?indexNumber=<index>   (public, no auth)
//
// Found: the bare results object (contracts/sdms-results-by-index.schema.json).
// SANDBOX ASSUMPTIONS until a live capture shows them: unknown index → 404
// {message}; missing parameter → 400 {message}; status-false behaviour → 200
// with an empty object (SDMS has no status envelope).
// ══════════════════════════════════════════════════════════════════

import type { SimResponse, SimulatorModule, Subject } from '../module.js';

export const SDMS_RESULTS_PATH = '/api/v1/public/results/by-index';

export const nesaSdmsModule: SimulatorModule = {
  id: 'nesa-sdms',
  authority: 'nesa',
  matches: (method, path) => method === 'GET' && path === SDMS_RESULTS_PATH,
  // Public endpoint: one shared budget, as an anonymous client would see.
  authorize: () => ({ client: 'public' }),
  subject(req, world): Subject | null {
    const index = req.query.get('indexNumber')?.trim() ?? '';
    const overlayIndex = world.overlay?.nesa?.['studentIndexNumber'];
    if (world.overlay !== null && overlayIndex === index) return { kind: 'private', persona: world.overlay };
    const hit = world.population.findByIndex(index);
    return hit === null ? null : { kind: 'synthetic', citizen: hit.citizen };
  },
  fault(kind): SimResponse {
    if (kind === 'rate-limited') return { status: 429, json: { message: 'Too many requests' } };
    if (kind === 'maintenance') return { status: 503, json: { message: 'Service temporarily unavailable' } };
    return { status: 200, json: {} };
  },
  async handle(req, subject, world): Promise<SimResponse> {
    const index = req.query.get('indexNumber')?.trim() ?? '';
    if (index === '') return { status: 400, json: { message: 'indexNumber is required' } };
    if (world.live?.appliesTo(index) === true) {
      const live = await world.live.fetch(index);
      switch (live.kind) {
        case 'OK': return { status: 200, json: live.record };
        case 'NOT_FOUND': return { status: 404, json: { message: 'Results not found' } };
        case 'THROTTLED': return { status: 429, json: { message: 'Too many requests' }, headers: { 'retry-after': String(live.retryAfterSeconds) } };
        case 'DRIFT': return { status: 502, json: { message: 'Live SDMS answer no longer matches the captured contract' } };
        case 'UNAVAILABLE': return { status: 503, json: { message: 'Service temporarily unavailable' } };
      }
    }
    if (subject === null) return { status: 404, json: { message: 'Results not found' } };
    if (subject.kind === 'private') return { status: 200, json: subject.persona.nesa };
    return { status: 200, json: subject.citizen.nesa };
  },
};
