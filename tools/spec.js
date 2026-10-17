// Copyright (C) 2026 Pierre Arnaud GUYOT (OktoPierre)
// SPDX-License-Identifier: GPL-3.0-or-later
// FM Wavelet Synthesizer — single source of truth.
// Created by Pierre Arnaud GUYOT ("OktoPierre"). Release history: see RELEASE_HISTORY.md
//   prototype 0.1 (2026-10-15) — first version: web app, 4 wavelet operators, 8 algorithms.
// Parameters, panel layout and factory presets are defined here once and generated into web/js/spec.js by gen_spec.js.
// Parameter order defines the parameter numbers (MIDI learn and saved presets use the keys): append only.
'use strict';

const DEVICE = { w: 1100, h: 790 };
const APP = {
  name: 'FM Wavelet Synthesizer',
  author: 'Pierre Arnaud GUYOT',
  credit: 'created by OktoPierre',   // shown on the panel
  copyright: 'Copyright (C) 2026 Pierre Arnaud GUYOT (OktoPierre)',
  license: 'GPL v3',                 // the licence is GPL-3.0-or-later (file LICENSE)
  version: 'prototype 0.1',
  versionNum: '0.1.0',
  date: '2026-10-15',
};
const DEFAULT_PRESET = 'E-Piano 1';   // sound loaded when the app opens

// The idea: FM synthesis in the style of the Yamaha DX7 / DX100, but every operator plays ONE WAVELET ATOM PER
// CYCLE (the band-1 atom of its wavelet, which spans the whole cycle) instead of a sine. Daubechies 20 is close to a
// sine (classic FM), Haar is a square (hard, digital FM), the others are in between, each with its own harmonics.
const WAVELETS = ['Haar', 'Daubechies 2', 'Daubechies 4', 'Daubechies 8', 'Symlet 8', 'Coiflet 3', 'Daubechies 20'];
const WAVELETS_SHORT = ['HAAR', 'DB2', 'DB4', 'DB8', 'SYM8', 'COIF3', 'DB20'];
// Frequency ratio of an operator (coarse) — FINE adds 0..99 % like a DX7 (ratio 2 + 38 % = 2.76: bells)
const RATIOS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
// The 8 algorithms of 4-operator FM (as on the DX100 / TX81Z). Operator 1 is always a carrier; arrows = "modulates".
const ALGORITHMS = ['1 · 4→3→2→1', '2 · (3+4)→2→1', '3 · 3→2→1 + 4→1', '4 · 2→1 + 4→3→1', '5 · 2→1 + 4→3',
  '6 · 4→1, 2, 3', '7 · 4→3 + 1 + 2', '8 · 1 + 2 + 3 + 4'];

// curve: lin | exp | pow2 | int | choice
// fmt:   pct | db | sec | hz | cents | int | choice | bipct
const P = [];
function add(key, name, short, o) { P.push(Object.assign({ key, name, short, curve: 'lin', fmt: 'pct', hidden: false, structural: false }, o)); }

