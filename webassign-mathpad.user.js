// ==UserScript==
// @name         WebAssign MathPad Console
// @namespace    https://github.com/Serverside-swzo/webassign-mathpad
// @version      0.3.2
// @description  Type WebAssign MathType answers from the console (mp(2, "x^2")) and expose a local REST API through bridge.js
// @match        https://www.webassign.net/*
// @match        https://webassign.net/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

/*
 * Console usage (run mp.help() for the full syntax table):
 *   mp("x^2 + 1/2")          write into the selected box (last one you clicked)
 *   mp(2, "<2p, -3q>")       write into question 2 (first box)
 *   mp("8b", "sqrt(x+1)")    question 8, part b  (also "8.2")
 *   mp.append(2, "+ 5")      append to what's already there
 *   mp.clear(2)              empty the box
 *   mp.text(2)               read the box back as typeable text
 *   mp.boxes()               table of every math box on the page
 *   mp.parse("...")          show the MathML without writing anything
 *   mp.raw(2, "<math>...")   write raw MathML
 *   mp.open(2) / mp.close()  open / close the full pad
 *   mp.press("Fraction")     click a real toolbar button in the open pad
 *
 * The console helpers never submit anything. Submitting only happens through
 * the REST API (POST .../submit) when bridge.js is running — see README.md.
 */

