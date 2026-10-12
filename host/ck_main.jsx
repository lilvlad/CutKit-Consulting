// CutKit host: Premiere Pro ExtendScript (ES3). Reads the active sequence and cuts ranges out of it in place.
// Times cross the bridge as seconds on the sequence timeline (0 = sequence start, the same base as TrackItem.start).

var CK = {};
CK.TPS = 254016000000;   // Premiere ticks per second

CK.json = function (v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') {
    return '"' + v.replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (c) {
      var m = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c];
      return m || '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
  }
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(CK.json(v[i]));
    return '[' + a.join(',') + ']';
  }
  var o = [];
  for (var k in v) if (v.hasOwnProperty(k) && typeof v[k] !== 'function') o.push(CK.json(k) + ':' + CK.json(v[k]));
  return '{' + o.join(',') + '}';
};
CK.ok = function (data) { data = data || {}; data.ok = true; return CK.json(data); };
CK.fail = function (msg) { return CK.json({ ok: false, error: String(msg) }); };
CK.run = function (fn) {
  try { return fn(); }
  catch (e) { return CK.fail((e && e.message ? e.message : e) + (e && e.line ? ' (line ' + e.line + ')' : '')); }
};

CK.seq = function () {
  var s = app.project ? app.project.activeSequence : null;
  if (!s) throw new Error('Open a sequence in the Timeline first.');
  return s;
};
CK.time = function (sec) { var t = new Time(); t.seconds = sec; return t; };
CK.frameDur = function (s) { return Number(s.timebase) / CK.TPS; };

// Every track of one kind: [{ track, kind: 'V'|'A', index }]
CK.tracks = function (s) {
  var out = [], i;
  for (i = 0; i < s.videoTracks.numTracks; i++) out.push({ track: s.videoTracks[i], kind: 'V', index: i });
  for (i = 0; i < s.audioTracks.numTracks; i++) out.push({ track: s.audioTracks[i], kind: 'A', index: i });
  return out;
};
CK.locked = function (tr) { try { return !!tr.isLocked(); } catch (e) { return false; } };

// The sequence's In and Out points in seconds, or null when not set (Premiere reports -400000 then).
CK.inOut = function (s) {
  var a = Number(s.getInPoint()), b = Number(s.getOutPoint());
  return { inP: a >= 0 ? a : null, outP: b >= 0 ? b : null };
};

function CK_ping() { return CK.ok({ version: app.version, project: app.project ? app.project.path : '' }); }

// The sequence a nested clip shows (its project item is the sequence's own item), or null.
CK.innerSeq = function (c) {
  var pi = c.projectItem;
  try { if (!pi || !pi.isSequence()) return null; } catch (e) { return null; }
  for (var i = 0; i < app.project.sequences.numSequences; i++) if (app.project.sequences[i].projectItem.nodeId === pi.nodeId) return app.project.sequences[i];
  return null;
};
// The audio track to listen to inside a nested sequence: the asked one if it has clips, else the first with clips.
CK.innerTrack = function (seq, want) {
  if (want != null && want >= 0 && want < seq.audioTracks.numTracks && seq.audioTracks[want].clips.numItems) return seq.audioTracks[want];
  for (var i = 0; i < seq.audioTracks.numTracks; i++) if (seq.audioTracks[i].clips.numItems) return seq.audioTracks[i];
  return null;
};

// The media files a clip plays, in the time of the sequence the clip sits in: [{ path, mIn, mOut, s0, s1, name }].
// Nested sequences are followed down (up to 4 levels) through the audio track `inner` (index) inside them.
// skipped counts pieces that can't be analysed (speed changes, no file).
CK.sources = function (c, inner, depth, out, skipped) {
  var speed = 1;
  try { speed = c.getSpeed(); } catch (e) {}
  if (Math.abs(speed - 1) > 1e-3) { skipped.n++; return; }
  var s0 = c.start.seconds, s1 = c.end.seconds, in0 = c.inPoint.seconds;
  var seq = depth < 4 ? CK.innerSeq(c) : null;
  if (!seq) {
    var path = '';
    try { path = c.projectItem ? c.projectItem.getMediaPath() : ''; } catch (e) {}
    if (path) out.push({ path: path, mIn: in0, mOut: in0 + (s1 - s0), s0: s0, s1: s1, name: c.name });
    else skipped.n++;
    return;
  }
  var tr = CK.innerTrack(seq, inner);
  if (!tr) { skipped.n++; return; }
  var w0 = in0, w1 = in0 + (s1 - s0);                       // the window of the nested sequence that's visible
  for (var j = 0; j < tr.clips.numItems; j++) {
    var sub = [], c2 = tr.clips[j];
    if (c2.end.seconds <= w0 || c2.start.seconds >= w1) continue;
    CK.sources(c2, inner, depth + 1, sub, skipped);
    for (var k = 0; k < sub.length; k++) {
      var x = sub[k], a = Math.max(x.s0, w0), b = Math.min(x.s1, w1);
      if (b - a < 0.05) continue;
      out.push({ path: x.path, mIn: x.mIn + (a - x.s0), mOut: x.mIn + (b - x.s0), s0: s0 + (a - w0), s1: s0 + (b - w0), name: x.name });
    }
  }
};

