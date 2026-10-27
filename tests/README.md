# Anchoring tests

An end-to-end guard on the one thing that can make a check disappear: the `<mark>` elements that tie a comment to the span of text it is about.

`./run.sh` serves the repo, loads `src/index.html` in headless Chromium, and drives it the way a person does — focus the editor, type through `execCommand` so `contenteditable` behaves as it really does, let `selectionchange` fire on its own, click the Ask button.
Nothing is stubbed and no app code is imported; the driver reads the page's own globals the way a second classic script on the page can.

It needs no toolchain.
The browser is whichever Chromium is already installed (Chrome, Brave, Chromium, or Playwright's), and the server is node's own `http` module.
Set `CHROME=` to point at a different binary, `PORT=` to move off 8731.

## What it covers

**A — Enter at the end of a highlight.**
Blink splits the `<mark>`, so the new blank line lands *inside* the highlight as an empty `<mark data-len="0"><br></mark>`.
This fires only when the span ends its block, which is the ordinary case: you highlight the sentence you just finished, then press Enter to carry on.
Left in place these accumulate, and each one is a landmine for every later selection.

**B — a span crossing a paragraph boundary.**
`Range.surroundContents()` throws `InvalidStateError` on any range that *partially* selects a non-Text node, and both a paragraph boundary and one of those empty clones qualify.
B3 and B4 pin that such a span still anchors, as one mark per block it covers.
B5 is the failure the whole suite exists for: an answer saved with nothing in the prose pointing at it is indistinguishable, to the reader, from an answer that never arrived.

**C — resolving a multi-block highlight.**
Every mark of the span has to go, not just the first one a `querySelector` finds, and the prose itself has to survive intact.

**D — pasted card markup must not steer the selection.**
A `.body` element in the prose used to make the app classify a prose selection as a card selection, throw while building the pending context, and file the next check under the *previous* quote.
D2 pins the rule that closed it: a selection in the editor is prose, whatever markup it happens to sit in.

**E — a question asked about a comment card.**
That highlight lives in markup `renderCardBody` rebuilds from scratch, so it cannot survive as an element.
It is stored as offsets into the parent card's text and re-wrapped each time the card is drawn.

**F — paste arrives as text, not markup.**
Rich paste is what put `.body`, `.card` and browser styling spans into the prose in the first place.

**G — putting a lost highlight back.**
A check restored only where its quote appears exactly once; ambiguous and absent quotes left alone and reported; nothing moved until asked for; the prose itself untouched.
G12 pins the deliberate choice on duplicates: several checks quoting one span are all restored, nested, rather than dropping the later ones.

**H — a card question saved before anchors existed.**
Found by its quote in the rebuilt card text, so old nested questions need no repair action.

**I — the colour a highlight wears.**
The verdict is held in state, not in the saved markup, so a document arrives repainted from the record: I1 and I2 pin that on a document saved by a build that wrote a `note` class and no colour at all.
I4 reads the rendered background rather than the stylesheet, which is the only way to catch a rule that parses but never matches.
I5 measures the actual contrast of text against its own background for every verdict, lit and unlit, pill and highlight, in both themes — it was written against a page whose highlighted prose rendered black-on-dark, because `<mark>` takes its colour from the UA sheet unless something says otherwise.
Both palettes are pinned with `data-theme` rather than inherited, since the headless browser has a colour scheme of its own and would otherwise leave half of it unmeasured.

## Passing is the point

Every assertion here failed, or would have, against the code before the fix — except the five guards (A1, A2, B0, B1, B2) that pin behaviour which already worked.
When changing anything that touches `markRange`, `paintMark`, `fixHighlightBoundary`, `onSelectionChange` or `renderCardBody`, run this first.
