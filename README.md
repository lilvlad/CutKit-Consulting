# CutKit (Premiere Pro panel)

A separate panel for **Premiere Pro 2025+** that cuts talking-head footage: silences, filler words, retakes and false starts.

## Install (macOS)

**You need:** Premiere Pro 2025 or newer, [Homebrew](https://brew.sh) (the installer uses it for ffmpeg and Whisper), and about 2 GB of free space (the speech model is 1.6 GB). For retake detection you also need to be signed in to Claude (the Claude desktop app); silence and filler cuts work without it.

**1. Download CutKit** (pick one):

- Terminal:
  ```bash
  git clone https://github.com/lilvlad/CutKit-Consulting.git ~/CutKit
  ```
- or click **Code > Download ZIP** on GitHub, unzip it, and move the folder somewhere permanent (e.g. Documents).

**2. Run the installer:**

```bash
bash ~/CutKit/"Install CutKit on Mac.command"
```

(If you downloaded the ZIP, right-click `Install CutKit on Mac.command` > **Open** instead, or run `bash` followed by the file's path.)

**3. Restart Premiere Pro**, then open **Window > Extensions > CutKit by Vlad**.

The installer links Adobe's extensions folder to the CutKit folder instead of copying it, so **don't move or delete the folder** afterwards. The first run downloads the Whisper model (1.6 GB, once).

**Update:** `cd ~/CutKit && git pull`, then reopen the panel.


1. Open the sequence, pick the **Voice Track** (the audio track with the voice) and press **Analyze**. The audio is pulled out
   with ffmpeg and transcribed with Whisper on this Mac (about 5 s per minute of footage the first time, instant after that).
   **Nested sequences** work: if the voice track holds nests (e.g. one per camera), an **Inside "…"** picker chooses the audio
   track inside them, and CutKit follows them down to the camera files. Files with several audio streams (one per mic)
   are analysed with all streams mixed, so nobody's talking counts as silence.
2. Then Claude reads the transcript in two passes (same Claude Code sign-in as EditKit's Claude tab):
   **Opus** reads the whole shoot as sentences and marks **earlier takes** (even minutes-long, reworded ones; it keeps the last
   complete take) and **between takes** talk (setup, countdowns, feedback, "one more"). Then **Sonnet** checks what's left for
   repeated lines, **false starts** and **stumbles**. A 15-minute shoot takes about 30 s and 2 requests; answers are cached.
3. Review. The transcript shows every planned cut struck through and colored by reason; pauses are the small pills.
   **Click** a struck word to keep it (or a normal word to cut it), **Shift+click** to cut a range, **Alt+click** to move Premiere's
   playhead there. Click a pause pill to keep or shorten it. The strip above is the waveform with all cuts: each detected pause shows
   faint, the part that's cut stronger, so the padding is visible. **Scroll** to zoom (words appear when zoomed in), **drag** to move,
   double-click for the whole sequence, click to move Premiere's playhead. **‹ ›** jump from cut to cut (the playhead lands 1.5 s
   before it, so you can play it in Premiere).
   After clicking anything in CutKit, Space / J K L / arrows go straight to Premiere's timeline (CutKit's buttons let go of the keyboard).
   **Silences** (fold the settings with ▾): **Loose / Natural / Tight / Very Tight** set everything in one click. *Below* is the
   level that counts as quiet (**Auto** picks it; the chart under it shows how often each loudness occurs, usually a "silence"
   hump and a "voice" hump: drag the blue line between them). *Longer Than* is the shortest pause that's cut. *Keep After Words*
   and *Keep Before Words* (ms) are the padding left on each side of every cut: the tail of the last word, and the lead-in to the next.
   Silence cuts **never touch a word**: every word gets an exact start and end (see *Word Timing* in Settings), the soft
   ends of words (a trailing "s", "t", a quiet last word) are kept, the quiet level is judged per part of the shoot (Auto),
   and at least 40 ms stays after a word and 50 ms before one. If a cut would still reach a word it is trimmed around it
   ("N words protected" in the summary; hover for which). Words in grey italics are ones Whisper wrote into silence (nobody
   spoke there); they don't stop a cut.
   **Only Between In/Out** cuts only between the sequence's In and Out points (I / O in Premiere), to try settings on a few minutes.
   **Swear Words** (fuck, shit, bitch, asshole, damn, motherfucker…, starred spellings like f***, and common Russian/Ukrainian ones)
   get a red wavy underline. **Add Red Markers** puts a red sequence marker named "Swear: <word>" on each one (they aren't cut;
   pressing it again doesn't add duplicates).
4. **Cut Sequence** cuts in place: every track is razored at the same points and closed up, so cameras and audio stay in sync.
   With **Keep a Backup** on, the sequence is first copied into a **CutKit Backups** bin as "<name> (Before CutKit)".
   Premiere has no single undo for scripted edits, so the backup is the easy way back. Sequence markers move with the footage
   (a marker inside a removed part lands on the cut). The cut uses Premiere's own Extract per range (about 0.1 s per cut,
   so ~1–2 min for a 2-hour sequence); during it every track with clips is targeted, sync-locked and unlocked, then put back.
   **Audio Crossfades** puts Premiere's default audio transition (read from its preferences, e.g. Constant Power, 4 frames) on every
   audio cut. **Undo Last Cut** (needs Keep a Backup) puts the backup back in the sequence's place (same name and bin); the cut version
   is renamed "(Cut, Undone)" and moved to CutKit Backups, nothing is deleted. If the sequence is nested elsewhere, that nest keeps the cut one.
5. **Keep refining.** After a cut the review stays open on the shorter sequence: what was removed shows faded (it can't be
   clicked; bring footage back from the backup), everything else works as before. Cut a missed "and and and", change the
   silence settings or add markers, then **Cut Sequence** again; only the new cuts are applied. Each round makes its own
   numbered backup ("(Before CutKit 2)"…). If the sequence was edited by hand in between, CutKit asks you to Analyze Again,
   which is quick on a cut sequence: pieces of the same camera file reuse its transcript.

**Tabs** (next to Cut):
- **Takes**: every part that was recorded more than once (from Claude), with all its takes. Click a take to put Premiere's playhead on it,
  **Keep** to choose which one stays; the others are cut with Cut Sequence. Claude picks the last complete take; talk between takes is cut too.
- **Swears**: every swear word in context, each with a tick box. **Red Markers**, **Mute** (the audio under the word is split out and
  switched off on every audio track: Shift+E on the piece brings it back) or **Bleep** (muted plus a beep on the first empty audio track).
  *Your Words*: extra words to catch (`crap*` = any ending) and words never to flag.

**New Adjustment Layer** (the layers button in the sidebar): with clips selected, it covers exactly their span; with nothing
selected, it runs 7 s from the playhead (change the length in Settings). It goes on the first free video track above the footage
(adding one if needed) and ends up selected, ready for effects. **Shift-click** adds it with a **Transform** effect already on it. Premiere's scripting can't make the very first adjustment layer, so
the first time make one yourself (File › New › Adjustment Layer) and click again: CutKit saves a copy (`Adjustment Layer.prproj` in its
data folder) and brings it into every project after that, in a **CutKit** bin.

**Settings** (the gear at the bottom of the sidebar): **Word Timing** picks how word edges are found: *Whisper + Word Aligner*
(recommended, free for any use), *CrisperWhisper* (most precise and writes every um and stutter; slower; its licence is for
non-commercial projects only) or *Whisper only* (fastest). Applies at the next Analyze; each result is cached.
 **Reload Panel** loads CutKit's latest files without restarting Premiere
(your settings stay; the current analysis is cleared), **Reload Premiere Scripts** reloads only the Premiere side, and **Show in Finder**
opens CutKit's data folder.

**Filler Words** (Cut tab): **Words…** adds your own fillers or phrases (*like, you know, I mean*); **Markers** puts a yellow marker on each instead of cutting.

Sped-up clips on the voice track are skipped for analysis (they're still cut). Cache: `~/Library/Application Support/CutKit/cache`
(delete it any time). Debugging: http://localhost:8098 while the panel is open, or `node tools/cdp.js --cutkit "<js>"`.

## Layout
```
index.html, css/, js/   the panel
host/ck_main.jsx        the Premiere side (cuts, markers, placing clips)
CSXS/manifest.xml       tells Premiere about the panel
tools/cdp.js            runs JS in the open panel (debugging)
```
Installed as a link: `~/Library/Application Support/Adobe/CEP/extensions/CutKit` points here, so edits show up after reopening the panel.
