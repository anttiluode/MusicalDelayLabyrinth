// Musical Delay Labyrinth — engine. The page's AudioWorklet and the Node tests run exactly this code.
//
// A maze of rooms. Every corridor between two rooms is a pair of delay lines (one each way):
// sound takes D seconds to walk through it, and the corridor's length on screen is that time.
// The song enters at the gate room. Every room sums what arrives, colours it with its own
// resonance, and sends it on down its corridors. You hear all rooms, panned by position.
//
// Learning is about TIME, not loudness:
//   - each corridor compares when its echoes arrive with when the song's own onsets happen;
//     if the echo lands a little before a song onset it lengthens, a little after it shortens
//     (an odd, signed timing error: this is what lets it lock, a power measure cannot);
//   - corridors whose echoes land on the song's onsets win a larger share of their room's output.
// Stability is by construction: rooms average their inputs, never amplify, and split at most
// a fraction rho ("memory") of their energy among their corridors. So the labyrinth always
// fades eventually; how long it keeps singing is set by rho.
'use strict';
const ML = (() => {
  const MAXD = 2.0, MIND = 0.12, BLOCK = 128;
  function xorshift(seed) { let s = (seed >>> 0) || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const SCALE = [0, 3, 5, 7, 10];  // minor pentatonic

  function makeMaze(seed, C = 6, R = 4) {
    const r = xorshift(seed), rooms = [], edges = [];
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
      const deg = SCALE[Math.floor(r() * 5)], oct = Math.floor(r() * 3);
      rooms.push({ x, y, f: 110 * Math.pow(2, (deg + 12 * oct) / 12) * 2 });
    }
    const id = (x, y) => y * C + x, seen = new Uint8Array(C * R), stack = [0]; seen[0] = 1;
    const has = new Set(), key = (a, b) => a < b ? a + ',' + b : b + ',' + a;
    const nbrs = i => { const x = i % C, y = (i / C) | 0, o = []; if (x > 0) o.push(id(x - 1, y)); if (x < C - 1) o.push(id(x + 1, y)); if (y > 0) o.push(id(x, y - 1)); if (y < R - 1) o.push(id(x, y + 1)); return o; };
    const delay = () => MIND + 0.1 + r() * 1.25;
    while (stack.length) { // randomized depth-first maze
      const i = stack[stack.length - 1], free = nbrs(i).filter(j => !seen[j]);
      if (!free.length) { stack.pop(); continue; }
      const j = free[Math.floor(r() * free.length)]; seen[j] = 1; stack.push(j); has.add(key(i, j)); edges.push([i, j, delay()]);
    }
    let extra = Math.round(C * R / 4);
    for (let tries = 0; extra > 0 && tries < 500; tries++) { const i = Math.floor(r() * C * R), ns = nbrs(i), j = ns[Math.floor(r() * ns.length)];
      if (!has.has(key(i, j))) { has.add(key(i, j)); edges.push([i, j, delay()]); extra--; } }
    return { C, R, rooms, edges };
  }

  class Lab {
    constructor(seed = 7, sr = 48000, P = {}) {
      this.sr = sr; this.seed = seed;
      this.P = Object.assign({ rho: 0.96, learn: 1, eta: 2.0, alpha: 0.02, dry: 0.78, wet: 0.22, drive: 1.6, loss: 0.55 }, P);
      this.L = Math.ceil(MAXD * sr) + 4; this.t = 0;
      const m = makeMaze(seed); this.C = m.C; this.R = m.R;
      this.rooms = m.rooms.map(o => this.mkRoom(o));
      this.cors = [];
      for (const [a, b, d] of m.edges) this.open(a, b, d);
      this.gate = 0; this.inEnv = 0; this.inSlow = 0; this.inOn = new Float32Array(128); this.blk = 0; this.acc = 0; this.nacc = 0; this.heard = 0;
      this.renorm();
    }
    mkRoom(o) {
      const w = 2 * Math.PI * o.f / this.sr, q = 3.5, al = Math.sin(w) / (2 * q), a0 = 1 + al;
      return Object.assign({}, o, { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0, z: 0, s: 0, env: 0, ins: [], outs: [] });
    }
    // a corridor is two directed delay lines that share a visual path
    open(a, b, d) {
      const mk = (from, to) => ({ from, to, D: d * this.sr, buf: new Float32Array(this.L), lp: 0, y: 0, w: 0.5, g: 0, env: 0, slow: 0, on: new Float32Array(128), late: 0, early: 0, sync: 0, pow: 0 });
      const p = { a, b, ab: mk(a, b), ba: mk(b, a) };
      this.cors.push(p); this.relink(); return p;
    }
    close(a, b) { this.cors = this.cors.filter(c => !((c.a === a && c.b === b) || (c.a === b && c.b === a))); this.relink(); }
    relink() {
      for (const r of this.rooms) { r.ins = []; r.outs = []; }
      for (const c of this.cors) for (const e of [c.ab, c.ba]) { this.rooms[e.from].outs.push(e); this.rooms[e.to].ins.push(e); }
      this.dir = this.cors.flatMap(c => [c.ab, c.ba]); this.renorm();
    }
    // each room shares at most rho of its energy among its corridors, in proportion to their weights
    renorm() {
      const sq = Math.sqrt(this.P.rho);
      for (const r of this.rooms) { let s = 0; for (const e of r.outs) s += e.w * e.w; const k = s > 0 ? sq / Math.sqrt(s) : 0; for (const e of r.outs) e.g = e.w * k; }
    }
    poke(room, amp = 0.8) { this.rooms[room].kick = amp; }

    // input: Float32Array or null; outL/outR: Float32Array(n)
    process(input, outL, outR, n) {
      const L = this.L, P = this.P, rooms = this.rooms, dir = this.dir, nR = rooms.length, C = this.C;
      const inNorm = 1 / Math.sqrt(nR);
      for (let i = 0; i < n; i++) {
        const t = this.t, x = input ? input[i] : 0;
        // read every corridor at its (fractional) delay, with a little loss of brightness per pass
        for (let k = 0; k < dir.length; k++) {
          const e = dir[k]; let p = t - e.D; while (p < 0) p += L;
          const i0 = Math.floor(p), fr = p - i0, a = e.buf[i0 % L], b = e.buf[(i0 + 1) % L];
          e.lp += P.loss * ((a + (b - a) * fr) - e.lp); e.y = e.lp;
        }
        let oL = 0, oR = 0;
        for (let r = 0; r < nR; r++) {
          const R = rooms[r]; let s = 0;
          for (let k = 0; k < R.ins.length; k++) s += R.ins[k].y;
          s = R.ins.length ? s / Math.sqrt(R.ins.length) : 0;
          if (r === this.gate) s += x * P.drive;
          if (R.kick) { s += R.kick; R.kick *= -0.6; if (Math.abs(R.kick) < 1e-3) R.kick = 0; }
          const band = R.b0 * s + R.b2 * R.x2 - R.a1 * R.y1 - R.a2 * R.y2; R.x2 = R.x1; R.x1 = s; R.y2 = R.y1; R.y1 = band;
          let v = P.dry * s + P.wet * band;
          v = v > 3 ? 1 : v < -3 ? -1 : v * (27 + v * v) / (27 + 9 * v * v);   // soft limit, never above |v|
          R.z = v; R.env += 0.002 * (v * v - R.env);
          const px = (R.x + 0.5) / C; oL += v * (1 - px); oR += v * px;
        }
        const w = t % L;
        for (let k = 0; k < dir.length; k++) { const e = dir[k]; e.buf[w] = rooms[e.from].z * e.g; }
        outL[i] = oL * inNorm; outR[i] = oR * inNorm;
        // block statistics for learning
        this.acc += x * x; for (let k = 0; k < dir.length; k++) dir[k].pow += dir[k].y * dir[k].y;
        if (++this.nacc === BLOCK) this.block();
        this.t++;
      }
    }

    block() {
    const P = this.P, dir = this.dir, n = this.nacc, j = this.blk & 127, K = 50;
    const ein = Math.sqrt(this.acc / n); this.acc = 0; this.nacc = 0;
    this.inSlow += 0.04 * (ein - this.inSlow);
    this.inOn[j] = Math.max(0, ein - 1.25 * this.inSlow);
    const active = this.inSlow > 2e-3;
    if (active) this.heard += BLOCK;
    // an echo heard K blocks ago (~133 ms) is compared with the song's onsets up to K blocks
    // before and after it, with triangular weights: a smoothed, signed timing error
    const jc = (this.blk - K) & 127, o = this.inOn;
    for (const e of dir) {
      const env = Math.sqrt(e.pow / n); e.pow = 0;
      e.slow += 0.04 * (env - e.slow); e.env = env;
      e.on[j] = Math.max(0, env - 1.25 * e.slow);
      if (!(P.learn && active)) continue;
      const c = e.on[jc], sc = 1 / (e.slow * this.inSlow + 1e-9);
      let late = 0, early = 0, sync = 0;
      if (c > 0) {
        for (let k = 1; k <= K; k++) { const wk = 1 - k / (K + 1); late += wk * o[(jc + k) & 127]; early += wk * o[(jc - k) & 127]; }
        for (let k = -2; k <= 2; k++) sync += o[(jc + k) & 127];
        late *= c * sc / (K / 2); early *= c * sc / (K / 2); sync *= c * sc / 5;
      }
      e.late += 0.03 * (late - e.late); e.early += 0.03 * (early - e.early); e.sync += 0.03 * (sync - e.sync);
      const err = (e.late - e.early) / (e.late + e.early + 1e-6);          // in [-1, 1]: + means the echo is early
      e.D = Math.min(MAXD * this.sr - 2, Math.max(MIND * this.sr, e.D + P.eta * err));
      const score = (e.sync - 0.5 * (e.late + e.early)) / (e.sync + 0.5 * (e.late + e.early) + 1e-6);
      e.w = Math.min(1, Math.max(0.03, e.w + P.alpha * score * (score > 0 ? 1 - e.w : e.w)));
    }
    if (P.learn && active) this.renorm();
    this.blk++;
  }

    snapshot(samples = 24) {   // for drawing: energy along each corridor, both directions
      const L = this.L, t = this.t, out = [];
      for (const c of this.cors) {
        const seg = e => { const a = new Float32Array(samples); for (let s = 0; s < samples; s++) { const tau = (s + 0.5) / samples * e.D; let p = (t - Math.floor(tau)) % L; if (p < 0) p += L;
            let m = 0; for (let q = 0; q < 48; q++) { const v = e.buf[(p - q + L) % L]; m += v * v; } a[s] = Math.sqrt(m / 48); } return a; };
        out.push({ a: c.a, b: c.b, Dab: c.ab.D / this.sr, Dba: c.ba.D / this.sr, wab: c.ab.w, wba: c.ba.w, eab: seg(c.ab), eba: seg(c.ba) });
      }
      return { cors: out, rooms: this.rooms.map(r => ({ x: r.x, y: r.y, f: r.f, env: Math.sqrt(r.env) })), gate: this.gate, C: this.C, R: this.R, heard: this.heard / this.sr, rho: this.P.rho, learn: this.P.learn };
    }
  }

  // A deterministic groove: kick, snare, hats, bass, chord stabs. bpm, seconds, rate.
  function makeGroove(bpm = 96, seconds = 30, sr = 48000, seed = 3) {
    const n = Math.floor(seconds * sr), out = new Float32Array(n), beat = 60 / bpm, r = xorshift(seed);
    const add = (t0, len, fn) => { const s0 = Math.floor(t0 * sr), m = Math.min(n - s0, Math.floor(len * sr)); for (let i = 0; i < m; i++) out[s0 + i] += fn(i / sr); };
    const bass = [55, 55, 65.4, 49], chord = [[220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]];
    for (let b = 0; b * beat < seconds; b++) {
      const t0 = b * beat, bar = Math.floor(b / 4) % 4;
      add(t0, 0.35, u => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-u * 30)) * u) * Math.exp(-u * 9));        // kick
      if (b % 2 === 1) add(t0, 0.2, u => 0.45 * (r() * 2 - 1) * Math.exp(-u * 22) + 0.2 * Math.sin(2 * Math.PI * 190 * u) * Math.exp(-u * 30)); // snare
      for (const h of [0, 0.5]) add(t0 + h * beat, 0.05, u => 0.12 * (r() * 2 - 1) * Math.exp(-u * 90));   // hats
      if (b % 4 === 0 || b % 4 === 2.5) add(t0, beat * 1.8, u => 0.35 * Math.sin(2 * Math.PI * bass[bar] * u) * Math.exp(-u * 1.5));
      if (b % 4 === 1) for (const f of chord[bar]) add(t0 + beat * 0.5, 0.4, u => 0.09 * Math.sin(2 * Math.PI * f * u) * Math.exp(-u * 6));
    }
    let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i])); for (let i = 0; i < n; i++) out[i] *= 0.8 / pk;
    return out;
  }
  return { Lab, makeMaze, makeGroove, xorshift, MAXD, MIND, BLOCK };
})();
if (typeof module !== 'undefined') module.exports = ML;
