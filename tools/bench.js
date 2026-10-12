// CutKit silence bench: runs CutKit's own detection (js/detect.js) on a cached analysis, outside Premiere, and counts how
// often a cut would touch a word. Compares the old loudness-only cutting with the new word-protected one.
//   node tools/bench.js <cache folder> [--fps 25] [--ref crisper|align] [--list]
// The cache folder is one in ~/Library/Application Support/CutKit/cache (audio.wav, words.json, and once analysed with
// them: vad.json, words-align.json, words-crisper.json). The reference words (the most precise timing there is) decide
// what counts as "touched"; each engine is also tested against it.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), dir = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!dir || !fs.existsSync(path.join(dir, 'audio.wav'))) { console.log('usage: node tools/bench.js <cache folder> [--fps 25] [--ref crisper|align] [--list]'); process.exit(1); }
const FPS = Number(opt('fps', 25)), LIST = args.includes('--list');

global.window = { CK: { fs, path, crypto: require('crypto'), settings: {}, readJSON: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } } } };
const CK = window.CK;
for (const f of ['media.js', 'detect.js']) eval(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'));
const D = CK.detect, M = CK.media, STEP = 0.01;

const read = f => CK.readJSON(path.join(dir, f), null);
const lv = M.levels(path.join(dir, 'audio.wav'));
const end = lv.env.length * STEP;
const vad = read('vad.json');
const speech = vad ? new Uint8Array(lv.env.length) : null;
if (vad) for (const [a, b] of vad.segs) for (let k = Math.round(a / STEP); k < Math.round(b / STEP) && k < speech.length; k++) speech[k] = 1;
const whisper = read('words.json').words;
const align = read('words-align.json'), crisper = read('words-crisper.json');

// an analysis like main.js builds it, for one engine
function analysis(engine) {
  let words;
  if (engine === 'crisper') words = crisper.words.filter(w => w.t0 != null).map(w => ({ w: w.w, at: w.t0 + 0.02, m0: w.t0, m1: w.t1, score: w.score }));
  else words = whisper.map((w, k) => {
    const T = engine === 'align' && align.words[k] && align.words[k].t0 != null ? align.words[k] : null;
    return { w: w.w, at: w.at, m0: T ? Math.max(0, T.t0 - 0.03) : null, m1: T ? T.t1 + 0.03 : null, score: T ? T.score : undefined };
  });
  words.forEach(w => { w.t0 = w.t1 = w.at; w.seg = 0; });
  const A = { end, frame: 1 / FPS, env: lv.env, hf: lv.hf, speech, segs: [{ start: 0, end, name: 'x' }], words };
  D.placeWords(A, D.autoThr(A));
  for (const w of words) if (w.m0 != null && w.m1 != null) { w.t0 = w.m0; w.t1 = Math.max(w.m1, w.m0 + 0.04); w.measured = true; }
  D.fillUnmeasured(words);
  for (const w of words) { w.r0 = w.t0; w.r1 = w.t1; }
  return A;
}

// the old way (before 2026-10-08): one threshold for the whole shoot, loudness only, edges rounded to the nearest frame
function oldRanges(A, p) {
  const thr = D.autoThr(A), out = [];
  let run = -1;
  for (let i = 0; i <= A.env.length; i++) {
    const q = i < A.env.length && A.env[i] < thr;
    if (q && run < 0) run = i;
    else if (!q && run >= 0) {
      const s = run * STEP, e = i * STEP; run = -1;
      if (e - s < p.minSil) continue;
      const cs = s <= STEP ? 0 : s + p.oldTail / 1000, ce = e >= A.end - STEP ? A.end : e - p.oldLead / 1000;
      if (ce - cs > 0.04) out.push([Math.round(cs * FPS) / FPS, Math.round(ce * FPS) / FPS]);
    }
  }
  return out.filter(([s, e]) => e - s >= 2 / FPS);
}

function newRanges(A, p) {
  const o = { thrAuto: true, thr: D.autoThr(A), minSil: p.minSil, tail: p.tail / 1000, lead: p.lead / 1000 };
  const sil = D.silences(A, o).map(c => Object.assign(c, { on: true }));
  return D.ranges(A, sil, A.frame, null);
}

// the reference: the most precise word times there are, without the words nobody said
const refName = opt('ref', crisper ? 'crisper' : align ? 'align' : 'whisper');
const REF = analysis(refName);
D.prepare(REF, { thrAuto: true });
const ref = REF.words.filter(w => !w.ghost);
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');
function touched(R) {
  const hit = [];
  let k = 0;
  for (const w of ref) {
    while (k < R.length && R[k][1] <= w.r0 + 0.01) k++;
    for (let j = k; j < R.length && R[j][0] < w.r1 - 0.01; j++) { hit.push({ w, by: Math.min(R[j][1], w.r1) - Math.max(R[j][0], w.r0) }); break; }
  }
  return hit;
}

console.log(path.basename(dir) + ': ' + (end / 60).toFixed(1) + ' min, ' + FPS + ' fps. Speech detector: ' + (vad ? 'yes' : 'no') +
  '. Reference words: ' + refName + ' (' + ref.length + ', ' + (REF.words.length - ref.length) + ' not really said)');
const PRESETS = [
  { name: 'Natural', minSil: 0.5, tail: 150, lead: 120, oldTail: 150, oldLead: 120 },
  { name: 'Very Tight', minSil: 0.25, tail: 40, lead: 50, oldTail: 30, oldLead: 20 }
];
const engines = ['whisper'].concat(align ? ['align'] : [], crisper ? ['crisper'] : []);
for (const p of PRESETS) {
  console.log('\n' + p.name);
  const rows = [['old (loudness only)', oldRanges(analysis('whisper'), p)]];
  for (const e of engines) { const A = analysis(e); const R = newRanges(A, p); rows.push(['new, ' + e + ' words', R, D.guarded.length]); }
  for (const [label, R, g] of rows) {
    const hit = touched(R), removed = R.reduce((s, r) => s + r[1] - r[0], 0);
    console.log('  ' + label.padEnd(22) + String(R.length).padStart(5) + ' cuts, removes ' + fmt(removed) + ', words touched: ' + String(hit.length).padStart(3) +
      ' (' + hit.filter(h => h.by > 0.05).length + ' by more than 50 ms)' + (g ? ', guard trimmed ' + g : ''));
    if (LIST) hit.slice(0, 15).forEach(h => console.log('      ' + fmt(h.w.r0) + '  "' + h.w.w + '"  ' + Math.round(h.by * 1000) + ' ms'));
  }
}
