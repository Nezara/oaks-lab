"use strict";
/* ============================================================================
   Oak's Lab cries — playing a Pokemon's cry in the browser.

   A Gen 1 cry is not a sound file, which is why this is synthesis and not a
   player. Each species is three things -- a base cry, a pitch and a length --
   and the base cry is a short bytecode program in the ROM's sound banks that
   the Game Boy's sound chip runs. 151 species share only 38 base cries; the
   rest of the variety is those two modifiers.

   That is exactly why a recording would not do. The whole point of step 6 is
   inventing a cry that has never existed -- somebody else's base bent to a new
   pitch and length -- and there is nothing to record for a sound that is being
   made up. Running the same program the console would run is the only way to
   hear it before the game does.

   This is a port of the cry-shaped slice of the engine's own synth
   (src/core/ChipSynth.lua). Deliberately a slice, not the whole thing: a cry
   uses three hardware channels (two pulses and the noise channel -- never the
   wave channel) and, across all 38 base cries, exactly five opcodes. Music
   needs the other nine tenths of that file; a cry does not.

   The bytes come from gamedata.json's `audio.programs` -- the engine's own
   decode of the three sound banks, 48 KB. ROM-derived, so it travels under
   the same rule as every other byte in that file and never ships in a mod.
   ========================================================================== */

const CRY_SAMPLE_RATE = 44100;
const CRY_TICKS_PER_SECOND = 15360;
const CRY_FRAME_TICKS = 256;
const GB_CLOCK = 4194304;

// The DMG's analog tail: a high-pass that drifts each channel back to zero and
// a gentle low-pass, then half gain so a three-channel cry cannot clip. Without
// these a cry is audibly harsher than the console's.
const CRY_HPF_CHARGE = Math.pow(0.999958, GB_CLOCK / CRY_SAMPLE_RATE);
const CRY_LPF_ALPHA = 0.8;
const CRY_MIX_SCALE = 0.5;

// The four pulse duty patterns, as the chip steps through them eight times a
// period. Which one is in use is what makes a cry buzz or hum.
const CRY_DUTY = {
  0: [0, 0, 0, 0, 0, 0, 0, 1],
  1: [1, 0, 0, 0, 0, 0, 0, 1],
  2: [1, 0, 0, 0, 0, 1, 1, 1],
  3: [0, 1, 1, 1, 1, 1, 1, 0],
};
const CRY_NOISE_DIVISORS = { 0: 8, 1: 16, 2: 32, 3: 48, 4: 64, 5: 80, 6: 96, 7: 112 };

// Ticks to samples, the engine's own rounding. Kept as its odd-looking integer
// form rather than a float multiply so note boundaries land on the same sample
// the engine puts them on.
const crySnapTicks = (t) => Math.floor((t * 1470 + 256) / 512);

// A volume envelope's low nibble is signed: bit 3 set means fade down.
const cryFadeValue = (n) => ((n & 8) ? -(n & 7) : n);

function cryEnvelopeVolume(volume, fade, elapsed) {
  if (fade === 0) return volume;
  const steps = Math.floor(elapsed / (Math.abs(fade) / 64));
  return fade > 0 ? Math.max(0, volume - steps) : Math.min(15, volume + steps);
}

/* ------------------------------------------------------------- the banks -- */

let cryBankCache = null;

/**
 * The three sound banks, decoded once.
 *
 * Addresses in a cry header are Game Boy addresses in the 0x4000 window, so
 * each bank is indexed from 0x4000 rather than from zero -- that is what makes
 * `romByte` below a subtraction instead of a lookup table.
 */
function cryBanks() {
  if (cryBankCache !== null) return cryBankCache;
  const audio = GAME?.audio;
  if (!audio?.programs || !audio.bankOrder) return (cryBankCache = false);
  const raw = base64Bytes(audio.programs);
  const banks = {};
  audio.bankOrder.forEach((bank, i) => {
    banks[bank] = raw.subarray(i * 0x4000, (i + 1) * 0x4000);
  });
  return (cryBankCache = banks);
}

