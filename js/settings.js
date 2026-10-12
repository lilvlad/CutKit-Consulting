// CutKit: Settings view (bottom of the sidebar). Reload Panel / Premiere Scripts, so file changes show without restarting Premiere.
(function () {
  const CK = window.CK, A = CK.app, $ = A.$;

  function about() {
    let ver = '';
    try { ver = (/ExtensionBundleVersion="([^"]+)"/.exec(CK.fs.readFileSync(CK.path.join(CK.extDir, 'CSXS', 'manifest.xml'), 'utf8')) || [])[1] || ''; } catch (e) {}
    $('#set-about').textContent = 'CutKit' + (ver ? ' ' + ver : '') + (CK.extDir ? ' · ' + CK.extDir : ' · preview mode');
    $('#set-data').textContent = CK.dataDir || '(only inside Premiere Pro)';
    $('#set-data-open').disabled = !CK.dataDir;
  }

  async function claudeStatus() {
    const st = $('#set-cc-status');
    if (!CK.cp) { st.textContent = 'Claude sign-in works only inside Premiere Pro.'; return; }
    st.textContent = 'Checking Claude Code…';
    const s = await CK.claude.status();
    $('#set-cc-login').hidden = !s.found || s.loggedIn;
    $('#set-cc-switch').hidden = !s.found || !s.loggedIn;
    if (!s.found) st.textContent = '✗ Claude Code not found. Install the Claude desktop app and open its Code tab once.';
    else if (s.loggedIn) st.textContent = '✓ Signed in as ' + (s.email || '?') + ' · ' + (s.org || 'personal') + (s.plan ? ' (' + s.plan + ' plan)' : '');
    else st.textContent = 'Not signed in. Click Sign in, finish in your browser, then click Check Again.';
  }

  // Word Timing: which engine times the words (CK.media.wordTimes). Changes apply at the next Analyze.
  const ENGINE_HINT = {
    align: 'Whisper writes the words, then a speech model (wav2vec2, free for any use) lines each one up with the audio. About a minute more per hour of footage.',
    crisper: 'CrisperWhisper writes every um, stutter and false start itself, with the most precise word times. Slower (several minutes per hour of footage, once). Its licence allows non-commercial use only: personal projects, not paid or monetised work.',
    whisper: 'Word edges are guessed from Whisper\'s timing and the loudness. Fastest, least precise.'
  };
  function engineUI() {
    const sel = $('#set-engine'), have = CK.media && CK.fs ? CK.media.engines() : { align: false, crisper: false };
    sel.value = CK.settings.wordEngine || 'align';
    [...sel.options].forEach(o => { if (o.value !== 'whisper') o.disabled = !have[o.value]; });
    const v = sel.value, missing = v !== 'whisper' && !have[v];
    $('#set-engine-hint').textContent = ENGINE_HINT[v] + (missing ? ' Not installed on this Mac, so Whisper only is used.' : '') + ' Applies the next time you Analyze.';
  }

  A.on('ready', () => {
    engineUI();
    $('#set-engine').onchange = e => { CK.settings.wordEngine = e.target.value; CK.save(); engineUI(); };
    $('#set-cc-login').onclick = () => { CK.claude.login(false); A.status('Finish the sign-in in Terminal and your browser, then click Check Again.'); };
    $('#set-cc-switch').onclick = () => { CK.claude.login(true); A.status('Finish the sign-in in Terminal and your browser, then click Check Again.'); };
    $('#set-cc-check').onclick = claudeStatus;
    A.on('view', v => { if (v === 'settings') claudeStatus(); });
    claudeStatus();
    $('#set-reload-panel').onclick = () => { A.status('Reloading CutKit…'); setTimeout(() => location.reload(), 50); };
    $('#set-reload-host').onclick = async () => {
      const r = await CK.loadHost();
      A.status(r.ok ? 'Premiere scripts reloaded.' : r.error, r.ok ? 'ok' : 'err');
    };
    $('#set-data-open').onclick = () => {
      try { CK.fs.mkdirSync(CK.dataDir, { recursive: true }); CK.cp.execFile('open', [CK.dataDir]); } catch (e) { A.status(e.message, 'err'); }
    };
    about();
  });
})();
