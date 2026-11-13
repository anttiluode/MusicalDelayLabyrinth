// node tests/test.js — runs the engine exactly as shipped in index.html. ~2 minutes.
const fs = require('fs'), crypto = require('crypto');
const src = fs.readFileSync(__dirname + '/../index.html', 'utf8').match(/<script id="ml-engine">\n?([\s\S]*?)<\/script>/)[1];
const ML = new Function(src.replace(/if \(typeof module[^\n]*/, '') + '\nreturn ML;')();
const sr = 48000, out = []; let fails = 0;
const check = (name, pass, d) => { out.push({ name, pass, ...d }); if (!pass) fails++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(d)}`); };
check('Engine in index.html is byte-identical to src/engine.js', src === fs.readFileSync(__dirname + '/../src/engine.js', 'utf8'), {});

function grow(seed, bpm, secs, learn, P = {}) {
  const lab = new ML.Lab(seed, sr, Object.assign({ learn }, P)), g = ML.makeGroove(bpm, secs, sr), L = new Float32Array(sr), R = new Float32Array(sr);
  for (let s = 0; s < secs; s++) lab.process(g.subarray(s * sr, (s + 1) * sr), L, R, sr);
  return lab;
}
const offGrid = (lab, bpm) => { const half = 30 / bpm; return lab.dir.map(e => Math.abs(e.D / sr - Math.round(e.D / sr / half) * half) * 1000); };
function tail(lab, secs = 10) { const L = new Float32Array(secs * sr), R = new Float32Array(secs * sr); lab.process(null, L, R, secs * sr); return [L, R]; }
function rhythm([L, R], bpm) {  // onset autocorrelation of the tail at 1/2, 1, 2 beats vs three off-grid lags
  const blk = 256, nb = Math.floor(L.length / blk), on = new Float64Array(nb); let sl = 0;
  for (let b = 0; b < nb; b++) { let s = 0; for (let i = 0; i < blk; i++) s += L[b * blk + i] ** 2 + R[b * blk + i] ** 2; const e = Math.sqrt(s / blk); sl += 0.1 * (e - sl); on[b] = Math.max(0, e - sl); }
  const ac = lag => { let s = 0; for (let b = 0; b + lag < nb; b++) s += on[b] * on[b + lag]; return s / (nb - lag); }, a0 = ac(0) || 1, lag = x => Math.round(x * sr / blk), beat = 60 / bpm;
  const onGrid = [0.5, 1, 2].map(m => ac(lag(m * beat)) / a0), off = [0.37, 0.71, 1.13].map(m => ac(lag(m * beat)) / a0);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { onBeat: +mean(onGrid).toFixed(3), offBeat: +mean(off).toFixed(3) };
}
const rms = ([L, R], from) => { let s = 0, n = 0; for (let i = from; i < L.length; i++) { s += L[i] * L[i] + R[i] * R[i]; n += 2; } return Math.sqrt(s / n); };

// determinism
{ const a = grow(7, 96, 10, 1), b = grow(7, 96, 10, 1), h = l => crypto.createHash('sha1').update(Buffer.from(Float64Array.from(l.dir.flatMap(e => [e.D, e.w])).buffer)).digest('hex').slice(0, 12);
  check('Same seed + same song gives identical delays and weights', h(a) === h(b), { a: h(a), b: h(b) }); }
// stability: loud noise at maximum memory stays bounded; silence then fades
{ const lab = new ML.Lab(3, sr, { rho: 0.99 }), r = ML.xorshift(9), x = new Float32Array(10 * sr).map(() => 2 * r() - 1), L = new Float32Array(x.length), R = new Float32Array(x.length);
  lab.process(x, L, R, x.length); let pk = 0; for (const v of L) pk = Math.max(pk, Math.abs(v));
  const t = tail(lab, 30), early = rms(t, 0) , late = rms(t, 25 * sr);
  check('Bounded under loud noise at memory 0.99, and fades in silence', pk < 2 && late < early, { peak: +pk.toFixed(3), rms0to30s: +early.toExponential(2), rms25to30s: +late.toExponential(2) }); }

// the main claims, three labyrinths x two tempos, learning on vs off
const rows = [];
for (const seed of [7, 11, 23]) for (const bpm of [96, 120]) {
  const before = offGrid(new ML.Lab(seed, sr), bpm), on = grow(seed, bpm, 60, 1), off = grow(seed, bpm, 60, 0);
  const a = offGrid(on, bpm), within = v => v.filter(x => x < 15).length;
  const rOn = rhythm(tail(on), bpm), rOff = rhythm(tail(off), bpm), gold = on.dir.filter(e => e.w > 0.6).length;
  rows.push({ seed, bpm, corridors: a.length, within15msBefore: within(before), within15msAfter: within(a), goldAfter: gold, tailOnBeat: rOn.onBeat, tailOffBeat: rOn.offBeat, controlOnBeat: rOff.onBeat, controlOffBeat: rOff.offBeat });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
check('Corridors retime onto the groove (more within 15 ms of the half-beat grid after 60 s, every run)', rows.every(r => r.within15msAfter > r.within15msBefore), {});
check('After the song stops, a learned labyrinth keeps the beat (tail onsets repeat more on-beat than off-beat, every run)', rows.every(r => r.tailOnBeat > r.tailOffBeat), {});
check('...and more than the same labyrinth that did not learn (every run)', rows.every(r => r.tailOnBeat - r.tailOffBeat > r.controlOnBeat - r.controlOffBeat), {});
fs.writeFileSync(__dirname + '/../results/tests.json', JSON.stringify({ date: new Date().toISOString(), checks: out, runs: rows }, null, 1));
console.log(`\n${out.length - fails}/${out.length} passed`); process.exit(fails ? 1 : 0);
