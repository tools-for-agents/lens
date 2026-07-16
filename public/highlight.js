// lens — the syntax highlighter. Extracted from index.html so it can be TESTED.
//
// 🔑 IT WAS SILENTLY DELETING CHARACTERS FROM YOUR CODE.
//
// The tokenizer is a single regex run in a `while ((m = re.exec(text)))` loop, and the loop only
// ever appends what it MATCHED. That is fine while every character matches something. It is a
// shredder the moment one does not: exec() with /g does not stop at an unmatchable character, it
// SCANS FORWARD to the next position that matches — and everything it skipped over is gone.
//
// `#4fd6be`: punctuation ate `:#`, then at `4` the number rule wants a word boundary AFTER the
// digits (`\b\d[\d_.]*\b`) and `4` is followed by `f`, so there is none; the identifier rule
// refuses a leading digit; punctuation refuses a word character. Nothing matches `4`. It is
// dropped, and the reader shows `#fd6be`.
//
// It is not a corner case. Measured over ordinary lines of this repo's own CSS:
//
//     padding: 12px 16px;             ->  padding: px px;
//     grid-template-columns: 1fr 2fr; ->  grid-template-columns: fr fr;
//     transition:color .12s;          ->  transition:color .s;
//     const mask = 0x1F;              ->  const mask = x1F;
//     --panel:#14181e;                ->  --panel:#e;
//
// Every CSS length in the reader was missing its number. lens exists to put code in front of an
// agent; the one thing it may never do is show code that is not what the file says. And nothing
// could catch it: the tests never rendered a line, and the eye checks whether text is LEGIBLE,
// not whether it is TRUE — iris said "✓ nothing broken" about a page displaying the wrong code.
//
// The fix is the invariant, not the regex: HIGHLIGHTING IS RE-DECORATION. Strip the tags and you
// must get the input back, byte for byte. So the tokenizer ends in a catch-all that matches any
// single character, and highlight.test.js asserts the round-trip over a corpus of the shapes that
// broke it. A rule you forget can now only lose a COLOUR — never a character.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const KEYWORDS = {
  javascript: 'const let var function return if else for while class extends new import export from default async await try catch finally throw typeof instanceof of in do switch case break continue this super yield static get set null true false undefined void delete'.split(' '),
  python: 'def class return if elif else for while import from as try except finally raise with lambda yield global nonlocal pass break continue and or not in is None True False async await self'.split(' '),
  go: 'func package import type struct interface map chan go defer return if else for range switch case break continue var const nil true false make new'.split(' '),
  rust: 'fn let mut pub struct enum trait impl mod use match if else for while loop return self Self as ref move async await dyn where const static true false Some None Ok Err'.split(' '),
  json: [], text: [], markdown: [], yaml: 'true false null'.split(' '),
  sql: 'select from where join on group by order limit insert update delete create table view index into values as and or not null'.split(' '),
};
KEYWORDS.typescript = KEYWORDS.javascript.concat('interface type enum namespace declare readonly public private protected implements keyof'.split(' '));
KEYWORDS.c = KEYWORDS.cpp = 'int char void float double return if else for while struct class public private include define const static new delete true false null nullptr auto'.split(' ');
KEYWORDS.java = KEYWORDS.cpp;
KEYWORDS.css = [];
KEYWORDS.shell = 'if then else fi for do done while case esac function return export local echo cd'.split(' ');
KEYWORDS.html = [];

// comments | strings | numbers | identifiers | punctuation+space | ANY ONE CHARACTER
//                                                                  ^^^^^^^^^^^^^^^^^
// The last alternative is the whole point: it cannot fail, so exec() never skips, so no character
// is ever dropped. Everything before it is only about what gets a COLOUR.
//
// The punctuation run excludes QUOTES on purpose. It is greedy and matches at the earliest position
// that fits, so in `foo("bar")` it took `("` — swallowing the opening quote, after which the string
// rule had nothing to start from and `"bar"` went uncoloured. Stopping punctuation before a quote
// lets the string rule have it. That is only SAFE because of the catch-all: an unpaired apostrophe
// (`it's`) now matches no rule at all, and before the catch-all existed, that dropped it.
const RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|([^\w\s'"`]+|\s+)|([\s\S])/g;

export function highlight(text, lang) {
  const kws = KEYWORDS[lang] || KEYWORDS.javascript;
  const lineComment = (lang === 'python' || lang === 'shell' || lang === 'yaml') ? '#' : '//';
  let out = '', m;
  // Belt and braces: exec() resets lastIndex itself once it returns null, and the loop below always
  // runs to null — so this line changes nothing today (deleting it fails no test, which I checked).
  // It is here for the `break` someone adds later: a leaked lastIndex makes the NEXT file start
  // tokenizing mid-line, and the damage would be silent.
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    if (m[1]) {                     // comment — but `#` only starts one in #-comment languages
      if (m[1][0] === '#' && lineComment !== '#') out += esc(m[1]);
      else out += `<span class="sx-com">${esc(m[1])}</span>`;
    } else if (m[2]) out += `<span class="sx-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="sx-num">${esc(m[3])}</span>`;
    else if (m[4]) {
      if (kws.includes(m[4])) out += `<span class="sx-key">${esc(m[4])}</span>`;
      else if (text[RE.lastIndex] === '(') out += `<span class="sx-fn">${esc(m[4])}</span>`;
      else out += esc(m[4]);
    } else out += esc(m[5] ?? m[6] ?? '');   // m[6]: the catch-all — undecorated, but PRESENT
  }
  return out || '&nbsp;';
}
