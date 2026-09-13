/* Drives the lost-highlight scenarios end to end, inside the real app page.
 *
 * Every step goes through the same path a person does: focus the editor, type
 * with execCommand so contenteditable behaves as it really does, let
 * selectionchange fire on its own, and click the Ask button. Nothing is stubbed
 * and no app code is imported — the driver reads the page's own globals
 * (`editor`, `state`, `pendingContext`, `serializeLibrary`) the way a second
 * classic script on the page can.
 *
 * Results land in #recall-test-results, one line per assertion, for run.sh to
 * read out of the dumped DOM.
 */
(function () {
  const PARA = 'Python import statements find the designated file on the module search path and run it once.';
  const LINE2 = 'Modules are cached in sys.modules after the first import.';

  const log = [];
  let failed = 0;
  /* `detail` prints only on failure: a diagnostic string next to PASS reads as
     evidence of something that did not happen. */
  function check(name, pass, detail) {
    if (!pass) failed++;
    const note = !pass && detail ? ' :: ' + (typeof detail === 'function' ? detail() : detail) : '';
    log.push(`RECALL-TEST ${pass ? 'PASS' : 'FAIL'} ${name}${note}`);
  }
  function note(msg) { log.push(`RECALL-TEST NOTE ${msg}`); }

  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  async function settle() { for (let i = 0; i < 6; i++) await tick(10); }

  /* ---- driving the page the way a pointer and keyboard would ---- */
  function textNodes(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = []; let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }
  function locate(root, offset) {
    const nodes = textNodes(root);
    for (const n of nodes) {
      if (offset <= n.data.length) return [n, offset];
      offset -= n.data.length;
    }
    const last = nodes[nodes.length - 1];
    return [last, last ? last.data.length : 0];
  }
  function put(range) {
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }
  function select(root, start, end) {
    const [sn, so] = locate(root, start);
    const [en, eo] = locate(root, end);
    if (!sn || !en) return null;
    const r = document.createRange();
    r.setStart(sn, so); r.setEnd(en, eo);
    put(r);
    return r;
  }
  function caretAtEndOf(node) {
    const r = document.createRange();
    r.selectNodeContents(node); r.collapse(false);
    put(r);
  }
  function type(text) {
    editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) caretAtEndOf(editor);
    document.execCommand('insertText', false, text);
  }
  /* Click Ask exactly as a person would, once the app has offered it. */
  async function ask() {
    await settle();
    const asker = document.querySelector('#asker');
    const offered = asker.style.display === 'block';
    asker.click();
    await settle();
    return offered;
  }
  const marks = () => Array.from(editor.querySelectorAll('mark.hl'));
  const marksFor = (id) => editor.querySelectorAll(`mark.hl[data-comment-id="${id}"]`);
  const newestComment = () => state.order[state.order.length - 1];

  async function run() {
    /* wait for the app's async boot to seed its first entry */
    for (let i = 0; i < 200 && !state.activeId; i++) await tick(10);

    /* ============ A: Enter at the end of a highlight clones the mark ============
       The span has to end its block for this to fire — which is the ordinary
       case, since you highlight the sentence you just finished and then press
       Enter to carry on writing. A highlight with text after it is unaffected. */
    createEntry('Repro A', 'Repro A');
    await settle();
    type(PARA);
    await settle();

    select(editor, PARA.length - 46, PARA.length);
    check('A1 ask is offered for a clean single-paragraph span', await ask());
    check('A2 a clean span gets its highlight', marks().length === 1,
      () => `marks=${marks().length}`);

    caretAtEndOf(marks()[0]);
    editor.focus();
    document.execCommand('insertParagraph');
    await settle();

    const empties = () => marks().filter(m => m.textContent.length === 0);
    check('A3 pressing Enter at the end of a highlight leaves no empty clone',
      empties().length === 0,
      () => `${empties().length} empty mark(s), ids=[${empties().map(m => m.dataset.commentId).join(',')}]`);

    /* ============ B: a span crossing that blank line still anchors ============ */
    type(LINE2);
    await settle();
    check('B0 text typed on the new line stays out of the highlight',
      !marks().some(m => m.textContent.includes(LINE2.slice(0, 12))));

    const before = state.order.length;
    select(editor, 20, editor.textContent.length - 10);
    /* Selection.toString() renders block boundaries as newlines and is what the
       app records; Range.toString() concatenates text nodes and would not. */
    const wanted = window.getSelection().toString().trim();
    check('B1 ask is offered for the cross-paragraph span', await ask());

    const idB = newestComment();
    check('B2 the check is recorded', state.order.length === before + 1,
      () => `order went ${before} -> ${state.order.length}`);
    check('B3 a span crossing a paragraph boundary gets its highlight',
      marksFor(idB).length > 0,
      () => `comment ${idB} has no mark; selected ${JSON.stringify(wanted.slice(0, 40))}`);
    check('B4 it is anchored by one mark per block it covers',
      marksFor(idB).length > 1, () => `${marksFor(idB).length} mark(s)`);

    /* the failure this whole suite exists for: an answer saved with nothing in
       the prose pointing at it is indistinguishable from an answer never given */
    const saved = JSON.parse(serializeLibrary());
    const entry = saved.library.find(e => e.id === state.activeId);
    const inComments = Boolean(entry.comments[idB]);
    const inProse = entry.editorHTML.includes(`data-comment-id="${idB}"`);
    check('B4b the recorded quote is the text that was selected',
      state.comments[idB] && state.comments[idB].quote === wanted,
      () => `recorded ${JSON.stringify(String(state.comments[idB] && state.comments[idB].quote).slice(0, 50))}, selected ${JSON.stringify(wanted.slice(0, 50))}`);

    check('B5 a saved check is reachable from the saved prose',
      !inComments || inProse,
      () => `comment saved=${inComments}, anchored in saved prose=${inProse}`);

    /* ============ C: resolving clears every mark of a multi-block span ======== */
    markResolved(idB);
    await settle();
    check('C1 resolving removes the whole highlight, not its first fragment',
      marksFor(idB).length === 0, () => `${marksFor(idB).length} mark(s) left`);
    check('C2 resolving leaves the prose itself intact',
      editor.textContent.includes(LINE2) && editor.textContent.includes(PARA.slice(0, 30)),
      () => `prose is ${JSON.stringify(editor.textContent.slice(0, 60))}`);

    /* ============ D: pasted card markup must not steer the pending context === */
    createEntry('Repro D', 'Repro D');
    await settle();
    type('Integers are not closed under division.');
    await settle();
    /* what pasting an answer card back into the prose used to leave behind */
    editor.insertAdjacentHTML('beforeend',
      '<div><div class="body"><p>Closure means the operation never leaves the set.</p></div></div>');
    await settle();

    const pastedBody = editor.querySelector('.body');
    select(pastedBody, 6, 40);
    const wantedD = window.getSelection().toString().trim();
    await settle();
    check('D1 the pending context tracks the current selection',
      Boolean(pendingContext) && pendingContext.quote === wantedD,
      () => `selected ${JSON.stringify(wantedD.slice(0, 40))}, context holds ${JSON.stringify(String(pendingContext && pendingContext.quote).slice(0, 40))}`);
    check('D2 a selection in the prose is treated as prose',
      Boolean(pendingContext) && pendingContext.kind === 'prose',
      () => `kind=${pendingContext && pendingContext.kind}`);

    await ask();
    const idD = newestComment();
    check('D3 the recorded quote is the text that was selected',
      Boolean(state.comments[idD]) && state.comments[idD].quote === wantedD,
      () => `recorded ${JSON.stringify(String(state.comments[idD] && state.comments[idD].quote).slice(0, 40))}`);

    /* ============ E: a highlight inside a card survives the card redrawing === */
    createEntry('Repro E', 'Repro E');
    await settle();
    type(PARA);
    await settle();
    select(editor, PARA.length - 46, PARA.length);
    await ask();
    const parentId = newestComment();

    const cardBody = document.querySelector(`#stack .card[data-comment-id="${parentId}"] .body`);
    check('E1 the parent card has a rendered body to question', Boolean(cardBody),
      () => `stack holds ${document.querySelector('#stack').innerHTML.slice(0, 120)}`);
    if (cardBody) {
      select(cardBody, 4, 30);
      await ask();
      const childId = Object.keys(state.comments).filter(k => state.comments[k].parentId === parentId)[0];
      check('E2 questioning a card records it as a child of that card', Boolean(childId));
      /* The card the question was asked about is no longer on screen — asking
         navigates to the new child card — so what has to survive is the anchor
         itself, stored as offsets into the parent's text. */
      const anchor = state.comments[childId] && state.comments[childId].anchor;
      check('E3 the question records where in the card it was asked',
        Boolean(anchor) && anchor.end > anchor.start,
        () => `anchor=${JSON.stringify(anchor)}`);

      /* walk back to the parent card, which rebuilds its body from scratch */
      document.querySelector('#stackBack').click();
      await settle();
      const rebuilt = document.querySelector(`#stack .card[data-comment-id="${parentId}"] .body mark.hl[data-comment-id="${childId}"]`);
      check('E4 the anchor is rebuilt when the card is redrawn', Boolean(rebuilt));
      check('E5 it is rebuilt over the text it was asked about',
        Boolean(rebuilt) && rebuilt.textContent.trim() === state.comments[childId].quote,
        () => `rebuilt over ${JSON.stringify(rebuilt && rebuilt.textContent)}, quote ${JSON.stringify(state.comments[childId].quote)}`);
    }

    /* ============ F: paste arrives as text, not as markup ==================== */
    createEntry('Repro F', 'Repro F');
    await settle();
    type('Before. ');
    await settle();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'pasted answer text');
    dt.setData('text/html', '<div class="body"><p>pasted answer text</p></div>');
    editor.focus();
    caretAtEndOf(editor);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await settle();
    check('F1 pasted text lands in the prose', editor.textContent.includes('pasted answer text'),
      () => `prose is ${JSON.stringify(editor.textContent.slice(0, 60))}`);
    check('F2 pasted markup does not', editor.querySelectorAll('.body, .card, p').length === 0,
      () => `editor holds ${editor.innerHTML.slice(0, 120)}`);

    /* ============ G: putting a lost highlight back ========================== */
    /* An entry shaped exactly like the damaged ones on disk: checks on record,
       prose with no marks in it. */
    const GP = 'Modules are cached. The search path is configurable. Modules are cached.';
    const orphan = (id, quote) => ({ id, quote, verdict: 'solid', body: 'A note about it.',
      parentId: null, targetKind: 'prose', pending: false });

    createEntry('Repro G', 'Repro G');
    await settle();
    let g = activeEntry();
    g.editorHTML = `<div>${GP}</div>`;
    g.comments = {
      c1: orphan('c1', 'The search path is configurable.'),   // appears once
      c2: orphan('c2', 'Modules are cached.'),                // appears twice
      c3: orphan('c3', 'Nothing in the page says this.'),     // gone entirely
    };
    g.order = ['c1', 'c2', 'c3'];
    g.seq = 4;
    loadEntry(g.id);
    await settle();

    check('G1 a check with no highlight is noticed', marks().length === 0 &&
      !document.querySelector('#repair').hidden);
    check('G2 nothing is put back without being asked',
      editor.querySelectorAll('mark.hl').length === 0);

    document.querySelector('#repairDo').click();
    await settle();

    check('G3 an unambiguous check is put back', marksFor('c1').length === 1,
      () => `${marksFor('c1').length} mark(s)`);
    check('G4 it is put back over its own text',
      (marksFor('c1')[0] || {}).textContent === 'The search path is configurable.',
      () => `landed on ${JSON.stringify((marksFor('c1')[0] || {}).textContent)}`);
    check('G5 an ambiguous check is left alone', marksFor('c2').length === 0,
      () => `${marksFor('c2').length} mark(s)`);
    check('G6 a check whose text is gone is left alone', marksFor('c3').length === 0);
    check('G7 the prose is not disturbed', editor.textContent.trim() === GP);

    const savedG = JSON.parse(serializeLibrary()).library.find(x => x.id === state.activeId);
    check('G8 the restored anchor survives a save',
      savedG.editorHTML.includes('data-comment-id="c1"'));
    check('G9 what could not be placed is still reported',
      !document.querySelector('#repair').hidden &&
      document.querySelector('#repairText').textContent.includes('could not be put back'),
      () => `bar reads ${JSON.stringify(document.querySelector('#repairText').textContent)}`);
    check('G10 restoring is not offered again once it has been tried',
      document.querySelector('#repairDo').hidden);

    document.querySelector('#repairSkip').click();
    await settle();
    check('G11 the notice can be dismissed', document.querySelector('#repair').hidden);

    /* Several checks can quote the same span — the stale-context bug filed three
       at a time that way. All of them are put back, nested on the one span,
       rather than dropping the ones that arrived later: an anchored check the
       reader has to dig for beats a check with no highlight at all. */
    createEntry('Repro G2', 'Repro G2');
    await settle();
    g = activeEntry();
    g.editorHTML = `<div>${GP}</div>`;
    g.comments = {
      c1: orphan('c1', 'The search path is configurable.'),
      c2: orphan('c2', 'The search path is configurable.'),
    };
    g.order = ['c1', 'c2'];
    g.seq = 3;
    loadEntry(g.id);
    await settle();
    document.querySelector('#repairDo').click();
    await settle();
    check('G12 checks quoting the same span are all put back',
      marksFor('c1').length === 1 && marksFor('c2').length === 1);
    check('G13 the span itself is not duplicated', editor.textContent.trim() === GP);

    /* ============ H: a question asked about a card, from before anchors ====== */
    createEntry('Repro H', 'Repro H');
    await settle();
    let h = activeEntry();
    h.editorHTML = `<div><mark class="hl note" data-comment-id="c1" data-len="18">The search path is</mark> configurable.</div>`;
    h.comments = {
      c1: { id: 'c1', quote: 'The search path is', verdict: 'imprecise',
            body: 'Configurable through sys.path, which is built at startup.',
            parentId: null, targetKind: 'prose', pending: false },
      c2: { id: 'c2', quote: 'built at startup', verdict: 'solid', body: 'Yes.',
            parentId: 'c1', targetKind: 'comment', pending: false },   // no anchor: legacy
    };
    h.order = ['c1'];
    h.seq = 3;
    loadEntry(h.id);
    await settle();
    openComment('c1');
    await settle();
    const rebuiltH = document.querySelector('#stack .card[data-comment-id="c1"] .body mark.hl[data-comment-id="c2"]');
    check('H1 a card question with no stored anchor is found by its quote', Boolean(rebuiltH),
      () => `card body is ${JSON.stringify((document.querySelector('#stack .card[data-comment-id="c1"] .body') || {}).textContent)}`);
    check('H2 it lands on the text it quoted',
      Boolean(rebuiltH) && rebuiltH.textContent === 'built at startup',
      () => `landed on ${JSON.stringify(rebuiltH && rebuiltH.textContent)}`);

    note(`${failed} failing assertion(s)`);
  }

  function report() {
    const pre = document.createElement('pre');
    pre.id = 'recall-test-results';
    pre.textContent = log.join('\n');
    document.body.appendChild(pre);
    document.title = failed ? `FAILED ${failed}` : 'PASSED';
  }

  window.addEventListener('load', () => {
    run().catch(e => check('driver completed', false, String((e && e.stack) || e)))
         .then(report);
  });
})();
