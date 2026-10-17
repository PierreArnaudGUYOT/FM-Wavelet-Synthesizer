# FM Wavelet Synthesizer — Release history

Created by **Pierre Arnaud GUYOT** ("OktoPierre").

## prototype 0.1 — 2026-10-15 (published on GitHub 2026-10-17: first public release)

- New synthesizer, a sister project of the Wavelet Synthesizer: **four-operator FM synthesis whose operators play
  wavelet atoms** (Haar, Daubechies 2/4/8/20, Symlet 8, Coiflet 3; Haar = square … Daubechies 20 = sine).
- 8 algorithms with a live diagram, operator 4 feedback, FM AMOUNT; per operator: wavelet, ratio (×0.5–×16) + fine,
  level, velocity, ADSR envelope.
- Anti-aliasing: band-limited operator waves chosen per note from the estimated FM bandwidth (Carson's rule, with
  harmonic h of a modulated operator modulated h times harder), fixed while a note plays. (The first draft changed the
  band limits with the envelopes, which made a noise behind many presets; fixed the same day, and `tests/quick.js` now
  checks that harmonic presets have no noise between their harmonics.)
- Live scope and scalogram (wavelet bands of the sound); operator displays (wave, ratio, role, envelope).
- 40 factory presets in 11 categories, levels matched; LFO (vibrato, tremolo, to FM), voice section, effects and
  triple chorus, MIDI (channel, Program Change, MIDI learn), demo player (preset tour on Beethoven and Bach).
- Web application only (no plugin yet). Fast test: `node tests/quick.js`.