// The active sequence: settings, every track and its clips. Nested clips on audio tracks list the audio tracks inside.
function CK_seqInfo() {
  return CK.run(function () {
    var s = CK.seq(), list = CK.tracks(s), tracks = [];
    for (var i = 0; i < list.length; i++) {
      var tr = list[i].track, clips = [], inner = null;
      for (var j = 0; j < tr.clips.numItems; j++) {
        var c = tr.clips[j];
        clips.push({ name: c.name, start: c.start.seconds, end: c.end.seconds });
        if (list[i].kind === 'A' && !inner) {
          var n = CK.innerSeq(c);
          if (n) {
            inner = { name: n.name, tracks: [] };
            for (var k = 0; k < n.audioTracks.numTracks; k++) inner.tracks.push({ index: k, name: n.audioTracks[k].name, clips: n.audioTracks[k].clips.numItems });
          }
        }
      }
      tracks.push({ kind: list[i].kind, index: list[i].index, name: tr.name, locked: CK.locked(tr), clips: clips, inner: inner });
    }
    return CK.ok({ id: s.sequenceID, name: s.name, frame: CK.frameDur(s), end: Number(s.end) / CK.TPS,
      zero: Number(s.zeroPoint) / CK.TPS, playhead: s.getPlayerPosition().seconds, markers: s.markers.numMarkers, tracks: tracks,
      io: CK.inOut(s) });
  });
}

// The media to analyse for audio track o.track of the active sequence (following nested sequences through o.inner).
function CK_sources(o) {
  return CK.run(function () {
    var s = CK.seq(), tr = s.audioTracks[o.track], out = [], skipped = { n: 0 };
    if (!tr) throw new Error('That audio track doesn\'t exist any more.');
    for (var j = 0; j < tr.clips.numItems; j++) CK.sources(tr.clips[j], o.inner, 0, out, skipped);
    return CK.ok({ id: s.sequenceID, sources: out, skipped: skipped.n });
  });
}

// Sequence markers at o.marks [{ t0, t1, name, comment }], colored o.color (Premiere's index: 1 = red).
// A marker already there with the same name at the same frame isn't added twice.
function CK_addMarkers(o) {
  return CK.run(function () {
    var s = CK.seq(), half = CK.frameDur(s) / 2, have = [], i;
    if (o.seqId && s.sequenceID !== o.seqId) throw new Error('The active sequence changed since the analysis. Open "' + (o.seqName || 'it') + '" again.');
    for (var m = s.markers.getFirstMarker(); m; m = s.markers.getNextMarker(m)) have.push({ t: m.start.seconds, name: m.name });
    var added = 0, dup = 0;
    for (i = 0; i < o.marks.length; i++) {
      var x = o.marks[i], seen = false;
      for (var k = 0; k < have.length; k++) if (have[k].name === x.name && Math.abs(have[k].t - x.t0) <= half) { seen = true; break; }
      if (seen) { dup++; continue; }
      var mk = s.markers.createMarker(x.t0);
      mk.name = x.name;
      if (x.comment) mk.comments = x.comment;
      if (x.t1 > x.t0) mk.end = x.t1;            // marker times take plain seconds (a Time object is refused)
      // (no nested ?: here: ExtendScript groups a ? b : c ? d : e wrongly)
      var col = 1;
      if (o.color != null) col = o.color;
      if (x.color != null) col = x.color;
      try { mk.setColorByIndex(col); } catch (e) {}
      added++;
    }
    return CK.ok({ added: added, dup: dup });
  });
}

function CK_setPlayhead(o) {
  return CK.run(function () {
    var s = CK.seq();
    s.setPlayerPosition(String(Math.round(o.t * CK.TPS)));
    return CK.ok({});
  });
}

// QE razor takes a timecode in the sequence's own display format, counted from 00:00 even when the sequence
// starts at another timecode (verified with a 01:00:00:00 start).
// It's aimed a quarter frame into the wanted frame: 65.32 s as a float is 65.3199…, which Premiere put on the frame before.
// The sequence settings are read once per sequence object (reading them for every razor was most of the razor time).
CK.tc = function (s, sec) {
  if (CK.tcSeq !== s) { CK.tcSeq = s; CK.tcSet = s.getSettings(); CK.tcFd = CK.frameDur(s); }
  var st = CK.tcSet, fd = CK.tcFd;
  return CK.time((Math.round(sec / fd) + 0.25) * fd).getFormatted(st.videoFrameRate, st.videoDisplayFormat);
};