// Whether this build can play anything at all. A --no-gamedata build carries no
// sound programs, so the UI asks this rather than offering a button that would
// do nothing.
const criesPlayable = () => cryBanks() !== false;

// What a species' cry sounds like in the unmodified game, for "start from".
const vanillaCry = (id) => GAME?.audio?.cries?.[id] || null;

// A sound effect's header -- {address, bank} exactly like a cry's, because it
// is the same three-bytes-per-channel descriptor. That equivalence is why a
// move's sound needs no second player.
const vanillaSfx = (name) => GAME?.audio?.sfx?.[name] || null;
const sfxPlayable = () => criesPlayable() && !!GAME?.audio?.sfx;

/* ------------------------------------------------------------ a channel -- */

// The twelve semitones, as the negative frequency words the hardware wants.
// Only a program that has flipped into music mode reads these.
const CRY_PITCHES = [
  0xF82C, 0xF89D, 0xF907, 0xF96B, 0xF9CA, 0xFA23,
  0xFA77, 0xFAC7, 0xFB12, 0xFB58, 0xFB9B, 0xFBDA,
];

/* --------------------------------------------------------- bending pitch -- */

// One step of the sweep unit: the register moves by a fraction of itself, so
// the slide accelerates rather than running at a constant rate.
const crySweepStep = (register, sweep) => {
  const delta = Math.floor(register / Math.pow(2, sweep.shift));
  return sweep.subtract ? register - delta : register + delta;
};

/**
 * Where a note's pitch actually is at this instant.
 *
 * Three ways a Gen 1 program bends a note, in the order the hardware settles
 * them: the sweep unit walks the register by a fraction of itself 128 times a
 * second; a slide crosses to a target over a fixed number of frames; vibrato
 * flips either side of the register on a fixed beat. Returns null when a
 * sweep has run the register off the end -- that silences the channel, which
 * is how most of the battle hit sounds stop.
 *
 * A cry sets none of these, so it takes the first line out.
 */
function bentRegister(ev) {
  const frame = Math.floor(ev.elapsed * 60);
  if (ev.sweep && ev.sweep.shift !== 0) {
    let register = ev.register;
    let next = crySweepStep(register, ev.sweep);
    if (next > 0x7FF || next < 0) return null;
    if (ev.sweep.pace === 0) return register;
    const steps = Math.floor(ev.elapsed * 128 / ev.sweep.pace);
    for (let i = 0; i < steps; i++) {
      register = next;
      next = crySweepStep(register, ev.sweep);
      if (next > 0x7FF || next < 0) return null;
    }
    return register;
  }
  if (ev.slide) {
    const amount = Math.min(1, frame / Math.max(1, ev.slide.length));
    return ev.register + (ev.slide.target - ev.register) * amount;
  }
  if (ev.vibrato && frame >= ev.vibrato.delay) {
    const toggles = Math.floor((frame - ev.vibrato.delay + 1) / (ev.vibrato.rate + 1));
    if (toggles > 0) {
      // Vibrato moves the register's LOW byte only, so a deep wobble near a
      // byte boundary is lopsided -- an artefact of the original, kept.
      const low = ev.register & 0xFF, high = ev.register & 0x700;
      return (toggles & 1)
        ? high + Math.min(0xFF, low + ev.vibrato.above)
        : high + Math.max(0, low - ev.vibrato.below);
    }
  }
  return ev.register;
}

/**
 * One hardware channel running its own little program.
 *
 * The three a cry uses are two pulse channels and the noise channel. Each has
 * its own program and its own clock, and they end at different times -- the cry
 * is over when the last one stops, which is why the mixer below asks all three.
 */
