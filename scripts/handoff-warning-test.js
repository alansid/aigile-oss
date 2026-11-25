import assert from 'node:assert/strict';
import { handoffWarning } from '../src/wake-hint.js';

const ai = { id: 'worker', code: 'RVVW', kind: 'ai', status: 'active' };
const human = { id: 'owner', kind: 'human', status: 'active' };
const people = new Map([ai, human].map(p => [p.id, p]));
const check = (text, ask) => handoffWarning(text, ask, people, 'author', [ai, human]).length;
assert.equal(check('[交接] 請接手', ['owner']), 1);
assert.equal(check('[交接] @RVVW 請接手', null), 1);
assert.equal(check('[交接] @RVVW 請接手', []), 1);
assert.equal(check('[交接] @RVVW 請接手', ['worker']), 0);
assert.equal(check('[交接] @RVVW2 請接手', []), 0);
assert.equal(check('[進度] @RVVW', ['owner']), 0);
