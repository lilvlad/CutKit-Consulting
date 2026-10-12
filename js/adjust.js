// CutKit: New Adjustment Layer (sidebar button). Over the selected clips at their length, or S.adjLen seconds from
// the playhead, on the first free video track above the footage (host: CK_adjustmentLayer).
(function () {
  const CK = window.CK, A = CK.app, $ = A.$;
  const tpl = () => CK.dataDir ? CK.path.join(CK.dataDir, 'Adjustment Layer.prproj') : null;
  const len = () => Math.max(1, Number(CK.settings.adjLen) || 7);
  const secs = t => (Math.round(t * 10) / 10).toString().replace(/\.0$/, '') + ' s';

  function hint() {
    $('#rail-adj').title = 'New Adjustment Layer: over the selected clips (same length), or ' + secs(len()) +
      ' from the playhead when nothing is selected. Lands on the first free video track above the footage.\nShift-click: with a Transform effect on it.';
  }

  async function make(e) {
    const fx = e && e.shiftKey ? 'Transform' : null;
    const b = $('#rail-adj');
    if (b.classList.contains('working')) return;
    if (!CK.inPR) { A.status('Preview mode: open CutKit inside Premiere Pro to add an adjustment layer.'); return; }
    b.classList.add('working');
    try {
      if (CK.dataDir) CK.fs.mkdirSync(CK.dataDir, { recursive: true });
      const r = await CK.host('CK_adjustmentLayer', { len: len(), tpl: tpl(), fx });
      if (!r.ok) {
        if (r.error === 'NOADJ') {
          A.status('Premiere\'s scripting can\'t make the first adjustment layer. Make one once (File › New › Adjustment Layer), ' +
            'then click again: CutKit keeps a copy and brings it into every project after that.', 'err');
        } else A.status(r.error, 'err');
        return;
      }
      const fxNote = !fx ? '' : r.fx === 'ok' ? ' With Transform.' : ' ' + r.fx;
      A.status('Adjustment layer on V' + (r.track + 1) + ', ' + secs(r.t1 - r.t0) +
        (r.fromSel ? ' over the selection.' : ' from the playhead.') + fxNote +
        (r.saved ? ' CutKit saved a copy, so new projects get one too.' : ''), fx && r.fx !== 'ok' ? 'err' : 'ok');
      b.classList.remove('done'); void b.offsetWidth; b.classList.add('done');
    } finally { b.classList.remove('working'); }
  }

  A.on('ready', () => {
    $('#rail-adj').onclick = make;
    const f = $('#set-adj-len');
    f.value = len();
    f.onchange = () => { CK.settings.adjLen = Number(f.value); CK.settings.adjLen = f.value = len(); CK.save(); hint(); };
    hint();
  });
})();
