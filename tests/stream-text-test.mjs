import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const ctx = vm.createContext({window:{},Intl});
vm.runInContext(readFileSync('ui/response-tags.js','utf8'),ctx);
vm.runInContext(readFileSync('ui/stream-text.js','utf8'),ctx);
const boundary=ctx.window.QStream.completeBoundary;
for(const [text,want] of [
 ['First unfinished',0],['First **rich**.\n\nSecond',17],
 ['```js\na\n\nb\n',0],['```js\na\n\nb\n```\n\n',16],
 ['$$\nx\n\ny\n',0],['\\[\nx\n\ny\n',0],
 ['<section><div>one\n\ntwo</div>\n\n',0],
 ['<section><div>one\n\ntwo</div></section>',38],
 ['<section><div>one\n\ntwo</div></section>\n\n',40],
 ['`<div>` and 2 < 3\n\n',19],
 ['<div title="a\n\n>b">x\n\n',0],
 ['<div title="a\n\n>b">x\n\n</div>','<div title="a\n\n>b">x\n\n</div>'.length],
 ['| a | b |\n|---|---|\n| x | y |\n',0],
 ['Before\n\n<div',8],
]) assert.equal(boundary(text),want,JSON.stringify(text));
for (const text of [
 'One.\n\nHe said `hello\n\nNext paragraph\n\n',
 'One \\(bad\n\nNext paragraph\n\n',
 'A.\n\nif x<y then a > b\n\nC.\n\n',
 'A.\n\nwhen a <b we stop\n\nC.\n\n',
 'Alpha<b>bold\n\nstill</b>\n\n',
 '<Entity value={3 > 2 ? "yes" : "no"}/>\n\n',
 '<pre>literal `<Entity>\n\nmore</pre>\n\n',
 'First.\r\n\r\nSecond.\r\n\r\n',
 '- a\n\n- b\n\nNext paragraph.\n\n',
]) assert.equal(boundary(text),text.length,JSON.stringify(text));
for (const tail of ['```js\nx\n','<pre>one\n\ntwo\n','$$\nx\n\ny\n']) {
 assert.equal(boundary('Done.\n\n'+tail),7,JSON.stringify(tail));
}
for (const [text, want] of [
 ['- a\n\n- b',5], ['1. one\n\n2. two',8],
 ['- first\n- ',0], ['- first\n- second',8],
 ['- first\n  - nested\n  - growing',0],
 ['- first\n  - nested\n- second',19],
 ['> - first\n> - second',0],
 ['- <section>first\n- second',0],
 ['- first\n  $$\nx\n- second',0],
 ['- ```js\n  const a = 1;\n- second',0],
 ['- first\n- <section>second',8],
]) assert.equal(boundary(text),want,JSON.stringify(text));
console.log('PASS completed block boundaries');

const loop = '{#each [{name:"A"},{name:"B"}] as item}\n\n{item.name}\n\n';
assert.equal(boundary('Done.\n\n'+loop),7,'an open each is withheld');
assert.equal(boundary(loop+'{/each}\n\n'),(loop+'{/each}\n\n').length);
assert.equal(boundary('Done.\n\n'+loop+'{/each}'),7+(loop+'{/each}').length,'each closer at EOF releases at once');
assert.equal(boundary('Done.\n\n'+loop+'{/ea'),7,'a split each closer waits');
assert.equal(boundary('Done.\n\n{#each [{name:"unfinished'),7);
assert.equal(boundary('`{#each literal}`\n\n'),19);
console.log('PASS each block boundaries');

// Tags and templates: only a real matching closer (every outer scope) releases a block.
const blocks=[
 ['<section>\n<div>\n\none</div>\n\n',0],
 ['Done.\n\n<section>a\n\n<div>b</div>\n\n',7],
 ['<section>a\n\n<div>b</div>\n\n</section>',null],
 ['<section>a</sec',0],['<section>a</section',0],['<section>a</section>',null],
 ['Hi.\n\n<section>a</section>\n',null],
 ['Hi.\n\n<br>\n\nBye.\n\n',null],
 ['<Card title="a\n\nb">x\n\ny</Card>',null],['<Card title="a\n\nb">x\n\ny</Car',0],
 ['{#each [1] as i}\n<section>x\n\n</section>\n\n',0],
 ['{#each [{a:1}] as i}\n<section>x\n\n</section>\n\n{/each}',null],
 ['Text <b>bold</b>',0],['Text with Array<object> and List<Item>\n\n',null],
 ['Text <b>bold\n\nmore</b>\n\n',null],
];
for (const [text,want] of blocks) assert.equal(boundary(text),want===null?text.length:want,JSON.stringify(text));
// A split closer across successive snapshots leaks nothing until it is whole.
const full='Intro.\n\n<section>one\n\ntwo</section>';
for (let n=full.indexOf('<section>')+1;n<full.length;n++) assert.equal(boundary(full.slice(0,n)),8,'partial '+n);
assert.equal(boundary(full),full.length);
console.log('PASS tag and template closers');