class CryChannel {
  constructor(banks, spec, o) {
    this.banks = banks;
    this.bank = o.bank;
    this.address = spec.address;
    // Software channels 5-8 map onto hardware 1-4; 8 is the noise channel.
    this.hardware = ((spec.number - 1) % 4) + 1;
    this.noise = this.hardware === 4;
    this.frameTicks = o.frameTicks;
    this.frequencyOffset = o.frequencyOffset || 0;
    this.volume = 12;
    this.fade = 0;
    this.duty = 2;
    // The rest is only ever touched by a sound effect. A cry's five opcodes
    // never reach any of it, so a cry renders exactly as it did before these
    // existed -- which is the point: the same synth, not a second one.
    this.speed = 12;
    this.octave = 4;
    this.perfectPitch = false;
    this.sweep = null;
    this.vibrato = null;
    this.pendingSlide = null;
    // A sound effect's program can flip into MUSIC mode part-way through
    // (0xF8), at which point a byte under 0xC0 stops being a raw note and
    // becomes a pitch-and-length pair read off the note table. One of the 48
    // battle sounds does exactly that.
    this.executeMusic = false;
    this.timeTicks = 0;
    this.ended = false;
    this.event = null;
    this.phase = 0;
    this.callStack = [];
    this.loopCounts = new Map();
    this.resetNoise();
  }

  resetNoise() { this.noiseLfsr = 0x7FFF; this.noiseClock = 0; }

  byte() {
    const v = this.banks[this.bank][this.address - 0x4000];
    this.address++;
    return v === undefined ? 0xFF : v;      // off the end reads as "end"
  }
  word() { return this.byte() + this.byte() * 0x100; }

  // In a cry the note length is multiplied by the channel's own frame rate,
  // which for a pulse channel is where `length` gets in: the pulses run at
  // 0x80 + length while the noise channel is pinned to one frame. That is why
  // a length under 128 changes nothing -- the noise channel is still the
  // longest thing playing.
  durationTicks(length) {
    return length * this.frameTicks * (this.executeMusic ? this.speed : 1);
  }

  /**
   * A note's frequency register, from the twelve-entry pitch table.
   *
   * Only the music half of a program uses this -- a sound effect's own notes
   * carry their register in the program. The table entries are stored as the
   * negative words the hardware wants, so the shift has to be arithmetic:
   * JavaScript's >> already is, which is the whole reason this is a
   * subtraction from 0x10000 rather than a mask.
   */
  frequency(note, octave) {
    const signed = CRY_PITCHES[note] - 0x10000;
    let register = (signed >> Math.max(0, (octave ?? this.octave) - 1)) & 0x7FF;
    if (this.perfectPitch) register = (register + 1) & 0x7FF;
    return (register + this.frequencyOffset) & 0x7FF;
  }

  /**
   * One tone, with whatever is currently bending its pitch attached.
   *
   * The three benders are mutually exclusive at playback (a slide overrides
   * vibrato, a sweep overrides both), so they ride along as fields and the
   * mixer picks. A cry sets none of them and gets the plain event it always
   * did. The sweep is hardware channel 1 only -- that is the only pulse the
   * Game Boy wired a sweep unit to.
   */
  toneEvent(register, volume, fade) {
    const slide = this.pendingSlide;
    this.pendingSlide = null;
    return {
      register,
      volume: volume === undefined ? this.volume : volume,
      fade: fade === undefined ? this.fade : fade,
      duty: this.duty,
      sweep: this.hardware === 1 ? this.sweep : null,
      vibrato: slide ? null : this.vibrato,
      slide,
    };
  }

  timedEvent(ev, ticks) {
    const first = crySnapTicks(this.timeTicks);
    this.timeTicks += ticks;
    ev.samples = crySnapTicks(this.timeTicks) - first;
    ev.sample = 0;
    ev.elapsed = 0;
    return ev;
  }