// Duplicates the sequence into a "CutKit Backups" bin as "<name> (Before CutKit)". Returns its name.
CK.backup = function (s) {
  var before = {}, i;
  for (i = 0; i < app.project.sequences.numSequences; i++) before[app.project.sequences[i].sequenceID] = 1;
  if (!s.clone()) throw new Error('Premiere couldn\'t duplicate the sequence for the backup, so nothing was cut.');
  var copy = null;
  for (i = 0; i < app.project.sequences.numSequences; i++) {
    var q = app.project.sequences[i];
    if (!before[q.sequenceID]) { copy = q; break; }
  }
  if (!copy) throw new Error('The backup copy didn\'t show up in the project, so nothing was cut.');
  // each round of cuts gets its own backup: "(Before CutKit)", "(Before CutKit 2)", …
  var taken = {};
  for (i = 0; i < app.project.sequences.numSequences; i++) taken[app.project.sequences[i].name] = 1;
  var name = s.name + ' (Before CutKit)', n = 2;
  while (taken[name]) name = s.name + ' (Before CutKit ' + (n++) + ')';
  try { copy.name = name; } catch (e) {}
  try {
    var root = app.project.rootItem, bin = null;
    for (i = 0; i < root.children.numItems; i++) {
      var it = root.children[i];
      if (it.type === ProjectItemType.BIN && it.name === 'CutKit Backups') { bin = it; break; }
    }
    if (!bin) bin = root.createBin('CutKit Backups');
    copy.projectItem.moveBin(bin);
  } catch (e) {}
  return name;
};

// Cuts o.ranges ([[start, end], ...] in seconds, sorted, not overlapping, on frame boundaries) out of every
// track of the active sequence and closes the gaps, so everything after each cut moves up and stays in sync.
// Sequence markers move with the footage (one inside a cut goes to the cut point).
// o.seqId: the sequence the panel analysed (refuses to cut a different one). o.backup: duplicate it first.
// o.method: 'extract' (default: Premiere's own Extract per range, ~0.1 s per cut) or 'move' (razor, remove, move
// every clip; the older, slower way, kept as a fallback).
function CK_cut(o) {
  return CK.run(function () {
    var s = CK.seq(), i;
    if (o.seqId && s.sequenceID !== o.seqId) throw new Error('The active sequence changed since the analysis. Open "' + (o.seqName || 'it') + '" again or re-analyse.');
    var R = o.ranges || [];
    if (!R.length) throw new Error('Nothing to cut.');
    var half = CK.frameDur(s) / 2;
    CK.tcSeq = null;
    var backupName = o.backup ? CK.backup(s) : '';
    if (o.backup) app.project.activeSequence = s;   // cloning can switch the active sequence
    // Extract keeps the In/Out points it sets; put the user's back afterwards
    var io = CK.inOut(s);
    var r = o.method === 'move' ? CK.cutMove(s, R, half) : CK.cutExtract(s, R, half);
    var total = 0;
    for (i = 0; i < R.length; i++) total += R[i][1] - R[i][0];
    if (o.xfade && o.xfade.frames > 0) r.xfade = CK.crossfades(s, R, o.xfade);
    CK.restoreInOut(s, io, R);
    r.cuts = R.length; r.seconds = total; r.backup = backupName;
    return CK.ok(r);
  });
}

// Puts the user's In/Out back where they were, moved like the footage (when there were none, Extract leaves none).
CK.restoreInOut = function (s, io, R) {
  var map = function (t) {
    var d = 0;
    for (var k = 0; k < R.length; k++) { if (R[k][1] <= t) d += R[k][1] - R[k][0]; else if (R[k][0] < t) { d += t - R[k][0]; } }
    return t - d;
  };
  try { if (io.inP != null) s.setInPoint(map(io.inP)); } catch (e) {}
  try { if (io.outP != null) s.setOutPoint(map(io.outP)); } catch (e) {}
};

