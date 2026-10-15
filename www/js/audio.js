export class AAASoundSystem {
  constructor() {
    this.ctx = null;
    this.musicEnabled = true;
    this.sfxEnabled = true;
    this.voiceEnabled = true;
    this.hapticsEnabled = true;
    this.isPaused = false;
    this.rpm = 0.2;
    this.gear = 1;
    this.lastGear = 1;
    this.bgmStep = 0;
    this.bgmInterval = null;
    this.isPlayingGetter = () => false;
  }

  applySettings(settings) {
    this.musicEnabled = settings.music !== false;
    this.sfxEnabled = settings.sfx !== false;
    this.voiceEnabled = settings.voice !== false;
    this.hapticsEnabled = settings.haptics !== false;
    if (!this.sfxEnabled && this.engGain && this.ctx) {
      this.engGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.05);
    }
    if (!this.voiceEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  vibrate(ms = 25) {
    if (!this.hapticsEnabled) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) {}
    }
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
    const silentBuf = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = silentBuf;
    src.connect(this.ctx.destination);
    src.start(0);

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.ctx.destination);

    this.engGain = this.ctx.createGain();
    this.engGain.gain.value = 0.01;

    this.engFilter = this.ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 320;
    this.engFilter.Q.value = 4.5;

    this.shaper = this.ctx.createWaveShaper();
    this.shaper.curve = this.makeDistortionCurve(60);

    this.osc1 = this.ctx.createOscillator();
    this.osc2 = this.ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2.type = 'triangle';
    this.osc1.frequency.value = 55;
    this.osc2.frequency.value = 27.5;

    this.osc1.connect(this.shaper);
    this.osc2.connect(this.shaper);
    this.shaper.connect(this.engFilter);
    this.engFilter.connect(this.engGain);
    this.engGain.connect(this.master);

    this.osc1.start();
    this.osc2.start();
    this.startBGM();
  }

  makeDistortionCurve(amount) {
    const n = 44100, curve = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  updateEngine(speedRatio, isPlaying, isMorphed, morphType) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    if (!this.sfxEnabled || this.isPaused) {
      this.engGain.gain.setTargetAtTime(0.0001, now, 0.06);
      return;
    }

    if (!isPlaying) {
      const idlePulse = 46 + Math.sin(now * 6) * 3;
      this.osc1.frequency.setTargetAtTime(idlePulse, now, 0.08);
      this.osc2.frequency.setTargetAtTime(idlePulse * 0.5, now, 0.08);
      this.engFilter.frequency.setTargetAtTime(190, now, 0.1);
      this.engGain.gain.setTargetAtTime(0.05, now, 0.15);
      return;
    }

    const totalProgress = Math.min(1, Math.max(0, (speedRatio - 0.78) / 0.82));
    const newGear = Math.min(5, Math.floor(totalProgress * 5) + 1);
    if (newGear > this.lastGear) this.triggerExhaustBackfire();
    this.lastGear = newGear;
    this.gear = newGear;

    const gearLocalRPM = ((totalProgress * 5) % 1) * 0.75 + 0.25;
    this.rpm = isMorphed ? 0.98 : gearLocalRPM;

    let baseFreq = 62 + this.rpm * 145 + (this.gear * 14);
    if (isMorphed) {
      baseFreq = morphType === 'jet' ? 240 + Math.sin(now * 20) * 15 : 85 + this.rpm * 95;
    }

    this.osc1.frequency.setTargetAtTime(baseFreq, now, 0.05);
    this.osc2.frequency.setTargetAtTime(baseFreq * (isMorphed && morphType === 'jet' ? 1.5 : 0.5), now, 0.05);
    this.engFilter.frequency.setTargetAtTime(300 + this.rpm * 1400, now, 0.06);
    this.engGain.gain.setTargetAtTime(0.14, now, 0.08);
  }

  triggerExhaustBackfire() {
    if (!this.ctx || !this.sfxEnabled || this.isPaused) return;
    [0, 0.07].forEach(delay => {
      setTimeout(() => {
        if (!this.ctx || !this.sfxEnabled || this.isPaused) return;
        const bufSize = this.ctx.sampleRate * 0.06;
        const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.3));
        const noise = this.ctx.createBufferSource();
        noise.buffer = buf;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 420 + Math.random() * 250;

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.28, this.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.06);

        noise.connect(filter); filter.connect(g); g.connect(this.master);
        noise.start();
      }, delay * 1000);
    });
  }

  playTireScreech() {
    if (!this.ctx || !this.sfxEnabled) return;
    this.vibrate(15);
    const dur = 0.14;
    const bufSize = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;

    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, this.ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(2200, this.ctx.currentTime + dur);
    filter.Q.value = 6.0;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + dur);

    noise.connect(filter); filter.connect(g); g.connect(this.master);
    noise.start();
    this.triggerExhaustBackfire();
  }

  playJumpWhoosh() {
    if (!this.ctx || !this.sfxEnabled) return;
    this.vibrate(20);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(780, this.ctx.currentTime + 0.24);
    g.gain.setValueAtTime(0.22, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.24);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(this.ctx.currentTime + 0.24);
  }

  playCoinChime(comboIndex) {
    if (!this.ctx || !this.sfxEnabled) return;
    this.vibrate(10);
    const notes = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.5];
    const freq = notes[comboIndex % notes.length];
    const now = this.ctx.currentTime;
    [freq, freq * 1.5].forEach((f, idx) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = idx === 0 ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(f, now);
      g.gain.setValueAtTime(idx === 0 ? 0.16 : 0.08, now);
      g.gain.exponentialRampToValueAtTime(0.005, now + 0.16);
      o.connect(g); g.connect(this.master);
      o.start(); o.stop(now + 0.16);
    });
  }

  playMorphPowerup() {
    this.vibrate([40, 30, 60]);
    if (this.ctx && this.sfxEnabled) {
      const now = this.ctx.currentTime;
      [261.6, 329.6, 392.0, 523.2, 659.2].forEach((f, i) => {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f, now + i * 0.055);
        o.frequency.exponentialRampToValueAtTime(f * 1.5, now + i * 0.055 + 0.25);
        g.gain.setValueAtTime(0.15, now + i * 0.055);
        g.gain.exponentialRampToValueAtTime(0.008, now + i * 0.055 + 0.25);
        o.connect(g); g.connect(this.master);
        o.start(now + i * 0.055); o.stop(now + i * 0.055 + 0.25);
      });
    }
    this.speakAnnouncer("MEGA MORPH!");
  }

  playCrashImpact() {
    this.vibrate([80, 40, 120]);
    if (!this.ctx || !this.sfxEnabled) return;
    const dur = 0.45;
    const bufSize = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.35));

    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 650;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.4, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + dur);
    noise.connect(filter); filter.connect(g); g.connect(this.master);
    noise.start();
  }

  speakAnnouncer(text) {
    if (!this.voiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.25; u.pitch = 1.15; u.volume = 0.85;
    window.speechSynthesis.speak(u);
  }

  startBGM() {
    const bassNotes = [65.41, 65.41, 77.78, 65.41, 87.31, 87.31, 98.00, 77.78];
    const arpNotes  = [261.6, 311.1, 392.0, 523.2, 392.0, 311.1, 349.2, 440.0];
    this.bgmInterval = setInterval(() => {
      if (!this.ctx || !this.musicEnabled || this.isPaused || this.ctx.state !== 'running') return;
      const now = this.ctx.currentTime;
      const step = this.bgmStep % 8;

      const bOsc = this.ctx.createOscillator();
      const bGain = this.ctx.createGain();
      const bFilter = this.ctx.createBiquadFilter();
      bOsc.type = 'sawtooth';
      bOsc.frequency.setValueAtTime(bassNotes[step], now);
      bFilter.type = 'lowpass';
      bFilter.frequency.setValueAtTime(420, now);
      bFilter.frequency.exponentialRampToValueAtTime(110, now + 0.18);
      bGain.gain.setValueAtTime(0.11, now);
      bGain.gain.exponentialRampToValueAtTime(0.008, now + 0.2);
      bOsc.connect(bFilter); bFilter.connect(bGain); bGain.connect(this.master);
      bOsc.start(now); bOsc.stop(now + 0.2);

      if (step % 2 === 0) {
        const kOsc = this.ctx.createOscillator();
        const kGain = this.ctx.createGain();
        kOsc.frequency.setValueAtTime(135, now);
        kOsc.frequency.exponentialRampToValueAtTime(32, now + 0.12);
        kGain.gain.setValueAtTime(0.22, now);
        kGain.gain.exponentialRampToValueAtTime(0.008, now + 0.14);
        kOsc.connect(kGain); kGain.connect(this.master);
        kOsc.start(now); kOsc.stop(now + 0.14);
      }

      if (this.isPlayingGetter()) {
        const aOsc = this.ctx.createOscillator();
        const aGain = this.ctx.createGain();
        aOsc.type = 'triangle';
        aOsc.frequency.setValueAtTime(arpNotes[step], now);
        aGain.gain.setValueAtTime(0.045, now);
        aGain.gain.exponentialRampToValueAtTime(0.004, now + 0.15);
        aOsc.connect(aGain); aGain.connect(this.master);
        aOsc.start(now); aOsc.stop(now + 0.15);
      }
      this.bgmStep++;
    }, 220);
  }
}