(function () {
    'use strict';

    // Page globals (mathTypeEditor, MooTools, fetch) live on the real page window.
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const NS = 'http://www.w3.org/1998/Math/MathML';
    const EMPTY = `<math xmlns="${NS}"/>`;
    const BOX_ID_RE = /^R[A-Z]_\d+_(\d+)_(\d+)_\d+$/;

    // ---------------------------------------------------------------------------
    // Symbol tables — every entry mirrors the MathML the real pad buttons emit.
    // ---------------------------------------------------------------------------

    const TRIG = [
        'sin', 'cos', 'tan', 'csc', 'sec', 'cot',
        'arcsin', 'arccos', 'arctan', 'arccsc', 'arcsec', 'arccot',
        'sinh', 'cosh', 'tanh', 'csch', 'sech', 'coth',
        'arcsinh', 'arccosh', 'arctanh', 'arccsch', 'arcsech', 'arccoth',
    ];
    const TRIG_ALIAS = {
        asin: 'arcsin', acos: 'arccos', atan: 'arctan', acsc: 'arccsc', asec: 'arcsec', acot: 'arccot',
        asinh: 'arcsinh', acosh: 'arccosh', atanh: 'arctanh', acsch: 'arccsch', asech: 'arcsech', acoth: 'arccoth',
    };
    const LOGS = ['log', 'ln'];
    const SPECIAL_FUNCS = ['sqrt', 'cbrt', 'root', 'abs', 'exp', 'vec', 'hat', 'arrow'];

    // Lowercase greek -> <mi>, as the Greek tab emits. Note: pad "phi" is U+03D5.
    const GREEK_LOWER = {
        alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
        iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
        sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    };
    // Capital greek -> <mo>, as the Greek tab's "More" panel emits.
    const GREEK_UPPER = {
        Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ',
        Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ',
        Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
    };
    const CONST_WORDS = {
        inf: () => mo('∞'), infinity: () => mo('∞'), oo: () => mo('∞'),
        DNE: () => mtext('DNE'),
        undefined: () => mtext('UNDEFINED'), UNDEFINED: () => mtext('UNDEFINED'),
        nosolution: () => mtext('NO SOLUTION'), NOSOLUTION: () => mtext('NO SOLUTION'),
        empty: () => mo('∅'), emptyset: () => mo('∅'),
        deg: () => mo('°'),
        hbar: () => mi('ℏ'),
    };
    const INFIX_WORDS = { union: '∪', cup: '∪', intersect: '∩', cap: '∩' };

    // `#name` escapes for buttons that have no natural typed form.
    const HASH = {
        i: () => mi('\u{1D5F6}'), j: () => mi('\u{1D5F7}'), k: () => mi('\u{1D5F8}'), // Vectors tab bold i/j/k
        im: () => mi('i', ' mathvariant="normal"'),                                   // "Imaginary number i"
        deg: () => mo('°'), empty: () => mo('∅'), inf: () => mo('∞'), pi: () => mi('π'),
        dne: () => mtext('DNE'), undef: () => mtext('UNDEFINED'), nosol: () => mtext('NO SOLUTION'),
    };

    // Infix operators (output as a flat <mo>). Values are what the pad emits.
    const INFIX = {
        '+': '+', '-': '-', '−': '-', '=': '=', '<': '<', '>': '>',
        '<=': '≤', '≤': '≤', '>=': '≥', '≥': '≥', '!=': '≠', '≠': '≠',
        ',': ',', ';': ';', ':': ':', '->': '→', '→': '→', '÷': '÷',
        '∪': '∪', '∩': '∩', '⇀': '⇀', '⇌': '⇌', '←': '←',
    };
    const TIMES = ['*', '⋅', '·', '×', '.'];
    // Single unicode characters that act as a value.
    const SYMBOL_CHARS = { 'π': () => mi('π'), '∞': () => mo('∞'), '°': () => mo('°'), '∅': () => mo('∅'), 'ℏ': () => mi('ℏ') };

    const WORDS = [
        ...TRIG, ...Object.keys(TRIG_ALIAS), ...LOGS, ...SPECIAL_FUNCS,
        ...Object.keys(GREEK_LOWER), ...Object.keys(GREEK_UPPER), ...Object.keys(CONST_WORDS), ...Object.keys(INFIX_WORDS),
    ].sort((a, b) => b.length - a.length);

    // ---------------------------------------------------------------------------
    // MathML node helpers. A node is { x: xml, multi?: bool, paren?: node }.
    // `multi` means x is several sibling elements (needs <mrow> inside a slot);
    // `paren` is set on plain (...) groups so they can be unwrapped in / ^ _ sqrt.
    // ---------------------------------------------------------------------------

    const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const enc = (s) => [...s].map((c) => (c.codePointAt(0) > 126
        ? `&#x${c.codePointAt(0).toString(16).toUpperCase()};` : escXml(c))).join('');

    const mi = (s, attrs = '') => ({ x: `<mi${attrs}>${enc(s)}</mi>` });
    const mo = (s) => ({ x: `<mo>${enc(s)}</mo>`, op: s });
    const mtext = (s) => ({ x: `<mtext>${enc(s)}</mtext>` });
    const xmlOf = (nodes) => nodes.map((n) => n.x).join('');
    const group = (nodes) => (nodes.length === 1 ? nodes[0] : { x: xmlOf(nodes), multi: nodes.length > 1 });
    const slot = (n) => (n.multi ? `<mrow>${n.x}</mrow>` : (n.x || '<mrow/>'));
    const row = (n) => (n.x ? `<mrow>${n.x}</mrow>` : '<mrow/>');
    const strip = (n) => n.paren || n;
    const concat = (...ns) => ({ x: ns.map((n) => n.x).join(''), multi: true });

    function number(v) {
        // The pad splits typed decimals: 12.5 -> <mn>12</mn><mo>.</mo><mn>5</mn>
        const out = [];
        v.split(/(\.)/).forEach((p) => {
            if (p === '.') out.push(mo('.'));
            else if (p) out.push({ x: `<mn>${p}</mn>` });
        });
        return group(out);
    }

    // ---------------------------------------------------------------------------
    // Tokenizer
    // ---------------------------------------------------------------------------

    const TWO_CHAR = ['<=', '>=', '!=', '->', '**'];

    function splitWord(run) {
        const out = [];
        let i = 0;
        while (i < run.length) {
            const w = WORDS.find((word) => run.startsWith(word, i));
            if (w) { out.push({ k: 'word', v: w }); i += w.length; }
            else { out.push({ k: 'letter', v: run[i] }); i += 1; }
        }
        return out;
    }

    function tokenize(src) {
        const t = [];
        let i = 0;
        while (i < src.length) {
            const c = String.fromCodePoint(src.codePointAt(i));
            if (/\s/.test(c)) { i += c.length; continue; }
            if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
                let j = i;
                while (j < src.length && /[0-9.]/.test(src[j])) j++;
                t.push({ k: 'num', v: src.slice(i, j) });
                i = j;
                continue;
            }
            if (/[A-Za-z]/.test(c)) {
                let j = i;
                while (j < src.length && /[A-Za-z]/.test(src[j])) j++;
                t.push(...splitWord(src.slice(i, j)));
                i = j;
                continue;
            }
            if (c === '"') {
                const j = src.indexOf('"', i + 1);
                if (j < 0) throw new SyntaxError('Unclosed "text"');
                t.push({ k: 'text', v: src.slice(i + 1, j) });
                i = j + 1;
                continue;
            }
            if (c === '#') {
                let j = i + 1;
                while (j < src.length && /[A-Za-z]/.test(src[j])) j++;
                t.push({ k: 'hash', v: src.slice(i + 1, j) });
                i = j;
                continue;
            }
            const two = src.slice(i, i + 2);
            if (TWO_CHAR.includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
            t.push({ k: 'op', v: c });
            i += c.length;
        }
        return t;
    }

    // ---------------------------------------------------------------------------
    // Parser: text -> MathML body (without the <math> wrapper)
    // ---------------------------------------------------------------------------

    function parse(src) {
        const toks = tokenize(String(src));
        let pos = 0;
        const peek = () => toks[pos];
        const next = () => toks[pos++];
        const isOp = (tk, v) => tk && tk.k === 'op' && tk.v === v;
        const fail = (msg) => { throw new SyntaxError(`${msg} (at token ${pos + 1} of "${src}")`); };
        const expect = (v) => { if (!isOp(peek(), v)) fail(`Expected "${v}"`); next(); };

        // Flat sequence of runs separated by infix operators, until a closer.
        function parseSeq(closers) {
            const out = [];
            let operandPos = true;
            for (;;) {
                const tk = peek();
                if (!tk) {
                    if (closers.length) fail(`Missing closing ${closers.join(' or ')}`);
                    break;
                }
                if (tk.k === 'op') {
                    if (tk.v === '>=' && closers.includes('>')) {
                        // "<a,b>=c": split into closing ">" and "="
                        toks.splice(pos, 1, { k: 'op', v: '>' }, { k: 'op', v: '=' });
                        break;
                    }
                    if (closers.includes(tk.v) && !(operandPos && tk.v === '|')) break;
                    if (')]}⟩'.includes(tk.v)) fail(`Unexpected "${tk.v}"`);
                    if (INFIX[tk.v] && !(operandPos && tk.v === '<')) {
                        next();
                        out.push(mo(INFIX[tk.v]));
                        operandPos = true;
                        continue;
                    }
                }
                if (tk.k === 'word' && INFIX_WORDS[tk.v]) {
                    next();
                    out.push(mo(INFIX_WORDS[tk.v]));
                    operandPos = true;
                    continue;
                }
                const run = parseRun(closers);
                if (!run.length) fail(`Unexpected "${tk.v}"`);
                out.push(...run);
                operandPos = false;
            }
            return out;
        }

        // A run of factors joined by implicit/explicit multiplication and "/".
        // "/" takes everything in the run so far as numerator and one factor as
        // denominator, which matches left-to-right evaluation: 1/2x = (1/2)x.
        function parseRun(closers) {
            let run = [];
            for (;;) {
                const tk = peek();
                if (!tk) break;
                if (tk.k === 'op') {
                    if (TIMES.includes(tk.v)) {
                        if (!run.length) fail(`Nothing before "${tk.v}"`);
                        next();
                        run.push(mo('⋅'));
                        continue;
                    }
                    if (tk.v === '/') {
                        if (!run.length) fail('Nothing before "/"');
                        next();
                        const num = strip(group(run));
                        const den = strip(parseSigned(closers));
                        run = [{ x: `<mfrac>${slot(num)}${slot(den)}</mfrac>` }];
                        continue;
                    }
                    const afterTimes = !run.length || run[run.length - 1].op === '⋅';
                    if (!startsFactor(tk, closers, afterTimes)) break;
                } else if (tk.k === 'word' && INFIX_WORDS[tk.v]) {
                    break;
                }
                run.push(parsePostfix(closers));
            }
            return run;
        }

        function startsFactor(tk, closers, atStart) {
            const v = tk.v;
            if ('([{⟨√'.includes(v)) return true;
            if (v === '|') return !closers.includes('|');
            if (v === '<') return atStart;
            if (SYMBOL_CHARS[v]) return true;
            return /\p{L}/u.test(v);
        }

        function parseSigned(closers) {
            const tk = peek();
            if (isOp(tk, '-') || isOp(tk, '+') || isOp(tk, '−')) {
                next();
                return concat(mo(tk.v === '+' ? '+' : '-'), parsePostfix(closers));
            }
            return parsePostfix(closers);
        }

        function scripts() {
            let sub = null;
            let sup = null;
            for (;;) {
                const tk = peek();
                if (isOp(tk, '_') && !sub) { next(); sub = parseScript(false); continue; }
                if ((isOp(tk, '^') || isOp(tk, '**')) && !sup) { next(); sup = parseScript(true); continue; }
                return { sub, sup };
            }
        }

        function attach(base, { sub, sup }) {
            if (sub && sup) return { x: `<msubsup>${slot(base)}${slot(sub)}${slot(sup)}</msubsup>` };
            if (sub) return { x: `<msub>${slot(base)}${slot(sub)}</msub>` };
            if (sup) return { x: `<msup>${slot(base)}${slot(sup)}</msup>` };
            return base;
        }

        function parsePostfix(closers) {
            let base = attach(parseAtom(closers), scripts());
            while (isOp(peek(), '!') || isOp(peek(), "'")) base = concat(base, mo(next().v));
            return base;
        }

        // Exponent / subscript: a (group), or [sign] atom, with right-assoc ^.
        function parseScript(isSup) {
            let sign = null;
            if (isOp(peek(), '-') || isOp(peek(), '+') || isOp(peek(), '−')) sign = next().v === '+' ? '+' : '-';
            let a = strip(parseAtom([]));
            if (isSup && (isOp(peek(), '^') || isOp(peek(), '**'))) {
                next();
                a = { x: `<msup>${slot(a)}${slot(parseScript(true))}</msup>` };
            }
            return sign ? concat(mo(sign), a) : a;
        }

        function fence(open, closers) {
            const nodes = parseSeq(closers);
            const close = next().v;
            const inner = group(nodes);
            const body = row(inner);
            const pair = open + close;
            const attrs = {
                '()': '',
                '(]': ' close="]" separators=""',
                '[]': ' open="[" close="]"',
                '[)': ' open="[" separators=""',
                '{}': ' open="{" close="}"',
                '<>': ' open="&lt;" close="&gt;"', '<⟩': ' open="&lt;" close="&gt;"',
                '⟨>': ' open="&lt;" close="&gt;"', '⟨⟩': ' open="&lt;" close="&gt;"',
                '||': ' open="|" close="|"',
            }[pair];
            const node = { x: `<mfenced${attrs}>${body}</mfenced>` };
            if (pair === '()') node.paren = nodes.length ? inner : { x: '' };
            return node;
        }

        // Argument of a function: (…) contents, or a single factor.
        function fnArg(closers) {
            if (isOp(peek(), '(')) {
                next();
                const nodes = parseSeq([')']);
                expect(')');
                return group(nodes);
            }
            return strip(parsePostfix(closers));
        }

        function splitArgs(nodes) {
            const args = [[]];
            nodes.forEach((n) => (n.op === ',' ? args.push([]) : args[args.length - 1].push(n)));
            return args.map(group);
        }

        function word(w, closers) {
            const name = TRIG_ALIAS[w] || w;
            if (TRIG.includes(name) || LOGS.includes(name)) {
                const head = attach(mi(name), scripts());
                const arg = fnArg(closers);
                const attrs = TRIG.includes(name) ? ' separators=""' : '';
                return concat(head, { x: `<mfenced${attrs}>${row(arg)}</mfenced>` });
            }
            switch (name) {
                case 'sqrt': {
                    const a = fnArg(closers);
                    return { x: a.x ? `<msqrt>${a.x}</msqrt>` : '<msqrt/>' };
                }
                case 'cbrt':
                    return { x: `<mroot>${slot(fnArg(closers))}<mn>3</mn></mroot>` };
                case 'root': {
                    expect('(');
                    const args = splitArgs(parseSeq([')']));
                    expect(')');
                    if (args.length === 2) return { x: `<mroot>${slot(args[1])}${slot(args[0])}</mroot>` };
                    if (args.length === 1 && isOp(peek(), '(')) {
                        // root(n)(x)
                        return { x: `<mroot>${slot(fnArg(closers))}${slot(args[0])}</mroot>` };
                    }
                    if (args.length === 1) return { x: `<msqrt>${args[0].x}</msqrt>` };
                    return fail('root takes (index, radicand)');
                }
                case 'abs':
                    return { x: `<mfenced open="|" close="|">${row(fnArg(closers))}</mfenced>` };
                case 'exp':
                    return { x: `<msup><mi>e</mi>${slot(fnArg(closers))}</msup>` };
                case 'vec':
                    return { x: `<mover>${slot(fnArg(closers))}<mo>&#x21C0;</mo></mover>` };
                case 'arrow':
                    return { x: `<mover>${slot(fnArg(closers))}<mo>&#x2192;</mo></mover>` };
                case 'hat':
                    return { x: `<mover>${slot(fnArg(closers))}<mo>^</mo></mover>` };
                default:
            }
            if (GREEK_LOWER[name]) return mi(GREEK_LOWER[name]);
            if (GREEK_UPPER[name]) return mo(GREEK_UPPER[name]);
            if (CONST_WORDS[name]) return CONST_WORDS[name]();
            return fail(`Unknown word "${w}"`);
        }

        function parseAtom(closers) {
            const tk = next();
            if (!tk) return fail('Unexpected end of input');
            switch (tk.k) {
                case 'num': return number(tk.v);
                case 'letter': return mi(tk.v);
                case 'text': return mtext(tk.v);
                case 'hash':
                    if (!HASH[tk.v]) fail(`Unknown #${tk.v} (have: ${Object.keys(HASH).map((k) => '#' + k).join(' ')})`);
                    return HASH[tk.v]();
                case 'word': return word(tk.v, closers);
                default:
            }
            const v = tk.v;
            if (v === '(') return fence('(', [')', ']']);
            if (v === '[') return fence('[', [']', ')']);
            if (v === '{') return fence('{', ['}']);
            if (v === '<' || v === '⟨') return fence(v, ['>', '⟩']);
            if (v === '|') return fence('|', ['|']);
            if (v === '√') {
                const a = strip(parsePostfix(closers));
                return { x: `<msqrt>${a.x}</msqrt>` };
            }
            if (SYMBOL_CHARS[v]) return SYMBOL_CHARS[v]();
            if (/[Α-Ω]/.test(v)) return mo(v);
            if (/\p{L}/u.test(v)) return mi(v);
            return fail(`Unexpected "${v}"`);
        }

        const out = parseSeq([]);
        return xmlOf(out);
    }

    // ---------------------------------------------------------------------------
    // MathML -> typeable text (for reading answers back)
    // ---------------------------------------------------------------------------

    const REV_MO = { '⋅': '*', '≤': '<=', '≥': '>=', '≠': '!=', '→': '->', '∞': 'inf', '∅': 'empty', '°': 'deg', '∪': ' union ', '∩': ' intersect ', '÷': '÷' };
    const REV_MI = Object.assign(
        { '\u{1D5F6}': '#i', '\u{1D5F7}': '#j', '\u{1D5F8}': '#k', 'ℏ': 'hbar' },
        ...Object.entries(GREEK_LOWER).map(([k, v]) => ({ [v]: k })),
        ...Object.entries(GREEK_UPPER).map(([k, v]) => ({ [v]: k })),
    );
    const REV_TEXT = { DNE: 'DNE', UNDEFINED: 'undefined', 'NO SOLUTION': 'nosolution' };

    function toText(mathml) {
        const doc = new DOMParser().parseFromString(mathml || EMPTY, 'application/xml');
        const kids = (n) => [...n.children];
        const atomic = (n) => ['mi', 'mn', 'mo', 'mtext', 'mfenced', 'msqrt', 'mroot'].includes(n.localName)
            || (n.localName === 'mrow' && n.children.length === 1 && atomic(n.children[0]));
        const wrap = (n) => (atomic(n) ? tt(n) : `(${tt(n)})`);
        function tt(n) {
            const k = kids(n);
            const all = () => k.map(tt).join('');
            const txt = n.textContent;
            switch (n.localName) {
                case 'math': case 'mrow': case 'maction': case 'mstyle': return all();
                case 'mn': return txt;
                case 'mi':
                    if (n.getAttribute('mathvariant') === 'normal' && txt === 'i') return '#im';
                    return REV_MI[txt] || txt;
                case 'mo': return REV_MO[txt] || REV_MI[txt] || (txt === ',' ? ', ' : txt);
                case 'mtext': return REV_TEXT[txt] || `"${txt}"`;
                case 'mfrac': return `${wrap(k[0])}/${wrap(k[1])}`;
                case 'msup': return `${wrap(k[0])}^${wrap(k[1])}`;
                case 'msub': return `${wrap(k[0])}_${wrap(k[1])}`;
                case 'msubsup': return `${wrap(k[0])}_${wrap(k[1])}^${wrap(k[2])}`;
                case 'msqrt': return `sqrt(${all()})`;
                case 'mroot': return `root(${tt(k[1])}, ${tt(k[0])})`;
                case 'mover': {
                    const acc = k[1] ? k[1].textContent : '';
                    const fn = { '⇀': 'vec', '→': 'arrow', '^': 'hat' }[acc] || 'vec';
                    return `${fn}(${tt(k[0])})`;
                }
                case 'mfenced': {
                    let open = n.hasAttribute('open') ? n.getAttribute('open') : '(';
                    let close = n.hasAttribute('close') ? n.getAttribute('close') : ')';
                    if (open === '<') { open = '<'; close = '>'; }
                    return `${open}${all()}${close}`;
                }
                default: return all();
            }
        }
        return tt(doc.documentElement).replace(/\s+/g, ' ').trim();
    }

    // ---------------------------------------------------------------------------
    // Page integration
    // ---------------------------------------------------------------------------

    let current = null;

    function boxes() {
        return [...document.querySelectorAll('[id^="editable-math-"][data-boxid]')].map((div) => {
            const id = div.dataset.boxid;
            const m = id.match(BOX_ID_RE);
            return {
                id,
                q: m ? Number(m[1]) + 1 : null,
                part: m ? Number(m[2]) + 1 : null,
                type: div.dataset.type,
                div,
                disabled: div.classList.contains('mtDisabled'),
            };
        });
    }

    function trackSelection(e) {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const box = t.closest('[id^="editable-math-"][data-boxid]');
        const overlay = t.closest('#mathtype-overlay');
        if (box) current = box.dataset.boxid;
        else if (overlay && overlay.dataset.boxid) current = overlay.dataset.boxid;
    }
    document.addEventListener('click', trackSelection, true);
    document.addEventListener('focusin', trackSelection, true);

    function resolve(target) {
        const all = boxes();
        if (!all.length) throw new Error('No MathType answer boxes on this page.');
        let box;
        if (target == null) {
            const overlay = document.querySelector('#mathtype-overlay.is-open');
            const open = document.querySelector('.mathtype.mtOpen');
            const id = (overlay && overlay.dataset.boxid) || (open && open.dataset.boxid) || current;
            box = id ? all.find((b) => b.id === id) : (all.length === 1 ? all[0] : null);
            if (!box) throw new Error('No box selected. Click a box first, or pass a question: mp(2, "...")');
        } else if (typeof target === 'number') {
            box = all.find((b) => b.q === target);
        } else {
            const s = String(target).trim();
            const m = s.match(/^(\d+)\s*[.\-:]?\s*(\d+|[a-z])?$/i);
            if (m) {
                const q = Number(m[1]);
                const part = m[2] == null ? 1 : (/\d/.test(m[2]) ? Number(m[2]) : m[2].toLowerCase().charCodeAt(0) - 96);
                box = all.find((b) => b.q === q && b.part === part);
            } else {
                box = all.find((b) => b.id === s || b.div.id === s);
            }
        }
        if (!box) throw new Error(`No math box for ${JSON.stringify(target)}. See mp.boxes().`);
        return box;
    }

    const label = (box) => `Q${box.q}${box.part > 1 || boxes().filter((b) => b.q === box.q).length > 1 ? String.fromCharCode(96 + box.part) : ''}`;

    function editorFor(box) {
        const ed = W.mathTypeEditor && W.mathTypeEditor[box.type];
        if (!ed) throw new Error(`MathType editor "${box.type}" is not loaded yet.`);
        return ed;
    }

    async function write(box, body) {
        if (box.disabled) throw new Error(`${label(box)} is disabled (no submissions left or locked).`);
        const full = body ? `<math xmlns="${NS}">${body}</math>` : EMPTY;
        const field = document.getElementById(box.id);
        const ov = W.mathTypeOverlay;
        const overlayEl = document.getElementById('mathtype-overlay');
        const inOverlay = ov && ov.isActive() && overlayEl && overlayEl.dataset.boxid === box.id;
        const inline = box.div.classList.contains('mtOpen');

        if (inOverlay || inline) {
            const ed = editorFor(box);
            await new Promise((r) => ed.setMathMLWithCallback(full, r));
            if (inOverlay) {
                ov.syncAnswerValue(box.id);
                ov.queuePreview(box.id);
            } else {
                field.value = ed.getMathML() || full;
                if (typeof W.warnInvalidMathTypeCharacters === 'function') W.warnInvalidMathTypeCharacters(box.id);
            }
        } else {
            field.value = full;
            if (ov) {
                ov.renderPreview(box.id);
            } else {
                const clean = W.mathTypeEditor ? W.mathTypeEditor.cleanMathMLForMathJax(full) : full;
                box.div.innerHTML = `<span class="mtAnswer">${clean}</span>`;
                if (typeof W.reparseMathJaxForMathtypeAnswer === 'function') W.reparseMathJaxForMathtypeAnswer(box.div.id, 'Typeset');
            }
            if (typeof W.warnInvalidMathTypeCharacters === 'function') W.warnInvalidMathTypeCharacters(box.id);
        }
        // WebAssign loads MooTools, which replaces window.Event, so build events the old way.
        ['input', 'change'].forEach((type) => {
            const ev = document.createEvent('HTMLEvents');
            ev.initEvent(type, true, false);
            field.dispatchEvent(ev);
        });

        if (typeof W.checkForInvalidMathTypeCharacters === 'function') {
            const bad = W.checkForInvalidMathTypeCharacters(field.value);
            if (bad) console.warn(`[mp] ${label(box)}: ${bad} character(s) WebAssign can't grade.`);
        }
        current = box.id;
        return field.value;
    }

    const bodyOf = (mathml) => (mathml || '').replace(/^<math[^>]*\/>$/, '').replace(/^<math[^>]*>/, '').replace(/<\/math>$/, '');

    // ---------------------------------------------------------------------------
    // Console API
    // ---------------------------------------------------------------------------

    async function mp(a, b) {
        return b === undefined ? mp.set(undefined, a) : mp.set(a, b);
    }

    mp.set = async (target, expr) => {
        const body = parse(expr);
        const box = resolve(target);
        await write(box, body);
        const msg = `${label(box)} ← ${toText(document.getElementById(box.id).value)}`;
        console.log(`[mp] ${msg}`);
        return msg;
    };

    mp.append = async (target, expr) => {
        if (expr === undefined) [target, expr] = [undefined, target];
        const box = resolve(target);
        await write(box, bodyOf(document.getElementById(box.id).value) + parse(expr));
        return `${label(box)} ← ${mp.text(box.id)}`;
    };

    mp.raw = async (target, mathml) => {
        if (mathml === undefined) [target, mathml] = [undefined, target];
        const box = resolve(target);
        await write(box, bodyOf(mathml.trim()));
        return mp.get(box.id);
    };

    mp.clear = async (target) => {
        const box = resolve(target);
        await write(box, '');
        return `${label(box)} cleared`;
    };

    mp.get = (target) => document.getElementById(resolve(target).id).value;
    mp.text = (target) => toText(mp.get(target));
    mp.parse = (expr) => `<math xmlns="${NS}">${parse(expr)}</math>`;
    mp.toText = toText;

    mp.select = (target) => {
        const box = resolve(target);
        current = box.id;
        return `${label(box)} selected`;
    };

    mp.boxes = () => {
        const rows = boxes().map((b) => ({
            box: label(b),
            q: b.q,
            part: b.part,
            selected: b.id === current ? '◀' : '',
            disabled: b.disabled,
            value: toText(document.getElementById(b.id).value),
            id: b.id,
        }));
        console.table(rows);
        return rows;
    };

    mp.open = async (target) => {
        const box = resolve(target);
        current = box.id;
        await W.mathTypeOverlay.open(box.id);
        return `${label(box)} pad open`;
    };

    mp.close = async () => {
        if (W.mathTypeOverlay && W.mathTypeOverlay.isActive()) await W.mathTypeOverlay.close({ restoreFocus: false });
        const open = document.querySelector('.mathtype.mtOpen');
        if (open) await new Promise((r) => W.destroyMathTypeEditor(open.dataset.boxid, r));
        return 'closed';
    };

    function activeEditorRoot() {
        return document.querySelector('#mathtype-overlay.is-open .mathtype-overlay-editor')
            || document.querySelector('#mathtype-overlay.is-open')
            || document.querySelector('.mathtype.mtOpen');
    }
    const btnLabel = (b) => b.getAttribute('aria-label') || b.title || b.textContent.trim();

    mp.buttons = () => {
        const root = activeEditorRoot();
        if (!root) throw new Error('Open a pad first: mp.open(2) or click a box.');
        return [...root.querySelectorAll('button')].map(btnLabel).filter(Boolean);
    };

    mp.press = (name) => {
        const root = activeEditorRoot();
        if (!root) throw new Error('Open a pad first: mp.open(2) or click a box.');
        const want = name.toLowerCase();
        const all = [...root.querySelectorAll('button')];
        const b = all.find((x) => btnLabel(x).toLowerCase() === want)
            || all.find((x) => btnLabel(x).toLowerCase().startsWith(want));
        if (!b) throw new Error(`No button "${name}". See mp.buttons().`);
        b.click();
        return btnLabel(b);
    };

    mp.help = () => {
        console.log(`%cWebAssign MathPad console`, 'font-weight:bold;font-size:14px');
        console.log(`Commands:
  mp("expr")              write into selected box (last clicked / open pad)
  mp(2, "expr")           question 2 (first part);  mp("8b", …) or mp("8.2", …) for parts
  mp.append([t,] "expr")  add to the end      mp.clear(t)    empty a box
  mp.text(t) / mp.get(t)  read back text / MathML
  mp.parse("expr")        preview MathML only mp.raw(t, mathml)
  mp.boxes()              list boxes           mp.select(t)   choose default box
  mp.open(t) / mp.close() full pad             mp.press("Fraction") click a pad button
Nothing is ever submitted — use the page's Submit button yourself.`);
        console.table([
            ['a/b, (x+1)/(x-1)', 'Fraction — numerator is the whole product before /, denominator one factor: 1/2x = (1/2)x, use 1/(2x)'],
            ['x^2, e^(2x), x^-1, x^2^3', 'Superscript (use parens for more than one factor)'],
            ['x_1, x_(n+1), x_1^2', 'Subscript / sub+superscript'],
            ['sqrt(x), √x, cbrt(x), root(n, x)', 'Square root, cube root, nth root'],
            ['sin(x) … coth(x), arcsin/asin …, sin^2(x)', 'Trig tab (all 24 + More); function power'],
            ['ln(x), log(x), log_2(x), exp(x)', 'Logs, log base n, e^x'],
            ['(a), [a], {a}, |x|, abs(x)', 'Parentheses, square brackets, curly, vertical bars'],
            ['(a, b], [a, b)', 'Half-open intervals'],
            ['<1, 2, 3>, ⟨a, b⟩', 'Angle brackets (vectors)'],
            ['vec(v), arrow(AB), hat(u)', 'Vector (harpoon), arrow and hat accents'],
            ['#i #j #k', 'Bold unit vectors'],
            ['*  (also ⋅ · ×)', 'Multiplication dot'],
            ['÷  <  >  <=  >=  !=  ->', 'Division sign, relations, arrow'],
            ['union / cup, intersect / cap', 'Set operators'],
            ['pi, inf / oo, deg, empty, #im', 'π, ∞, °, ∅, imaginary i (button form)'],
            ['DNE, undefined, nosolution', 'Other tab text answers'],
            ['alpha … omega, phi, varphi, Delta …', 'Greek (capitals like the pad)'],
            ['n!', 'Factorial'],
            ['"text"', 'Plain text'],
        ].map(([syntax, meaning]) => ({ syntax, meaning })));
        return 'mp ready';
    };

    W.mp = mp;
    console.log('[mp] WebAssign MathPad console loaded — type mp.help()');

    // ===========================================================================
    // REST bridge: bridge.js queues jobs, this tab runs them with the logged-in
    // session (same-origin fetch) and posts the results back.
    // ===========================================================================

    const BRIDGE = 'http://127.0.0.1:8787';
    // Reported to the bridge so clients can tell when this script is outdated.
    const SCRIPT_VERSION = '0.3.2';
    const BOX_RE = /^RP?([A-Z])_(\d+)_(\d+)_(\d+)_(\d+)$/;
    const BOX_TYPES = {
        A: 'answer', B: 'matrix', C: 'choice', E: 'essay', F: 'file', G: 'graph', I: 'image', J: 'applet',
        L: 'pencilpad', M: 'multiselect', N: 'number', Q: 'answer', R: 'numberline', S: 'checkboxes',
    };

    const httpError = (status, message) => Object.assign(new Error(message), { status });
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    async function waFetch(path, opts = {}) {
        let r;
        try {
            r = await W.fetch(path, { credentials: 'include', ...opts });
        } catch (e) {
            // Cross-origin redirects (e.g. to the Cengage login) surface as a network error.
            throw httpError(401, `WebAssign request failed (${e.message}). Is the session still logged in?`);
        }
        const url = new URL(r.url);
        if (!/(^|\.)webassign\.net$/.test(url.hostname) || /login/i.test(url.pathname)) {
            throw httpError(401, 'WebAssign session expired. Log in again in the browser.');
        }
        if (!r.ok) throw httpError(r.status, `WebAssign returned HTTP ${r.status} for ${path}`);
        return r;
    }

    async function getDoc(path, opts) {
        const r = await waFetch(path, opts);
        return new DOMParser().parseFromString(await r.text(), 'text/html');
    }

    // ---------------------------------------------------------------------------
    // Courses & assignment lists
    // ---------------------------------------------------------------------------

    async function listCourses() {
        const doc = await getDoc('/v4cgi/student.pl');
        const top = doc.getElementById('js-page-top');
        if (!top) throw httpError(502, 'Could not find the course list on the WebAssign home page.');
        const courses = JSON.parse(top.getAttribute('data-courses') || '{}');
        const selected = top.getAttribute('data-current-selected');
        return Object.entries(courses).map(([key, c]) => ({
            id: key,
            courseId: key.split(',')[0],
            sectionId: key.split(',')[1],
            course: c.course,
            section: c.section,
            term: c.term,
            current: key === selected,
        }));
    }

    function mapAssignment(a, past) {
        const s = a.score || {};
        return {
            id: Number(a.id),
            assignmentId: a.assignmentId,
            name: a.name,
            category: a.category,
            due: a.due,
            past,
            score: s.score === undefined || s.score === 'NS' ? null : Number(s.score),
            total: s.total === undefined ? null : Number(s.total),
            percentage: s.percentage === undefined ? null : Number(s.percentage),
            submitted: s.score !== undefined && s.score !== 'NS',
            extended: Boolean(a.isExtended),
            excused: Boolean(a.isExcused),
            restrictions: a.restrictions || {},
        };
    }

    async function listAssignments({ section, course } = {}) {
        let sectionId = section;
        if (!sectionId && course) sectionId = String(course).split(',')[1];
        if (!sectionId) {
            const cur = (await listCourses()).find((c) => c.current);
            if (!cur) throw httpError(400, 'No current course; pass ?section=<sectionId> (see GET /api/courses).');
            sectionId = cur.sectionId;
        }
        const r = await waFetch(`/web/bff/section/${encodeURIComponent(sectionId)}/assignments`, {
            headers: { Accept: 'application/json' },
        });
        const json = await r.json();
        const d = json.data || {};
        return {
            sectionId: String(sectionId),
            current: (d.currentAssignments || []).map((a) => mapAssignment(a, false)),
            past: (d.pastAssignments || []).map((a) => mapAssignment(a, true)),
        };
    }

    // ---------------------------------------------------------------------------
    // Assignment page parsing
    // ---------------------------------------------------------------------------

    const PAREN_IMG = { angle: ['⟨', '⟩'], paren: ['(', ')'], bracket: ['[', ']'], brace: ['{', '}'], bar: ['|', '|'], vert: ['|', '|'], floor: ['⌊', '⌋'], ceil: ['⌈', '⌉'] };
    const RESOURCE_LINE = /^((Read It|Watch It|Master It|Tutorial|eBook|Resources)\s*\d*\s*)+$/i;
    const BLOCK = new Set(['DIV', 'P', 'BR', 'TR', 'LI', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'HR']);

    // Label markup for a choice (may contain images or math), sanitized.
    function labelHtml(input, doc) {
        const lbl = (input.id && doc.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest('label');
        if (!lbl) return null;
        const c = lbl.cloneNode(true);
        c.querySelectorAll('input').forEach((e) => e.remove());
        sanitizeTree(c);
        return c.innerHTML.trim();
    }

    function labelFor(input, doc) {
        const lbl = (input.id && doc.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest('label');
        return clean((lbl || input.parentElement || {}).textContent);
    }

    function parseBox(id, qEl, doc, parts) {
        const m = id.match(BOX_RE);
        if (!m) return null;
        const [, type, , pos, boxNum] = m;
        const named = [...qEl.querySelectorAll(`[name="${id}"]`)];
        if (!named.length) return null;
        const settingsEl = doc.getElementById(`${id}_settings`);
        let settings = {};
        try { settings = settingsEl ? JSON.parse(settingsEl.value) : {}; } catch (e) { /* keep {} */ }

        let kind;
        let value = '';
        let choices = null;
        let display = null; // how WebAssign shows it: dropdown | radio | checkbox
        if (settings.mathtype) {
            kind = 'math';
            value = named[0].value;
            if (!value) {
                // Closed/answered boxes render their answer in .mtAnswer rather
                // than keeping it in the input; recover the MathML from there.
                const ans = qEl.querySelector(`#editable-math-${CSS.escape(id)} .mtAnswer math`);
                if (ans) value = ans.outerHTML;
            }
        } else if (type === 'C' && settings.pulldown) {
            kind = 'choice';
            display = 'dropdown';
            const sel = named.find((e) => e.tagName === 'SELECT');
            choices = [...sel.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, label: clean(o.textContent) }));
            const opt = [...sel.options].find((o) => o.hasAttribute('selected'));
            value = opt ? opt.value : '';
        } else if (type === 'C' || type === 'S') {
            kind = type === 'C' ? 'choice' : 'checkboxes';
            display = type === 'C' ? 'radio' : 'checkbox';
            const inputs = named.filter((e) => e.type === 'radio' || e.type === 'checkbox');
            choices = inputs.map((e) => ({ value: e.value, label: labelFor(e, doc), html: labelHtml(e, doc) }));
            value = inputs.filter((e) => e.hasAttribute('checked')).map((e) => e.value).join(',');
        } else if (type === 'M') {
            kind = 'multiselect';
            display = 'dropdown';
            choices = [...named[0].options].filter((o) => o.value !== '').map((o) => ({ value: o.value, label: clean(o.textContent) }));
            value = named.map((s) => { const o = [...s.options].find((x) => x.hasAttribute('selected')); return o ? o.value : ''; }).join(',');
        } else if (['F', 'G', 'I', 'J', 'L', 'R'].includes(type)) {
            kind = 'unsupported';
            value = named[0].value || '';
        } else {
            kind = named[0].tagName === 'TEXTAREA' ? 'essay' : 'text';
            value = named[0].tagName === 'TEXTAREA' ? named[0].textContent : (named[0].getAttribute('value') || '');
        }
        const part = parts[Number(boxNum)] || {};
        const tip = doc.getElementById(`tip_${id}`);
        // Grading mark next to the box, e.g. <span class="waMark single mCorrect"> with an img title.
        const markEl = doc.getElementById(`${id}_mark`);
        const markClass = markEl ? [...markEl.classList].find((c) => /^m[A-Z]/.test(c)) : null;
        const markImg = markEl ? markEl.querySelector('img') : null;
        const mark = markClass ? {
            state: markClass.slice(1).replace(/^./, (c) => c.toLowerCase()), // mCorrect -> correct
            title: markImg ? clean(markImg.getAttribute('title') || markImg.getAttribute('alt')) : null,
        } : null;
        const scoreState = part.scoreState || null;
        let status = 'unanswered';
        if (scoreState === 'full_credit' || (mark && mark.state === 'correct')) status = 'correct';
        else if (scoreState === 'partial_credit' || (mark && /partial|frac/.test(mark.state))) status = 'partial';
        else if (scoreState === 'no_credit' || (mark && /incorrect|wrong/.test(mark.state))) status = 'incorrect';
        else if (part.submissions > 0) status = 'submitted';
        return {
            id,
            type,
            typeName: BOX_TYPES[type] || 'unknown',
            kind,
            display,
            boxNum,
            pos,
            value,
            original: value,
            text: kind === 'math' ? toText(value) : value,
            choices,
            hint: tip ? clean(tip.textContent) : null,
            status,
            mark,
            part: {
                score: part.score === undefined ? null : part.score,
                total: part.total === undefined ? null : part.total,
                submissions: part.submissions === undefined ? null : part.submissions,
                maxSubmissions: part.totalSubmissions === undefined ? null : part.totalSubmissions,
                state: part.scoreState || null,
            },
        };
    }

    // Question HTML -> readable text, with each answer box shown as [1], [2], ...
    function questionText(content, boxList, code) {
        const root = content.cloneNode(true);
        root.querySelectorAll('script:not([type^="math/tex"]), style, .tooltip, noscript').forEach((e) => e.remove());
        root.querySelectorAll('table.watexparenleft, table.watexparenright').forEach((t) => {
            const img = t.querySelector('img');
            const m = img && /(left|right)(angle|paren|bracket|brace|bar|vert|floor|ceil)/.exec(img.getAttribute('src') || '');
            const ch = m ? PAREN_IMG[m[2]][m[1] === 'left' ? 0 : 1] : '';
            t.replaceWith(root.ownerDocument.createTextNode(ch));
        });
        boxList.forEach((b, i) => {
            const mark = root.ownerDocument.createTextNode(` [${i + 1}] `);
            const esc = CSS.escape(b.id);
            const target = root.querySelector(`#editable-math-${esc}`) || root.querySelector(`select[name="${esc}"]`)
                || root.querySelector(`input[name="${esc}"]:not([type="hidden"]), textarea[name="${esc}"]`);
            if (!target) return;
            if (target.type === 'radio' || target.type === 'checkbox') {
                target.parentNode.insertBefore(mark, target);
                root.querySelectorAll(`input[name="${esc}"][type="radio"], input[name="${esc}"][type="checkbox"]`)
                    .forEach((e) => e.replaceWith(root.ownerDocument.createTextNode(e.type === 'radio' ? '○ ' : '☐ ')));
            } else {
                target.replaceWith(mark);
            }
        });
        root.querySelectorAll('input, button, select, textarea').forEach((e) => e.remove());

        let out = '';
        const walk = (n, inline) => {
            if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, ' '); return; }
            if (n.nodeType !== 1) return;
            const tag = n.tagName;
            if (tag === 'SCRIPT') { out += ` $${n.textContent.trim()}$ `; return; }
            if (n.localName === 'math') { out += ` ${toText(n.outerHTML)} `; return; }
            if (tag === 'IMG') { out += ` [image: ${n.getAttribute('src')}] `; return; }
            const isInline = inline || n.classList.contains('watex') || n.classList.contains('watexinlineblock');
            const block = !isInline && BLOCK.has(tag);
            if (block) out += '\n';
            if (tag === 'TD' || tag === 'TH') out += ' ';
            n.childNodes.forEach((c) => walk(c, isInline));
            if (block) out += '\n';
        };
        walk(root, false);
        return out.split('\n').map((l) => l.replace(/[  ]+/g, ' ').trim())
            .filter((l) => l && l !== clean(code) && !RESOURCE_LINE.test(l))
            .join('\n');
    }

    // ---------------------------------------------------------------------------
    // Question HTML for rich clients: sanitized, absolute image URLs, and every
    // answer widget replaced by a placeholder the client renders itself:
    //   <span class="wa-slot" data-box="n" [data-sub="k"]>   text/math/dropdown boxes
    //   <span class="wa-opt" data-box="n" data-value="v">    each radio/checkbox
    //   <label class="wa-opt-label" data-box data-value>      that option's label
    // ---------------------------------------------------------------------------

    const WA_BASE = 'https://www.webassign.net/web/Student/Assignment-Responses/';
    const DROP = [
        'script:not([type^="math/tex"])', 'style', 'noscript', 'iframe', 'object', 'embed', 'link', 'meta', 'form',
        'button', '.tooltip', '.js-question-resources', '.extraContent', '.help-buttons-container', '.badgeWrap',
        '.latex-source', '.mathtype-sr-only', '.mathtype-overlay-trigger', '.padMark',
    ].join(', ');

    function sanitizeTree(root) {
        const d = root.ownerDocument;
        root.querySelectorAll(DROP).forEach((e) => e.remove());
        // Grading marks wrap a closed question's choices: unwrap, don't drop.
        root.querySelectorAll('.waMark, .waMarkWrap').forEach((m) => m.replaceWith(...m.childNodes));
        root.querySelectorAll('script[type^="math/tex"]').forEach((sc) => {
            const span = d.createElement('span');
            span.className = 'wa-tex';
            if (/mode=display/.test(sc.type)) span.dataset.display = '1';
            span.textContent = sc.textContent;
            sc.replaceWith(span);
        });
        root.querySelectorAll('*').forEach((el) => {
            [...el.attributes].forEach((a) => {
                const n = a.name.toLowerCase();
                if (n.startsWith('on') || n === 'srcset' || n === 'formaction'
                    || ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*(javascript|vbscript):/i.test(a.value))) {
                    el.removeAttribute(a.name);
                }
            });
            if (el.tagName === 'IMG') {
                const src = el.getAttribute('src');
                if (src && !/^data:/i.test(src)) {
                    try { el.setAttribute('src', new URL(src, WA_BASE).href); } catch (e) { el.remove(); }
                }
            }
            if (el.tagName === 'A') {
                // No navigation from question text; keep the content.
                const span = d.createElement('span');
                while (el.firstChild) span.appendChild(el.firstChild);
                el.replaceWith(span);
            }
        });
    }

    function questionHtml(content, boxList, code) {
        const root = content.cloneNode(true);
        const d = root.ownerDocument;
        const slot = (n, sub) => {
            const s = d.createElement('span');
            s.className = 'wa-slot';
            s.dataset.box = String(n);
            if (sub !== undefined) s.dataset.sub = String(sub);
            return s;
        };
        boxList.forEach((b, i) => {
            const n = i + 1;
            const esc = CSS.escape(b.id);
            if (b.kind === 'math') {
                const ed = root.querySelector(`#editable-math-${esc}`);
                const wrap = ed && (ed.closest('.mathtype-wrapper') || ed);
                // Closed/answered boxes show their rendered answer in .mtAnswer;
                // leave those for the static pass instead of an empty slot.
                const closed = !!wrap && (!!wrap.querySelector('.mtAnswer') || !!ed.classList.contains('mtDisabled'));
                if (wrap && !closed) wrap.replaceWith(slot(n));
                return;
            }
            if (b.display === 'radio' || b.display === 'checkbox') {
                root.querySelectorAll(`input[name="${esc}"]`).forEach((inp) => {
                    if (inp.type !== 'radio' && inp.type !== 'checkbox') { inp.remove(); return; }
                    const lbl = inp.id && root.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
                    if (lbl) {
                        lbl.classList.add('wa-opt-label');
                        lbl.dataset.box = String(n);
                        lbl.dataset.value = inp.value;
                        lbl.removeAttribute('for');
                    }
                    const o = d.createElement('span');
                    o.className = 'wa-opt';
                    o.dataset.box = String(n);
                    o.dataset.value = inp.value;
                    inp.replaceWith(o);
                });
                return;
            }
            const targets = [...root.querySelectorAll(`select[name="${esc}"], textarea[name="${esc}"], input[name="${esc}"]:not([type="hidden"])`)];
            targets.forEach((t, j) => t.replaceWith(slot(n, targets.length > 1 ? j : undefined)));
        });
        // Closed questions keep their answers as disabled radios/checkboxes (often inside
        // the grading mark). Show them read-only: <span class="static-opt radio on grade-correct">.
        root.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((inp) => {
            const mark = inp.closest('.waMark');
            const m = mark && [...mark.classList].find((c) => /^m[A-Z]/.test(c));
            const grade = m ? m.slice(1).toLowerCase() : null;
            const chosen = inp.hasAttribute('checked');
            const s = d.createElement('span');
            s.className = `static-opt ${inp.type}${chosen ? ' on' : ''}${grade && chosen ? ` grade-${grade}` : ''}`;
            const lbl = chosen && inp.id && root.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
            if (lbl) lbl.classList.add('static-chosen', ...(grade ? [`grade-${grade}`] : []));
            inp.replaceWith(s);
        });
        // Closed/answered math boxes remain as disabled editors: keep only the rendered answer.
        root.querySelectorAll('.mathtype-wrapper').forEach((w) => {
            const span = d.createElement('span');
            span.className = 'wa-static';
            const ans = w.querySelector('.mtAnswer math') || w.querySelector('.mtAnswer');
            if (ans) span.appendChild(ans);
            w.replaceWith(span);
        });
        root.querySelectorAll('input, select, textarea').forEach((e) => e.remove());
        if (code) {
            root.querySelectorAll('div').forEach((el) => {
                if (clean(el.textContent) === clean(code) && !el.querySelector('.wa-slot, .wa-opt')) el.remove();
            });
        }
        sanitizeTree(root);
        return root.innerHTML;
    }

    // WebAssign's own question-layout CSS (watex math, stacks, choice lists),
    // scoped under .qhtml and recolored for a dark background.
    const QCSS_RE = /(watex|\.wa1|\.stack|subblock|sublabel|subpart|multBox|\.ms\b|fitb|accblock|\.figure|nobr|\.indent|qTextField|questionRadio|wa1list|cap-btm|alt-cap|\.desc\b|studentQuestion)/;

    function luminance(value, ctx) {
        ctx.fillStyle = '#010203';
        ctx.fillStyle = value;
        const v = ctx.fillStyle;
        if (v === '#010203') return null; // not a color (inherit, currentColor, ...)
        let r; let g; let b; let a = 1;
        const hex = /^#([0-9a-f]{6})$/i.exec(v);
        if (hex) {
            const n = parseInt(hex[1], 16);
            [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
        } else {
            const m = /rgba?\(([^)]+)\)/.exec(v);
            if (!m) return null;
            [r, g, b, a = 1] = m[1].split(',').map(Number);
        }
        if (a === 0) return null;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

    async function questionStyles({ dep }) {
        const doc = await getDoc(`/web/Student/Assignment-Responses/last?dep=${dep}`);
        const hrefs = [...new Set([...doc.querySelectorAll('link[rel="stylesheet"]')]
            .map((l) => l.getAttribute('href') || '')
            .filter((h) => /student_screen_min\.css|csstyle\/style\.css/.test(h)))];
        const ctx = document.createElement('canvas').getContext('2d');
        const out = [];
        for (const href of hrefs) {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync((await (await waFetch(href)).text()).replace(/@import[^;]+;/g, ''));
            for (const rule of sheet.cssRules) {
                if (!rule.selectorText || !QCSS_RE.test(rule.selectorText)) continue;
                const decls = [];
                for (let i = 0; i < rule.style.length; i++) {
                    const prop = rule.style[i];
                    let val = rule.style.getPropertyValue(prop);
                    const lum = /color$/.test(prop) ? luminance(val, ctx) : null;
                    if (prop === 'color' && lum !== null && lum < 0.45) val = 'inherit';
                    else if (prop === 'background-color' && lum !== null && lum > 0.75) val = 'transparent';
                    else if (/^(border-.*|outline)-color$/.test(prop) && lum !== null && lum < 0.45) val = 'currentColor';
                    decls.push(`${prop}: ${val}${rule.style.getPropertyPriority(prop) ? ' !important' : ''}`);
                }
                const sel = rule.selectorText.split(',')
                    .map((x) => `.qhtml ${x.trim().replace(/^(html|body)\b\s*/, '')}`).join(', ');
                out.push(`${sel} { ${decls.join('; ')} }`);
            }
        }
        return { css: out.join('\n'), sources: hrefs };
    }

    function parseQuestion(qEl, doc) {
        const [, qid, position] = qEl.id.match(/^question(\d+)_(\d+)$/);
        const header = qEl.querySelector('.js-question-header');
        let info = {};
        try { info = JSON.parse(header ? header.getAttribute('data-question-display') : '{}') || {}; } catch (e) { /* ignore */ }
        const parts = (info.summary && info.summary.parts) || [];
        const boxList = [...qEl.querySelectorAll('input.wa_question_box')]
            .filter((b) => !b.classList.contains('static'))
            .map((b) => parseBox(b.value, qEl, doc, parts))
            .filter(Boolean);
        const content = qEl.querySelector('.qContent') || qEl;
        const mastery = qEl.closest('.js-mastery-group');
        const number = Number(qEl.getAttribute('data-view-position')) || Number(position) + 1;
        return {
            number,
            id: qid,
            position: Number(position),
            code: clean(info.code) || null,
            score: info.score === undefined ? null : info.score,
            total: info.total === undefined ? null : info.total,
            submissions: info.submissions || null,
            text: questionText(content, boxList, info.code),
            html: questionHtml(content, boxList, info.code),
            saved: Boolean(qEl.querySelector('.qUtility.qAlert')),
            masteryGroup: mastery ? mastery.getAttribute('data-id') : null,
            boxes: boxList.map((b, i) => ({ index: i + 1, ...b })),
        };
    }

    async function loadAssignment(dep) {
        if (!/^\d+$/.test(String(dep))) throw httpError(400, `Bad assignment id "${dep}"`);
        const doc = await getDoc(`/web/Student/Assignment-Responses/last?dep=${dep}`);
        return parseAssignmentDoc(doc, dep);
    }

    function parseAssignmentDoc(doc, dep) {
        const depInput = doc.getElementById('deployment');
        if (!depInput) throw httpError(404, `Assignment ${dep} not found or not available.`);
        const meta = doc.querySelector('meta[name="X-CSRF-TOKEN"]');
        const questions = [...doc.querySelectorAll('div[id^="question"]')]
            .filter((e) => /^question\d+_\d+$/.test(e.id))
            .map((e) => parseQuestion(e, doc))
            .sort((a, b) => a.number - b.number);
        return {
            id: Number(depInput.value),
            name: doc.title.replace(/\s*\|\s*WebAssign\s*$/, '').split(' - ')[0].trim(),
            user: (doc.getElementById('user') || {}).value,
            stamp: (doc.getElementById('stamp') || {}).value || '1',
            csrf: meta ? meta.getAttribute('content') : null,
            questions,
        };
    }

    // Public shape: drop internal fields the CLI does not need.
    function publicQuestion(q, { html = false } = {}) {
        const { html: qHtml, saved, masteryGroup, boxes: bx, ...rest } = q;
        return {
            ...rest,
            ...(html ? { html: qHtml } : {}),
            boxes: bx.map(({ original, boxNum, pos, ...b }) => b),
        };
    }

    function publicAssignment(a, opts) {
        return { id: a.id, name: a.name, questions: a.questions.map((q) => publicQuestion(q, opts)) };
    }

    function findQuestion(a, n) {
        const q = a.questions.find((x) => x.number === Number(n));
        if (!q) throw httpError(404, `Assignment ${a.id} has no question ${n} (it has ${a.questions.length}).`);
        return q;
    }

    // ---------------------------------------------------------------------------
    // Answers
    // ---------------------------------------------------------------------------

    function findBox(q, key) {
        const k = String(key).trim();
        let box;
        if (/^\d+$/.test(k)) box = q.boxes[Number(k) - 1];
        else if (/^[a-z]$/i.test(k)) box = q.boxes[k.toLowerCase().charCodeAt(0) - 97];
        else box = q.boxes.find((b) => b.id === k);
        if (!box) throw httpError(400, `Question ${q.number} has no box "${key}" (boxes are 1..${q.boxes.length}).`);
        return box;
    }

    function pickChoice(box, answer) {
        const a = String(answer).trim();
        const hit = box.choices.find((c) => c.value === a)
            || box.choices.find((c) => c.label.toLowerCase() === a.toLowerCase());
        if (!hit) {
            throw httpError(400, `Box ${box.index}: "${answer}" is not a choice. Choices: `
                + box.choices.map((c) => `${c.value}=${c.label}`).join(', '));
        }
        return hit.value;
    }

    function encodeAnswer(box, answer) {
        if (answer === null || answer === undefined) return box.value;
        const list = Array.isArray(answer) ? answer : String(answer).split(',');
        switch (box.kind) {
            case 'math': {
                const s = String(answer).trim();
                if (!s) return EMPTY;
                if (s.startsWith('<math')) return s;
                try {
                    return `<math xmlns="${NS}">${parse(s)}</math>`;
                } catch (e) {
                    throw httpError(400, `Box ${box.index}: ${e.message}`);
                }
            }
            case 'choice':
                return String(answer).trim() === '' ? '' : pickChoice(box, answer);
            case 'checkboxes':
                return list.filter((x) => String(x).trim() !== '').map((x) => pickChoice(box, x)).join(',');
            case 'multiselect':
                return list.map((x) => (String(x).trim() === '' ? '' : pickChoice(box, x))).join(',');
            case 'unsupported':
                if (typeof answer !== 'string') throw httpError(400, `Box ${box.index} (${box.typeName}) only takes a raw response string.`);
                return answer;
            default:
                return String(answer);
        }
    }

    // answers: ["x^2", "parallel"]  or  {"1": "x^2", "b": "parallel", "<box id>": ...}
    function applyAnswers(q, answers) {
        if (answers === undefined || answers === null) return;
        const entries = Array.isArray(answers)
            ? answers.map((v, i) => [String(i + 1), v])
            : Object.entries(answers);
        entries.forEach(([key, v]) => {
            if (v === null || v === undefined) return;
            const box = findBox(q, key);
            box.value = encodeAnswer(box, v);
        });
    }

    const trimmed = (v) => String(v === undefined || v === null ? '' : v).trim();
    const changed = (q) => q.boxes.some((b) => trimmed(b.value) !== trimmed(b.original));

    // Mirrors WA.Question.Submittable#getResponses: saved questions send every box,
    // otherwise only the boxes that changed.
    function questionResponses(q) {
        const boxes = q.saved ? q.boxes : q.boxes.filter((b) => trimmed(b.value) !== trimmed(b.original));
        if (!boxes.length) return null;
        return { id: q.id, position: q.position, responses: boxes.map((b) => ({ box: b.boxNum, pos: b.pos, response: trimmed(b.value) })) };
    }

    function answerPreview(q) {
        return q.boxes.map((b) => ({
            index: b.index,
            kind: b.kind,
            response: trimmed(b.value),
            text: b.kind === 'math' ? toText(b.value) : trimmed(b.value),
            changed: trimmed(b.value) !== trimmed(b.original),
        }));
    }

    async function saveQuestion({ dep, n, answers }) {
        const a = await loadAssignment(dep);
        const q = findQuestion(a, n);
        applyAnswers(q, answers);
        if (!changed(q)) return { saved: false, reason: 'Nothing changed compared to the saved answers.', answers: answerPreview(q) };
        const resp = { ...questionResponses(q), masteryGroup: q.masteryGroup };
        const data = { deployment: String(a.id), user: a.user, responses: [resp], allResponses: [resp], smw: [] };
        const r = await waFetch(`/web/Rest/Response/save?dep=${a.id}&user=${a.user}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Accept: 'application/json',
                'X-Request': 'JSON',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-TOKEN': a.csrf,
            },
            body: JSON.stringify(data),
        });
        let result = null;
        try { result = await r.json(); } catch (e) { /* non-JSON body */ }
        if (result && result.status && String(result.status) !== '200') {
            throw httpError(502, `WebAssign refused the save: ${result.message || JSON.stringify(result).slice(0, 300)}`);
        }
        return { saved: true, answers: answerPreview(q) };
    }

    async function submitQuestion({ dep, n, answers, dryRun }) {
        const a = await loadAssignment(dep);
        const q = findQuestion(a, n);
        applyAnswers(q, answers);
        const resp = questionResponses(q);
        if (!resp) throw httpError(400, `Question ${q.number}: nothing to submit (no answers given or changed).`);
        const data = {
            deployment: String(a.id),
            user: a.user,
            responses: [resp],
            allResponses: changed(q) ? [{ ...resp, masteryGroup: q.masteryGroup }] : [],
            smw: [],
        };
        // The page adds qid/pos when the question is the one being viewed (index > 0).
        const params = new URLSearchParams({ dep: String(a.id) });
        if (q.number - 1 > 0) {
            data.qid = q.id;
            params.set('pos', String(q.number - 1));
        }
        data.masteryGroup = q.masteryGroup;
        data.stamp = a.stamp;
        if (dryRun) return { dryRun: true, url: `/web/Student/Assignment-Responses/submit?${params}`, data, answers: answerPreview(q) };

        const before = { score: q.score, submissions: q.submissions };
        const form = new FormData();
        form.append('data', JSON.stringify(data));
        form.append('CSRFToken', a.csrf || '');
        const r = await waFetch(`/web/Student/Assignment-Responses/submit?${params}`, { method: 'POST', body: form });
        let after;
        try {
            after = parseAssignmentDoc(new DOMParser().parseFromString(await r.text(), 'text/html'), dep);
        } catch (e) {
            after = await loadAssignment(dep);
        }
        const nq = findQuestion(after, n);
        const results = nq.boxes.map((b) => ({
            index: b.index,
            status: b.status,
            score: b.part.score,
            total: b.part.total,
            submissions: b.part.submissions,
            maxSubmissions: b.part.maxSubmissions,
            message: b.mark ? b.mark.title : null,
        }));
        return {
            submitted: true,
            allCorrect: results.every((r) => r.status === 'correct'),
            results,
            before,
            question: publicQuestion(nq, { html: true }),
        };
    }

    const ACTIONS = {
        ping: async () => ({ ok: true, url: location.href }),
        courses: () => listCourses(),
        assignments: (p) => listAssignments(p),
        assignment: async (p) => publicAssignment(await loadAssignment(p.dep), p),
        question: async (p) => publicQuestion(findQuestion(await loadAssignment(p.dep), p.n), p),
        save: (p) => saveQuestion(p),
        submit: (p) => submitQuestion(p),
        styles: (p) => questionStyles(p),
        mathml: async (p) => {
            const body = parse(p.expr);
            const mathml = `<math xmlns="${NS}">${body}</math>`;
            return { mathml, text: toText(mathml) };
        },
    };

    // ---------------------------------------------------------------------------
    // Bridge polling
    // ---------------------------------------------------------------------------

    const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;

    function bridgeRequest(method, path, body, timeout) {
        return new Promise((resolve, reject) => {
            gm({
                method,
                url: BRIDGE + path,
                headers: { 'Content-Type': 'application/json' },
                data: body === undefined ? undefined : JSON.stringify(body),
                timeout,
                onload: resolve,
                onerror: () => reject(new Error('bridge unreachable')),
                ontimeout: () => reject(new Error('bridge timeout')),
            });
        });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let jobChain = Promise.resolve(); // run jobs one at a time, in order

    async function runJob(job) {
        let reply;
        try {
            const fn = ACTIONS[job.action];
            if (!fn) throw httpError(400, `Unknown action "${job.action}"`);
            reply = { id: job.id, ok: true, result: await fn(job.params || {}) };
        } catch (e) {
            reply = { id: job.id, ok: false, status: e.status || 500, error: e.message || String(e) };
        }
        try { await bridgeRequest('POST', '/_bridge/result', reply, 15000); } catch (e) { /* bridge went away */ }
    }

    async function pollLoop() {
        let warned = false;
        for (;;) {
            try {
                const r = await bridgeRequest('GET', `/_bridge/poll?page=${encodeURIComponent(location.pathname)}&v=${SCRIPT_VERSION}`, undefined, 40000);
                if (warned) { console.log('[mp] REST bridge connected'); warned = false; }
                if (r.status === 200) {
                    const job = JSON.parse(r.responseText);
                    jobChain = jobChain.then(() => runJob(job));
                } else if (r.status !== 204) {
                    await sleep(3000);
                }
            } catch (e) {
                if (!warned) { console.log('[mp] WebAssign Desk bridge not running (open the app); retrying quietly'); warned = true; }
                await sleep(5000);
            }
        }
    }

    // One polling tab is enough; other WebAssign tabs stand by until the leader closes.
    function startBridge() {
        if (!gm) return;
        const KEY = 'mpBridgeLeader';
        const me = Math.random().toString(36).slice(2);
        const claim = () => {
            let cur = null;
            try { cur = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* ignore */ }
            if (!cur || cur.id === me || Date.now() - cur.t > 10000) {
                try { localStorage.setItem(KEY, JSON.stringify({ id: me, t: Date.now() })); } catch (e) { /* ignore */ }
                return true;
            }
            return false;
        };
        let started = false;
        const tick = () => {
            if (claim() && !started) { started = true; pollLoop(); }
        };
        tick();
        setInterval(tick, 4000);
        W.addEventListener('beforeunload', () => {
            try {
                const cur = JSON.parse(localStorage.getItem(KEY) || 'null');
                if (cur && cur.id === me) localStorage.removeItem(KEY);
            } catch (e) { /* ignore */ }
        });
    }

    mp.api = ACTIONS; // e.g. await mp.api.assignments() from the console
    startBridge();
}());
