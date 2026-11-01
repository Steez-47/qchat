// QHighlight test: round-trip integrity, token typing, performance bound.
// Plain Node script (no browser). Prints PASS/FAIL lines, ends with ALL PASS.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const QH = require(resolve(import.meta.dirname, "..", "ui", "highlight.js"));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err && err.stack || err}`);
  }
}

const TYPES = new Set(["keyword", "string", "comment", "number", "function", "type", "tag", "attr", "meta"]);

/** Every token slice concatenates to exactly `code`, types stay in-budget, no empty slices. */
function assertRoundTrip(code, lang) {
  const toks = QH.tokenize(code, lang);
  assert.ok(Array.isArray(toks), "tokenize must return an array");
  let out = "";
  for (const tok of toks) {
    assert.ok(typeof tok.s === "string" && tok.s.length > 0, "empty token slice");
    assert.ok(tok.t === null || TYPES.has(tok.t), `bad token type ${tok.t}`);
    out += tok.s;
  }
  assert.equal(out, code, "token slices must reproduce the input exactly");
}

const ALL_LANGS = [
  "js", "javascript", "jsx", "mjs", "ts", "typescript", "tsx", "py", "python",
  "rust", "rs", "go", "c", "cpp", "c++", "csharp", "cs", "c#", "java", "json",
  "html", "xml", "svg", "css", "scss", "bash", "sh", "shell", "zsh",
  "powershell", "ps1", "sql", "yaml", "yml", "md", "markdown", "diff"
];

const SAMPLES = {
  js: "const greeting = \"hello\";\nfunction greet(name) { return `${greeting}, ${name}!?`; }\n// done\nlet n = 42;\n",
  ts: "interface User { id: number; name: string; }\nconst u: User = { id: 1, name: \"x\" };\n",
  py: "def greet(name):\n    \"\"\"Doc.\"\"\"\n    return f\"hi {name}\"  # ok\nclass Foo(Bar):\n    pass\n",
  rust: "fn main() {\n    let s: &str = \"hi\";\n    let v: Vec<i32> = vec![1];\n}\n",
  go: "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"hi\") }\n",
  c: "#include <stdio.h>\nint main(void) { /* hi */ printf(\"hi\"); return 0; }\n",
  cpp: "#include <vector>\nstd::vector<int> v{1, 2};\n",
  csharp: "using System;\nclass Program { static void Main() { Console.WriteLine(\"hi\"); } }\n",
  java: "public class Main { public static void main(String[] args) { System.out.println(\"hi\"); } }\n",
  json: "{\"a\": 1, \"b\": [true, false, null], \"c\": \"s\"}\n",
  html: "<!DOCTYPE html>\n<!-- note -->\n<div id=\"root\" class=\"app\" data-x=5>text &amp; more</div>\n<script>var a = 1;</script>\n",
  css: "@media (max-width: 600px) {\n  .app { color: #fff; background: url(x.png); font: 12px/1.5 sans-serif; }\n}\n/* c */\n",
  bash: "#!/usr/bin/env bash\n# comment\nfor f in *.txt; do echo \"$f\"; done\n",
  powershell: "function Get-Stuff { <# note #> $x = \"hi\" }\n",
  sql: "SELECT id, name FROM users WHERE age > 21 -- note\nINSERT INTO t VALUES (1);\n",
  yaml: "# top\n---\nname: QChat\nlist:\n  - a\n  - \"b\"\ncount: 42\nok: true\n",
  md: "# Title\n\nSome `code` and text.\n\n## Section\n",
  diff: "@@ -1,3 +1,4 @@\n old line\n+new line\n-removed\n context\n"
};

const HOSTILE = [
  "",
  "\n\n\n",
  "s = \"unterminated",
  "/* unterminated block comment",
  "<!-- unterminated html comment",
  "`unterminated template",
  "'unterminated sql string",
  "<div class=\"unterminated attr",
  "# unterminated bash comment",
  '"unterminated python triple """',
  "\uD83D\uDE00\uD83C\uDF89\uD83D\uDE80 mixed emoji \u2026 \u00e9\u00e8",
  "x".repeat(200000),
  "\t x \r\n y \r\n",
  "if/*c*/else/*",
  "a &#39;'\" quoted \0 nullish",
  "@decorator\ndef f(): pass\n",
  "|", ">", "<", "&", "\u0000", "\uD83D\uDE0A"
];

test("exports shape", () => {
  assert.equal(typeof QH.tokenize, "function");
  assert.equal(typeof QH.highlightInto, "function");
  assert.equal(typeof QH.languages, "object");
  assert.equal(QH.languages.jsx, "js");
  assert.equal(QH.languages["c#"], "csharp");
});

test("round-trip: realistic sample for every language and alias", () => {
  for (const lang of ALL_LANGS) {
    const canonical = QH.languages[lang];
    assert.ok(canonical, `missing alias ${lang}`);
    assertRoundTrip(SAMPLES[canonical], lang);
  }
});

test("round-trip: hostile inputs for every language", () => {
  for (const lang of ALL_LANGS) {
    for (const code of HOSTILE) assertRoundTrip(code, lang);
  }
});

test("round-trip: hostile inputs without a language", () => {
  for (const code of HOSTILE) assertRoundTrip(code, "brainfuck");
});

test("unknown language -> single plain token", () => {
  const toks = QH.tokenize("hello world", "brainfuck");
  assert.deepEqual(toks, [{ t: null, s: "hello world" }]);
  assert.deepEqual(QH.tokenize("x", ""), [{ t: null, s: "x" }]);
  assert.deepEqual(QH.tokenize("x"), [{ t: null, s: "x" }]);
});

