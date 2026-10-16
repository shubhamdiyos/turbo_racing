// AAA sound system.
//
// Signal flow is a console, not a tangle: every voice lands on a category bus, the buses sum
// through a send to the space reverb, and a limiter is the only thing wired to the destination.
// That is what lets a coin run, an upshift and the announcer stack without clipping on a phone
// speaker, and it is what makes a mute a gain change instead of a pile of special cases.

const RIG_MODELS = {
  // lo/hi are the fundamental at idle and redline. tone is the body-resonance lowpass sweep.
  // air is the airflow band: intake hiss for the piston rigs, turbine whistle for the jet.
  car: {
    waveA: 'sawtooth', waveB: 'square', ratioB: 2.0, ratioSub: 0.5, levelSub: 0.5, levelB: 0.3,
    lo: 58, hi: 196, gearKick: 9, toneLo: 260, toneHi: 1750, toneQ: 5.2,
    airLo: 620, airHi: 2100, airQ: 1.4, airLevel: 0.045, level: 0.15, drive: 62, send: 0.16
  },
  truck: {
    waveA: 'square', waveB: 'sawtooth', ratioB: 1.0, ratioSub: 0.25, levelSub: 0.85, levelB: 0.5,
    lo: 32, hi: 118, gearKick: 6, toneLo: 150, toneHi: 900, toneQ: 7.5,
    airLo: 180, airHi: 720, airQ: 0.9, airLevel: 0.085, level: 0.19, drive: 110, send: 0.24
  },
  jet: {
    waveA: 'sawtooth', waveB: 'sine', ratioB: 1.5, ratioSub: 3.0, levelSub: 0.18, levelB: 0.22,
    lo: 150, hi: 330, gearKick: 18, toneLo: 900, toneHi: 3600, toneQ: 3.0,
    airLo: 1500, airHi: 4600, airQ: 2.6, airLevel: 0.13, level: 0.13, drive: 28, send: 0.34
  }
};

const BAR_ROOTS = [55.0, 55.0, 43.65, 49.0];      // A A F G, an octave under the arp
const ARP_NOTES = [220.0, 261.63, 329.63, 440.0, 392.0, 329.63, 293.66, 261.63];
const STEP = 60 / 126 / 4;                          // 126 BPM on a sixteenth-note grid

export class AAASoundSystem {
  constructor() {
    this.ctx = null;
    this.musicEnabled = true;
    this.sfxEnabled = true;
    this.voiceEnabled = true;
    this.hapticsEnabled = true;
    this.rpm = 0.2;
    this.gear = 1;
    this.lastGear = 1;
    this.isPlayingGetter = () => false;
    this.rigKey = null;
    this._paused = false;
    this._musicTarget = 0.5;
    this._sfxTarget = 0.9;
    this._engineTarget = 0.0001;
    this._step = 0;
    this._nextStepTime = 0;
    this._transport = null;
    this._intensity = 0;
  }