add('algo', 'Algorithm', 'ALGORITHM', { curve: 'choice', fmt: 'choice', min: 0, max: 7, def: 0, choices: ALGORITHMS, choiceShort: ALGORITHMS });
add('feedback', 'Feedback (Op 4)', 'FEEDBACK', { min: 0, max: 1, def: 0 });
add('fm_amount', 'FM Amount', 'FM AMT', { min: 0, max: 2, def: 1 });   // scales every modulation index
for (let k = 1; k <= 4; k++) {
  const o = 'op' + k + '_', N = 'Op ' + k + ' ';
  add(o + 'wave', N + 'Wavelet', 'WAVELET', { curve: 'choice', fmt: 'choice', min: 0, max: 6, def: 6, choices: WAVELETS, choiceShort: WAVELETS_SHORT });
  add(o + 'ratio', N + 'Ratio', 'RATIO', { curve: 'choice', fmt: 'choice', min: 0, max: RATIOS.length - 1, def: 1, values: RATIOS,
    choices: RATIOS.map(r => '×' + r), choiceShort: RATIOS.map(r => '×' + r) });
  add(o + 'fine', N + 'Fine Ratio', 'FINE', { min: 0, max: 0.99, def: 0 });
  add(o + 'level', N + 'Level', 'LEVEL', { min: 0, max: 1, def: k === 1 ? 0.8 : 0 });
  add(o + 'vel', N + 'Velocity', 'VELOCITY', { min: 0, max: 1, def: 0.5 });
  add(o + 'a', N + 'Attack', 'ATTACK', { curve: 'exp', fmt: 'sec', min: 0.001, max: 10, def: 0.002 });
  add(o + 'd', N + 'Decay', 'DECAY', { curve: 'exp', fmt: 'sec', min: 0.005, max: 20, def: 1 });
  add(o + 's', N + 'Sustain', 'SUSTAIN', { min: 0, max: 1, def: 0.7 });
  add(o + 'r', N + 'Release', 'RELEASE', { curve: 'exp', fmt: 'sec', min: 0.005, max: 10, def: 0.3 });
}
add('lfo_shape', 'LFO Shape', 'SHAPE', { curve: 'choice', fmt: 'choice', min: 0, max: 4, def: 0,
  choices: ['Sine', 'Triangle', 'Saw', 'Square', 'Sample & Hold'], choiceShort: ['SINE', 'TRI', 'SAW', 'SQR', 'S&H'] });
add('lfo_rate', 'LFO Rate', 'RATE', { curve: 'exp', fmt: 'hz', min: 0.05, max: 20, def: 5 });
add('lfo_pitch', 'LFO to Pitch', 'VIBRATO', { fmt: 'cents', min: 0, max: 100, def: 0 });
add('lfo_amp', 'LFO to Level', 'TREMOLO', { min: 0, max: 1, def: 0 });
add('lfo_fm', 'LFO to FM Amount', 'TO FM', { min: 0, max: 1, def: 0 });
add('v_porta', 'Portamento', 'PORTA', { curve: 'choice', fmt: 'choice', min: 0, max: 2, def: 1,
  choices: ['Off', 'Poly', 'Legato only'], choiceShort: ['OFF', 'POLY', 'LEGATO'] });
add('v_oct', 'Octave', 'OCTAVE', { curve: 'int', fmt: 'int', min: -3, max: 3, def: 0 });
add('v_fine', 'Fine Tune', 'FINE', { fmt: 'cents', min: -100, max: 100, def: 0 });
add('v_voices', 'Voices', 'VOICES', { curve: 'int', fmt: 'int', min: 1, max: 16, def: 12 });
add('v_glide', 'Glide', 'GLIDE', { curve: 'pow2', fmt: 'sec', min: 0, max: 2, def: 0 });
add('v_unison', 'Unison', 'UNISON', { curve: 'int', fmt: 'int', min: 1, max: 4, def: 1 });
add('v_detune', 'Unison Detune', 'DETUNE', { fmt: 'cents', min: 0, max: 50, def: 10 });
add('v_width', 'Stereo Width', 'STEREO', { min: 0, max: 1, def: 0.7 });
add('fx_drive', 'Drive', 'DRIVE', { min: 0, max: 1, def: 0 });
add('fx_dtime', 'Delay Time', 'TIME', { curve: 'exp', fmt: 'sec', min: 0.01, max: 1, def: 0.35 });
add('fx_dfb', 'Delay Feedback', 'FEEDBACK', { min: 0, max: 0.9, def: 0.35 });
add('fx_dmix', 'Delay Mix', 'DLY MIX', { min: 0, max: 1, def: 0 });
add('fx_rsize', 'Reverb Size', 'SIZE', { min: 0, max: 1, def: 0.6 });
add('fx_rmix', 'Reverb Mix', 'REV MIX', { min: 0, max: 1, def: 0 });
add('ch_mix', 'Chorus', 'CHORUS', { min: 0, max: 1, def: 0 });
add('ch_rate', 'Chorus Rate', 'RATE', { curve: 'exp', fmt: 'hz', min: 0.1, max: 3, def: 0.7 });
add('ch_depth', 'Chorus Depth', 'DEPTH', { min: 0, max: 1, def: 0.6 });
add('master', 'Master Volume', 'VOLUME', { fmt: 'db', min: -36, max: 6, def: -3 });
add('bend', 'Pitch Bend', 'BEND', { fmt: 'bipct', min: -1, max: 1, def: 0, hidden: true });
add('modwheel', 'Mod Wheel', 'MOD', { min: 0, max: 1, def: 0, hidden: true });
add('hold', 'Sustain Pedal', 'HOLD', { min: 0, max: 1, def: 0, hidden: true });