// Audio crossfades at every new edit point: x = { name, frames } (Premiere's default is read from its prefs by the
// panel). Each cut ends up at R[k][0] minus everything cut before it; there the clip that starts gets a centred
// transition, on every audio track that has a clip on both sides of the edit.
CK.crossfades = function (s, R, x) {
  app.enableQE();
  var q = qe.project.getActiveSequence(), tr = qe.project.getAudioTransitionByName(x.name || 'Constant Power');
  if (!tr) return { added: 0, failed: 0, error: 'No audio transition called "' + x.name + '".' };
  var fd = CK.frameDur(s), half = fd / 2, st = s.getSettings();
  var dur = CK.time(x.frames * fd + fd * 0.25).getFormatted(st.videoFrameRate, st.videoDisplayFormat);
  var zero = CK.time(0).getFormatted(st.videoFrameRate, st.videoDisplayFormat);
  var at = [], pre = 0, i, j, k;
  for (k = 0; k < R.length; k++) { at.push(R[k][0] - pre); pre += R[k][1] - R[k][0]; }
  var added = 0, failed = 0, err = '';
  for (i = 0; i < s.audioTracks.numTracks; i++) {
    if (!s.audioTracks[i].clips.numItems) continue;
    var qt = q.getAudioTrackAt(i), items = [];
    for (j = 0; j < qt.numItems; j++) { var it = qt.getItemAt(j); items.push({ it: it, clip: it.type === 'Clip', a: it.start.secs, b: it.end.secs }); }
    var p = 0;
    for (k = 0; k < at.length; k++) {
      while (p < items.length && items[p].a < at[k] - half) p++;
      if (p >= items.length || !items[p].clip || Math.abs(items[p].a - at[k]) > half) continue;
      if (p === 0 || !items[p - 1].clip || Math.abs(items[p - 1].b - at[k]) > half) continue;   // needs a clip on both sides
      try { items[p].it.addTransition(tr, true, dur, zero, 0.5, false, true); added++; }
      catch (e) { failed++; err = e.message; }
    }
  }
  return { added: added, failed: failed, error: err };
};

// Extract (like the Extract button with In/Out marks) per range, last range first so earlier times stay valid.
// Extract works on targeted tracks and ripples sync-locked ones, so every track with clips is targeted, sync-locked
// and unlocked for the edit, then put back as it was. Extract moves markers after a range itself but deletes the
// ones inside it, so those are first moved to the range's end (they then land on the cut).
CK.cutExtract = function (s, R, half) {
  var i, k, T0 = new Date().getTime();
  app.enableQE();
  var q = qe.project.getActiveSequence(), all = CK.tracks(s), saved = [];
  var end0 = Number(s.end) / CK.TPS, total = 0;
  for (i = 0; i < R.length; i++) total += R[i][1] - R[i][0];
  for (i = 0; i < all.length; i++) {
    var t = all[i].track;
    if (!t.clips.numItems) continue;
    var qt = all[i].kind === 'V' ? q.getVideoTrackAt(all[i].index) : q.getAudioTrackAt(all[i].index);
    var rec = { t: t, qt: qt, locked: CK.locked(t), targeted: true, sync: true };
    try { rec.targeted = !!t.isTargeted(); } catch (e) {}
    try { rec.sync = !!qt.isSyncLocked(); } catch (e) {}
    saved.push(rec);
    if (rec.locked) t.setLocked(0);
    if (!rec.targeted) t.setTargeted(true, true);
    if (!rec.sync) qt.setSyncLock(true);
  }
  var marks = 0;
  try {
    for (k = R.length - 1; k >= 0; k--) {
      for (var m = s.markers.getFirstMarker(); m; m = s.markers.getNextMarker(m)) {
        var ms = m.start.seconds;
        if (ms >= R[k][0] - half && ms < R[k][1] - half) { m.start = R[k][1]; marks++; }
      }
      q.setInPoint(CK.tc(s, R[k][0]));
      q.setOutPoint(CK.tc(s, R[k][1]));
      q.extract();
    }
    // the sequence must be shorter by exactly the cut time (unless a cut ran past its end)
    var end1 = Number(s.end) / CK.TPS, want = end0 - total;
    if (R[R.length - 1][1] < end0 - half && Math.abs(end1 - want) > half * 3)
      throw new Error('The sequence is ' + end1.toFixed(2) + ' s long instead of ' + want.toFixed(2) + ' s after the cuts. Check the timeline; the backup has the original.');
  } finally {
    for (i = 0; i < saved.length; i++) {
      var sv = saved[i];
      try { if (!sv.sync) sv.qt.setSyncLock(false); } catch (e) {}
      try { if (!sv.targeted) sv.t.setTargeted(false, true); } catch (e) {}
      try { if (sv.locked) sv.t.setLocked(1); } catch (e) {}
    }
  }
  return { method: 'extract', ms: { extract: new Date().getTime() - T0 }, markers: marks, missing: 0 };
};