  get isPaused() { return this._paused; }
  // main.js assigns this as a plain flag in eight places; an accessor is what lets a pause ride
  // the buses down instead of muting one oscillator and leaving the soundtrack loud.
  set isPaused(v) {
    const on = !!v;
    if (on === this._paused) return;
    this._paused = on;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._setBus(this.musicBus, on ? 0.0001 : this._musicTarget, 0.12);
    this._setBus(this.sfxBus, on ? 0.0001 : this._sfxTarget, 0.05);
    this.engineGain.gain.setTargetAtTime(on ? 0.0001 : this._engineTarget, now, 0.08);
    if (on && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  applySettings(settings) {
    this.musicEnabled = settings.music !== false;
    this.sfxEnabled = settings.sfx !== false;
    this.voiceEnabled = settings.voice !== false;
    this.hapticsEnabled = settings.haptics !== false;
    if (!this.voiceEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    if (!this.ctx) return;
    this._musicTarget = this.musicEnabled ? 0.5 : 0.0001;
    this._sfxTarget = this.sfxEnabled ? 0.9 : 0.0001;
    const paused = this._paused;
    this._setBus(this.musicBus, paused ? 0.0001 : this._musicTarget, 0.05);
    this._setBus(this.sfxBus, paused ? 0.0001 : this._sfxTarget, 0.05);
    this.engineGain.gain.setTargetAtTime(paused || !this.sfxEnabled ? 0.0001 : this._engineTarget,
      this.ctx.currentTime, 0.05);
  }

  vibrate(pattern = 25) {
    if (!this.hapticsEnabled || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) { /* never fatal, and iOS has no vibration API */ }
  }

  init(isPlayingCallback) {
    if (isPlayingCallback) this.isPlayingGetter = isPlayingCallback;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    // iOS Safari / WKWebView Silent Buffer Unlock
    const unlock = this.ctx.createBufferSource();
    unlock.buffer = this.ctx.createBuffer(1, 1, 22050);
    unlock.connect(this.ctx.destination);
    unlock.start(0);

    this._musicTarget = this.musicEnabled ? 0.5 : 0.0001;
    this._sfxTarget = this.sfxEnabled ? 0.9 : 0.0001;
    this._noiseShort = this._makeNoise(0.5);
    this._noiseLong = this._makeNoise(1.4);
    this._buildMaster();
    this._buildReverb();
    this._buildEngine();
    this._startTransport();
  }

  _buildMaster() {
    // A limiter, not a compressor: fast enough that a crash transient never gets through as a
    // crack, slow enough that the score keeps its punch.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.22;
    this.limiter.connect(this.ctx.destination);

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.limiter);

    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.engineBus = this.ctx.createGain();
    this.musicBus.gain.value = this._musicTarget;
    this.sfxBus.gain.value = this._sfxTarget;
    this.engineBus.gain.value = 1;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.engineBus.connect(this.master);

    // Melodic voices sit behind this so the kick can pump the score, the way a real mix does.
    this.musicDuck = this.ctx.createGain();
    this.musicDuck.gain.value = 0.95;
    this.musicDuck.connect(this.musicBus);

    // One tone control over the whole score is the adaptive layer: it opens as the player speeds
    // up, instead of switching to a second soundtrack nobody asked for.
    this.musicTone = this.ctx.createBiquadFilter();
    this.musicTone.type = 'lowpass';
    this.musicTone.frequency.value = 1250;
    this.musicTone.Q.value = 0.7;
    this.musicTone.connect(this.musicDuck);
  }

  _buildReverb() {
    this.space = this.ctx.createConvolver();
    this.space.buffer = this._makeImpulse();
    this.spaceSend = this.ctx.createGain();
    this.spaceSend.gain.value = 0.5;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.34;
    this.spaceSend.connect(this.space);
    this.space.connect(wet);
    wet.connect(this.master);

    // A highpass ahead of the convolver stops the engine's sub from turning the street into a
    // rumble: reverb is for the tails you want to hear, not the low end.
    this.spaceTrim = this.ctx.createBiquadFilter();
    this.spaceTrim.type = 'highpass';
    this.spaceTrim.frequency.value = 260;
    this.spaceTrim.connect(this.spaceSend);

    // The score's leads are the one part with a stereo story, and they run eight to the bar, so
    // their send is a permanent node rather than a fresh gain per note.
    this.leadSend = this.ctx.createGain();
    this.leadSend.gain.value = 0.22;
    this.leadSend.connect(this.spaceTrim);
  }

  // The single way a voice reaches the mix: dry into its bus, a slice into the space, optionally
  // off-centre. No caller has to remember any of the three.
  _out(node, bus, send, pan = 0) {
    let tail = node;
    if (pan !== 0 && typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      tail = p;
    }
    tail.connect(bus);
    if (send > 0) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      tail.connect(s);
      s.connect(this.spaceTrim);
    }
    return tail;
  }

  _setBus(bus, value, timeConstant) {
    const now = this.ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setTargetAtTime(value, now, timeConstant);
  }

  _makeImpulse(seconds = 1.1, decay = 3.1) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const pre = Math.floor(rate * 0.011);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        // One-pole smoothed noise: a raw white tail sounds like fizz, and real spaces roll the
        // top end off as the sound ages.
        lp += (Math.random() * 2 - 1 - lp) * 0.3;
        d[i] = lp * Math.pow(1 - i / n, decay);
      }
      d.copyWithin(pre, 0, n - pre);          // first-reflection gap
      for (let i = 0; i < pre; i++) d[i] = 0;
    }
    return buf;
  }

  _makeNoise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _shaperCurve(amount) {
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  _buildEngine() {
    const rig = RIG_MODELS.car;

    // Three sources cover all three rigs: a saw for the body, a second wave for the harmonic
    // that defines the engine (2x burble for the V8, 1x for the truck, 1.5x whine for the jet)
    // and a sub for the weight you feel rather than hear.
    this.engA = this.ctx.createOscillator();
    this.engB = this.ctx.createOscillator();
    this.engSub = this.ctx.createOscillator();
    this.engA.type = rig.waveA;
    this.engB.type = rig.waveB;
    this.engSub.type = 'triangle';

    this.engBGain = this.ctx.createGain();
    this.engSubGain = this.ctx.createGain();
    this.engShaper = this.ctx.createWaveShaper();
    this.engShaper.curve = this._shaperCurve(rig.drive);
    this.engTone = this.ctx.createBiquadFilter();
    this.engTone.type = 'lowpass';
    this.engTone.Q.value = rig.toneQ;

    this.engA.connect(this.engShaper);
    this.engB.connect(this.engBGain);
    this.engBGain.connect(this.engShaper);
    this.engSub.connect(this.engSubGain);
    this.engSubGain.connect(this.engTone);
    this.engShaper.connect(this.engTone);

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engTone.connect(this.engineGain);
    this.engineGain.connect(this.engineBus);
    this.engineSend = this.ctx.createGain();
    this.engineSend.gain.value = rig.send;
    this.engineGain.connect(this.engineSend);
    this.engineSend.connect(this.spaceTrim);

    this.engAir = this.ctx.createBufferSource();
    this.engAir.buffer = this._noiseLong;
    this.engAir.loop = true;
    this.engAirBp = this.ctx.createBiquadFilter();
    this.engAirBp.type = 'bandpass';
    this.engAirBp.Q.value = rig.airQ;
    this.engAirGain = this.ctx.createGain();
    this.engAirGain.gain.value = 0.0001;
    this.engAir.connect(this.engAirBp);
    this.engAirBp.connect(this.engAirGain);
    this.engAirGain.connect(this.engineGain);

    const t = this.ctx.currentTime;
    this.engA.frequency.value = rig.lo;
    this.engB.frequency.value = rig.lo * rig.ratioB;
    this.engSub.frequency.value = rig.lo * rig.ratioSub;
    this.engBGain.gain.value = rig.levelB;
    this.engSubGain.gain.value = rig.levelSub;
    this.engTone.frequency.value = rig.toneLo;
    this.engAirBp.frequency.value = rig.airLo;
    this.engA.start(t);
    this.engB.start(t);
    this.engSub.start(t);
    this.engAir.start(t);
    this.rigKey = 'car';
  }

  _setRig(key) {
    if (key === this.rigKey) return;
    const rig = RIG_MODELS[key];
    if (!rig) return;
    const now = this.ctx.currentTime;
    this.rigKey = key;
    this.engA.type = rig.waveA;
    this.engB.type = rig.waveB;
    this.engShaper.curve = this._shaperCurve(rig.drive);
    this.engTone.Q.value = rig.toneQ;
    this.engBGain.gain.setTargetAtTime(rig.levelB, now, 0.1);
    this.engSubGain.gain.setTargetAtTime(rig.levelSub, now, 0.1);
    this.engAirBp.Q.value = rig.airQ;
    // Each rig lives in a different world, so each gets a different amount of street around it.
    this.engineSend.gain.setTargetAtTime(rig.send, now, 0.2);
  }

  updateEngine(speedRatio, isPlaying, isMorphed, morphType) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._setRig(isMorphed && RIG_MODELS[morphType] ? morphType : 'car');
    const rig = RIG_MODELS[this.rigKey];

    if (!this.sfxEnabled || this._paused) {
      this._engineTarget = 0.0001;
      this.engineGain.gain.setTargetAtTime(0.0001, now, 0.06);
      return;
    }

    const progress = Math.min(1, Math.max(0, (speedRatio - 0.78) / 0.82));
    this._intensity = progress;
    this.musicTone.frequency.setTargetAtTime(1250 + progress * 5200, now, 0.4);

    if (isPlaying) {
      const newGear = Math.min(5, Math.floor(progress * 5) + 1);
      if (newGear > this.lastGear) { this.lastGear = newGear; this._upshift(now); }
      this.gear = newGear;
      this.rpm = isMorphed ? 0.98 : ((progress * 5) % 1) * 0.75 + 0.25;
    } else {
      this.gear = 1;
      this.lastGear = 1;
      this.rpm = isMorphed ? 0.9 : 0.12 + Math.sin(now * 2.1) * 0.04;
    }

    const f = isPlaying
      ? rig.lo + this.rpm * (rig.hi - rig.lo) + this.gear * rig.gearKick
      : rig.lo * 0.82 + Math.sin(now * 6) * 2.5;

    this.engA.frequency.setTargetAtTime(f, now, 0.05);
    this.engB.frequency.setTargetAtTime(f * rig.ratioB, now, 0.05);
    this.engSub.frequency.setTargetAtTime(f * rig.ratioSub, now, 0.05);
    this.engTone.frequency.setTargetAtTime(rig.toneLo + this.rpm * (rig.toneHi - rig.toneLo), now, 0.06);
    this.engAirBp.frequency.setTargetAtTime(rig.airLo + this.rpm * (rig.airHi - rig.airLo), now, 0.06);

    const load = isPlaying ? 1 : 0.55;
    this._engineTarget = rig.level * (isMorphed ? 1.12 : 1) * load;
    this.engineGain.gain.setTargetAtTime(this._engineTarget, now, 0.08);
    // The jet's whistle has to be there at rest, so airflow tracks the band position, not just
    // the throttle.
    this.engAirGain.gain.setTargetAtTime(rig.airLevel * load * (0.4 + this.rpm * 0.6), now, 0.09);
  }

  // A pitch collapse plus a pressure pop: what you hear on a change is the gearbox, not the revs.
  _upshift(now) {
    this.triggerExhaustBackfire();
    if (!this.sfxEnabled) return;
    const rig = RIG_MODELS[this.rigKey];
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(rig.hi * 0.9, now);
    o.frequency.exponentialRampToValueAtTime(rig.lo * 0.7, now + 0.13);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.1, now);
    g.gain.exponentialRampToValueAtTime(0.004, now + 0.14);
    o.connect(g);
    this._out(g, this.sfxBus, 0.12);
    o.start(now);
    o.stop(now + 0.15);
  }

  triggerExhaustBackfire() {
    if (!this.ctx || !this.sfxEnabled || this._paused) return;
    [0, 0.07].forEach((delay, i) => {
      const at = this.ctx.currentTime + delay;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noiseShort;
      noise.playbackRate.value = 0.85 + i * 0.2;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 420 + Math.random() * 250;
      bp.Q.value = 1.6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3 - i * 0.06, at);
      g.gain.exponentialRampToValueAtTime(0.006, at + 0.07);
      noise.connect(bp);
      bp.connect(g);
      this._out(g, this.sfxBus, 0.2, (Math.random() - 0.5) * 0.5);
      noise.start(at);
      noise.stop(at + 0.08);
    });
  }

  playTireScreech() {
    if (!this.ctx || !this.sfxEnabled || this._paused) return;
    this.vibrate(15);
    const now = this.ctx.currentTime;
    const dur = 0.34;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseLong;
    noise.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1550, now);
    bp.frequency.linearRampToValueAtTime(2350, now + dur * 0.6);
    bp.frequency.linearRampToValueAtTime(1750, now + dur);
    bp.Q.value = 7;

    // A wobble on the squeal: a fixed pitch reads as a test tone, a moving one reads as rubber
    // slipping across a real surface.
    const wobble = this.ctx.createOscillator();
    wobble.frequency.value = 21;
    const wobbleAmt = this.ctx.createGain();
    wobbleAmt.gain.value = 190;
    wobble.connect(wobbleAmt);
    wobbleAmt.connect(bp.frequency);

    const hiss = this.ctx.createBiquadFilter();
    hiss.type = 'highpass';
    hiss.frequency.value = 3400;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.17, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.008, now + dur);

    noise.connect(bp);
    bp.connect(g);
    noise.connect(hiss);
    hiss.connect(g);
    this._out(g, this.sfxBus, 0.26, (Math.random() - 0.5) * 0.7);
    noise.start(now);
    noise.stop(now + dur + 0.02);
    wobble.start(now);
    wobble.stop(now + dur);

    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(96, now);
    sub.frequency.exponentialRampToValueAtTime(62, now + 0.18);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.07, now);
    sg.gain.exponentialRampToValueAtTime(0.004, now + 0.2);
    sub.connect(sg);
    this._out(sg, this.sfxBus, 0);
    sub.start(now);
    sub.stop(now + 0.21);
  }

  playJumpWhoosh() {
    if (!this.ctx || !this.sfxEnabled || this._paused) return;
    this.vibrate(20);
    const now = this.ctx.currentTime;
    const dur = 0.4;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseLong;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(320, now);
    bp.frequency.exponentialRampToValueAtTime(2600, now + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(700, now + dur);
    bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.2, now + 0.08);
    g.gain.exponentialRampToValueAtTime(0.006, now + dur);
    noise.connect(bp);
    bp.connect(g);
    this._out(g, this.sfxBus, 0.4);
    noise.start(now);
    noise.stop(now + dur + 0.02);

    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, now);
    o.frequency.exponentialRampToValueAtTime(760, now + 0.24);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.12, now);
    og.gain.exponentialRampToValueAtTime(0.004, now + 0.26);
    o.connect(og);
    this._out(og, this.sfxBus, 0.25);
    o.start(now);
    o.stop(now + 0.27);
  }

  playCoinChime(comboIndex) {
    if (!this.ctx || !this.sfxEnabled || this._paused) return;
    this.vibrate(10);
    const idx = Math.max(0, comboIndex | 0);
    const notes = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.5];
    const freq = notes[idx % notes.length];
    const now = this.ctx.currentTime;
    // Coins arrive in runs, so they fan across the stereo field and read as a stream of pickups
    // instead of one tone repeated.
    const pan = ((idx % 3) - 1) * 0.45;

    [[freq, 'sine', 0.17, 0.19], [freq * 1.5, 'triangle', 0.075, 0.13], [freq * 2, 'sine', 0.035, 0.09]]
      .forEach(([f, type, level, decay]) => {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f, now);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(level, now);
        g.gain.exponentialRampToValueAtTime(0.004, now + decay);
        o.connect(g);
        this._out(g, this.sfxBus, 0.3, pan);
        o.start(now);
        o.stop(now + decay + 0.01);
      });
  }

  playMorphPowerup() {
    this.vibrate([40, 30, 60]);
    if (!this.ctx || !this.sfxEnabled || this._paused) { this.speakAnnouncer('MEGA MORPH!'); return; }
    const now = this.ctx.currentTime;

    // Riser into the fanfare, so the transform has a lead-in instead of arriving all at once.
    const riser = this.ctx.createOscillator();
    riser.type = 'sawtooth';
    riser.frequency.setValueAtTime(180, now);
    riser.frequency.exponentialRampToValueAtTime(900, now + 0.42);
    const rp = this.ctx.createBiquadFilter();
    rp.type = 'lowpass';
    rp.frequency.setValueAtTime(700, now);
    rp.frequency.exponentialRampToValueAtTime(4200, now + 0.42);
    rp.Q.value = 4;
    const rg = this.ctx.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.linearRampToValueAtTime(0.14, now + 0.34);
    rg.gain.exponentialRampToValueAtTime(0.006, now + 0.46);
    riser.connect(rp);
    rp.connect(rg);
    this._out(rg, this.sfxBus, 0.4);
    riser.start(now);
    riser.stop(now + 0.47);

    [261.6, 329.6, 392.0, 523.2, 659.2].forEach((f, i) => {
      const at = now + 0.34 + i * 0.05;
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(f * 1.5, at + 0.25);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.11, at);
      g.gain.exponentialRampToValueAtTime(0.006, at + 0.25);
      o.connect(g);
      this._out(g, this.sfxBus, 0.3);
      o.start(at);
      o.stop(at + 0.26);
    });

    this.speakAnnouncer('MEGA MORPH!');
  }

  playCrashImpact() {
    this.vibrate([80, 40, 120]);
    if (!this.ctx || !this.sfxEnabled || this._paused) return;
    const now = this.ctx.currentTime;

    // Three registers, because an impact is felt, heard and noticed: a sub thump, a debris bed
    // and one bright metal transient to cut through everything else.
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(104, now);
    sub.frequency.exponentialRampToValueAtTime(34, now + 0.36);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.62, now);
    sg.gain.exponentialRampToValueAtTime(0.005, now + 0.42);
    sub.connect(sg);
    this._out(sg, this.sfxBus, 0);
    sub.start(now);
    sub.stop(now + 0.43);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseLong;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, now);
    lp.frequency.exponentialRampToValueAtTime(220, now + 0.45);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.42, now);
    ng.gain.exponentialRampToValueAtTime(0.006, now + 0.5);
    noise.connect(lp);
    lp.connect(ng);
    this._out(ng, this.sfxBus, 0.55, (Math.random() - 0.5) * 0.8);
    noise.start(now);
    noise.stop(now + 0.52);

    const ring = this.ctx.createBufferSource();
    ring.buffer = this._noiseShort;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2900;
    bp.Q.value = 2.2;
    const bg = this.ctx.createGain();
    bg.gain.setValueAtTime(0.2, now);
    bg.gain.exponentialRampToValueAtTime(0.004, now + 0.2);
    ring.connect(bp);
    bp.connect(bg);
    this._out(bg, this.sfxBus, 0.7, (Math.random() - 0.5) * 0.9);
    ring.start(now);
    ring.stop(now + 0.22);

    this._duckMusic(0.5, 0.6);
  }

  // The announcer is OS text-to-speech and never passes through this graph, so the only way to
  // give a callout headroom is to pull the score down underneath it.
  _duckMusic(level, seconds) {
    if (!this.ctx || !this.musicEnabled) return;
    const now = this.ctx.currentTime;
    const target = this._paused ? 0.0001 : this._musicTarget;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setTargetAtTime(target * level, now, 0.05);
    this.musicBus.gain.setTargetAtTime(target, now + seconds, 0.3);
  }

  speakAnnouncer(text) {
    if (!this.voiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    // Lower and slower than a speech default: a PA callout, not a cartoon voice.
    u.rate = 1.04;
    u.pitch = 0.78;
    u.volume = 1;
    // TTS length is unknowable from JS, so the release is a floor scaled by the line, not a guess.
    this._duckMusic(0.34, Math.max(1.1, text.length * 0.085));
    window.speechSynthesis.speak(u);
  }

  _startTransport() {
    this._nextStepTime = this.ctx.currentTime + 0.1;
    this._transport = setInterval(() => this._scheduleAhead(), 25);
  }

  // Lookahead scheduling instead of one setInterval per note: at 25 ms the grid locks to the
  // audio clock, which is the difference between a soundtrack and a clicking machine.
  _scheduleAhead() {
    if (!this.ctx || !this.musicEnabled || this._paused || this.ctx.state !== 'running') {
      if (this.ctx) this._nextStepTime = this.ctx.currentTime + 0.05;
      return;
    }
    const horizon = this.ctx.currentTime + 0.22;
    while (this._nextStepTime < horizon) {
      this._playStep(this._step % 16, Math.floor(this._step / 16) % 4, this._nextStepTime);
      this._step++;
      this._nextStepTime += STEP;
    }
  }

  _playStep(step, bar, time) {
    const racing = this.isPlayingGetter();
    const root = BAR_ROOTS[bar];
    const intensity = this._intensity;

    // Garage: a pulse-free bed under the showroom. Racing: four-on-the-floor, and the kit fills
    // in as the speed climbs.
    if (racing && step % 4 === 0) {
      this._kick(time);
      this._pump(time);
    }
    if (racing && step % 2 === 1 && intensity > 0.35) this._hat(time, step);

    if (racing ? (step % 2 === 0 || intensity > 0.55) : step % 8 === 0) {
      this._bass(time, step % 8 === 6 ? root * 1.5 : root,
        racing ? 0.1 : 0.24, racing ? 0.1 + intensity * 0.05 : 0.06);
    }

    if (racing ? intensity > 0.2 : step % 4 === 0) {
      this._pluck(time, ARP_NOTES[(step + bar * 3) % ARP_NOTES.length] * (racing ? 1 : 0.5),
        racing ? 0.055 + intensity * 0.04 : 0.035, racing ? 0.13 : 0.4);
    }
  }

  _kick(time) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(148, time);
    o.frequency.exponentialRampToValueAtTime(42, time + 0.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.42, time);
    g.gain.exponentialRampToValueAtTime(0.004, time + 0.16);
    o.connect(g);
    g.connect(this.musicBus);
    o.start(time);
    o.stop(time + 0.17);
  }

  _pump(time) {
    const p = this.musicDuck.gain;
    p.setValueAtTime(0.95, time);
    p.linearRampToValueAtTime(0.4, time + 0.035);
    p.exponentialRampToValueAtTime(0.95, time + 0.19);
  }

  _bass(time, freq, gate, level) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, time);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(700 + this._intensity * 900, time);
    f.frequency.exponentialRampToValueAtTime(120, time + gate);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(level, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.004, time + gate);
    o.connect(f);
    f.connect(g);
    g.connect(this.musicTone);
    o.start(time);
    o.stop(time + gate + 0.02);
  }

  _pluck(time, freq, level, decay) {
    const racing = this.isPlayingGetter();
    const o = this.ctx.createOscillator();
    o.type = racing ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(freq, time);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2600 + this._intensity * 3000, time);
    f.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(level, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.003, time + decay);
    o.connect(f);
    f.connect(g);
    g.connect(this.musicTone);
    g.connect(this.leadSend);
    o.start(time);
    o.stop(time + decay + 0.02);
  }

  _hat(time, step) {
    const n = this.ctx.createBufferSource();
    n.buffer = this._noiseShort;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(step % 4 === 3 ? 0.055 : 0.03, time);
    g.gain.exponentialRampToValueAtTime(0.002, time + 0.05);
    n.connect(hp);
    hp.connect(g);
    g.connect(this.musicBus);
    n.start(time);
    n.stop(time + 0.06);
  }
}
