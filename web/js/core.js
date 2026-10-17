// Copyright (C) 2026 Pierre Arnaud GUYOT (OktoPierre)
// SPDX-License-Identifier: GPL-3.0-or-later
// FM Wavelet Synthesizer — created by Pierre Arnaud GUYOT (OktoPierre).
// DSP core: four-operator FM synthesis (phase modulation, as on the Yamaha DX7 / DX100) whose operators play one
// WAVELET ATOM per cycle instead of a sine. Used by the page (displays), by the AudioWorklet (engine, loaded with
// WSCoreFactory.toString()) and by Node tests (module.exports).
function WSCoreFactory(SPEC) {
  'use strict';

  const N = 2048;          // samples per operator cycle (2^11)
  const NB = 11;           // wavelet bands of a cycle (band 1 = coarsest, band 11 = finest)
  const NMIP = 11;         // band-limited copies of an operator wave, mip m keeps harmonics 1..(1024 >> m)
  const FN = N + 1;        // floats per mip level (one cycle + guard sample)
  const NOP = 4;           // operators
  const CTRL = 32;         // control-rate block
  const MAXV = 16;
  const LN1000 = Math.log(1000);
  const VOICE_GAIN = 0.4;   // about -8 dB per voice: headroom for chords
  const LIMIT_T = 0.7;      // output soft limiter: transparent below -3 dBFS, never above 0 dBFS
  const CH_BASE = 0.006, CH_DEPTH = 0.003, CH_FAST = 9.7;   // chorus: base delay, sweep per unit of depth (s), fast/slow LFO ratio
  const IMAX = 8;           // modulation index (radians) of a modulator at LEVEL 100 % and FM AMOUNT 100 %
  const FBMAX = 1.6;        // operator 4 self-modulation (radians) at FEEDBACK 100 %
  const HMOD = 8;           // a modulator keeps at most 8 harmonics of its own wave (anti-aliasing of the sidebands)
  const TWO_PI = 2 * Math.PI;

  const P = {};
  SPEC.PARAMS.forEach((p, i) => { P[p.key] = i; });
  const NP = SPEC.PARAMS.length;
  const RATIOS = SPEC.PARAMS[P.op1_ratio].values;
  const OPP = [1, 2, 3, 4].map(k => {   // parameter indices of each operator
    const o = 'op' + k + '_';
    return { wave: P[o + 'wave'], ratio: P[o + 'ratio'], fine: P[o + 'fine'], level: P[o + 'level'], vel: P[o + 'vel'],
      a: P[o + 'a'], d: P[o + 'd'], s: P[o + 's'], r: P[o + 'r'] };
  });
  // The 8 algorithms (operators 0-based): mod[k] = operators that modulate operator k; car = carriers (heard).
  // Modulation always goes from a higher to a lower operator number, so operators are computed 4, 3, 2, 1.
  const ALGOS = [
    { mod: [[1], [2], [3], []], car: [0] },          // 1 · 4→3→2→1
    { mod: [[1], [2, 3], [], []], car: [0] },        // 2 · (3+4)→2→1
    { mod: [[1, 3], [2], [], []], car: [0] },        // 3 · 3→2→1 + 4→1
    { mod: [[1, 2], [], [3], []], car: [0] },        // 4 · 2→1 + 4→3→1
    { mod: [[1], [], [3], []], car: [0, 2] },        // 5 · 2→1 + 4→3
    { mod: [[3], [3], [3], []], car: [0, 1, 2] },    // 6 · 4→1, 2, 3
    { mod: [[], [], [3], []], car: [0, 1, 2] },      // 7 · 4→3 + 1 + 2
    { mod: [[], [], [], []], car: [0, 1, 2, 3] },    // 8 · 1 + 2 + 3 + 4
  ];
  for (const a of ALGOS) a.isCar = [0, 1, 2, 3].map(k => a.car.includes(k));

  // ------------------------------------------------------------ utilities
  function rng(seed) {
    let s = seed >>> 0;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  function toPlain(p, n) {
    n = Math.min(1, Math.max(0, n));
    switch (p.curve) {
      case 'exp': return p.min * Math.pow(p.max / p.min, n);
      case 'pow2': return p.min + (p.max - p.min) * n * n;
      case 'int': case 'choice': return p.min + Math.round(n * (p.max - p.min));
      default: return p.min + (p.max - p.min) * n;
    }
  }
  function toNorm(p, v) {
    v = Math.min(p.max, Math.max(p.min, v));
    switch (p.curve) {
      case 'exp': return Math.log(v / p.min) / Math.log(p.max / p.min);
      case 'pow2': return Math.sqrt((v - p.min) / (p.max - p.min));
      default: return (v - p.min) / (p.max - p.min);
    }
  }
  const sgn = (v, s) => (v > 0 ? '+' : v < 0 ? '−' : '') + s;
  function format(p, v) {
    switch (p.fmt) {
      case 'pct': return Math.round(v * 100) + '%';
      case 'bipct': return sgn(v, Math.abs(Math.round(v * 100)) + '%');
      case 'db': return (v >= 0 ? '' : '−') + Math.abs(v).toFixed(1) + ' dB';
      case 'sec':
        if (p.curve === 'pow2' && v < 0.0005) return 'off';
        return v < 0.9995 ? (v * 1000).toFixed(v < 0.01 ? 1 : 0) + ' ms' : v.toFixed(2) + ' s';
      case 'hz': return v.toFixed(v < 1 ? 2 : 1) + ' Hz';
      case 'cents': return sgn(v, Math.abs(Math.round(v)) + ' ct');
      case 'int': return p.min < 0 ? sgn(Math.round(v), String(Math.abs(Math.round(v)))) : String(Math.round(v));
      case 'choice': return p.choices[Math.round(v)] || '';
      default: return v.toFixed(2);
    }
  }
  function parse(p, s) {
    if (p.fmt === 'choice') {
      const i = p.choices.findIndex(c => c.toLowerCase() === String(s).trim().toLowerCase());
      if (i >= 0) return i;
    }
    const t = String(s).replace('−', '-');
    if (p.fmt === 'sec' && /off/i.test(t)) return p.min;
    const m = /[-+]?[0-9]*.?[0-9]+/.exec(t);
    let v = m ? parseFloat(m[0]) : NaN;
    if (isNaN(v)) return null;
    switch (p.fmt) {
      case 'pct': case 'bipct': v /= 100; break;
      case 'sec': if (/ms/i.test(t)) v /= 1000; break;
    }
    return Math.min(p.max, Math.max(p.min, v));
  }
  function defaults() { return SPEC.PARAMS.map(p => p.def); }

  // ------------------------------------------------------------ wavelets
  const FILTERS = SPEC.WAVELETS.map(w => {
    const L = w.h.length, h = Float64Array.from(w.h), g = new Float64Array(L);
    for (let n = 0; n < L; n++) g[n] = ((n & 1) ? -1 : 1) * h[L - 1 - n];
    return { h, g, L };
  });

  // Periodic orthogonal DWT, full depth. Output layout: c[0] = approximation,
  // band b (1..11) occupies c[2^(b-1) .. 2^b - 1] (band 11 = finest).
  function dwt(x, f) {
    const c = new Float64Array(N);
    let a = Float64Array.from(x), M = N;
    while (M > 1) {
      const half = M >> 1, na = new Float64Array(half);
      for (let k = 0; k < half; k++) {
        let sa = 0, sd = 0;
        for (let n = 0; n < f.L; n++) { const v = a[(2 * k + n) % M]; sa += f.h[n] * v; sd += f.g[n] * v; }
        na[k] = sa; c[half + k] = sd;
      }
      a = na; M = half;
    }
    c[0] = a[0];
    return c;
  }
  function idwt(c, f) {
    let a = new Float64Array(1); a[0] = c[0];
    for (let M = 2; M <= N; M <<= 1) {
      const half = M >> 1, x = new Float64Array(M);
      for (let k = 0; k < half; k++) {
        const ak = a[k], dk = c[half + k];
        if (ak === 0 && dk === 0) continue;
        for (let n = 0; n < f.L; n++) { const i = (2 * k + n) % M; x[i] += f.h[n] * ak + f.g[n] * dk; }
      }
      a = x;
    }
    return a;
  }

  // ------------------------------------------------------------ FFT (radix-2, N points)
  const rev = new Uint16Array(N), cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < 11; b++) if (i & (1 << b)) r |= 1 << (10 - b); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
  function fft(re, im, inverse) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step, wr = cosT[k], wi = inverse ? sinT[k] : -sinT[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // ------------------------------------------------------------ operator waves
  // An operator plays the band-1 atom of its wavelet: one wavelet atom spanning the whole cycle (periodised), scaled to
  // peak 1. Haar gives a square; the longer, smoother wavelets come closer and closer to a sine.
  const waveCache = [], tableCache = [];
  function opWave(w) {
    if (waveCache[w]) return waveCache[w];
    const c = new Float64Array(N); c[1] = 1;
    const x = idwt(c, FILTERS[w]);
    let peak = 0, mean = 0;
    for (let i = 0; i < N; i++) mean += x[i] / N;
    for (let i = 0; i < N; i++) { x[i] -= mean; peak = Math.max(peak, Math.abs(x[i])); }
    for (let i = 0; i < N; i++) x[i] /= peak;
    return (waveCache[w] = x);
  }
  // Band-limited copies (mips) of an operator wave, so that an operator never plays harmonics above Nyquist.
  function opTable(w) {
    if (tableCache[w]) return tableCache[w];
    const x = opWave(w), t = new Float32Array(NMIP * FN);
    const re = Float64Array.from(x), im = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N);
    fft(re, im, false);
    for (let m = 0; m < NMIP; m++) {
      const H = 1024 >> m;
      yr.fill(0); yi.fill(0);
      for (let h = 1; h <= H; h++) { yr[h] = re[h]; yi[h] = im[h]; }
      for (let h = 1; h <= Math.min(H, N / 2 - 1); h++) { yr[N - h] = re[N - h]; yi[N - h] = im[N - h]; }
      fft(yr, yi, true);
      const off = m * FN;
      for (let i = 0; i < N; i++) t[off + i] = yr[i] / N;
      t[off + N] = t[off];
    }
    return (tableCache[w] = t);
  }
  const mipOf = H => (H >= 1024 ? 0 : H < 1 ? NMIP - 1 : Math.min(NMIP - 1, Math.ceil(Math.log2(1024 / H) - 1e-9)));
  // Effective harmonic content of each operator wave: the number of harmonics that hold 99.9 % of its energy
  // (Daubechies 20: 1, a sine; Haar: many, a square). Used to estimate how far the FM sidebands of a modulator reach.
  const HEFF = FILTERS.map((f, w) => {
    const re = Float64Array.from(opWave(w)), im = new Float64Array(N);
    fft(re, im, false);
    let tot = 0; const e = [];
    for (let h = 1; h < N / 2; h++) { e[h] = re[h] * re[h] + im[h] * im[h]; tot += e[h]; }
    let acc = 0;
    for (let h = 1; h < N / 2; h++) { acc += e[h]; if (acc >= 0.999 * tot) return h; }
    return N / 2;
  });
  const ratioOf = (params, k) => RATIOS[Math.round(params[OPP[k].ratio])] * (1 + params[OPP[k].fine]);

  // One cycle of the sound for the displays: the operators at the given output levels (0..1, LEVEL x envelope; the
  // LEVEL values when lv is omitted), raw waves (not band-limited). A non-integer ratio does not repeat every cycle:
  // the display then shows the first cycle of the carrier.
  function fmCycle(params, lv, out) {
    const al = ALGOS[Math.round(params[P.algo])], amt = params[P.fm_amount];
    const R = [], wv = [], m = [];
    for (let k = 0; k < NOP; k++) {
      R[k] = ratioOf(params, k); wv[k] = opWave(Math.round(params[OPP[k].wave]));
      const l = lv ? lv[k] : params[OPP[k].level];
      m[k] = al.isCar[k] ? l : l * IMAX * amt / TWO_PI;   // carriers: amplitude; modulators: index in cycles
    }
    const rd = (x, ph) => { ph -= Math.floor(ph); const pos = ph * N, i0 = pos | 0, fr = pos - i0, a = x[i0]; return a + fr * (x[(i0 + 1) % N] - a); };
    const kfb = params[P.feedback] * FBMAX / TWO_PI, o = [0, 0, 0, 0];
    const ncar = al.car.length;
    let f1 = 0, f2 = 0;
    out = out || new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / N;
      for (let k = NOP - 1; k >= 0; k--) {
        let q = R[k] * x;
        if (k === 3) q += kfb * 0.5 * (f1 + f2);
        for (const j of al.mod[k]) q += m[j] * o[j];
        o[k] = rd(wv[k], q);
        if (k === 3) { f2 = f1; f1 = o[3]; }
      }
      let y = 0;
      for (const c of al.car) y += m[c] * o[c];
      out[i] = y / Math.sqrt(ncar);
    }
    return out;
  }

  // ------------------------------------------------------------ output stage helpers
  function softLimit(x) {
    const a = Math.abs(x);
    if (a <= LIMIT_T) return x;
    const y = LIMIT_T + (1 - LIMIT_T) * Math.tanh((a - LIMIT_T) / (1 - LIMIT_T));
    return x < 0 ? -y : y;
  }

  // ------------------------------------------------------------ engine
  function Env() { this.stage = 0; this.level = 0; }
  // stage: 0 idle, 1 attack, 2 decay/sustain, 3 release
  Env.prototype.gate = function (on) { this.stage = on ? 1 : (this.stage ? 3 : 0); };
  Env.prototype.step = function (n, sr, a, d, s, r) {
    if (this.stage === 1) {
      this.level += n / (a * sr);
      if (this.level >= 1) { this.level = 1; this.stage = 2; }
    } else if (this.stage === 2) {
      this.level = s + (this.level - s) * Math.exp(-n * LN1000 / (d * sr));
    } else if (this.stage === 3) {
      this.level *= Math.exp(-n * LN1000 / (r * sr));
      if (this.level < 1e-5) { this.level = 0; this.stage = 0; }
    }
    return this.level;
  };

  function Voice() {
    this.active = false; this.gate = false; this.held = false;
    this.note = 60; this.vel = 1; this.age = 0;
    this.pitch = 60; this.target = 60; this.glide = false;
    this.phase = new Float64Array(4 * NOP);   // [unison voice u][operator k] at u * 4 + k
    this.fb = new Float64Array(8);            // last two outputs of operator 4, per unison voice
    this.env = [new Env(), new Env(), new Env(), new Env()];
    this.m0 = new Float64Array(NOP);          // per operator, at the start of the block: carrier amplitude or modulator index (cycles)
    this.m1 = new Float64Array(NOP);          // ... at the end of the block
    this.lv = new Float64Array(NOP);          // operator output levels (LEVEL x envelope x velocity), for the displays
    this.R = new Float64Array(NOP);           // frequency ratios
    this.mip = new Int32Array(NOP);
    this.fresh = true;
  }

  function Engine(sr) {
    this.p = Float64Array.from(defaults());
    this.voices = [];
    for (let i = 0; i < MAXV; i++) this.voices.push(new Voice());
    this.counter = 0; this.lastPitch = 60; this.stack = [];
    this.lfoPhase = 0; this.lfo = 0; this.sh = 0; this.lfoRng = rng(777);
    this.keys = new Uint8Array(128);
    this.tabs = [];
    for (let w = 0; w < FILTERS.length; w++) this.tabs.push(opTable(w));   // all operator waves, built once
    this.bufL = new Float32Array(CTRL); this.bufR = new Float32Array(CTRL);
    this.panL = new Float64Array(4); this.panR = new Float64Array(4); this.inc = new Float64Array(4);
    this.o = new Float64Array(NOP); this.B = new Float64Array(NOP); this.I = new Float64Array(NOP);
    this.Bs = new Float64Array(NOP); this.Is = new Float64Array(NOP);
    this.disp = { voices: 0, peakL: 0, peakR: 0, note: -1, lv: new Float32Array(NOP) };
    this.lastVoice = -1;
    this.setSampleRate(sr);
  }
  const E = Engine.prototype;

  E.setSampleRate = function (sr) {
    this.sr = sr;
    this.fmax = Math.max(0.45 * sr, sr - 19000);
    this.dlyLen = Math.ceil(sr * 1.1) + 4;
    this.dlyL = new Float32Array(this.dlyLen); this.dlyR = new Float32Array(this.dlyLen);
    this.dlyW = 0; this.dlyT = this.p[P.fx_dtime] * sr; this.lpL = 0; this.lpR = 0;
    const sc = sr / 44100;
    const cT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aT = [556, 441, 341, 225];
    this.combs = []; this.aps = [];
    for (let ch = 0; ch < 2; ch++) {
      for (const t of cT) this.combs.push({ buf: new Float32Array(Math.round((t + ch * 23) * sc)), i: 0, f: 0, ch });
      for (const t of aT) this.aps.push({ buf: new Float32Array(Math.round((t + ch * 23) * sc)), i: 0, ch });
    }
    this.vol = Math.pow(10, this.p[P.master] / 20);
    this.dcR = 1 - 2 * Math.PI * 10 / sr; this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
    this.chLen = Math.ceil(sr * 0.03) + 4;
    this.chBuf = new Float32Array(this.chLen); this.chW = 0; this.chPh = 0; this.chPh2 = 0;
  };

  E.setParam = function (id, v) {
    const old = this.p[id];
    this.p[id] = v;
    if (id === P.hold && old >= 0.5 && v < 0.5) {
      for (const vc of this.voices) if (vc.active && vc.held) { vc.held = false; this.release(vc); }
    }
  };

  E.release = function (vc) { vc.gate = false; for (const e of vc.env) e.gate(false); };

  // glideOn: this note slides from the previous pitch (portamento mode and legato decide)
  E.trigger = function (vc, note, vel, legato, glideOn) {
    vc.glide = !!glideOn;
    const glide = glideOn ? this.p[P.v_glide] : 0;
    if (!vc.active) {
      vc.fresh = true;
      vc.phase.fill(0); vc.fb.fill(0);
      for (const e of vc.env) { e.level = 0; e.stage = 0; }
      // polyphonic portamento: an idle voice glides from its own last pitch (a never-used voice from the last note)
      vc.pitch = glide > 0 ? (vc.age ? vc.pitch : this.lastPitch) : note;
    } else if (glide <= 0) vc.pitch = note;
    vc.active = true; vc.gate = true; vc.held = false;
    vc.note = note; vc.target = note; vc.vel = vel;
    vc.age = ++this.counter;
    if (!legato) for (const e of vc.env) e.gate(true);
    this.lastPitch = note;
  };

  E.noteOn = function (note, vel) {
    if (vel <= 0) { this.noteOff(note); return; }
    let othersHeld = false;
    for (let k = 0; k < 128; k++) if (k !== note && this.keys[k]) { othersHeld = true; break; }
    const porta = Math.round(this.p[P.v_porta]);
    this.keys[note] = 1;
    const maxV = Math.round(this.p[P.v_voices]);
    if (maxV <= 1) {
      const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
      const vc = this.voices[0];
      const legato = vc.active && this.stack.length > 0;   // another key is still held down
      this.stack.push(note);
      for (let k = 1; k < MAXV; k++) if (this.voices[k].active) this.release(this.voices[k]);
      this.trigger(vc, note, vel, legato, porta === 1 || (porta === 2 && legato));
      this.lastVoice = 0;
      return;
    }
    const glideOn = porta === 1 || (porta === 2 && othersHeld);
    let pick = -1;
    for (let k = 0; k < MAXV; k++) if (this.voices[k].active && this.voices[k].note === note) { pick = k; break; }
    if (pick < 0 && glideOn && this.p[P.v_glide] > 0) pick = this.glideVoice(note, maxV, othersHeld);
    if (pick < 0) for (let k = 0; k < maxV; k++) if (!this.voices[k].active) { pick = k; break; }
    if (pick < 0) {
      let best = -1, bestAge = Infinity;
      for (let k = 0; k < maxV; k++) { const v = this.voices[k]; if (!v.gate && v.age < bestAge) { best = k; bestAge = v.age; } }
      if (best < 0) for (let k = 0; k < maxV; k++) { const v = this.voices[k]; if (v.age < bestAge) { best = k; bestAge = v.age; } }
      pick = best;
    }
    const from = this.lastPitch;
    this.trigger(this.voices[pick], note, vel, false, glideOn);
    // Legato only, polyphonic: like a mono legato line, glide from the note still held (the last one played)
    if (porta === 2 && glideOn && this.p[P.v_glide] > 0) this.voices[pick].pitch = from;
    this.lastVoice = pick;
  };

  // Polyphonic portamento: which free voice glides to the new note. Playing one note at a time it is the voice of the
  // previous note; with other keys held (chords) it is the free voice whose last pitch is nearest.
  E.glideVoice = function (note, maxV, othersHeld) {
    let pick = -1, best = Infinity;
    for (let k = 0; k < maxV; k++) {
      const v = this.voices[k];
      if (v.gate || !v.age) continue;
      const score = othersHeld ? Math.abs(v.pitch - note) - v.age * 1e-9 : -v.age;
      if (score < best) { best = score; pick = k; }
    }
    return pick;
  };

  E.noteOff = function (note) {
    this.keys[note] = 0;
    const hold = this.p[P.hold] >= 0.5;
    if (Math.round(this.p[P.v_voices]) <= 1) {
      const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
      const vc = this.voices[0];
      if (vc.active && vc.note === note) {
        if (this.stack.length) {
          const n = this.stack[this.stack.length - 1];
          vc.note = n; vc.target = n; vc.glide = Math.round(this.p[P.v_porta]) !== 0;
          if (!vc.glide || this.p[P.v_glide] <= 0) vc.pitch = n;
          this.lastPitch = n;
        } else if (hold) vc.held = true;
        else this.release(vc);
      }
      return;
    }
    for (const vc of this.voices) if (vc.active && vc.gate && vc.note === note) {
      if (hold) vc.held = true; else this.release(vc);
    }
  };

  E.allNotesOff = function () {
    this.stack.length = 0; this.keys.fill(0);
    for (const vc of this.voices) if (vc.active) { vc.held = false; this.release(vc); }
  };

  // MIDI CC120: silence immediately (voices and effect tails)
  E.allSoundOff = function () {
    this.stack.length = 0; this.keys.fill(0);
    for (const vc of this.voices) { vc.active = false; vc.gate = false; vc.held = false; for (const e of vc.env) { e.stage = 0; e.level = 0; } }
    this.dlyL.fill(0); this.dlyR.fill(0); this.lpL = 0; this.lpR = 0;
    for (const c of this.combs) { c.buf.fill(0); c.f = 0; }
    for (const a of this.aps) a.buf.fill(0);
    this.chBuf.fill(0);
  };

  E.lfoTick = function (n) {
    const p = this.p, shape = Math.round(p[P.lfo_shape]), ph = this.lfoPhase;
    let v;
    switch (shape) {
      case 0: v = Math.sin(2 * Math.PI * ph); break;
      case 1: v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break;
      case 2: v = 1 - 2 * ph; break;
      case 3: v = ph < 0.5 ? 1 : -1; break;
      default: v = this.sh; break;
    }
    this.lfo = v;
    this.lfoPhase += p[P.lfo_rate] * n / this.sr;
    if (this.lfoPhase >= 1) { this.lfoPhase -= Math.floor(this.lfoPhase); this.sh = this.lfoRng() * 2 - 1; }
  };

  // Per-voice control update for a block of n samples: pitch, operator envelopes and levels, modulation indices and
  // the band limit of every operator. Returns false when the voice has ended (all its carriers are silent).
  E.control = function (vc, n) {
    const p = this.p, sr = this.sr;
    const glide = vc.glide ? p[P.v_glide] : 0;
    if (glide > 0 && vc.pitch !== vc.target) {
      vc.pitch += (vc.target - vc.pitch) * (1 - Math.exp(-n * 4.6 / (glide * sr)));
      if (Math.abs(vc.target - vc.pitch) < 1e-3) vc.pitch = vc.target;
    } else vc.pitch = vc.target;
    const semis = vc.pitch + 12 * p[P.v_oct] + p[P.v_fine] / 100 + 2 * p[P.bend] +
      this.lfo * (p[P.lfo_pitch] + 50 * p[P.modwheel]) / 100;
    const f0 = 440 * Math.pow(2, (semis - 69) / 12);
    vc.f0 = f0;
    const U = Math.round(p[P.v_unison]), det = p[P.v_detune];
    vc.U = U;
    const fTop = f0 * Math.pow(2, (U > 1 ? det : 0) / 1200);
    const maxH = this.fmax / fTop;   // highest partial (in multiples of the note) that stays below the audio limit

    const al = ALGOS[Math.round(p[P.algo])];
    vc.al = al;
    const amt = Math.max(0, p[P.fm_amount] * (1 + p[P.lfo_fm] * this.lfo));
    const I = this.I, B = this.B;
    let alive = false;
    for (let k = 0; k < NOP; k++) {
      const q = OPP[k];
      const e = vc.env[k].step(n, sr, p[q.a], p[q.d], p[q.s], p[q.r]);
      if (al.isCar[k] && vc.env[k].stage !== 0) alive = true;
      const lv = p[q.level] * e * (1 - p[q.vel] * (1 - vc.vel));
      vc.lv[k] = lv;
      vc.R[k] = ratioOf(p, k);
      I[k] = al.isCar[k] ? 0 : lv * IMAX * amt;   // modulation index (radians) of a modulator
    }
    // Band limits (anti-aliasing), from operator 4 down to 1. Phase modulation of a wave that is not a sine modulates
    // its harmonic h h times harder than its fundamental: harmonic h of operator k, modulated by operators j (index I,
    // output bandwidth B), spreads up to h·fk + Σ (h·I + 1)·B (Carson's rule). So every operator reads the copy of its
    // wave whose harmonics stay below the audio limit (modulators: below Nyquist and at most HMOD harmonics) at the
    // STRONGEST modulation of the note (LEVEL settings, full velocity, LFO peak): the copy is fixed while the note plays,
    // so the sound never jumps. A Haar operator (a square) therefore loses its upper harmonics when it is modulated; a
    // Daubechies 20 operator (a sine) is not affected. FM sidebands themselves cannot be band-limited by tables: on high
    // notes the index of a modulator is reduced smoothly (a continuous function of pitch and level, no threshold) when its
    // sidebands reach far past the audio limit.
    const kfbR = p[P.feedback] * FBMAX, fNyq = 0.45 * sr, Bs = this.Bs, Is = this.Is;
    const amtMax = p[P.fm_amount] * (1 + p[P.lfo_fm]);
    const lim = (bw, i) => { const x = (i + 1) * bw / fNyq; return x > 0.5 ? i / (1 + 4 * (x - 0.5) * (x - 0.5)) : i; };   // x = 1: sidebands at the limit
    for (let k = NOP - 1; k >= 0; k--) {
      const fk = vc.R[k] * fTop, car = al.isCar[k], hEff = HEFF[Math.round(p[OPP[k].wave])], limit = car ? this.fmax : fNyq;
      // modulation arriving at this operator, now (I, B) and at the strongest (Is, Bs): Σ B and Σ I·B
      let sB = 0, sIB = 0, dB = 0, dIB = 0;
      for (const j of al.mod[k]) {
        if (Is[j] > 0) { sB += Bs[j]; sIB += Is[j] * Bs[j]; }
        if (I[j] > 0) { dB += B[j]; dIB += I[j] * B[j]; }
      }
      if (k === 3 && kfbR > 0) { sB += fk; sIB += kfbR * fk; dB += fk; dIB += kfbR * fk; }   // feedback: operator 4 modulates itself
      let H = car ? Math.floor(limit / fk) : Math.min(HMOD, Math.floor(limit / fk));
      if (sIB > 0) H = Math.min(H, Math.floor((limit - sB) / (fk + sIB)));
      if (fk >= limit) H = 0;
      else if (H < 1) H = 1;   // the fundamental always stays
      if (H < 1) { I[k] = 0; if (car) vc.lv[k] = 0; }   // above the audio limit: silent
      vc.mip[k] = mipOf(H);
      const h = Math.min(hEff, Math.max(1, H));   // highest harmonic really present
      B[k] = h * fk + h * dIB + dB; Bs[k] = h * fk + h * sIB + sB;   // bandwidth of the output, Hz
      Is[k] = car || H < 1 ? 0 : p[OPP[k].level] * IMAX * amtMax;
      if (!car) {
        if (I[k] > 0) I[k] = lim(B[k], I[k]);
        if (Is[k] > 0) Is[k] = lim(Bs[k], Is[k]);
      }
    }
    const tremolo = 1 - p[P.lfo_amp] * (0.5 + 0.5 * this.lfo);
    const ncar = 1 / Math.sqrt(al.car.length);
    for (let k = 0; k < NOP; k++) {
      vc.m1[k] = al.isCar[k] ? vc.lv[k] * tremolo * ncar : I[k] / TWO_PI;   // carriers: amplitude; modulators: index in cycles
      if (vc.fresh) vc.m0[k] = al.isCar[k] ? 0 : vc.m1[k];
    }
    vc.fresh = false;
    vc.kfb = kfbR / TWO_PI;
    return alive;
  };

  // Render one voice for n samples, accumulating into bufL/bufR. Operators are computed 4, 3, 2, 1; each reads its
  // band-limited wave at its own phase plus the outputs of its modulators (phase modulation).
  E.renderVoice = function (vc, n) {
    const p = this.p, sr = this.sr, U = vc.U, al = vc.al, tabs = this.tabs, o = this.o;
    const det = p[P.v_detune], width = p[P.v_width];
    const gl = this.panL, gr = this.panR, inc = this.inc, ph = vc.phase, fb = vc.fb;
    const uGain = VOICE_GAIN / Math.sqrt(U);
    for (let u = 0; u < U; u++) {
      const pos = U > 1 ? 2 * u / (U - 1) - 1 : 0;
      inc[u] = vc.f0 * Math.pow(2, det * pos / 1200) / sr;
      const th = (pos * width + 1) * Math.PI / 4;
      gl[u] = Math.SQRT2 * Math.cos(th) * uGain; gr[u] = Math.SQRT2 * Math.sin(th) * uGain;
    }
    const T = [], off = [], R = vc.R, m0 = vc.m0, dm = [];
    for (let k = 0; k < NOP; k++) {
      T[k] = tabs[Math.round(p[OPP[k].wave])]; off[k] = vc.mip[k] * FN;
      dm[k] = (vc.m1[k] - m0[k]) / n;
    }
    const mod = al.mod, car = al.car, kfb = vc.kfb;
    const audible = vc.f0 < 0.5 * sr;   // a fundamental at or above Nyquist can only alias
    const L = this.bufL, Rb = this.bufR;
    const m = [m0[0], m0[1], m0[2], m0[3]];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < NOP; k++) m[k] += dm[k];
      let outL = 0, outR = 0;
      for (let u = 0; u < U; u++) {
        const b = u * NOP;
        for (let k = NOP - 1; k >= 0; k--) {
          let x = ph[b + k] + inc[u] * R[k];
          if (x >= 1) x -= Math.floor(x);   // keeps the table position inside the cycle even for steps longer than a cycle
          ph[b + k] = x;
          let q = x;
          if (k === 3) q += kfb * 0.5 * (fb[2 * u] + fb[2 * u + 1]);
          const mk = mod[k];
          for (let j = 0; j < mk.length; j++) q += m[mk[j]] * o[mk[j]];
          q -= Math.floor(q);
          const t = T[k], pos = q * N, i0 = pos | 0, fr = pos - i0, a = t[off[k] + i0];
          o[k] = a + fr * (t[off[k] + i0 + 1] - a);
          if (k === 3) { fb[2 * u + 1] = fb[2 * u]; fb[2 * u] = o[3]; }
        }
        if (!audible) continue;
        let y = 0;
        for (let c = 0; c < car.length; c++) y += m[car[c]] * o[car[c]];
        outL += y * gl[u]; outR += y * gr[u];
      }
      L[i] += outL; Rb[i] += outR;
    }
    for (let k = 0; k < NOP; k++) m0[k] = vc.m1[k];
  };

  // Process n samples (any n) into outL/outR (overwrites).
  E.process = function (outL, outR, n) {
    let done = 0;
    while (done < n) {
      const m = Math.min(CTRL, n - done);
      this.block(outL, outR, done, m);
      done += m;
    }
  };

  E.block = function (outL, outR, o, n) {
    const p = this.p, L = this.bufL, R = this.bufR;
    L.fill(0, 0, n); R.fill(0, 0, n);
    this.lfoTick(n);
    let voices = 0;
    for (let k = 0; k < MAXV; k++) {
      const vc = this.voices[k];
      if (!vc.active) continue;
      if (!this.control(vc, n)) { vc.active = false; vc.gate = false; continue; }
      this.renderVoice(vc, n);
      voices |= 1 << k;
    }

    // ---- effects
    const drive = p[P.fx_drive], kd = Math.pow(10, drive * 24 / 20), comp = 0.5 / Math.tanh(0.5 * kd);
    const fb = p[P.fx_dfb], dmix = p[P.fx_dmix], rmix = p[P.fx_rmix];
    const dTarget = p[P.fx_dtime] * this.sr, dlen = this.dlyLen;
    const feedback = 0.7 + 0.28 * p[P.fx_rsize], damp = 0.25;
    const volT = Math.pow(10, p[P.master] / 20);
    const chMix = p[P.ch_mix], chLen = this.chLen, chBuf = this.chBuf;
    const chBase = CH_BASE * this.sr, chDepth = p[P.ch_depth] * CH_DEPTH * this.sr;
    const chInc = p[P.ch_rate] / this.sr, chInc2 = chInc * CH_FAST;
    let pkL = this.disp.peakL, pkR = this.disp.peakR;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (drive > 0) {
        l = (1 - drive) * l + drive * Math.tanh(kd * l) * comp;
        r = (1 - drive) * r + drive * Math.tanh(kd * r) * comp;
      }
      // string-machine triple chorus: three delay lines swept by a slow and a fast LFO, 120° apart, left / centre / right
      chBuf[this.chW] = 0.5 * (l + r);
      if (chMix > 0) {
        this.chPh += chInc; if (this.chPh >= 1) this.chPh -= 1;
        this.chPh2 += chInc2; if (this.chPh2 >= 1) this.chPh2 -= 1;
        let v0 = 0, v1 = 0, v2 = 0;
        for (let c = 0; c < 3; c++) {
          const mo = 0.8 * Math.sin(2 * Math.PI * (this.chPh + c / 3)) + 0.2 * Math.sin(2 * Math.PI * (this.chPh2 + c / 3));
          let rp = this.chW - (chBase + chDepth * (1 + mo)); if (rp < 0) rp += chLen;
          const i0 = Math.floor(rp), fr = rp - i0, i1 = (i0 + 1) % chLen;
          const v = chBuf[i0] + fr * (chBuf[i1] - chBuf[i0]);
          if (c === 0) v0 = v; else if (c === 1) v1 = v; else v2 = v;
        }
        l += chMix * ((2 * v0 + v1) / 3 - l);
        r += chMix * ((2 * v2 + v1) / 3 - r);
      }
      if (++this.chW >= chLen) this.chW = 0;
      // ping-pong delay
      this.dlyT += (dTarget - this.dlyT) * 0.0005;
      if (dmix > 0 || fb > 0) {
        let rp = this.dlyW - this.dlyT; if (rp < 0) rp += dlen;
        const i0 = rp | 0, fr = rp - i0, i1 = (i0 + 1) % dlen;
        const dl = this.dlyL[i0] + fr * (this.dlyL[i1] - this.dlyL[i0]);
        const dr = this.dlyR[i0] + fr * (this.dlyR[i1] - this.dlyR[i0]);
        this.lpL += (dl - this.lpL) * 0.35; this.lpR += (dr - this.lpR) * 0.35;
        this.dlyL[this.dlyW] = 0.5 * (L[i] + R[i]) + fb * this.lpR;
        this.dlyR[this.dlyW] = fb * this.lpL;
        l += dmix * dl; r += dmix * dr;
      } else { this.dlyL[this.dlyW] = 0; this.dlyR[this.dlyW] = 0; }
      if (++this.dlyW >= dlen) this.dlyW = 0;
      // reverb (Freeverb topology)
      if (rmix > 0) {
        const inp = (l + r) * 0.015;
        let wl = 0, wr = 0;
        for (const c of this.combs) {
          const y = c.buf[c.i];
          c.f = y * (1 - damp) + c.f * damp;
          c.buf[c.i] = inp + c.f * feedback;
          if (++c.i >= c.buf.length) c.i = 0;
          if (c.ch === 0) wl += y; else wr += y;
        }
        for (const a of this.aps) {
          const bo = a.buf[a.i], x = a.ch === 0 ? wl : wr;
          a.buf[a.i] = x + bo * 0.5;
          if (++a.i >= a.buf.length) a.i = 0;
          if (a.ch === 0) wl = bo - x; else wr = bo - x;
        }
        l += rmix * wl * 1.5; r += rmix * wr * 1.5;
      }
      // DC blocker (10 Hz), master volume, soft limiter
      const yl = l - this.dcxL + this.dcR * this.dcyL; this.dcxL = l; this.dcyL = Math.abs(yl) < 1e-20 ? 0 : yl; l = this.dcyL;
      const yr = r - this.dcxR + this.dcR * this.dcyR; this.dcxR = r; this.dcyR = Math.abs(yr) < 1e-20 ? 0 : yr; r = this.dcyR;
      this.vol += (volT - this.vol) * 0.002;
      l = softLimit(l * this.vol); r = softLimit(r * this.vol);
      outL[o + i] = l; outR[o + i] = r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pkL) pkL = al; if (ar > pkR) pkR = ar;
    }
    // ---- display state: the operator levels of the last voice played
    const d = this.disp;
    d.peakL = pkL; d.peakR = pkR; d.voices = voices;
    const lv = this.lastVoice >= 0 ? this.voices[this.lastVoice] : null;
    if (lv && lv.active) { for (let k = 0; k < NOP; k++) d.lv[k] = lv.lv[k]; d.note = lv.note; } else d.note = -1;
  };

  return {
    N, NB, NMIP, NOP, CTRL, MAXV, P, NP, ALGOS, RATIOS, IMAX,
    rng, toPlain, toNorm, format, parse, defaults,
    FILTERS, dwt, idwt, fft, opWave, opTable, ratioOf, fmCycle, Engine,
  };
}
if (typeof module !== 'undefined') module.exports = WSCoreFactory;