// The older way: razor every track at each edge, remove the pieces inside, move every later clip left.
CK.cutMove = function (s, R, half) {
  var i, j, k;
  // total cut before time t (prefix sums), and whether [a, b] lies inside one range
  var pre = [0];
  for (i = 0; i < R.length; i++) pre.push(pre[i] + R[i][1] - R[i][0]);
  var lastEndingBy = function (t) {           // index of the last range with end <= t, or -1
    var lo = 0, hi = R.length - 1, f = -1;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (R[m][1] <= t + half) { f = m; lo = m + 1; } else hi = m - 1; }
    return f;
  };
  var cutBefore = function (t) { return pre[lastEndingBy(t) + 1]; };
  var inRange = function (a, b) {
    var lo = 0, hi = R.length - 1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (R[m][1] + half < b) lo = m + 1; else if (R[m][0] - half > a) hi = m - 1; else return a >= R[m][0] - half && b <= R[m][1] + half;
    }
    return false;
  };
  var spansOf = function (tr) {
    var sp = [];
    for (var x = 0; x < tr.clips.numItems; x++) { var c = tr.clips[x]; sp.push([c.start.seconds, c.end.seconds]); }
    return sp;
  };
  var edges = [];
  for (i = 0; i < R.length; i++) edges.push(R[i][0], R[i][1]);

  // unlock locked tracks for the edit (relocked at the end); empty tracks are left alone
  var all = CK.tracks(s), list = [], relock = [];
  for (i = 0; i < all.length; i++) if (all[i].track.clips.numItems) list.push(all[i]);
  for (i = 0; i < list.length; i++) if (CK.locked(list[i].track)) { list[i].track.setLocked(0); relock.push(list[i].track); }

  var razors = 0, removed = 0, moved = 0, missing = 0, marks = 0, T0 = new Date().getTime(), ms = {};
  var lap = function (k) { var t = new Date().getTime(); ms[k] = t - T0; T0 = t; };
  try {
    // 1. razor every track at each cut edge that falls inside a clip (clips and edges are both in time order)
    app.enableQE();
    var q = qe.project.getActiveSequence();
    for (i = 0; i < list.length; i++) {
      var qt = list[i].kind === 'V' ? q.getVideoTrackAt(list[i].index) : q.getAudioTrackAt(list[i].index);
      var sp = spansOf(list[i].track), p = 0, need = [];
      for (k = 0; k < edges.length; k++) {
        while (p < sp.length && sp[p][1] - half <= edges[k]) p++;
        if (p < sp.length && edges[k] > sp[p][0] + half) need.push(edges[k]);
      }
      for (k = 0; k < need.length; k++) { qt.razor(CK.tc(s, need[k])); razors++; }
      list[i].need = need;
    }

    lap('razor');
    // safety: each razor must have made a clip boundary. If one landed elsewhere (an unusual timecode setup),
    // stop before removing or moving anything; the extra splits change nothing.
    for (i = 0; i < list.length; i++) {
      var sp2 = spansOf(list[i].track), b = {}, nd = list[i].need;
      for (j = 0; j < sp2.length; j++) { b[Math.round(sp2[j][0] / half)] = 1; b[Math.round(sp2[j][1] / half)] = 1; }
      for (k = 0; k < nd.length; k++) {
        var key = Math.round(nd[k] / half);
        if (!b[key] && !b[key - 1] && !b[key + 1]) throw new Error('Premiere didn\'t split ' + list[i].kind + (list[i].index + 1) + ' at ' + nd[k].toFixed(2) + ' s, so nothing was removed (the clips are only split). Undo with Cmd+Z or use the backup.');
      }
    }

    lap('check');
    // 2. remove every clip piece that lies inside a cut range
    for (i = 0; i < list.length; i++) {
      var t2 = list[i].track, sp3 = spansOf(t2);
      for (j = sp3.length - 1; j >= 0; j--) if (inRange(sp3[j][0], sp3[j][1])) { t2.clips[j].remove(0, 0); removed++; }
    }

    lap('remove');
    // 3. close the gaps: every clip moves left by the total cut before it. Clips go in time order across all
    // tracks so each one only moves into space that's already free. Left moves keep each track's clip order,
    // so a clip is found again by its index; a linked partner that already moved along is skipped.
    var todo = [];
    for (i = 0; i < list.length; i++) {
      var t3 = list[i].track, sp4 = spansOf(t3);
      for (j = 0; j < sp4.length; j++) {
        var d = cutBefore(sp4[j][0]);
        if (d > half) todo.push({ tr: t3, j: j, id: t3.clips[j].nodeId, target: sp4[j][0] - d });
      }
    }
    todo.sort(function (a, b) { return a.target - b.target; });
    for (i = 0; i < todo.length; i++) {
      var T = todo[i], c4 = T.tr.clips[T.j];
      if (!c4 || c4.nodeId !== T.id) {
        c4 = null;
        for (j = 0; j < T.tr.clips.numItems; j++) if (T.tr.clips[j].nodeId === T.id) { c4 = T.tr.clips[j]; break; }
      }
      if (!c4) { missing++; continue; }
      var delta = T.target - c4.start.seconds;
      if (Math.abs(delta) > half) { c4.move(CK.time(delta)); moved++; }
    }

    lap('move');
    // 4. sequence markers follow the footage
    var mk = [];
    for (var m = s.markers.getFirstMarker(); m; m = s.markers.getNextMarker(m)) mk.push(m);
    for (i = 0; i < mk.length; i++) {
      var m0 = mk[i].start.seconds, m1 = mk[i].end.seconds;
      var n0 = inRange(m0, m0) ? m0 - cutBefore(m0) - (m0 - R[lastEndingBy(m0) + 1][0]) : m0 - cutBefore(m0);
      if (Math.abs(n0 - m0) <= half) continue;
      var len = Math.max(0, m1 - m0);
      mk[i].start = n0;                          // plain seconds; moving the start carries the end along
      mk[i].end = n0 + len;
      marks++;
    }
    lap('markers');
  } finally {
    for (i = 0; i < relock.length; i++) try { relock[i].setLocked(1); } catch (e) {}
  }
  return { method: 'move', ms: ms, razors: razors, removed: removed, moved: moved, missing: missing, markers: marks };
};

