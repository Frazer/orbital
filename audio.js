// audio.js — Orbital's procedural music and sound effects.
// Everything is synthesised with the Web Audio API at runtime; there are no audio files.
//
//   OrbitalAudio.unlock()            call from a user gesture (click / keydown) before anything else
//   OrbitalAudio.startMusic('calm')  start a theme (see THEMES); no-op if it is already playing
//   OrbitalAudio.stopMusic()         fade the music out
//   OrbitalAudio.setIntensity(0..1)  >= 0.5 switches the music into "danger" mode
//   OrbitalAudio.setThrust(bool)     engine rumble on / off
//   OrbitalAudio.setBoost(bool)      booster roar on / off
//   OrbitalAudio.sfx.*               one-shot sound effects
//   OrbitalAudio.toggleMute()        persisted in localStorage
const OrbitalAudio = (() => {
  let ac = null;
  let master, musicBus, sfxBus, reverbSend, delaySend, delay;
  let noiseBuffer = null;
  let thrustGain = null, boostGain = null;
  let muted = localStorage.getItem('orbitalMuted') === '1';

  const MUSIC_LEVEL = 0.5;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const CHORD = { m: [0, 3, 7, 10], M: [0, 4, 7, 11] };   // minor 7 / major 7 voicings
  const PENT = [0, 3, 5, 7, 10];                            // minor pentatonic: every note fits every chord

  // Each theme: tempo, key (MIDI note of the tonic, octave 3), chord progression as
  // [semitones from the tonic, quality], and how loud each layer plays (0 = layer off).
  const THEMES = {
    ambient: { bpm: 70,  root: 50, prog: [[0,'m'],[-4,'M'],[-2,'M'],[-4,'M']], layers: { pad: 1,   arp: 0.5, bass: 0,   drums: 0,   lead: 0.5 }, sparse: true, buildBars: 0 },
    calm:    { bpm: 100, root: 57, prog: [[0,'m'],[-4,'M'],[3,'M'],[-2,'M']],  layers: { pad: 1,   arp: 0.8, bass: 0.9, drums: 0.7, lead: 0.8 } },   // Am F C G
    drive:   { bpm: 116, root: 50, prog: [[0,'m'],[-2,'M'],[-4,'M'],[-2,'M']], layers: { pad: 0.8, arp: 1,   bass: 1,   drums: 1,   lead: 1 } },     // Dm C Bb C
    epic:    { bpm: 120, root: 55, prog: [[-4,'M'],[-2,'M'],[0,'m'],[0,'m']],  layers: { pad: 1,   arp: 1,   bass: 1,   drums: 1,   lead: 1 } },     // Eb F Gm Gm
    tense:   { bpm: 126, root: 52, prog: [[0,'m'],[5,'m'],[-4,'M'],[-5,'M']],  layers: { pad: 0.7, arp: 1,   bass: 1,   drums: 1,   lead: 1 } },     // Em Am C B
    heat:    { bpm: 134, root: 48, prog: [[0,'m'],[-2,'M'],[-4,'M'],[-5,'M']], layers: { pad: 0.6, arp: 1,   bass: 1,   drums: 1,   lead: 1 } },     // Cm Bb Ab G
    deep:    { bpm: 124, root: 53, prog: [[0,'m'],[-4,'M'],[-2,'M'],[7,'m']],  layers: { pad: 1,   arp: 1,   bass: 1,   drums: 1,   lead: 1 } },     // Fm Db Eb Cm
    dusk:    { bpm: 92,  root: 47, prog: [[0,'m'],[-2,'M'],[-4,'M'],[5,'m']],  layers: { pad: 1,   arp: 0.7, bass: 0.8, drums: 0.6, lead: 0.9 } },   // Bm A G Em
    storm:   { bpm: 140, root: 50, prog: [[0,'m'],[-5,'M'],[-2,'M'],[-4,'M']], layers: { pad: 0.5, arp: 1,   bass: 1,   drums: 1,   lead: 1 } },     // Dm A C Bb
    void:    { bpm: 112, root: 46, prog: [[0,'m'],[3,'M'],[-2,'M'],[-4,'M']],  layers: { pad: 1,   arp: 0.9, bass: 1,   drums: 0.8, lead: 1 } },     // Bbm Db Ab Gb
  };

  // ---------------------------------------------------------------- graph
  function ensure() {
    if (ac) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ac = new AC();

    master = ac.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ac.destination);

    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 20; comp.ratio.value = 4;
    comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(master);

    musicBus = ac.createGain(); musicBus.gain.value = MUSIC_LEVEL; musicBus.connect(comp);
    sfxBus = ac.createGain();   sfxBus.gain.value = 0.8;           sfxBus.connect(comp);

    // Reverb: convolution with a generated decaying-noise impulse.
    const reverb = ac.createConvolver();
    reverb.buffer = makeImpulse(2.8, 2.5);
    const reverbOut = ac.createGain(); reverbOut.gain.value = 0.5;
    reverb.connect(reverbOut); reverbOut.connect(comp);
    reverbSend = ac.createGain(); reverbSend.connect(reverb);

    // Tempo-synced feedback delay (set per theme).
    delay = ac.createDelay(2.0); delay.delayTime.value = 0.4;
    const delayFilter = ac.createBiquadFilter(); delayFilter.type = 'lowpass'; delayFilter.frequency.value = 2500;
    const delayFeedback = ac.createGain(); delayFeedback.gain.value = 0.38;
    const delayOut = ac.createGain(); delayOut.gain.value = 0.5;
    delay.connect(delayFilter); delayFilter.connect(delayFeedback); delayFeedback.connect(delay);
    delayFilter.connect(delayOut); delayOut.connect(comp);
    delaySend = ac.createGain(); delaySend.connect(delay);

    noiseBuffer = makeNoise(2);
    makeEngineLoops();
    return true;
  }

  function makeImpulse(seconds, decay) {
    const rate = ac.sampleRate, len = Math.floor(rate * seconds);
    const buf = ac.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function makeNoise(seconds) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Looping noise beds for the engine; their gains are ramped by setThrust / setBoost.
  function makeEngineLoops() {
    const loop = (type, freq, q) => {
      const src = ac.createBufferSource(); src.buffer = noiseBuffer; src.loop = true;
      const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ac.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(sfxBus); src.start();
      return g;
    };
    thrustGain = loop('lowpass', 420, 0.7);
    boostGain = loop('bandpass', 900, 0.8);
    const sub = ac.createOscillator(); sub.type = 'sine'; sub.frequency.value = 48;
    const subGain = ac.createGain(); subGain.gain.value = 0.5;
    sub.connect(subGain); subGain.connect(boostGain); sub.start();
  }

  // ---------------------------------------------------------------- voices
  // One oscillator note with an attack / hold / release envelope and optional filter and sends.
  function tone({ type = 'sine', freq, t, dur, vol = 0.2, attack = 0.01, release = 0.1, dest,
                  detune = 0, filter = null, send = 0, delaySendAmt = 0, slideTo = null, slideTime = 0 }) {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.value = detune;
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + slideTime);

    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let node = osc;
    if (filter) {
      const f = ac.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.Q.value = filter.q || 1;
      f.frequency.setValueAtTime(filter.freq, t);
      if (filter.sweepTo) f.frequency.exponentialRampToValueAtTime(filter.sweepTo, t + (filter.sweepTime || dur));
      osc.connect(f); node = f;
    }
    node.connect(g); g.connect(dest);
    if (send) { const s = ac.createGain(); s.gain.value = send; g.connect(s); s.connect(reverbSend); }
    if (delaySendAmt) { const s = ac.createGain(); s.gain.value = delaySendAmt; g.connect(s); s.connect(delaySend); }
    osc.start(t); osc.stop(t + dur + 0.05);
    return osc;
  }

  function noise({ t, dur, vol = 0.2, filter, dest, send = 0, sweepTo = null }) {
    const src = ac.createBufferSource(); src.buffer = noiseBuffer; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = filter.type; f.Q.value = filter.q || 1;
    f.frequency.setValueAtTime(filter.freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    if (send) { const s = ac.createGain(); s.gain.value = send; g.connect(s); s.connect(reverbSend); }
    src.start(t); src.stop(t + dur + 0.05);
  }

  function kick(t, vol = 0.9) {
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ac.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.4);
    noise({ t, dur: 0.03, vol: 0.25 * vol, filter: { type: 'highpass', freq: 1500 }, dest: musicBus });
  }
  function snare(t, vol = 0.5) {
    noise({ t, dur: 0.18, vol, filter: { type: 'bandpass', freq: 1800, q: 0.8 }, dest: musicBus, send: 0.3 });
    tone({ type: 'triangle', freq: 190, t, dur: 0.12, vol: vol * 0.6, attack: 0.001, release: 0.1, dest: musicBus });
  }
  function hat(t, open = false, vol = 0.18) {
    noise({ t, dur: open ? 0.25 : 0.05, vol, filter: { type: 'highpass', freq: 7000 }, dest: musicBus });
  }
  function bassNote(t, f, dur, vol) {
    tone({ type: 'sawtooth', freq: f, t, dur, vol, attack: 0.005, release: 0.05, dest: musicBus,
           filter: { type: 'lowpass', freq: 1400, q: 4, sweepTo: 250, sweepTime: dur } });
    tone({ type: 'sine', freq: f, t, dur, vol: vol * 0.8, attack: 0.005, release: 0.05, dest: musicBus });
  }
  function padChord(t, freqs, dur, vol, hot) {
    for (const f of freqs) for (const d of [-8, 8]) {
      tone({ type: 'sawtooth', freq: f, t, dur, vol, attack: 0.5, release: 0.6, detune: d, dest: musicBus,
             filter: { type: 'lowpass', freq: hot ? 1800 : 700, q: 0.7 }, send: 0.6 });
    }
  }
  function arpNote(t, f, dur, vol) {
    tone({ type: 'square', freq: f, t, dur, vol, attack: 0.003, release: 0.04, dest: musicBus,
           filter: { type: 'lowpass', freq: 2600 }, delaySendAmt: 0.45, send: 0.15 });
  }
  function leadNote(t, f, dur, vol) {
    const o = tone({ type: 'triangle', freq: f, t, dur, vol, attack: 0.02, release: 0.1, dest: musicBus, delaySendAmt: 0.5, send: 0.35 });
    tone({ type: 'sawtooth', freq: f, t, dur, vol: vol * 0.25, attack: 0.02, release: 0.1, dest: musicBus,
           filter: { type: 'lowpass', freq: 1800 }, delaySendAmt: 0.5, send: 0.35 });
    const lfo = ac.createOscillator(); lfo.frequency.value = 5.5;
    const lg = ac.createGain(); lg.gain.value = 6;
    lfo.connect(lg); lg.connect(o.detune); lfo.start(t); lfo.stop(t + dur + 0.1);
  }

  // ---------------------------------------------------------------- music
  let theme = null, step = 0, nextTime = 0, timer = null, melody = null, intensity = 0;

  // A fresh melodic phrase on an eighth-note grid: a random walk over the minor pentatonic
  // that lands on a chord tone on the strong beats.
  function makeMelody(th) {
    const bars = th.prog.length * 2;
    const slots = bars * 8;
    const notes = new Array(slots).fill(null);
    const ext = [];
    for (let o = 0; o < 2; o++) for (const p of PENT) ext.push(p + 12 * o);
    ext.push(24);
    let idx = 3 + Math.floor(Math.random() * 4);
    for (let s = 0; s < slots; s++) {
      const beat = s % 8, bar = Math.floor(s / 8);
      const [cr, cq] = th.prog[bar % th.prog.length];
      const strong = beat === 0 || beat === 4;
      const density = strong ? 0.85 : (beat % 2 === 0 ? 0.55 : 0.3);
      if (Math.random() > density) continue;
      idx = Math.max(0, Math.min(ext.length - 1, idx + Math.floor(Math.random() * 5) - 2));
      if (strong) {
        const tones = CHORD[cq].slice(0, 3).map(i => ((cr + i) % 12 + 12) % 12);
        let best = idx, bestD = 99;
        for (let k = Math.max(0, idx - 2); k <= Math.min(ext.length - 1, idx + 2); k++) {
          if (tones.includes(ext[k] % 12) && Math.abs(k - idx) < bestD) { best = k; bestD = Math.abs(k - idx); }
        }
        idx = best;
      }
      const dur = (beat === 2 || beat === 6) && Math.random() < 0.4 ? 2 : 1;
      notes[s] = { semis: ext[idx], dur };
      if (dur === 2) s++;
    }
    return notes;
  }

  function playStep(step, t) {
    const th = theme, L = th.layers;
    const s16 = step % 16, bar = Math.floor(step / 16);
    const [cr, cq] = th.prog[bar % th.prog.length];
    const chord = CHORD[cq];
    const root = th.root;
    const dur16 = 60 / th.bpm / 4;
    const hot = intensity >= 0.5;
    const buildBars = th.buildBars === undefined ? 4 : th.buildBars;
    const drumsOn = L.drums > 0 && (bar >= buildBars || hot);
    const bassOn = L.bass > 0 && (bar >= buildBars / 2 || hot);
    const leadOn = L.lead > 0 && (bar >= buildBars * 2 || hot);

    if (drumsOn) {
      const kickOn = s16 === 0 || s16 === 8 || (s16 === 10 && (bar % 2 === 1 || hot)) || (s16 === 7 && hot);
      if (kickOn) kick(t, 0.9 * L.drums);
      if (s16 === 4 || s16 === 12) snare(t, 0.45 * L.drums);
      if (bar % 8 === 7 && s16 >= 12) snare(t, 0.2 + 0.06 * (s16 - 12));          // roll into the next phrase
      if (hot || s16 % 2 === 0) hat(t, s16 === 14 && bar % 2 === 1, (s16 % 4 === 0 ? 0.2 : 0.11) * L.drums);
    }
    if (bassOn && s16 % 2 === 0) {
      const pat = [0, 0, 0, 12, 0, 0, 12, 0];
      let n = root - 12 + cr; if (cr > 4) n -= 12;
      bassNote(t, mtof(n + pat[s16 / 2]), dur16 * 2 * 0.85, 0.3 * L.bass);
    }
    if (L.pad > 0 && s16 === 0) padChord(t, chord.map(i => mtof(root + cr + i)), dur16 * 16, 0.05 * L.pad, hot);
    if (L.arp > 0 && !(th.sparse && s16 % 2 === 1)) {
      const pat = (bar % 4 < 2) ? [0, 1, 2, 3, 2, 1, 0, 2] : [0, 2, 1, 3, 0, 1, 3, 2];
      const n = root + 12 + cr + chord[pat[s16 % 8]] + (hot ? 12 : 0);
      arpNote(t, mtof(n), dur16 * 0.9, (s16 % 4 === 0 ? 0.14 : 0.09) * L.arp);
    }
    if (leadOn && s16 % 2 === 0) {
      const slot = Math.floor(step / 2) % melody.length;
      if (slot === 0 && Math.random() < 0.6) melody = makeMelody(th);
      const n = melody[slot];
      if (n) leadNote(t, mtof(root + 12 + n.semis), dur16 * 2 * n.dur * 0.9, 0.12 * L.lead);
    }
  }

  function schedule() {
    if (!theme) return;
    const now = ac.currentTime;
    if (nextTime < now - 0.3) nextTime = now + 0.05;      // tab was hidden; skip ahead instead of bursting
    while (nextTime < now + 0.15) {
      playStep(step, nextTime);
      nextTime += 60 / theme.bpm / 4;
      step++;
    }
  }

  function startMusic(name) {
    if (!ensure() || !THEMES[name]) return;
    if (theme && theme.name === name) return;
    stopMusic(0.2);
    theme = Object.assign({ name }, THEMES[name]);
    delay.delayTime.setValueAtTime(60 / theme.bpm * 0.75, ac.currentTime);
    melody = makeMelody(theme);
    step = 0;
    nextTime = ac.currentTime + 0.1;
    timer = setInterval(schedule, 25);
    const g = musicBus.gain, t = ac.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(MUSIC_LEVEL, t + 1.0);
  }

  function stopMusic(fade = 0.4) {
    if (timer) { clearInterval(timer); timer = null; }
    theme = null;
    if (!ac) return;
    const g = musicBus.gain, t = ac.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(0.0001, t + fade);
  }

  function setIntensity(v) { intensity = v; }

  // ---------------------------------------------------------------- sfx
  function jingle(notes, dur = 0.12, type = 'square', vol = 0.15) {
    if (!ensure()) return;
    const t0 = ac.currentTime + 0.02;
    notes.forEach((n, i) => tone({ type, freq: mtof(n), t: t0 + i * dur, dur: dur * 2.5, vol, attack: 0.005, release: 0.2,
                                   dest: sfxBus, send: 0.4, delaySendAmt: 0.3 }));
  }

  const sfx = {
    collectOre(combo = 1) {
      if (!ensure()) return;
      const t = ac.currentTime;
      const n = 76 + PENT[(combo - 1) % PENT.length] + 12 * Math.min(1, Math.floor((combo - 1) / PENT.length));
      tone({ type: 'square', freq: mtof(n), t, dur: 0.07, vol: 0.28, attack: 0.002, release: 0.03, dest: sfxBus });
      tone({ type: 'square', freq: mtof(n + 7), t: t + 0.06, dur: 0.28, vol: 0.28, attack: 0.002, release: 0.22,
             dest: sfxBus, send: 0.3, delaySendAmt: 0.15 });
    },
    collectFuel() {
      if (!ensure()) return;
      const t = ac.currentTime;
      tone({ type: 'triangle', freq: 294, slideTo: 587, slideTime: 0.1, t, dur: 0.22, vol: 0.4, attack: 0.005, release: 0.15, dest: sfxBus, send: 0.2 });
      noise({ t, dur: 0.15, vol: 0.12, filter: { type: 'highpass', freq: 3000 }, dest: sfxBus });
    },
    crash() {
      if (!ensure()) return;
      const t = ac.currentTime;
      noise({ t, dur: 1.0, vol: 0.7, filter: { type: 'lowpass', freq: 2500, q: 0.5 }, sweepTo: 60, dest: sfxBus, send: 0.6 });
      tone({ type: 'sine', freq: 110, slideTo: 28, slideTime: 0.5, t, dur: 0.7, vol: 0.7, attack: 0.005, release: 0.5, dest: sfxBus });
      tone({ type: 'sawtooth', freq: 60, t, dur: 0.3, vol: 0.2, attack: 0.005, release: 0.2, dest: sfxBus, filter: { type: 'lowpass', freq: 200 } });
    },
    tick() {
      if (!ensure()) return;
      tone({ type: 'square', freq: 1500, t: ac.currentTime, dur: 0.04, vol: 0.2, attack: 0.002, release: 0.03, dest: sfxBus });
    },
    sizzle() {
      if (!ensure()) return;
      noise({ t: ac.currentTime, dur: 0.12, vol: 0.2, filter: { type: 'highpass', freq: 4000 }, dest: sfxBus });
    },
    respawn() {
      if (!ensure()) return;
      tone({ type: 'triangle', freq: 440, slideTo: 880, slideTime: 0.15, t: ac.currentTime, dur: 0.25, vol: 0.25, attack: 0.005, release: 0.15, dest: sfxBus, send: 0.3 });
    },
    select() {
      if (!ensure()) return;
      tone({ type: 'square', freq: 880, t: ac.currentTime, dur: 0.06, vol: 0.18, attack: 0.002, release: 0.04, dest: sfxBus });
    },
    warp() {   // the flight between star systems on the map
      if (!ensure()) return;
      const t = ac.currentTime;
      tone({ type: 'sawtooth', freq: 80, slideTo: 1200, slideTime: 1.4, t, dur: 1.8, vol: 0.16, attack: 0.15, release: 0.8,
             dest: sfxBus, send: 0.5, filter: { type: 'lowpass', freq: 1800, q: 2 } });
      noise({ t, dur: 2.0, vol: 0.22, filter: { type: 'bandpass', freq: 300, q: 1.2 }, sweepTo: 5000, dest: sfxBus, send: 0.4 });
    },
    arrive()        { jingle([79, 84, 88], 0.09, 'triangle', 0.16); },
    levelComplete() { jingle([72, 76, 79, 84, 79, 84, 88], 0.1, 'square', 0.14); },
    gameOver()      { jingle([64, 60, 57, 52], 0.28, 'triangle', 0.18); },
    win()           { jingle([67, 72, 76, 79, 84, 79, 84, 88, 91, 96], 0.12, 'square', 0.14); },
  };

  function setThrust(on) {
    if (!ac) return;
    thrustGain.gain.setTargetAtTime(on ? 0.45 : 0, ac.currentTime, on ? 0.04 : 0.1);
  }
  function setBoost(on) {
    if (!ac) return;
    boostGain.gain.setTargetAtTime(on ? 0.35 : 0, ac.currentTime, on ? 0.03 : 0.12);
  }

  function unlock() {
    if (!ensure()) return false;
    if (ac.state === 'suspended') ac.resume();
    return true;
  }
  function toggleMute() {
    muted = !muted;
    localStorage.setItem('orbitalMuted', muted ? '1' : '0');
    if (ac) master.gain.setTargetAtTime(muted ? 0 : 1, ac.currentTime, 0.02);
    return muted;
  }

  return { unlock, startMusic, stopMusic, setIntensity, setThrust, setBoost, toggleMute, isMuted: () => muted, sfx, THEMES };
})();
