// CutKit Claude: reads the transcript and finds repeated takes, false starts and stumbles.
// Runs Claude Code headless (the same program and sign-in EditKit's Claude tab uses), with no tools.
(function () {
  const CK = window.CK;
  const fs = CK.fs, P = CK.path;
  const C = CK.claude = {};

  C.find = function () {
    const home = CK.os.homedir(), list = [];
    const ek = CK.readJSON(P.join(home, 'Library', 'Application Support', 'EditKit', 'settings.json'), {});
    if (CK.settings.claudePath) list.push(CK.settings.claudePath);
    if (ek.claudePath) list.push(ek.claudePath);
    list.push(P.join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', P.join(home, '.claude/local/claude'));
    const root = P.join(home, 'Library/Application Support/Claude/claude-code');
    try {
      fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .forEach(v => {
          list.push(P.join(root, v, 'claude.app/Contents/MacOS/claude'));
          // newer desktop apps keep it one folder deeper: <version>/<build id>/claude.app
          try { fs.readdirSync(P.join(root, v)).forEach(b => list.push(P.join(root, v, b, 'claude.app/Contents/MacOS/claude'))); } catch (e) {}
        });
    } catch (e) {}
    for (const c of list) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {} }
    return null;
  };

  // { found, bin, loggedIn, email, org, plan } from `claude auth status` (no tokens spent).
  C.status = function () {
    return new Promise(resolve => {
      const bin = C.find();
      if (!bin) { resolve({ found: false }); return; }
      CK.cp.execFile(bin, ['auth', 'status'], { timeout: 15000 }, (err, stdout) => {
        let s = {};
        try { s = JSON.parse(stdout); } catch (e) {}
        resolve({ found: true, bin, loggedIn: !!s.loggedIn, email: s.email || '', org: s.orgName || '', plan: s.subscriptionType || '' });
      });
    });
  };
  // Opens Terminal to sign in (the login itself happens in the browser). switchAccount: sign out first.
  C.login = function (switchAccount) {
    const bin = C.find();
    if (!bin) return false;
    const q = "'" + bin.replace(/'/g, "'\\''") + "'";
    const cmd = (switchAccount ? q + ' auth logout; ' : '') + q + ' auth login';
    CK.cp.execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script ' + JSON.stringify(cmd)]);
    return true;
  };

  const SYSTEM = [
    'You are an assistant editor cutting a talking-head recording. You get a word-by-word transcript; every word has an index in brackets.',
    'Find the parts an editor would remove so the speaker sounds clean, and answer with JSON only.',
    '',
    'Look for:',
    '- "repeat": the speaker says a line (or part of one), then says it again. Remove the earlier attempt(s) and KEEP THE LAST complete take.',
    '- "false_start": a sentence started and abandoned, then restarted differently. Remove the abandoned beginning.',
    '- "stumble": a stuttered or doubled word or short phrase ("I, I think", "the the"). Remove the extra copy, keep the last.',
    '',
    'Rules:',
    '- Ranges are inclusive word indices to REMOVE. Include fillers (um, uh) that sit inside a removed range, but never flag a filler on its own.',
    '- A removed range must end right before the take that is kept, so the edit joins cleanly.',
    '- Be conservative: never remove content that is said only once, deliberate repetition for emphasis, or lists.',
    '- Example: "[38]is, [39]is [40]everything" → {"from":38,"to":38,"kind":"stumble"} (only the first "is"; the last copy always stays).',
    '- If a retake is preceded by an aside like "let me say that again" or "sorry", include the aside in the removed range.',
    '',
    'Output exactly: {"cuts":[{"from":12,"to":20,"kind":"repeat","why":"first try of the intro line"}]}  ("why" under 10 words). If nothing, {"cuts":[]}.'
  ].join('\n');

  // Pass 1: the shape of the whole shoot. Sentences, not words, so a long recording fits in one request.
  const STRUCT = [
    'You are an assistant editor. You get the transcript of one camera recording from a video shoot (a talking head, an interview,',
    'a podcast or a debate). The camera often keeps rolling between takes: people redo an intro, a statement or an answer several times,',
    'and in between they talk about the take (setting up, "good to go?", "three, two, one", feedback, "be a bit stronger", "let\'s do one more").',
    'The transcript is split into numbered lines (one sentence or one phrase between pauses). Find:',
    '',
    '- "parts": every part that was attempted more than once (an intro, a statement, an answer). List ALL its attempts ("takes") in order,',
    '  including the good one. Takes can be several minutes long and are usually reworded each time, so compare meaning and purpose,',
    '  not exact words. "keep" is the index (0-based) of the take to keep: the LAST complete attempt (if the last one is abandoned',
    '  or cut short, the last complete one). Give each part a short name ("Intro", "Mark: why we disagree").',
    '- "offtake": talk that is not meant for the video: preparation, countdowns, feedback and directions between takes, discussing how to',
    '  say something, crew or small talk around the takes.',
    '',
    'Rules:',
    '- The real content (the final takes, and the actual conversation or debate once it runs) stays, even when people repeat points or argue.',
    '  A part said only once is not listed.',
    '- Takes and offtake ranges don\'t overlap. Be precise about each range\'s first and last line.',
    '- When unsure whether something is real content, leave it.',
    '',
    'Output JSON only:',
    '{"parts":[{"name":"Intro","takes":[{"from":5,"to":20},{"from":31,"to":44},{"from":52,"to":66}],"keep":2}],',
    ' "offtake":[{"from":21,"to":30,"why":"feedback between takes"}]}',
    'with inclusive line numbers. "why" under 10 words. If nothing, {"parts":[],"offtake":[]}.'
  ].join('\n');

  // Sentence-sized lines: a new line after . ? ! or at a pause, and at most 35 words. [{ a, b }] word indices.
  C.lines = function (words, from, to) {
    const out = [];
    let a = from;
    for (let i = from; i < to; i++) {
      const at = w => (w.at != null ? w.at : w.t0);   // Whisper's anchors are steadier than word ends for spotting pauses
      const end = i === to - 1 || /[.?!]["')\]]*$/.test(words[i].w) || at(words[i + 1]) - at(words[i]) > 1.2 || i - a >= 34;
      if (end) { out.push({ a, b: i }); a = i + 1; }
    }
    return out;
  };

  function ask(prompt, system, model, effort) {
    return new Promise((resolve, reject) => {
      const bin = C.find();
      if (!bin) { reject(new Error('Claude Code isn\'t installed. Install the Claude desktop app, then check CutKit > Settings > Claude.')); return; }
      const dir = P.join(CK.dataDir, 'claude');
      fs.mkdirSync(dir, { recursive: true });
      const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--model', model || CK.settings.model || 'sonnet',
        '--effort', effort || 'medium', '--system-prompt', system || SYSTEM];
      const c = CK.cp.spawn(bin, args, { cwd: dir });
      running.add(c);
      c.on('close', () => running.delete(c));
      let out = '', err = '';
      c.stdout.on('data', d => { out += d; });
      c.stderr.on('data', d => { err += d; });
      c.on('error', e => reject(new Error('Could not start Claude Code: ' + e.message)));
      c.on('close', code => {
        let r = null;
        try { r = JSON.parse(out); } catch (e) {}
        if (r && !r.is_error && typeof r.result === 'string') { resolve(r.result); return; }
        if (/not logged in|login|authenticat/i.test(err + out)) reject(new Error('Claude Code isn\'t signed in. Sign in from CutKit > Settings > Claude.'));
        else reject(new Error((r && r.result) || err.trim().split('\n').pop() || 'Claude Code stopped (exit ' + code + ').'));
      });
      c.stdin.write(prompt);
      c.stdin.end();
    });
  }
  const running = new Set();
  C.stop = () => { running.forEach(c => { try { c.kill('SIGTERM'); } catch (e) {} }); };

  // The first balanced {...} that has `key` as an array, even with prose or code fences around it.
  C.parseObj = (text, key) => {
    text = String(text || '');
    for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
      let depth = 0, str = false;
      for (let k = i; k < text.length; k++) {
        const ch = text[k];
        if (str) { if (ch === '\\') k++; else if (ch === '"') str = false; continue; }
        if (ch === '"') str = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { const j = JSON.parse(text.slice(i, k + 1)); if (j && Array.isArray(j[key])) return j; } catch (e) {}
          break;
        }
      }
    }
    throw new Error('Claude\'s answer wasn\'t readable. Untick and tick Retakes to try again.');
  };
  // The first balanced {...} that has "cuts", even with prose or code fences around it.
  C.parseCuts = text => {
    text = String(text || '');
    for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
      let depth = 0, str = false;
      for (let k = i; k < text.length; k++) {
        const ch = text[k];
        if (str) { if (ch === '\\') k++; else if (ch === '"') str = false; continue; }
        if (ch === '"') str = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { const j = JSON.parse(text.slice(i, k + 1)); if (j && Array.isArray(j.cuts)) return j.cuts; } catch (e) {}
          break;
        }
      }
    }
    throw new Error('Claude\'s answer wasn\'t readable. Untick and tick Retakes to try again.');
  };
  const parseCuts = C.parseCuts;

  // A stumble must leave one copy: words a..b have to be said again right after. If Claude's range also took the
  // kept copy, shrink it to the longest start that repeats; if nothing repeats, drop it.
  const norm = w => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');
  C.checkStumble = function (words, a, b) {
    const same = (x, y, n) => { for (let k = 0; k < n; k++) if (!words[y + k] || norm(words[x + k].w) !== norm(words[y + k].w)) return false; return true; };
    for (let e = b; e >= a; e--) if (same(a, e + 1, e - a + 1)) return e;
    return -1;
  };

  // A retake range sometimes starts one word late ("If [you leave…] if you leave"): while the words just before it
  // match the start of the kept take, pull them into the cut.
  C.checkRepeat = function (words, a, b) {
    const eq = (x, y) => words[x] && words[y] && norm(words[x].w) === norm(words[y].w);
    while (a > 0 && eq(a - 1, b + 1) && eq(a, b + 2)) a--;
    return a;
  };
  function check(list) {
    return list.map(c => c.kind === 'stumble' ? Object.assign({}, c, { b: C.checkStumble(words_, c.a, c.b) })
      : c.kind === 'repeat' || c.kind === 'false_start' ? Object.assign({}, c, { a: C.checkRepeat(words_, c.a, c.b) })
      : Object.assign({}, c)).filter(c => c.b >= c.a);
  }
  let words_ = [];

  // words: [{ w, t0 }] → [{ kind, a, b, why }]. Long transcripts go in chunks that overlap a little.
  // Answers are cached by the transcript text, so re-opening the same sequence is instant.
  // words: [{ w, t0, t1 }] → [{ kind, a, b, why }] word ranges to cut.
  // Pass 1 (Opus, high effort) reads the whole recording as sentences and marks earlier takes and talk between takes.
  // Pass 2 (Sonnet) reads what's left word by word for repeats, false starts and stumbles, a few chunks in parallel.
  // Answers are cached by the transcript text and the models, so re-opening the same sequence is instant.
  C.takes = async function (words, onPct) {
    words_ = words;
    const S = CK.settings, m1 = S.structModel || 'opus', m2 = S.model || 'sonnet';
    const key = CK.crypto.createHash('sha1').update('v4|' + m1 + '|' + m2 + '|' + words.map(w => w.w).join(' ')).digest('hex').slice(0, 16);
    const cacheF = P.join(CK.dataDir, 'cache', 'takes-' + key + '.json');
    const hit = CK.readJSON(cacheF, null);
    if (hit && hit.v === 4) return { parts: hit.parts, cuts: check(hit.cuts) };
    const out = [], parts = [];
    const tell = (p, text) => { if (onPct) onPct(p, text); };

    // ---- pass 1: structure (chunks of ~12000 words, overlapping by 2000, so a 2-hour shoot is 2 requests) ----
    const N1 = 12000, OV1 = 2000, starts1 = [];
    for (let s0 = 0; s0 < words.length; s0 += N1 - OV1) { starts1.push(s0); if (s0 + N1 >= words.length) break; }
    for (let k = 0; k < starts1.length; k++) {
      tell(k / (starts1.length + 1), 'Claude (' + m1 + ') is reading the whole shoot for earlier takes' + (starts1.length > 1 ? ' (' + (k + 1) + '/' + starts1.length + ')' : '') + '…');
      const a = starts1[k], b = Math.min(words.length, a + N1), L = C.lines(words, a, b);
      const text = L.map((l, n) => 'L' + (n + 1) + ' [' + fmtT(words[l.a].t0) + '] ' + words.slice(l.a, l.b + 1).map(w => w.w).join(' ')).join('\n');
      const ans = C.parseObj(await ask('Transcript lines (L<number> [time]):\n\n' + text, STRUCT, m1, 'high'), 'parts');
      const span = r => { const f = Math.max(1, Math.min(L.length, r.from | 0)), t = Math.max(f, Math.min(L.length, r.to | 0)); return { a: L[f - 1].a, b: L[t - 1].b }; };
      for (const p of ans.parts || []) {
        const takes = (p.takes || []).map(span).sort((x, y) => x.a - y.a);
        if (takes.length < 2) continue;
        // the overlap of two chunks can report the same part twice: keep the first
        if (parts.some(q => q.takes.some(t => takes.some(u => u.a <= t.b && t.a <= u.b)))) continue;
        parts.push({ name: String(p.name || 'Part').slice(0, 60), takes, keep: Math.max(0, Math.min(takes.length - 1, p.keep == null ? takes.length - 1 : p.keep | 0)) });
      }
      for (const r of ans.offtake || []) {
        const x = span(r);
        if (!out.some(y => y.a <= x.b && x.a <= y.b)) out.push({ kind: 'offtake', a: x.a, b: x.b, why: String(r.why || '').slice(0, 80) });
      }
    }
    parts.sort((x, y) => x.takes[0].a - y.takes[0].a);

    // ---- pass 2: details in the words that stay (chunks of ~1500 kept words, 3 at a time) ----
    const gone = new Uint8Array(words.length);
    out.forEach(c => { for (let i = c.a; i <= c.b; i++) gone[i] = 1; });
    parts.forEach(p => p.takes.forEach((t, n) => { if (n !== p.keep) for (let i = t.a; i <= t.b; i++) gone[i] = 1; }));
    const kept = [];
    for (let i = 0; i < words.length; i++) if (!gone[i]) kept.push(i);
    const N2 = 1500, OV2 = 60, chunks = [];
    for (let s0 = 0; s0 < kept.length; s0 += N2 - OV2) { chunks.push(kept.slice(s0, s0 + N2)); if (s0 + N2 >= kept.length) break; }
    let done = 0;
    tell(starts1.length / (starts1.length + 1), 'Claude (' + m2 + ') is checking the kept takes for stumbles and false starts…');
    const detail = async ids => {
      const lines = [];
      let line = [];
      for (let n = 0; n < ids.length; n++) {
        const i = ids[n];
        // a new line at each pause, and where removed takes were taken out ("…")
        if (line.length && (i !== ids[n - 1] + 1 || words[i].t0 - words[i - 1].t1 > 0.7)) { lines.push(line.join(' ')); line = []; if (i !== ids[n - 1] + 1) lines.push('…'); }
        line.push('[' + i + ']' + words[i].w);
      }
      if (line.length) lines.push(line.join(' '));
      const ans = await ask('Transcript (a new line = a pause, "…" = a removed part):\n\n' + lines.join('\n'), SYSTEM, m2, 'medium');
      const lo = ids[0], hi = ids[ids.length - 1];
      for (const c of parseCuts(ans)) {
        const f = Math.max(lo, Math.min(hi, c.from | 0)), t = Math.max(f, Math.min(hi, c.to | 0));
        if (gone[f] || gone[t]) continue;
        if (!out.some(x => x.a === f && x.b === t)) out.push({ kind: ['repeat', 'false_start', 'stumble'].indexOf(c.kind) >= 0 ? c.kind : 'repeat', a: f, b: t, why: String(c.why || '').slice(0, 80) });
      }
      done++;
      tell((starts1.length + done / chunks.length) / (starts1.length + 1), null);
    };
    for (let k = 0; k < chunks.length; k += 3) await Promise.all(chunks.slice(k, k + 3).map(detail));

    out.sort((x, y) => x.a - y.a);
    const res = { v: 4, parts, cuts: out };
    CK.writeJSON(cacheF, res);
    return { parts, cuts: check(out) };
  };
  const fmtT = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
})();
