// Edge cases and seeded fuzzing for the pure text code: Find, the streaming boundary, reply tags,
// highlighting and maths. Plain Node. Replay a failure with QCHAT_FUZZ_SEED; soak with QCHAT_FUZZ_RUNS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadUI, plain, random, root, runs, suite, within } from './lib/check.mjs';
import path from 'node:path';

const { test, finish } = suite();
// Maths loads KaTeX on demand; nothing is rendered here, so the request goes nowhere.
const document = { createElement: () => ({ addEventListener() {}, setAttribute() {} }), head: { append() {}, appendChild() {} } };
const { window } = loadUI(['find-text.js', 'response-tags.js', 'stream-text.js', 'math.js'], { document });
const { QFindText, QResponseTags: tags, QStream, QMath } = window;
const QH = createRequire(import.meta.url)(path.join(root, 'ui/highlight.js'));

const indices = (text, query) => plain(QFindText.indices(text, query));

// --- Find ------------------------------------------------------------------------------------
test('Find treats every regex character literally', () => {
  for (const symbol of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/', '-', '(?<x>', '\\d', '[a-z]', '$&', '\\u0041']) {
    assert.deepEqual(indices(`a${symbol}b`, symbol), [{ start: 1, end: 1 + symbol.length }], symbol);
    assert.deepEqual(indices('plain words only', symbol), [], symbol);
  }
});

test('Find survives awkward Unicode', () => {
  assert.deepEqual(indices('👩‍💻 dev', '👩‍💻'), [{ start: 0, end: 5 }]);
  assert.deepEqual(indices('\ud83d alone', '\ud83d'), [{ start: 0, end: 1 }], 'lone surrogate');
  assert.deepEqual(indices('😀', '\ud83d'), [], 'half a pair never matches inside an emoji');
  assert.deepEqual(indices('مرحبا بالعالم', 'بالعالم'), [{ start: 6, end: 13 }], 'right to left');
  assert.deepEqual(indices('ÉCOLE école', 'école'), [{ start: 0, end: 5 }, { start: 6, end: 11 }], 'case folding');
  assert.deepEqual(indices('a\u200Bb', 'ab'), [], 'zero width characters are not stripped');
  assert.deepEqual(indices('\uE100\uE000', '\uE000'), [{ start: 1, end: 2 }], 'private use');
});

test('Find handles non-string-like and empty queries calmly', () => {
  for (const empty of ['', null, undefined]) assert.deepEqual(indices('text', empty), []);
  assert.deepEqual(indices('', 'x'), []);
});

test('Find agrees with a plain scan on random text', () => {
  const r = random();
  for (let i = 0; i < runs(3000); i++) {
    const text = r.text(['a', 'b', 'A', ' ', '.', '\n', 'é', '😀', '*'], 60);
    const query = r.text(['a', 'b', '.', '*', '😀'], 3);
    if (!query) continue;
    const found = indices(text, query);
    // Non-overlapping, ordered, in bounds, and each span really is the query.
    let cursor = 0;
    for (const { start, end } of found) {
      assert.ok(start >= cursor && end <= text.length && end > start, JSON.stringify({ text, query, found }));
      assert.equal(text.slice(start, end).toLowerCase(), query.toLowerCase());
      cursor = end;
    }
    // The same count as a left-to-right, case-insensitive scan by code point.
    const hay = text.toLowerCase(), needle = query.toLowerCase();
    let expected = 0;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) expected++;
    assert.equal(found.length, expected, JSON.stringify({ text, query, found }));
  }
});

test('Find stays quick on a huge history', () => {
  const text = 'needle and hay '.repeat(40000);
  assert.equal(within(1500, () => QFindText.indices(text, 'needle')).length, 40000);
  within(1500, () => QFindText.indices('a'.repeat(600000), 'aaaa'));
});

