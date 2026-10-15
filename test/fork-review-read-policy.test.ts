import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assertForkReviewReadPolicy } from './helpers/fork-review-read-policy.ts';
let engine:PGLiteEngine;
beforeAll(async()=>{engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();});
afterAll(async()=>{await engine.disconnect();});
test('facts, volunteer pointers, salience and ontology retain page ACLs',async()=>{await assertForkReviewReadPolicy(engine);});