const idx = Object.fromEntries(P.map((p, i) => [p.key, i]));

// ---------------------------------------------------------------- layout (panel 1100 x 790)
// Sections are cards; widget coordinates are relative to their section.
// widget types: knobM knobS knobT seg step algo opwave scope scalogram leds fxheads keyboard wheels logo presets meter credit
const S = [];
function section(id, title, x, y, w, h, widgets) { S.push({ id, title, x, y, w, h, mode: '', widgets }); }
const kn = (key, x, y, t) => ({ type: t || 'knobM', param: key, x, y, w: 52, h: 60 });
const row = (keys, x0, y, dx) => keys.map((k, i) => kn(k, x0 + i * (dx || 52), y));

section('header', '', 0, 0, 1100, 48, [
  { type: 'logo', x: 16, y: 8, w: 270, h: 32 },
  { type: 'presets', x: 566, y: 9, w: 300, h: 30 },
  { type: 'knobS', param: 'master', x: 1028, y: 6, w: 36, h: 36 },
  { type: 'meter', x: 1072, y: 9, w: 14, h: 30 },
]);
section('algo', 'ALGORITHM · 4 WAVELET OPERATORS', 12, 56, 330, 228, [
  { type: 'algo', x: 12, y: 30, w: 306, h: 130 },
  { type: 'step', param: 'algo', x: 12, y: 170, w: 186, h: 30 },
  kn('feedback', 206, 162), kn('fm_amount', 264, 162),
]);
section('display', 'SCOPE · SCALOGRAM', 350, 56, 738, 228, [
  { type: 'scope', x: 12, y: 30, w: 714, h: 90 },
  { type: 'scalogram', x: 12, y: 126, w: 714, h: 92 },
]);
for (let k = 1; k <= 4; k++) {
  const o = 'op' + k + '_';
  section('op' + k, 'OPERATOR ' + k, 12 + (k - 1) * 271, 292, 263, 248, [
    { type: 'opwave', op: k, x: 12, y: 30, w: 239, h: 50 },
    { type: 'step', param: o + 'wave', x: 12, y: 86, w: 239, h: 26 },
    ...row([o + 'ratio', o + 'fine', o + 'level', o + 'vel'], 12, 118, 60),
    ...row([o + 'a', o + 'd', o + 's', o + 'r'], 12, 182, 60),
  ]);
}
section('lfo', 'LFO', 12, 548, 284, 136, [
  { type: 'seg', param: 'lfo_shape', x: 12, y: 30, w: 260, h: 24 },
  ...row(['lfo_rate', 'lfo_pitch', 'lfo_amp', 'lfo_fm'], 12, 64),
]);
section('voice', 'VOICE', 304, 548, 388, 136, [
  { type: 'seg', param: 'v_porta', x: 12, y: 30, w: 156, h: 22 },
  { type: 'leds', x: 176, y: 32, w: 200, h: 18 },
  ...row(['v_oct', 'v_fine', 'v_voices', 'v_glide', 'v_unison', 'v_detune', 'v_width'], 12, 64),
]);
section('fx', 'EFFECTS', 700, 548, 388, 136, [
  { type: 'fxheads', x: 12, y: 32, w: 364, h: 18 },
  ...row(['fx_drive', 'fx_dtime', 'fx_dfb', 'fx_dmix', 'fx_rsize', 'fx_rmix'], 38, 64),
]);
section('keys', '', 0, 692, 1100, 98, [
  { type: 'wheels', x: 12, y: 0, w: 60, h: 84 },
  { type: 'keyboard', x: 216, y: 0, w: 872, h: 84 },
  { type: 'credit', x: 588, y: 86, w: 500, h: 12 },
]);
// knobT = tiny knob with label (cell 40 x 56)
section('chorus', 'CHORUS', 80, 692, 128, 84, [
  { type: 'knobT', param: 'ch_mix', x: 4, y: 22, w: 40, h: 58 },
  { type: 'knobT', param: 'ch_rate', x: 44, y: 22, w: 40, h: 58 },
  { type: 'knobT', param: 'ch_depth', x: 84, y: 22, w: 40, h: 58 },
]);

