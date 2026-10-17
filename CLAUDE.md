# CLAUDE.md — FM Wavelet Synthesizer: architecture and maintenance guide

FM Wavelet Synthesizer is a four-operator FM synthesizer (DX7 / DX100 style) whose operators play **wavelet atoms**
instead of sines. Created by Pierre Arnaud GUYOT ("OktoPierre"), GPL-3.0-or-later. Web application only for now.
It was started from the **Wavelet Synthesizer** (`C:\Users\pierrearnaud.guyot\GIT\wavelet synthesizer`, a separate
project and repository — **never modify it from here**): panel framework, MIDI, effects, demo player and tests driver
were copied and adapted; the engine, parameters, layout and presets are new.

## 1. Files
| Path | Role |
|---|---|
| `tools/spec.js` | **Single source of truth**: app metadata, parameters, panel layout, factory presets, categories, preset levels (`LEVELS` block, generated). |
| `tools/gen_spec.js` | Generates `web/js/spec.js` (`WS_SPEC`). Run after any change to `tools/spec.js`. |
| `tools/wavelets.json` | Wavelet filter coefficients (same as the Wavelet Synthesizer). |
| `web/js/core.js` | DSP: operator waves and tables, FM engine, voices, LFO, effects; display helpers (`fmCycle`). Runs in the page, in the AudioWorklet (serialised with `toString()`) and in Node. |
| `web/js/worklet.js` | AudioWorkletProcessor: parameters, notes, sample-accurate demo sequencer, display messages (`lv` = operator levels). |
| `web/js/ui.js` | `SynthUI`: builds the panel from `WS_SPEC.SECTIONS`; widgets knob/seg/step/keyboard/wheels/meter/leds; canvases `algo` (algorithm diagram), `opwave` (operator), `scope`, `scalogram`. |
| `web/js/app.js` | Parameters, presets (factory, user, export/import), audio lifecycle, MIDI, computer keyboard, test hooks `WS_TEST`. |
| `web/js/demo.js`, `demo_data.js`, `midi.js` | Demo: every piece is a preset tour (factory order without drums and Init, 4 s, snapped to chords). |
| `tests/quick.js` | Fast check (engine + muted headless Edge). `tests/web/cdp.js` = Edge driver (always `--mute-audio`). |

## 2. Engine (`core.js`)
- **Operator wave** = band-1 atom of its wavelet: `idwt` of a single coefficient `c[1] = 1` over N = 2048 samples,
  mean removed, peak 1 (`opWave`). Haar = square; Daubechies 20 ≈ sine (harmonics 2–10 below 0.1 %).
- **Tables**: 11 band-limited copies per wavelet (`opTable`, mip m keeps harmonics ≤ 1024 >> m), all 7 built once when
  the engine starts.
- **Algorithms** (`ALGOS`): `mod[k]` = modulators of operator k, `car` = carriers; modulation always goes from a higher
  to a lower operator, so operators are computed 4 → 1 per sample. Feedback on operator 4 = average of its last two
  outputs × FEEDBACK × 1.6 rad. Carriers are summed × 1/√(number of carriers).
- **Levels**: LEVEL × envelope × velocity; carriers → amplitude, modulators → index LEVEL × 8 rad × FM AMOUNT
  (× LFO "to FM"). Values are computed per 32-sample block and interpolated per sample.
- **Anti-aliasing** (`control`, operators 4 → 1). Phase modulation of a wave that is not a sine modulates harmonic h
  h times harder: harmonic h of operator k spreads up to h·fk + Σ (h·I + 1)·B over its modulators j (index I, output
  bandwidth B, Carson's rule). Each operator reads the mip whose harmonics stay below the limit (carriers: `fmax`,
  aliases above 19 kHz; modulators: 0.45·sr and ≤ 8 harmonics) at the **strongest modulation of the note** (`Is`,
  `Bs`: LEVEL settings, full velocity, LFO peak) — so the mip is fixed while a note plays and never jumps. Haar
  operators thus lose upper harmonics when modulated; DB20 (a sine, `HEFF` = 1) is not affected. On high notes a
  modulator's index is reduced by a smooth function of (I + 1)·B / limit (no threshold). Lesson of prototype 0.1:
  limits that depended on the momentary envelope made the band limit and the indices jump → audible noise; keep
  every band-limit decision constant during a note. `tests/quick.js` checks the noise between harmonics (< −38 dB).
  A voice ends when all its carriers' envelopes are idle.
- Voices, portamento, unison, LFO, drive, chorus, delay, reverb, limiter: same code as the Wavelet Synthesizer.

## 3. Conventions
- Parameters are appended only (MIDI learn and presets use keys, but keep the order stable anyway).
- New preset: `preset(name, category, algorithm 1–8, [op1..op4], values)` in `tools/spec.js`, then run the loudness
  levelling `node tools/levels.js --write` (it measures the loudest 200 ms of a held chord — 50 ms and 3 dB lower for
  drums, single note and 4 dB lower for mono presets — target −14 dB; it stores them in the `LEVELS` block), then `gen_spec` and `quick`.
- Storage keys `fws.*` (own presets, state, MIDI channel, MIDI learn); `ws.audioOwner` is shared with the Wavelet
  Synthesizer on purpose: only one of the two plays at a time in the same browser.
- Headless Edge for tests must always run with `--mute-audio` and be closed; check that no headless Edge is left.
- Every source file starts with the copyright line and `SPDX-License-Identifier: GPL-3.0-or-later`.
- Git: repo-local identity `Pierre Arnaud GUYOT <343022474+PierreArnaudGUYOT@users.noreply.github.com>` (never the
  author's work identity); commit and push only when asked.