for (const text of ['<section><mark>Unfinished</section>','{#each [1] as i}<section>Unfinished{/each}']) assert.equal(boundary(text),0,'missing inner closer: '+text);
for (const text of ['Alpha<B>unfinished\n\n','Alpha<DIV>unfinished\n\n']) assert.equal(boundary(text),0,'uppercase HTML needs its real closer: '+text);
const sibling='<section>Finished</section>';
assert.equal(boundary(sibling+'<section>Unfinished'),sibling.length,'finished adjacent sibling releases immediately');
for (const text of [sibling+'<section>Also finished</section>','<Card/>','<Entity value="Done"/>',sibling+'<Card/>']) assert.equal(boundary(text),text.length,'every complete adjacent or self-closing block releases: '+text);
for (const text of ['> ~~~html\n> <section>\n> ~~~\n\nNext paragraph.\n\n','- item\n\n    ~~~html\n    <section>\n    ~~~\n\nNext paragraph.\n\n']) assert.equal(boundary(text),text.length,'tag syntax in container fences stays literal: '+text);
for (const text of ['Inline $<section>$ math.\n\n','The price is $5 and $10.\n\n','<Card title="\n```\n">x</Card>','<Card data={{value: `\n~~~\n`}}>x</Card>']) assert.equal(boundary(text),text.length,'literal syntax inside math or attributes: '+text);

// Fences and display maths release on their real closer, including at EOF.
const F='`'.repeat(3);
for (const text of ['Done.\n\n'+F+'js\na\n\nb\n'+F,'Done.\n\n'+F+'js\na\n'+F+'\n','Done.\n\n~~~\nx\n~~~','Done.\n\n$$\nx\n\ny\n$$','Done.\n\n\\[\nx\n\\]','Done.\n\n$$x^2$$']) assert.equal(boundary(text),text.length,JSON.stringify(text));
for (const text of ['Done.\n\n'+F+'js\na\n``','Done.\n\n````\na\n'+F,'Done.\n\n$$\nx\n$','Done.\n\n\\[\nx\n\\','Done.\n\n'+F+'js']) assert.equal(boundary(text),7,JSON.stringify(text));
for (const closer of ['- '+F,'> '+F,'    '+F]) {
 const text=F+'js\nunfinished\n'+closer+'\n';
 assert.equal(boundary(text),0,'fence-like code is not a real closer: '+closer);
 assert.equal(boundary(text+F),(text+F).length,'a later real fence closer releases the block');
}
assert.equal(boundary('> '+F+'js\n> unfinished\n'+F),0,'a quote fence requires a closer in the same quote');
assert.equal(boundary('Inline $$x$$ ends'),0,'maths inside a sentence waits for its paragraph');
assert.equal(boundary(F+'\n</section>\n'+F),F.length*2+12,'tags in code are ignored');
assert.equal(boundary('`<div>` text\n\n'),14);
assert.equal(boundary('\\<div> text\n\n'),'\\<div> text\n\n'.length,'escaped tags are text');
assert.equal(boundary('$$\n<div>\n$$\n\n'),'$$\n<div>\n$$\n\n'.length,'tags in maths are ignored');
// A released prefix never shrinks as the stream grows, and only whole blocks are released.
const doc='A.\n\n- a\n- b\n\nB.\n\n'+F+'js\nx\n\ny\n'+F+'\n\n<div>\n\nz</div>\n\n| a |\n|---|\n| b |\n\nEnd.\n\n';
let prior=0;
for (let n=0;n<=doc.length;n++){const b=boundary(doc.slice(0,n));assert.ok(b>=prior,'monotonic at '+n);assert.ok(b<=n);prior=b;}
assert.equal(prior,doc.length);
console.log('PASS fence, maths and stable prefix boundaries');

// Reuse complete prefixes without losing list/fence context or hiding corrected snapshots.
const buffer = {};
const bufferedDoc = 'Intro.\n\n- first\n\n- second\n  - nested\n\nAfter.\n\n' + F + 'js\ncode\n' + F + '\n\n<section>Done</section>\n\nEnd.\n\n';
for (let n = 0; n <= bufferedDoc.length; n++) {
  const text = bufferedDoc.slice(0, n);
  assert.equal(boundary(text, buffer), boundary(text), 'cached boundary at ' + n);
}
assert.ok(buffer.prefix?.length > bufferedDoc.length / 2, 'finished prefixes are checkpointed');
for (const text of [bufferedDoc.replace('Intro.', 'Corrected intro.'), 'Shorter.\n\n', '', bufferedDoc]) {
  assert.equal(boundary(text, buffer), boundary(text), 'corrected snapshot: ' + text);
}
console.log('PASS incremental boundaries and corrected snapshots');

