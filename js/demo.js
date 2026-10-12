// CutKit preview mode: a made-up talking-head take with pauses, fillers and retakes, so the panel can be
// tried in a browser without Premiere. Never used inside Premiere.
(function () {
  const CK = window.CK;
  const demo = CK.demo = {};
  // "|" = a long pause
  const SCRIPT = 'Hi, I\'m Vlad. | Today we are going to, um, | today we\'re going to look at how I cut interviews. | ' +
    'So the main thing is, uh, the main thing is timing. | Timing is, is everything. | ' +
    'If you leave every pause in, the, the, | if you leave every pause in, it drags. | Um, | so let me show you, it\'s a damn good trick.';

  demo.analysis = function () {
    const words = [];
    let t = 0.6;
    for (const tok of SCRIPT.split(' ')) {
      if (tok === '|') { t += 1.1 + (words.length % 3) * 0.35; continue; }
      const d = 0.16 + tok.replace(/[^a-z]/gi, '').length * 0.045;
      words.push({ w: tok, t0: t, t1: t + d, seg: 0 });
      t += d + 0.06;
    }
    const end = t + 0.8, STEP = 0.01;
    const env = new Float32Array(Math.ceil(end / STEP) + 2);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < env.length; i++) env[i] = -58 + rnd() * 5;
    for (const w of words) {
      for (let k = Math.floor(w.t0 / STEP); k < Math.ceil(w.t1 / STEP); k++) {
        const p = (k * STEP - w.t0) / (w.t1 - w.t0);
        env[k] = -30 + Math.sin(p * Math.PI) * 14 + rnd() * 4;
      }
    }
    return { id: 'demo', name: 'Interview_A', demo: true, end, frame: 1 / 25, env, segs: [{ start: 0, end, name: 'Interview_A.mov', w0: 0 }], words };
  };

  // What Claude would say about the script above.
  demo.takes = function () {
    const W = demo.analysis().words.map(w => w.w.toLowerCase().replace(/[^a-z']/g, ''));
    const find = (seq, from) => { for (let i = from || 0; i < W.length; i++) if (seq.every((s, k) => W[i + k] === s)) return i; return -1; };
    const a1 = find(['today', 'we', 'are']), a2 = find(['today', "we're"]);
    const b1 = find(['so', 'the', 'main']), b2 = find(['the', 'main'], b1 + 2);
    const c1 = find(['is', 'is']);
    const d1 = find(['if', 'you', 'leave']), d2 = find(['if', 'you', 'leave'], d1 + 1);
    const endOf = i => { while (i < W.length - 1 && !/[.]$/.test(demo.analysis().words[i].w)) i++; return i; };
    return new Promise(r => setTimeout(() => r({
      parts: [
        { name: 'Intro line', takes: [{ a: a1, b: a2 - 1 }, { a: a2, b: endOf(a2) }], keep: 1 },
        { name: 'Pauses make it drag', takes: [{ a: d1, b: d2 - 1 }, { a: d2, b: endOf(d2) }], keep: 1 }
      ],
      cuts: [
        { kind: 'false_start', a: b1 + 1, b: b2 - 1, why: 'restarted the sentence' },
        { kind: 'stumble', a: c1, b: c1, why: 'doubled "is"' }
      ]
    }), 1200));
  };
})();