  /**
   * Run the program until it produces something to play, or ends.
   *
   * Five opcodes cover every cry in the game. Battle sound effects -- which
   * are the same bytecode read the same way, and are what a move's sound is --
   * reach for seven more: a frequency sweep (the descending "boop" behind half
   * the hit sounds), vibrato, an octave and a speed, and the flip into music
   * mode. Anything past those is a program this code does not understand, and
   * stopping is the honest response -- a sound that ends early is obvious, a
   * sound that plays garbage is not.
   */
  nextEvent() {
    if (this.ended) return null;
    for (let guard = 0; guard < 10000; guard++) {
      const at = this.address;
      const c = this.byte();

      if (this.executeMusic && c < 0xC0) {
        // Music mode: the byte IS the note and its length, read off the pitch
        // table rather than carrying a register of its own.
        const note = c >> 4;
        const length = (c & 0x0F) + 1;
        if (this.noise) {
          // A music-mode noise note names a drum out of a per-engine kit this
          // synth does not carry. Silence for the right length keeps the rest
          // of the program in time, which is what matters here.
          if (c >= 0xB0) this.byte();
          return this.timedEvent({ silence: true }, this.durationTicks(length));
        }
        return this.timedEvent(this.toneEvent(this.frequency(note)), this.durationTicks(length));
      } else if (c >= 0x20 && c < 0x30) {
        // A note: length, then volume/fade, then the pitch. The cry's own
        // pitch modifier is added here -- to an 8-bit noise parameter or an
        // 11-bit pulse register, and it WRAPS, which is why the pitch slider
        // is not simply "lower is deeper".
        const length = (c & 0x0F) + 1;
        const packed = this.byte();
        const volume = packed >> 4;
        const fade = cryFadeValue(packed & 0x0F);
        if (this.noise) {
          const parameter = (this.byte() + this.frequencyOffset) & 0xFF;
          return this.timedEvent(
            { noise: true, volume, fade, noiseParameter: parameter },
            this.durationTicks(length));
        }
        const register = (this.word() + this.frequencyOffset) & 0x7FF;
        return this.timedEvent(this.toneEvent(register, volume, fade), this.durationTicks(length));
      } else if (c >= 0xC0 && c < 0xD0) {
        return this.timedEvent({ silence: true }, this.durationTicks((c & 0x0F) + 1));
      } else if (c === 0x10) {
        // Frequency sweep (NR10): how fast, which way, and by how much of
        // itself the pitch slides each step. This is the falling whistle in
        // Battle_09 and the rising one in Faint_Fall.
        const p = this.byte();
        this.sweep = { pace: (p >> 4) & 7, subtract: (p & 8) !== 0, shift: p & 7 };
      } else if (c >= 0xD0 && c < 0xE0) {
        this.speed = c & 0x0F;
        if (!this.noise) {
          const p = this.byte();
          this.volume = p >> 4;
          this.fade = cryFadeValue(p & 0x0F);
        }
      } else if (c >= 0xE0 && c <= 0xE7) {
        this.octave = 8 - (c & 7);
      } else if (c === 0xE8) {
        this.perfectPitch = !this.perfectPitch;
      } else if (c === 0xE9) {
        /* unused command */
      } else if (c === 0xEA) {
        const delay = this.byte();
        const p = this.byte();
        const depth = p >> 4;
        this.vibrato = depth === 0 ? null
          : { delay, above: (depth >> 1) + (depth & 1), below: depth >> 1, rate: p & 0x0F };
      } else if (c === 0xEB) {
        const length = this.byte();
        const p = this.byte();
        this.pendingSlide = { length, target: this.frequency(p & 0x0F, 8 - (p >> 4)) };
      } else if (c === 0xED || c === 0xEE || c === 0xEF || c === 0xF0) {
        // Tempo (two bytes), stereo pan and the two unused one-byte commands.
        // A one-shot has nothing to do with any of them; step past the
        // operands rather than reading them as opcodes.
        this.byte();
        if (c === 0xED) this.byte();
      } else if (c === 0xF8) {
        this.executeMusic = !this.executeMusic;
      } else if (c === 0xFC) {
        // Four duty values packed into a byte, one per frame -- the chip
        // cycles them, which is the warble on a lot of the 151.
        const p = this.byte();
        this.duty = [(p >> 6) & 3, (p >> 4) & 3, (p >> 2) & 3, p & 3];
      } else if (c === 0xEC) {
        this.duty = this.byte() & 3;
      } else if (c === 0xFD) {
        this.callStack.push(this.address + 2);
        this.address = this.word();
      } else if (c === 0xFE) {
        const count = this.byte();
        const target = this.word();
        // A zero count is an infinite loop. A cry is a one-shot, so that is
        // the end of it rather than something to play forever.
        if (count === 0) { this.ended = true; return null; }
        let remaining = this.loopCounts.has(at) ? this.loopCounts.get(at) : count;
        remaining -= 1;
        if (remaining > 0) { this.loopCounts.set(at, remaining); this.address = target; }
        else this.loopCounts.delete(at);
      } else if (c === 0xFF) {
        const ret = this.callStack.pop();
        if (ret !== undefined) this.address = ret;
        else { this.ended = true; return null; }
      } else {
        this.ended = true;
        return null;
      }
    }
    this.ended = true;
    return null;
  }

