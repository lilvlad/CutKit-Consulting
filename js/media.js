// CutKit media: pulls a clip's audio out with ffmpeg, measures its loudness, and transcribes it with Whisper (whisper.cpp).
// Everything runs locally. Results are cached per source file + in/out in ~/Library/Application Support/CutKit/cache.
(function () {
  const CK = window.CK;
  const fs = CK.fs, P = CK.path;
  const M = CK.media = {};

  M.STEP = 0.01;   // loudness is measured every 10 ms

  const which = list => { for (const c of list) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {} } return null; };
  M.ffmpeg = () => which(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
  M.ffprobe = () => which(['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']);
  M.whisper = () => which(['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']);
  const modelFile = name => { const f = P.join(CK.dataDir, 'models', name); return fs && fs.existsSync(f) ? f : null; };
  M.model = () => modelFile('ggml-large-v3-turbo.bin');

  // A cache folder for one stretch of one source file (changes if the file changes).
  M.cacheDir = function (path, inSec, outSec) {
    let st = { size: 0, mtimeMs: 0 };
    try { st = fs.statSync(path); } catch (e) {}
    const key = CK.crypto.createHash('sha1').update(['mix2', path, st.size, Math.round(st.mtimeMs), inSec.toFixed(3), outSec.toFixed(3)].join('|')).digest('hex').slice(0, 16);
    const d = P.join(CK.dataDir, 'cache', key);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // Runs a program; onLine gets each line of stdout+stderr. Resolves with { code, out, err }.
  M.run = function (bin, args, onLine, env) {
    return new Promise(resolve => {
      const c = CK.cp.spawn(bin, args, env ? { env: Object.assign({}, process.env, env) } : undefined);
      let out = '', err = '', buf = '';
      const feed = d => {
        if (!onLine) return;
        buf += d; let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
      };
      c.stdout.on('data', d => { out += d; feed(String(d)); });
      c.stderr.on('data', d => { err += d; feed(String(d)); });
      c.on('error', e => resolve({ code: -1, out, err: e.message }));
      c.on('close', code => resolve({ code, out, err }));
      M.current = c;
    });
  };
  M.stop = () => { try { if (M.current) M.current.kill('SIGTERM'); } catch (e) {} };

  // How many audio streams a file has (cameras often record each mic as its own stream).
  M.audioStreams = async function (path) {
    const fp = M.ffprobe();
    if (!fp) return 1;
    const r = await M.run(fp, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path]);
    return Math.max(1, r.out.trim().split('\n').filter(Boolean).length);
  };

  // 16 kHz mono 16-bit WAV of [inSec, outSec] of the source (the format Whisper wants). Every audio stream is mixed
  // in, so a second speaker on another mic never counts as silence.
  M.extract = async function (path, inSec, outSec, dir, onPct) {
    const wav = P.join(dir, 'audio.wav');
    if (fs.existsSync(wav)) return wav;
    const ff = M.ffmpeg();
    if (!ff) throw new Error('ffmpeg isn\'t installed. In Terminal: brew install ffmpeg');
    const dur = outSec - inSec, n = await M.audioStreams(path);
    const mix = n > 1 ? ['-filter_complex', Array.from({ length: n }, (_, i) => '[0:a:' + i + ']').join('') + 'amix=inputs=' + n + ':normalize=0:duration=longest[m]', '-map', '[m]'] : ['-vn'];
    const r = await M.run(ff, ['-y', '-v', 'error', '-ss', inSec.toFixed(4), '-t', dur.toFixed(4), '-i', path].concat(mix,
      ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', wav + '.part.wav']), l => {
      const m = /^out_time_us=(\d+)/.exec(l);
      if (m && onPct) onPct(Math.min(1, Number(m[1]) / 1e6 / dur));
    });
    if (r.code !== 0) throw new Error('ffmpeg couldn\'t read the audio of ' + P.basename(path) + ': ' + r.err.trim().split('\n').pop());
    fs.renameSync(wav + '.part.wav', wav);
    return wav;
  };

  // Loudness in dB (RMS) for every 10 ms of a 16 kHz mono WAV (env), and the same for its hiss (hf): the second
  // difference of the samples, which keeps the 3-8 kHz part (s, f, t, sh, breath) and drops voice and room rumble.
  // Soft word endings like "it's" or "stuff" barely move the loudness but show clearly in hf.
  M.levels = function (wav) {
    const b = fs.readFileSync(wav);
    let off = 12, data = null;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
      if (id === 'data') { data = b.subarray(off + 8, Math.min(b.length, off + 8 + size)); break; }
      off += 8 + size + (size & 1);
    }
    if (!data) throw new Error('Unreadable audio file.');
    const smp = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
    const win = 160, n = Math.floor(smp.length / win), env = new Float32Array(n), hf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, h = 0;
      for (let j = i * win, e = j + win; j < e; j++) {
        const x = smp[j];
        s += x * x;
        if (j >= 2) { const d = x - 2 * smp[j - 1] + smp[j - 2]; h += d * d; }
      }
      env[i] = Math.max(-90, 10 * Math.log10(s / win / 1073741824 + 1e-12));
      hf[i] = Math.max(-90, 10 * Math.log10(h / win / 16 / 1073741824 + 1e-12));   // /16: a full-scale square wave reads 0 dB
    }
    return { env, hf };
  };
  M.envelope = wav => M.levels(wav).env;

  // Whisper keeps "um", "uh" and stumbles when its prompt is written like that (it tidies them away otherwise).
  const PROMPT = 'Umm, so, uh, I was, I was thinking, like, hmm... Okay. So the, the main thing is, um, timing.';

  // Whisper sometimes repeats a line it already wrote, with times running backwards, so the copy ends up squeezed
  // 0.02 s apart. A squeezed run of 4+ words that exactly repeats the words just before it is dropped.
  const normW = w => String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  M.dropGhosts = function (W) {
    const drop = new Set();
    for (let i = 1; i < W.length; i++) {
      if (!W[i].squeezed) continue;
      let j = i;
      while (j + 1 < W.length && W[j + 1].squeezed) j++;
      const a = i - 1, n = j - a + 1;                    // the run starts at the word before the first squeezed one
      if (n >= 4) {
        const run = W.slice(a, j + 1).map(w => normW(w.w)).join(' ');
        const before = W.slice(Math.max(0, a - 80), a).map(w => normW(w.w)).join(' ');
        if (before.indexOf(run) >= 0) for (let k = a; k <= j; k++) drop.add(k);
      }
      i = j;
    }
    return drop.size ? W.filter((w, k) => !drop.has(k)) : W;
  };

  // Words from the start of the WAV: [{ w, at, t0, t1 }]. `at` is Whisper's DTW time for the word, a point just inside it
  // (reliable even after pauses, unlike its segment times); detect.placeWords turns it into a start and end from the audio.
  M.transcribe = async function (wav, dir, onPct) {
    const cache = P.join(dir, 'words.json');
    const hit = CK.readJSON(cache, null);
    if (hit && hit.v === 4) return hit.words;
    const bin = M.whisper(), model = M.model();
    if (!bin) throw new Error('Whisper isn\'t installed. Run "Install CutKit on Mac.command" again.');
    if (!model) throw new Error('The Whisper model is missing. Run "Install CutKit on Mac.command" again.');
    const base = P.join(dir, 'whisper');
    // -dtw only works with flash attention off (-nfa); the token times then come back as t_dtw in the full JSON
    const args = ['-m', model, '-f', wav, '-l', CK.settings.lang || 'auto', '-ojf', '-of', base, '-pp',
      '-dtw', 'large.v3.turbo', '-nfa', '--prompt', PROMPT];
    const r = await M.run(bin, args, l => {
      const m = /progress\s*=\s*(\d+)%/.exec(l);
      if (m && onPct) onPct(Number(m[1]) / 100);
    });
    if (r.code !== 0) throw new Error('Whisper failed: ' + r.err.trim().split('\n').slice(-2).join(' '));
    const j = CK.readJSON(base + '.json', null);
    if (!j || !Array.isArray(j.transcription)) throw new Error('Whisper didn\'t write a transcript.');
    const words = [];
    for (const seg of j.transcription) {
      for (const t of seg.tokens || []) {
        const raw = String(t.text || '');
        if (!raw.trim() || /^\[_/.test(raw) || /^\s*\[.*\]\s*$/.test(raw)) continue;   // [_BEG_], timestamps, [BLANK_AUDIO]
        const at = t.t_dtw >= 0 ? t.t_dtw / 100 : t.offsets.from / 1000;
        // a token without a leading space continues the word ("Tim" + "ing", "I" + "'m", punctuation)
        if (words.length && !/^\s/.test(raw)) { words[words.length - 1].w += raw.trim(); continue; }
        words.push({ w: raw.trim(), at, t0: at, t1: t.offsets.to / 1000 });
      }
    }
    // drop sound-effect captions like "(music)" and keep the anchors in order
    let out = words.filter(w => !/^[(\[].*[)\]]$/.test(w.w));
    for (let i = 1; i < out.length; i++) if (out[i].at < out[i - 1].at + 0.02) { out[i].at = out[i - 1].at + 0.02; out[i].squeezed = true; }
    out = M.dropGhosts(out);
    out.forEach(w => { delete w.squeezed; });
    CK.writeJSON(cache, { v: 4, words: out });
    return out;
  };

  // ---------- speech detection (Silero VAD, the copy that comes with whisper.cpp) ----------
  M.vadBin = () => which(['/opt/homebrew/bin/whisper-vad-speech-segments', '/usr/local/bin/whisper-vad-speech-segments']);
  M.vadModel = () => modelFile('ggml-silero-v6.2.0.bin');
  // Where someone is speaking: [[start, end]] in seconds from the start of the WAV, or null if the detector isn't installed.
  // A low threshold (0.35) and no padding: it should catch quiet speech, and CutKit adds its own margins.
  M.vad = async function (wav, dir) {
    const cache = P.join(dir, 'vad.json');
    const hit = CK.readJSON(cache, null);
    if (hit && hit.v === 1) return hit.segs;
    const bin = M.vadBin(), model = M.vadModel();
    if (!bin || !model) return null;
    const r = await M.run(bin, ['-f', wav, '-vm', model, '-vt', '0.35', '-vspd', '100', '-vsd', '100', '-vp', '0', '-np']);
    if (r.code !== 0) return null;
    // "Speech segment 3: start = 560.00, end = 1251.00" (hundredths of a second)
    const segs = [];
    const re = /start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(r.out + '\n' + r.err))) segs.push([Number(m[1]) / 100, Number(m[2]) / 100]);
    CK.writeJSON(cache, { v: 1, segs });
    return segs;
  };

  // ---------- exact word times (tools/words.py, in CutKit's own Python) ----------
  // align   = Whisper's words lined up on the audio by wav2vec2 (Apache 2.0, fine for paid work)
  // crisper = CrisperWhisper 2.0 writes the transcript itself (every um, stutter, false start) with word times
  //           (its licence is non-commercial: personal projects only, unless licensed from nyra health)
  M.python = () => { const f = P.join(CK.dataDir, 'py', 'bin', 'python'); return fs.existsSync(f) ? f : null; };
  const hfDir = () => P.join(CK.dataDir, 'models', 'hf');
  const hasModel = id => fs.existsSync(P.join(hfDir(), 'hub', 'models--' + id.replace('/', '--')));
  M.engines = () => ({
    align: !!M.python() && hasModel('facebook/wav2vec2-large-960h-lv60-self'),
    crisper: !!M.python() && hasModel('nyralabs/CrisperWhisper2.0_large')
  });
  // [{ w, t0, t1, score }] from the start of the WAV. For 'align', the same list and order as Whisper's words
  // (t0/t1 null where a word couldn't be placed).
  M.wordTimes = async function (engine, wav, dir, onPct) {
    const cache = P.join(dir, 'words-' + engine + '.json');
    const hit = CK.readJSON(cache, null);
    if (hit && hit.v === 1) return hit.words;
    const py = M.python();
    if (!py || !M.engines()[engine]) throw new Error((engine === 'crisper' ? 'CrisperWhisper' : 'The word aligner') + ' isn\'t installed. Pick another Word Timing in Settings.');
    const script = P.join(CK.extDir, 'tools', 'words.py');
    const lang = !CK.settings.lang || CK.settings.lang === 'auto' ? 'en' : CK.settings.lang;
    const args = engine === 'align' ? [script, 'align', wav, P.join(dir, 'words.json'), cache] : [script, 'crisper', wav, cache, lang];
    const r = await M.run(py, args, l => {
      const m = /progress\s*=\s*(\d+)%/.exec(l);
      if (m && onPct) onPct(Number(m[1]) / 100);
    }, { HF_HOME: hfDir(), HF_HUB_OFFLINE: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1', TOKENIZERS_PARALLELISM: 'false' });
    const j = CK.readJSON(cache, null);
    if (r.code !== 0 || !j) throw new Error('Word timing (' + engine + ') failed: ' + r.err.trim().split('\n').slice(-2).join(' '));
    return j.words;
  };
})();
