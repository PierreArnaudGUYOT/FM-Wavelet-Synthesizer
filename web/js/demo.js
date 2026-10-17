// Copyright (C) 2026 Pierre Arnaud GUYOT (OktoPierre)
// SPDX-License-Identifier: GPL-3.0-or-later
// FM Wavelet Synthesizer — created by Pierre Arnaud GUYOT (OktoPierre).
// Demo player: plays public-domain pieces (MIDI from the Mutopia Project) or your own MIDI file as a tour of the
// factory presets (a new preset about every 4 s, on a change of chord). A small window says what is playing.
function WSDemo(api) {
  'use strict';
  const SONGS = WS_DEMO_SONGS;
  const C = api.C, P = api.P, PARAMS = api.PARAMS;
  const LEAD_IN = 0.25;   // seconds between the click and the first note
  const MAX_FILE_SECONDS = 360;
  const STEP = 4;         // seconds per preset

  // The tour plays the factory presets in menu order, without the drums and the Init preset (a piano piece).
  const TOUR_ORDER = WS_SPEC.PRESETS.filter(p => p.cat !== 'Drums & Perc' && p.cat !== 'Init').map(p => p.name);
  // Every preset is made playable on the piece: polyphonic, normal octave, no glide, short attacks, short echoes.
  const TOUR_SAFE = { v_voices: 16, v_oct: 0, v_glide: 0 };
  const TOUR_MAX_ATTACK = 0.08;
  const TOUR_MAX_DELAY_MIX = 0.1, TOUR_MAX_DELAY_FB = 0.3;   // long echoes on a fast piece sound like a canon
  const TOUR_SNAP = 1.5, TOUR_LEAD = 0.08;
  // Each change is moved to a change of chord: near every STEP-second mark (within TOUR_SNAP), the onset where the most
  // notes start together; the preset is loaded TOUR_LEAD before it, so the new sound starts with the chord.
  function chordOnsets(notes) {   // notes: flat [time, duration, note, velocity] * n, sorted by time
    const ev = [];
    for (let i = 0; i < notes.length; i += 4) {
      const last = ev[ev.length - 1];
      if (last && notes[i] - last.t < 0.03) last.n++; else ev.push({ t: notes[i], n: 1 });
    }
    return ev;
  }
  function tourScenes(notes, duration) {
    const ev = chordOnsets(notes), out = [];
    let prev = 0;
    for (let k = 0; k * STEP < duration; k++) {
      let t = k * STEP;
      if (k > 0) {
        let best = null, score = -Infinity;
        for (const e of ev) {
          if (e.t < t - TOUR_SNAP || e.t <= prev + STEP / 2) continue;
          if (e.t > t + TOUR_SNAP) break;
          const s = e.n - Math.abs(e.t - t);   // a full chord close to the mark wins
          if (s > score) { score = s; best = e; }
        }
        if (best) t = best.t - TOUR_LEAD;
      }
      out.push({ t, preset: TOUR_ORDER[k % TOUR_ORDER.length] });
      prev = t;
    }
    out.forEach((sc, i) => { sc.pos = i; sc.of = out.length; });
    return out;
  }
  function presetSummary() {
    const v = api.values(), f = (k) => C.format(PARAMS[P[k]], v[P[k]]);
    const al = C.ALGOS[Math.round(v[P.algo])], parts = [];
    parts.push(`algorithm ${f('algo')}`);
    const used = [0, 1, 2, 3].filter(k => v[P['op' + (k + 1) + '_level']] > 0);
    parts.push(used.map(k => `op ${k + 1} ${C.format(PARAMS[P['op' + (k + 1) + '_wave']], v[P['op' + (k + 1) + '_wave']])} ×` +
      (+C.ratioOf(v, k).toFixed(2)) + (al.isCar[k] ? ' (carrier)' : '')).join(', '));
    if (v[P.feedback] > 0) parts.push(`feedback ${f('feedback')}`);
    const fx = [];
    if (v[P.ch_mix] > 0.05) fx.push('chorus');
    if (v[P.fx_drive] > 0.02) fx.push('drive');
    if (v[P.fx_dmix] > 0.05) fx.push('delay');
    if (v[P.fx_rmix] > 0.05) fx.push('reverb');
    if (fx.length) parts.push(fx.join(' + '));
    return parts.join(' · ') + '. Played polyphonic at its normal octave, with short echoes.';
  }

  let st = null;        // running state
  let win = null;       // window elements

  // ---------------------------------------------------------------- window
  function buildWindow() {
    const dev = document.getElementById('device');
    const w = document.createElement('div');
    w.className = 'demo-win';
    w.innerHTML =
      '<div class="dw-bar"><span class="dw-title"></span><button class="dw-stop" title="Stop the demo">■ STOP</button></div>' +
      '<div class="dw-body"><div class="dw-sec"></div><div class="dw-param"></div><div class="dw-val"></div><div class="dw-text"></div>' +
      '<div class="dw-prog"><i></i></div><div class="dw-foot"><span class="dw-time"></span><span class="dw-src"></span></div></div>';
    dev.appendChild(w);
    win = {
      el: w, title: w.querySelector('.dw-title'), sec: w.querySelector('.dw-sec'), param: w.querySelector('.dw-param'),
      val: w.querySelector('.dw-val'), text: w.querySelector('.dw-text'), prog: w.querySelector('.dw-prog i'),
      time: w.querySelector('.dw-time'), src: w.querySelector('.dw-src'),
    };
    w.querySelector('.dw-stop').onclick = () => stop();
    const bar = w.querySelector('.dw-bar'), D = WS_SPEC.DEVICE;
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      bar.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, l: w.offsetLeft, t: w.offsetTop };
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const s = api.ui.scale;
      w.style.left = Math.max(0, Math.min(D.w - w.offsetWidth, drag.l + (e.clientX - drag.x) / s)) + 'px';
      w.style.top = Math.max(0, Math.min(D.h - w.offsetHeight, drag.t + (e.clientY - drag.y) / s)) + 'px';
    });
    bar.addEventListener('pointerup', () => { drag = null; });
  }

  const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  // ---------------------------------------------------------------- control
  function set(key, v) { if (key in P) api.setParam(P[key], v); }

  function enterScene(k) {
    const sc = st.scenes[k];
    api.applyPreset(sc.preset);
    for (const key in TOUR_SAFE) set(key, TOUR_SAFE[key]);
    for (let o = 1; o <= 4; o++) if (api.values()[P['op' + o + '_a']] > TOUR_MAX_ATTACK) set('op' + o + '_a', TOUR_MAX_ATTACK);
    if (api.values()[P.fx_dmix] > TOUR_MAX_DELAY_MIX) set('fx_dmix', TOUR_MAX_DELAY_MIX);
    if (api.values()[P.fx_dfb] > TOUR_MAX_DELAY_FB) set('fx_dfb', TOUR_MAX_DELAY_FB);
    st.scene = k;
    api.setPresetLabel(sc.preset, false);
    win.sec.textContent = `Preset tour · ${sc.pos + 1}/${sc.of} · ${(WS_SPEC.PRESETS.find(p => p.name === sc.preset) || {}).cat || ''}`;
    win.param.textContent = 'Now playing: ' + sc.preset;
    win.text.textContent = presetSummary();
  }

  // Scene clock: the audio thread reports the sequencer position about 30 times per second; between reports it is
  // extrapolated (at most 120 ms). Before the first note and after the last one, the AudioContext clock is used.
  function now() {
    if (st.sync) return st.sync.seq + Math.min(0.12, (performance.now() - st.sync.at) / 1000);
    return api.ctxTime() - st.t0;
  }

  function tick() {
    if (!st) return;
    const t = now();
    let k = 0;
    for (let i = 0; i < st.scenes.length; i++) if (t >= st.scenes[i].t) k = i;
    if (t >= 0 && k !== st.scene) enterScene(k);
    if (t >= 0 && st.scene >= 0) {
      const next = st.scenes[st.scene + 1];
      win.val.textContent = next ? `next preset in ${Math.max(0, next.t - t).toFixed(1)} s: ${next.preset}` : 'last preset of this demo';
    }
    const total = st.song.duration;
    win.prog.style.width = (100 * Math.min(1, Math.max(0, t / total))) + '%';
    win.time.textContent = `${mmss(Math.max(0, Math.min(total, t)))} / ${mmss(Math.round(total))}`;   // total rounded like the menu
    if (t > total + 2.5) { stop(); return; }
    st.raf = requestAnimationFrame(tick);
  }

  async function play(song) {
    if (st) stop();
    await api.startAudio();
    if (!win) buildWindow();
    st = { song, scenes: tourScenes(song.notes, song.duration), saved: api.snapshot(), scene: -1, t0: api.ctxTime() + LEAD_IN, raf: 0, sync: null };
    api.post({ t: 'alloff' });
    api.post({ t: 'seq', notes: song.notes, delay: LEAD_IN });
    win.title.textContent = 'DEMO · ' + (song.composer ? song.composer + ' — ' : '') + (song.short || song.title);
    win.title.title = song.title;
    win.src.textContent = 'MIDI: ' + (song.license ? song.source.replace(/ \(mutopiaproject\.org\)/, '') + ' · ' + (song.license === 'Public Domain' ? 'public domain' : song.license) : song.source);
    win.el.style.display = 'block';
    api.ui.setDemoRunning(true);
    enterScene(0);
    st.raf = requestAnimationFrame(tick);
  }

  // Plays factory song number i (0 = the default demo, the Appassionata).
  function start(i) { return play(SONGS[Math.max(0, Math.min(SONGS.length - 1, i | 0))]); }

  // Plays a MIDI file chosen by the user (ArrayBuffer or Uint8Array).
  function startFile(bytes, fileName) {
    const m = WSReadMIDI(new Uint8Array(bytes));
    const notes = m.notes.filter(n => n.ch !== 9 && n.t < MAX_FILE_SECONDS);   // channel 10 = drums
    if (!notes.length) throw new Error('this MIDI file contains no playable notes');
    const t0 = notes[0].t, flat = [];
    for (const n of notes) flat.push(n.t - t0, Math.max(0.03, n.d), n.note, n.vel / 127);
    let duration = 0;
    for (const n of notes) duration = Math.max(duration, n.t - t0 + n.d);
    const name = String(fileName || 'MIDI file').replace(/\.(mid|midi)$/i, '');
    return play({ title: m.title || name, composer: '', source: 'your file ' + (fileName || ''), license: '', duration, notes: flat });
  }

  function stop() {
    if (!st) return;
    cancelAnimationFrame(st.raf);
    api.post({ t: 'seqstop' });
    const saved = st.saved;
    st = null;
    api.ui.setDemoRunning(false);
    if (win) win.el.style.display = 'none';
    api.restore(saved);
  }

  function onSeqTime(seqTime) {
    if (!st) return;
    if (seqTime >= 0) st.sync = { seq: seqTime, at: performance.now() };
    else if (st.sync) {   // the sequence has ended: continue on the AudioContext clock
      st.t0 = api.ctxTime() - (st.sync.seq + Math.min(0.12, (performance.now() - st.sync.at) / 1000));
      st.sync = null;
    }
  }

  return {
    start, startFile, stop, onSeqTime,
    running: () => !!st,
    tourPlan: (i) => { const s = SONGS[i]; return s ? tourScenes(s.notes, s.duration).map(x => ({ t: x.t, preset: x.preset })) : null; },
    songs: () => SONGS.map((s, i) => ({ title: s.title, short: s.short || s.title, composer: s.composer, duration: s.duration, license: s.license, tour: i === 0 })),
    state: () => (st ? { running: true, song: st.song.title, scene: st.scene, preset: st.scenes[Math.max(0, st.scene)].preset,
      scenes: st.scenes.length, time: now() } : { running: false }),
  };
}