// ---------------------------------------------------------------- presets
// op(ratio, level, options): w wavelet (0 Haar … 6 DB20), f fine, a d s r envelope, v velocity
const W = { haar: 0, db2: 1, db4: 2, db8: 3, sym8: 4, coif3: 5, db20: 6 };
function op(ratio, level, o) {
  const ri = RATIOS.indexOf(ratio);
  if (ri < 0) throw new Error('ratio not in the list: ' + ratio);
  o = o || {};
  return { ratio: ri, level, wave: o.w === undefined ? W.db20 : o.w, fine: o.f || 0, a: o.a, d: o.d, s: o.s, r: o.r, vel: o.v };
}
// preset(name, category, algorithm 1..8, [op1, op2, op3, op4], other values)
const PRESET_LIST = [];
function preset(name, cat, algo, ops, v) {
  const out = Object.assign({ algo: algo - 1 }, v || {});
  ops.forEach((x, i) => {
    const o = 'op' + (i + 1) + '_';
    if (!x) { out[o + 'level'] = 0; return; }
    for (const k of ['wave', 'ratio', 'fine', 'level', 'a', 'd', 's', 'r', 'vel']) if (x[k] !== undefined) out[o + k] = x[k];
  });
  PRESET_LIST.push({ name, cat, v: out });
}

// Keys
preset('E-Piano 1', 'Keys', 5, [op(1, 0.9, { d: 3, s: 0.15, r: 0.6, v: 0.6 }), op(1, 0.35, { d: 1.6, s: 0.1, v: 0.8 }),
  op(1, 0.5, { d: 1.2, s: 0, r: 0.5, v: 0.7 }), op(14, 0.25, { d: 0.25, s: 0, v: 0.9 })],
{ ch_mix: 0.35, ch_rate: 0.8, fx_rmix: 0.15 });
preset('E-Piano Bright', 'Keys', 5, [op(1, 0.9, { d: 2.5, s: 0.2, r: 0.5, v: 0.6 }), op(1, 0.55, { w: W.db8, d: 1.2, s: 0.15, v: 0.9 }),
  op(1, 0.5, { d: 1, s: 0, r: 0.4 }), op(14, 0.35, { d: 0.2, s: 0, v: 0.9 })],
{ ch_mix: 0.25, fx_rmix: 0.12 });
preset('FM Clav', 'Keys', 1, [op(1, 0.9, { d: 0.7, s: 0.15, r: 0.08, v: 0.8 }), op(3, 0.45, { d: 0.4, s: 0.2, v: 0.8 }),
  op(1, 0.3, { d: 0.2, s: 0 }), op(7, 0.15, { d: 0.05, s: 0 })], { fx_drive: 0.15 });
preset('Haar Toy Piano', 'Keys', 2, [op(1, 0.9, { w: W.haar, d: 1.2, s: 0, r: 0.4 }), op(4, 0.25, { d: 0.5, s: 0 }),
  op(7, 0.12, { d: 0.1, s: 0 }), null], { v_oct: 1, fx_rmix: 0.2 });
preset('Wavelet Vibes', 'Keys', 5, [op(1, 0.9, { d: 3.5, s: 0, r: 1.2 }), op(4, 0.12, { d: 0.8, s: 0 }),
  op(4, 0.4, { d: 2.5, s: 0, r: 1 }), op(10, 0.15, { d: 0.3, s: 0 })], { lfo_amp: 0.3, lfo_rate: 5.5, fx_rmix: 0.3 });
// Bass
preset('FM Bass', 'Bass', 1, [op(1, 0.9, { d: 1.2, s: 0.5, r: 0.1 }), op(1, 0.5, { d: 0.4, s: 0.25, v: 0.7 }),
  op(1, 0.3, { d: 0.25, s: 0.1 }), op(1, 0.2, { d: 0.3, s: 0.2 })], { feedback: 0.5, v_oct: -1 });
