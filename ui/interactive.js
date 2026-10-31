(function () {
  'use strict';
  // This is a data interpreter: source never becomes host JavaScript.
  const MAX_SOURCE = 200000, MAX_SIZE = 100000, MAX_ITEMS = 1000;
  const badKey = key => (key !== null && typeof key === 'object') || /^(?:__proto__|prototype|constructor|caller|callee|arguments)$/.test(String(key));
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const record = () => Object.create(null);
  const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const display = value => typeof value === 'object' ? '' : escape(value).replace(/[\\`*_[\]{}()!#$|~]/g, '\\$&');
  function braceEnd(source, start) {
    let depth = 1, quote = '';
    for (let i = start + 1; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
      else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}' && !--depth) return i;
    }
    return -1;
  }
  function createSession() {
    const states = new Map(), callables = new WeakMap();
    let handlers = new Map(), steps = 0, iterations = 0, changed = false;
    function tick(depth = 0) { if (++steps > 20000 || depth > 40) throw Error('Interactive budget exceeded'); }
    function bounded(value) {
      if (typeof value === 'string' && value.length > MAX_SIZE || Array.isArray(value) && value.length > MAX_ITEMS || typeof value === 'number' && !Number.isFinite(value)) throw Error('Interactive value too large');
      return value;
    }
    function callable(meta) { const value = record(); callables.set(value, meta); return value; }
    function parse(source) {
      if (!window.acorn) throw Error('Parser unavailable');
      return window.acorn.parse(source, {ecmaVersion: 2022});
    }
    function expression(source) {
      const ast = parse('(' + source + '\n)');
      return ast.body[0].expression;
    }
    function get(obj, key) {
      if (badKey(key)) throw Error('Blocked property');
      key = String(key);
      if (badKey(key) || obj == null || callables.has(obj)) throw Error('Blocked property');
      if ((typeof obj === 'string' || Array.isArray(obj)) && key === 'length') return obj.length;
      if (typeof obj === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) return obj[Number(key)];
      if (typeof obj === 'object' && own(obj, key)) return obj[key];
      return undefined;
    }
    function invoke(fn, args, depth) {
      tick(depth);
      const meta = fn && callables.get(fn);
      if (!meta) throw Error('Call unavailable');
      if (meta.setter) {
        const next = args[0] && callables.has(args[0]) ? invoke(args[0], [states.get(meta.setter)], depth + 1) : args[0];
        bounded(next);
        if (states.get(meta.setter) !== next) { states.set(meta.setter, next); changed = true; }
        return undefined;
      }
      const env = Object.assign(record(), meta.env);
      meta.node.params.forEach((param, i) => { if (param.type !== 'Identifier' || badKey(param.name)) throw Error('Invalid parameter'); env[param.name] = args[i]; });
      if (meta.node.body.type !== 'BlockStatement') return evaluate(meta.node.body, env, depth + 1);
      return statements(meta.node.body.body, env, depth + 1).value;
    }
    function method(obj, key, args, depth) {
      if (badKey(key)) throw Error('Blocked method');
      const scalarArgs = () => { if (args.some(value => value !== null && typeof value === 'object')) throw Error('Invalid method argument'); };
      if (Array.isArray(obj)) {
        if (['map', 'filter', 'find', 'some', 'every'].includes(key)) {
          const result = [];
          for (let i = 0; i < obj.length; i++) {
            if (++iterations > MAX_ITEMS) throw Error('Iteration budget exceeded');
            const value = invoke(args[0], [obj[i], i], depth + 1);
            if (key === 'map') result.push(value);
            if (key === 'filter' && value) result.push(obj[i]);
            if (key === 'find' && value) return obj[i];
            if (key === 'some' && value) return true;
            if (key === 'every' && !value) return false;
          }
          return key === 'find' ? undefined : key === 'some' ? false : key === 'every' ? true : bounded(result);
        }
        if (key === 'slice') { scalarArgs(); return obj.slice(...args.slice(0, 2)); }
        if (key === 'concat') {
          if (args.reduce((size,value) => size + (Array.isArray(value) ? value.length : 1),obj.length) > MAX_ITEMS) throw Error('Array too large');
          return bounded(obj.concat(...args));
        }
        if (key === 'includes') return obj.includes(args[0]);
        if (key === 'indexOf') return obj.indexOf(args[0]);
        if (key === 'join' && obj.every(x => x == null || ['string', 'number', 'boolean'].includes(typeof x))) {
          scalarArgs();
          const separator = args[0] === undefined ? ',' : String(args[0]);
          if (obj.reduce((size,value) => size + String(value ?? '').length,0) + Math.max(0,obj.length - 1) * separator.length > MAX_SIZE) throw Error('String too large');
          return bounded(obj.join(separator));
        }
      }
      if (typeof obj === 'string') {
        scalarArgs();
        if (key === 'toLowerCase') return obj.toLowerCase();
        if (key === 'toUpperCase') return obj.toUpperCase();
        if (key === 'trim') return obj.trim();
        if (key === 'slice') return obj.slice(...args.slice(0, 2));
        if (key === 'includes') return obj.includes(args[0]);
        if (key === 'startsWith') return obj.startsWith(args[0]);
        if (key === 'endsWith') return obj.endsWith(args[0]);
        if (key === 'split' && typeof args[0] === 'string') return bounded(obj.split(args[0], MAX_ITEMS));
      }
      throw Error('Method unavailable');
    }
    function evaluate(node, env, depth = 0) {
      tick(depth);
      const run = n => evaluate(n, env, depth + 1);
      switch (node.type) {
        case 'Literal': if (node.regex || node.bigint) throw Error('Literal unavailable'); return bounded(node.value);
        case 'Identifier': if (badKey(node.name) || !own(env, node.name)) throw Error('Unknown binding'); return env[node.name];
        case 'ArrayExpression': {
          const result = [];
          for (const item of node.elements) {
            if (!item) result.push(undefined);
            else if (item.type === 'SpreadElement') { const value = run(item.argument); if (!Array.isArray(value)) throw Error('Invalid spread'); result.push(...value); }
            else result.push(run(item));
            bounded(result);
          }
          return result;
        }
        case 'ObjectExpression': {
          const result = record();
          for (const prop of node.properties) {
            if (prop.type === 'SpreadElement') {
              const value = run(prop.argument);
              if (!value || typeof value !== 'object' || Array.isArray(value) || callables.has(value)) throw Error('Invalid spread');
              for (const key of Object.keys(value)) { if (badKey(key)) throw Error('Blocked key'); result[key] = value[key]; }
            } else {
              if (prop.kind !== 'init' || prop.method) throw Error('Invalid property');
              const key = prop.computed ? run(prop.key) : prop.key.name ?? prop.key.value;
              if (badKey(key)) throw Error('Blocked key'); result[key] = run(prop.value);
            }
            if (Object.keys(result).length > MAX_ITEMS) throw Error('Object too large');
          }
          return result;
        }
        case 'MemberExpression': return get(run(node.object), node.computed ? run(node.property) : node.property.name);
        case 'ArrowFunctionExpression': if (node.async) throw Error('Async unavailable'); return callable({node, env});
        case 'ConditionalExpression': return run(node.test) ? run(node.consequent) : run(node.alternate);
        case 'LogicalExpression': { const left = run(node.left); return node.operator === '&&' ? left && run(node.right) : node.operator === '||' ? left || run(node.right) : left ?? run(node.right); }
        case 'UnaryExpression': {
          const value = run(node.argument);
          if (typeof value === 'object') throw Error('Invalid operand');
          if (node.operator === '!') return !value;
          if (node.operator === '-') return bounded(-value);
          if (node.operator === '+') return bounded(+value);
          if (node.operator === 'typeof') return typeof value;
          throw Error('Operator unavailable');
        }
        case 'BinaryExpression': {
          const a = run(node.left), b = run(node.right);
          if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) {
            if (node.operator === '===') return a === b;
            if (node.operator === '!==') return a !== b;
            throw Error('Invalid operand');
          }
          switch (node.operator) {
            case '+': return bounded(a + b); case '-': return bounded(a - b); case '*': return bounded(a * b); case '/': return bounded(a / b); case '%': return bounded(a % b);
            case '===': return a === b; case '!==': return a !== b; case '==': return a == b; case '!=': return a != b;
            case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
            default: throw Error('Operator unavailable');
          }
        }
        case 'TemplateLiteral': {
          let result = node.quasis[0].value.cooked;
          node.expressions.forEach((part, i) => { const value = run(part); if (typeof value === 'object') throw Error('Invalid template'); result = bounded(result + String(value ?? '') + node.quasis[i + 1].value.cooked); });
          return result;
        }
        case 'CallExpression': {
          if (node.optional || node.arguments.some(arg => arg.type === 'SpreadElement')) throw Error('Call unavailable');
          const args = node.arguments.map(run);
          if (node.callee.type === 'MemberExpression') {
            const member = node.callee, key = member.computed ? run(member.property) : member.property.name;
            return method(run(member.object), key, args, depth + 1);
          }
          return invoke(run(node.callee), args, depth + 1);
        }
        default: throw Error('Expression unavailable');
      }
    }
    function statements(nodes, env, depth = 0) {
      for (const node of nodes) {
        tick(depth);
        if (node.type === 'ReturnStatement') return {value: node.argument ? evaluate(node.argument, env, depth + 1) : undefined, returned: true};
        if (node.type === 'ExpressionStatement') evaluate(node.expression, env, depth + 1);
        else if (node.type === 'VariableDeclaration') declarations(node, env, depth + 1);
        else if (node.type === 'IfStatement') {
          const branch = evaluate(node.test, env, depth + 1) ? node.consequent : node.alternate;
          if (branch) { const result = statements(branch.type === 'BlockStatement' ? branch.body : [branch], env, depth + 1); if (result.returned) return result; }
        } else if (node.type !== 'EmptyStatement') throw Error('Statement unavailable');
      }
      return {};
    }
    function declarations(node, env, depth) {
      if (!['const', 'let'].includes(node.kind)) throw Error('Declaration unavailable');
      for (const item of node.declarations) {
        const init = item.init;
        if (item.id.type === 'ArrayPattern' && init?.type === 'CallExpression' && init.callee.type === 'MemberExpression' && !init.callee.computed && init.callee.object.name === 'DIL' && init.callee.property.name === 'useState') {
          const [value, setter] = item.id.elements;
          if (item.id.elements.length !== 2 || value?.type !== 'Identifier' || setter?.type !== 'Identifier' || badKey(value.name) || badKey(setter.name)) throw Error('Invalid state');
          const identity = value.name;
          if (!states.has(identity)) states.set(identity, evaluate(init.arguments[0], env, depth + 1));
          env[value.name] = states.get(identity); env[setter.name] = callable({setter: identity});
        } else {
          if (item.id.type !== 'Identifier' || badKey(item.id.name)) throw Error('Invalid binding');
          env[item.id.name] = init ? evaluate(init, env, depth + 1) : undefined;
        }
      }
    }
    function tagAt(source, at) {
      const head = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(source.slice(at));
      if (!head || !/^[\s/>]|^$/.test(source.slice(at + head[0].length))) return null;
      let i = at + head[0].length; const attrs = [];
      while (i < source.length) {
        while (/\s/.test(source[i] || '') && i < source.length) i++;
        if (source[i] === '>' || source.startsWith('/>', i)) return {name: head[2], close: !!head[1], self: source[i] === '/', attrs, end: i + (source[i] === '/' ? 2 : 1)};
        const key = /^[A-Za-z_][\w:-]*/.exec(source.slice(i));
        if (!key) return {partial: true, end: source.length};
        i += key[0].length; while (/\s/.test(source[i] || '') && i < source.length) i++;
        let value = true, dynamic = false;
        if (source[i] === '=') {
          i++; while (/\s/.test(source[i] || '') && i < source.length) i++;
          if (source[i] === '{') { const end = braceEnd(source, i); if (end < 0) return {partial: true, end: source.length}; value = source.slice(i + 1, end); dynamic = true; i = end + 1; }
          else if (source[i] === '"' || source[i] === "'") { const quote = source[i++], start = i; while (i < source.length && source[i] !== quote) i++; if (i === source.length) return {partial: true, end: i}; value = source.slice(start, i++); }
          else { const match = /^[^\s>]+/.exec(source.slice(i)); if (!match) return {partial: true, end: source.length}; value = match[0]; i += value.length; }
        }
        attrs.push({key: key[0].toLowerCase(), value, dynamic});
      }
      return {partial: true, end: source.length};
    }
    function validHandler(fn, scope) {
      const meta = fn && callables.get(fn);
      if (!meta) return false;
      if (meta.setter) return true;
      const names = new Set(Object.keys(scope));
      const types = new Set(['ArrowFunctionExpression', 'BlockStatement', 'ReturnStatement', 'ExpressionStatement', 'VariableDeclaration', 'VariableDeclarator', 'IfStatement', 'EmptyStatement', 'Literal', 'Identifier', 'ArrayExpression', 'ObjectExpression', 'Property', 'SpreadElement', 'MemberExpression', 'ConditionalExpression', 'LogicalExpression', 'UnaryExpression', 'BinaryExpression', 'TemplateLiteral', 'TemplateElement', 'CallExpression']);
      let count = 0;
      function walk(node, parent, key) {
        if (!node || typeof node !== 'object') return true;
        if (++count > 2000 || !types.has(node.type)) return false;
        if (node.type === 'ArrowFunctionExpression') for (const param of node.params) { if (param.type !== 'Identifier' || badKey(param.name)) return false; names.add(param.name); }
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') names.add(node.id.name);
        if (node.type === 'Identifier') {
          if (badKey(node.name)) return false;
          if (!(parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) && !(parent?.type === 'Property' && key === 'key' && !parent.computed) && !names.has(node.name)) return false;
        }
        for (const [childKey, child] of Object.entries(node)) {
          if (Array.isArray(child)) { for (const item of child) if (item && typeof item === 'object' && !walk(item, node, childKey)) return false; }
          else if (child && typeof child === 'object' && child.type && !walk(child, node, childKey)) return false;
        }
        return true;
      }
      return walk(meta.node, null, '');
    }
    function render(source) {
      handlers = new Map(); steps = 0; iterations = 0;
      const controls = [], env = record(); env.undefined = undefined;
      source = String(source ?? '').slice(0, MAX_SOURCE);
      // Mask body declarations before prose shielding: currency/backticks inside data are JS strings.
      const bodies = []; let prefix = '\uE310body:'; while (source.includes(prefix)) prefix += ':';
      let masked = '', cursor = 0;
      for (let at = source.indexOf('{@body'); at >= 0; at = source.indexOf('{@body', cursor)) {
        masked += source.slice(cursor, at); const end = braceEnd(source, at);
        bodies.push(source.slice(at, end < 0 ? source.length : end + 1)); masked += prefix + (bodies.length - 1) + '\uE311'; cursor = end < 0 ? source.length : end + 1;
      }
      masked += source.slice(cursor);
      const restoreBodies = text => text.replace(new RegExp(prefix + '(\\d+)\uE311', 'g'), (_, n) => bodies[n]);
      const safeEval = (text, scope) => evaluate(expression(text), scope);
      function tokens(text) {
        const result = []; let at = 0;
        while (at < text.length) {
          const next = text.indexOf('{', at);
          if (next < 0) { result.push({type: 'text', value: text.slice(at)}); break; }
          if (next > at) result.push({type: 'text', value: text.slice(at, next)});
          if (next > 0 && text[next - 1] === '\\') { result.push({type: 'text', value: '{'}); at = next + 1; continue; }
          const end = braceEnd(text, next);
          if (end < 0) { if (!/^\{(?:@(?:b(?:o(?:d(?:y)?)?)?)?|[#/:])/.test(text.slice(next))) result.push({type: 'text', value: text.slice(next)}); break; }
          result.push({type: 'brace', value: text.slice(next + 1, end)}); at = end + 1;
        }
        return result;
      }
      function renderParts(parts, scope, depth = 0) {
        tick(depth); let out = '';
        for (let i = 0; i < parts.length; i++) {
          tick(depth);
          const part = parts[i];
          if (part.type === 'text') { out += renderTags(part.value, scope, depth + 1); continue; }
          const value = part.value.trim();
          if (/^@body\b/.test(value)) {
            try { const ast = parse(value.replace(/^@body\b/, '')); for (const node of ast.body) { if (node.type !== 'VariableDeclaration') throw Error('Body accepts declarations'); declarations(node, scope, depth + 1); } } catch (_) {}
          } else if (/^#(?:each|if)\b/.test(value)) {
            const kind = value.startsWith('#each') ? 'each' : 'if'; let nesting = 1, stop = parts.length, alternate = -1;
            for (let j = i + 1; j < parts.length; j++) {
              if (parts[j].type !== 'brace') continue;
              const marker = parts[j].value.trim();
              if (/^#(?:each|if)\b/.test(marker)) nesting++;
              else if (/^\/(?:each|if)\b/.test(marker) && !--nesting) { stop = j; break; }
              else if (marker === ':else' && nesting === 1) alternate = j;
            }
            try {
              if (kind === 'each') {
                const match = /^#each\s+([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?$/.exec(value);
                if (match && !badKey(match[2]) && !badKey(match[3])) {
                  const items = safeEval(match[1], scope);
                  if (Array.isArray(items)) for (let j = 0; j < items.length; j++) { if (++iterations > MAX_ITEMS) throw Error('Iteration budget exceeded'); const local = Object.assign(record(), scope); local[match[2]] = items[j]; if (match[3]) local[match[3]] = j; out += renderParts(parts.slice(i + 1, alternate < 0 ? stop : alternate), local, depth + 1); if (out.length > MAX_SIZE) throw Error('Output too large'); }
                }
              } else { const yes = safeEval(value.slice(3), scope); out += renderParts(yes ? parts.slice(i + 1, alternate < 0 ? stop : alternate) : alternate < 0 ? [] : parts.slice(alternate + 1, stop), scope, depth + 1); }
            } catch (_) {}
            i = stop;
          } else if (!/^[/#:@]/.test(value)) { try { out += display(safeEval(value, scope)); } catch (_) { out += '{' + part.value + '}'; } }
          if (out.length > MAX_SIZE) return out.slice(0, MAX_SIZE);
        }
        return out.slice(0, MAX_SIZE);
      }
      function renderTags(text, scope, depth) {
        // Braced attributes must stay with their tag rather than becoming prose expressions.
        return text;
      }
      // Tags and their dynamic attributes are masked as atomic template tokens.
      function template(text) {
        const tags = []; let tagPrefix = '\uE320tag:'; while (text.includes(tagPrefix)) tagPrefix += ':';
        let output = '', at = 0;
        while (at < text.length) {
          if (text[at] === '{') { const end = braceEnd(text, at); output += text.slice(at, end < 0 ? text.length : end + 1); at = end < 0 ? text.length : end + 1; continue; }
          if (text[at] === '<' && (at === 0 || text[at - 1] !== '\\')) {
            const tag = tagAt(text, at);
            if (tag) { tags.push(tag); output += tagPrefix + (tags.length - 1) + '\uE321'; at = tag.end; continue; }
          }
          output += text[at++];
        }
        renderTags = function (chunk, scope, depth) {
          return chunk.replace(new RegExp(tagPrefix + '(\\d+)\uE321', 'g'), (_, n) => {
            const tag = tags[n]; if (tag.partial) return '';
            const attrs = record();
            for (const attr of tag.attrs) { try { attrs[attr.key] = attr.dynamic ? safeEval(attr.value, scope) : attr.value; } catch (_) {} }
            const name = tag.name.toLowerCase();
            if (/^(button|input|select|textarea|slider|checkbox|switch)$/.test(name) && !tag.close) {
              const id = 'q' + controls.length, safe = record();
              for (const key of ['type', 'value', 'checked', 'disabled', 'min', 'max', 'step', 'placeholder', 'name', 'multiple', 'required', 'aria-label']) if (own(attrs, key) && ['string', 'number', 'boolean'].includes(typeof attrs[key])) safe[key] = attrs[key];
              if (tag.attrs.some(attr => /^on/.test(attr.key)) && ![attrs.onclick, attrs.onchange, attrs.oninput].some(fn => validHandler(fn, scope))) safe.disabled = true;
              const descriptor = {id, tag: name, attrs: safe, label: '', options: []};
              controls.push(descriptor); handlers.set(id, {click: attrs.onclick, change: attrs.onchange ?? attrs.oninput, disabled: !!safe.disabled});
              return '\uE300' + id + '\uE301';
            }
            if (/^(button|select|textarea|slider|checkbox|switch)$/.test(name) && tag.close) return '</' + name + '>';
            const rendered = Object.entries(attrs).filter(([key, value]) => !/^on/i.test(key) && !badKey(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => value === true ? ' ' + key : value === false ? '' : ' ' + key + '="' + escape(value) + '"').join('');
            return '<' + (tag.close ? '/' : '') + tag.name + rendered + (tag.self ? '/>' : '>');
          });
        };
        return renderParts(tokens(output), env);
      }
      let text;
      try {
        text = window.QResponseTags.protect(masked, shielded => template(restoreBodies(shielded)));
        text = restoreBodies(text);
        // Consume labels only after expansion, allowing expressions/each inside a control.
        for (const control of controls) {
          const token = '\uE300' + control.id + '\uE301';
          if (['input', 'slider', 'checkbox', 'switch'].includes(control.tag)) continue;
          const start = text.indexOf(token), close = '</' + control.tag + '>', end = text.indexOf(close, start + token.length);
          if (start < 0) continue;
          const body = text.slice(start + token.length, end < 0 ? text.length : end);
          control.label = body.replace(/<[^>]*>/g, '').trim();
          if (control.tag === 'textarea' && !own(control.attrs, 'value')) control.attrs.value = control.label;
          if (control.tag === 'select') {
            const pattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi; let match;
            while ((match = pattern.exec(body))) { const option = tagAt('<option' + match[1] + '>', 0), data = record(); for (const attr of option?.attrs || []) data[attr.key] = attr.value; control.options.push({value: String(data.value ?? match[2].replace(/<[^>]*>/g, '').trim()), label: match[2].replace(/<[^>]*>/g, '').trim(), disabled: !!data.disabled, selected: !!data.selected}); }
          }
          text = text.slice(0, start + token.length) + (end < 0 ? '' : text.slice(end + close.length));
        }
      } catch (_) { text = ''; }
      return {text: text.slice(0, MAX_SIZE), controls};
    }
    function dispatch(id, value) {
      const handler = handlers.get(id); if (!handler || handler.disabled) return false;
      steps = 0; iterations = 0; changed = false;
      const fn = value === undefined ? handler.click : handler.change;
      if (!fn || !callables.has(fn)) return false;
      try {
        const meta = callables.get(fn), param = meta.node?.params[0];
        let argument = bounded(value);
        if (typeof argument !== 'string' && typeof argument !== 'boolean' && typeof argument !== 'number' && argument !== undefined) return false;
        if (param && /^(?:e|ev|event)$/.test(param.name)) { const target = record(); target.value = argument; target.checked = !!argument; argument = record(); argument.target = target; argument.currentTarget = target; }
        invoke(fn, [argument], 0);
      } catch (_) {}
      return changed;
    }
    return {render, dispatch};
  }
  window.QInteractive = {createSession};
})();
