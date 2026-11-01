import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../ui/find-text.js', import.meta.url), 'utf8'), context);
const indices = (text, query) => JSON.parse(JSON.stringify(context.window.QFindText.indices(text, query)));
const check = (text, query, expected) => assert.deepEqual(indices(text, query), expected);

check('one TWO one', 'one', [{ start: 0, end: 3 }, { start: 8, end: 11 }]);
check('aaaaa', 'aa', [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
check('[.*]+? x [.*]+?', '[.*]+?', [{ start: 0, end: 6 }, { start: 9, end: 15 }]);
check('K k ſ S', 'k', [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
check('K k ſ S', 's', [{ start: 4, end: 5 }, { start: 6, end: 7 }]);
check('a😀B😀', '😀', [{ start: 1, end: 3 }, { start: 4, end: 6 }]);
check('anything', '', []);
check('first\nsecond\nfirst', 't\ns', [{ start: 4, end: 7 }]);
check('first\nsecond', 'firstsecond', []);
console.log('find-text indices tests passed');
