import { afterAll, beforeAll, describe, test } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { assertForkReviewReadPolicy } from '../helpers/fork-review-read-policy.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
(hasDatabase()?describe:describe.skip)('fork page ACL SQL on PostgreSQL',()=>{
 let engine:BrainEngine;
 beforeAll(async()=>{engine=await setupDB();});
 afterAll(teardownDB);
 test('facts, volunteer pointers, salience and ontology filter before delivery',async()=>{await assertForkReviewReadPolicy(engine);});
});