  /**
   * The noise channel: a shift register tapped for one bit a sample.
   *
   * Not random -- the same 15-bit sequence every time, which is why a cry
   * sounds the same twice. The 7-bit mode is a much shorter loop, and metallic
   * rather than hissy.
   */
  sampleNoise(parameter) {
    const divisor = CRY_NOISE_DIVISORS[parameter & 7];
    const shift = parameter >> 4;
    if (shift < 14) {
      const cycles = GB_CLOCK / divisor / Math.pow(2, shift) / CRY_SAMPLE_RATE;
      const width7 = (parameter & 8) !== 0;
      let remaining = cycles;
      while (remaining > 0) {
        const span = Math.min(remaining, 1 - this.noiseClock);
        this.noiseClock += span;
        remaining -= span;
        if (this.noiseClock >= 1 - 1e-12) {
          this.noiseClock = 0;
          const feedback = (this.noiseLfsr & 1) ^ ((this.noiseLfsr >> 1) & 1);
          this.noiseLfsr = (this.noiseLfsr >> 1) | (feedback << 14);
          if (width7) this.noiseLfsr = (this.noiseLfsr & ~0x40) | (feedback << 6);
        }
      }
    }
    return (this.noiseLfsr & 1) === 0 ? 1 : 0;
  }

  sample() {
    while (!this.ended && (!this.event || this.event.sample >= this.event.samples)) {
      this.event = this.nextEvent();
      this.phase = 0;
      this.resetNoise();
    }
    const ev = this.event;
    if (!ev) return 0;
    const i = ev.sample;
    ev.elapsed = i / CRY_SAMPLE_RATE;
    ev.sample = i + 1;
    if (ev.silence) return 0;

    const volume = cryEnvelopeVolume(ev.volume || 0, ev.fade || 0, ev.elapsed);
    if (ev.noise) return this.sampleNoise(ev.noiseParameter) * volume / 15;

    const register = bentRegister(ev);
    // A sweep that runs the register out of range silences the channel, which
    // is how the hit sounds stop rather than trailing off.
    if (register === null) return 0;

    const frequency = 131072 / (2048 - Math.min(register, 2047));
    const phase = this.phase;
    this.phase = (phase + frequency / CRY_SAMPLE_RATE) % 1;
    let duty = ev.duty;
    if (Array.isArray(duty)) duty = duty[Math.floor(ev.elapsed * 60) % 4];
    const pattern = CRY_DUTY[duty] || CRY_DUTY[2];
    return pattern[Math.floor(phase * 8) % 8] === 0 ? 0 : volume / 15;
  }
}

/* ------------------------------------------------------------ rendering -- */

/**
 * Render one cry to samples.
 *
 * `def` is {address, bank, pitch, length} -- a vanilla cry straight out of
 * gamedata, or a borrowed base with the step 6 sliders' own pitch and length,
 * which is the case that matters. Returns null if there is nothing to play.
 */
