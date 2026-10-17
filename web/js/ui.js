// Copyright (C) 2026 Pierre Arnaud GUYOT (OktoPierre)
// SPDX-License-Identifier: GPL-3.0-or-later
// FM Wavelet Synthesizer — created by Pierre Arnaud GUYOT (OktoPierre).
// Panel UI built from WS_SPEC (framework of the Wavelet Synthesizer: knobs, selectors, keyboard, preset menu, demo).
'use strict';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
const KB_LO = 24, KB_HI = 96;   // C1..C7 on the wide keyboard
const isBlack = n => [1, 3, 6, 8, 10].includes(n % 12);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, cls, parent, style) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  if (parent) parent.appendChild(e);
  return e;
}
function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
// angle 0 = 12 o'clock, clockwise
function arcPath(cx, cy, r, a0, a1) {
  if (Math.abs(a1 - a0) < 1e-4) return '';
  const x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0), x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0, sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} ${sweep} ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

function pill(ctx, text, x, y, align, color) {
  ctx.font = '600 9.5px Segoe UI, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 8, x0 = align === 'right' ? x - w + 4 : x - 4;
  ctx.fillStyle = 'rgba(12,15,19,0.78)';
  ctx.fillRect(x0, y - 10, w, 14);
  ctx.fillStyle = color; ctx.textAlign = 'left';
  ctx.fillText(text, x0 + 4, y);
}

class SynthUI {
  constructor(device, SPEC, C, host) {
    this.dev = device; this.SPEC = SPEC; this.C = C; this.host = host;
    this.P = C.P; this.params = SPEC.PARAMS;
    this.byParam = new Map();   // param index -> [widget]
    this.canvases = [];
    this.sections = [];
    this.scale = 1;
    this.live = null;
    this.tip = el('div', 'tip', document.body, { display: 'none' });
    this.cycle = new Float64Array(C.N);
    this.view = { frame: -1 };   // the sound shown by the scope and the scalogram (computed once per frame)
    this.frameNo = 0;
    this.mouseNotes = new Map();
    this.build();
    window.addEventListener('resize', () => this.fit());
    this.fit();
    const loop = () => { this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ building
  build() {
    for (const s of this.SPEC.SECTIONS) {
      const card = s.title !== '';
      const se = el('div', 'section' + (card ? ' card' : ''), this.dev, { left: s.x + 'px', top: s.y + 'px', width: s.w + 'px', height: s.h + 'px' });
      if (card) {
        const t = el('div', 'title', se);
        const parts = s.title.split(' · ');
        t.innerHTML = parts.length > 1 ? `<b>${parts[0]}</b> · ${parts.slice(1).join(' · ')}` : s.title;
      }
      this.sections.push({ spec: s, el: se });
      for (const w of s.widgets) this.makeWidget(w, se, s);
    }
  }

  reg(param, widget) {
    if (param == null) return;
    const i = this.P[param];
    if (!this.byParam.has(i)) this.byParam.set(i, []);
    this.byParam.get(i).push(widget);
    // right-click: MIDI learn (link a knob or fader of a MIDI controller to this control)
    if (widget.el && this.host.midiLearn) widget.el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.host.midiLearn(i); });
  }

  // Shows the MIDI CC linked to each control in its tooltip. map: { cc: paramKey }
  setMidiMap(map) {
    const ccOf = {};
    for (const cc of Object.keys(map)) ccOf[map[cc]] = cc;
    for (const [i, list] of this.byParam) for (const w of list) {
      if (!w.el) continue;
      if (w.baseTitle === undefined) w.baseTitle = w.el.title || this.params[i].name;
      const cc = ccOf[this.params[i].key];
      w.el.title = w.baseTitle + (cc !== undefined ? ` — MIDI CC ${cc} (right-click to change)` : ' — right-click for MIDI learn');
    }
  }