preset('Slap Bass', 'Bass', 3, [op(1, 0.9, { d: 0.9, s: 0.4, r: 0.08, v: 0.7 }), op(1, 0.45, { d: 0.3, s: 0.2, v: 0.8 }),
  op(2, 0.2, { d: 0.2, s: 0 }), op(7, 0.3, { d: 0.08, s: 0, v: 0.9 })], { v_oct: -1 });
preset('Wavelet Sub Bass', 'Bass', 1, [op(1, 0.9, { d: 2, s: 0.9, r: 0.12 }), op(1, 0.15, { d: 0.3, s: 0.1 }), null, null],
  { v_oct: -1, v_voices: 1, v_porta: 2, v_glide: 0.05 });
preset('Haar Bass', 'Bass', 1, [op(1, 0.85, { w: W.haar, d: 0.8, s: 0.6, r: 0.08 }), op(2, 0.2, { w: W.haar, d: 0.3, s: 0.1 }),
  null, null], { v_oct: -1, fx_drive: 0.2 });
preset('Rubber FM Bass', 'Bass', 2, [op(1, 0.9, { d: 0.6, s: 0.6, r: 0.08 }), op(0.5, 0.4, { d: 0.25, s: 0.2, v: 0.7 }),
  op(1, 0.2, { d: 0.15, s: 0 }), op(2, 0.1, { d: 0.1, s: 0 })], { v_oct: -1, v_voices: 1, v_porta: 2, v_glide: 0.07 });
// Brass
preset('FM Brass', 'Brass', 1, [op(1, 0.9, { a: 0.05, d: 1, s: 0.9, r: 0.2 }), op(1, 0.5, { a: 0.08, d: 0.5, s: 0.7, v: 0.6 }),
  op(1, 0.15, { a: 0.1, d: 0.5, s: 0.5 }), op(1, 0.1, { d: 1, s: 0.8 })], { feedback: 0.3, v_unison: 2, v_detune: 8, ch_mix: 0.2, fx_rmix: 0.2 });
preset('Brass Stab', 'Brass', 1, [op(1, 0.9, { a: 0.01, d: 0.35, s: 0.2, r: 0.15 }), op(1, 0.6, { a: 0.02, d: 0.25, s: 0.2, v: 0.7 }),
  op(1, 0.2, { d: 0.2, s: 0.1 }), op(1, 0.1, {})], { feedback: 0.4, v_unison: 2, v_detune: 10, fx_rmix: 0.25 });
preset('Synth Horn', 'Brass', 2, [op(1, 0.9, { a: 0.08, d: 1, s: 0.85, r: 0.3 }), op(1, 0.35, { a: 0.15, d: 0.8, s: 0.6 }),
  op(3, 0.1, { a: 0.2, d: 1, s: 0.5 }), op(1, 0.1, { d: 1, s: 0.7 })], { lfo_pitch: 5, fx_rmix: 0.3 });
// Bells
preset('Tubular Bell', 'Bells', 5, [op(1, 0.8, { d: 6, s: 0, r: 4 }), op(3.5, 0.4, { d: 4, s: 0 }),
  op(2, 0.5, { d: 5, s: 0, r: 3 }), op(2, 0.35, { f: 0.38, d: 3, s: 0 })], { fx_rsize: 0.85, fx_rmix: 0.45 });
preset('Glass Bell', 'Bells', 1, [op(1, 0.85, { d: 4, s: 0, r: 2.5 }), op(1, 0.35, { f: 0.41, d: 3, s: 0 }), null, null],
  { fx_rsize: 0.8, fx_rmix: 0.4, ch_mix: 0.2 });
preset('Music Box', 'Bells', 5, [op(1, 0.85, { d: 2, s: 0, r: 1.2 }), op(7, 0.2, { d: 0.6, s: 0 }),
  op(2, 0.35, { d: 1.2, s: 0, r: 0.8 }), op(5, 0.15, { d: 0.4, s: 0 })], { v_oct: 1, fx_dtime: 0.28, fx_dfb: 0.3, fx_dmix: 0.2, fx_rmix: 0.25 });