// The bin a project item sits in (from its tree path), or the root.
CK.binOf = function (pi) {
  var parts = String(pi.treePath || '').split('\\'), node = app.project.rootItem;
  for (var i = 2; i < parts.length - 1; i++) {        // [ '', project name, bin…, item name ]
    var next = null;
    for (var j = 0; j < node.children.numItems; j++) if (node.children[j].type === ProjectItemType.BIN && node.children[j].name === parts[i]) { next = node.children[j]; break; }
    if (!next) break;
    node = next;
  }
  return node;
};

// Undo Last Cut: the backup made before the cut takes the sequence's place (name and bin) and opens; the cut version
// is renamed "<name> (Cut, Undone)" and goes to CutKit Backups. Nothing is deleted. (Premiere's scripted undo stops
// part-way through a cut, so it can't be used for this.)
function CK_restoreBackup(o) {
  return CK.run(function () {
    var s = CK.seq(), i, k = null;
    if (o.seqId && s.sequenceID !== o.seqId) throw new Error('Open the cut sequence again to undo its cut.');
    for (i = 0; i < app.project.sequences.numSequences; i++) if (app.project.sequences[i].name === o.backup) k = app.project.sequences[i];
    if (!k) throw new Error('The backup "' + o.backup + '" isn\'t in the project any more.');
    var name = s.name, home = CK.binOf(s.projectItem), backups = CK.binOf(k.projectItem);
    s.name = name + ' (Cut, Undone)';
    try { s.projectItem.moveBin(backups); } catch (e) {}
    k.name = name;
    try { k.projectItem.moveBin(home); } catch (e) {}
    app.project.openSequence(k.sequenceID);
    return CK.ok({ id: k.sequenceID, name: name, end: Number(k.end) / CK.TPS });
  });
}

// A bin at the top of the project, created if missing.
CK.bin = function (name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) if (root.children[i].type === ProjectItemType.BIN && root.children[i].name === name) return root.children[i];
  return root.createBin(name);
};
// The project item for a file in a bin, imported into that bin if it isn't there yet.
CK.importOnce = function (path, binName) {
  var bin = CK.bin(binName), i, norm = function (p) { return String(p).replace(/\\/g, '/'); };
  for (i = 0; i < bin.children.numItems; i++) { try { if (norm(bin.children[i].getMediaPath()) === norm(path)) return bin.children[i]; } catch (e) {} }
  app.project.importFiles([path], true, bin, false);
  for (i = 0; i < bin.children.numItems; i++) { try { if (norm(bin.children[i].getMediaPath()) === norm(path)) return bin.children[i]; } catch (e) {} }
  throw new Error('Premiere couldn\'t import ' + path);
};
// The first audio track with no clips at all (for beeps), or the asked one.
CK.freeAudioTrack = function (s, want) {
  if (want != null && want >= 0 && want < s.audioTracks.numTracks) return want;
  for (var i = 0; i < s.audioTracks.numTracks; i++) if (!s.audioTracks[i].clips.numItems) return i;
  throw new Error('Every audio track has clips. Add an empty audio track in Premiere first.');
};

