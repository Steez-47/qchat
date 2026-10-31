import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({window: {}, URL});
for (const file of ['ui/vendor/acorn.js', 'ui/response-tags.js', 'ui/interactive.js']) vm.runInContext(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, {filename: file, timeout: 2000});
context.window.acorn = context.acorn;
const make = () => context.window.QInteractive.createSession();
const source = `{@body const [items,setItems]=DIL.useState([{name:'Chess',price:'$20'}]); const extras=[{name:'Go',price:'$10'},{name:'Cards',price:'$5'}];}
# Games
{#each items as game}<Card title={game.name}>{game.name}: {game.price}</Card>{/each}
<button onClick={()=>setItems([...items, extras[items.length % extras.length]])}>Add game</button>
{#if items.length > 1}Many{:else}One{/if}`;
const session = make();
let result = session.render(source);
assert.match(result.text, /Chess/); assert.match(result.text, /\$20/); assert.match(result.text, /One/);
assert.equal(result.controls[0].label, 'Add game');
assert.equal(session.dispatch(result.controls[0].id), true);
result = session.render(source); assert.match(result.text, /Cards/); assert.match(result.text, /Many/);
assert.equal(session.dispatch(result.controls[0].id), true);
result = session.render(source); assert.match(result.text, /Go/);
result = session.render(source + '\n{@body const pending ='); assert.match(result.text, /Go/); assert.doesNotMatch(result.text, /pending/);
const functional = make();
const funcSource = `{@body const [n,setN]=DIL.useState(0);}<button onClick={()=>setN(prev=>prev+1)}>Next</button>{n*2}`;
let f = functional.render(funcSource); functional.dispatch(f.controls[0].id); f = functional.render(funcSource); assert.match(f.text, /2$/);
const input = make();
const inputSource = `{@body const [name,setName]=DIL.useState('Ada'); const [checked,setChecked]=DIL.useState(false);}<input value={name} onChange={value=>setName(value)} /><select value={name} onChange={e=>setName(e.target.value)}><option value="Ada">Ada</option><option value="Grace">Grace</option></select><checkbox checked={checked} onChange={e=>setChecked(e.target.checked)} />{name}:{checked}`;
let form = input.render(inputSource); assert.equal(form.controls.length, 3); assert.equal(form.controls[1].options.length, 2);
assert.equal(input.dispatch('q0', 'Lin'), true); form = input.render(inputSource); assert.match(form.text, /Lin:false/);
assert.equal(input.dispatch('q1', 'Grace'), true); assert.equal(input.dispatch('q2', true), true); form = input.render(inputSource); assert.match(form.text, /Grace:true/);
const literal = '`{@body const x=1;} {x} <button onClick={()=>x}>x</button>`\n```js\n{@body const x=2;}\n```\n$1+{x}$';
assert.equal(make().render(literal).text, literal);
const constant = make().render(`{@body const games=[{name:'A'}, {name:'B'}];}{#each games as game}<Card title={game.name}>{game.name}</Card>{/each}`);
assert.match(constant.text, /title="A"/); assert.match(constant.text, /title="B"/); assert.doesNotMatch(constant.text, /@body/);
for (const attack of ['window.fetch("https://evil.test")', 'fetch("https://evil.test")', 'globalThis.process.exit()', '({}).constructor.constructor("return window")()', 'items["__proto__"]', 'DIL.issueNewTurn("send")', 'import("node:fs")', 'new Function("return 1")()', 'window.__TAURI__.core.invoke("shell")']) {
  const hostile = make(); const text = `{@body const [items,setItems]=DIL.useState([]); const x=${attack};}<button onClick={()=>${attack}}>Go</button>{items.length}`;
  const view = hostile.render(text); assert.equal(hostile.dispatch(view.controls[0]?.id), false); assert.match(view.text, /0$/);
}
const unsupported = make().render('<button onClick={()=>GenUI.issueNewTurn("hello")}>Send</button>');
assert.equal(unsupported.controls[0].attrs.disabled, true);
assert.match(make().render(`{@body const text='<button>';}{text}`).text, /&lt;button&gt;/);
assert.match(make().render(`{"<button>"}`).text, /&lt;button&gt;/);
assert.doesNotMatch(make().render('Hello {@bod').text, /@bod/);
const bounded = make(); const large = '"x",'.repeat(1100);
assert.ok(bounded.render(`{@body const a=[${large}];}{#each a as x}{x}{/each}`).text.length <= 100000);
assert.ok(make().render('{@body const x=1;}\n{#each [1,2,3] as a}'.repeat(60)).text.length <= 100000);
assert.doesNotMatch(fs.readFileSync(new URL('../ui/interactive.js', import.meta.url), 'utf8'), /\beval\s*\(|\bnew\s+Function\s*\(/);
console.log('interactive-test: all assertions passed');

const nestedCoercion='{@body const a0=["x"];'+Array.from({length:26},(_,i)=>`const a${i+1}=[a${i},a${i}];`).join('')+'const x="x".includes(a26);}<text>{x}</text>';
const coercionStart=performance.now();make().render(nestedCoercion);assert.ok(performance.now()-coercionStart<500,'nested arrays must never be coerced by native methods');
const joinLimit='{@body const x="'+ 'x'.repeat(1000) +'";const a=['+Array(200).fill('x').join(',')+'];const result=a.join("");}<text>{result}</text>';
assert.ok(make().render(joinLimit).text.length<100000);

const inputAlias=make();const aliasSource='{@body const [v,setV]=DIL.useState("old")}<input value={v} onInput={x=>setV(x)}/>{v}';
let alias=inputAlias.render(aliasSource);assert.equal(alias.controls[0].attrs.disabled,undefined);assert.equal(inputAlias.dispatch('q0','new'),true);assert.match(inputAlias.render(aliasSource).text,/new$/);

const openButton=make();const openButtonSource='{@body const [n,setN]=DIL.useState(0)}<button onClick={()=>setN(n+1)}>Add item';
assert.equal(openButton.render(openButtonSource).controls[0].label,'Add item');
assert.equal(openButton.render(openButtonSource+'</button>').controls[0].label,'Add item');
const selfClosed=make().render('{@body const [n,setN]=DIL.useState(0)}Click: <button onClick={()=>setN(n+1)} /> Follow-up paragraph. <button onClick={()=>setN(0)}>Reset</button>');
assert.match(selfClosed.text,/Follow-up paragraph\./,'text after a self-closing button survives');
assert.equal(selfClosed.controls[0].label,'','a self-closing button has no label of its own');
assert.equal(selfClosed.controls[1].label,'Reset','the next control keeps its own label');
assert.equal(selfClosed.controls.length,2);