assert.equal(boundary('Done.\n\n{@body const games = [\n\n"RDR2"'),7);
const declaration='{@body const games=["$1", "$2"]}\n\n';
assert.equal(boundary(declaration),declaration.length);
const interactive='{@body const [n,setN]=DIL.useState(0)}\n<button onClick={()=>setN(n+1)}>Add</button>';
assert.equal(boundary(interactive),interactive.length,'closed declarations and controls release without blank lines');
const stabilizeCode=ctx.window.QStream.stabilize;
for(const text of ['Use `$$` for display math and more text.','Use `\\(` for inline and more text.','Use `\\[` for display and more text.','Use ``$$`` doubled and more text.'])assert.equal(stabilizeCode(text),text,'delimiters inside inline code are not openers: '+text);
assert.equal(stabilizeCode('Real display $$x^2 still open'),'Real display ','a real display opener is still held');
assert.equal(stabilizeCode('Real inline \\(x still open'),'Real inline ','a real inline opener is still held');
assert.equal(stabilizeCode('Both `$$` code then real $$x open'),'Both `$$` code then real ','code before a real opener does not unbalance the count');
assert.equal(stabilizeCode('Closed $$x$$ then `$$` code.'),'Closed $$x$$ then `$$` code.','closed maths and code together stay visible');
assert.equal(stabilizeCode('Index `arr[0` is first'),'Index `arr[0` is first','an open bracket inside closed code stays');
assert.equal(stabilizeCode('Typing `arr[0'),'Typing `arr[0`','an open bracket inside open code stays');
assert.equal(stabilizeCode('Shown `[a](b` text'),'Shown `[a](b` text','link syntax inside code stays literal');
assert.equal(stabilizeCode('Read [the docs](https://exa'),'Read the docs','a real unfinished link still shows only its label');
assert.equal(stabilizeCode('Read [the doc'),'Read the doc','a real open bracket is still hidden');
assert.equal(stabilizeCode('Read [the docs](https://example.com) now'),'Read [the docs](https://example.com) now','a whole link is untouched');
console.log('PASS inline code literals in stabilize');

// The live view: finished blocks as they are, plus the block being written with its markup closed.
const live=(text)=>ctx.window.QStream.liveView(text,{});
for (const [text,want] of [
 ['First unfinished','First unfinished'],
 ['Done.\n\nSecond **bo','Done.\n\nSecond **bo**'],
 ['Intro *italic* and **bold** then more','Intro *italic* and **bold** then more'],
 ['1. **Second ','1. **Second** '],
 ['Hi <cite>x</cite> and more','Hi <cite>x</cite> and more'],
 ['Press <kbd>Ctrl</kbd> to','Press <kbd>Ctrl</kbd> to'],
 ['Hi <mark>open and','Hi '],
 ['Press <','Press '],
 ['Hi <b','Hi '],
 ['<section>one\n\ntwo',''],
 ['Costs $5 and $10 total','Costs $5 and $10 total'],
 ['Formula $x^2','Formula '],
 ['Formula $x^2$ ok','Formula $x^2$ ok'],
 ['Fact citeturn0','Fact '],
 ['```js\nconst a = 1;\nconst b','```js\nconst a = 1;\nconst b'],
 ['```js',''],
 ['```html\n<div>open\n','```html\n<div>open\n'],
 ['| a | b |\n|---|---|\n| x | y |\n| z','| a | b |\n|---|---|\n| x | y |\n'],
 ['Link [text](http://ex','Link text'],
 ['A [ref][docs].\n\n[docs]: https://exa','A [ref][docs].\n\n'],
 ['Code `<div` here','Code `<div` here'],
 ['$$\nx\n',''],
 ['{#each [1] as x}<mark>{x}</mark>',''],
 ['if a <b we stop','if a <b we stop'],
]) assert.equal(live(text),want,'live view: '+JSON.stringify(text));
console.log('PASS live view of the block being written');

const stops=(text)=>JSON.parse(JSON.stringify(ctx.window.QStream.revealStops(text).map(at=>text.slice(0,at))));
assert.deepEqual(stops('One **bold** word'),['One ','One **bold** ','One **bold** word'],'emphasis markers travel with their word');
assert.deepEqual(stops('Use `code` here'),['Use ','Use `code` ','Use `code` here'],'code markers travel with their word');
const snap=ctx.window.QStream.graphemeEnd;
assert.equal(snap('A👩‍💻\n',5),6,'a position inside a joined emoji moves to its end');
assert.equal(snap('Aé x',2),3,'a combining mark stays with its letter');
assert.equal(snap('Hello',3),3,'a boundary stays put');
assert.equal(snap('Hi',9),2,'past the end clamps');
console.log('PASS marker-aware reveal stops and grapheme snapping');
