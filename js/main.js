// CutKit panel: analyse the active sequence, review the planned cuts on the transcript, then cut it in place.
(function () {
  const CK = window.CK, D = CK.detect, M = CK.media, S = CK.settings;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const st = {
    info: null,       // CK_seqInfo of the sequence when it was last read
    A: null,          // the analysis (see detect.js)
    words: [],        // word cuts: fillers, Claude's takes and cuts by hand ({ kind, a, b, off })
    sil: [],          // silence cuts for the current settings
    silOff: new Set(),// silence cuts switched off by hand (by id)
    takes: 'none',    // Claude: none | busy | done | failed
    parts: [],        // repeated parts from Claude: [{ name, takes: [{ a, b, off }], keep }] (the Takes tab)
    takeCuts: [],     // cuts made from parts: every take but the kept one
    busy: false, cancel: false, last: null, ph: null
  };
  CK.state = st;   // for debugging from tools/cdp.js

  // ---------- status, progress, modal ----------
  let statusT = null;
  function status(msg, kind) {
    const el = $('#status');
    el.textContent = msg || ''; el.title = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    clearTimeout(statusT);
    if (kind === 'ok') statusT = setTimeout(() => { el.textContent = 'Ready.'; el.className = 'status'; }, 8000);
  }
  function prog(pct, text) {
    const p = $('#prog');
    if (pct === false) { p.hidden = true; return; }
    p.hidden = false;
    p.classList.toggle('indet', pct == null);
    if (pct != null) $('#prog-bar').style.width = Math.round(pct * 100) + '%';
    if (text != null) $('#prog-text').textContent = text;
  }
  function confirmBox(title, html, okLabel, danger) {
    return new Promise(resolve => {
      const m = $('#modal'), ok = $('#modal-ok');
      $('#modal-title').textContent = title;
      $('#modal-body').innerHTML = html;
      ok.textContent = okLabel; ok.className = 'btn ' + (danger ? 'danger' : 'primary');
      m.hidden = false; ok.focus();
      const done = v => { m.hidden = true; ok.onclick = $('#modal-cancel').onclick = m.onkeydown = null; resolve(v); };
      ok.onclick = () => done(true);
      $('#modal-cancel').onclick = () => done(false);
      m.onkeydown = e => { if (e.key === 'Escape') done(false); };
    });
  }
  const tip = $('#tip');
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(x - w / 2, innerWidth - w - 6)) + 'px';
    tip.style.top = (y - h - 10 > 4 ? y - h - 10 : y + 18) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };
  const kStyle = k => { const c = D.KINDS[k].color; return '--k:' + c + ';--kb:' + rgba(c, 0.14); };

  // ---------- the sequence ----------
  async function readSeq(quiet) {
    if (!CK.inPR) return;
    const r = await CK.host('CK_seqInfo');
    if (!r.ok) { if (!quiet) status(r.error, 'err'); return; }
    st.info = r;
    st.io = r.io;
    $('#seq-name').textContent = r.name;
    const sel = $('#ref-track'), audio = r.tracks.filter(t => t.kind === 'A');
    const prev = sel.value || S.refTrack;
    sel.innerHTML = audio.map(t => '<option value="' + t.index + '">A' + (t.index + 1) + (t.name && !/^Audio \d+$/.test(t.name) ? ' · ' + esc(t.name) : '') +
      ' (' + (t.clips.length ? t.clips.length + ' clip' + (t.clips.length > 1 ? 's' : '') : 'empty') + ')</option>').join('');
    const pick = audio.find(t => String(t.index) === String(prev) && t.clips.length) || audio.find(t => t.clips.length) || audio[0];
    if (pick) sel.value = pick.index;
    innerOptions();
    checkSeq(r.id, r.name);
  }
  // When the voice track holds nested sequences: which audio track inside them has the voice.
  function innerOptions() {
    const t = st.info && st.info.tracks.find(x => x.kind === 'A' && String(x.index) === $('#ref-track').value);
    const row = $('#inner-row'), sel = $('#inner-track');
    if (!t || !t.inner) { row.hidden = true; return; }
    row.hidden = false;
    $('#inner-name').textContent = t.inner.name;
    const list = t.inner.tracks.filter(x => x.clips);
    sel.innerHTML = list.map(x => '<option value="' + x.index + '">A' + (x.index + 1) + (x.name && !/^Audio \d+$/.test(x.name) ? ' · ' + esc(x.name) : '') + '</option>').join('');
    const want = list.find(x => x.index === S.innerTrack) || list[0];
    if (want) sel.value = want.index;
  }
  function checkSeq(id, name) {
    const w = $('#seq-warn');
    if (st.A && id && id !== st.A.id) { w.hidden = false; w.textContent = 'This analysis is for "' + st.A.name + '". Open it again to cut, or Analyze "' + name + '".'; }
    else w.hidden = true;
    $('#cut').disabled = !st.A || st.busy || !w.hidden;
  }

  // ---------- analysis ----------
  async function analyze() {
    if (st.busy) { st.cancel = true; M.stop(); CK.claude.stop(); return; }
    if (!CK.inPR) { loadDemo(); return; }
    for (const [ok, msg] of [[M.ffmpeg(), 'ffmpeg isn\'t installed. Run "Install CutKit on Mac.command" again.'], [M.whisper(), 'Whisper isn\'t installed. Run "Install CutKit on Mac.command" again.'], [M.model(), 'The Whisper model is missing. Run "Install CutKit on Mac.command" again.']]) {
      if (!ok) { status(msg, 'err'); return; }
    }
    await readSeq();
    const info = st.info;
    if (!info) return;
    const track = info.tracks.find(t => t.kind === 'A' && String(t.index) === $('#ref-track').value);
    if (!track || !track.clips.length) { status('That track has no clips. Pick the track with the voice.', 'err'); return; }
    S.refTrack = track.index;
    const inner = track.inner ? Number($('#inner-track').value) : null;
    if (track.inner) S.innerTrack = inner;
    CK.save();
    // the media files the track plays, following nested sequences down to them
    const src = await CK.host('CK_sources', { track: track.index, inner });
    if (!src.ok) { status(src.error, 'err'); return; }
    const clips = src.sources.filter(c => c.s1 - c.s0 > 0.1)
      .map(c => ({ path: c.path, inPoint: c.mIn, outPoint: c.mOut, start: c.s0, end: c.s1, name: c.name }));
    const skipped = src.skipped;
    if (!clips.length) { status('No audio to analyse on A' + (track.index + 1) + (track.inner ? ' (inside "' + track.inner.name + '")' : '') + '. Sped-up clips are skipped.', 'err'); return; }

    busy(true);
    const segs = [], words = [];
    const end = info.end, n = Math.ceil(end / M.STEP) + 2;
    const env = new Float32Array(n).fill(-Infinity), hf = new Float32Array(n).fill(-Infinity), speech = new Uint8Array(n);
    let hasVad = true;
    // Word Timing (Settings): 'crisper' = CrisperWhisper writes the transcript; 'align' = Whisper + the aligner;
    // 'whisper' = Whisper's own anchors (the old way). Falls back when the chosen one isn't installed.
    const eng = M.engines(), engine = S.wordEngine === 'crisper' && eng.crisper ? 'crisper' : S.wordEngine !== 'whisper' && eng.align ? 'align' : 'whisper';
    // Pieces of the same file are read and transcribed once, as one stretch from the first to the last piece
    // (a cut sequence has hundreds of pieces of one camera file; this also reuses the transcript from before the cut).
    const groups = [];
    for (const c of clips) {
      let g = groups.find(x => x.path === c.path && c.inPoint < x.out + 600 && c.outPoint > x.in - 600);
      if (!g) groups.push(g = { path: c.path, in: c.inPoint, out: c.outPoint, pieces: [] });
      g.in = Math.min(g.in, c.inPoint); g.out = Math.max(g.out, c.outPoint); g.pieces.push(c);
    }
    try {
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i], len = g.out - g.in;
        const slow = engine === 'crisper' ? '(CrisperWhisper takes a while on long files, once) ' : len > 600 ? '(' + D.fmt(len) + ' long, Whisper takes a few minutes) ' : '';
        const label = (groups.length > 1 ? 'File ' + (i + 1) + '/' + groups.length + ': ' : '') + slow;
        const part = (a, b) => p => prog((i + a + (b - a) * p) / groups.length, null);
        const dir = M.cacheDir(g.path, g.in, g.out);
        prog(i / groups.length, label + 'Reading the audio…');
        const wav = await M.extract(g.path, g.in, g.out, dir, part(0, 0.05));
        if (st.cancel) throw new Error('stopped');
        Object.assign(g, M.levels(wav));
        prog(null, label + 'Listening for speech…');
        g.vad = await M.vad(wav, dir);
        if (!g.vad) hasVad = false;
        if (engine === 'crisper') {
          prog(null, label + 'Transcribing with CrisperWhisper…');
          const T = await M.wordTimes('crisper', wav, dir, p => prog((i + 0.05 + 0.95 * p) / groups.length, label + 'Transcribing with CrisperWhisper… ' + Math.round(p * 100) + '%'));
          // [UM] / [UH] become plain fillers; other sounds ([laughter], [cough]) stay as words, so they're never cut as silence
          g.words = T.filter(w => w.t0 != null).map(w => ({ w: /^\[(um+|uh+|er+m?|ah+|hm+)\]$/i.test(w.w) ? w.w.slice(1, -1).toLowerCase() : w.w, at: w.t0 + 0.02, r0: w.t0, r1: w.t1, score: w.score }));
        } else {
          const wEnd = engine === 'align' ? 0.6 : 1;
          prog(null, label + 'Transcribing with Whisper…');
          g.words = await M.transcribe(wav, dir, p => prog((i + 0.05 + (wEnd - 0.05) * p) / groups.length, label + 'Transcribing… ' + Math.round(p * 100) + '%'));
          if (engine === 'align') {
            if (st.cancel) throw new Error('stopped');
            const T = await M.wordTimes('align', wav, dir, p => prog((i + wEnd + (1 - wEnd) * p) / groups.length, label + 'Timing every word… ' + Math.round(p * 100) + '%'));
            // the aligner's edges run a little late at the start and early at the end (20 ms frames): 30 ms more room each side
            g.words = g.words.map((w, k) => T[k] && T[k].t0 != null && T[k].w === w.w ? Object.assign({}, w, { r0: Math.max(0, T[k].t0 - 0.03), r1: T[k].t1 + 0.03, score: T[k].score }) : w);
          }
        }
        if (st.cancel) throw new Error('stopped');
      }
      // lay every piece onto the sequence timeline, in timeline order
      const pieces = [];
      groups.forEach(g => g.pieces.forEach(c => pieces.push({ c, g })));
      pieces.sort((x, y) => x.c.start - y.c.start);
      for (const { c, g } of pieces) {
        const k0 = Math.round((c.inPoint - g.in) / M.STEP), k1 = Math.round((c.outPoint - g.in) / M.STEP), off = Math.round(c.start / M.STEP) - k0;
        for (let k = Math.max(0, k0); k < k1 && k < g.env.length; k++) if (off + k >= 0 && off + k < n) { env[off + k] = g.env[k]; hf[off + k] = g.hf[k]; }
        for (const [a, b] of g.vad || []) for (let k = Math.max(k0, Math.round(a / M.STEP)), e = Math.min(k1, Math.round(b / M.STEP)); k < e; k++) if (off + k >= 0 && off + k < n) speech[off + k] = 1;
        segs.push({ start: c.start, end: c.end, name: c.name });
        const tl = t => c.start + (g.in + t - c.inPoint);                 // seconds in the WAV → on the timeline
        for (const w of g.words) {
          const mt = g.in + w.at;
          if (mt >= c.inPoint && mt < c.outPoint - 0.02) {
            const at = tl(w.at);
            words.push({ w: w.w, at, t0: at, t1: at, seg: segs.length - 1, m0: w.r0 != null ? Math.max(c.start, tl(w.r0)) : null, m1: w.r1 != null ? Math.min(c.end, tl(w.r1)) : null, score: w.score });
          }
        }
      }
    } catch (e) {
      busy(false);
      prog(false);
      status(e.message === 'stopped' ? 'Stopped.' : e.message, e.message === 'stopped' ? '' : 'err');
      return;
    }
    st.A = { id: info.id, name: info.name, end, frame: info.frame, env, hf, speech: hasVad ? speech : null, segs, words, engine };
    if (S.thrAuto) S.thr = D.autoThr(st.A);
    // Whisper's anchors give every word a first guess; measured times (aligner / CrisperWhisper) replace it
    D.placeWords(st.A, D.autoThr(st.A));
    for (const w of words) {
      if (w.m0 != null && w.m1 != null) { w.t0 = w.m0; w.t1 = Math.max(w.m1, w.m0 + 0.04); w.measured = true; }   // a word can come back 0 s long
      delete w.m0; delete w.m1;
    }
    D.fillUnmeasured(words);
    for (const w of words) { w.r0 = w.t0; w.r1 = w.t1; delete w.measured; }
    D.prepare(st.A, S);
    st.words = D.fillers(st.A, fillerList());
    st.swears = D.swears(st.A);
    st.silOff.clear();
    st.takes = 'none'; st.parts = []; st.takeCuts = [];
    st.view = null; st.navI = null; st.lastCut = null; st.hist = null;
    busy(false);
    prog(false);
    showResults();
    CK.app.emit('analyzed');
    status('Analyzed ' + words.length + ' words' + (skipped ? ' (' + skipped + ' clip' + (skipped > 1 ? 's' : '') + ' skipped: sped up or no file)' : '') + '.', 'ok');
    if (S.takes) findTakes();
  }

  async function findTakes() {
    if (st.A && st.takes !== 'busy' && st.takes !== 'done') setTimeout(() => CK.app.emit('takes'), 0);
    if (!st.A || st.takes === 'busy' || st.takes === 'done') return;
    if (!st.A.words.length) { st.takes = 'done'; update(); return; }
    st.takes = 'busy';
    update();
    status('Claude is reading the transcript for takes…', 'busy');
    try {
      const res = st.A.demo ? await CK.demo.takes() : await CK.claude.takes(st.A.words, (p, text) => { if (text) status(text, 'busy'); });
      // older cached answers were a plain list of cuts
      const found = Array.isArray(res) ? res : res.cuts, parts = Array.isArray(res) ? [] : res.parts.map(p => ({ name: p.name, keep: p.keep, takes: p.takes.map(t => ({ a: t.a, b: t.b })) }));
      st.parts = parts;
      rebuildTakes();
      // a word belongs to one cut: Claude's ranges win over single fillers inside them
      const big = found.concat(st.takeCuts);
      st.words = st.words.filter(c => c.kind !== 'filler' || !big.some(t => c.a >= t.a && c.b <= t.b)).concat(found);
      st.takes = 'done';
      const nt = st.takeCuts.length, no = found.filter(c => c.kind === 'offtake').length, small = found.length - no;
      status('Claude found ' + parts.length + ' repeated part' + (parts.length === 1 ? '' : 's') + ' (' + nt + ' earlier take' + (nt === 1 ? '' : 's') + '), ' + no + ' between-takes part' + (no === 1 ? '' : 's') +
        ' and ' + small + ' small retake' + (small === 1 ? '' : 's') + ' / false start' + (small === 1 ? '' : 's') + '. See the Takes tab.', 'ok');
      CK.app.emit('takes');
    } catch (e) {
      st.takes = 'failed';
      status(e.message, 'err');
    }
    update();
  }

  function busy(on) {
    st.busy = on; st.cancel = false;
    const b = $('#analyze');
    b.textContent = on ? 'Stop' : (st.A ? 'Analyze Again' : 'Analyze');
    b.className = 'btn ' + (on ? '' : 'primary');
    if (on) status('Analyzing…', 'busy');
    checkSeq();
  }

  // ---------- review ----------
  function showResults() {
    ['#detect', '#strip-wrap', '#transcript', '#foot'].forEach(s => { $(s).hidden = false; });
    $('#intro').hidden = true;
    $('#analyze').textContent = 'Analyze Again';
    syncControls();
    update();
  }
  function syncControls() {
    $('#on-silence').checked = S.silence; $('#on-filler').checked = S.fillers; $('#on-takes').checked = S.takes;
    $('#thr').value = S.thr; $('#thr-auto').checked = S.thrAuto; $('#thr').disabled = S.thrAuto;
    $('#min-sil').value = S.minSil; $('#tail').value = S.tail; $('#lead').value = S.lead; $('#backup').checked = S.backup;
    const tk = D.tightOf(S);
    document.querySelectorAll('#tight button').forEach(b => b.classList.toggle('on', b.dataset.k === tk));
    $('#scope').checked = S.scopeIO;
    $('#sil-opts').hidden = S.silFold === true; $('#sil-fold').classList.toggle('closed', S.silFold === true); $('#sil-fold').setAttribute('aria-expanded', String(S.silFold !== true));
    if (S.xfadeName == null || S.xfadeFrames == null) { const d = CK.premiereDefaults(); S.xfadeName = S.xfadeName || d.name; S.xfadeFrames = S.xfadeFrames || d.frames || 4; }
    $('#xfade').checked = S.xfade; $('#xfade-frames').value = S.xfadeFrames; $('#xfade-len').classList.toggle('off', !S.xfade);
    $('#xfade-label').title = 'Put a ' + S.xfadeName + ' audio transition on every audio cut to smooth it (Premiere\'s default audio transition)';
    scopeInfo();
  }
  // The In/Out scope: [in, out] in seconds when it's on and set in Premiere, else null.
  function scope() {
    const io = st.io;
    if (!S.scopeIO || !io || (io.inP == null && io.outP == null)) return null;
    return [io.inP == null ? 0 : io.inP, io.outP == null ? Infinity : io.outP];
  }
  function scopeInfo() {
    const io = st.io, el = $('#scope-info');
    if (!S.scopeIO) { el.textContent = ''; return; }
    el.textContent = !io || (io.inP == null && io.outP == null) ? 'no In/Out set in Premiere, so the whole sequence' :
      (io.inP == null ? 'start' : D.fmt(io.inP, true)) + ' → ' + (io.outP == null ? 'end' : D.fmt(io.outP, true));
  }

  const enabled = c => c.kind === 'manual' || (c.kind === 'filler' ? S.fillers : S.takes);
  // every word-based cut: fillers, Claude's small fixes and between-takes talk, cuts by hand, and the takes not kept
  const wordCuts = () => st.words.concat(st.takeCuts);
  function rebuildTakes() {
    st.takeCuts = [];
    st.parts.forEach((p, pi) => p.takes.forEach((t, ti) => {
      if (ti !== p.keep) st.takeCuts.push({ kind: 'take', a: t.a, b: t.b, off: !!t.off, part: pi, take: ti, why: p.name + ': take ' + (ti + 1) + ' of ' + p.takes.length + ' (keeping ' + (p.keep + 1) + ')' });
    }));
  }
  function allCuts() {
    const wc = wordCuts();
    wc.forEach(c => { c.on = enabled(c) && !c.off; });
    return st.sil.filter(c => c.on).concat(wc.filter(c => c.on));
  }
  const fillerList = () => String(S.fillerExtra || '').split(',').map(x => x.trim()).filter(Boolean);

  // Redraws at most once per frame (dragging a number box fires many changes).
  let updQueued = false;
  function update() {
    if (updQueued) return;
    updQueued = true;
    // next frame, or after 60 ms if frames are paused (a panel or tab in the background)
    const run = () => { if (!updQueued) return; updQueued = false; updateNow(); };
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }
  function updateNow() {
    const A = st.A;
    if (!A) return;
    st.sil = D.silences(A, { thr: S.thr, thrAuto: S.thrAuto, minSil: S.minSil, tail: S.tail / 1000, lead: S.lead / 1000 });
    st.sil.forEach(c => { c.on = S.silence && !st.silOff.has(c.id); });
    const cuts = allCuts();
    st.ranges = D.ranges(A, cuts, A.frame, scope());
    const removed = st.ranges.reduce((n, r) => n + r[1] - r[0], 0);
    $('#n-silence').textContent = st.sil.filter(c => c.on).length + ' of ' + st.sil.length;
    $('#n-filler').textContent = st.words.filter(c => c.kind === 'filler' && c.on).length || 'none';
    const nt = wordCuts().filter(c => /take|repeat|false_start|stumble/.test(c.kind) && c.on).length;
    const tk = $('#n-takes');
    tk.classList.toggle('busy', st.takes === 'busy');
    tk.textContent = st.takes === 'busy' ? 'Reading…' : st.takes === 'failed' ? 'Failed, untick and tick to retry' : st.takes === 'done' ? (nt || 'none') : '';
    const ns = (st.swears || []).length;
    $('#n-swear').textContent = ns ? ns + ' found' : 'none';
    $('#swear-mark').disabled = !ns || st.busy;
    $('#filler-mark').disabled = !st.words.some(c => c.kind === 'filler' && !c.off) || st.busy;
    ['silence', 'filler', 'takes'].forEach(k => $('#on-' + k).closest('.det').classList.toggle('off', !$('#on-' + k).checked));
    $('#summary').innerHTML = '<span><b>' + st.ranges.length + '</b> cut' + (st.ranges.length === 1 ? '' : 's') + '</span>' +
      '<span>removes <b>' + D.fmt(removed, true) + '</b></span>' +
      '<span>' + D.fmt(A.end) + ' <span class="arrow">→</span> <b>' + D.fmt(A.end - removed) + '</b></span>' +
      (A.rounds ? '<span class="done">already cut ' + D.fmt(A.cutSoFar, true) + ' in ' + A.rounds + ' round' + (A.rounds > 1 ? 's' : '') + '</span>' : '') +
      (D.guarded.length ? '<span class="guard" title="These cuts would have touched a word that stays, so they were trimmed around it: ' + esc(D.guarded.slice(0, 12).map(i => '"' + A.words[i].w + '" at ' + D.fmt(A.words[i].t0, true)).join(', ')) + (D.guarded.length > 12 ? '…' : '') + '">' + D.guarded.length + ' word' + (D.guarded.length === 1 ? '' : 's') + ' protected</span>' : '');
    $('#cut').disabled = !st.ranges.length || st.busy || !$('#seq-warn').hidden;
    drawStrip();
    drawHist();
    navInfo();
    $('#undo-cut').hidden = !st.lastCut;
    renderTranscript(cuts);
  }

  // ---------- transcript ----------
  function renderTranscript() {
    const A = st.A, W = A.words, map = D.wordMap(wordCuts()), sw = new Set(st.swears || []);
    const sil = st.sil.slice().sort((a, b) => a.s - b.s);
    let si = 0, html = '', para = false, seg = -1;
    const pill = c => '<span class="pause' + (c.on ? ' cut' : '') + '" data-sil="' + c.id + '">' + c.len.toFixed(1) + 's</span> ';
    for (let i = 0; i < W.length; i++) {
      const w = W[i];
      const newFile = w.seg !== seg && (seg < 0 || A.segs[w.seg].name !== A.segs[seg].name);
      if (newFile) {
        if (para) html += '</p>';
        if (A.segs.length > 1 && new Set(A.segs.map(g => g.name)).size > 1) html += '<span class="clip-label">' + esc(A.segs[w.seg].name) + ' · ' + D.fmt(A.segs[w.seg].start) + '</span>';
        html += '<p class="para">'; para = true;
      } else if (i && !w.gone && !W[i - 1].gone && w.t0 - W[i - 1].t1 > 1.4) html += '</p><p class="para">';
      seg = w.seg;
      if (w.gone) { html += '<span class="w gone" data-i="' + i + '">' + esc(w.w) + '</span> '; continue; }
      while (si < sil.length && sil[si].s < w.t0 + 0.05) html += pill(sil[si++]);
      const c = map.get(i);
      html += '<span class="w' + (c ? ' cut' : '') + (sw.has(i) ? ' swear' : '') + (w.ghost ? ' ghost' : '') + '" data-i="' + i + '"' + (c ? ' style="' + kStyle(c.kind) + '"' : '') + (w.ghost ? ' title="Probably not said: no voice here, only room tone (Whisper sometimes writes words into silence). It doesn\'t stop a silence cut."' : '') + '>' + esc(w.w) + '</span> ';
    }
    while (si < sil.length) html += pill(sil[si++]);
    if (para) html += '</p>';
    if (!W.length) html = '<p class="hint">Whisper heard no words on this track. Only silences can be cut.</p>' + sil.map(pill).join('');
    const el = $('#transcript'), top = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = top;
    markNow();
  }

  function cutAt(i) { return wordCuts().find(c => c.a <= i && i <= c.b && enabled(c)); }
  function clickWord(i, e) {
    const A = st.A;
    if (A.words[i].gone) return;
    if (e.altKey) { jump(Math.max(0, A.words[i].t0 - 1)); return; }
    if (e.shiftKey && st.last != null) {
      const a = Math.min(st.last, i), b = Math.max(st.last, i);
      st.words = st.words.filter(c => !(c.kind === 'manual' && c.a >= a && c.b <= b));
      st.words.push({ kind: 'manual', a, b });
    } else {
      const c = cutAt(i);
      if (c && c.kind === 'manual') st.words.splice(st.words.indexOf(c), 1);
      else if (c) { c.off = !c.off; if (c.kind === 'take') { st.parts[c.part].takes[c.take].off = c.off; CK.app.emit('takes'); } }
      else {
        const L = st.words.find(x => x.kind === 'manual' && x.b === i - 1), R = st.words.find(x => x.kind === 'manual' && x.a === i + 1);
        if (L && R) { L.b = R.b; st.words.splice(st.words.indexOf(R), 1); delete L.s; }
        else if (L) { L.b = i; delete L.s; }
        else if (R) { R.a = i; delete R.s; }
        else st.words.push({ kind: 'manual', a: i, b: i });
      }
    }
    st.last = i;
    update();
  }

  function tipFor(el) {
    if (el.dataset.sil) {
      const c = st.sil.find(x => x.id === el.dataset.sil);
      return c ? 'Pause of <b>' + c.len.toFixed(2) + ' s</b> at ' + D.fmt(c.s, true) + '<br>' + (c.on ? 'Cut ' + (c.e - c.s).toFixed(2) + ' s of it, keeping ' + S.tail + ' ms after the words and ' + S.lead + ' ms before. Click to keep it all.' : 'Kept. Click to cut it.') : '';
    }
    const i = Number(el.dataset.i), w = st.A.words[i], c = cutAt(i);
    if (w.gone) return 'Already cut' + (S.backup ? '. To bring it back, take it from the backup sequence in <b>CutKit Backups</b>.' : '.');
    const t = D.fmt(w.t0, true) + ((st.swears || []).indexOf(i) >= 0 ? ' · <span class="k" style="--k:#e5484d">Swear word</span>' : '');
    if (c && !c.off) return '<span class="k" style="' + kStyle(c.kind) + '">' + D.KINDS[c.kind].label + '</span>' + (c.why ? ': ' + esc(c.why) : '') +
      '<br>' + t + ' · Click to keep' + (c.b > c.a ? ' these ' + (c.b - c.a + 1) + ' words' : '') + ' · Alt+click to jump there';
    return t + ' · Click to cut · Shift+click to cut a range · Alt+click to jump there';
  }

  // ---------- waveform strip ----------
  // ---------- waveform strip (zoomable) ----------
  // st.view = [t0, t1] seconds shown; null = the whole sequence.
  const view = () => { const A = st.A; let [a, b] = st.view || [0, A.end]; b = Math.min(b, A.end); a = Math.max(0, Math.min(a, b - 1)); return [a, b]; };
  function setView(a, b) {
    const A = st.A, len = Math.max(2, Math.min(A.end, b - a));
    a = Math.max(0, Math.min(a, A.end - len));
    st.view = len >= A.end - 0.01 ? null : [a, a + len];
    drawStrip();
  }
  function zoom(f, around) {
    const [a, b] = view(), c = around == null ? (a + b) / 2 : around, len = (b - a) * f;
    setView(c - (c - a) * f, c - (c - a) * f + len);
  }
  function drawStrip() {
    const A = st.A, cv = $('#strip');
    if (!A || cv.offsetParent === null) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const [v0, v1] = view(), span = v1 - v0, X = t => (t - v0) / span * W;
    const showWords = span <= 45, wy = showWords ? 14 : 0, WH = H - wy - 4, mid = wy + WH / 2;
    $('#view-range').textContent = st.view ? D.fmt(v0, span < 60) + ' – ' + D.fmt(v1, span < 60) : 'whole sequence';
    const sc = scope();
    // outside the In/Out scope: dimmed
    if (sc) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, Math.max(0, X(sc[0])), H); g.fillRect(Math.min(W, X(sc[1])), 0, W, H); }
    // planned silence cuts: the whole detected pause faint, the part that's cut stronger, so the padding shows
    for (const c of st.sil) {
      if (c.e0 < v0 || c.s0 > v1) continue;
      g.fillStyle = 'rgba(111,143,179,' + (c.on ? .13 : .06) + ')';
      g.fillRect(X(c.s0), wy, Math.max(1, X(c.e0) - X(c.s0)), WH);
    }
    const cuts = st.sil.filter(c => c.on).concat(wordCuts().filter(c => c.on).map(c => D.timed(A, c)));
    for (const c of cuts) {
      if (c.e < v0 || c.s > v1) continue;
      const x0 = X(c.s), w = Math.max(1, X(c.e) - x0), col = D.KINDS[c.kind].color;
      g.fillStyle = rgba(col, 0.3); g.fillRect(x0, wy, w, WH);
      g.fillStyle = col; g.fillRect(x0, H - 3, w, 3);
      if (w > 6) { g.fillRect(x0, wy, 1, WH); g.fillRect(x0 + w - 1, wy, 1, WH); }   // the cut edges
    }
    // waveform; the parts that go are dimmed
    const R = st.ranges || [];
    let ri = 0;
    for (let x = 0; x < W; x++) {
      const ta = v0 + x / W * span, tb = v0 + (x + 1) / W * span;
      let m = -Infinity;
      for (let k = Math.floor(ta / M.STEP), e = Math.max(k + 1, Math.floor(tb / M.STEP)); k < e; k++) if (A.env[k] > m) m = A.env[k];
      if (m === -Infinity) continue;
      const tm = (ta + tb) / 2;
      while (ri < R.length && R[ri][1] <= tm) ri++;
      const gone = ri < R.length && tm >= R[ri][0];
      const h = Math.max(1, Math.min(1, (m + 70) / 60) * (WH - 4));
      g.fillStyle = gone ? 'rgba(141,141,141,.25)' : '#8a96a3';
      g.fillRect(x, mid - h / 2, 1, h);
    }
    // silence threshold
    if (S.silence) {
      const y = (Math.min(1, (S.thr + 70) / 60) * (WH - 4)) / 2;
      g.fillStyle = 'rgba(111,143,179,.55)';
      g.fillRect(0, mid - y, W, 1); g.fillRect(0, mid + y, W, 1);
    }
    // words, when zoomed in far enough to read them
    if (showWords) {
      g.font = '10px system-ui, -apple-system, sans-serif'; g.textBaseline = 'top';
      const map = D.wordMap(wordCuts());
      let lastX = -1e9;
      for (let i = 0; i < A.words.length; i++) {
        const w = A.words[i];
        if (w.gone || w.t1 < v0 || w.t0 > v1) continue;
        const x = X(w.t0);
        if (x < lastX + 2) continue;
        const c = map.get(i), cutRange = R.some(r => (w.t0 + w.t1) / 2 >= r[0] && (w.t0 + w.t1) / 2 < r[1]);
        g.fillStyle = c ? D.KINDS[c.kind].color : cutRange ? '#6f8fb3' : '#c9ced4';
        g.fillText(w.w, x, 2);
        const tw = g.measureText(w.w).width;
        if (c || cutRange) g.fillRect(x, 8, tw, 1);
        lastX = x + tw;
      }
    }
    if (st.ph != null && st.ph >= v0 && st.ph <= v1) { g.fillStyle = '#2d8ceb'; g.fillRect(Math.round(X(st.ph)) - 1, 0, 2, H); }
  }

  // ---------- loudness chart (how often each level occurs) with the threshold; drag to set it ----------
  function drawHist() {
    const A = st.A, cv = $('#hist');
    if (!A || cv.offsetParent === null) return;
    if (!st.hist || st.histFor !== A) { st.hist = D.histogram(A); st.histFor = A; }
    const h = st.hist, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const lo = -80, hi = 0, X = db => (db - lo) / (hi - lo) * W;
    const max = Math.max(1, ...h.slice(10));
    for (let i = 10; i < h.length; i++) {
      const db = i - 90, x0 = X(db - 0.5), w = Math.max(1, X(db + 0.5) - x0), bh = Math.sqrt(h[i] / max) * (H - 12);
      g.fillStyle = db < S.thr ? 'rgba(111,143,179,.75)' : 'rgba(170,178,188,.75)';
      g.fillRect(x0, H - 10 - bh, w - 0.5, bh);
    }
    g.fillStyle = '#6f6f6f'; g.font = '9px system-ui, -apple-system, sans-serif'; g.textBaseline = 'bottom';
    for (const db of [-70, -50, -30, -10]) { g.fillText(String(db), X(db) - 6, H); }
    const tx = X(S.thr);
    g.fillStyle = '#2d8ceb'; g.fillRect(tx - 1, 0, 2, H - 10);
    g.fillText('silence', Math.max(2, tx - 40), 10); g.fillStyle = '#9aa3ad'; g.fillText('voice', Math.min(W - 26, tx + 5), 10);
  }

  // Keyboard: Premiere receives the panel's key presses itself (Space, K, L, arrows work on the timeline) once no
  // button holds the focus, so CutKit doesn't handle them: doing both made Space stop and then restart playback.
  const typing = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox'));

  // ---------- jumping between cuts ----------
  function navInfo() {
    const R = st.ranges || [];
    $('#cut-nav').textContent = R.length ? (st.navI != null && st.navI < R.length ? 'Cut ' + (st.navI + 1) + ' / ' + R.length : R.length + ' cuts') : 'no cuts';
    $('#c-prev').disabled = $('#c-next').disabled = !R.length;
  }
  function goCut(dir) {
    const R = st.ranges || [];
    if (!R.length) return;
    const ref = st.navI != null && st.navI < R.length ? st.navI : null;
    let i = ref == null ? (dir > 0 ? R.findIndex(r => r[0] > (st.ph || 0)) : (() => { let k = -1; R.forEach((r, n) => { if (r[1] < (st.ph || 0)) k = n; }); return k; })()) : ref + dir;
    if (i < 0) i = dir > 0 ? 0 : R.length - 1;
    i = Math.max(0, Math.min(R.length - 1, i));
    st.navI = i;
    const r = R[i], pad = Math.max(3, (r[1] - r[0]) * 1.5);
    setView(r[0] - pad, r[1] + pad);
    jump(Math.max(0, r[0] - 1.5));       // play from here in Premiere to hear the cut
    navInfo();
  }

  // ---------- playhead ----------
  async function jump(t) {
    st.ph = t; drawStrip(); markNow();
    if (CK.inPR) await CK.host('CK_setPlayhead', { t });
  }
  function markNow() {
    const A = st.A;
    document.querySelectorAll('.w.now').forEach(e => e.classList.remove('now'));
    if (!A || st.ph == null) return;
    let lo = 0, hi = A.words.length - 1, f = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (A.words[m].t0 <= st.ph) { f = m; lo = m + 1; } else hi = m - 1; }
    if (f >= 0 && st.ph < A.words[f].t1 + 0.3) { const el = document.querySelector('.w[data-i="' + f + '"]'); if (el) el.classList.add('now'); }
  }
  // Every poll is a script call on Premiere's main thread, the one that also starts playback: polling while you
  // edit in the timeline made Space feel like it needed a second press. So CutKit only polls while the mouse is
  // over the panel, and catches up the moment it comes back.
  let hover = false, pollT = null, polling = false;
  document.documentElement.addEventListener('mouseenter', () => { hover = true; clearTimeout(pollT); poll(); });
  document.documentElement.addEventListener('mouseleave', () => { hover = false; });
  async function poll() {
    pollT = null;
    if (!hover || polling) return;
    polling = true;
    if (CK.inPR && !st.busy && !document.hidden) {
      const r = await CK.host('CK_playhead');
      if (r.ok && !r.none) {
        if (st.info && r.id !== st.info.id) readSeq(true);
        checkSeq(r.id, r.name);
        const io = JSON.stringify(r.io || null);
        if (io !== JSON.stringify(st.io || null)) { st.io = r.io; scopeInfo(); if (S.scopeIO) update(); }
        if (st.A && r.t !== st.ph) { st.ph = r.t; drawStrip(); markNow(); }
      }
    }
    polling = false;
    if (hover && !pollT) pollT = setTimeout(poll, 700);
  }

  // ---------- filler words: your own list, and markers instead of cuts ----------
  async function editFillers() {
    const ok = await confirmBox('Filler words', '<p>Always found: um, uh, er, ah, hmm. Add your own words or phrases, separated by commas ' +
      '(e.g. <i>like, you know, I mean, basically</i>). Careful with words that are often real content.</p>' +
      '<textarea id="filler-extra" rows="3" spellcheck="false">' + esc(S.fillerExtra || '') + '</textarea>', 'Save', false);
    if (!ok) return;
    S.fillerExtra = $('#filler-extra') ? $('#filler-extra').value : S.fillerExtra;
    CK.save();
    if (st.A) {
      const keepOff = new Set(st.words.filter(c => c.kind === 'filler' && c.off).map(c => c.a + ':' + c.b));
      const big = st.words.filter(c => c.kind !== 'filler' && c.kind !== 'manual').concat(st.takeCuts);
      const fresh = D.fillers(st.A, fillerList()).filter(c => !big.some(t => c.a >= t.a && c.b <= t.b) && !st.A.words[c.a].gone);
      fresh.forEach(c => { if (keepOff.has(c.a + ':' + c.b)) c.off = true; });
      st.words = st.words.filter(c => c.kind !== 'filler').concat(fresh);
      update();
    }
  }
  async function markFillers() {
    const A = st.A;
    const list = st.words.filter(c => c.kind === 'filler' && !c.off && !A.words[c.a].gone);
    if (!list.length) return;
    const marks = list.map(c => ({ t0: A.words[c.a].t0, t1: A.words[c.b].t1, name: 'Filler: ' + A.words.slice(c.a, c.b + 1).map(w => w.w).join(' ').replace(/[.,!?;:]+$/, ''), comment: 'CutKit' }));
    await CK.app.markers(marks, 4, 'yellow');
  }
  // markers on the analysed sequence (color: Premiere's index, 1 red, 4 yellow…)
  async function markers(marks, color, colorName, extra) {
    const A = st.A;
    if (!A || !marks.length) return null;
    if (A.demo) { status('Preview mode: would add ' + marks.length + ' ' + colorName + ' markers.', 'ok'); return { added: marks.length }; }
    const r = await CK.host('CK_addMarkers', Object.assign({ marks, color, seqId: A.id, seqName: A.name }, extra || {}));
    if (!r.ok) { status(r.error, 'err'); return null; }
    status('Added ' + r.added + ' ' + colorName + ' marker' + (r.added === 1 ? '' : 's') + (r.dup ? ' (' + r.dup + ' already there)' : '') + '. They move with the footage when you cut.', 'ok');
    return r;
  }

  // ---------- swear-word markers ----------
  async function markSwears() {
    const A = st.A, list = st.swears || [];
    if (!A || !list.length) return;
    const marks = list.filter(i => !(st.swearOff || new Set()).has(i)).map(i => ({ t0: Math.max(0, A.words[i].t0), t1: A.words[i].t1, name: 'Swear: ' + A.words[i].w.replace(/[.,!?;:]+$/, ''), comment: 'CutKit' }));
    await markers(marks, 1, 'red');
  }

  // ---------- cut ----------
  // opts.auto: no questions
  async function cut(opts) {
    const auto = !!(opts && opts.auto);
    const A = st.A, R = st.ranges;
    if (!A || !R || !R.length) return null;
    if (A.rounds && CK.inPR) {
      const now = await CK.host('CK_seqInfo');
      if (now.ok && Math.abs(now.end - A.end) > A.frame * 1.5) {
        status('The sequence length changed since the last cut (edited by hand?), so the review no longer lines up. Press Analyze Again.', 'err');
        return null;
      }
    }
    const removed = R.reduce((n, r) => n + r[1] - r[0], 0);
    const ok = auto || await confirmBox('Cut "' + A.name + '"?',
      '<p><b>' + R.length + '</b> cuts remove <b>' + D.fmt(removed, true) + '</b> from every track. The sequence goes from ' + D.fmt(A.end) + ' to <b>' + D.fmt(A.end - removed) + '</b>.</p>' +
      (S.backup ? '<p>A copy of the sequence goes into the <b>CutKit Backups</b> bin first.</p>'
        : '<p>No backup: undoing means pressing Cmd+Z once per cut.</p>') +
      '<p>Sequence markers move with the footage.</p>', 'Cut Sequence', true);
    if (!ok) return null;
    busy(true);
    prog(null, 'Cutting ' + R.length + ' ranges in Premiere…');
    status('Cutting… Premiere may look frozen for a moment.', 'busy');
    const t0 = Date.now();
    const xfade = S.xfade ? { name: S.xfadeName, frames: S.xfadeFrames } : null;
    const r = A.demo ? { ok: true, cuts: R.length, seconds: removed, backup: 'Interview_A (Before CutKit)', xfade: xfade && { added: R.length, failed: 0 } }    // preview mode: pretend
      : await CK.host('CK_cut', { ranges: R, seqId: A.id, seqName: A.name, backup: S.backup, xfade });
    busy(false);
    prog(false);
    if (!r.ok) { status(r.error, 'err'); return r; }
    // keep reviewing: the same analysis moved onto the cut timeline. What was cut stays listed (faded); the cuts that
    // were applied are done, the ones switched off stay available.
    // what Undo Last Cut needs: Premiere's undo steps for this cut, and the review as it was before it
    st.lastCut = r.backup ? { backup: r.backup, A, words: st.words, silOff: new Set(st.silOff), seqId: A.id, parts: JSON.parse(JSON.stringify(st.parts)) } : null;
    st.A = D.afterCut(A, R);
    st.words = st.words.filter(c => !c.on).map(c => { const x = Object.assign({}, c); delete x.s; delete x.e; return x; });
    st.parts = []; st.takeCuts = [];      // the takes were decided and applied
    st.view = null; st.navI = null; st.hist = null;
    CK.app.emit('cut', { ranges: R, result: r });
    st.swears = D.swears(st.A);
    st.silOff.clear();
    st.last = null;
    update();
    status('Cut ' + r.cuts + ' ranges, ' + D.fmt(r.seconds, true) + ' removed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s.' +
      (r.markers ? ' ' + r.markers + ' marker' + (r.markers === 1 ? '' : 's') + ' moved.' : '') +
      (r.xfade ? ' ' + r.xfade.added + ' audio crossfade' + (r.xfade.added === 1 ? '' : 's') + (r.xfade.failed ? ' (' + r.xfade.failed + ' failed: ' + (r.xfade.error || '?') + ')' : '') + '.' : '') + (r.backup ? ' Backup: "' + r.backup + '".' : '') + (r.missing ? ' (' + r.missing + ' clips couldn\'t be moved, check the timeline.)' : ''), r.missing ? 'err' : 'ok');
    readSeq(true);
    return r;
  }

  // One click back: the backup made before the last cut takes the sequence's place, and the review goes back too.
  async function undoCut() {
    const L = st.lastCut;
    if (!L) return;
    const ok = await confirmBox('Undo the last cut?', '<p>The backup <b>' + esc(L.backup) + '</b> takes this sequence\'s place (same name, same bin) and opens. ' +
      'The cut version is renamed "… (Cut, Undone)" and moved to <b>CutKit Backups</b>; nothing is deleted.</p>' +
      '<p>If this sequence is nested in another one, that nest still shows the cut version.</p>', 'Undo Last Cut', false);
    if (!ok) return;
    let id = L.seqId;
    if (!L.A.demo) {
      busy(true);
      const r = await CK.host('CK_restoreBackup', { seqId: L.seqId, backup: L.backup });
      busy(false);
      if (!r.ok) { status(r.error, 'err'); return; }
      id = r.id;
    }
    st.A = Object.assign({}, L.A, { id }); st.words = L.words; st.silOff = L.silOff; st.swears = D.swears(st.A);
    st.parts = L.parts || []; rebuildTakes(); CK.app.emit('takes');
    st.lastCut = null; st.view = null; st.navI = null; st.hist = null;
    await readSeq(true);
    update();
    status('Undid the last cut: the sequence before it is back in the timeline.', 'ok');
  }

  // ---------- preview mode (a browser, outside Premiere) ----------
  function loadDemo() {
    const d = CK.demo.analysis();
    st.info = { id: d.id, name: d.name };
    st.A = d;
    st.words = D.fillers(d, fillerList());
    st.swears = D.swears(d);
    st.takes = 'none'; st.parts = []; st.takeCuts = [];
    if (S.thrAuto) S.thr = D.autoThr(d);
    $('#seq-name').textContent = d.name + ' (preview)';
    showResults();
    CK.app.emit('analyzed');
    status('Preview mode: a made-up interview, nothing to cut.', '');
    if (S.takes) findTakes();
  }

  // ---------- number boxes: drag to scrub (Shift = 10x), click to type ----------
  (function scrub() {
    let drag = null;
    const dec = s => (String(s).split('.')[1] || '').length;
    document.addEventListener('mousedown', e => {
      const el = e.target;
      if (e.button !== 0 || !(el instanceof HTMLInputElement) || el.type !== 'number' || el.disabled || document.activeElement === el) return;
      e.preventDefault();
      drag = { el, x: e.clientX, v: Number(el.value) || 0, moved: false };
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      if (!drag.moved) { drag.moved = true; document.body.classList.add('scrubbing'); }
      const el = drag.el, stp = Number(el.step) || 1;
      let v = drag.v + Math.round(dx / 4) * stp * (e.shiftKey ? 10 : 1);
      if (el.min !== '') v = Math.max(Number(el.min), v);
      if (el.max !== '') v = Math.min(Number(el.max), v);
      v = Number(v.toFixed(dec(stp)));
      if (String(v) !== el.value) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      const { el, moved } = drag;
      drag = null;
      document.body.classList.remove('scrubbing');
      if (!moved) { el.focus(); el.select(); }
    });
  })();

  // ---------- wiring ----------
  function wire() {
    $('#analyze').onclick = analyze;
    $('#cut').onclick = cut;
    $('#refresh').onclick = () => { const b = $('#refresh'); b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin'); readSeq(); };
    const num = (id, key) => $(id).addEventListener('input', e => { const v = Number(e.target.value); if (isFinite(v) && e.target.value !== '') { S[key] = v; CK.save(); update(); } });
    num('#thr', 'thr'); num('#min-sil', 'minSil'); num('#tail', 'tail'); num('#lead', 'lead');
    ['#min-sil', '#tail', '#lead'].forEach(id => $(id).addEventListener('input', () => syncControls()));
    $('#tight').innerHTML = Object.keys(D.TIGHT).map(k => '<button type="button" data-k="' + k + '" title="Pauses over ' + D.TIGHT[k].minSil + ' s; keeps ' + D.TIGHT[k].tail + ' ms after words and ' + D.TIGHT[k].lead + ' ms before">' + D.TIGHT[k].label + '</button>').join('');
    $('#tight').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const t = D.TIGHT[b.dataset.k];
      Object.assign(S, { minSil: t.minSil, tail: t.tail, lead: t.lead }); CK.save(); syncControls(); update();
    };
    $('#scope').onchange = e => { S.scopeIO = e.target.checked; CK.save(); scopeInfo(); update(); };
    $('#xfade').onchange = e => { S.xfade = e.target.checked; CK.save(); syncControls(); };
    $('#xfade-frames').addEventListener('input', e => { const v = Math.round(Number(e.target.value)); if (v > 0) { S.xfadeFrames = v; CK.save(); } });
    $('#undo-cut').onclick = undoCut;
    $('#sil-fold').onclick = () => { S.silFold = !S.silFold; CK.save(); syncControls(); drawHist(); };
    $('#z-in').onclick = () => zoom(0.5); $('#z-out').onclick = () => zoom(2); $('#z-fit').onclick = () => { st.view = null; drawStrip(); };
    $('#c-prev').onclick = () => goCut(-1); $('#c-next').onclick = () => goCut(1);
    // threshold: drag on the loudness chart
    const hc = $('#hist');
    const setThr = e => {
      const r = hc.getBoundingClientRect(), db = Math.round(-80 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 80);
      S.thrAuto = false; S.thr = Math.max(-80, Math.min(-10, db)); CK.save(); syncControls(); update();
    };
    hc.addEventListener('mousedown', e => {
      if (!st.A) return;
      setThr(e);
      const mv = ev => setThr(ev), up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
    $('#thr-auto').onchange = e => { S.thrAuto = e.target.checked; if (S.thrAuto && st.A) S.thr = D.autoThr(st.A); CK.save(); syncControls(); update(); };
    $('#on-silence').onchange = e => { S.silence = e.target.checked; CK.save(); update(); };
    $('#on-filler').onchange = e => { S.fillers = e.target.checked; CK.save(); update(); };
    $('#on-takes').onchange = e => {
      S.takes = e.target.checked; CK.save();
      if (S.takes && st.takes === 'failed') st.takes = 'none';
      if (S.takes) findTakes(); else update();
    };
    $('#backup').onchange = e => { S.backup = e.target.checked; CK.save(); };
    document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
    $('#swear-mark').onclick = markSwears;
    $('#filler-edit').onclick = editFillers;
    $('#filler-mark').onclick = markFillers;
    $('#ref-track').onchange = innerOptions;
    $('#inner-track').onchange = e => { S.innerTrack = Number(e.target.value); CK.save(); };

    const tr = $('#transcript');
    tr.addEventListener('click', e => {
      const w = e.target.closest('.w'), p = e.target.closest('.pause');
      if (w) clickWord(Number(w.dataset.i), e);
      else if (p) { const id = p.dataset.sil; if (st.silOff.has(id)) st.silOff.delete(id); else st.silOff.add(id); update(); }
      hideTip();
    });
    tr.addEventListener('mouseover', e => {
      const el = e.target.closest('.w, .pause');
      if (!el || !st.A) { hideTip(); return; }
      const r = el.getBoundingClientRect();
      showTip(tipFor(el), r.left + r.width / 2, r.top);
    });
    tr.addEventListener('mouseleave', hideTip);
    tr.addEventListener('scroll', hideTip);

    const cv = $('#strip');
    const tAt = e => { const r = cv.getBoundingClientRect(), [v0, v1] = view(); return v0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (v1 - v0); };
    let drag = null;
    cv.addEventListener('mousedown', e => { if (st.A && e.button === 0) drag = { x: e.clientX, v: view(), moved: false }; });
    addEventListener('mousemove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true; cv.classList.add('dragging'); hideTip();
      const [a, b] = drag.v, dt = -dx / cv.clientWidth * (b - a);
      setView(a + dt, b + dt);
    });
    addEventListener('mouseup', e => {
      if (!drag) return;
      const was = drag; drag = null; cv.classList.remove('dragging');
      if (!was.moved && e.target === cv) { st.navI = null; jump(tAt(e)); navInfo(); }
    });
    cv.addEventListener('wheel', e => {
      if (!st.A) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const [a, b] = view(), dt = e.deltaX / cv.clientWidth * (b - a); setView(a + dt, b + dt); }
      else zoom(Math.pow(1.0018, e.deltaY), tAt(e));
    }, { passive: false });
    cv.addEventListener('dblclick', () => { st.view = null; drawStrip(); });
    cv.addEventListener('mousemove', e => {
      if (!st.A || drag) return;
      const t = tAt(e), c = st.sil.concat(wordCuts()).find(x => x.on && x.s != null && t >= x.s && t < x.e);
      const sil = !c && st.sil.find(x => t >= x.s0 && t < x.e0);
      showTip(D.fmt(t, true) + (c ? ' · <span class="k" style="' + kStyle(c.kind) + '">' + D.KINDS[c.kind].label + '</span>' + (c.kind === 'silence' ? ' (pause ' + c.len.toFixed(2) + ' s, cut ' + (c.e - c.s).toFixed(2) + ' s)' : '') :
        sil ? ' · padding kept around a cut' : '') + '<br>Click: playhead · Drag: move · Scroll: zoom', e.clientX, cv.getBoundingClientRect().top);
    });
    cv.addEventListener('mouseleave', hideTip);
    window.addEventListener('resize', () => { drawStrip(); drawHist(); });
    // a clicked button, checkbox or the strip gives the keyboard back, so Space doesn't press the button again
    document.addEventListener('mouseup', e => setTimeout(() => {
      const el = document.activeElement;
      if (el && el !== document.body && !typing(el)) el.blur();
    }, 0));

    syncControls();
  }

  // ---------- sidebar (views) ----------
  const I = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const RAIL_ICONS = {
    // scissors: the blades snip on hover
    cut: I('<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path class="fx-snip" style="--r:-10deg" d="M8.2 7.5 20 17"/><path class="fx-snip" style="--r:10deg" d="M8.2 16.5 20 7"/>'),
    // stacked layers: the top one lifts
    adj: I('<path class="fx-lift" d="M12 3.5 3.5 8l8.5 4.5L20.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>'),
    // a gear that turns on hover
    settings: I('<g class="fx-turn"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></g>')
  };
  function showView(v) {
    S.view = v; CK.save();
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    document.querySelectorAll('.view').forEach(x => { x.hidden = x.id !== 'view-' + v; });
    if (v === 'cut') update();
    CK.app.emit('view', v);
  }
  function wireRail() {
    document.querySelectorAll('.rail-btn').forEach(b => {
      b.innerHTML = RAIL_ICONS[b.dataset.view || b.dataset.action] || '';
      if (b.dataset.view) b.onclick = () => showView(b.dataset.view);   // action buttons (data-action) wire themselves
      b.addEventListener('mouseenter', () => {
        if (b.classList.contains('play') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        b.classList.add('play'); setTimeout(() => b.classList.remove('play'), 800);
      });
    });
  }

  // ---------- tabs ----------
  function showTab(t) {
    st.tab = t;
    document.querySelectorAll('#tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', String(b.dataset.tab === t)); });
    document.querySelectorAll('.pane').forEach(p => { p.hidden = p.id !== 'pane-' + t; });
    if (t === 'cut') update();
    CK.app.emit('tab', t);
  }

  // ---------- shared with the tab modules (takes.js, swears.js) ----------
  const listeners = {};
  CK.app = {
    st, S, $, esc, status, prog, confirmBox, update, jump, readSeq, busy, scope, kStyle, setView, rebuildTakes, wordCuts, markers, markSwears,
    analyze, findTakes, cut, fillerList, syncControls, showTab, showView,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, data) { (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
  };

  async function start() {
    wire();
    wireRail();
    if (S.view && S.view !== 'cut' && document.getElementById('view-' + S.view)) showView(S.view);
    CK.app.emit('ready');
    if (!CK.inPR) { status('Preview mode: open CutKit inside Premiere Pro to cut real sequences. Analyze shows a made-up example.'); return; }
    const r = await CK.loadHost();
    if (!r.ok) { status(r.error, 'err'); return; }
    await readSeq(true);
    poll();
  }
  // the tab modules load after this file and register first
  setTimeout(start, 0);
})();
