// CutKit Takes tab: every part that was recorded more than once (from Claude's structure pass), with all its takes.
// Click a take to hear it in Premiere (the playhead lands on it); "Keep" picks the take that stays, the others are cut.
(function () {
  const CK = window.CK, A_ = CK.app, D = CK.detect;
  const { st, $, esc } = A_;
  const pane = $('#pane-takes');
  const open = new Set();

  function render() {
    const A = st.A, parts = st.parts;
    $('#b-takes').textContent = parts.length || '';
    if (!A) { pane.innerHTML = '<p class="empty">Analyze a sequence first. Claude then lists every part that was recorded more than once.</p>'; return; }
    if (st.takes === 'busy') { pane.innerHTML = '<p class="empty">Claude is reading the shoot…</p>'; return; }
    if (!parts.length) {
      pane.innerHTML = '<p class="empty">' + (st.takes === 'done' ? 'No part was recorded more than once.' :
        'Tick <b>Retakes &amp; False Starts</b> in the Cut tab to let Claude find repeated takes.') + '</p>';
      return;
    }
    const W = A.words, text = (a, b) => W.slice(a, b + 1).map(w => w.w).join(' ');
    let html = '<p class="small-note">Claude keeps the last complete take of each part. Click a take to hear it in Premiere (press Space there), ' +
      '<b>Keep</b> to choose another one. The takes not kept are cut with the Cut tab\'s <b>Cut Sequence</b>.</p>';
    const off = st.offtakes();
    if (off.length) html += '<p class="small-note">Also cut: ' + off.length + ' stretch' + (off.length === 1 ? '' : 'es') + ' of talk between takes (' + D.fmt(off.reduce((n, c) => n + W[c.b].t1 - W[c.a].t0, 0)) + ').</p>';
    parts.forEach((p, pi) => {
      const kept = p.takes[p.keep], isOpen = open.has(pi) || parts.length <= 3;
      html += '<div class="card"><div class="card-head" data-part="' + pi + '"><span class="t">' + esc(p.name) + '</span>' +
        '<span class="n">' + p.takes.length + ' takes · keeping ' + (p.keep + 1) + ' · ' + D.fmt(W[kept.a].t0) + '</span><span class="n">' + (isOpen ? '▾' : '▸') + '</span></div>';
      if (isOpen) p.takes.forEach((t, ti) => {
        const len = Math.max(0, W[t.b].t1 - W[t.a].t0), keep = ti === p.keep, gone = W[t.a].gone && W[t.b].gone;
        html += '<div class="item' + (keep ? ' keep' : t.off ? '' : ' dim') + '" data-part="' + pi + '" data-take="' + ti + '">' +
          '<span class="time" data-jump title="Move Premiere\'s playhead here">' + D.fmt(W[t.a].t0, true) + '</span>' +
          '<span class="txt" data-jump title="' + esc(text(t.a, t.b)) + '">' + (ti + 1) + '. ' + esc(text(t.a, Math.min(t.b, t.a + 14))) + (t.b > t.a + 14 ? '…' : '') + '</span>' +
          '<span class="n">' + len.toFixed(1) + ' s</span>' +
          (gone ? '<span class="n">cut</span>' : '<button class="keep-btn" data-keep>' + (keep ? '✓ Kept' : 'Keep') + '</button>') + '</div>';
      });
      html += '</div>';
    });
    pane.innerHTML = html;
  }

  pane.addEventListener('click', e => {
    const head = e.target.closest('.card-head');
    if (head) { const pi = Number(head.dataset.part); if (open.has(pi)) open.delete(pi); else open.add(pi); render(); return; }
    const it = e.target.closest('.item');
    if (!it) return;
    const p = st.parts[Number(it.dataset.part)], ti = Number(it.dataset.take), t = p.takes[ti];
    if (e.target.closest('[data-keep]')) {
      p.keep = ti; p.takes.forEach(x => { delete x.off; });
      A_.rebuildTakes(); A_.update(); render();
      A_.status('Keeping take ' + (ti + 1) + ' of "' + p.name + '"; the other ' + (p.takes.length - 1) + ' will be cut.', 'ok');
    } else if (e.target.closest('[data-jump]')) {
      const W = st.A.words, a = W[t.a].t0, b = W[t.b].t1;
      A_.setView(a - 2, b + 2);
      A_.jump(a);
    }
  });

  st.offtakes = () => st.words.filter(c => c.kind === 'offtake');
  A_.on('analyzed', render); A_.on('takes', render); A_.on('cut', render); A_.on('tab', t => { if (t === 'takes') render(); });
  A_.on('ready', render);
})();
