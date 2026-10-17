// Copyright (C) 2026 Pierre Arnaud GUYOT (OktoPierre)
// SPDX-License-Identifier: GPL-3.0-or-later
// quick.js - fast check (about 15-25 s) to run after every change.
//
//   node tests/quick.js
//
// 1. every JS file parses, the generated spec is up to date
// 2. JS engine: every preset sounds, stays finite and <= 0 dBFS (also on very high notes); all algorithms and
//    wavelets render; the operator waves go from a square (Haar) to a sine (Daubechies 20)
// 3. web app in headless Edge (muted: cdp.js always passes --mute-audio; always closed at the end): loads without
//    errors, preset order, sound, the default demo starts on the first preset of its tour
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (...p) => path.join(ROOT, ...p);
let failed = 0;
function report(name, ok, detail, t0) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(11)} ${detail}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (!ok) failed++;
}
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };

function statics() {
  const t = Date.now(), bad = [];
  const js = ['web/js', 'tools', 'tests', 'tests/web'].flatMap(d => fs.readdirSync(R(d)).filter(f => f.endsWith('.js')).map(f => R(d, f)));
  for (const f of js) { try { new (require('vm').Script)(fs.readFileSync(f, 'utf8'), { filename: f }); } catch (e) { bad.push(path.basename(f) + ': ' + e.message); } }
  report('static', bad.length === 0, bad.length ? bad.join('; ') : `${js.length} JS files parse`, t);
  const t2 = Date.now(), src = Math.max(mtime(R('tools', 'spec.js')), mtime(R('tools', 'gen_spec.js')), mtime(R('tools', 'wavelets.json')));
  const ok = mtime(R('web', 'js', 'spec.js')) >= src;
  report('up to date', ok, ok ? 'generated spec is newer than tools/spec.js' : 'run  node tools/gen_spec.js', t2);
}

function engine() {
  const t = Date.now(), bad = [];
  const SPEC = require(R('web', 'js', 'spec.js')), C = require(R('web', 'js', 'core.js'))(SPEC), P = C.P;
  const sr = 48000;
  const render = (values, notes, secs) => {
    const eng = new C.Engine(sr); values.forEach((v, i) => eng.setParam(i, v));
    const L = new Float32Array(128), Rr = new Float32Array(128), n = Math.ceil(secs * sr / 128);
    let pk = 0, nan = 0;
    for (let b = 0; b < n; b++) {
      if (b === 0) for (const k of notes) eng.noteOn(k, 0.9);
      if (b === Math.floor(n * 0.7)) eng.allNotesOff();
      eng.process(L, Rr, 128);
      for (let i = 0; i < 128; i++) { if (!isFinite(L[i]) || !isFinite(Rr[i])) nan++; pk = Math.max(pk, Math.abs(L[i]), Math.abs(Rr[i])); }
    }
    return { pk, nan };
  };
  for (const pr of SPEC.PRESETS) {
    const a = render(pr.values, [48, 60, 64, 67], 1.2), b = render(pr.values, [108, 120, 127], 0.4);
    if (a.nan || b.nan) bad.push(pr.name + ': not finite');
    else if (!(a.pk > 1e-3)) bad.push(pr.name + ': no sound');
    else if (a.pk > 1.0001 || b.pk > 1.0001) bad.push(pr.name + ': above 0 dBFS');
  }
  // every algorithm with every wavelet, strong modulation and feedback
  const base = SPEC.PRESETS[SPEC.DEFAULT_PRESET].values.slice();
  for (let a = 0; a < C.ALGOS.length; a++) for (let w = 0; w < C.FILTERS.length; w++) {
    const v = base.slice(); v[P.algo] = a; v[P.feedback] = 1; v[P.fm_amount] = 2;
    for (let k = 1; k <= 4; k++) { v[P['op' + k + '_wave']] = w; v[P['op' + k + '_level']] = 1; v[P['op' + k + '_ratio']] = 3 + k; }
    const r = render(v, [36, 72, 115], 0.3);
    if (r.nan || r.pk > 1.0001 || !(r.pk > 1e-3)) bad.push(`algorithm ${a + 1} / wavelet ${w}: ${r.nan ? 'not finite' : 'peak ' + r.pk.toFixed(3)}`);
  }
  // no noise behind the sound: on a held note (envelopes at full level, effects, unison and LFO off) a preset with
  // harmonic ratios has (almost) nothing between its harmonics. Presets that use noise on purpose (feedback >= 0.9) or
  // inharmonic ratios (FINE) are skipped. Catches aliasing and unstable modulation (jumps between band limits).
  const NF = 8192, fre = new Float64Array(NF), fim = new Float64Array(NF);
  const fftN = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const h = len / 2, vr = re[i + j + h] * cr - im[i + j + h] * ci, vi = re[i + j + h] * ci + im[i + j + h] * cr;
          re[i + j + h] = re[i + j] - vr; im[i + j + h] = im[i + j] - vi; re[i + j] += vr; im[i + j] += vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  };
  const noiseDb = (values, note) => {
    const v = values.slice();
    for (const [k, x] of Object.entries({ ch_mix: 0, fx_rmix: 0, fx_dmix: 0, fx_dfb: 0, v_unison: 1, lfo_pitch: 0, lfo_amp: 0, lfo_fm: 0, fx_drive: 0, v_oct: 0 })) v[P[k]] = x;
    for (let k = 1; k <= 4; k++) { v[P['op' + k + '_d']] = 20; v[P['op' + k + '_s']] = 1; }
    const eng = new C.Engine(sr); v.forEach((x, i) => eng.setParam(i, x)); eng.noteOn(note, 0.9);
    const L = new Float32Array(128), Rr = new Float32Array(128), n0 = Math.round(0.2 * sr / 128) * 128, buf = new Float32Array(n0 + NF);
    for (let o = 0; o < buf.length; o += 128) { eng.process(L, Rr, 128); buf.set(L.subarray(0, Math.min(128, buf.length - o)), o); }
    for (let i = 0; i < NF; i++) { fre[i] = buf[n0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF)); fim[i] = 0; }
    fftN(fre, fim);
    const half = 440 * Math.pow(2, (note - 69) / 12) / 2;   // ratio ×0.5 allowed: harmonics of half the note
    let harm = 0, other = 0;
    for (let k = 1; k < NF / 2; k++) {
      const f = k * sr / NF; if (f > 18000) break;   // audible band
      const e = fre[k] * fre[k] + fim[k] * fim[k], d = Math.abs(f / half - Math.round(f / half)) * half;
      if (d < 4 * sr / NF) harm += e; else other += e;
    }
    return 10 * Math.log10(other / harm + 1e-30);
  };
  let worstNoise = -200, checkedNoise = 0;
  for (const pr of SPEC.PRESETS) {
    const fine = [1, 2, 3, 4].some(k => pr.values[P['op' + k + '_fine']] > 0 && pr.values[P['op' + k + '_level']] > 0);
    if (fine || pr.values[P.feedback] >= 0.9) continue;
    checkedNoise++;
    for (const note of [48, 72, 96]) {
      const db = noiseDb(pr.values, note);
      worstNoise = Math.max(worstNoise, db);
      if (db > -38) bad.push(`${pr.name}: noise ${db.toFixed(0)} dB at note ${note}`);
    }
  }
  // operator waves: Haar = square (strong harmonics), Daubechies 20 = practically a sine
  const thd = (w) => { const re = Float64Array.from(C.opWave(w)), im = new Float64Array(C.N); C.fft(re, im, false); let h = 0; for (let k = 2; k <= 10; k++) h += re[k] * re[k] + im[k] * im[k]; return Math.sqrt(h) / Math.hypot(re[1], im[1]); };
  if (!(thd(0) > 0.3 && thd(6) < 0.01)) bad.push(`operator waves: Haar ${thd(0).toFixed(2)}, DB20 ${thd(6).toFixed(3)}`);
  report('JS engine', bad.length === 0, bad.length ? bad.slice(0, 3).join('; ') : `${SPEC.PRESETS.length} presets, ${C.ALGOS.length} algorithms x ${C.FILTERS.length} wavelets: sound, finite, <= 0 dBFS; no noise (${checkedNoise} presets, worst ${worstNoise.toFixed(0)} dB)`, t);
}

