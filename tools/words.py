"""CutKit word timing: exact start and end times for every word, so silence cuts never touch one.

Run by the panel with CutKit's own Python (~/Library/Application Support/CutKit/py):
  words.py align   <audio.wav> <whisper words.json> <out.json>   Whisper's words lined up on the audio (wav2vec2, Apache 2.0)
  words.py crisper <audio.wav> <out.json> [language]             CrisperWhisper 2.0 transcript + word times (non-commercial licence)

Writes {"v": 1, "engine": ..., "words": [{"w", "t0", "t1", "score"}]} (seconds from the start of the WAV; t0/t1 are null
for a word that couldn't be placed, e.g. "2014" has no letters to align). Prints "progress = N%" lines.
"""
import json, os, sys, time

ALIGN_MODEL = 'facebook/wav2vec2-large-960h-lv60-self'
SR = 16000


def progress(p):
    print('progress = %d%%' % max(0, min(100, round(p * 100))), flush=True)


def device():
    import torch
    return 'mps' if torch.backends.mps.is_available() else 'cpu'


def load_wav(path):
    import soundfile as sf
    x, sr = sf.read(path, dtype='float32')
    if x.ndim > 1:
        x = x.mean(1)
    if sr != SR:
        raise SystemExit('expected 16 kHz audio, got %d' % sr)
    return x


def write(out, engine, words):
    tmp = out + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'v': 1, 'engine': engine, 'words': words}, f)
    os.replace(tmp, out)


# ---------- align: Whisper's words, timed by a CTC speech model ----------

def ctc_path(lp, tokens, blank):
    """Viterbi forced alignment. lp: [T, V] log-probs, tokens: label ids. Returns the state per frame
    (state 2k+1 = token k, even states = blank) or None when the text can't fit in the frames."""
    import numpy as np
    T, L = lp.shape[0], len(tokens)
    S = 2 * L + 1
    if L == 0 or T < L:
        return None
    lab = np.full(S, blank)
    lab[1::2] = tokens
    # a token may skip the blank before it unless it repeats the token two states back
    skip = np.zeros(S, bool)
    skip[3::2] = lab[3::2] != lab[1:-2:2]
    NEG = -1e30
    a = np.full(S, NEG)
    a[0] = lp[0, blank]
    a[1] = lp[0, lab[1]]
    back = np.zeros((T, S), np.int8)
    for t in range(1, T):
        stay = a
        step = np.concatenate(([NEG], a[:-1]))
        jump = np.where(skip, np.concatenate(([NEG, NEG], a[:-2])), NEG)
        best = np.maximum(stay, np.maximum(step, jump))
        back[t] = np.where(best == stay, 0, np.where(best == step, 1, 2))
        a = best + lp[t, lab]
    s = S - 1 if a[S - 1] >= a[S - 2] else S - 2
    if a[s] <= NEG / 2:
        return None
    path = np.empty(T, np.int32)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(back[t, s])
    return path


