// CutKit bridge: talks to Premiere Pro (ExtendScript) and exposes Node for audio, Whisper and Claude.
/* global window */
(function () {
  const CK = window.CK = window.CK || {};
  const inPR = !!window.__adobe_cep__;
  const req = typeof window.require === 'function' ? window.require : null;
  CK.inPR = inPR;
  CK.fs = req ? req('fs') : null;
  CK.path = req ? req('path') : null;
  CK.os = req ? req('os') : null;
  CK.cp = req ? req('child_process') : null;
  CK.crypto = req ? req('crypto') : null;

  CK.extDir = (function () {
    if (!inPR) return null;
    let p = window.__adobe_cep__.getSystemPath('extension');
    p = decodeURIComponent(String(p).replace(/^file:\/\//, ''));
    try { p = CK.fs.realpathSync(p); } catch (e) {}
    return p;
  })();
  CK.dataDir = CK.os ? CK.path.join(CK.os.homedir(), 'Library', 'Application Support', 'CutKit') : null;

  // One call to Premiere at a time, so calls never interleave.
  let queue = Promise.resolve();
  CK.evalRaw = function (code) {
    const run = () => new Promise(resolve => {
      if (!inPR) { resolve('{"ok":false,"error":"Not running inside Premiere Pro."}'); return; }
      window.__adobe_cep__.evalScript(code, r => resolve(r == null ? '' : String(r)));
    });
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  };
  const parse = r => { try { const o = JSON.parse(r); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };

  // A JSON literal is a valid ExtendScript literal; non-ASCII is escaped so it survives the trip intact.
  CK.lit = v => JSON.stringify(v).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));

  // Calls a host function with one object argument. If Premiere lost CutKit's functions, reload them once and retry
  // (a missing function never ran, so retrying can't double an edit).
  CK.host = async function (fn, arg) {
    const code = fn + '(' + (arg === undefined ? '' : CK.lit(arg)) + ')';
    let o = parse(await CK.evalRaw(code));
    if (!o && inPR) {
      const alive = await CK.evalRaw('typeof ' + fn + ' === "function" ? "yes" : "no"');
      if (alive !== 'yes') {
        const r = await CK.loadHost();
        if (!r.ok) return r;
        o = parse(await CK.evalRaw(code));
      }
    }
    return o || { ok: false, error: 'Premiere didn\'t answer ' + fn + '.' };
  };

  CK.loadHost = async function () {
    if (!inPR || !CK.fs) return { ok: false, error: 'Not running inside Premiere Pro.' };
    const f = CK.path.join(CK.extDir, 'host', 'ck_main.jsx');
    let src;
    try { src = CK.fs.readFileSync(f, 'utf8'); } catch (e) { return { ok: false, error: 'Missing host file ' + f }; }
    const r = await CK.evalRaw('try { eval(' + CK.lit(src) + '); "OK"; } catch (e) { "ERR:" + e.message + " (line " + e.line + ")"; }');
    if (r !== 'OK') return { ok: false, error: 'ck_main.jsx: ' + String(r).replace(/^ERR:/, '') };
    return parse(await CK.evalRaw('CK_ping()')) || { ok: false, error: 'The script loaded but Premiere didn\'t answer.' };
  };

  CK.fileUrl = p => 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');

  // ---------- settings ----------
  const settingsFile = CK.dataDir ? CK.path.join(CK.dataDir, 'settings.json') : null;
  CK.readJSON = (f, fallback) => { try { return JSON.parse(CK.fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; } };
  CK.writeJSON = function (f, data) {
    CK.fs.mkdirSync(CK.path.dirname(f), { recursive: true });
    CK.fs.writeFileSync(f + '.tmp', JSON.stringify(data));
    CK.fs.renameSync(f + '.tmp', f);
  };
  const saved = settingsFile ? CK.readJSON(settingsFile, {}) : {};
  // older settings had one "Leave" value split evenly around the cut; it becomes the two paddings (ms)
  if (saved.tail == null && saved.keep != null) { saved.tail = saved.lead = Math.round(saved.keep * 500); delete saved.keep; }
  // Very Tight used to keep 30 / 20 ms; CutKit now never keeps less than 40 ms after / 50 ms before a word
  if (saved.minSil === 0.25 && saved.tail === 30 && saved.lead === 20) { saved.tail = 40; saved.lead = 50; }
  CK.settings = Object.assign({
    thr: -42, thrAuto: true, minSil: 0.5, tail: 150, lead: 120,
    silence: true, fillers: true, takes: true, backup: true, model: 'sonnet', lang: 'auto',
    scopeIO: false, xfade: false, xfadeName: null, xfadeFrames: null, wordEngine: 'align', adjLen: 7
  }, saved);

  // Premiere's own default audio transition and its length (Preferences > Timeline), read from its prefs file.
  CK.premiereDefaults = function () {
    const out = { name: 'Constant Power', frames: 4 };
    if (!CK.fs) return out;
    try {
      const root = CK.path.join(CK.os.homedir(), 'Documents', 'Adobe', 'Premiere Pro');
      const ver = CK.fs.readdirSync(root).filter(v => /^\d/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a))[0];
      const prof = CK.fs.readdirSync(CK.path.join(root, ver)).find(d => /^Profile-/.test(d));
      const x = CK.fs.readFileSync(CK.path.join(root, ver, prof, 'Adobe Premiere Pro Prefs'), 'utf8');
      const get = k => { const m = new RegExp('<' + k + '>\\s*([^<]*?)\\s*<').exec(x); return m ? m[1] : null; };
      const name = get('BE.Prefs.DefaultAudioTransition'), unit = get('BE.Prefs.DefaultAudioTransitionDurationUnit');
      const fr = Number(get('BE.Prefs.DefaultAudioTransitionDurationInFrames')), sec = Number(get('BE.Prefs.DefaultAudioTransitionDurationInSeconds'));
      if (name) out.name = name;
      if (unit === '0' && fr > 0) out.frames = fr;
      else if (sec > 0) out.seconds = sec;
    } catch (e) {}
    return out;
  };
  let saveT = null;
  CK.save = function () {
    if (!settingsFile) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => CK.writeJSON(settingsFile, CK.settings), 300);
  };
})();
