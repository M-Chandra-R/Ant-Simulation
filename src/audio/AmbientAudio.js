/**
 * Pure WebAudio Procedural Post-Rain Forest Soundscape:
 * - Soft stereo breeze rustling through wet foliage (reactive to wind strength)
 * - Delicate crystalline water-drop plinks when droplets detach & hit puddles/leaves
 * - Subtle wet-blade brush sound as the ant moves through dense grass
 */
export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.initialized = false;
    this.windGain = null;
    this.windFilter = null;
    this.rustleGain = null;
  }

  init() {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended' && this.enabled) {
        this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.enabled ? 0.55 : 0.0;
    this.masterGain.connect(this.ctx.destination);

    // Generate 4-second seamless pink-ish organic noise buffer
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * 4;
    const noiseBuf = this.ctx.createBuffer(1, length, sampleRate);
    const out = noiseBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.035;
      b6 = white * 0.115926;
    }

    // 1. Forest Canopy Breeze Layer
    const windSrc = this.ctx.createBufferSource();
    windSrc.buffer = noiseBuf;
    windSrc.loop = true;

    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.85;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.18;

    windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.masterGain);
    windSrc.start();

    // 2. Ant Grass-Brush Rustle Layer
    const rustleSrc = this.ctx.createBufferSource();
    rustleSrc.buffer = noiseBuf;
    rustleSrc.loop = true;
    rustleSrc.playbackRate.value = 1.45;

    const rustleFilter = this.ctx.createBiquadFilter();
    rustleFilter.type = 'highpass';
    rustleFilter.frequency.value = 1900;

    this.rustleGain = this.ctx.createGain();
    this.rustleGain.gain.value = 0.0;

    rustleSrc.connect(rustleFilter);
    rustleFilter.connect(this.rustleGain);
    this.rustleGain.connect(this.masterGain);
    rustleSrc.start();

    this.initialized = true;
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.initialized && this.enabled) {
      this.init();
    }
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.enabled ? 0.55 : 0.0, this.ctx.currentTime, 0.08);
    }
    return this.enabled;
  }

  playDropletSplash(distance, hitPuddle) {
    if (!this.initialized || !this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const atten = Math.max(0, 1.0 - distance / 34.0);
    if (atten <= 0.02) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // Puddle impacts produce a classic upward-chirping bubble plink; leaf/soil impacts a soft damp tap
    if (hitPuddle) {
      const baseFreq = 680 + Math.random() * 480;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 2.15, now + 0.075);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.085 * atten, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.12);
    } else {
      const baseFreq = 320 + Math.random() * 220;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, now + 0.045);
      gain.gain.setValueAtTime(0.038 * atten, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.055);
    }
  }

  update(elapsed, windStrength, antSpeed, isGrounded) {
    if (!this.initialized || !this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const gust = 0.7 + 0.3 * Math.sin(elapsed * 0.65);
    this.windFilter.frequency.setTargetAtTime(340 + windStrength * 240 * gust, now, 0.15);
    this.windGain.gain.setTargetAtTime(0.09 + windStrength * 0.12 * gust, now, 0.15);

    const rustleAmt = isGrounded ? Math.min(0.065, antSpeed * 0.0055) : 0.0;
    this.rustleGain.gain.setTargetAtTime(rustleAmt, now, 0.08);
  }
}
