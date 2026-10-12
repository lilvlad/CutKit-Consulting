// CutKit Swears tab: every swear word with its context. Tick the ones to treat, then mark them (red markers),
// mute them (the audio under the word is split out and switched off on every audio track) or bleep them
// (muted, plus a beep of the same length on an empty audio track). Your own block / allow lists refine the finder.
(function () {
  const CK = window.CK, A_ = CK.app, D = CK.detect, M = CK.media;
  const { st, S, $, esc } = A_;
  const pane = $('#pane-swears');
  st.swearOff = new Set();      // word indexes unticked by hand

  function render() {
    const A = st.A, list = st.swears || [];
    $('#b-swears').textContent = list.length || '';
    let html = '';
    if (!A) html = '<p class="empty">Analyze a sequence first.</p>';
    else if (!list.length) html = '<p class="empty">No swear words found' + (A.rounds ? ' in what\'s left of the sequence' : '') + '.</p>';
    else {
      const W = A.words, on = list.filter(i => !st.swearOff.has(i)).length;
      html += '<div class="actions">' +
        '<button class="btn small" id="sw-mark" title="A red marker on each ticked word">Red Markers</button>' +
        '<button class="btn small" id="sw-mute" title="Switch off the audio under each ticked word, on every audio track (splits the audio around it; switch the piece back on in Premiere to undo)">Mute</button>' +
        '<button class="btn small" id="sw-bleep" title="Mute, plus a beep of the same length on the first empty audio track">Bleep</button>' +
        '<span class="small-note" style="margin:3px 0 0">' + on + ' of ' + list.length + ' ticked</span></div>';
      html += '<div class="card">' + list.map(i => {
        const ctx = W.slice(Math.max(0, i - 4), i).filter(w => !w.gone).map(w => esc(w.w)).join(' ') + ' <b style="color:#e5484d">' + esc(W[i].w) + '</b> ' +
          W.slice(i + 1, i + 5).filter(w => !w.gone).map(w => esc(w.w)).join(' ');
        return '<div class="item' + (st.swearOff.has(i) ? ' dim' : '') + '" data-i="' + i + '"><input type="checkbox" data-tick' + (st.swearOff.has(i) ? '' : ' checked') + '>' +
          '<span class="time" data-jump>' + D.fmt(W[i].t0, true) + '</span><span class="txt" data-jump>' + ctx + '</span></div>';
      }).join('') + '</div>';
    }
    html += '<h2>Your Words</h2>' +
      '<label class="small-note" style="display:block">Also catch (comma separated; end with * for any ending, e.g. <i>bloody, crap*</i>)</label>' +
      '<textarea id="sw-block" rows="2" spellcheck="false">' + esc(S.swearBlock || '') + '</textarea>' +
      '<label class="small-note" style="display:block;margin-top:8px">Never flag (e.g. <i>damn, hell</i>)</label>' +
      '<textarea id="sw-allow" rows="2" spellcheck="false">' + esc(S.swearAllow || '') + '</textarea>' +
      '<p class="small-note">Built in: the common English swear words (also starred ones like f***) and common Russian/Ukrainian ones.</p>';
    pane.innerHTML = html;
  }

  function ticked() {
    const A = st.A;
    return (st.swears || []).filter(i => !st.swearOff.has(i) && !A.words[i].gone);
  }
  // the time ranges of the ticked words, padded a little so the start and end of the word are covered
  function ranges() {
    const A = st.A, f = A.frame, out = [];
    ticked().forEach(i => {
      const w = A.words[i];
      let a = Math.max(0, Math.floor((w.t0 - 0.03) / f) * f), b = Math.ceil((w.t1 + 0.03) / f) * f;
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([Number(a.toFixed(6)), Number(b.toFixed(6))]);
    });
    return out;
  }
  // a short 1 kHz beep, made once with ffmpeg
  async function beepFile() {
    const f = CK.path.join(CK.dataDir, 'assets', 'CutKit Beep.wav');
    if (CK.fs.existsSync(f)) return f;
    CK.fs.mkdirSync(CK.path.dirname(f), { recursive: true });
    const r = await M.run(M.ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=5', '-af', 'volume=-14dB', '-ar', '48000', '-ac', '2', f]);
    if (r.code !== 0) throw new Error('Couldn\'t make the beep sound: ' + r.err);
    return f;
  }
  async function treat(kind, auto) {
    const A = st.A, R = ranges();
    if (!R.length) return null;
    const ok = auto || await A_.confirmBox(kind === 'mute' ? 'Mute ' + R.length + ' words?' : 'Bleep ' + R.length + ' words?',
      '<p>' + (kind === 'mute' ? 'The audio under each word is split out and switched off on every audio track.' :
        'The audio under each word is switched off on every audio track, and a beep goes on the first empty audio track.') +
      ' To undo one, select its piece in Premiere and switch it back on (Shift+E), or use Edit &gt; Undo.</p>', kind === 'mute' ? 'Mute' : 'Bleep', true);
    if (!ok) return null;
    if (A.demo) { A_.status('Preview mode: would ' + kind + ' ' + R.length + ' words.', 'ok'); return { ok: true, n: R.length }; }
    try {
      const r = kind === 'mute' ? await CK.host('CK_mute', { ranges: R, seqId: A.id })
        : await CK.host('CK_bleep', { ranges: R, seqId: A.id, path: await beepFile(), track: -1 });
      if (!r.ok) { A_.status(r.error, 'err'); return r; }
      A_.status(kind === 'mute' ? 'Muted ' + R.length + ' words (' + r.muted + ' audio pieces switched off).' :
        'Bleeped ' + R.length + ' words: ' + r.placed + ' beeps on A' + (r.track + 1) + ', ' + r.muted + ' audio pieces switched off.', 'ok');
      return Object.assign(r, { n: R.length });
    } catch (e) { A_.status(e.message, 'err'); return { ok: false, error: e.message }; }
  }
  A_.swearTreat = treat;

  pane.addEventListener('click', e => {
    if (e.target.id === 'sw-mark') { A_.markSwears(); return; }
    if (e.target.id === 'sw-mute') { treat('mute'); return; }
    if (e.target.id === 'sw-bleep') { treat('bleep'); return; }
    const it = e.target.closest('.item');
    if (!it) return;
    const i = Number(it.dataset.i);
    if (e.target.closest('[data-tick]')) { if (st.swearOff.has(i)) st.swearOff.delete(i); else st.swearOff.add(i); render(); }
    else if (e.target.closest('[data-jump]')) { const w = st.A.words[i]; A_.setView(w.t0 - 3, w.t1 + 3); A_.jump(Math.max(0, w.t0 - 1)); }
  });
  pane.addEventListener('input', e => {
    if (e.target.id !== 'sw-block' && e.target.id !== 'sw-allow') return;
    S[e.target.id === 'sw-block' ? 'swearBlock' : 'swearAllow'] = e.target.value;
    CK.save();
    clearTimeout(pane.t);
    pane.t = setTimeout(() => {          // re-find once typing pauses, keeping the cursor in the box
      if (!st.A) return;
      st.swears = D.swears(st.A);
      const id = e.target.id, pos = e.target.selectionStart;
      render(); A_.update();
      const el = $('#' + id); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }, 600);
  });

  A_.on('analyzed', () => { st.swearOff = new Set(); render(); });
  A_.on('cut', render); A_.on('ready', render); A_.on('tab', t => { if (t === 'swears') render(); });
})();