function renderCry(def) {
  const banks = cryBanks();
  if (!banks || !def) return null;
  const bank = def.bank ?? 2;
  if (!banks[bank]) return null;

  const romByte = (a) => banks[bank][a - 0x4000];
  const romWord = (a) => romByte(a) + romByte(a + 1) * 0x100;

  // A cry header is one 3-byte descriptor per channel; the top two bits of the
  // first byte say how many follow.
  let a = def.address;
  if (romByte(a) === undefined) return null;
  const count = ((romByte(a) & 0xF0) >> 6) + 1;
  const channels = [];
  for (let i = 0; i < count; i++) {
    const descriptor = romByte(a);
    const number = (descriptor & 0x0F) + 1;
    const address = romWord(a + 1);
    a += 3;
    const hardware = ((number - 1) % 4) + 1;
    channels.push(new CryChannel(banks, { number, address }, {
      bank,
      frequencyOffset: def.pitch || 0,
      // Only the pulse channels carry the length modifier; the noise channel
      // runs at one frame whatever the cry says.
      frameTicks: hardware === 4 ? CRY_FRAME_TICKS : 0x80 + (def.length || 0),
    }));
  }
  if (!channels.length) return null;

  // Five seconds is far past the longest cry in the game (~1.6s) and exists
  // only so a program this code misreads cannot spin.
  const max = CRY_SAMPLE_RATE * 5;
  const out = new Float32Array(max);
  let n = 0, hpf = 0, lpf = 0;
  while (n < max) {
    if (channels.every((c) => c.ended && (!c.event || c.event.sample >= c.event.samples))) break;
    let v = 0;
    for (const c of channels) v += c.sample();
    const hp = v - hpf;
    hpf = v - hp * CRY_HPF_CHARGE;
    lpf = lpf + CRY_LPF_ALPHA * (hp - lpf);
    out[n++] = Math.max(-1, Math.min(1, lpf * CRY_MIX_SCALE));
  }
  // Anything shorter than a hundredth of a second is a misread, not a cry.
  if (n < CRY_SAMPLE_RATE / 100) return null;
  return out.subarray(0, n);
}

/* ------------------------------------------------------------- playback -- */

// One context for the whole page. Browsers cap how many a tab may open, and a
// cry is played over and over while the sliders move.
let cryContext = null;
let cryPlaying = null;

function cryAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!cryContext) cryContext = new Ctor({ sampleRate: CRY_SAMPLE_RATE });
  // Autoplay policy parks a context created before the first gesture; every
  // caller here is a click or a slider, so resuming is always allowed.
  if (cryContext.state === "suspended") cryContext.resume();
  return cryContext;
}

/**
 * Play a cry, stopping whatever was already playing.
 *
 * Dragging the pitch slider fires this on every step, and two cries overlapping
 * tells you nothing about either -- the newest is the one being asked about.
 */