// Mutes o.ranges ([[t0, t1], ...] seconds) on every audio track that has clips: the audio is split around each range
// and that piece is switched off (disabled), so it shows in the timeline and can be switched back on.
CK.mute = function (s, R) {
  app.enableQE();
  var q = qe.project.getActiveSequence(), half = CK.frameDur(s) / 2, n = 0, i, j, k;
  CK.tcSeq = null;
  for (i = 0; i < s.audioTracks.numTracks; i++) {
    var tr = s.audioTracks[i];
    if (!tr.clips.numItems) continue;
    var relock = CK.locked(tr);
    if (relock) tr.setLocked(0);
    try {
      var qt = q.getAudioTrackAt(i);
      for (k = 0; k < R.length; k++) { qt.razor(CK.tc(s, R[k][0])); qt.razor(CK.tc(s, R[k][1])); }
      for (j = 0; j < tr.clips.numItems; j++) {
        var c = tr.clips[j], a = c.start.seconds, b = c.end.seconds;
        for (k = 0; k < R.length; k++) if (a >= R[k][0] - half && b <= R[k][1] + half) { c.disabled = true; n++; break; }
      }
    } finally { if (relock) tr.setLocked(1); }
  }
  return n;
};
function CK_mute(o) {
  return CK.run(function () {
    var s = CK.seq();
    if (o.seqId && s.sequenceID !== o.seqId) throw new Error('Open the analysed sequence again first.');
    return CK.ok({ muted: CK.mute(s, o.ranges) });
  });
}

// Bleep: mutes the ranges and lays a beep (o.path, a WAV the panel made) of the same length on an empty audio track.
function CK_bleep(o) {
  return CK.run(function () {
    var s = CK.seq();
    if (o.seqId && s.sequenceID !== o.seqId) throw new Error('Open the analysed sequence again first.');
    var ti = CK.freeAudioTrack(s, o.track), tr = s.audioTracks[ti], item = CK.importOnce(o.path, 'CutKit');
    var muted = CK.mute(s, o.ranges), placed = 0;
    for (var k = 0; k < o.ranges.length; k++) {
      var len = o.ranges[k][1] - o.ranges[k][0];
      item.setInPoint(0, 4); item.setOutPoint(Math.max(0.04, len + CK.frameDur(s) * 0.5), 4);   // half a frame more, so it doesn't round a frame short
      tr.overwriteClip(item, o.ranges[k][0]);
      placed++;
    }
    item.clearInPoint && item.clearInPoint(); item.clearOutPoint && item.clearOutPoint();
    return CK.ok({ muted: muted, placed: placed, track: ti });
  });
}