test("js token types", () => {
  assert.deepEqual(QH.tokenize("const", "js"), [{ t: "keyword", s: "const" }]);
  assert.deepEqual(QH.tokenize("\"x\"", "js"), [{ t: "string", s: "\"x\"" }]);
  assert.deepEqual(QH.tokenize("// c", "js"), [{ t: "comment", s: "// c" }]);
  assert.deepEqual(QH.tokenize("42", "js"), [{ t: "number", s: "42" }]);
  const fn = QH.tokenize("foo(", "js");
  assert.equal(fn[0].t, "function");
  assert.equal(fn[0].s, "foo");
});

test("more per-language token types", () => {
  const has = (code, lang, type, text) =>
    QH.tokenize(code, lang).some((k) => k.t === type && k.s === text);

  // ts
  assert.ok(has("string", "ts", "type", "string"));
  // py
  assert.ok(has("def foo():", "py", "keyword", "def"));
  assert.equal(QH.tokenize("foo()", "py")[0].t, "function");
  assert.ok(has("'''t'''", "py", "string", "'''t'''"));
  assert.ok(has("# c", "py", "comment", "# c"));
  assert.ok(has("@dec", "py", "meta", "@dec"));
  // rust
  assert.ok(has("fn main()", "rust", "keyword", "fn"));
  // go
  assert.ok(has("package main", "go", "keyword", "package"));
  // c / cpp / java / csharp
  assert.ok(has("struct S", "c", "keyword", "struct"));
  assert.ok(has("int x", "cpp", "keyword", "int"));
  assert.ok(has("public class Foo", "java", "keyword", "public"));
  assert.ok(has("using System;", "csharp", "keyword", "using"));
  // json / sql
  assert.ok(has("{\"a\": true}", "json", "keyword", "true"));
  assert.ok(has("select * from t", "sql", "keyword", "select"));
  // bash
  assert.equal(QH.tokenize("#!/usr/bin/env node\n", "bash")[0].t, "meta");
  assert.ok(has("for", "bash", "keyword", "for"));
  assert.ok(has("$HOME", "bash", "attr", "$HOME"));
  // powershell
  assert.ok(has("$x", "powershell", "attr", "$x"));
  // html
  const htmlToks = QH.tokenize("<div class=\"a\" data-x=5>x</div>", "html");
  assert.ok(htmlToks.some((k) => k.t === "tag" && k.s === "<div"));
  assert.ok(htmlToks.some((k) => k.t === "attr" && k.s === "class"));
  assert.ok(htmlToks.some((k) => k.t === "string" && k.s === "\"a\""));
  assert.ok(htmlToks.some((k) => k.t === "tag" && k.s === "</div"));
  assert.ok(has("<!-- c -->", "html", "comment", "<!-- c -->"));
  assert.ok(has("<!DOCTYPE html>", "html", "meta", "<!DOCTYPE html>"));
  // css
  assert.ok(has("@media", "css", "meta", "@media"));
  assert.ok(has("100px", "css", "number", "100px"));
  assert.ok(has("color: red", "css", "attr", "color"));
  assert.ok(has("rgb(", "css", "function", "rgb"));
  assert.ok(has("#fff", "css", "number", "#fff"));
  // yaml
  assert.ok(has("key: value", "yaml", "attr", "key"));
  assert.ok(has("ok: true", "yaml", "keyword", "true"));
  assert.ok(has("n: 42", "yaml", "number", "42"));
  assert.equal(QH.tokenize("---\n", "yaml")[0].t, "meta");
  assert.ok(has("# c", "yaml", "comment", "# c"));
  // markdown
  assert.deepEqual(QH.tokenize("# Heading", "md"), [{ t: "meta", s: "# Heading" }]);
  assert.ok(has("`code`", "md", "string", "`code`"));
  // diff
  assert.ok(has("+a", "diff", "string", "+a"));
  assert.ok(has("-b", "diff", "keyword", "-b"));
  assert.ok(has("@@ -1 +1 @@", "diff", "meta", "@@ -1 +1 @@"));
  assert.ok(has("plain", "diff", null, "plain"));
});

test("empty input tokenizes to no tokens", () => {
  for (const lang of ["js", "", "diff", "html", "md"]) {
    assert.deepEqual(QH.tokenize("", lang), []);
  }
});

test("performance: 200 KB single line under 100 ms", () => {
  const unit = "function fn123(a, b) { if (a.b !== \"ok\") { /* note */ return [1, 2.5e3, 0x2f]; } } const q = 'tail' + \"str\"; 42 % 9; x.foo(#nope)  ";
  let big = unit;
  while (big.length < 200000) big += unit;
  big = big.slice(0, 200000);
  assertRoundTrip(big, "js"); // warm + integrity on the long line
  const t0 = performance.now();
  QH.tokenize(big, "js");
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `too slow: ${ms.toFixed(1)} ms`);
});

test("performance: 200 KB long python/file round trips", () => {
  const unit = "def f(x): # c\n  return \"s\" + '''t''' + str(0x2f) *\n";
  let big = unit;
  while (big.length < 200000) big += unit;
  assertRoundTrip(big, "py");
  assertRoundTrip(big, "md");
  assertRoundTrip(big, "diff");
  assertRoundTrip(big, "html");
  assertRoundTrip(big, "yaml");
  assertRoundTrip(big, "css");
});

test("node/CJS wiring", () => {
  assert.equal(QH.module, undefined);
  assert.ok(QH.tokenize("ok", "js").length >= 1);
  assert.equal(typeof globalThis.window, "undefined"); // never fabricated a window in Node
});

console.log(failures ? `${failures} group(s) FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
