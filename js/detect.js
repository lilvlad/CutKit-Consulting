// CutKit detection: silences, filler words (from the transcript) and the final cut list.
// Times are seconds on the sequence timeline. A = the analysis: { end, env (dB per 10 ms over the whole sequence,
// -Infinity where the reference track has no audio), hf (the same for the hiss: s, f, t, breath), speech (1 per 10 ms
// where the speech detector heard a voice, or null), segs: [{ start, end }], words: [{ w, t0, t1, r0, r1 }] }.
// r0/r1 are a word's times as measured (aligner, CrisperWhisper or Whisper's anchors); t0/t1 are those stretched over
// any sound still belonging to it (D.prepare). The rule everything follows: a silence cut never touches a word.
(function () {
  const CK = window.CK;
  const D = CK.detect = {};
  const STEP = 0.01;

  D.KINDS = {
    silence: { label: 'Silence', color: '#6f8fb3' },
    filler: { label: 'Filler word', color: '#e8a64f' },
    take: { label: 'Earlier take', color: '#e5675e' },
    offtake: { label: 'Between takes', color: '#9a8f86' },
    repeat: { label: 'Repeated line', color: '#e5675e' },
    false_start: { label: 'False start', color: '#d9739f' },
    stumble: { label: 'Stumble', color: '#c78be0' },
    manual: { label: 'Cut by hand', color: '#2d8ceb' }
  };

  const at = (A, t) => A.env[Math.max(0, Math.min(A.env.length - 1, Math.round(t / STEP)))];

  // Threshold between the room noise (quietest 10%) and the voice (loudest 10%), a third of the way up.
  D.autoThr = function (A) {
    const v = [];
    for (let i = 0; i < A.env.length; i += 2) if (A.env[i] > -Infinity) v.push(A.env[i]);
    if (!v.length) return -42;
    v.sort((a, b) => a - b);
    const lo = v[Math.floor(v.length * 0.1)], hi = v[Math.floor(v.length * 0.9)];
    return Math.round(Math.max(-62, Math.min(-22, lo + (hi - lo) * 0.33)));
  };

  // ---------- the sound around the words ----------
  // Room tone and voice level for every second, from the 31 s around it: a long shoot drifts (the speaker leans back,
  // the gain or the room changes), so one threshold for two hours is wrong somewhere. 1 dB histograms per second,
  // summed over a sliding window; lo = the quietest 10%, hi = the loudest 10%.
  function localLevels(src) {
    const n = src.length, B = Math.ceil(n / 100), R = 15, H = new Uint32Array(B * 91);
    for (let i = 0; i < n; i++) { const v = src[i]; if (v > -Infinity) H[Math.floor(i / 100) * 91 + Math.max(0, Math.min(90, Math.round(v + 90)))]++; }
    const lo = new Float32Array(B).fill(NaN), hi = new Float32Array(B).fill(NaN), win = new Float64Array(91);
    let total = 0;
    const add = (b, k) => { if (b < 0 || b >= B) return; for (let d = 0; d < 91; d++) { win[d] += k * H[b * 91 + d]; total += k * H[b * 91 + d]; } };
    for (let b = 0; b <= R; b++) add(b, 1);
    for (let b = 0; b < B; b++) {
      if (b) { add(b + R, 1); add(b - R - 1, -1); }
      if (total < 300) continue;                                   // under 3 s of audio around: use the whole-shoot level
      let c = 0, d = 0;
      for (; d < 91 && (c += win[d]) < total * 0.1; d++);
      lo[b] = d - 90;
      for (c = 0, d = 90; d >= 0 && (c += win[d]) < total * 0.1; d--);
      hi[b] = d - 90;
    }
    return { lo, hi };
  }

  // Thresholds per second for the current settings: below thr (loudness) and below hfThr (hiss) counts as quiet.
  // Auto: a third of the way from the local room tone to the local voice (like D.autoThr, per region). Otherwise the
  // threshold you set. The hiss threshold is always automatic: a quarter of the way up, at least 6 dB over the room.
  D.thresholds = function (A, o) {
    const key = (o.thrAuto ? 'auto' : o.thr) + '|' + A.env.length;
    if (A._thr && A._thr.key === key) return A._thr;
    if (!A._lv) A._lv = { env: localLevels(A.env), hf: A.hf ? localLevels(A.hf) : null };
    const L = A._lv.env, F = A._lv.hf, B = L.lo.length, g = D.autoThr(A);
    const thr = new Float32Array(B), hfThr = new Float32Array(B);
    for (let b = 0; b < B; b++) {
      if (!o.thrAuto) thr[b] = o.thr;
      else if (isNaN(L.lo[b])) thr[b] = g;
      else thr[b] = Math.max(L.lo[b] + 6, Math.min(-22, Math.max(-62, L.lo[b] + (L.hi[b] - L.lo[b]) * 0.33)));
      hfThr[b] = F && !isNaN(F.lo[b]) ? F.lo[b] + Math.max(6, (F.hi[b] - F.lo[b]) * 0.25) : Infinity;
    }
    return (A._thr = { key, thr, hfThr });
  };

  // How far a word's sound may run past its measured times: a trailing s/t/f or a soft ending (150 ms), a breathy
  // start (100 ms). And the least that stays next to any word, whatever the tightness.
  const STRETCH_END = 15, STRETCH_START = 10, MIN_TAIL = 0.04, MIN_LEAD = 0.05;

  // Gets the words ready for the current thresholds: t0/t1 (measured times stretched over the sound that still belongs
  // to the word), `ghost` (Whisper wrote words where nobody spoke: no voice detected, nothing above room tone, and the
  // aligner wasn't sure either; these don't protect anything), and A._prot: 1 for every 10 ms that must never be cut.
  D.prepare = function (A, o) {
    const T = D.thresholds(A, o), W = A.words, n = A.env.length, hf = A.hf, sp = A.speech;
    if (A._prep === T.key) return;
    const idx = t => Math.max(0, Math.min(n - 1, Math.round(t / STEP)));
    const thrAt = i => T.thr[Math.floor(i / 100)], hfAt = i => T.hfThr[Math.floor(i / 100)];
    const sound = i => i >= 0 && i < n && (A.env[i] >= thrAt(i) || (hf && hf[i] >= hfAt(i)));
    // a voice nearby (speech detector) or real loudness inside the word: over the local threshold and the whole shoot's
    // (in a long silent stretch the local one sits just above room tone, and a noise bump would make an invented word
    // look real; hiss doesn't count either)
    const g = D.autoThr(A);
    const heard = w => {
      const i0 = idx(w.r0), i1 = Math.max(i0 + 1, idx(w.r1));
      for (let i = i0; i < i1; i++) if (A.env[i] >= Math.max(g, thrAt(i))) return true;
      // the aligner found no trace of its letters (score ~0) and it's quiet: not said, whatever the detector's loose edges say
      if (w.score != null && w.score < 0.05) return false;
      if (!sp) return true;                                            // no speech detector: trust every word
      for (let i = Math.max(0, i0 - 15), e = Math.min(n, i1 + 15); i < e; i++) if (sp[i]) return true;
      return false;
    };
    for (const w of W) {
      if (w.r0 == null) { w.r0 = w.t0; w.r1 = w.t1; }
      w.ghost = !w.gone && !(w.score > 0.3) && !heard(w);
    }
    const live = W.filter(w => !w.gone && !w.ghost);
    for (let k = 0; k < live.length; k++) {
      const w = live[k], prev = live[k - 1], next = live[k + 1];
      let i = idx(w.r1);
      const endLim = Math.min(i + STRETCH_END, next ? idx(next.r0) : n, idx(A.segs[w.seg] ? A.segs[w.seg].end : A.end));
      while (i < endLim && sound(i)) i++;
      w.t1 = Math.max(w.r1, i * STEP);
      i = idx(w.r0);
      const startLim = Math.max(i - STRETCH_START, prev ? idx(prev.r1) : 0, idx(A.segs[w.seg] ? A.segs[w.seg].start : 0));
      while (i > startLim && sound(i - 1)) i--;
      w.t0 = Math.min(w.r0, i * STEP);
    }
    // two words with no pause between them both reach into the sound between them: they meet at its quietest point
    for (let k = 1; k < live.length; k++) {
      const p = live[k - 1], w = live[k];
      if (p.t1 <= w.t0) continue;
      let cut;
      if (p.r1 < w.r0) {
        let best = Infinity;
        for (let i = idx(p.r1), e = idx(w.r0); i <= e; i++) if (A.env[i] < best) { best = A.env[i]; cut = i * STEP; }
      } else cut = (p.r1 + w.r0) / 2;
      p.t1 = Math.max(p.t0 + STEP, cut); w.t0 = Math.min(w.t1 - STEP, cut);
    }
    for (const w of W) if (w.ghost) { w.t0 = w.r0; w.t1 = w.r1; }
    // protected: every real word, plus speech the transcript missed (the detector heard a voice for 0.2 s+ with no word
    // in it; only its frames clearly above room tone, since the detector's edges are loose)
    const prot = new Uint8Array(n);
    for (const w of live) for (let i = idx(w.t0), e = idx(w.t1); i < e; i++) prot[i] = 1;
    if (sp) {
      const lo = A._lv.env.lo;
      for (let i = 0; i < n;) {
        if (!sp[i]) { i++; continue; }
        let j = i, words = false;
        while (j < n && sp[j]) { if (prot[j]) words = true; j++; }
        if (!words && j - i >= 20) for (let k = i; k < j; k++) { const l = lo[Math.floor(k / 100)]; if (A.env[k] >= (isNaN(l) ? -60 : l) + 8) prot[k] = 1; }
        i = j;
      }
    }
    A._prot = prot;
    A._prep = T.key;
  };

  // After the measured times (aligner / CrisperWhisper) replace Whisper's guesses: a word that got none (a number like
  // "10" has no letters to align) would keep Whisper's guess, which can be seconds off and out of order. It gets the
  // whole space between its measured neighbours instead, so it stays in order and is protected wherever it really is.
  // words: [{ t0, t1, measured }], in spoken order.
  D.fillUnmeasured = function (words) {
    for (let k = 0; k < words.length; k++) {
      if (words[k].measured) continue;
      let p = k - 1, q = k + 1;
      while (p >= 0 && !words[p].measured) p--;
      while (q < words.length && !words[q].measured) q++;
      if (p < 0 && q >= words.length) return;                    // nothing measured: keep Whisper's times
      const a = p >= 0 ? words[p].t1 : Math.max(0, words[q].t0 - 1), b = q < words.length ? words[q].t0 : words[p].t1 + 1;
      words[k].t0 = a; words[k].t1 = Math.max(a + STEP, b);
    }
  };

  // Pauses of at least minSil seconds inside the reference clips. A moment is quiet when the loudness is under the local
  // threshold and no word is there (a word's hissy edges are already part of it, see D.prepare; hiss elsewhere in a pause,
  // like clothes or a breath, doesn't keep it). Each pause keeps `tail` after the last word and `lead` before
  // the next one (never under 40 / 50 ms); a pause at the very start or end of a clip is cut completely.
  D.silences = function (A, o) {
    D.prepare(A, o);
    const T = A._thr, prot = A._prot, out = [];
    const tail = Math.max(MIN_TAIL, o.tail), lead = Math.max(MIN_LEAD, o.lead);
    const quiet = i => A.env[i] < T.thr[Math.floor(i / 100)] && !prot[i];
    for (const seg of A.segs) {
      const i0 = Math.ceil(seg.start / STEP), i1 = Math.min(A.env.length, Math.floor(seg.end / STEP));
      let run = -1;
      for (let i = i0; i <= i1; i++) {
        const q = i < i1 && quiet(i);
        if (q && run < 0) run = i;
        else if (!q && run >= 0) {
          const s = run * STEP, e = i * STEP;
          run = -1;
          if (e - s < o.minSil) continue;
          const cs = s <= seg.start + STEP ? seg.start : s + tail;
          const ce = e >= seg.end - STEP ? seg.end : e - lead;
          if (ce - cs > 0.04) out.push({ kind: 'silence', s: cs, e: ce, s0: s, e0: e, len: e - s, id: 's' + Math.round(s * 10) });
        }
      }
    }
    return out;
  };

  // One-click tightness, like FireCut's: minimum pause, then what stays after the last word / before the next (ms).
  D.TIGHT = {
    loose: { label: 'Loose', minSil: 0.75, tail: 250, lead: 250 },
    natural: { label: 'Natural', minSil: 0.5, tail: 150, lead: 120 },
    tight: { label: 'Tight', minSil: 0.35, tail: 80, lead: 60 },
    vtight: { label: 'Very Tight', minSil: 0.25, tail: 40, lead: 50 }
  };
  D.tightOf = S => Object.keys(D.TIGHT).find(k => { const t = D.TIGHT[k]; return t.minSil === S.minSil && t.tail === S.tail && t.lead === S.lead; }) || 'custom';

  // How often each loudness occurs (1 dB bins from -90 to 0), for the chart under the threshold.
  D.histogram = function (A) {
    const h = new Array(91).fill(0);
    for (let i = 0; i < A.env.length; i++) { const v = A.env[i]; if (v > -Infinity) h[Math.max(0, Math.min(90, Math.round(v + 90)))]++; }
    return h;
  };

  // The time range that removes words a..b: from where word a starts up to where the next word starts, so the pause
  // before the removed words stays and the one after them goes. At a pause the edge sits 30 ms into the quiet,
  // so no breath or consonant of the kept words is clipped.
  D.wordRange = function (A, a, b) {
    const W = A.words;
    let p = a - 1, n = b + 1;                          // neighbours still in the sequence (after a cut, removed words stay listed)
    while (p >= 0 && W[p].gone) p--;
    while (n < W.length && W[n].gone) n++;
    const prev = W[p], next = W[n];
    const pauseBefore = prev && prev.seg === W[a].seg && W[a].t0 - prev.t1 > 0.1;
    const s = W[a].t0 - (pauseBefore ? 0.03 : 0);
    let e;
    if (next && next.seg === W[b].seg) e = next.t0 - (next.t0 - W[b].t1 > 0.1 ? 0.03 : 0);
    else e = W[b].t1 + 0.05;
    return { s, e: Math.max(e, s + 0.04) };
  };

  // Each word gets its start and end from the audio around Whisper's anchor time `at` (a point just inside the word).
  // Between two words: if there's a pause (quiet for 0.12 s+), the first word ends where it goes quiet and the next starts
  // where the sound comes back. Without a pause, the edge goes to the quietest moment just before the next anchor.
  D.placeWords = function (A, thr) {
    const W = A.words, n = A.env.length, quiet = i => i >= 0 && i < n && A.env[i] < thr;
    const idx = t => Math.max(0, Math.min(n - 1, Math.round(t / STEP)));
    // the pause between anchors i..j (frames): [first quiet frame, last quiet frame + 1] of the longest quiet run, or null
    const pauseIn = (i, j) => {
      let best = null, run = -1;
      for (let k = i; k <= j; k++) {
        const q = k < j && quiet(k);
        if (q && run < 0) run = k;
        else if (!q && run >= 0) { if (k - run >= 12 && (!best || k - run > best[1] - best[0])) best = [run, k]; run = -1; }
      }
      return best;
    };
    // a real dip between two sounds: at least 6 dB quieter than the loudest point within 60 ms on each side
    const valley = (i, j) => {
      let best = -1, bv = Infinity;
      for (let k = i; k <= j; k++) {
        const v = A.env[k];
        if (v >= bv) continue;
        let l = -Infinity, r = -Infinity;
        for (let d = 1; d <= 6; d++) { if (k - d >= 0) l = Math.max(l, A.env[k - d]); if (k + d < n) r = Math.max(r, A.env[k + d]); }
        if (l - v >= 6 && r - v >= 6) { best = k; bv = v; }
      }
      return best;
    };
    const LAG = 17;   // Whisper's DTW time lands ~0.17-0.2 s after a word really starts
    for (let k = 0; k < W.length; k++) {
      const w = W[k], seg = A.segs[w.seg] || { start: 0, end: A.end }, ia = idx(w.at);
      // start
      if (k === 0 || W[k - 1].seg !== w.seg) {
        let i = ia, lim = Math.max(idx(seg.start), ia - 150);
        while (i > lim && !quiet(i - 1)) i--;
        w.t0 = i * STEP;
      } else {
        const ip = idx(W[k - 1].at), p = pauseIn(ip + 1, ia);
        if (p) { W[k - 1].t1 = p[0] * STEP; w.t0 = p[1] * STEP; }
        else {
          // no pause: estimate the edge from the anchor, then snap to a dip in the sound nearby if there is one
          const lo = Math.min(ip + 5, ia - 3), hi = ia - 3, c = Math.max(lo, Math.min(hi, ia - LAG));
          const v = valley(Math.max(lo, c - 10), Math.min(hi, c + 10));
          const e = (v >= 0 ? v : c) * STEP;
          W[k - 1].t1 = e; w.t0 = e;
        }
      }
      // end of a clip's last word: where the sound stops (at most 1.5 s on)
      if (k === W.length - 1 || W[k + 1].seg !== w.seg) {
        let i = ia, lim = Math.min(idx(seg.end), ia + 150);
        while (i < lim && !quiet(i)) i++;
        w.t1 = i * STEP;
      }
    }
    for (const w of W) { w.t0 = Math.min(w.t0, w.at); w.t1 = Math.max(w.t1, w.t0 + STEP); }
  };

  const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|hm+|m+h*m+|e+h+)$/;
  D.isFiller = w => FILLER.test(String(w).toLowerCase().replace(/[^a-z]/g, ''));

  // Swear words: English (with the starred spellings Whisper sometimes writes, like f***), plus common
  // Russian/Ukrainian ones. Matched on the whole word without punctuation; stems catch the endings.
  const SWEAR = new RegExp('^(' + [
    '\\w*fuck\\w*', 'f\\*+\\w*', 'fu\\*+\\w*', 'f\\*+k\\w*', 'fk\\w*', 'fck\\w*', 'wtf', 'stfu',
    '\\w*shit\\w*', 'sh\\*+t\\w*', 's\\*+t\\w*', 'shite',
    'bitch\\w*', 'b\\*+tch\\w*', 'bastards?', '\\w*asshole\\w*', 'arse\\w*', 'ass', 'asses', 'jackass', 'dumbass', 'badass',
    'cunts?', 'c\\*+t', 'dicks?', 'dickhead\\w*', 'cocks?', 'cocksucker\\w*', 'pussy', 'pussies', 'prick\\w*', 'twats?', 'wank\\w*',
    'bollocks', 'bullocks', 'whores?', 'sluts?', 'motherfuck\\w*', 'goddamn\\w*', 'damn\\w*', 'dammit', 'piss\\w*',
    'хуй\\S*', 'хуе\\S*', 'хуя\\S*', 'пизд\\S*', 'ёб\\S*', 'еба\\S*', 'ебл\\S*', 'ебу\\S*', 'бля\\S*', 'сука', 'суки', 'мудак\\S*', 'хер\\S*'
  ].join('|') + ')$', 'i');
  // Your own lists (Swears tab): extra words to catch (a trailing * matches any ending) and words never to flag.
  const swearKey = w => String(w).toLowerCase().replace(/[^\p{L}\p{N}*']/gu, '').replace(/'s$/, '');
  const list = v => String(v || '').split(',').map(x => swearKey(x.trim())).filter(Boolean);
  D.isSwear = function (w) {
    const k = swearKey(w), S = CK.settings;
    if (!k || list(S.swearAllow).indexOf(k) >= 0) return false;
    if (list(S.swearBlock).some(b => b.endsWith('*') ? k.indexOf(b.slice(0, -1)) === 0 : b === k)) return true;
    return SWEAR.test(k);
  };
  D.swears = A => A.words.reduce((out, w, i) => (!w.gone && D.isSwear(w.w) && out.push(i), out), []);

  // extra: your own filler words or phrases ("like", "you know"), matched whole-word, case and punctuation ignored.
  D.fillers = function (A, extra) {
    const out = [], W = A.words, norm = w => String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
    const phrases = (extra || []).map(p => p.toLowerCase().split(/\s+/).map(norm).filter(Boolean)).filter(p => p.length)
      .sort((x, y) => y.length - x.length);
    for (let i = 0; i < W.length; i++) {
      if (W[i].gone) continue;
      if (D.isFiller(W[i].w)) { out.push({ kind: 'filler', a: i, b: i, id: 'f' + i }); continue; }
      const p = phrases.find(ph => ph.every((x, k) => W[i + k] && !W[i + k].gone && norm(W[i + k].w) === x));
      if (p) { out.push({ kind: 'filler', a: i, b: i + p.length - 1, id: 'f' + i }); i += p.length - 1; }
    }
    return out;
  };

  // Word-based cuts get their time range (silence cuts already have one).
  D.timed = function (A, c) {
    if (c.a == null) return c;
    if (c.s == null) Object.assign(c, D.wordRange(A, c.a, c.b));
    return c;
  };

  // Enabled cuts → sorted, merged ranges on whole frames, ready for Premiere.
  // scope: [in, out] to cut only between the sequence's In and Out points (or null).
  // Edges are rounded inwards (start up, end down to a frame), so rounding never moves a cut into what stays.
  // Last check: no range may touch a word that stays (a real word that no word cut removes). A range that would is
  // trimmed back to the word plus a margin, or split around it; D.guarded lists every word that was protected this way.
  D.ranges = function (A, cuts, frame, scope) {
    const lo = scope ? Math.max(0, scope[0]) : 0, hi = scope ? Math.min(A.end, scope[1]) : A.end;
    const up = t => Math.ceil(t / frame - 1e-6) * frame, down = t => Math.floor(t / frame + 1e-6) * frame;
    const r = cuts.filter(c => c.on).map(c => D.timed(A, c)).map(c => [Math.max(lo, c.s), Math.min(hi, c.e)])
      .map(([s, e]) => [up(s), down(e)])
      .filter(([s, e]) => e - s >= frame * 2)
      .sort((x, y) => x[0] - y[0]);
    // a gap between two cuts goes too when it's under 2 frames, or holds no word and no sound (only a scrap of pause).
    // Sound without a word stays: it may be speech the transcript missed (CrisperWhisper once left out a loud "Look.").
    const W = A.words;
    // the words by start time (not trusting the list to be in perfect time order), and how long the longest one is
    const order = W.map((w, i) => i).sort((x, y) => W[x].t0 - W[y].t0);
    const longest = W.reduce((m, w) => Math.max(m, w.t1 - w.t0), 0);
    const near = t => {                              // binary search: the first word (by start) that could reach past t
      let lo = 0, hi = order.length - 1, f = order.length;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (W[order[m]].t0 >= t - longest) { f = m; hi = m - 1; } else lo = m + 1; }
      return f;
    };
    const wordIn = (a, b) => {
      for (let k = near(a + 0.02); k < order.length && W[order[k]].t0 < b - 0.02; k++) { const w = W[order[k]]; if (!w.gone && !w.ghost && w.t1 > a + 0.02) return true; }
      return false;
    };
    const T = A._thr, prot = A._prot;
    const soundIn = (a, b) => {
      if (!T) return false;
      for (let i = Math.max(0, Math.floor(a / STEP)), e = Math.min(A.env.length, Math.ceil(b / STEP)); i < e; i++) if (A.env[i] >= T.thr[Math.floor(i / 100)] || (prot && prot[i])) return true;
      return false;
    };
    const merged = [];
    for (const x of r) {
      const last = merged[merged.length - 1];
      if (last && (x[0] <= last[1] + frame * 2 || (!wordIn(last[1], x[0]) && !soundIn(last[1], x[0])))) last[1] = Math.max(last[1], x[1]);
      else merged.push(x.slice());
    }
    // the guard
    const removed = D.wordMap(cuts);
    const keeps = i => !W[i].gone && !W[i].ghost && !removed.has(i);
    const out = [];
    D.guarded = [];
    for (const [s0, e0] of merged) {
      let s = s0;
      for (let k = near(s0); k < order.length && W[order[k]].t0 < e0; k++) {
        const i = order[k], w = W[i];
        if (!keeps(i) || w.t1 <= s || w.t0 >= e0) continue;
        D.guarded.push(i);
        const e = down(w.t0 - MIN_LEAD);
        if (e - s >= frame * 2) out.push([s, e]);
        s = Math.max(s, up(w.t1 + MIN_TAIL));
      }
      if (e0 - s >= frame * 2) out.push([s, e0]);
    }
    return out.map(([s, e]) => [Number(s.toFixed(6)), Number(e.toFixed(6))]);
  };
  D.guarded = [];

  // After a cut in place: the same analysis on the new, shorter timeline. R = the ranges that were cut (sorted seconds).
  // Removed words stay in the list marked `gone` (shown faded), everything else moves up by the time cut before it.
  D.afterCut = function (A, R) {
    const pre = [0];
    R.forEach((r, i) => pre.push(pre[i] + r[1] - r[0]));
    const firstAfter = t => {                         // index of the first range that ends after t
      let lo = 0, hi = R.length - 1, f = R.length;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (R[m][1] > t) { f = m; hi = m - 1; } else lo = m + 1; }
      return f;
    };
    const inside = t => { const k = firstAfter(t); return k < R.length && t >= R[k][0]; };
    const map = t => { const k = firstAfter(t); return k < R.length && t >= R[k][0] ? R[k][0] - pre[k] : t - pre[k]; };
    const end = A.end - pre[R.length], env = new Float32Array(Math.ceil(end / STEP) + 2).fill(-Infinity);
    for (let i = 0, k = 0; i < A.env.length; i++) {
      const t = i * STEP;
      while (k < R.length && R[k][1] <= t) k++;
      if (k < R.length && t >= R[k][0]) continue;
      const j = Math.round((t - pre[k]) / STEP);
      if (j < env.length) env[j] = A.env[i];
    }
    // the other per-10 ms tracks move the same way
    const remap = (src, fill) => {
      if (!src) return null;
      const dst = new src.constructor(env.length).fill(fill);
      for (let i = 0, k = 0; i < src.length; i++) {
        const t = i * STEP;
        while (k < R.length && R[k][1] <= t) k++;
        if (k < R.length && t >= R[k][0]) continue;
        const j = Math.round((t - pre[k]) / STEP);
        if (j < dst.length) dst[j] = src[i];
      }
      return dst;
    };
    const words = A.words.map(w => Object.assign({}, w, {
      gone: w.gone || inside((w.t0 + w.t1) / 2), t0: map(w.t0), t1: map(w.t1), at: map(w.at != null ? w.at : w.t0),
      r0: map(w.r0 != null ? w.r0 : w.t0), r1: map(w.r1 != null ? w.r1 : w.t1)
    }));
    const segs = A.segs.map(g => Object.assign({}, g, { start: map(g.start), end: map(g.end - 1e-6) }));
    return Object.assign({}, A, { end, env, hf: remap(A.hf, -Infinity), speech: remap(A.speech, 0), words, segs,
      _lv: null, _thr: null, _prep: null, _prot: null, rounds: (A.rounds || 0) + 1, cutSoFar: (A.cutSoFar || 0) + pre[R.length] });
  };

  // Which words are cut (index → the cut), for the transcript.
  D.wordMap = function (cuts) {
    const m = new Map();
    for (const c of cuts) if (c.a != null && c.on) for (let i = c.a; i <= c.b; i++) if (!m.has(i)) m.set(i, c);
    return m;
  };

  D.fmt = function (sec, frac) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (frac ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0'));
  };
})();
