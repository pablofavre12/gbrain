import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { defineColdTemporalSemanticsTests } from './helpers/link-temporal-cold-semantics-scenario.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); });
defineColdTemporalSemanticsTests(() => engine);
