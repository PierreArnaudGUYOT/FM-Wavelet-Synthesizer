# FM Wavelet Synthesizer

*Created by **Pierre Arnaud GUYOT** ("OktoPierre") — version **prototype 0.1** (2026-10-15), see [RELEASE_HISTORY.md](RELEASE_HISTORY.md).
Architecture and maintenance notes: [CLAUDE.md](CLAUDE.md).*

A polyphonic **FM synthesizer** in the spirit of the Yamaha DX7 / DX100, with one twist: its operators do not play
sine waves but **wavelet atoms**. Each of the 4 operators plays one atom of its own wavelet per cycle — Haar gives a
square, Daubechies 2 and 4 asymmetric "digital" shapes, Daubechies 20 an almost pure sine — so the same algorithm can
sound like a classic DX7 or like hard, gritty digital FM, operator by operator.

It is the sister project of the [Wavelet Synthesizer](https://github.com/PierreArnaudGUYOT/Free-Wavelet-Synthesizer-VST)
(subtractive and additive wavelet synthesis), from which it takes its panel, MIDI, effects and demo player.
For now it is a **web application** (no plugin yet).

**Play online:** https://pierrearnaudguyot.github.io/FM-Wavelet-Synthesizer/ (Chrome or Edge; Web MIDI works with a hardware
keyboard). **Download** for offline use: the [Releases](https://github.com/PierreArnaudGUYOT/FM-Wavelet-Synthesizer/releases)
page (unzip, open `web/index.html`).

## Use it
Open `web/index.html` in Chrome or Edge (double-click; no server or install needed), then click **Click to start audio**.
- Play with the mouse, a MIDI keyboard (Web MIDI), or the computer keyboard (digits **1 … 0** = C D E F G A B C D E,
  letter rows = chromatic, **Z** / **X** = octave down / up).
- **Presets**: ◀ ▶ or click the name; 40 factory presets by category (Keys, Bass, Brass, Bells, Organ, Pad, Lead,
  Pluck, Strings & Winds, FX, Drums & Perc). **Save preset / Export / Import** are in the status bar.
- **▶ DEMO** plays Beethoven's *Appassionata* (III) as a tour of the presets (a new one about every 4 s, on a change of
  chord); **▾** chooses another piece or your own MIDI file.
- MIDI without a DAW: channel selector, Program Change selects a preset, MIDI learn (right-click a control, move a knob).

## The panel
| Section | What it does |
|---|---|
| **ALGORITHM** | The 8 algorithms of 4-operator FM (as on the DX100 / TX81Z), drawn as a diagram: carriers (heard) on the bottom row, modulators above what they modulate. **FEEDBACK** = operator 4 modulates itself (towards saw-like, then noise). **FM AMT** scales every modulation index (the brightness of the whole sound). |
| **OPERATOR 1…4** | **WAVELET** = the atom the operator plays; **RATIO** (×0.5 … ×16) + **FINE** (adds 0–99 %, e.g. ×2 + 38 % = ×2.76 for bells); **LEVEL** = loudness for a carrier, modulation index for a modulator (100 % = 8 radians); **VELOCITY**; envelope **ATTACK / DECAY / SUSTAIN / RELEASE**. The title says whether the operator is a carrier or which operator it modulates. |
| **SCOPE · SCALOGRAM** | One cycle of the sound (live, with the envelopes of the note playing) and its wavelet bands: the brighter the sound, the more the fine bands (B6…B11) light up. |
| **LFO** | Vibrato, tremolo and **TO FM** (the LFO moves FM AMT: wah-like or robotic movement). |
| **VOICE, EFFECTS, CHORUS** | As on the Wavelet Synthesizer: polyphony, mono / legato, polyphonic portamento, unison; drive, ping-pong delay, reverb; string-machine triple chorus. |

## How the engine works (short)
- An operator's wave is the **band-1 atom** of its wavelet: the inverse discrete wavelet transform of a single
  coefficient at the coarsest scale, over a cycle of 2048 samples — one atom that spans the whole cycle.
- **Phase modulation** like the DX7: each operator reads its wave at its own phase plus the outputs of its modulators
  (× their index). Operators are computed 4 → 1; carriers are summed.
- **No aliasing**: every operator wave exists in 11 band-limited copies. For every note the engine estimates the
  bandwidth of the modulation (Carson's rule), keeps modulators to at most 8 harmonics of their own, picks the copy
  that fits under the audio limit and, on very high notes, reduces the modulation indices.

## Development
```bash
node tools/gen_spec.js     # after editing tools/spec.js (parameters, panel layout, presets)
node tests/quick.js        # fast check: engine (all presets, algorithms, wavelets) + web app in muted headless Edge
```

## Licence
Copyright (C) 2026 Pierre Arnaud GUYOT ("OktoPierre"). Free software under the GNU General Public License v3 or later
(`LICENSE`), without any warranty. The demo music data (`tools/demo/*.mid`, `web/js/demo_data.js`) comes from the
Mutopia Project and keeps its own licences (public domain, except the *Moonlight* Sonata III: CC BY-SA 2.5, Stewart
Holmes) — see `tools/demo/SOURCE.md`.