// --- Streaming boundary ----------------------------------------------------------------------
const boundary = QStream.completeBoundary;
const STREAM_DOCS = [
  'First paragraph.\n\nSecond paragraph.\n\nThird.',
  'Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.\n\n',
  '~~~\n```\nnot closed by backticks\n~~~\n\nNext.\n\n',
  '````md\n```\ninner\n```\n````\n\nDone.\n\n',
  'Math:\n\n$$\nx^2\n\ny^2\n$$\n\nThen \\[a\\] and \\(b\\).\n\n',
  '- one\n- two\n\n  still two\n\n- three\n\nAfter the list.\n\n',
  '> quote\n>\n> more quote\n\nNot quoted.\n\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table.\n\n',
  '<section><div>one\n\ntwo</div></section>\n\nAfter.\n\n',
  '<Future-widget value={"x > y"}>\n\nbody\n\n</Future-widget>\n\nEnd.\n\n',
  'Costs $5 and $10.\n\nThen $x^2$ inline.\n\n',
  'Crlf one.\r\n\r\nCrlf two.\r\n\r\nCrlf three.\r\n\r\n',
  '😀 emoji para.\n\n👩‍💻 another.\n\nمرحبا بالعالم.\n\n',
  '{#each items as item}\n\n{item}\n\n{/each}\n\nEnd.\n\n',
  'Unclosed `code\n\nnext para\n\n',
  '1. item\n\n   ```py\n   x = 1\n\n   y = 2\n   ```\n\n2. item\n\nDone.\n\n',
  'Array<object> and a < b > c.\n\n<notatag\n\nEnd.\n\n',
  '\n\n\n\nLeading blanks.\n\n',
  ''
];

test('the released text never shrinks as a reply streams in, one character at a time', () => {
  for (const doc of STREAM_DOCS) {
    let previous = 0;
    for (let i = 0; i <= doc.length; i++) {
      const text = doc.slice(0, i), end = boundary(text);
      assert.ok(Number.isInteger(end) && end >= 0 && end <= text.length, JSON.stringify({ doc, i, end }));
      assert.ok(end >= previous, `shrank from ${previous} to ${end} at ${i} in ${JSON.stringify(doc)}`);
      previous = end;
    }
  }
});

test('the released text never cuts a fence, display maths block or emoji in half', () => {
  for (const doc of STREAM_DOCS) {
    for (let i = 0; i <= doc.length; i++) {
      const released = doc.slice(0, boundary(doc.slice(0, i)));
      const code = released.charCodeAt(released.length - 1);
      assert.ok(!(code >= 0xd800 && code <= 0xdbff), `split surrogate in ${JSON.stringify(released)}`);
      assert.equal((released.match(/^\$\$\s*$/gm) || []).length % 2, 0, `open maths in ${JSON.stringify(released)}`);
      const fences = [...released.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)];
      if (doc === STREAM_DOCS[1]) assert.equal(fences.length % 2, 0, `open fence in ${JSON.stringify(released)}`);
    }
  }
});

test('the boundary is the same whatever the chunking, and never throws on junk', () => {
  const r = random(7);
  const parts = ['word ', '\n', '\n\n', '```', '~~~', '$$', '$', '`', '\\', '<', '>', '</', '<div>', '</div>', '<b', '{', '}', '{#each x}', '{/each}', '{@body', '|', '- ', '> ', '1. ', '\r\n', '😀', '\ud83d', '\t', '    ', '<!--', '-->', '\\[', '\\]', '\\(', '"', "'"];
  for (let i = 0; i < runs(1500); i++) {
    const text = r.text(parts, 40);
    const end = boundary(text);
    assert.ok(end >= 0 && end <= text.length, JSON.stringify(text));
    assert.equal(boundary(text), end, 'a pure function of its input');
  }
});

test('a missed currency scan never hides a formula earlier on the line', () => {
  const text = '$x$ then $5 and $6';
  assert.equal(tags.mathEnd(text, 9), 9, 'no closer after the first price');
  assert.equal(tags.mathEnd(text, 0), 3, 'the formula before it is still found');
  assert.equal(tags.mathEnd(text, 9), 9);
  assert.equal(tags.mathEnd('$y$', 0), 3, 'a different text starts afresh');
});