preset('Wavelet Chimes', 'Bells', 2, [op(1, 0.85, { d: 3, s: 0, r: 2 }), op(4, 0.3, { w: W.haar, f: 0.2, d: 2, s: 0 }),
  op(3, 0.15, { d: 1, s: 0 }), null], { v_oct: 1, fx_rmix: 0.45 });
// Organ
preset('FM Organ', 'Organ', 8, [op(1, 0.8, { d: 1, s: 1, r: 0.06, v: 0 }), op(2, 0.5, { d: 1, s: 1, r: 0.06, v: 0 }),
  op(3, 0.35, { d: 1, s: 1, r: 0.06, v: 0 }), op(4, 0.25, { d: 1, s: 1, r: 0.06, v: 0 })], { ch_mix: 0.5, ch_rate: 1.2, fx_rmix: 0.15 });
preset('Rock Organ', 'Organ', 6, [op(1, 0.8, { s: 1, r: 0.06, v: 0 }), op(2, 0.6, { s: 1, r: 0.06, v: 0 }),
  op(0.5, 0.5, { s: 1, r: 0.06, v: 0 }), op(1, 0.15, { s: 1, v: 0 })], { feedback: 0.35, fx_drive: 0.35, ch_mix: 0.4, fx_rmix: 0.15 });
preset('Wavelet Pipe', 'Organ', 7, [op(1, 0.8, { a: 0.05, s: 1, r: 0.6, v: 0 }), op(2, 0.4, { w: W.sym8, a: 0.05, s: 1, r: 0.6, v: 0 }),
  op(4, 0.3, { w: W.haar, a: 0.05, s: 1, r: 0.6, v: 0 }), op(4, 0.1, { s: 1, v: 0 })], { fx_rsize: 0.95, fx_rmix: 0.5 });
// Pad
preset('FM Pad', 'Pad', 2, [op(1, 0.8, { a: 1, d: 2, s: 0.9, r: 2 }), op(1, 0.2, { a: 1.2, d: 3, s: 0.8 }),
  op(2, 0.1, { a: 1.5, d: 4, s: 1 }), op(0.5, 0.08, { a: 2, s: 1 })], { v_unison: 3, v_detune: 12, ch_mix: 0.5, fx_rmix: 0.5 });
preset('Glass Pad', 'Pad', 1, [op(1, 0.8, { a: 0.8, d: 2, s: 0.9, r: 2.5 }), op(3.5, 0.15, { a: 1.5, d: 3, s: 0.7 }),
  op(1, 0.05, { a: 2, s: 1 }), null], { v_unison: 2, v_detune: 8, lfo_fm: 0.3, lfo_rate: 0.3, ch_mix: 0.5, fx_rsize: 0.9, fx_rmix: 0.6 });
preset('Haar Choir', 'Pad', 2, [op(1, 0.8, { a: 0.6, d: 2, s: 0.9, r: 1.8 }), op(2, 0.08, { w: W.haar, a: 0.8, s: 1 }),
  op(3, 0.05, { w: W.haar, a: 1, s: 1 }), null], { v_unison: 3, v_detune: 15, lfo_pitch: 4, ch_mix: 0.6, fx_rmix: 0.6 });
// Lead
preset('FM Lead', 'Lead', 1, [op(1, 0.9, { d: 1, s: 0.8, r: 0.15 }), op(1, 0.45, { d: 0.6, s: 0.6 }),
  op(1, 0.2, { s: 0.8 }), op(1, 0.2, { s: 1 })], { feedback: 0.7, v_voices: 1, v_porta: 2, v_glide: 0.06, lfo_pitch: 6, lfo_rate: 5.5, fx_dmix: 0.2, fx_rmix: 0.15 });
preset('Wavelet Sync Lead', 'Lead', 1, [op(1, 0.9, { d: 1, s: 0.85, r: 0.15 }), op(2, 0.55, { w: W.db4, d: 0.8, s: 0.5 }),
  null, null], { v_voices: 1, v_porta: 2, v_glide: 0.05, lfo_fm: 0.5, lfo_rate: 0.5, fx_drive: 0.2, fx_dmix: 0.2 });
