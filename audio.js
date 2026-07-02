// Juicy Web Audio SFX engine — all synthesized (no files). Uses FM timbres,
// pitch-drop transients, detuned layers, filter-swept risers and a reverb tail
// so the sounds feel produced, not like plain beeps. Exposed as a global `SFX`.
window.SFX = (function () {
  let ctx = null, master = null, comp = null, reverb = null;
  let volume = 0.5;

  function makeImpulse(dur, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 3;
      master.connect(comp);
      comp.connect(ctx.destination);
      reverb = ctx.createConvolver();
      reverb.buffer = makeImpulse(1.5, 2.4);
      const rg = ctx.createGain();
      rg.gain.value = 0.9;
      reverb.connect(rg);
      rg.connect(comp);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master) master.gain.value = volume;
  }

  // rich tone: osc (+ optional detuned twin, + optional FM) -> filter (w/ env) -> amp -> master (+ reverb send)
  function tone(o) {
    if (volume <= 0 || !ensure()) return;
    const t = ctx.currentTime + (o.when || 0);
    const dur = o.dur || 0.2;
    const peak = o.vol == null ? 0.35 : o.vol;
    const atk = o.atk == null ? 0.004 : o.atk;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(peak, t + atk);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let dest = amp;
    if (o.lp) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(o.lp, t);
      if (o.lpEnd) lp.frequency.exponentialRampToValueAtTime(Math.max(80, o.lpEnd), t + dur);
      lp.Q.value = o.q || 1;
      lp.connect(amp);
      dest = lp;
    }

    const startOsc = function (detune) {
      const osc = ctx.createOscillator();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.freq, t);
      if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t + (o.glideDur || dur));
      if (detune) osc.detune.value = detune;
      if (o.fm) { // simple FM for bell/metallic timbres
        const mod = ctx.createOscillator();
        const mg = ctx.createGain();
        mod.frequency.value = o.freq * o.fm.ratio;
        mg.gain.setValueAtTime(o.freq * o.fm.depth, t);
        mg.gain.exponentialRampToValueAtTime(o.freq * 0.01, t + dur);
        mod.connect(mg); mg.connect(osc.frequency);
        mod.start(t); mod.stop(t + dur + 0.05);
      }
      osc.connect(dest);
      osc.start(t); osc.stop(t + dur + 0.05);
    };
    startOsc(0);
    if (o.detune) startOsc(o.detune);

    amp.connect(master);
    if (o.rev) {
      const send = ctx.createGain();
      send.gain.value = o.rev;
      amp.connect(send); send.connect(reverb);
    }
  }

  // filtered noise (clicks, whooshes, risers). bp=true => bandpass sweep.
  function noise(o) {
    if (volume <= 0 || !ensure()) return;
    const t = ctx.currentTime + (o.when || 0);
    const dur = o.dur || 0.15;
    const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * dur)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = o.bp ? "bandpass" : "lowpass";
    filt.frequency.setValueAtTime(o.f || 1000, t);
    if (o.fEnd) filt.frequency.exponentialRampToValueAtTime(Math.max(60, o.fEnd), t + dur);
    filt.Q.value = o.q || 1;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(o.vol == null ? 0.3 : o.vol, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(amp); amp.connect(master);
    if (o.rev) { const s = ctx.createGain(); s.gain.value = o.rev; amp.connect(s); s.connect(reverb); }
    src.start(t); src.stop(t + dur + 0.02);
  }

  // perfects climb a major-pentatonic run, looping every 8 so it never gets shrill
  const SCALE = [0, 2, 4, 7, 9];
  function perfectFreq(combo) {
    const n = (Math.max(1, combo || 1) - 1) % 8;
    const idx = n % SCALE.length;
    const oct = Math.floor(n / SCALE.length);
    return 523 * Math.pow(2, (SCALE[idx] + oct * 12) / 12); // base C5
  }

  return {
    resume: ensure,
    setVolume: setVolume,
    getVolume: function () { return volume; },

    // crisp FM bell with a soft pitch-up snap + reverb tail
    perfect: function (combo) {
      const f = perfectFreq(combo);
      tone({ freq: f * 0.98, freqEnd: f, type: "sine", dur: 0.16, vol: 0.32, atk: 0.002, glideDur: 0.03, fm: { ratio: 2.0, depth: 0.8 }, lp: 7000, rev: 0.28 });
    },
    // punchy "thock": pitch-drop body + noise click
    slice: function () {
      tone({ freq: 240, freqEnd: 70, type: "triangle", dur: 0.12, vol: 0.34, glideDur: 0.08, lp: 1500 });
      noise({ dur: 0.05, f: 1800, fEnd: 300, vol: 0.2 });
    },
    // detuned saw sliding down through a closing filter
    miss: function () {
      tone({ freq: 360, freqEnd: 70, type: "sawtooth", dur: 0.5, vol: 0.26, detune: 9, glideDur: 0.45, lp: 1700, lpEnd: 260, q: 5, rev: 0.18 });
    },
    grow: function () {
      tone({ freq: 300, freqEnd: 1050, type: "triangle", dur: 0.32, vol: 0.34, glideDur: 0.3, lp: 7000, rev: 0.2 });
      tone({ freq: 600, freqEnd: 2100, type: "sine", dur: 0.3, vol: 0.12, glideDur: 0.3, when: 0.01 });
    },
    arm: function (positive) {
      const b = positive ? 470 : 360;
      tone({ freq: b, freqEnd: positive ? b * 1.7 : b * 0.6, type: "triangle", dur: 0.16, vol: 0.3, glideDur: 0.12, lp: 6500, rev: 0.16 });
      tone({ freq: positive ? b * 2 : b * 0.5, type: "sine", dur: 0.12, vol: 0.14, when: 0.06, rev: 0.14 });
    },
    // ascending/descending arpeggio blips (FM gives them sparkle)
    build: function (positive, step) {
      const s = step || 0;
      const f = 392 * Math.pow(2, (positive ? (s % 12) : -(s % 12)) / 12);
      tone({ freq: f, type: "triangle", dur: 0.07, vol: 0.15, fm: { ratio: 2, depth: 0.4 }, lp: 7500, rev: 0.1 });
    },
    // rocket launch: pitch riser + a noise sweep opening up
    launch: function (intensity) {
      const v = 0.2 + 0.32 * (intensity || 0);
      tone({ freq: 130, freqEnd: 1200, type: "sawtooth", dur: 0.55, vol: v, glideDur: 0.55, lp: 5000, rev: 0.2 });
      noise({ dur: 0.5, bp: true, f: 250, fEnd: 5500, q: 1.6, vol: v * 0.5, rev: 0.2 });
    },
    // bomb dive: pitch falls + a noise sweep closing down
    dive: function (intensity) {
      const v = 0.2 + 0.32 * (intensity || 0);
      tone({ freq: 820, freqEnd: 80, type: "sawtooth", dur: 0.55, vol: v, glideDur: 0.55, lp: 2600 });
      noise({ dur: 0.5, bp: true, f: 5500, fEnd: 260, q: 1.6, vol: v * 0.5 });
    },
    // build payoff: triumphant chord + sub (up) / heavy thud (down)
    boom: function (positive) {
      if (positive) {
        [523, 659, 784, 1047].forEach(function (f, k) { tone({ freq: f, type: "sine", dur: 0.6, vol: 0.26, when: k * 0.02, fm: { ratio: 2, depth: 0.25 }, lp: 8000, rev: 0.35 }); });
        tone({ freq: 92, freqEnd: 46, type: "sine", dur: 0.5, vol: 0.42, glideDur: 0.4, rev: 0.15 });
        noise({ dur: 0.1, f: 6000, fEnd: 2000, vol: 0.16 });
      } else {
        tone({ freq: 110, freqEnd: 38, type: "sawtooth", dur: 0.55, vol: 0.42, glideDur: 0.4, lp: 900, rev: 0.18 });
        noise({ dur: 0.3, f: 800, fEnd: 120, vol: 0.3 });
      }
    },
    // TNT crate slams onto the tower: heavy wooden/metal thud
    tntland: function () {
      tone({ freq: 150, freqEnd: 52, type: "sine", dur: 0.24, vol: 0.42, glideDur: 0.16, lp: 1200, rev: 0.1 });
      tone({ freq: 240, freqEnd: 90, type: "triangle", dur: 0.14, vol: 0.22, glideDur: 0.1, lp: 1800 });
      noise({ dur: 0.09, f: 900, fEnd: 200, vol: 0.3 });
    },
    // burning fuse sizzle — pitch/brightness climb toward the blast (pass 0..1)
    fuse: function (p) {
      p = p || 0;
      noise({ dur: 0.06, bp: true, f: 4200 + 4200 * p, q: 2.2, vol: 0.1 + 0.12 * p });
      tone({ freq: 1100 + 1400 * p, type: "square", dur: 0.035, vol: 0.05 + 0.06 * p, lp: 6500 });
    },
    // the big one: bright crack + punchy body + deep sub + rolling rumble tail
    explode: function (intensity) {
      const v = 0.6 + 0.4 * (intensity || 0);
      noise({ dur: 0.13, f: 8500, fEnd: 380, vol: 0.55 * v });                                   // initial crack
      tone({ freq: 190, freqEnd: 40, type: "sawtooth", dur: 0.55, vol: 0.5 * v, glideDur: 0.3, lp: 1500, lpEnd: 200, rev: 0.28 }); // body
      tone({ freq: 92, freqEnd: 26, type: "sine", dur: 0.8, vol: 0.6 * v, glideDur: 0.55, rev: 0.22 }); // deep sub
      noise({ dur: 0.7, f: 520, fEnd: 80, vol: 0.32 * v, rev: 0.35 });                             // rumble tail
      noise({ dur: 0.28, bp: true, f: 2700, fEnd: 650, q: 1.2, vol: 0.22 * v, when: 0.05 });       // debris crackle
    },
    save: function () {
      [523, 659, 784].forEach(function (f, k) { tone({ freq: f, type: "sine", dur: 0.28, vol: 0.34, when: k * 0.08, fm: { ratio: 2, depth: 0.35 }, lp: 7000, rev: 0.3 }); });
    },
    reset: function () {
      tone({ freq: 440, freqEnd: 55, type: "sawtooth", dur: 0.7, vol: 0.3, glideDur: 0.6, lp: 1500, lpEnd: 280, q: 3, rev: 0.2 });
      noise({ dur: 0.4, f: 1200, fEnd: 120, vol: 0.22 });
    },
    milestone: function () {
      [523, 659, 784, 1047, 1319].forEach(function (f, k) { tone({ freq: f, type: "sine", dur: 0.34, vol: 0.32, when: k * 0.07, fm: { ratio: 2, depth: 0.35 }, lp: 8000, rev: 0.35 }); });
    },
    tick: function (urgent) {
      if (urgent) tone({ freq: 940, freqEnd: 760, type: "square", dur: 0.08, vol: 0.26, lp: 3500 });
      else noise({ dur: 0.022, f: 4200, vol: 0.12 });
    },
    ui: function () {
      tone({ freq: 680, type: "sine", dur: 0.05, vol: 0.14 });
    },
    start: function () {
      [392, 523, 659, 784].forEach(function (f, k) { tone({ freq: f, type: "sine", dur: 0.24, vol: 0.34, when: k * 0.07, fm: { ratio: 2, depth: 0.3 }, lp: 7000, rev: 0.3 }); });
    },
  };
})();