async function web() {
  const t = Date.now(), bad = [];
  const { Browser, sleep } = require(R('tests', 'web', 'cdp.js'));
  const SPEC = require(R('web', 'js', 'spec.js'));
  let B = null;
  try {
    B = await Browser.launch({ width: 1240, height: 900 });
    await B.navigate('file:///' + R('web', 'index.html').replace(/\\/g, '/').replace(/ /g, '%20'));
    if (!await B.waitFor('!!window.WS_TEST', 5000)) throw new Error('the app did not start (no WS_TEST)');
    const names = await B.evaluate('WS_TEST.presets()');
    if (JSON.stringify(names.slice(0, SPEC.PRESETS.length)) !== JSON.stringify(SPEC.PRESETS.map(p => p.name))) bad.push('preset menu order differs from the spec');
    const label = await B.evaluate("(document.querySelector('.presets .pname span') || {}).textContent || ''");
    if (label !== SPEC.PRESETS[SPEC.DEFAULT_PRESET].name) bad.push(`opens on '${label}'`);
    await B.evaluate('WS_TEST.start()', 10000);
    if (await B.evaluate('WS_TEST.audioState()') !== 'running') bad.push('audio did not start');
    await B.evaluate('WS_TEST.noteOn(60, 0.9)');
    let peak = 0;   // the audio of headless Edge starts after about half a second: listen up to 2.5 s
    for (let w = 0; w < 2500 && !(peak > 1e-3); w += 150) { await sleep(150); const lv = await B.evaluate('WS_TEST.getLevel()'); peak = Math.max(peak, lv.peakL, lv.peakR); }
    await B.evaluate('WS_TEST.allNotesOff()');
    if (!(peak > 1e-3)) bad.push('no sound');
    await B.evaluate('WS_TEST.demoStart(0)');
    await sleep(800);
    const st = await B.evaluate('WS_TEST.demoState()'), plan = await B.evaluate('WS_TEST.demoTour(0)');
    await B.evaluate('WS_TEST.demoStop()');
    if (!st.running) bad.push('the default demo did not start');
    else if (!plan || st.preset !== plan[0].preset) bad.push(`demo tour starts on '${st.preset}'`);
    const errs = B.errors();
    if (errs.length) bad.push('page errors: ' + errs.slice(0, 2).join(' | '));
  } catch (e) {
    bad.push(e.message);
  } finally {
    if (B) await B.close();
  }
  report('web app', bad.length === 0, bad.length ? bad.join('; ') : 'loads without errors, preset order, sound, demo tour starts', t);
}

(async () => {
  const t = Date.now();
  console.log('FM Wavelet Synthesizer - quick check');
  statics();
  engine();
  await web();
  console.log(`${failed ? 'FAIL' : 'PASS'} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  process.exit(failed ? 1 : 0);
})();