preset('Haar Chip Lead', 'Lead', 1, [op(1, 0.8, { w: W.haar, d: 0.3, s: 0.7, r: 0.1 }), op(4, 0.12, { w: W.haar, d: 0.2, s: 0.3 }),
  null, null], { v_voices: 1, lfo_pitch: 8, lfo_rate: 6, fx_dtime: 0.25, fx_dfb: 0.35, fx_dmix: 0.25 });
// Pluck
preset('FM Pluck', 'Pluck', 1, [op(1, 0.9, { d: 0.5, s: 0, r: 0.3 }), op(1, 0.5, { d: 0.15, s: 0, v: 0.8 }), null, null],
  { fx_dtime: 0.375, fx_dfb: 0.4, fx_dmix: 0.25, fx_rmix: 0.2 });
preset('FM Koto', 'Pluck', 1, [op(1, 0.9, { d: 1.2, s: 0, r: 0.4 }), op(3, 0.35, { d: 0.3, s: 0, v: 0.8 }), null, null],
  { lfo_pitch: 3, lfo_rate: 4, fx_rmix: 0.2 });
preset('FM Harp', 'Pluck', 1, [op(1, 0.9, { d: 2, s: 0, r: 1 }), op(2, 0.2, { d: 0.6, s: 0 }), null, null], { fx_rsize: 0.8, fx_rmix: 0.45 });
// Strings & Winds
preset('FM Strings', 'Strings & Winds', 2, [op(1, 0.85, { a: 0.3, d: 2, s: 0.9, r: 0.8 }), op(1, 0.25, { a: 0.4, d: 2, s: 0.8 }),
  op(2, 0.08, { a: 0.5, s: 1 }), op(1, 0.08, { s: 1 })], { feedback: 0.3, v_unison: 3, v_detune: 10, ch_mix: 0.6, fx_rmix: 0.35 });
preset('FM Flute', 'Strings & Winds', 3, [op(1, 0.85, { a: 0.08, d: 1, s: 0.9, r: 0.2 }), op(1, 0.1, { a: 0.1, s: 0.8 }),
  op(2, 0.05, { s: 1 }), op(1, 0.08, { a: 0.05, d: 0.3, s: 0.3 })], { feedback: 1, lfo_pitch: 5, lfo_rate: 5, fx_rmix: 0.25 });
preset('FM Clarinet', 'Strings & Winds', 1, [op(1, 0.85, { a: 0.05, d: 1, s: 0.9, r: 0.15 }), op(2, 0.35, { a: 0.05, d: 0.8, s: 0.7 }),
  null, null], { lfo_pitch: 4, lfo_rate: 5, fx_rmix: 0.2 });
// FX
preset('Laser FM', 'FX', 1, [op(1, 0.85, { d: 1, s: 0.5, r: 0.3 }), op(0.5, 0.9, { d: 0.2, s: 0 }), null, null],
  { lfo_fm: 0.6, lfo_rate: 7, lfo_shape: 2, fx_dtime: 0.2, fx_dfb: 0.6, fx_dmix: 0.35 });
preset('Metal Feedback', 'FX', 1, [op(1, 0.8, { d: 4, s: 0, r: 2.5 }), op(3.5, 0.3, { d: 2, s: 0.2 }),
  op(2, 0.4, { f: 0.41, d: 1.5, s: 0.3 }), op(1, 0.3, { s: 0.5 })], { feedback: 0.95, fx_rsize: 0.9, fx_rmix: 0.4 });
preset('Robot Speak', 'FX', 1, [op(1, 0.85, { s: 1, r: 0.2 }), op(1, 0.4, { s: 1 }), op(3, 0.2, { s: 1 }), null],
  { lfo_shape: 4, lfo_rate: 8, lfo_fm: 0.9, fx_drive: 0.3 });
// Drums & Perc (pitched: play them on different keys)
preset('FM Kick', 'Drums & Perc', 1, [op(1, 0.95, { d: 0.35, s: 0, r: 0.05 }), op(1, 0.6, { d: 0.04, s: 0, v: 0.6 }), null, null],
  { v_oct: -2 });