// ---------- adjustment layer (sidebar button) ----------
// Premiere's scripting can't create an adjustment layer, but it can place one that's already in the project at any
// length. So CutKit reuses one: an item named like "Adjustment Layer" in the project (the CutKit bin first), else the
// one in CutKit's template project (o.tpl), imported into the CutKit bin. The template is saved once from the first
// adjustment layer CutKit finds: a throwaway sequence holding it is exported as a project, then deleted.
CK.findBin = function (name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) if (root.children[i].type === ProjectItemType.BIN && root.children[i].name === name) return root.children[i];
  return null;
};
// The first item in a bin (searched before its sub-bins) that passes test.
CK.findItem = function (bin, test) {
  var i, n = bin.children.numItems;
  for (i = 0; i < n; i++) if (test(bin.children[i])) return bin.children[i];
  for (i = 0; i < n; i++) {
    var b = bin.children[i];
    if (b.type === ProjectItemType.BIN) { var f = CK.findItem(b, test); if (f) return f; }
  }
  return null;
};
// Synthetic clips (adjustment layers, mattes) have no media file.
CK.isSynth = function (it) {
  try { return it.type === ProjectItemType.CLIP && !it.isSequence() && !it.getMediaPath(); } catch (e) { return false; }
};
CK.isAdj = function (it) { return CK.isSynth(it) && /adjust/i.test(it.name); };
CK.findAdj = function () {
  var bin = CK.findBin('CutKit'), it = bin ? CK.findItem(bin, CK.isAdj) : null;
  return it || CK.findItem(app.project.rootItem, CK.isAdj);
};
CK.adjFromTemplate = function (tpl) {
  if (!tpl || !new File(tpl).exists) return null;
  var tmp = app.project.rootItem.createBin('CutKit Import'), it = null;
  try {
    app.project.importFiles([tpl], true, tmp, false);
    it = CK.findItem(tmp, CK.isSynth);
    if (it) it.moveBin(CK.bin('CutKit'));
  } finally { tmp.deleteBin(); }
  return it;
};
CK.saveAdjTemplate = function (item, tpl) {
  var s = app.project.activeSequence, t = null;
  try {
    t = app.project.createNewSequenceFromClips('CutKit Adjustment Template', [item], CK.bin('CutKit'));
    if (t) t.exportAsProject(tpl);
  } catch (e) {}
  if (s) app.project.activeSequence = s;
  if (t) { try { app.project.deleteSequence(t); } catch (e2) {} }
  return new File(tpl).exists;
};
// The highest video track with a clip between a and b (-1 when none).
CK.topVideo = function (s, a, b) {
  var V = s.videoTracks, half = CK.frameDur(s) / 2, top = -1;
  for (var i = 0; i < V.numTracks; i++) {
    var cl = V[i].clips;
    for (var j = 0; j < cl.numItems; j++) {
      var c = cl[j];
      if (c.start.seconds >= b - half) break;
      if (c.end.seconds > a + half) { top = i; break; }
    }
  }
  return top;
};
// The first unlocked video track above top (all of them are empty between a and b), or -1.
CK.freeAbove = function (s, top) {
  for (var i = top + 1; i < s.videoTracks.numTracks; i++) if (!CK.locked(s.videoTracks[i])) return i;
  return -1;
};
// Puts an adjustment layer on the first free video track above the footage: over the selected clips (their whole
// span), or o.len seconds from the playhead when nothing is selected. The new layer ends up selected, ready for effects.
// o.fx: also put that video effect on it (Shift-click adds Transform).
function CK_adjustmentLayer(o) {
  return CK.run(function () {
    var s = CK.seq(), sel = s.getSelection() || [], a = null, b = null, i;
    for (i = 0; i < sel.length; i++) {
      var x0 = sel[i].start.seconds, x1 = sel[i].end.seconds;
      if (a === null || x0 < a) a = x0;
      if (b === null || x1 > b) b = x1;
    }
    var fromSel = a !== null && b > a;
    if (!fromSel) { a = s.getPlayerPosition().seconds; b = a + (o.len > 0 ? o.len : 7); }

    var item = CK.findAdj(), made = '';
    if (!item) { item = CK.adjFromTemplate(o.tpl); if (item) made = 'template'; }
    if (!item) throw new Error('NOADJ');

    var top = CK.topVideo(s, a, b), ti = CK.freeAbove(s, top);
    if (ti < 0) {
      app.enableQE();
      qe.project.getActiveSequence().addTracks(1, s.videoTracks.numTracks, 0);
      s = CK.seq();
      top = CK.topVideo(s, a, b); ti = CK.freeAbove(s, top);
      if (ti < 0) throw new Error('No free video track above the footage. Add a video track in Premiere and try again.');
    }

    var tr = s.videoTracks[ti], half = CK.frameDur(s) / 2;
    item.setInPoint(0, 4); item.setOutPoint(b - a, 4);
    tr.overwriteClip(item, a);
    if (item.clearInPoint) item.clearInPoint();
    if (item.clearOutPoint) item.clearOutPoint();

    // the placed clip: stretch it if Premiere kept the item's own length, then select only it
    var placed = null;
    for (i = 0; i < tr.clips.numItems; i++) if (Math.abs(tr.clips[i].start.seconds - a) < half) { placed = tr.clips[i]; break; }
    if (placed) {
      if (Math.abs(placed.end.seconds - b) > half) { try { placed.end = CK.time(b); } catch (e) {} }
      for (i = 0; i < sel.length; i++) { try { sel[i].setSelected(0, 1); } catch (e2) {} }
      try { placed.setSelected(1, 1); } catch (e3) {}
    }

    // o.fx (Shift-click): a video effect by name (e.g. 'Transform') on the new layer, through QE
    var fx = '';
    if (o.fx) {
      app.enableQE();
      var eff = qe.project.getVideoEffectByName(o.fx);
      if (!eff) fx = 'No video effect called "' + o.fx + '".';
      else {
        var qt = qe.project.getActiveSequence().getVideoTrackAt(ti);
        fx = 'Couldn\'t find the new layer to add ' + o.fx + ' to.';
        for (i = 0; i < qt.numItems; i++) {
          var q = qt.getItemAt(i);
          if (q.type === 'Clip' && Math.abs(Number(q.start.secs) - a) < half) { q.addVideoEffect(eff); fx = 'ok'; break; }
        }
      }
    }

    var saved = false;
    if (o.tpl && !new File(o.tpl).exists) saved = CK.saveAdjTemplate(item, o.tpl);
    return CK.ok({ track: ti, t0: a, t1: placed ? placed.end.seconds : b, fromSel: fromSel, made: made, saved: saved, fx: fx });
  });
}

// Light poll for the panel: which sequence is active and where the playhead is.
function CK_playhead() {
  return CK.run(function () {
    var s = app.project ? app.project.activeSequence : null;
    if (!s) return CK.ok({ none: true });
    return CK.ok({ id: s.sequenceID, name: s.name, t: s.getPlayerPosition().seconds, io: CK.inOut(s) });
  });
}

