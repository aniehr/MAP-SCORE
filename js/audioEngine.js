/**
 * AudioEngine
 *
 * Three-layer synthesiser driven by map colour ratios, built with Tone.js.
 *
 *   Green (自然 Nature)  → Ambient pad   – softer tone with more green
 *   Blue  (水域 Water)   → Flowing arp   – slower rhythm with more blue
 *   Gray  (道路 Roads)   → Noise texture – stronger resonance with more gray
 *
 * A low drone provides a constant tonal foundation.
 *
 * The design mirrors the original MAP SCORE pipeline where colour ratios from
 * TouchDesigner drive parameters in VCV Rack via OSC.
 */
class AudioEngine {
  constructor() {
    this.isPlaying   = false;
    this.initialized = false;

    // Latest colour values (percentages)
    this.params = { green: 0, blue: 0, gray: 0 };
  }

  /* ── Initialisation ──────────────────────────────────────────── */

  async init() {
    if (this.initialized) return;
    await Tone.start();

    // ── Master bus ──────────────────────────────────────────────
    this.master = new Tone.Gain(0.65);
    this.master.toDestination();

    this.analyser = new Tone.Analyser('waveform', 128);
    this.master.connect(this.analyser);

    // ── Drone (subtle sine foundation) ─────────────────────────
    this.droneGain   = new Tone.Gain(0.1).connect(this.master);
    this.droneFilter = new Tone.Filter(350, 'lowpass').connect(this.droneGain);
    this.drone = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope:   { attack: 4, decay: 0, sustain: 1, release: 4 }
    }).connect(this.droneFilter);

    // ── GREEN / NATURE – Ambient pad ───────────────────────────
    this.padReverb = new Tone.Reverb(8);
    this.padReverb.wet.value = 0.45;
    this.padReverb.connect(this.master);

    this.padFilter = new Tone.Filter({
      frequency: 900,
      type: 'lowpass',
      rolloff: -24
    }).connect(this.padReverb);

    this.padGain = new Tone.Gain(0).connect(this.padFilter);

    this.padSynth = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 8,
      oscillator: { type: 'fatsine', count: 3, spread: 12 },
      envelope:   { attack: 3, decay: 2, sustain: 0.55, release: 5 }
    }).connect(this.padGain);

    // Chinese-pentatonic-friendly chord voicings (宫商角徵羽 – C D E G A)
    this.padChords = [
      ['C3', 'G3', 'D4', 'A4'],
      ['A2', 'E3', 'A3', 'E4'],
      ['D3', 'A3', 'D4', 'A4'],
      ['G2', 'D3', 'G3', 'D4'],
      ['E3', 'A3', 'E4', 'A4'],
      ['C3', 'E3', 'A3', 'E4']
    ];
    this.chordIdx = 0;

    // ── BLUE / WATER – Flowing arpeggios ───────────────────────
    this.arpReverb = new Tone.Reverb(5);
    this.arpReverb.wet.value = 0.55;
    this.arpReverb.connect(this.master);

    this.arpDelay = new Tone.PingPongDelay({
      delayTime: '8n',
      feedback:  0.3,
      wet:       0.35
    }).connect(this.arpReverb);

    this.arpGain = new Tone.Gain(0).connect(this.arpDelay);

    this.arpSynth = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope:   { attack: 0.015, decay: 0.35, sustain: 0.08, release: 1.2 }
    }).connect(this.arpGain);

    // C major pentatonic (宫调式)
    this.arpNotes = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5'];
    this.arpIdx   = 0;
    this.arpDir   = 1;

    // ── GRAY / URBAN – Noise + resonance ───────────────────────
    this.noiseGain = new Tone.Gain(0).connect(this.master);
    this.noiseFilter = new Tone.Filter({
      frequency: 1000,
      type:      'bandpass',
      Q:         2
    }).connect(this.noiseGain);

    this.noise = new Tone.Noise('pink').connect(this.noiseFilter);

    // Metallic resonance hits
    this.resGain   = new Tone.Gain(0).connect(this.master);
    this.resReverb = new Tone.Reverb(3);
    this.resReverb.wet.value = 0.35;
    this.resReverb.connect(this.resGain);

    this.resSynth = new Tone.MetalSynth({
      frequency:       200,
      envelope:        { attack: 0.001, decay: 0.4, release: 0.2 },
      harmonicity:     5.1,
      modulationIndex: 16,
      resonance:       4000,
      octaves:         1.5,
      volume:          -18
    }).connect(this.resReverb);

    // Wait for reverb impulse-response generation
    await Promise.all([
      this.padReverb.ready,
      this.arpReverb.ready,
      this.resReverb.ready
    ]);

    this.initialized = true;
  }

  /* ── Start / Stop ────────────────────────────────────────────── */

  start() {
    if (!this.initialized || this.isPlaying) return;
    this.isPlaying = true;

    Tone.Transport.bpm.value = 90;

    // Drone
    this.drone.triggerAttack('C2', Tone.now());

    // Noise
    this.noise.start();

    // Pad – chord changes every ~8 s, decoupled from Transport BPM
    this._triggerPadChord();
    this.padTimer = setInterval(() => this._triggerPadChord(), 8000);

    // Arp – tempo-synced
    this.arpLoop = new Tone.Loop((time) => {
      if (this.params.blue < 0.8) return;
      const note = this.arpNotes[this.arpIdx];
      const vel  = 0.3 + Math.random() * 0.35;
      this.arpSynth.triggerAttackRelease(note, '16n', time, vel);

      // Bounce with occasional random jump for variety
      if (Math.random() < 0.08) {
        this.arpIdx = Math.floor(Math.random() * this.arpNotes.length);
      } else {
        this.arpIdx += this.arpDir;
        if (this.arpIdx >= this.arpNotes.length - 1) this.arpDir = -1;
        if (this.arpIdx <= 0)                        this.arpDir =  1;
      }
    }, '8n').start(0);

    // Metal resonance hits
    this.resLoop = new Tone.Loop((time) => {
      if (this.params.gray < 2.5) return;
      this.resSynth.triggerAttackRelease('16n', time);
    }, '2n').start(0);

    Tone.Transport.start();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    Tone.Transport.stop();

    if (this.padTimer) {
      clearInterval(this.padTimer);
      this.padTimer = null;
    }
    if (this.arpLoop) { this.arpLoop.stop(); this.arpLoop.dispose(); this.arpLoop = null; }
    if (this.resLoop) { this.resLoop.stop(); this.resLoop.dispose(); this.resLoop = null; }

    this.drone.triggerRelease();
    this.noise.stop();

    // Fade out gains
    const fade = 0.6;
    this.padGain.gain.rampTo(0, fade);
    this.arpGain.gain.rampTo(0, fade);
    this.noiseGain.gain.rampTo(0, fade);
    this.resGain.gain.rampTo(0, fade);
    this.droneGain.gain.rampTo(0, fade);
  }

  /* ── Real-time parameter update ──────────────────────────────── */

  update(colorData) {
    if (!this.isPlaying) return;
    this.params = colorData;

    const t = 1.5; // ramp time (seconds) – smooth transitions

    // ── Green / Nature ──
    // Normalise: ~40 % green is "full" presence
    const gn = Math.min(colorData.green / 40, 1);
    this.padGain.gain.rampTo(gn * 0.55, t);
    // More green → lower cutoff → softer, warmer timbre (音色越柔和)
    this.padFilter.frequency.rampTo(280 + (1 - gn) * 2400, t);

    // ── Blue / Water ──
    // Normalise: ~25 % blue is "full"
    const bn = Math.min(colorData.blue / 25, 1);
    this.arpGain.gain.rampTo(bn * 0.45, t);
    // More blue → slower BPM (节奏越慢)
    const bpm = 160 - bn * 120; // range 160 → 40
    Tone.Transport.bpm.rampTo(bpm, t * 2);
    // More blue → wetter reverb & delay (more spacious)
    this.arpReverb.wet.rampTo(0.3 + bn * 0.5, t);
    this.arpDelay.wet.rampTo(0.2 + bn * 0.45, t);

    // ── Gray / Urban ──
    // Normalise: ~35 % gray is "full"
    const grn = Math.min(colorData.gray / 35, 1);
    this.noiseGain.gain.rampTo(grn * 0.30, t);
    // More gray → higher Q → stronger resonance (共鸣声越强)
    this.noiseFilter.Q.rampTo(1 + grn * 18, t);
    this.noiseFilter.frequency.rampTo(350 + grn * 2200, t);
    // Metal hits volume
    this.resGain.gain.rampTo(grn * 0.25, t);

    // ── Drone responds to overall activity ──
    const activity = (gn + bn + grn) / 3;
    this.droneGain.gain.rampTo(0.06 + activity * 0.14, t);
    this.droneFilter.frequency.rampTo(180 + activity * 400, t);
  }

  /* ── Waveform data for visualisation ─────────────────────────── */

  getWaveform() {
    return this.analyser ? this.analyser.getValue() : null;
  }

  /* ── Internal helpers ────────────────────────────────────────── */

  _triggerPadChord() {
    if (!this.isPlaying || this.params.green < 0.5) return;
    const chord = this.padChords[this.chordIdx];
    this.padSynth.triggerAttackRelease(chord, 8);
    this.chordIdx = (this.chordIdx + 1) % this.padChords.length;
  }
}