preset('FM Snare', 'Drums & Perc', 3, [op(1, 0.8, { d: 0.2, s: 0, r: 0.1 }), op(2, 0.3, { d: 0.1, s: 0 }),
  op(1, 0.2, { d: 0.08, s: 0 }), op(1, 0.8, { d: 0.18, s: 0 })], { feedback: 1, fx_rmix: 0.15 });
preset('Metal Hat', 'Drums & Perc', 1, [op(1, 0.8, { d: 0.12, s: 0, r: 0.05 }), op(3.5, 0.6, { f: 0.3, d: 0.1, s: 0 }),
  op(7, 0.6, { f: 0.4, d: 0.1, s: 0 }), op(1, 0.4, { s: 0 })], { feedback: 0.9, v_oct: 1 });
preset('Wood Block FM', 'Drums & Perc', 1, [op(1, 0.9, { d: 0.15, s: 0, r: 0.05 }), op(3.5, 0.3, { d: 0.05, s: 0 }), null, null],
  { v_oct: 1 });
// Init
preset('Init', 'Init', 1, [op(1, 0.8, {}), op(1, 0.3, {}), null, null], {});

// LEVELS (generated by the loudness check: master volume per preset, so the presets sound equally loud)
const LEVELS = {"E-Piano 1": 2.5, "E-Piano Bright": 2, "FM Clav": -0.5, "Haar Toy Piano": -5, "Wavelet Vibes": -0.5, "FM Bass": -1.5, "Slap Bass": -1.5, "Wavelet Sub Bass": -5, "Haar Bass": -7, "Rubber FM Bass": -3, "FM Brass": -2, "Brass Stab": 2, "Synth Horn": -4.5, "Tubular Bell": -3.5, "Glass Bell": -3, "Music Box": -1, "Wavelet Chimes": -5.5, "FM Organ": 1.5, "Rock Organ": -1, "Wavelet Pipe": -5.5, "FM Pad": -2, "Glass Pad": -4.5, "Haar Choir": -1.5, "FM Lead": -3, "Wavelet Sync Lead": -5.5, "Haar Chip Lead": -4.5, "FM Pluck": 2.5, "FM Koto": -2, "FM Harp": -4.5, "FM Strings": -0.5, "FM Flute": -4.5, "FM Clarinet": -5, "Laser FM": -4, "Metal Feedback": -4, "Robot Speak": -6.5, "FM Kick": -2, "FM Snare": -0.5, "Metal Hat": 1.5, "Wood Block FM": -2.5, "Init": -2.5};
for (const p of PRESET_LIST) if (LEVELS[p.name] !== undefined && p.v.master === undefined) p.v.master = LEVELS[p.name];
// END LEVELS

const CATEGORIES = ['Keys', 'Bass', 'Brass', 'Bells', 'Organ', 'Pad', 'Lead', 'Pluck', 'Strings & Winds', 'FX', 'Drums & Perc', 'Init'];
const PRESETS = [];
for (const cat of CATEGORIES) for (const p of PRESET_LIST) if (p.cat === cat) PRESETS.push(p);
if (PRESETS.length !== PRESET_LIST.length) throw new Error('every preset needs a category of CATEGORIES');
if (!PRESETS.some(p => p.name === DEFAULT_PRESET)) throw new Error('DEFAULT_PRESET not found: ' + DEFAULT_PRESET);

// Validate preset keys and ranges at generation time.
for (const pr of PRESETS) for (const [k, v] of Object.entries(pr.v)) {
  if (!(k in idx)) throw new Error(`preset ${pr.name}: unknown param ${k}`);
  const p = P[idx[k]];
  if (!(v >= p.min && v <= p.max)) throw new Error(`preset ${pr.name}: ${k}=${v} out of range`);
}
for (const s of S) for (const w of s.widgets) if (w.param && !(w.param in idx)) throw new Error('layout: unknown param ' + w.param);

module.exports = { DEVICE, APP, DEFAULT_PRESET, PARAMS: P, INDEX: idx, SECTIONS: S, PRESETS, FAVOURITES: 0, CATEGORIES };