test('the released text never shrinks on random streams', () => {
  const r = random(11);
  const parts = ['word ', 'more words. ', '\n', '\n\n', '```\n', '$$\n', '`', '<div>', '</div>', '- item\n', '> quote\n', '| a |\n'];
  for (let i = 0; i < runs(300); i++) {
    const doc = r.text(parts, 25);
    let previous = 0;
    for (let at = 0; at <= doc.length; at += 1 + r.int(4)) {
      const end = boundary(doc.slice(0, at));
      assert.ok(end >= previous, `shrank from ${previous} to ${end} at ${at} in ${JSON.stringify(doc)}`);
      previous = end;
    }
  }
});

test('the boundary stays quick on hostile replies', () => {
  for (const [name, text] of Object.entries({
    'one long line': 'x'.repeat(400000),
    'base64 run': 'QUJD'.repeat(100000),
    'many paragraphs': 'Para.\n\n'.repeat(30000),
    'unclosed tags': '<div>'.repeat(5000),
    'less-than signs': '< '.repeat(50000),
    'backticks': '` '.repeat(50000),
    'dollars': '$a '.repeat(20000),
    'dollars across lines': '$a b\n'.repeat(20000),
    'inline maths openers': '\\(a '.repeat(20000),
    'display maths openers': '\\[a '.repeat(20000),
    'double dollars': '$$a '.repeat(20001),
    'braces': '{ '.repeat(20000)
  })) within(5000, () => boundary(text), name);
});

test('reveal stops always land between graphemes, in order', () => {
  for (const text of ['👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻', 'e\u0301'.repeat(40), 'https://example.com/' + 'a'.repeat(100), 'one two, three. four', '', '   ']) {
    const stops = plain(QStream.revealStops(text));
    let previous = 0;
    for (const stop of stops) {
      assert.ok(stop > previous && stop <= text.length, JSON.stringify({ text, stops }));
      const before = text.charCodeAt(stop - 1);
      assert.ok(!(before >= 0xd800 && before <= 0xdbff), 'split a surrogate pair');
      assert.ok(text[stop] !== '\u0301', 'split a combining mark');
      assert.ok(text[stop] !== '\u200D' && text[stop - 1] !== '\u200D', 'split a joined emoji');
      previous = stop;
    }
    if (text) assert.equal(stops.at(-1), text.length, 'the last stop reaches the end');
  }
});

// --- Reply tags ------------------------------------------------------------------------------
test('safeURL only lets web and mail links through', () => {
  for (const good of ['https://example.com/', 'http://example.com/a?b=c#d', 'mailto:a@example.com', 'HTTPS://EXAMPLE.COM/']) assert.ok(tags.safeURL(good), good);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///c:/windows/system32', 'blob:http://x/1', 'about:blank', 'ms-settings:', 'tauri://localhost', 'ipc://x', '/relative', '//example.com', 'example.com', '', null, undefined, {}, []]) {
    assert.equal(tags.safeURL(bad), '', String(bad));
  }
});

test('entities decode without ever producing a broken character', () => {
  const decode = tags.decodeEntities;
  assert.equal(decode('&lt;&GT;&amp;&quot;&apos;'), `<>&"'`);
  assert.equal(decode('&#65;&#x41;&#X41;'), 'AAA');
  assert.equal(decode('&#x1F600;'), '😀');
  for (const kept of ['&#0;', '&#xD800;', '&#xDFFF;', '&#x110000;', '&#99999999999;', '&nosuch;', '&', '&;', '&#;', '&#x;', '&amp']) assert.equal(decode(kept), kept);
  assert.equal(decode('&amp;lt;'), '&lt;', 'decodes once only');
  assert.equal(decode(null), '');
  assert.equal(decode(undefined), '');
  assert.equal(decode(5), '5');
});

