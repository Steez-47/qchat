import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({window:{}, URL});
vm.runInContext(readFileSync(new URL('../ui/response-tags.js',import.meta.url),'utf8'), context);
const api=context.window.QResponseTags, md=(s,o)=>api.toMarkdown(s,o);
assert.match(md('<Future-wrap><box><Entity value={"a > b"}/><Link href={\'https://example.com\'}>go</Link></box></Future-wrap>'), /a &gt; b[\s\S]*\[go\]/);
assert.equal(md('<Entity value={globalThis.hacked=true}/>'), '');
assert.equal(context.hacked,undefined);
assert.equal(md('<Future label="Readable" action="opaque"/>'), 'Readable');
assert.equal(md('<caption>Caption</caption>'), '*Caption*');
assert.equal(md('<Link url="javascript:alert(1)" title="safe"/>'),'safe');
assert.equal(md('<script>alert(1)</script><svg><path/></svg>'), '');
assert.equal(md('<Entity value={"name"}/>'), 'name');
assert.equal(md('<Cite refs={["turn1search0:L1-L3","turn2search0"]}/>',{citation:r=>r}),'turn1search0 turn2search0');
for(const code of ['`<Entity value="x"/>`','``a ` <Cite ref="x"/>``','~~~~\n<Entity value="x"/>\n~~~~','````\n```\n<Cite/>','~~~\n<Entity/>']) assert.equal(md(code),code);
assert.equal(md('x < 3 and &lt;tag&gt;'), 'x &lt; 3 and &lt;tag&gt;');
for (const s of ['<Future','<Future a="x>','<Future a={{"x":[1,2]']) assert.equal(md('hello '+s),'hello ');
for(const tag of ['u','mark','sub','sup','table','thead','tbody','tr','td','th','dl','dt','dd','details','summary','figure','figcaption']) assert.equal(md(`<${tag} onclick="bad()">word</${tag}>`).trim(),`<${tag}>word</${tag}>`);
for(const tag of ['b','strong','i','em','s','del','h1','h6','p','div','blockquote','li','ul','ol','pre','code','title','caption','box','row','col','column','stack','grid','grid-item','text','card','section']) assert.match(md(`<${tag}>word</${tag}>`), /word/);
assert.equal(md('<pre><code>&lt;Entity/&gt;</code></pre>'), '\n\n~~~\n<Entity/>\n~~~\n\n');
assert.equal(md('<img src="https://evil.example/image" alt="photo"/>'),'photo');
assert.equal(md('<AsyncImageGroup query={["a","b"]}/>',{image:q=>q}),'a b');
assert.equal(md('<grid-item><AsyncImage query="a"/><caption>Caption</caption></grid-item>',{image:(q,c)=>q+':'+c}),'a:Caption\n');
assert.ok(md('<x>'.repeat(10000)+'end'+'</x>'.repeat(10000)).includes('end'));
assert.equal(api.hasLayout('`<Future/>`'),false);
assert.equal(api.hasLayout('<Future-widget'),true);
assert.doesNotMatch(api.sanitizeHTML('<img src=x onerror=alert(1)><u onclick="alert(2)">oops</u>'), /<(?:img|u\s)/);
assert.equal(api.sanitizeHTML('<mark>safe</mark>'), '<mark>safe</mark>');
const nestedList = md('<ol start="3"><li>First</li><li>Second<ul><li>Nested</li></ul></li></ol>');
assert.match(nestedList, /3\. First\n4\. Second\n\s+\n   - Nested/);
assert.ok(md('<box>Text\n\n    nested code\n    preserve indent\n</box>').includes('    preserve indent'));
assert.ok(md('<pre>one\n\n\nthree</pre>').includes('one\n\n\nthree'));
assert.ok(md('<box>Words</box>\n\n`<Entity value="literal"/>`').includes('`<Entity value="literal"/>`'));
assert.equal(md('\uE1000\uE101 `code`'), '\uE1000\uE101 `code`');
assert.equal(md('<Future label="<img src=x onerror=alert(1)>"/>'), '&lt;img src=x onerror=alert(1)&gt;');
assert.equal(md('<Badge value={42}/>'), '42');
assert.doesNotMatch(md('<box>\n    <title>Stat</title>\n</box>'), /^ {4}\S/m);
assert.equal(md('Text\uE200unknown\uE202opaque\uE201\uE203\uE204'), 'Text');
assert.equal(md('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
assert.equal(md('<Entity value="A &amp; B"/>'), 'A &amp; B');
assert.equal(md('<Future label="&lt;img&gt;"/>'), '&lt;img&gt;');
assert.equal(md('<Link href=https://example.com/path title=Read/>'), '[Read](https://example.com/path)');
assert.equal(md('<b>Hello</b> <i>world</i>'), '**Hello** *world*');
assert.equal(md('<Entity value="John"/> <Entity value="Doe"/>'), 'John Doe');
assert.equal(md('<code>a</code> <code>b</code>'), '\` a \` \` b \`');
for (const math of ['$x < y$','$$a < b$$','\\(x < y\\)','\\[a <b\\]','$a <b$']) {
  assert.equal(md(math),math);
  assert.equal(md(md(math)),math);
  assert.equal(api.hasLayout(math),false);
}
for (const source of ['<code>a \` b</code><p>after</p>','<pre>a \` b</pre><p>after</p>','<code>\`b\`</code>','<pre>\n~~~\nx\n~~~\n</pre>','<blockquote><pre><Entity value="x"/></pre></blockquote>','<ol><li><pre><Cite ref="literal"/></pre></li></ol>']) {
  const first=md(source);
  assert.equal(md(first),first);
  if(source.includes('after')) assert.ok(first.includes('after'));
  assert.ok(!first.includes('</pre>') && !first.includes('</code>'));
}
assert.equal(md('<code/>hello <Entity value="x"/>'), 'hello x');
assert.equal(md('An Array<object> is common in JS, followed by important text.'),'An Array&lt;object&gt; is common in JS, followed by important text.');
for(const prose of ['Suppose a <b and c = 1 in this proof.',"Suppose a <b and it's > 0 in this proof."]) assert.equal(md(prose),prose.replace('<','&lt;'));
for(const prose of ['Hello <C','Hello <Ci','Hello <Cit','Visit <https','Visit <mailto','If a \\<b in math']) assert.equal(api.hasLayout(prose),false);
assert.equal(md('<Future>\n    Plain text\n</Future>').trim(),'Plain text');
const sales = `{#each [{period:"First 24 hours",copies:"25M",revenue:"$2.2B"},{period:'First 3 days',copies:'30M',revenue:'$2.6B'},{period:'First week',copies:'40M',revenue:'$3.5B'}] as item, index}<box><text>{item.period}</text><strong>{item.copies}</strong><text>{item.revenue}</text><text>{index}</text></box>`;
const salesOutput = md(sales);
for (const value of ['First 24 hours','First 3 days','First week','25M','30M','40M','2.2B','2.6B','3.5B']) assert.ok(salesOutput.includes(value),value);
assert.doesNotMatch(salesOutput,/\{[#/]|item\.|<box>/);
for (const close of ['{','{/','{/e','{/ea','{/eac','{/each','{/each}']) assert.equal(md(sales + close),salesOutput,close);
for (const prefix of ['{#','{#e','{#ea','{#eac','{#each','{#each [','{#each [{period:"First','{#each [] as']) {
  assert.equal(md('Before '+prefix),'Before ');
  assert.equal(api.hasLayout(prefix),true);
}
const nestedEach = `{#each [{name:'A',rows:[{n:1},{n:2}]},{name:'B',rows:[{n:3}]}] as group}{group.name}:{#each group.rows as item, i}{i}={item.n};{/each}|{/each}`;
assert.equal(md(nestedEach),'A:0=1;1=2;|B:0=3;|');
assert.equal(md(`{#each [true,false,null,12,-2.5, {name:'line\\nquote\\\'\\u0041'}] as item}{item};{/each}`), 'true;false;;12;-2.5;;');
assert.equal(md(`{#each [{a:'one'},{a:'two'},] as item}{item.a}{/each}`),'onetwo');
for (const data of ['globalThis.hacked=true','[globalThis.hacked=true]','[(()=>{globalThis.hacked=true})()]','[1].map(alert)','[{__proto__:{x:1}}]','[{constructor:1}]','[{prototype:1}]','[NaN]','[Infinity]','[1e999]','[undefined]','[{x:}]']) {
  assert.equal(md(`Before{#each ${data} as item}hidden{item}{/each}After`),'BeforeAfter',data);
}
for (const expression of ['item.constructor','item.__proto__','item.a.constructor','item.toString()','globalThis.hacked=true','item.a + "bad"','item["a"]']) {
  assert.equal(md(`{#each [{a:'safe'}] as item}{${expression}}{/each}`),'',expression);
}
assert.equal(context.hacked,undefined);
for (const wrapper of [s=>'`'+s+'`',s=>'~~~\n'+s+'\n~~~',s=>'$$'+s+'$$',s=>'\\('+s+'\\)']) {
  const example=wrapper('{#each [1] as item}{item}{/each}');
  assert.equal(md(example),example);
  assert.equal(api.hasLayout(example),false);
}
assert.equal(md('{#each [1] as item}`{item}`<code>{item}</code>{/each}'),'`{item}`` {item} `');
assert.equal(md('\\{#each [1] as item}literal\\{/each}'),'\\{#each [1] as item}literal\\{/each}');
assert.equal(api.hasLayout('\\{#each [1] as item}'),false);
const xss = md(`{#each [{x:'<img src=x onerror=alert(1)>',y:'[click](javascript:alert(1))',z:'{#each [1] as item}bad{/each}'}] as item}{item.x} {item.y} {item.z}{/each}`);
assert.ok(xss.includes('&lt;img'));
assert.doesNotMatch(xss,/<img|\[click\]\(javascript/);
assert.ok(xss.includes('\\{#each') || xss.includes('\\{\\#each'));
assert.equal(md(`{#each [{x:'" onmouseover="alert(1)'}] as item}<Future label="{item.x}"/>{/each}`),'&quot; onmouseover=&quot;alert\\(1\\)');
assert.equal(md(`{#each [{name:'Hello world'}] as item}<Entity value={item.name}/><Entity value={"literal text"}/>{/each}`),'Hello worldliteral text');
assert.equal(md(`{#each [{name:'<img src=x onerror=alert(1)>'}] as item}<Entity value={item.name}/>{/each}`),'&lt;img src=x onerror=alert(1)&gt;');
assert.equal(md('x'.repeat(1000001)).length,1000001);
const many = `[${Array(1001).fill('1').join(',')}]`;
assert.equal(md(`{#each ${many} as item}x{/each}`).length,1000);
assert.ok(md(`{#each ${many} as item}${'x'.repeat(2000)}{/each}`).length <= 1000000);
assert.equal(api.eachAt('{#each [{a:"}"}] as row}',0).end,'{#each [{a:"}"}] as row}'.length);
assert.equal(api.eachAt('{/each}',0).close,true);
for (const closer of ['<','</','</m','</mark>']) assert.equal(md('<mark>Live'+closer),'<mark>Live</mark>');
console.log('ALL PASS response tags');

assert.equal(api.hasInteractive('{@body const a=1}'),true);
assert.equal(api.hasInteractive('{@bo'),true);
assert.equal(api.hasInteractive('<button onClick={()=>setN(1)}>Add</button>'),true);
assert.equal(api.hasInteractive('`{@body const a=1}`'),false);
assert.equal(api.hasInteractive('```js\n{@body const a=1}\n```'),false);
assert.equal(api.hasInteractive('\\{@body const a=1}'),false);