  makeWidget(w, parent, sec) {
    const box = el('div', 'w ' + w.type, parent, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' });
    const ab = { x: sec.x + w.x, y: sec.y + w.y };
    switch (w.type) {
      case 'knobL': case 'knobM': case 'knobS': case 'knobT': return this.knob(w, box);
      case 'seg': return this.seg(w, box);
      case 'step': return this.step(w, box);
      case 'logo': return this.logo(box);
      case 'presets': return this.presets(box);
      case 'credit': {
        const A = this.SPEC.APP;
        box.textContent = `${A.credit} · ${A.version} · ${A.license}`;
        box.title = `${A.name} — ${A.copyright}. Free software under the GNU General Public License v3 or later, WITHOUT ANY WARRANTY (see the LICENSE file).`;
        return;
      }
      default: return this.canvasWidget(w, box, ab);
    }
  }

  // ------------------------------------------------------------------ knob
  knob(w, box) {
    const i = this.P[w.param], p = this.params[i];
    const big = w.type === 'knobL', small = w.type === 'knobS', tiny = w.type === 'knobT';
    const d = big ? 56 : small ? 30 : tiny ? 26 : 38, cx = w.w / 2, cy = big ? 32 : small ? 18 : tiny ? 15 : 20, r = d / 2;
    box.classList.add('knob');
    box.title = p.name;
    const s = svg('svg', { width: w.w, height: w.h }, box);
    const id = 'kg' + i + w.type;
    const defs = svg('defs', {}, s);
    const grad = svg('radialGradient', { id, cx: '35%', cy: '30%', r: '75%' }, defs);
    svg('stop', { offset: '0%', 'stop-color': '#3a414c' }, grad);
    svg('stop', { offset: '100%', 'stop-color': '#161a1f' }, grad);
    const thin = small || tiny, A0 = -0.75 * Math.PI, A1 = 0.75 * Math.PI, ar = r + (thin ? 2 : 4);
    svg('path', { d: arcPath(cx, cy, ar, A0, A1), stroke: '#2a303a', 'stroke-width': thin ? 2.5 : 3, fill: 'none', 'stroke-linecap': 'round' }, s);
    const val = svg('path', { d: '', stroke: 'var(--accent)', 'stroke-width': thin ? 2.5 : 3, fill: 'none', 'stroke-linecap': 'round' }, s);
    svg('circle', { cx, cy, r: r - 1, fill: `url(#${id})`, stroke: '#0b0d10', 'stroke-width': 1.5 }, s);
    svg('circle', { cx, cy, r: r - 4, fill: 'none', stroke: 'rgba(255,255,255,0.05)', 'stroke-width': 1 }, s);
    const ptr = svg('line', { x1: cx, y1: cy - r * 0.25, x2: cx, y2: cy - r + 4, stroke: '#eef2f7', 'stroke-width': big ? 3 : tiny ? 2 : 2.2, 'stroke-linecap': 'round' }, s);
    let label = null;
    if (!small) {
      label = el('div', 'label', box, { top: (big ? 70 : tiny ? 33 : 43) + 'px', fontSize: big ? '10.5px' : tiny ? '8.5px' : '' });
      label.textContent = p.short;
    }
    const bip = p.min < 0 && p.max > 0;
    const widget = {
      w, p, i, el: box,
      update: () => {
        const v = this.host.get(i), n = this.C.toNorm(p, v);
        const a = A0 + (A1 - A0) * n;
        const from = bip ? A0 + (A1 - A0) * this.C.toNorm(p, 0) : A0;
        val.setAttribute('d', arcPath(cx, cy, ar, Math.min(from, a), Math.max(from, a)));
        ptr.setAttribute('transform', `rotate(${(a * 180 / Math.PI).toFixed(2)} ${cx} ${cy})`);
        if (label) {
          const showVal = widget.hover || widget.drag;
          label.textContent = showVal ? this.C.format(p, v) : p.short;
          label.classList.toggle('value', !!showVal);
        }
        if (small && (widget.hover || widget.drag)) this.showTip(box, `${p.name}: <b>${this.C.format(p, v)}</b>`);
      },
    };
    this.dragBehaviour(box, widget, i, p, 180);
    this.reg(w.param, widget);
    widget.update();
  }

  // vertical drag, wheel and double-click shared by knobs and drawbars
  dragBehaviour(box, widget, i, p, range) {
    const stepped = p.curve === 'int' || p.curve === 'choice';
    box.addEventListener('pointerenter', () => { widget.hover = true; widget.update(); });
    box.addEventListener('pointerleave', () => { widget.hover = false; if (!widget.drag) this.hideTip(); widget.update(); });
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { this.host.begin(i); this.host.set(i, p.def); this.host.end(i); return; }   // Ctrl+click = default
      box.setPointerCapture(e.pointerId);
      widget.drag = { y: e.clientY, n: this.C.toNorm(p, this.host.get(i)), shift: e.shiftKey };
      box.classList.add('active');
      this.host.begin(i);
      widget.update();
    });
    box.addEventListener('pointermove', (e) => {
      if (!widget.drag) return;
      const dy = (e.clientY - widget.drag.y) / this.scale;
      const sens = e.shiftKey ? range * 5 : range;
      let n = clamp(widget.drag.n - dy / sens, 0, 1);
      if (e.shiftKey !== widget.drag.shift) { widget.drag = { y: e.clientY, n: this.C.toNorm(p, this.host.get(i)), shift: e.shiftKey }; return; }
      const v = this.C.toPlain(p, n);
      if (v !== this.host.get(i)) this.host.set(i, v);
    });
    const end = (e) => {
      if (!widget.drag) return;
      widget.drag = null;
      box.classList.remove('active');
      try { box.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      this.host.end(i);
      if (!widget.hover) this.hideTip();
      widget.update();
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('dblclick', () => { this.host.begin(i); this.host.set(i, p.def); this.host.end(i); });
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const cur = this.host.get(i);
      let v;
      if (stepped) v = clamp(Math.round(cur) + dir, p.min, p.max);
      else v = this.C.toPlain(p, clamp(this.C.toNorm(p, cur) + dir * (e.shiftKey ? 0.002 : 0.01), 0, 1));
      this.host.begin(i); this.host.set(i, v); this.host.end(i);
    }, { passive: false });
  }

  // ------------------------------------------------------------------ selectors
  seg(w, box) {
    const i = this.P[w.param], p = this.params[i];
    box.classList.add('seg');
    if (w.style === 'engine') box.classList.add('engine');
    const btns = p.choiceShort.map((label, k) => {
      const b = el('button', '', box);
      b.textContent = label;
      b.title = p.name + ': ' + p.choices[k];
      b.onclick = () => { this.host.begin(i); this.host.set(i, k); this.host.end(i); };
      return b;
    });
    const widget = { w, p, i, el: box, update: () => { const v = Math.round(this.host.get(i)); btns.forEach((b, k) => b.classList.toggle('on', k === v)); } };
    this.reg(w.param, widget);
    widget.update();
  }

  step(w, box) {
    const i = this.P[w.param], p = this.params[i];
    box.classList.add('step');
    const prev = el('button', '', box); prev.textContent = '◀'; prev.title = 'Previous ' + p.name.toLowerCase();
    const name = el('div', 'name', box);
    const next = el('button', '', box); next.textContent = '▶'; next.title = 'Next ' + p.name.toLowerCase();
    const go = d => {
      const n = p.max - p.min + 1;
      const v = ((Math.round(this.host.get(i)) - p.min + d) % n + n) % n + p.min;
      this.host.begin(i); this.host.set(i, v); this.host.end(i);
    };
    prev.onclick = () => go(-1); next.onclick = () => go(1); name.onclick = () => go(1);
    name.title = p.name + ' (click to cycle)';
    const narrow = w.w < 200;
    const widget = { w, p, i, el: box, update: () => { const v = Math.round(this.host.get(i)); name.innerHTML = (narrow ? '' : `<small>${p.short}</small>`) + p.choices[v]; } };
    this.reg(w.param, widget);
    widget.update();
  }

  logo(box) {
    box.classList.add('logo');
    const mark = el('div', 'mark', box);
    mark.innerHTML = '<svg viewBox="0 0 32 32" width="24" height="24"><path d="M3 16h5l3-9 4 18 4-13 3 7h7" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    const t = el('div', 'txt', box);
    t.innerHTML = '<b>FM WAVELET</b><span>SYNTHESIZER</span>';
  }

  presets(box) {
    box.classList.add('presets');
    const prev = el('button', 'arrow', box); prev.textContent = '◀'; prev.title = 'Previous preset';
    const name = el('div', 'pname', box);
    const next = el('button', 'arrow', box); next.textContent = '▶'; next.title = 'Next preset';
    prev.onclick = () => this.host.presetStep(-1);
    next.onclick = () => this.host.presetStep(1);
    name.onclick = (e) => { e.stopPropagation(); this.togglePresetMenu(box); };
    this.presetNameEl = name;
    document.addEventListener('pointerdown', (e) => { if (this.pmenu && !this.pmenu.contains(e.target)) this.closePresetMenu(); });
  }
  setPresetName(nm, dirty) {
    if (this.presetNameEl) this.presetNameEl.innerHTML = `<span>${nm.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>${dirty ? '<span class="dirty" title="Modified">•</span>' : ''}<span class="chev">▼</span>`;
  }
  togglePresetMenu(box) {
    if (this.pmenu) { this.closePresetMenu(); return; }
    const m = el('div', 'pmenu', box);
    const list = this.host.presetList();
    // Groups fold like the banks of a hardware synth: favourites, user presets and the group of the current preset
    // start open; a click on a group title opens or closes it (remembered while the page is open).
    const cur = list.find(x => x.current);
    if (!this.openGroups) this.openGroups = new Set(['★ FAVOURITES', 'USER PRESETS']);
    if (cur) this.openGroups.add(cur.group);
    const counts = {};
    for (const x of list) counts[x.group] = (counts[x.group] || 0) + 1;
    let grp = null, body = m;
    list.forEach(item => {
      if (item.group !== grp) {
        grp = item.group;
        const g = grp, open = this.openGroups.has(g);
        const h = el('div', 'grp fold' + (open ? ' open' : ''), m);
        h.innerHTML = `<span class="tw">${open ? '▾' : '▸'}</span>${g.replace(/&/g, '&amp;')}<span class="cnt">${counts[g]}</span>`;
        body = el('div', 'gbody', m);
        if (!open) body.style.display = 'none';
        const b = body;
        h.onclick = (e) => {
          e.stopPropagation();
          const nowOpen = b.style.display === 'none';
          b.style.display = nowOpen ? '' : 'none';
          h.classList.toggle('open', nowOpen);
          h.firstChild.textContent = nowOpen ? '▾' : '▸';
          if (nowOpen) this.openGroups.add(g); else this.openGroups.delete(g);
        };
      }
      const it = el('div', 'it' + (item.current ? ' cur' : ''), body);
      const n = el('span', '', it);
      const mm = /^(AB|A|B) · (.*)$/.exec(item.name);   // engine letters in their colours (AB = both engines mixed)
      if (mm) {
        const e = el('b', 'eng', n);
        for (const ch of mm[1]) el('span', ch.toLowerCase(), e).textContent = ch;
        n.appendChild(document.createTextNode(mm[2]));
      } else n.textContent = item.name;
      if (item.deletable) {
        const d = el('span', 'del', it); d.textContent = '✕'; d.title = 'Delete user preset';
        d.onclick = (e) => { e.stopPropagation(); this.host.deletePreset(item.id); this.closePresetMenu(); };
      }
      it.onclick = () => { this.host.loadPreset(item.id); this.closePresetMenu(); };
    });
    this.pmenu = m;
    const c = m.querySelector('.it.cur');
    if (c && c.offsetTop + c.offsetHeight > m.clientHeight) m.scrollTop = c.offsetTop - m.clientHeight / 2;   // bring the current preset into view
  }
  closePresetMenu() { if (this.pmenu) { this.pmenu.remove(); this.pmenu = null; } }

  // ------------------------------------------------------------------ canvases
  canvasWidget(w, box, ab) {
    const screen = ['scope', 'scalogram', 'algo', 'opwave'].includes(w.type);
    if (screen) box.classList.add('screen');
    const cv = el('canvas', 'disp', box);
    const c = { w, box, cv, ctx: cv.getContext('2d'), ab, dirty: true };
    this.canvases.push(c);
    if (w.type === 'keyboard') this.keyboardInput(c);
    if (w.type === 'wheels') this.wheelInput(c);
  }

  sizeCanvases() {
    const pr = (window.devicePixelRatio || 1) * this.scale;
    for (const c of this.canvases) {
      const W = Math.round(c.w.w * pr), H = Math.round(c.w.h * pr);
      if (c.cv.width !== W || c.cv.height !== H) {
        c.cv.width = W; c.cv.height = H;
        c.cv.style.width = c.w.w + 'px'; c.cv.style.height = c.w.h + 'px';
      }
      c.pr = pr; c.dirty = true;
    }
  }

  fit() {
    const stage = this.dev.parentElement;
    const aw = stage.clientWidth - 24, ah = stage.clientHeight - 24;
    const D = this.SPEC.DEVICE, s = clamp(Math.min(aw / D.w, ah / D.h), 0.45, 2.5);
    this.scale = s;
    this.dev.style.transform = `scale(${s})`;
    this.dev.style.left = Math.max(0, (stage.clientWidth - D.w * s) / 2) + 'px';
    this.dev.style.top = Math.max(0, (stage.clientHeight - D.h * s) / 2) + 'px';
    this.sizeCanvases();
  }

  showTip(anchor, html) {
    const r = anchor.getBoundingClientRect();
    this.tip.innerHTML = html;
    this.tip.style.display = 'block';
    const tw = this.tip.offsetWidth;
    this.tip.style.left = clamp(r.left + r.width / 2 - tw / 2, 4, window.innerWidth - tw - 4) + 'px';
    this.tip.style.top = Math.max(4, r.top - 30) + 'px';
  }
  hideTip() { this.tip.style.display = 'none'; }

  // ------------------------------------------------------------------ state from app
  refresh(i) {
    const ws = this.byParam.get(i);
    if (ws) for (const w of ws) w.update();
    if (i === this.P.algo) this.updateRoles();
    for (const c of this.canvases) c.dirty = true;
  }
  refreshAll() {
    for (const [, ws] of this.byParam) for (const w of ws) w.update();
    this.updateRoles();
    for (const c of this.canvases) c.dirty = true;
  }
  // Operator section titles: "OPERATOR 2 · MODULATES 1" or "OPERATOR 1 · CARRIER" for the current algorithm.
  updateRoles() {
    const al = this.C.ALGOS[Math.round(this.host.get(this.P.algo))];
    for (const s of this.sections) {
      const m = /^op(\d)$/.exec(s.spec.id);
      if (!m) continue;
      const k = +m[1] - 1, targets = [];
      al.mod.forEach((list, t) => { if (list.includes(k)) targets.push(t + 1); });
      const role = al.isCar[k] ? 'CARRIER' : 'MODULATES ' + targets.join(', ');
      s.el.querySelector('.title').innerHTML = `<b>OPERATOR ${k + 1}</b> · ${role}`;
      s.el.classList.toggle('carrier', al.isCar[k]);
    }
  }
  setLive(d) { this.live = d; }

  // ------------------------------------------------------------------ demo support
  // Highlights the controls of the parameters being animated by the demo.
  setHot(ids) {
    for (const e of this.hotEls || []) e.classList.remove('hot');
    this.hotEls = [];
    for (const id of ids) for (const w of this.byParam.get(id) || []) if (w.el) { w.el.classList.add('hot'); this.hotEls.push(w.el); }
  }
  // DEMO split button: ▶ DEMO plays the default demo (first song), ▾ opens the list of songs.
  // d = { running, stop, songs, play(i), loadFile }
  makeDemoButton(d) {
    const b = el('button', 'hbtn demo-btn', this.dev);
    b.innerHTML = '&#9654; DEMO';
    b.title = 'Play the default demo: Beethoven, Appassionata (III), with a tour of the presets (a new preset about every 4 s, on a change of chord)';
    const arrow = el('button', 'hbtn demo-arrow', this.dev);
    arrow.innerHTML = '&#9662;';
    arrow.title = 'Choose another demo song or load your own MIDI file';
    const close = () => { if (this.dmenu) { this.dmenu.remove(); this.dmenu = null; } };
    b.onclick = (e) => {
      e.stopPropagation();
      close();
      if (d.running()) d.stop(); else d.play(0);
    };
    arrow.onclick = (e) => {
      e.stopPropagation();
      if (this.dmenu) { close(); return; }
      const m = el('div', 'pmenu demo-menu', this.dev);
      el('div', 'grp', m).textContent = 'DEMO SONGS · FREE MIDI (MUTOPIA PROJECT)';
      const mmss = s => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
      d.songs().forEach((s, i) => {
        const it = el('div', 'it', m);
        it.innerHTML = `<span>${s.composer} — <b>${(s.short || s.title).replace(/</g, '&lt;')}</b>${s.tour ? ' <i class="tag">DEFAULT</i>' : ''}</span><span class="dur">${mmss(s.duration)}</span>`;
        it.title = s.title + (s.license && s.license !== 'Public Domain' ? ` (MIDI licence: ${s.license})` : ' (public domain)') +
          (s.tour ? ' — default demo (▶ DEMO): a tour of the factory presets, a new one every 4 s' : '');
        it.onclick = () => { close(); d.play(i); };
      });
      el('div', 'sep', m);
      const ld = el('div', 'it', m);
      ld.innerHTML = '<span>Load a MIDI file…</span><span class="dur">.mid</span>';
      ld.title = 'Play your own MIDI file with the same parameter animations (drums on channel 10 are ignored)';
      ld.onclick = () => { close(); d.loadFile(); };
      this.dmenu = m;
    };
    document.addEventListener('pointerdown', (e) => { if (this.dmenu && !this.dmenu.contains(e.target) && e.target !== arrow) close(); });
    this.demoBtn = b;
  }
  setDemoRunning(on) {
    if (!this.demoBtn) return;
    this.demoBtn.classList.toggle('running', on);
    this.demoBtn.innerHTML = on ? '&#9632; STOP' : '&#9654; DEMO';
  }

  // ------------------------------------------------------------------ drawing
  frame() {
    this.frameNo++;
    for (const c of this.canvases) {
      const t = c.w.type;
      const animated = t === 'scope' || t === 'scalogram' || t === 'meter' || t === 'leds' || t === 'keyboard' || t === 'algo' || t === 'opwave';
      if (!c.dirty && !animated) continue;
      c.dirty = false;
      const ctx = c.ctx;
      ctx.setTransform(c.pr, 0, 0, c.pr, 0, 0);
      ctx.clearRect(0, 0, c.w.w, c.w.h);
      const fn = this['draw_' + t];
      if (fn) fn.call(this, ctx, c.w.w, c.w.h, c);
    }
  }

  accent() { return '#b38cff'; }
  accentRGB() { return [179, 140, 255]; }

  // The sound shown: one cycle at the operator levels of the voice playing (live), or at the LEVEL settings, and its
  // wavelet decomposition (with operator 1's wavelet). Computed once per frame for the scope and the scalogram.
  soundView() {
    const C = this.C, v = this.view;
    if (v.frame === this.frameNo) return v;
    const vals = this.host.values(), live = this.live;
    const playing = live && live.note >= 0 && live.lv;
    C.fmCycle(vals, playing ? live.lv : null, this.cycle);
    const wi = Math.round(vals[this.P.op1_wave]);
    v.frame = this.frameNo; v.y = this.cycle; v.note = playing ? live.note : -1;
    v.c = C.dwt(this.cycle, C.FILTERS[wi]); v.wavelet = this.SPEC.WAVELETS[wi].name;
    return v;
  }

  draw_scope(ctx, W, H) {
    const C = this.C, v = this.soundView(), y = v.y;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(W * k / 4 + 0.5, 4); ctx.lineTo(W * k / 4 + 0.5, H - 4); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath(); ctx.moveTo(0, H / 2 + 0.5); ctx.lineTo(W, H / 2 + 0.5); ctx.stroke();
    let peak = 0.25;
    for (let i = 0; i < C.N; i++) peak = Math.max(peak, Math.abs(y[i]));
    const sy = (H / 2 - 8) / peak;
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      const i = Math.min(C.N - 1, Math.floor(x / W * C.N)), yy = H / 2 - y[i] * sy;
      if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.strokeStyle = this.accent(); ctx.lineWidth = 2; ctx.shadowColor = this.accent(); ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    pill(ctx, v.note >= 0 ? 'ONE CYCLE · LIVE OPERATOR LEVELS' : 'ONE CYCLE · AT THE LEVEL SETTINGS', 8, 14, 'left', 'rgba(200,210,225,0.6)');
    if (v.note >= 0) pill(ctx, noteName(v.note) + ' · LIVE', W - 8, 14, 'right', this.accent());
  }

  draw_scalogram(ctx, W, H) {
    const C = this.C, v = this.soundView(), c = v.c;
    const lm = 26, pw = W - lm - 4, rh = (H - 6) / C.NB, top = 3;
    ctx.font = '600 8.5px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let b = 1; b <= C.NB; b++) { ctx.fillStyle = 'rgba(200,210,225,0.4)'; ctx.fillText('B' + b, lm - 5, top + (C.NB - b) * rh + rh / 2); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const [r0, g0, b0] = this.accentRGB();
    const col = (t) => {
      if (t <= 0) return null;
      if (t < 0.75) { const k = t / 0.75; return `rgb(${Math.round(18 + (r0 - 18) * k)},${Math.round(22 + (g0 - 22) * k)},${Math.round(28 + (b0 - 28) * k)})`; }
      const k = (t - 0.75) / 0.25;
      return `rgb(${Math.round(r0 + (255 - r0) * k)},${Math.round(g0 + (255 - g0) * k)},${Math.round(b0 + (255 - b0) * k)})`;
    };
    let ref = 1e-9;   // normalised to the strongest atom, so the picture shows the shape of the spectrum whatever the level
    for (let i = 1; i < C.N; i++) { const b = 31 - Math.clz32(i); ref = Math.max(ref, Math.abs(c[i]) * Math.pow(2, b / 2)); }
    for (let b = 1; b <= C.NB; b++) {
      const n = 1 << (b - 1), yy = top + (C.NB - b) * rh, sc = Math.pow(2, (b - 1) / 2) / ref;
      const val = k => { const x = Math.abs(c[n + k]) * sc; return x > 0 ? clamp((20 * Math.log10(x) + 60) / 60, 0, 1) : 0; };
      if (n <= pw) {
        const cw = pw / n, gap = cw >= 4 ? 1 : 0;
        for (let k = 0; k < n; k++) { const cc = col(val(k)); if (!cc) continue; ctx.fillStyle = cc; ctx.fillRect(lm + k * cw, yy + 0.5, Math.max(1, cw - gap), rh - 1); }
      } else {
        for (let x = 0; x < pw; x++) {
          const k0 = Math.floor(x / pw * n), k1 = Math.max(k0 + 1, Math.floor((x + 1) / pw * n));
          let t = 0; for (let k = k0; k < k1; k++) t = Math.max(t, val(k));
          const cc = col(t); if (!cc) continue; ctx.fillStyle = cc; ctx.fillRect(lm + x, yy + 0.5, 1, rh - 1);
        }
      }
    }
    pill(ctx, 'WAVELET BANDS OF THE CYCLE · ' + v.wavelet.toUpperCase(), W - 8, 13, 'right', 'rgba(200,210,225,0.6)');
  }

  // Algorithm diagram: operator boxes (carriers on the bottom row, modulators above what they modulate), arrows,
  // the feedback loop of operator 4; each box lights up with the operator's level while a note plays.
  draw_algo(ctx, W, H) {
    const P = this.P, a = Math.round(this.host.get(P.algo)), al = this.C.ALGOS[a];
    const POS = [[[1.5, 0], [1.5, 1], [1.5, 2], [1.5, 3]], [[1.5, 0], [1.5, 1], [1, 2], [2, 2]], [[1.5, 0], [1, 1], [1, 2], [2, 1]],
      [[1.5, 0], [1, 1], [2, 1], [2, 2]], [[1, 0], [1, 1], [2, 0], [2, 1]], [[0.5, 0], [1.5, 0], [2.5, 0], [1.5, 1]],
      [[0.5, 0], [1.5, 0], [2.5, 0], [2.5, 1]], [[0, 0], [1, 0], [2, 0], [3, 0]]][a];
    const bw = 44, bh = 20, colW = 64, rowH = 27, rows = Math.max(...POS.map(q => q[1]));
    const top = (H - (rows * rowH + bh + 16)) / 2, base = top + rows * rowH + bh / 2, busY = base + bh / 2 + 12.5;   // centred
    const X = c => W / 2 + (c - 1.5) * colW, Y = r => base - r * rowH;
    const live = this.live, playing = live && live.note >= 0 && live.lv;
    const [r0, g0, b0] = this.accentRGB();
    // output bus
    ctx.strokeStyle = 'rgba(200,210,225,0.35)'; ctx.lineWidth = 1.5;
    const xs = al.car.map(k => X(POS[k][0]));
    ctx.beginPath(); ctx.moveTo(Math.min(...xs), busY); ctx.lineTo(Math.max(...xs), busY); ctx.stroke();
    for (const x of xs) { ctx.beginPath(); ctx.moveTo(x, base + bh / 2); ctx.lineTo(x, busY); ctx.stroke(); }
    ctx.fillStyle = 'rgba(200,210,225,0.45)'; ctx.font = '700 8.5px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('OUT', Math.max(...xs) + 6, busY + 3);
    // modulation arrows
    ctx.strokeStyle = this.accent(); ctx.fillStyle = this.accent(); ctx.lineWidth = 1.6;
    al.mod.forEach((list, t) => list.forEach((j) => {
      const x0 = X(POS[j][0]), y0 = Y(POS[j][1]) + bh / 2, x1 = X(POS[t][0]), y1 = Y(POS[t][1]) - bh / 2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1 - 4); ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 6 * Math.cos(ang - 0.45), y1 - 6 * Math.sin(ang - 0.45));
      ctx.lineTo(x1 - 6 * Math.cos(ang + 0.45), y1 - 6 * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
    }));
    // feedback loop of operator 4
    const fbv = this.host.get(P.feedback), x4 = X(POS[3][0]) + bw / 2, y4 = Y(POS[3][1]);
    ctx.strokeStyle = fbv > 0 ? this.accent() : 'rgba(200,210,225,0.25)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x4, y4 + 4); ctx.lineTo(x4 + 9, y4 + 4); ctx.lineTo(x4 + 9, y4 - bh / 2 - 6);
    ctx.lineTo(x4 - bw / 2, y4 - bh / 2 - 6); ctx.lineTo(x4 - bw / 2, y4 - bh / 2); ctx.stroke();
    // operator boxes
    for (let k = 0; k < 4; k++) {
      const x = X(POS[k][0]) - bw / 2, y = Y(POS[k][1]) - bh / 2;
      const lv = playing ? clamp(live.lv[k], 0, 1) : clamp(this.host.get(P['op' + (k + 1) + '_level']), 0, 1);
      ctx.fillStyle = al.isCar[k] ? `rgba(${r0},${g0},${b0},${0.12 + 0.6 * lv})` : `rgba(220,226,235,${0.06 + 0.4 * lv})`;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = al.isCar[k] ? this.accent() : 'rgba(220,226,235,0.6)'; ctx.lineWidth = 1.2;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
      ctx.fillStyle = '#eef2f7'; ctx.font = '700 11px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(k + 1), x + bw / 2, y + 14);
    }
    ctx.textAlign = 'left';
    pill(ctx, al.car.length > 1 ? al.car.length + ' CARRIERS' : '1 CARRIER', 6, 13, 'left', 'rgba(200,210,225,0.55)');
  }

  // Operator display: one cycle of its wave (a wavelet atom), its frequency ratio, its role and its envelope.
  draw_opwave(ctx, W, H, c) {
    const C = this.C, P = this.P, k = c.w.op, o = 'op' + k + '_', vals = this.host.values();
    const al = C.ALGOS[Math.round(vals[P.algo])], car = al.isCar[k - 1];
    const x = C.opWave(Math.round(vals[P[o + 'wave']]));
    const live = this.live, playing = live && live.note >= 0 && live.lv;
    const lvl = playing ? clamp(live.lv[k - 1], 0, 1) : vals[P[o + 'level']];
    const ww = 104, mid = H / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(ww, mid + 0.5); ctx.stroke();
    ctx.beginPath();
    for (let px = 0; px <= ww; px++) {
      const i = Math.min(C.N - 1, Math.round(px / ww * (C.N - 1))), yy = mid - x[i] * (H / 2 - 6) * (0.25 + 0.75 * lvl);
      if (px) ctx.lineTo(px, yy); else ctx.moveTo(px, yy);
    }
    ctx.strokeStyle = car ? this.accent() : '#dfe5ee'; ctx.lineWidth = 1.8; ctx.stroke();
    // envelope shape (log time) behind the text
    const a = vals[P[o + 'a']], d = vals[P[o + 'd']], s = vals[P[o + 's']], r = vals[P[o + 'r']];
    const f = t => 0.06 + Math.log10(1 + t * 100) / Math.log10(1001);
    const wa = f(a), wd = f(d), wr = f(r), hold = 0.35, tot = wa + wd + hold + wr, x0 = ww + 10, xw = W - x0 - 2;
    const X = v => x0 + v / tot * xw, Y = v => H - 3 - v * (H - 8);
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(wa), Y(1));
    for (let q = 1; q <= 12; q++) { const t = q / 12; ctx.lineTo(X(wa + wd * t), Y(s + (1 - s) * Math.pow(0.001, t))); }
    ctx.lineTo(X(wa + wd + hold), Y(s));
    for (let q = 1; q <= 12; q++) { const t = q / 12; ctx.lineTo(X(wa + wd + hold + wr * t), Y(s * Math.pow(0.001, t))); }
    ctx.lineTo(X(tot), Y(0)); ctx.closePath();
    const [r0, g0, b0] = this.accentRGB();
    ctx.fillStyle = `rgba(${r0},${g0},${b0},0.10)`; ctx.fill();
    // ratio and role
    ctx.fillStyle = '#eef2f7'; ctx.font = '700 15px Segoe UI, system-ui, sans-serif';
    const R = C.ratioOf(vals, k - 1);
    ctx.fillText('×' + (Math.abs(R - Math.round(R)) < 1e-9 ? String(R) : R.toFixed(2)), x0, 18);
    ctx.font = '700 8.5px Segoe UI, system-ui, sans-serif'; ctx.fillStyle = car ? this.accent() : 'rgba(200,210,225,0.6)';
    ctx.fillText(car ? 'CARRIER · HEARD' : 'MODULATOR', x0, 31);
  }

  draw_leds(ctx, W, H) {
    const live = this.live, mask = live ? live.voices : 0;
    const maxV = Math.round(this.host.get(this.P.v_voices));
    const step = (W - 10) / 15;
    for (let k = 0; k < 16; k++) {
      const on = (mask >> k) & 1, avail = k < Math.max(1, maxV);
      ctx.beginPath(); ctx.arc(5 + k * step, 8.5, 4, 0, Math.PI * 2);
      ctx.fillStyle = on ? this.accent() : avail ? '#2a303a' : '#1a1e24';
      if (on) { ctx.shadowColor = this.accent(); ctx.shadowBlur = 8; }
      ctx.fill(); ctx.shadowBlur = 0;
    }
  }

  draw_fxheads(ctx) {
    ctx.font = '700 9px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center';
    const groups = [['SATURATION', 26, 52], ['PING-PONG DELAY', 78, 156], ['REVERB', 234, 104]];
    for (const [t, x, w] of groups) {
      ctx.fillStyle = 'rgba(200,210,225,0.42)'; ctx.fillText(t, x + w / 2, 12);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(x + 4, 17.5); ctx.lineTo(x + w - 4, 17.5); ctx.stroke();
    }
    ctx.textAlign = 'left';
  }

  draw_meter(ctx, W, H) {
    const live = this.live;
    this.mL = Math.max(live ? live.peakL : 0, (this.mL || 0) * 0.86);
    this.mR = Math.max(live ? live.peakR : 0, (this.mR || 0) * 0.86);
    const bw = (W - 2) / 2;
    [this.mL, this.mR].forEach((v, k) => {
      const db = 20 * Math.log10(v + 1e-9), t = clamp((db + 48) / 48, 0, 1);
      ctx.fillStyle = '#0c0f13'; ctx.fillRect(k * (bw + 2), 0, bw, H);
      const h = t * H;
      const grd = ctx.createLinearGradient(0, H, 0, 0);
      grd.addColorStop(0, '#b38cff'); grd.addColorStop(0.75, '#c8e86a'); grd.addColorStop(1, '#ff5d5d');
      ctx.fillStyle = grd; ctx.fillRect(k * (bw + 2), H - h, bw, h);
    });
  }

  draw_keyboard(ctx, W, H) {
    const whites = []; for (let n = KB_LO; n <= KB_HI; n++) if (!isBlack(n)) whites.push(n);
    const ww = W / whites.length, keys = this.host.keysDown();
    this.keyGeom = { ww, whites };
    whites.forEach((n, k) => {
      const x = k * ww, on = keys.has(n);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      if (on) { g.addColorStop(0, this.accent()); g.addColorStop(1, '#f3edff'); } else { g.addColorStop(0, '#d9dee5'); g.addColorStop(1, '#f6f8fa'); }
      ctx.fillStyle = g; ctx.fillRect(x + 0.5, 0, ww - 1, H);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x + 0.5, H - 3, ww - 1, 3);
      if (n % 12 === 0) { ctx.fillStyle = on ? '#0d1014' : '#7a8594'; ctx.font = '600 9px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(noteName(n), x + ww / 2, H - 8); ctx.textAlign = 'left'; }
    });
    const base = this.host.computerBase ? this.host.computerBase() : -1;
    if (base >= KB_LO && base <= KB_HI) {
      const k0 = whites.indexOf(base), k1 = whites.indexOf(Math.min(KB_HI, base + 16)) ;
      if (k0 >= 0) { const [r, g, b] = this.accentRGB(); ctx.fillStyle = `rgba(${r},${g},${b},0.6)`; ctx.fillRect(k0 * ww + 2, 0, ((k1 >= 0 ? k1 + 1 : whites.length) - k0) * ww - 4, 3); }
    }
    for (let n = KB_LO; n <= KB_HI; n++) {
      if (!isBlack(n)) continue;
      const k = whites.indexOf(n - 1), x = (k + 1) * ww - ww * 0.31, bw = ww * 0.62, bh = H * 0.6, on = keys.has(n);
      const g = ctx.createLinearGradient(0, 0, 0, bh);
      if (on) { g.addColorStop(0, this.accent()); g.addColorStop(1, '#4a2f7a'); } else { g.addColorStop(0, '#262b33'); g.addColorStop(1, '#0d0f12'); }
      ctx.fillStyle = g; ctx.fillRect(x, 0, bw, bh);
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x + 2, bh - 5, bw - 4, 3);
    }
  }

  keyAt(c, px, py) {
    const g = this.keyGeom; if (!g) return null;
    const H = c.w.h;
    if (py < H * 0.6) {
      for (let n = KB_LO; n <= KB_HI; n++) {
        if (!isBlack(n)) continue;
        const k = g.whites.indexOf(n - 1), x = (k + 1) * g.ww - g.ww * 0.31;
        if (px >= x && px <= x + g.ww * 0.62) return { n, vel: clamp(0.35 + 0.65 * py / (H * 0.6), 0.1, 1) };
      }
    }
    const k = clamp(Math.floor(px / g.ww), 0, g.whites.length - 1);
    return { n: g.whites[k], vel: clamp(0.35 + 0.65 * py / H, 0.1, 1) };
  }

  localPos(c, e) {
    const r = c.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  keyboardInput(c) {
    const cv = c.cv;
    cv.style.cursor = 'pointer';
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      const p = this.localPos(c, e), k = this.keyAt(c, p.x, p.y);
      if (!k) return;
      this.mouseNotes.set(e.pointerId, k.n);
      this.host.noteOn(k.n, k.vel);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.mouseNotes.has(e.pointerId)) return;
      const p = this.localPos(c, e), k = this.keyAt(c, clamp(p.x, 0, c.w.w - 1), clamp(p.y, 0, c.w.h - 1));
      const cur = this.mouseNotes.get(e.pointerId);
      if (k && k.n !== cur) { this.host.noteOff(cur); this.host.noteOn(k.n, k.vel); this.mouseNotes.set(e.pointerId, k.n); }
    });
    const up = (e) => { const n = this.mouseNotes.get(e.pointerId); if (n != null) { this.host.noteOff(n); this.mouseNotes.delete(e.pointerId); } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  draw_wheels(ctx, W, H) {
    const P = this.P, bend = this.host.get(P.bend), mod = this.host.get(P.modwheel);
    const ww = 24;
    [[0, (bend + 1) / 2, 'PITCH', true], [W - ww, mod, 'MOD', false]].forEach(([x, v, lab, center]) => {
      const h = H - 14;
      const g = ctx.createLinearGradient(x, 0, x + ww, 0);
      g.addColorStop(0, '#0b0d10'); g.addColorStop(0.5, '#1c2128'); g.addColorStop(1, '#0b0d10');
      ctx.fillStyle = g; ctx.fillRect(x, 0, ww, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let y = 4; y < h; y += 5) { ctx.beginPath(); ctx.moveTo(x + 3, y + 0.5); ctx.lineTo(x + ww - 3, y + 0.5); ctx.stroke(); }
      if (center) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, h / 2 - 0.5, ww, 1); }
      const yy = (1 - v) * (h - 8) + 4;
      ctx.fillStyle = this.accent(); ctx.shadowColor = this.accent(); ctx.shadowBlur = 8;
      ctx.fillRect(x + 2, yy - 2, ww - 4, 4); ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(200,210,225,0.45)'; ctx.font = '700 8px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(lab, x + ww / 2, H - 2); ctx.textAlign = 'left';
    });
  }

  wheelInput(c) {
    const cv = c.cv;
    cv.style.cursor = 'ns-resize';
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      const p = this.localPos(c, e);
      const which = p.x < c.w.w / 2 ? 'bend' : 'modwheel';
      cv.setPointerCapture(e.pointerId);
      drag = { which, y: p.y };
      move(e);
    });
    const move = (e) => {
      if (!drag) return;
      const p = this.localPos(c, e), h = c.w.h - 14;
      const v = clamp(1 - (p.y - 4) / (h - 8), 0, 1);
      this.host.set(this.P[drag.which], drag.which === 'bend' ? v * 2 - 1 : v);
    };
    cv.addEventListener('pointermove', move);
    const up = () => { if (drag && drag.which === 'bend') this.host.set(this.P.bend, 0); drag = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }
}
