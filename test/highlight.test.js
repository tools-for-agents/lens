// The highlighter had never been tested, because it lived inline in a 1,600-line HTML file and
// nothing in this repo renders a line of code. It was deleting characters from the code lens exists
// to show you. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { highlight, esc } = await import('../public/highlight.js');

// Undo exactly what highlight() adds: its own spans, and its own escaping. Nothing else.
const strip = (html) => html
  .replace(/<span class="sx-[a-z]+">/g, '').replace(/<\/span>/g, '')
  .replace(/&nbsp;/g, '\u00a0').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// 🔑 THE INVARIANT: HIGHLIGHTING IS RE-DECORATION. Strip the tags and you get the input back, byte
// for byte. A colouring rule that misses is a cosmetic bug; a colouring rule that EATS is a lie
// about the file, from the tool whose whole job is showing you the file.
//
// It ate. The tokenizer ran `while ((m = re.exec(text)))` and appended only what it matched — and
// exec() with /g does not stop at an unmatchable character, it scans FORWARD to the next match and
// the skipped text is gone. `4` in `#4fd6be` matches nothing: the number rule needs a word boundary
// after the digits (`f` denies it), the identifier rule refuses a leading digit, punctuation refuses
// a word character. Measured: 6 of 10 ordinary lines of this repo's CSS came out wrong.
test('highlighting NEVER changes the text — strip the spans and the line is byte-identical', () => {
  const corpus = [
    '  --accent:#4fd6be;',                       // → "#fd6be": the 4 was dropped
    '  --panel:#14181e;',                        // → "#e": FIVE characters dropped
    '  padding: 12px 16px;',                     // → "padding: px px;"
    '  grid-template-columns: 1fr 2fr;',         // → "fr fr"
    '  transition:color .12s;',                  // → ".s"
    '  const mask = 0x1F;',                      // → "x1F"
    '  const big = 1_000_000;',
    '  const v = "1.2.3";',
    '  width:100%;',
    '  const a = 5;',
    '  if (a < b && c > d) return "x&y";',       // the escaping must round-trip too
    '  const s = `a ${b} c`;',
    '  // a comment with 3 numbers 42 and #hex',
    '  /* block 12px */',
    '  const emoji = "🧠 → cortex";',            // astral chars: two code units, one character
    '',
    '   ',
  ];
  for (const line of corpus) {
    for (const lang of ['css', 'javascript', 'html', 'python', 'shell']) {
      const got = strip(highlight(line, lang));
      const want = line === '' ? ' ' : line;   // an empty line renders &nbsp; so it keeps its height
      assert.equal(got, want, `${lang}: highlighting changed the text\n  in:  ${JSON.stringify(line)}\n  out: ${JSON.stringify(got)}`);
    }
  }
});

// The catch-all must not become a paint bucket: the point is that nothing is LOST, not that nothing
// is coloured. If a rule stops firing, this test says so while the round-trip above still passes.
test('and it still colours what it always coloured', () => {
  assert.match(highlight('const x = 1;', 'javascript'), /<span class="sx-key">const<\/span>/, 'keywords');
  assert.match(highlight('const x = 1;', 'javascript'), /<span class="sx-num">1<\/span>/, 'numbers');
  // the output is escaped HTML — the span wraps &quot;bar&quot;, not "bar"
  assert.match(highlight('foo("bar")', 'javascript'), /<span class="sx-str">&quot;bar&quot;<\/span>/,
    'a string is coloured even when punctuation touches its opening quote — foo("bar")');
  assert.match(highlight('foo("bar")', 'javascript'), /<span class="sx-fn">foo<\/span>/, 'call sites');
  assert.match(highlight('// hi', 'javascript'), /<span class="sx-com">\/\/ hi<\/span>/, 'comments');
  assert.match(highlight('# hi', 'python'), /<span class="sx-com"># hi<\/span>/, '# comments, in # languages');
  // …and NOT in the others: `#4fd6be` is a colour, not a comment, and treating it as one would
  // paint the rest of the line grey.
  assert.ok(!/sx-com/.test(highlight('  --accent:#4fd6be;', 'css')), 'a css hex is not a comment');
});

// A /g regex carries lastIndex ACROSS CALLS, and RE is shared at module scope — so consecutive calls
// have to be independent. They are, and this says so.
//
// Note what this test does NOT do: it does not guard the `RE.lastIndex = 0` line. I checked by
// deleting it — all four tests still passed, because exec() resets lastIndex itself when it returns
// null, and this loop always runs to null. The reset is insurance against a future `break` in the
// loop, not a live bug, and pretending otherwise would make this a test that cannot fail.
test('consecutive calls are independent — the second line is not tokenized from where the first stopped', () => {
  const a = '  const first = 1;';
  const b = '  const second = 2;';
  highlight(a, 'javascript');
  assert.equal(strip(highlight(b, 'javascript')), b, 'the second line is whole');
  assert.equal(strip(highlight(a, 'javascript')), a, 'and so is the first, again');
});

test('esc escapes exactly the four characters that can break out of the markup', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
});