function playCry(def) {
  const samples = renderCry(def);
  if (!samples) return false;
  const ctx = cryAudioContext();
  if (!ctx) return false;

  stopCry();
  const buffer = ctx.createBuffer(1, samples.length, CRY_SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => { if (cryPlaying === source) cryPlaying = null; };
  source.start();
  cryPlaying = source;
  return true;
}

function stopCry() {
  if (!cryPlaying) return;
  try { cryPlaying.stop(); } catch { /* already finished */ }
  cryPlaying = null;
}

/**
 * The cry a species record would actually make, as a {address, bank, pitch,
 * length} the renderer takes.
 *
 * `_cry` is what step 6 authors: a base to borrow and the two modifiers. With
 * no pitch or length of its own it falls back to the base cry's, so "start
 * from PIDGEY" alone plays PIDGEY rather than something at pitch zero.
 */
function cryDefFor(cry) {
  if (!cry?.base) return null;
  const base = vanillaCry(cry.base);
  if (!base) return null;
  return {
    address: base.address,
    bank: base.bank,
    pitch: cry.pitch == null ? base.pitch : cry.pitch,
    length: cry.length == null ? base.length : cry.length,
  };
}

/**
 * The sound a move makes, in the same shape the renderer takes.
 *
 * A move record's `anim` is {sound, pitch, tempo} -- an effect to borrow and
 * two modifiers, which is the same arrangement a cry has under different
 * names. `tempo` lands in `length` because both end up as the channel's frame
 * rate: the engine seeds it as 0x80 + the byte either way
 * (ChipAudio.newSfx and Audio_SetSfxTempo). 0x80 is "no shift", which is what
 * every move that does not bend its sound carries.
 */
function moveSoundDef(anim) {
  if (!anim?.sound) return null;
  const base = vanillaSfx(anim.sound);
  if (!base) return null;
  return {
    address: base.address,
    bank: base.bank,
    pitch: anim.pitch || 0,
    length: anim.tempo == null ? 0x80 : anim.tempo,
  };
}

// Every sound the game's own moves reach for, in the order a person would
// scan them: the battle bank first (which is nearly all of them), then the
// named one-offs. The other ~60 effects in the ROM are menu beeps and doors,
// and offering those as a move's sound is a worse list, not a longer one.
function moveSoundOptions() {
  const all = GAME?.audio?.sfx || {};
  const used = new Set();
  for (const rec of Object.values(GAME?.moves || {})) if (rec?.anim?.sound) used.add(rec.anim.sound);
  const inGame = [...used].filter((n) => all[n]);
  const battle = inGame.filter((n) => n.startsWith("Battle_")).sort();
  const named = inGame.filter((n) => !n.startsWith("Battle_")).sort();
  return [...battle, ...named];
}

// Which of the game's moves already use a given sound -- the only label that
// makes "Battle_2F" mean anything to a person.
function movesUsingSound(name) {
  const out = [];
  for (const rec of Object.values(GAME?.moves || {})) {
    if (rec?.anim?.sound === name) out.push(rec.name || rec.id);
  }
  return out.sort();
}

/* ---------------------------------------------------- importing real audio -- */

/**
 * A cry and a move's sound are both, natively, a program run on the Game
 * Boy's own sound chip -- that is what playCry()/renderCry() above actually
 * synthesize, and why the vanilla editors are sliders over an existing
 * program rather than a file picker. But the engine's own `cries` and `sfx`
 * registries both document a second shape, `{file}`, that skips the chip
 * entirely: love.audio plays the file straight back (Sound.lua's
 * newFileSource -- the same route Yellow's own voiced Pikachu clips take).
 * So a REAL recording is a genuinely supported alternative, not a hack; this
 * is the shared UI for it, appended below the synth editor in both the
 * Pokemon workspace's cry step and the Moves workspace's sound step.
 *
 * `get()` returns the current import (`{name, ext, b64}`) or null; `set(v)`
 * writes a new one or clears it with null; `onChange()` re-renders the
 * caller's step. Kept file-format-agnostic on purpose -- OGG/WAV/MP3 are all
 * things a browser can read back for the preview and love.audio can play in
 * the game, so nothing here validates beyond "did a file get picked."
 */
function renderAudioImport(host, get, set, onChange) {
  const cur = get();
  host.append(el("h2", { style: "margin-top:14px" }, "Or import a recording"));
  host.append(el("p", { class: "hint" },
    "Ships the file itself in the mod instead of a chip program — love.audio plays it back "
    + "directly, the same route the game's own voiced Pikachu clips use. OGG or WAV is safest; "
    + "most browsers can also read back an MP3 to preview it here."));

  const input = el("input", { type: "file", accept: "audio/*" });
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || "ogg").toLowerCase();
    set({ name: f.name, ext, b64 });
    onChange();
  };
  host.append(input);

  if (cur) {
    host.append(el("p", { class: "hint good", style: "margin-top:6px" }, "Imported: " + cur.name));
    host.append(el("div", { class: "row" },
      el("button", { class: "fixed", onclick: () => playImportedAudio(cur) }, "▶ Play it"),
      el("button", { class: "fixed danger", onclick: () => { set(null); onChange(); } }, "Remove")));
  }
}

// A plain <audio> element, not the chip synth above -- this previews exactly
// the bytes that will ship, so it has nothing to do with how the game plays
// them back (love.audio) beyond decoding the same file format.
let importedAudioEl = null;
function playImportedAudio(cur) {
  if (importedAudioEl) { try { importedAudioEl.pause(); } catch { /* already gone */ } }
  const mime = cur.ext === "mp3" ? "mpeg" : cur.ext === "wav" ? "wav" : cur.ext === "ogg" ? "ogg" : cur.ext;
  importedAudioEl = new Audio(`data:audio/${mime};base64,${cur.b64}`);
  importedAudioEl.play().catch(() => toast("This browser can't preview that file, but it may still work in the game", true));
}