def align(wav, words_json, out):
    import numpy as np, torch
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    x = load_wav(wav)
    W = json.load(open(words_json))['words']
    dev = device()
    proc = Wav2Vec2Processor.from_pretrained(ALIGN_MODEL)
    model = Wav2Vec2ForCTC.from_pretrained(ALIGN_MODEL).to(dev).eval()
    vocab = proc.tokenizer.get_vocab()
    blank, bar = vocab['<pad>'], vocab['|']
    progress(0.02)

    # letters the model knows ("don't" -> D O N ' T); words without any (numbers, symbols) get no time here
    def letters(w):
        return [vocab[c] for c in w.upper() if c in vocab and (c.isalpha() or c == "'")]
    toks = [letters(w['w']) for w in W]

    # loudness per 10 ms, to put window edges in the quietest spot between two words
    n = len(x) // 160
    env = 10 * np.log10((x[:n * 160].reshape(n, 160) ** 2).mean(1) + 1e-12)

    def quietest(t0, t1):
        i0, i1 = int(max(0, t0) * 100), int(min(n - 1, t1) * 100)
        return (i0 + int(np.argmin(env[i0:i1 + 1]))) / 100 if i1 > i0 else max(0.0, t0)

    # windows of about 20 s, split at a pause; Whisper's DTW time `at` lands ~0.2 s after a word starts
    at = [w['at'] for w in W]
    wins, a = [], 0
    for i in range(1, len(W) + 1):
        long_enough = i < len(W) and at[i] - at[a] > 20 and at[i] - at[i - 1] > 0.35
        too_long = i < len(W) and at[i] - at[a] > 30
        if i == len(W) or long_enough or too_long:
            wins.append((a, i - 1))
            a = i
    edges = [max(0.0, at[0] - 1.5)]
    for (a, b) in wins[1:]:
        edges.append(quietest(at[a - 1] + 0.1, at[a] - 0.25))
    edges.append(min(len(x) / SR, at[-1] + 2.0))

    res = [{'w': w['w'], 't0': None, 't1': None, 'score': None} for w in W]
    t_start = time.time()
    for k, (a, b) in enumerate(wins):
        s0, s1 = edges[k], edges[k + 1]
        seg = x[int(s0 * SR):int(s1 * SR)]
        ids, owner = [], []
        for i in range(a, b + 1):
            if not toks[i]:
                continue
            if ids:
                ids.append(bar); owner.append(-1)
            ids += toks[i]; owner += [i] * len(toks[i])
        if not ids or len(seg) < SR * 0.1:
            continue
        with torch.inference_mode():
            inp = proc(seg, sampling_rate=SR, return_tensors='pt').input_values.to(dev)
            lp = torch.log_softmax(model(inp).logits[0].float(), -1).cpu().numpy()
        frame = (len(seg) / SR) / lp.shape[0]            # ~20 ms
        path = ctc_path(lp, ids, blank)
        if path is None:
            continue
        for t, s in enumerate(path):
            if s % 2 == 0:
                continue
            j = (s - 1) // 2
            i = owner[j]
            if i < 0:
                continue
            res[i].setdefault('_f', []).append((s0 + t * frame, float(np.exp(lp[t, ids[j]]))))
        for i in range(a, b + 1):
            f = res[i].get('_f')
            if not f:
                continue
            # when the model isn't sure, a word's letters can spread over seconds of silence ("five" over 3 s):
            # split them where 0.25 s+ passes between two letters and keep the group the model is surest about
            groups, cur = [], [f[0]]
            for letter in f[1:]:
                if letter[0] - cur[-1][0] > 0.25:
                    groups.append(cur); cur = []
                cur.append(letter)
            groups.append(cur)
            g = max(groups, key=lambda c: (sum(p for _, p in c), len(c)))
            res[i]['t0'], res[i]['t1'] = g[0][0], g[-1][0] + frame
            res[i]['score'] = sum(p for _, p in f) / len(f)
        progress(0.05 + 0.95 * (k + 1) / len(wins))
    for r in res:
        r.pop('_f', None)
        if r['t0'] is not None:
            r['score'] = round(r['score'], 3)
            r['t0'], r['t1'] = round(r['t0'], 3), round(r['t1'], 3)
    write(out, 'align', res)
    print('aligned %d words in %.0f s on %s' % (sum(r['t0'] is not None for r in res), time.time() - t_start, dev), flush=True)


# ---------- crisper: CrisperWhisper 2.0 does the transcript and the word times ----------

def crisper(wav, out, lang='en'):
    from crisperwhisper import CrisperWhisperModel
    import threading
    x = load_wav(wav)
    dur = len(x) / SR
    t_start = time.time()
    model = CrisperWhisperModel('large', backend='transformers', device=device())
    progress(0.03)
    # no progress callback in the library: estimate from elapsed time (refined after the first run on this Mac)
    done = threading.Event()
    rate = float(os.environ.get('CK_CRISPER_RTF', '0.35'))

    def tick():
        t0 = time.time()
        while not done.wait(2):
            progress(min(0.97, 0.03 + (time.time() - t0) / (dur * rate)))
    threading.Thread(target=tick, daemon=True).start()
    r = model.transcribe(x, sr=SR, language=lang, mode='verbatim', word_timestamps=True)
    done.set()
    res = []
    for w in r.words:
        txt = str(w.word).strip()
        if not txt:
            continue
        res.append({'w': txt, 't0': round(float(w.start), 3), 't1': round(float(w.end), 3),
                    'score': round(float(w.probability), 3) if getattr(w, 'probability', None) is not None else None})
    write(out, 'crisper', res)
    print('transcribed %.0f s of audio in %.0f s' % (dur, time.time() - t_start), flush=True)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'align' and len(sys.argv) == 5:
        align(*sys.argv[2:5])
    elif cmd == 'crisper' and len(sys.argv) in (4, 5):
        crisper(*sys.argv[2:])
    elif cmd == 'check':
        import torch, transformers
        print(json.dumps({'torch': torch.__version__, 'device': device(), 'transformers': transformers.__version__}))
    else:
        raise SystemExit(__doc__)