// What an output may never contain as live markup. Escaped text such as &lt;img onerror&gt; is safe.
const liveProblems = (out) => {
  const found = [];
  for (const [tag, name, attrs] of out.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>?/g)) {
    if (/^(script|iframe|object|embed|svg|style|link|meta|base|form|math|input|img)$/i.test(name)) found.push(tag);
    if (/\bon\w+\s*=|javascript:|srcdoc|style\s*=/i.test(attrs)) found.push(tag);
  }
  if (/\]\(\s*(?:javascript|data|vbscript):/i.test(out)) found.push('markdown link');
  return found;
};
const ATTACKS = [
  '<script>alert(1)</script>', '<SCRIPT SRC=x></SCRIPT>', '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x onerror=alert(1)>', '<IMG SRC=x OnErRoR=alert(1)>', '<img/src=x/onerror=alert(1)>', '<img src="x" onerror="alert(1)"',
  '<svg onload=alert(1)>', '<svg><script>alert(1)</script></svg>', '<math><mtext></mtext><script>alert(1)</script></math>',
  '<iframe src="javascript:alert(1)"></iframe>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<a href="javascript:alert(1)">x</a>', '<a href="JaVaScRiPt:alert(1)">x</a>', '<a href="java&#10;script:alert(1)">x</a>', '<a href=" javascript:alert(1)">x</a>',
  '<Link href="javascript:alert(1)">x</Link>', '<Link url={"javascript:alert(1)"}>x</Link>', '<AsyncImage src="javascript:alert(1)"/>',
  '<div onclick="alert(1)">x</div>', '<u onmouseover=alert(1)>x</u>', '<b style="background:url(javascript:alert(1))">x</b>',
  '<form action="javascript:alert(1)"><button>x</button></form>', '<input autofocus onfocus=alert(1)>', '<details open ontoggle=alert(1)>',
  '<object data="javascript:alert(1)"></object>', '<embed src="javascript:alert(1)">', '<link rel=stylesheet href=x>', '<meta http-equiv=refresh content="0;url=javascript:alert(1)">', '<base href="//evil.example/">', '<style>*{background:red}</style>',
  '<Entity value={globalThis.pwned=1}/>', '<Cite ref={constructor.constructor("alert(1)")()}/>', '<Future a={(()=>{throw 1})()}/>'
];

test('reply tags never let an attack through', () => {
  for (const attack of ATTACKS) {
    for (const text of [attack, `Before ${attack} after`, `<div>${attack}</div>`, `<section><box>${attack}</box></section>`]) {
      const out = tags.toMarkdown(text);
      assert.deepEqual(liveProblems(out), [], `${text} => ${out}`);
    }
    assert.doesNotMatch(tags.sanitizeHTML(attack), /<(?!\/?(?:b|i|u|em|strong|s|del|mark|sub|sup|kbd|p|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|dl|dt|dd|details|summary|figure|figcaption|div|span|blockquote|pre|code)\s*>)/i, attack);
  }
  assert.equal(window.pwned, undefined);
  assert.equal(globalThis.pwned, undefined);
});

test('tag parsing is safe against prototype tricks', () => {
  for (const text of ['<x __proto__="polluted" constructor="y"/>', '<Future __proto__={{"polluted":true}}/>']) {
    tags.toMarkdown(text);
    tags.hasLayout(text);
    tags.hasInteractive(text);
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(tags.tagAt('<x a="1"/>', 0).attrs), null);
});

test('reply tags leave code and ordinary prose alone', () => {
  for (const same of ['plain', 'x < 3', '`<script>`', '```\n<script>alert(1)</script>\n```', '~~~html\n<div onclick="x()">\n~~~', 'a > b', '1 < 2 > 0', 'Use `<div>` here', '']) {
    const out = tags.toMarkdown(same);
    assert.equal(out.replaceAll('&lt;', '<').replaceAll('&gt;', '>'), same, same);
  }
  assert.equal(tags.toMarkdown(null), '');
  assert.equal(tags.toMarkdown(undefined), '');
});

test('reply tags never throw on junk, and terminate quickly', () => {
  const r = random(3);
  const parts = ['<', '>', '/', '</', '/>', '<div', '<b>', '</b>', '<Future', '<Link href="', '"', "'", '{', '}', '={', '{#each', '{/each}', '{@body', '=', ' ', 'a', '\n', '```', '~~~', '`', '$', '\\', '&', '&#', ';', '😀', '\ud83d', '\u0000', '\uE100q0:', '<!--', '-->'];
  for (let i = 0; i < runs(2500); i++) {
    const text = r.text(parts, 40);
    assert.equal(typeof tags.toMarkdown(text), 'string', JSON.stringify(text));
    tags.hasLayout(text);
    tags.hasInteractive(text);
    tags.sanitizeHTML(text);
    for (let at = 0; at < Math.min(text.length, 6); at++) {
      tags.tagAt(text, at);
      tags.eachAt(text, at);
      tags.bodyAt(text, at);
      const end = tags.mathEnd(text, at);
      assert.ok(end >= at && end <= text.length, JSON.stringify({ text, at, end }));
    }
  }
});

