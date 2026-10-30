// QHighlight — dependency-free syntax highlighting for QChat code blocks.
//
// Design: one small hand-written scanner per language family, driven by data
// tables (keywords, comment styles, string styles). Linear time, no regex
// backtracking, and safe on incomplete code (strings/comments may stream in
// unterminated). CSP-safe: no eval, no innerHTML — DOM output only ever uses
// document.createTextNode and spans.
(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;

  // ---------------------------------------------------------------------------
  // Character helpers (char-code based: fast and regex-free)
  // ---------------------------------------------------------------------------
  function isAlpha(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
  function isDigit(c) { return c >= 48 && c <= 57; }
  function isHexDigit(c) { return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70); }
  function isIdentStart(c) { return isAlpha(c) || c === 95 || c === 36; } // _ $
  function isIdentPart(c) { return isIdentStart(c) || isDigit(c); }

  const KEYWORDS = (list) => { const s = new Set(); for (const w of list) s.add(w); return s; };
  const UNION = (...sets) => {
    const s = new Set();
    for (const t of sets) for (const x of t) s.add(x);
    return s;
  };

  // Shared token bookkeeping: `plain` flushes pending plain text, `emit` records
  // a typed token. Every token is an exact slice of the source, so concatenating
  // all slices always reproduces the input — even when unterminated.
  function open(src) {
    const toks = [];
    let mark = 0;
    const plain = (end) => {
      if (end > mark) { toks.push({ t: null, s: src.slice(mark, end) }); mark = end; }
    };
    const emit = (type, start, end) => {
      plain(start);
      toks.push({ t: type, s: src.slice(start, end) });
      mark = end;
    };
    return { toks, plain, emit, get mark() { return mark; } };
  }

  // Find a string's end for quote spec {d: delimiter, e: escape flag, t: doubled-quote escape}.
  function findStringEnd(src, i, q) {
    const n = src.length, d = q.d;
    let j = i + d.length;
    while (j < n) {
      if (q.e && src.charCodeAt(j) === 92) { j += 2; continue; } // \ escape
      if (src.startsWith(d, j)) {
        if (q.t && j + d.length < n && src.charCodeAt(j + d.length) === d.charCodeAt(0)) {
          j += d.length; continue; // "" / '' doubling
        }
        return j + d.length;
      }
      j++;
    }
    return n; // unterminated: tolerate partial input while streaming
  }

  // Shared number scanner (starts at digit, ".", or optional "-"; caller decides).
  function scanNumber(src, i, n) {
    let j = i;
    if (src.charCodeAt(j) === 45) j++; // leading -
    const c = src.charCodeAt(j);
    if (c === 48 && (src.charCodeAt(j + 1) | 32) === 120) { // 0x
      j += 2; while (j < n && isHexDigit(src.charCodeAt(j))) j++;
    } else if (c === 48 && (src.charCodeAt(j + 1) | 32) === 98) { // 0b
      j += 2; while (j < n && (src.charCodeAt(j) === 48 || src.charCodeAt(j) === 49)) j++;
    } else if (c === 48 && (src.charCodeAt(j + 1) | 32) === 111) { // 0o
      j += 2; while (j < n && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 55) j++;
    } else {
      while (j < n && isDigit(src.charCodeAt(j))) j++;
      if (src.charCodeAt(j) === 46 && isDigit(src.charCodeAt(j + 1))) {
        j++; while (j < n && isDigit(src.charCodeAt(j))) j++;
      }
      const e = src.charCodeAt(j) | 32;
      if (e === 101) {
        let k = j + 1;
        if (src.charCodeAt(k) === 43 || src.charCodeAt(k) === 45) k++;
        if (isDigit(src.charCodeAt(k))) { j = k; while (j < n && isDigit(src.charCodeAt(j))) j++; }
      }
    }
    // consume units/suffixes/separators (10px, 10ULL, 1_000)
    while (j < n && isIdentPart(src.charCodeAt(j))) j++;
    return j;
  }

  // ---------------------------------------------------------------------------
  // Family scanner: C-like (js, ts, c, cpp, csharp, java, go, rust, json, py,
  // sql, bash, powershell) — all driven by the same state machine + data tables.
  // ---------------------------------------------------------------------------
  function scanCLike(src, cfg) {
    const n = src.length;
    const S = open(src);
    const { toks, plain, emit } = S;
    let i = 0;

    // Group rules by first character so each position checks only candidates.
    const chars = new Map();
    const entry = (k) => {
      let e = chars.get(k);
      if (!e) { e = {}; chars.set(k, e); }
      return e;
    };
    for (const line of (cfg.line || [])) {
      const e = entry(line.charAt(0));
      (e.lines = e.lines || []).push(line);
    }
    for (const b of (cfg.block || [])) {
      const e = entry(b[0].charAt(0));
      (e.blocks = e.blocks || []).push(b);
    }
    for (const q of (cfg.quotes || [])) {
      const e = entry(q.d.charAt(0));
      (e.qs = e.qs || []).push(q);
    }

    if (cfg.hashbang && n > 1 && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
      let e = src.indexOf("\n", 2);
      if (e < 0) e = n;
      emit("meta", 0, e);
      i = e;
    }

    while (i < n) {
      const ch = src.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) { i++; continue; }

      // Rust lifetimes ('a) stay plain; char literals ('x', '\n') go the normal route.
      if (cfg.life && ch === 39 && i + 1 < n) {
        const c1 = src.charCodeAt(i + 1);
        if (c1 !== 92 && isIdentStart(c1) && src.charCodeAt(i + 2) !== 39) { i++; continue; }
      }

      const ent = chars.get(src.charAt(i));
      if (ent) {
        let done = false;
        if (ent.lines) {
          for (const l of ent.lines) {
            if (src.startsWith(l, i)) {
              let e = src.indexOf("\n", i + l.length);
              if (e < 0) e = n;
              emit("comment", i, e); i = e; done = true; break;
            }
          }
        }
        if (!done && ent.blocks) {
          for (const b of ent.blocks) {
            if (src.startsWith(b[0], i)) {
              let e = src.indexOf(b[1], i + b[0].length);
              const end = e < 0 ? n : e + b[1].length;
              emit("comment", i, end); i = end; done = true; break;
            }
          }
        }
        if (!done && ent.qs) {
          for (const q of ent.qs) {
            if (src.startsWith(q.d, i)) {
              const end = findStringEnd(src, i, q);
              emit("string", i, end); i = end; done = true; break;
            }
          }
        }
        if (done) continue;
      }

      // Python decorators (@word, @a.b)
      if (cfg.at && ch === 64 && i + 1 < n && isAlpha(src.charCodeAt(i + 1))) {
        let j = i + 1;
        while (j < n && isIdentPart(src.charCodeAt(j))) j++;
        while (j < n && src.charCodeAt(j) === 46) {
          let k = j + 1;
          while (k < n && isIdentPart(src.charCodeAt(k))) k++;
          if (k === j + 1) break;
          j = k;
        }
        emit("meta", i, j); i = j; continue;
      }

      // Shell variables ($x, ${...})
      if (cfg.dollar && ch === 36 && i + 1 < n) {
        const c1 = src.charCodeAt(i + 1);
        if (isIdentStart(c1) || c1 === 123) {
          let j = i + 2;
          if (c1 === 123) {
            let depth = 1;
            while (j < n && depth > 0) {
              const cj = src.charCodeAt(j);
              if (cj === 123) depth++;
              else if (cj === 125) { depth--; if (depth === 0) { j++; break; } }
              j++;
            }
          } else {
            while (j < n && isIdentPart(src.charCodeAt(j))) j++;
          }
          emit("attr", i, j); i = j; continue;
        }
      }

      // Identifiers / keywords
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(src.charCodeAt(j))) j++;
        const word = src.slice(i, j);
        const probe = cfg.ci ? word.toUpperCase() : word;
        if (cfg.kw && cfg.kw.has(probe)) emit("keyword", i, j);
        else if (cfg.ty && cfg.ty.has(probe)) emit("type", i, j);
        else if (cfg.func) {
          let k = j;
          while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
          if (src.charCodeAt(k) === 40) emit("function", i, j); // ident(
        }
        i = j; continue;
      }

      // Numbers (not directly after an identifier, so foo.10 stays plain-ish)
      if (isDigit(ch) ||
        (ch === 46 && isDigit(src.charCodeAt(i + 1)) && !(i > 0 && isIdentPart(src.charCodeAt(i - 1))))) {
        const j = scanNumber(src, i, n);
        emit("number", i, j); i = j; continue;
      }

      i++;
    }
    plain(n);
    return toks;
  }

  // ---------------------------------------------------------------------------
  // HTML / XML / SVG
  // ---------------------------------------------------------------------------
  function isNameChar(c) {
    return isAlpha(c) || isDigit(c) || c === 45 || c === 58 || c === 46 || c === 95;
  }

  function scanHtml(src) {
    const n = src.length;
    const S = open(src);
    const { toks, plain, emit } = S;
    let i = 0, inTag = false;

    const readName = (start) => {
      let j = start;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      return j;
    };

    while (i < n) {
      const ch = src.charCodeAt(i);

      if (ch === 60) { // <
        if (src.startsWith("<!--", i)) {
          let e = src.indexOf("-->", i + 4);
          const end = e < 0 ? n : e + 3;
          emit("comment", i, end); i = end; continue;
        }
        if (src.startsWith("<!", i)) {
          const e = src.indexOf(">", i + 2);
          const end = e < 0 ? n : e + 1;
          emit("meta", i, end); i = end; continue;
        }
        if (src.startsWith("<?", i)) {
          const e = src.indexOf("?>", i + 2);
          const end = e < 0 ? n : e + 2;
          emit("meta", i, end); i = end; continue;
        }
        if (i + 1 < n && src.charCodeAt(i + 1) === 47) { // </name>
          const j = readName(i + 2);
          emit("tag", i, j); i = j; inTag = false; continue;
        }
        if (i + 1 < n && isAlpha(src.charCodeAt(i + 1))) { // <name
          const j = readName(i + 1);
          emit("tag", i, j); i = j; inTag = true; continue;
        }
        i++; continue; // bare "<"
      }

      if (inTag) {
        if (ch === 62) { inTag = false; i++; continue; }  // >
        if (ch === 47) { i++; continue; }                  // /
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13) { i++; continue; }
        if (isAlpha(ch)) {
          const j = readName(i);
          let k = j;
          while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10 || src.charCodeAt(k) === 13)) k++;
          if (src.charCodeAt(k) === 61) { // attr=
            emit("attr", i, j);
            i = k + 1; // "=" falls out as plain implicitly
            // value
            let m = i;
            while (m < n && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9 || src.charCodeAt(m) === 10 || src.charCodeAt(m) === 13)) m++;
            const q = m < n ? src.charCodeAt(m) : 0;
            if (q === 34 || q === 39) {
              let e = m + 1;
              while (e < n && src.charCodeAt(e) !== q) e++;
              const end = e < n ? e + 1 : n;
              emit("string", m, end);
              i = end;
            } else if (q !== 0 && q !== 62 && !(q === 47 && src.charCodeAt(m + 1) === 62)) {
              let e = m;
              while (e < n) {
                const c = src.charCodeAt(e);
                if (c === 32 || c === 9 || c === 10 || c === 13 || c === 62) break;
                e++;
              }
              emit("string", m, e);
              i = e;
            }
            continue;
          }
          i = j; continue; // bare attribute name stays plain
        }
        i++; continue;
      }

      // Text: jump to the next '<'
      const lt = src.indexOf("<", i);
      if (lt < 0) { plain(n); return toks; }
      i = lt;
    }
    plain(n);
    return toks;
  }

  // ---------------------------------------------------------------------------
  // CSS / SCSS
  // ---------------------------------------------------------------------------
  function scanCss(src) {
    const n = src.length;
    const S = open(src);
    const { toks, plain, emit } = S;
    let i = 0;

    while (i < n) {
      const ch = src.charCodeAt(i);
      if (ch === 47 && src.startsWith("/*", i)) { // comment
        let e = src.indexOf("*/", i + 2);
        const end = e < 0 ? n : e + 2;
        emit("comment", i, end); i = end; continue;
      }
      if (ch === 34 || ch === 39) { // string
        let j = i + 1;
        while (j < n) {
          const c = src.charCodeAt(j);
          if (c === 92) { j += 2; continue; }
          if (c === ch) { j++; break; }
          j++;
        }
        const end = j > n ? n : j;
        emit("string", i, end); i = end; continue;
      }
      if (ch === 33 && src.startsWith("!important", i)) { // !important
        emit("keyword", i, i + 10); i = i + 10; continue;
      }
      if (ch === 64 && i + 1 < n && isAlpha(src.charCodeAt(i + 1))) { // @rule
        let j = i + 1;
        while (j < n && (isIdentPart(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
        emit("meta", i, j); i = j; continue;
      }
      if (ch === 35 && isHexDigit(src.charCodeAt(i + 1))) { // #hex color
        let j = i + 1;
        while (j < n && isHexDigit(src.charCodeAt(j))) j++;
        emit("number", i, j); i = j; continue;
      }
      if (isDigit(ch) ||
        (ch === 46 && isDigit(src.charCodeAt(i + 1))) ||
        (ch === 45 && isDigit(src.charCodeAt(i + 1)))) {
        const j = scanNumber(src, i, n);
        emit("number", i, j); i = j; continue;
      }
      if (isAlpha(ch) || (ch === 45 && i + 1 < n && isAlpha(src.charCodeAt(i + 1)))) {
        let j = i + 1;
        while (j < n && (isIdentPart(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
        const nc = src.charCodeAt(j);
        if (nc === 40) emit("function", i, j); // rgb(
        else if (nc === 58) emit("attr", i, j); // property name before ":"
        i = j; continue;
      }
      i++;
    }
    plain(n);
    return toks;
  }

  // ---------------------------------------------------------------------------
  // YAML / YML
  // ---------------------------------------------------------------------------
  function scanYaml(src) {
    const n = src.length;
    const S = open(src);
    const { toks, plain, emit } = S;
    let i = 0;

    while (i < n) {
      const lineStart = i === 0 || src.charCodeAt(i - 1) === 10;
      const ch = src.charCodeAt(i);

      if (lineStart) {
        const le = src.indexOf("\n", i);
        const lim = le < 0 ? n : le;

        // Indentation stays plain.
        let j = i;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
        if (j > i) { plain(j); i = j; continue; }

        if (ch === 35) { // whole-line comment
          emit("comment", i, lim);
          i = le < 0 ? n : le + 1;
          continue;
        }
        if ((src.startsWith("---", i) || src.startsWith("...", i)) &&
          (lim === i + 3 || src.charCodeAt(i + 3) === 32 || src.charCodeAt(i + 3) === 9)) {
          emit("meta", i, i + 3);
          i = i + 3;
          continue;
        }
        if (ch === 34 || ch === 39) { // quoted scalar (possibly a quoted key)
          let k = i + 1;
          while (k < lim && src.charCodeAt(k) !== ch) k++;
          const end = k < lim ? k + 1 : lim;
          emit("string", i, end); i = end; continue;
        }
        // "key:" detection at content start
        if (isAlpha(ch) || isDigit(ch) || ch === 95 || ch === 46) {
          let k = i;
          while (k < lim) {
            const c = src.charCodeAt(k);
            if (isAlpha(c) || isDigit(c) || c === 95 || c === 46 || c === 45 || c === 47) { k++; continue; }
            break;
          }
          if (k > i) {
            let m = k;
            while (m < lim && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
            if (src.charCodeAt(m) === 58 &&
              (m + 1 >= lim || src.charCodeAt(m + 1) === 32 || src.charCodeAt(m + 1) === 9)) {
              emit("attr", i, k);
              i = m + 1; // ":" plain implicitly
              continue;
            }
          }
        }
      }

      // Mid-line value scanning.
      const prev = i > 0 ? src.charCodeAt(i - 1) : 10;
      if (ch === 35 && (prev === 32 || prev === 9)) {
        const le = src.indexOf("\n", i);
        const end = le < 0 ? n : le;
        emit("comment", i, end); i = end; continue;
      }
      if (ch === 34 || ch === 39) {
        const le = src.indexOf("\n", i);
        const lim = le < 0 ? n : le;
        let k = i + 1;
        while (k < lim && src.charCodeAt(k) !== ch) k++;
        const end = k < lim ? k + 1 : lim;
        emit("string", i, end); i = end; continue;
      }
      if (isDigit(ch) || (ch === 45 && i + 1 < n && isDigit(src.charCodeAt(i + 1)))) {
        const j = scanNumber(src, i, n);
        emit("number", i, j); i = j; continue;
      }
      if (isAlpha(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(src.charCodeAt(j))) j++;
        const word = src.slice(i, j).toLowerCase();
        if (word === "true" || word === "false" || word === "null" ||
          word === "yes" || word === "no" || word === "on" || word === "off") {
          emit("keyword", i, j);
        }
        i = j; continue;
      }
      i++;
    }
    plain(n);
    return toks;
  }

  // ---------------------------------------------------------------------------
  // Markdown: headings and code spans only, everything else plain.
  // ---------------------------------------------------------------------------
  function scanMarkdown(src) {
    const n = src.length;
    const S = open(src);
    const { toks, plain, emit } = S;
    let i = 0;

    while (i < n) {
      const lineStart = i === 0 || src.charCodeAt(i - 1) === 10;

      if (lineStart) {
        let j = i;
        while (j < n && src.charCodeAt(j) === 35) j++; // # run
        if (j > i && j - i <= 6 &&
          (j === n || src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) {
          const le = src.indexOf("\n", i);
          const end = le < 0 ? n : le;
          emit("meta", i, end);
          i = le < 0 ? n : le + 1;
          continue;
        }
      }

      if (src.charCodeAt(i) === 96) { // code span: `...`
        let j = i;
        while (j < n && src.charCodeAt(j) === 96) j++;
        const run = j - i;
        const le = src.indexOf("\n", j);
        const lim = le < 0 ? n : le;
        let k = j;
        let end = lim; // unterminated: to end of line
        while (k < lim) {
          if (src.charCodeAt(k) === 96) {
            let m = k;
            while (m < lim && src.charCodeAt(m) === 96) m++;
            if (m - k === run) { end = m; break; }
            k = m;
          } else {
            k++;
          }
        }
        emit("string", i, end); i = end; continue;
      }

      i++;
    }
    plain(n);
    return toks;
  }

  // ---------------------------------------------------------------------------
  // Diff: + lines are strings, - lines are keywords, @@ lines are meta.
  // ---------------------------------------------------------------------------
  function scanDiff(src) {
    const n = src.length;
    const S = open(src);
    const { toks, plain, emit } = S;
    let i = 0;

    while (i < n) {
      if (i === 0 || src.charCodeAt(i - 1) === 10) {
        const ch = src.charCodeAt(i);
        if (ch === 43 || ch === 45 || (ch === 64 && src.charCodeAt(i + 1) === 64)) {
          const le = src.indexOf("\n", i);
          const end = le < 0 ? n : le;
          const type = ch === 43 ? "string" : ch === 45 ? "keyword" : "meta";
          emit(type, i, end);
          i = le < 0 ? n : le + 1;
          continue;
        }
        // skip the rest of the line as plain
        const le = src.indexOf("\n", i);
        i = le < 0 ? n : le + 1;
        continue;
      }
      i++;
    }
    plain(n);
    return toks;
  }

  // ---------------------------------------------------------------------------
  // Language tables
  // ---------------------------------------------------------------------------
  const JS_KW = KEYWORDS([
    "abstract", "async", "await", "break", "case", "catch", "class", "const",
    "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
    "extends", "false", "finally", "for", "from", "function", "get", "if",
    "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
    "of", "private", "protected", "public", "return", "set", "static", "super",
    "switch", "this", "throw", "true", "try", "typeof", "undefined", "var",
    "void", "while", "with", "yield"
  ]);
  const JS_TY = KEYWORDS([
    "Array", "Boolean", "Date", "Error", "Function", "JSON", "Map", "Math",
    "Number", "Object", "Promise", "Proxy", "Reflect", "RegExp", "Set", "String",
    "Symbol", "console", "document", "globalThis", "window"
  ]);

  const JS = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "`", e: 1 }, { d: "\"", e: 1 }, { d: "'", e: 1 }],
    kw: JS_KW,
    ty: JS_TY,
    func: 1
  };

  const TS = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "`", e: 1 }, { d: "\"", e: 1 }, { d: "'", e: 1 }],
    kw: UNION(JS_KW, KEYWORDS([
      "any", "as", "asserts", "declare", "infer", "keyof", "namespace",
      "override", "readonly", "satisfies", "type"
    ])),
    ty: UNION(JS_TY, KEYWORDS([
      "any", "bigint", "boolean", "never", "number", "object", "string",
      "symbol", "unknown", "void"
    ])),
    func: 1
  };

  const PY = {
    family: "clike",
    line: ["#"],
    quotes: [{ d: "'''", e: 1 }, { d: "\"\"\"", e: 1 }, { d: "'", e: 1 }, { d: "\"", e: 1 }],
    kw: KEYWORDS([
      "and", "as", "assert", "async", "await", "break", "case", "class",
      "continue", "def", "del", "elif", "else", "except", "False", "finally",
      "for", "from", "global", "if", "import", "in", "is", "lambda", "match",
      "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try",
      "while", "with", "yield"
    ]),
    ty: KEYWORDS([
      "bool", "dict", "float", "frozenset", "int", "list", "set", "str", "tuple",
      "type", "print", "len", "range", "open", "iter", "next", "repr", "format", "input"
    ]),
    at: 1,
    func: 1
  };

  const C_KW = KEYWORDS([
    "auto", "break", "case", "const", "continue", "default", "do", "double",
    "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int",
    "long", "register", "restrict", "return", "short", "signed", "sizeof",
    "static", "struct", "switch", "typedef", "union", "unsigned", "void",
    "volatile", "while"
  ]);
  const C_TY = KEYWORDS([
    "bool", "char", "double", "float", "int", "long", "short", "signed",
    "unsigned", "size_t", "ssize_t", "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t", "intptr_t", "uintptr_t",
    "FILE", "NULL", "true", "false"
  ]);

  const C = { family: "clike", line: ["//"], block: [["/*", "*/"]], quotes: [{ d: "\"", e: 1 }, { d: "'", e: 1 }], kw: C_KW, ty: C_TY, func: 1 };

  const CPP = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "\"", e: 1 }, { d: "'", e: 1 }],
    kw: UNION(C_KW, KEYWORDS([
      "alignas", "alignof", "and", "class", "co_await", "co_return", "co_yield",
      "compl", "concept", "consteval", "constexpr", "constinit", "const_cast",
      "decltype", "delete", "dynamic_cast", "explicit", "export", "final",
      "friend", "mutable", "namespace", "new", "noexcept", "not", "nullptr",
      "operator", "or", "override", "private", "protected", "public",
      "reinterpret_cast", "requires", "static_assert", "static_cast", "template",
      "this", "thread_local", "throw", "true", "try", "typeid", "typename",
      "using", "virtual", "xor"
    ])),
    ty: UNION(C_TY, KEYWORDS(["char8_t", "char16_t", "char32_t", "wchar_t"])),
    func: 1
  };

  const RUST = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "\"", e: 1 }, { d: "'", e: 1 }],
    kw: KEYWORDS([
      "as", "async", "await", "break", "const", "continue", "crate", "dyn",
      "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop",
      "match", "mod", "move", "mut", "pub", "ref", "self", "Self", "static",
      "struct", "super", "trait", "type", "union", "unsafe", "use", "where",
      "while", "true", "false"
    ]),
    ty: KEYWORDS([
      "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize",
      "str", "u8", "u16", "u32", "u64", "u128", "usize", "String", "Vec",
      "Option", "Result", "Box", "Rc", "Arc", "Cell", "RefCell", "HashMap",
      "HashSet", "BTreeMap", "BTreeSet"
    ]),
    life: 1,
    func: 1
  };

  const GO = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "\"", e: 1 }, { d: "`", e: 1 }, { d: "'", e: 1 }],
    kw: KEYWORDS([
      "break", "case", "chan", "const", "continue", "default", "defer", "else",
      "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
      "map", "package", "range", "return", "select", "struct", "switch", "type",
      "var"
    ]),
    ty: KEYWORDS([
      "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
      "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
      "uint16", "uint32", "uint64", "uintptr", "nil", "true", "false", "append",
      "cap", "close", "copy", "delete", "len", "make", "new", "panic", "print",
      "println", "recover"
    ]),
    func: 1
  };

  const CS = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "\"", e: 1 }, { d: "'", e: 1 }],
    kw: KEYWORDS([
      "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char",
      "checked", "class", "const", "continue", "decimal", "default", "delegate",
      "do", "double", "else", "enum", "event", "explicit", "extern", "false",
      "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit",
      "in", "int", "interface", "internal", "is", "lock", "long", "namespace",
      "new", "null", "object", "operator", "out", "override", "params",
      "private", "protected", "public", "readonly", "ref", "return", "sbyte",
      "sealed", "short", "sizeof", "stackalloc", "static", "string", "struct",
      "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong",
      "unchecked", "unsafe", "ushort", "using", "var", "virtual", "void",
      "volatile", "while"
    ]),
    ty: KEYWORDS([
      "String", "Int32", "Int64", "Boolean", "Double", "Decimal", "Math",
      "Console", "Task", "List", "Dictionary", "Object", "DateTime", "Guid",
      "Exception", "Action", "Func", "IEnumerable"
    ]),
    func: 1
  };

  const JAVA = {
    family: "clike",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: [{ d: "\"", e: 1 }, { d: "'", e: 1 }],
    kw: KEYWORDS([
      "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
      "class", "const", "continue", "default", "do", "double", "else", "enum",
      "exports", "extends", "final", "finally", "float", "for", "goto", "if",
      "implements", "import", "instanceof", "int", "interface", "long", "module",
      "native", "new", "null", "open", "opens", "package", "permits", "private",
      "protected", "provides", "public", "record", "requires", "return", "sealed",
      "short", "static", "strictfp", "super", "switch", "synchronized", "this",
      "throw", "throws", "to", "transitive", "true", "false", "try", "uses",
      "var", "void", "volatile", "while", "yield"
    ]),
    ty: KEYWORDS([
      "String", "Integer", "Long", "Boolean", "Double", "Float", "Character",
      "Byte", "Short", "Math", "System", "Object", "List", "ArrayList", "Map",
      "HashMap", "Set", "HashSet", "Optional", "Stream", "Exception",
      "RuntimeException", "Thread", "Runnable", "Void", "BigDecimal"
    ]),
    func: 1
  };

  const JSON = {
    family: "clike",
    quotes: [{ d: "\"", e: 1 }],
    kw: KEYWORDS(["true", "false", "null"])
  };

  const SQL = {
    family: "clike",
    line: ["--"],
    block: [["/*", "*/"]],
    quotes: [{ d: "'", e: 0, t: 1 }, { d: "\"", e: 0, t: 1 }, { d: "`", e: 0 }],
    kw: KEYWORDS([
      "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "BEGIN", "BETWEEN", "BY",
      "CASE", "CHECK", "COLUMN", "COMMIT", "CONSTRAINT", "CREATE", "CROSS",
      "DEFAULT", "DELETE", "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXISTS",
      "FOREIGN", "FROM", "FULL", "GRANT", "GROUP", "HAVING", "IN", "INDEX",
      "INNER", "INSERT", "INTO", "IS", "JOIN", "KEY", "LEFT", "LIKE", "LIMIT",
      "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER", "PRIMARY",
      "REFERENCES", "RIGHT", "ROLLBACK", "SELECT", "SET", "TABLE", "THEN",
      "TRANSACTION", "UNION", "UNIQUE", "UPDATE", "VALUES", "VIEW", "WHEN",
      "WHERE", "WITH"
    ]),
    ci: 1,
    func: 1
  };

  const BASH = {
    family: "clike",
    line: ["#"],
    quotes: [{ d: "'", e: 0 }, { d: "\"", e: 1 }, { d: "`", e: 0 }],
    kw: KEYWORDS([
      "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
      "case", "esac", "in", "function", "select", "time", "coproc", "return",
      "exit", "break", "continue", "local", "export", "readonly", "declare",
      "typeset", "unset", "set", "shift", "eval", "exec", "trap", "source",
      "alias", "echo", "printf", "read", "test", "true", "false", "cd", "pushd",
      "popd", "jobs", "bg", "fg", "kill", "wait"
    ]),
    dollar: 1,
    hashbang: 1
  };

  const POWERSHELL = {
    family: "clike",
    line: ["#"],
    block: [["<#", "#>"]],
    quotes: [{ d: "'", e: 0 }, { d: "\"", e: 0 }],
    kw: KEYWORDS([
      "function", "if", "elseif", "else", "switch", "foreach", "for", "while",
      "do", "until", "break", "continue", "return", "throw", "try", "catch",
      "finally", "param", "begin", "process", "end", "filter", "trap", "in",
      "class", "enum", "new", "default", "hidden", "static", "workflow",
      "parallel", "sequence", "exit"
    ]),
    dollar: 1,
    hashbang: 1
  };

  // ---------------------------------------------------------------------------
  // Registry and aliases. languages maps every known id (canonical or alias)
  // to its canonical name.
  // ---------------------------------------------------------------------------
  const REGISTRY = {
    js: JS, ts: TS, py: PY, rust: RUST, go: GO, c: C, cpp: CPP, csharp: CS,
    java: JAVA, json: JSON, sql: SQL, bash: BASH, powershell: POWERSHELL,
    html: { family: "html" },
    css: { family: "css" },
    yaml: { family: "yaml" },
    md: { family: "markdown" },
    diff: { family: "diff" }
  };

  const languages = {
    "js": "js", "javascript": "js", "jsx": "js", "mjs": "js",
    "ts": "ts", "typescript": "ts", "tsx": "ts",
    "py": "py", "python": "py",
    "rust": "rust", "rs": "rust",
    "go": "go",
    "c": "c",
    "cpp": "cpp", "c++": "cpp",
    "csharp": "csharp", "cs": "csharp", "c#": "csharp",
    "java": "java",
    "json": "json",
    "html": "html", "xml": "html", "svg": "html",
    "css": "css", "scss": "css",
    "bash": "bash", "sh": "bash", "shell": "bash", "zsh": "bash",
    "powershell": "powershell", "ps1": "powershell",
    "sql": "sql",
    "yaml": "yaml", "yml": "yaml",
    "md": "md", "markdown": "md",
    "diff": "diff"
  };

  function tokenize(code, lang) {
    const src = String(code == null ? "" : code);
    if (!src.length) return [];
    const key = String(lang == null ? "" : lang).toLowerCase().trim();
    const name = languages[key];
    const rule = name ? REGISTRY[name] : null;
    if (!rule) return [{ t: null, s: src }];
    switch (rule.family) {
      case "html": return scanHtml(src);
      case "css": return scanCss(src);
      case "yaml": return scanYaml(src);
      case "markdown": return scanMarkdown(src);
      case "diff": return scanDiff(src);
      default: return scanCLike(src, rule);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM rendering: never innerHTML — text nodes and spans only.
  // ---------------------------------------------------------------------------
  const rendered = new WeakMap();

  function highlightInto(el, code, lang) {
    if (!el || typeof document === "undefined" || typeof el.appendChild !== "function") return;
    const src = String(code == null ? "" : code);
    const langKey = String(lang == null ? "" : lang);
    const prev = rendered.get(el);
    if (prev && prev.code === src && prev.lang === langKey) return; // unchanged: cheap no-op

    const toks = tokenize(src, langKey);
    const frag = document.createDocumentFragment();
    for (const tok of toks) {
      if (tok.t == null) {
        frag.appendChild(document.createTextNode(tok.s));
      } else {
        const span = document.createElement("span");
        span.className = "tok-" + tok.t;
        span.appendChild(document.createTextNode(tok.s));
        frag.appendChild(span);
      }
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(frag);
    rendered.set(el, { code: src, lang: langKey });
  }

  const QHighlight = { tokenize, highlightInto, languages };

  root.QHighlight = QHighlight;
  if (typeof module !== "undefined") module.exports = QHighlight;
})();
