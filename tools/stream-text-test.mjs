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
 ['<section><div>one\n\ntwo</div></section>\n\n',40],
 ['`<div>` and 2 < 3\n\n',19],
 ['<div title="a\n\n>b">x\n\n',0],
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
for (const tail of ['```js\nx\n','<box>one\n\ntwo\n','$$\nx\n\ny\n']) {
 assert.equal(boundary('Done.\n\n'+tail),7,JSON.stringify(tail));
}
for (const text of ['- a\n\n- b','1. one\n\n2. two','Alpha<b>bold\n\nstill']) assert.equal(boundary(text),0,JSON.stringify(text));
console.log('PASS completed block boundaries');