test('protect restores exactly what it shielded, even with its own marker in the text', () => {
  for (const text of ['```\ncode\n```', '`a` and `b`', 'prose only', '\uE100q0:already here `x`', '<pre>x</pre>', '']) {
    assert.equal(tags.protect(text, (s) => s), text, JSON.stringify(text));
  }
  assert.equal(tags.protect('a `a` a', (s) => s.replaceAll('a', 'X')), 'X `a` X');
});

// Each of these used to hang the app: a line prefix regex could split its spaces two ways per level.
const NESTED = {
  quotes: `${'> '.repeat(200)}x`, 'tight quotes': `${'>'.repeat(5000)}x`, 'tab quotes': `${'>\t'.repeat(200)}x`, 'spaced quotes': `${'>   '.repeat(200)}x`,
  bullets: `${'- '.repeat(200)}x`, 'wide bullets': `${'-  '.repeat(200)}x`, numbers: `${'1.  '.repeat(200)}x`, 'mixed markers': `${'> -  1.  '.repeat(100)}x`,
  'spaces only': `${' '.repeat(5000)}x`, 'quotes inside a fence': `\`\`\`\n${`${'> '.repeat(200)}x\n`.repeat(3)}`, 'nested lists': Array.from({ length: 200 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n')
};

test('deeply nested line markers never hang any text function', () => {
  for (const [name, text] of Object.entries(NESTED)) {
    within(1000, () => tags.toMarkdown(text), `toMarkdown ${name}`);
    within(1000, () => tags.hasLayout(text), `hasLayout ${name}`);
    within(1000, () => tags.hasInteractive(text), `hasInteractive ${name}`);
    within(1000, () => boundary(text), `boundary ${name}`);
    within(1000, () => QMath.prepare(text), `maths ${name}`);
  }
});

test('fences inside quotes and lists are still shielded', () => {
  for (const fence of ['> ```\n> <Entity value="x"/>\n> ```', '>```\n><Entity value="x"/>\n>```', '> > ```\n> > <Entity value="x"/>\n> > ```', '- ```\n  <Entity value="x"/>\n  ```', '-   ```\n    <Entity value="x"/>\n    ```', '1. ```\n   <Entity value="x"/>\n   ```', '1.  > ~~~\n    > <Entity value="x"/>\n    > ~~~', '\t```\n<Entity value="x"/>\n```']) {
    assert.equal(tags.toMarkdown(fence), fence, fence);
  }
});

test('reply tags stay quick on hostile input', () => {
  for (const [name, text] of Object.entries({
    nested: '<x>'.repeat(20000),
    unclosed: '<div '.repeat(10000),
    quotes: '<a b="'.repeat(10000),
    braces: '<a b={'.repeat(10000),
    backticks: '`'.repeat(100000),
    dollars: '$'.repeat(100000),
    ampersands: '&#'.repeat(50000),
    each: '{#each x}'.repeat(5000),
    'dollar words': '$a '.repeat(30000)
  })) within(8000, () => tags.toMarkdown(text), name);
});

// --- Maths -----------------------------------------------------------------------------------
test('money stays prose and real formulas become placeholders', () => {
  const formulas = (text) => QMath.prepare(text).formulas.length;
  for (const prose of ['$5 and $10', 'It costs $5.', '$1,000 or $2,000', '$5k and $10k', 'US$5 and C$6', 'a $ b $ c', '\\$5 and \\$6 escaped']) {
    assert.equal(formulas(prose), 0, prose);
  }
  for (const maths of ['$x^2$', '$$x$$', '\\(x\\)', '\\[x\\]', 'then $a+b$ ok']) {
    assert.equal(formulas(maths), 1, maths);
  }
});

test('formulas cannot inject markup through their accessible label', () => {
  const html = (text) => QMath.prepare(text).formulas[0].html;
  assert.doesNotMatch(html('$"><img src=x onerror=alert(1)>$'), /<img/);
  assert.doesNotMatch(html(`$a" onmouseover="alert(1)$`), /aria-label="[^"]*" onmouseover=/);
});

test('code keeps its dollars, and junk never throws', () => {
  for (const code of ['`$x$`', '```\n$x$\n```', '~~~\n$$x$$\n~~~']) assert.equal(QMath.prepare(code).formulas.length, 0, code);
  const r = random(5);
  for (let i = 0; i < runs(1500); i++) QMath.prepare(r.text(['$', '$$', '\\(', '\\)', '\\[', '\\]', '\\', '`', '```', '\n', 'x', ' ', '5', '\uE000', '\uE001'], 30));
  within(4000, () => QMath.prepare('$a '.repeat(30000)), 'many dollars');
  within(4000, () => QMath.prepare('\\'.repeat(200000)), 'many backslashes');
  within(4000, () => QMath.prepare('\\(a '.repeat(30000)), 'many inline openers');
  within(4000, () => QMath.prepare('\\[a '.repeat(30000)), 'many display openers');
  within(4000, () => QMath.prepare('$$a '.repeat(30001)), 'many display dollars');
  within(4000, () => QMath.prepare('`a '.repeat(30001)), 'many backticks');
});

// --- Highlighting ----------------------------------------------------------------------------
const LANGUAGES = ['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'python', 'py', 'rust', 'rs', 'go', 'java', 'c', 'cpp', 'csharp', 'html', 'xml', 'css', 'json', 'bash', 'sh', 'shell', 'powershell', 'sql', 'yaml', 'toml', 'markdown', 'diff', 'php', 'ruby', 'kotlin', 'swift', 'nosuchlanguage', '', null, undefined, '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'JS', ' js ', '<script>'];
const joined = (code, lang) => QH.tokenize(code, lang).map((t) => t.s).join('');

test('highlighting returns the code exactly, in every language, on awkward code', () => {
  const samples = ['', ' ', '\n', '\r\n', '\t', '"unterminated', "'x", '`${a`', '/* open', '<!-- open', '#', '//', '\\', '\\\\', '😀', '\ud83d', 'a\u0000b', 'r#"raw"#', '"""py', '{{{{', '))))', '<<<EOF', '0x', '1e', '1_000', '.5', '@', '$$', '<a b="', '</', '=>', 'é = "ñ"', 'let 名前 = 1', '\n\n\n', ' \n \n '];
  for (const lang of LANGUAGES) for (const code of samples) assert.equal(joined(code, lang), code, JSON.stringify({ lang, code }));
});

test('highlighting round-trips random code', () => {
  const r = random(9);
  const parts = ['"', "'", '`', '/*', '*/', '//', '#', '<', '>', '</', '<!--', '-->', '\\', '\n', '\r\n', ' ', 'if', 'function', 'class', 'x', '1', '0x1f', '{', '}', '(', ')', '$', '${', '@', '=', 'é', '😀', '"""', "'''", 'r#"', '<<', '\t'];
  for (let i = 0; i < runs(2000); i++) {
    const code = r.text(parts, 40), lang = r.pick(LANGUAGES);
    assert.equal(joined(code, lang), code, JSON.stringify({ code, lang }));
  }
});

test('highlighting stays quick on hostile code', () => {
  for (const [name, code] of Object.entries({
    'one long line': 'x'.repeat(300000),
    quotes: '"'.repeat(100000),
    'open comments': '/*'.repeat(50000),
    backslashes: '\\'.repeat(100000),
    angles: '<'.repeat(100000),
    newlines: '\n'.repeat(200000)
  })) for (const lang of ['js', 'python', 'html', 'bash', 'nosuchlanguage']) within(6000, () => QH.tokenize(code, lang), `${name} (${lang})`);
});

await finish();
