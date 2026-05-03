// Shared flock-physics module.
//
// Pure JS — no browser APIs, no WebGL. Imported by:
//   - worker.js  (server-side bake → loop blob in R2)
//   - embed/index.html mirrors this code inline today; until that page is
//     refactored to import the module, keep the two copies in sync. The
//     constants and functions here MUST match what's in embed/index.html
//     section "INIT TOKEN STATE" / "physics step".
//
// `runBake(walletAddr, metaTokens)` returns Float32 buffers of positions
// and forwards over LOOP_FRAMES, identical in shape to what the browser
// recording captured. Worker quantizes + gzips + stores; browser
// dequantizes and replays.

// ── Loop sizing ─────────────────────────────────────────────────────────
export const LOOP_FPS         = 30;
export const LOOP_SECONDS     = 30;
export const LOOP_FRAMES      = LOOP_FPS * LOOP_SECONDS;     // 900
export const LOOP_FADE_FRAMES = LOOP_FPS;                     // 1 s cross-fade
export const FRAME_DT         = 1 / LOOP_FPS;

// ── Physics constants — keep in sync with embed/index.html ─────────────
const ADVECT_SPEED       = 0.013;
const FLOCK_ALIGN        = 0.55;
const FLOCK_COHESION     = 0.35;
const FLOCK_REST_ARC     = 0.18;
const SEPARATION_RADIUS  = 1.1;
const SEPARATION_STRENGTH = 0.20;
const POLE_THRESHOLD     = 0.65;
const POLE_PUSH_MAX      = 0.55;
const LAYER_COUNT        = 4;
const LAYER_INNER_R      = 0.78;
const LAYER_OUTER_R      = 1.18;
const BIG_WAVE_MIN       = 5;
const BIG_WAVE_AMP       = 0.005 * 2.6;     // WAVE_AMPLITUDE × 2.6
const SPAWN_SPREAD_TIGHT = 0.22;
const SPAWN_SPREAD_BASE  = 1.20;

// ── Deterministic PRNG (mulberry32) — must produce identical sequence
// in browser and Cloudflare Worker (both V8) given the same seed. Math.imul
// is portable.
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── tangentFlow: vector field tangent to the unit sphere, used as base
// swirl underneath the flocking forces. Same structure as embed.
function tangentFlow(px, py, pz, t, out) {
  const a1x = Math.sin(t * 0.04), a1y = 1.0,                  a1z = Math.cos(t * 0.05);
  const a2x = 1.0,                a2y = Math.sin(t * 0.06) * 0.6, a2z = Math.cos(t * 0.03);
  const a3x = Math.cos(t * 0.05), a3y = Math.sin(t * 0.04),   a3z = 0.8;

  const s1 = 0.95;
  const tax = Math.sin(px * s1 + t * 0.28) + Math.cos(pz * s1 * 1.1 - t * 0.19);
  const tay = Math.sin(py * s1 * 0.9 + t * 0.24) + Math.cos(px * s1 * 0.8 - t * 0.21);
  const taz = Math.cos(px * s1 * 1.2 + t * 0.17) + Math.sin(py * s1 * 1.1 - t * 0.23);

  const s2 = 2.7;
  const tbx = Math.sin(py * s2 + t * 0.55) - Math.cos(pz * s2 * 0.9 + t * 0.48);
  const tby = Math.cos(pz * s2 * 1.1 + t * 0.61) + Math.sin(px * s2 - t * 0.52);
  const tbz = Math.sin(px * s2 * 0.9 + t * 0.46) - Math.cos(py * s2 + t * 0.58);

  const gx = Math.sin(t * 0.11) * 0.9 + Math.cos(t * 0.07) * 0.4;
  const gy = Math.cos(t * 0.09) * 0.8 + Math.sin(t * 0.13) * 0.35;
  const gz = Math.sin(t * 0.10) * 1.0 - Math.cos(t * 0.08) * 0.5;

  let vx =
    (a1y * pz - a1z * py) * 0.55 + (a2y * pz - a2z * py) * 0.32 + (a3y * pz - a3z * py) * 0.18
    + (tay * pz - taz * py) * 0.42 + (tby * pz - tbz * py) * 0.26
    + (gy  * pz - gz  * py) * 0.22;
  let vy =
    (a1z * px - a1x * pz) * 0.55 + (a2z * px - a2x * pz) * 0.32 + (a3z * px - a3x * pz) * 0.18
    + (taz * px - tax * pz) * 0.42 + (tbz * px - tbx * pz) * 0.26
    + (gz  * px - gx  * pz) * 0.22;
  let vz =
    (a1x * py - a1y * px) * 0.55 + (a2x * py - a2y * px) * 0.32 + (a3x * py - a3y * px) * 0.18
    + (tax * py - tay * px) * 0.42 + (tbx * py - tby * px) * 0.26
    + (gx  * py - gy  * px) * 0.22;

  const d = vx * px + vy * py + vz * pz;
  out[0] = vx - d * px;
  out[1] = vy - d * py;
  out[2] = vz - d * pz;
}

// ── State init: groups tokens by collection, seeds per-collection state
// (centroid seed, orbit axis, big-wave phase), then spawns each token
// near its collection seed. Output is a state object that step() mutates.
//
// metaTokens is an array of { collection, contract, tokenId } from the
// atlas meta JSON (worker reads it from R2).
export function initState(walletAddr, metaTokens) {
  const N = metaTokens.length;
  const rng = mulberry32(seedFromString(walletAddr));

  // Group token indices by collection
  const collMap = new Map();
  for (let i = 0; i < N; i++) {
    const c = metaTokens[i].collection || 'unknown';
    if (!collMap.has(c)) collMap.set(c, []);
    collMap.get(c).push(i);
  }
  const collections = Array.from(collMap.entries()).sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );

  const collectionIdx = new Int32Array(N);
  collections.forEach(([, idxs], ci) => { idxs.forEach(i => { collectionIdx[i] = ci; }); });

  const tokens = new Array(N);
  for (let i = 0; i < N; i++) {
    tokens[i] = {
      pos:       [1, 0, 0],
      forward:   [0, 1, 0],
      phaseSeed: 0,
    };
  }

  const collectionData = collections.map(([name, idxs]) => ({
    name,
    indices:      idxs,
    seed:         [1, 0, 0],
    seedFwd:      [0, 1, 0],
    centroid:     [1, 0, 0],
    avgFwd:       [0, 1, 0],
    activeCount:  idxs.length,
    bigPhase:     0,
    bigAmp:       idxs.length >= BIG_WAVE_MIN ? BIG_WAVE_AMP : 0,
    radiusOffset: 1.0,
    radiusPhase:  0,
    radiusFreq:   0.05,
    separation:   [0, 0, 0],
    orbitAxis:    [1, 0, 0],
    orbitFreq:    0,
  }));

  // Seed per-collection state (orbit axes, radius cycle, big wave phase)
  for (const cd of collectionData) {
    const theta = rng() * Math.PI * 2;
    const phi   = Math.acos(2 * rng() - 1);
    cd.seed[0] = Math.sin(phi) * Math.cos(theta);
    cd.seed[1] = Math.sin(phi) * Math.sin(theta);
    cd.seed[2] = Math.cos(phi);
    const sx = rng() - 0.5, sy = rng() - 0.5, sz = rng() - 0.5;
    const sd = sx * cd.seed[0] + sy * cd.seed[1] + sz * cd.seed[2];
    let fx = sx - sd * cd.seed[0];
    let fy = sy - sd * cd.seed[1];
    let fz = sz - sd * cd.seed[2];
    const fm = Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-9;
    cd.seedFwd[0] = fx / fm;
    cd.seedFwd[1] = fy / fm;
    cd.seedFwd[2] = fz / fm;
    cd.centroid[0] = cd.seed[0]; cd.centroid[1] = cd.seed[1]; cd.centroid[2] = cd.seed[2];
    cd.avgFwd[0]   = cd.seedFwd[0]; cd.avgFwd[1] = cd.seedFwd[1]; cd.avgFwd[2] = cd.seedFwd[2];
    cd.bigPhase    = rng() * Math.PI * 2;
    cd.radiusPhase = rng() * Math.PI * 2;
    cd.radiusFreq  = 0.06 + rng() * 0.10;
    cd.radiusOffset = (LAYER_INNER_R + LAYER_OUTER_R) / 2;
    const oax = rng() - 0.5, oay = rng() - 0.5, oaz = rng() - 0.5;
    const oaMag = Math.sqrt(oax * oax + oay * oay + oaz * oaz) + 1e-9;
    cd.orbitAxis = [oax / oaMag, oay / oaMag, oaz / oaMag];
    cd.orbitFreq = (0.008 + rng() * 0.017) * (rng() < 0.5 ? -1 : 1);
  }

  // Spawn tokens clustered near their collection seed
  const spawnSpread = SPAWN_SPREAD_TIGHT + SPAWN_SPREAD_BASE * Math.exp(-N / 12);
  for (let i = 0; i < N; i++) {
    const cd = collectionData[collectionIdx[i]];
    const a  = rng() * Math.PI * 2;
    const r  = Math.sqrt(rng()) * spawnSpread;
    const sp = cd.seed;
    let ux = sp[1], uy = -sp[0], uz = 0;
    if (Math.sqrt(ux * ux + uy * uy + uz * uz) < 1e-3) { ux = 1; uy = 0; uz = 0; }
    const um = Math.sqrt(ux * ux + uy * uy + uz * uz) + 1e-9;
    ux /= um; uy /= um; uz /= um;
    const vx = sp[1] * uz - sp[2] * uy;
    const vy = sp[2] * ux - sp[0] * uz;
    const vz = sp[0] * uy - sp[1] * ux;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ox = ux * ca + vx * sa, oy = uy * ca + vy * sa, oz = uz * ca + vz * sa;
    const c = Math.cos(r), sA = Math.sin(r);
    let px = sp[0] * c + ox * sA, py = sp[1] * c + oy * sA, pz = sp[2] * c + oz * sA;
    const pm = Math.sqrt(px * px + py * py + pz * pz) + 1e-9;
    px /= pm; py /= pm; pz /= pm;
    const jx = (rng() - 0.5) * 0.4, jy = (rng() - 0.5) * 0.4, jz = (rng() - 0.5) * 0.4;
    let fwx = cd.seedFwd[0] + jx, fwy = cd.seedFwd[1] + jy, fwz = cd.seedFwd[2] + jz;
    const fd = fwx * px + fwy * py + fwz * pz;
    fwx -= fd * px; fwy -= fd * py; fwz -= fd * pz;
    const fwm = Math.sqrt(fwx * fwx + fwy * fwy + fwz * fwz) + 1e-9;
    tokens[i].pos[0] = px; tokens[i].pos[1] = py; tokens[i].pos[2] = pz;
    tokens[i].forward[0] = fwx / fwm;
    tokens[i].forward[1] = fwy / fwm;
    tokens[i].forward[2] = fwz / fwm;
    tokens[i].phaseSeed  = rng() * 6.2831853;
  }

  return { N, tokens, collectionData, collectionIdx };
}

// ── One physics step. Mutates state.tokens and state.collectionData.
// `t` is simulation time in seconds.
export function stepFrame(state, t) {
  const { N, tokens, collectionData, collectionIdx } = state;
  const vbuf = [0, 0, 0];

  // Per-collection centroid + average heading
  for (let ci = 0; ci < collectionData.length; ci++) {
    const cd = collectionData[ci];
    let cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0;
    const idxs = cd.indices;
    for (let k = 0; k < idxs.length; k++) {
      const tk = tokens[idxs[k]];
      cx += tk.pos[0]; cy += tk.pos[1]; cz += tk.pos[2];
      ax += tk.forward[0]; ay += tk.forward[1]; az += tk.forward[2];
    }
    cd.activeCount = idxs.length;
    const cm = Math.sqrt(cx * cx + cy * cy + cz * cz) + 1e-9;
    cd.centroid[0] = cx / cm; cd.centroid[1] = cy / cm; cd.centroid[2] = cz / cm;
    const am = Math.sqrt(ax * ax + ay * ay + az * az) + 1e-9;
    cd.avgFwd[0] = ax / am; cd.avgFwd[1] = ay / am; cd.avgFwd[2] = az / am;
  }

  // Inter-collection separation (Reynolds #3)
  const C = collectionData.length;
  for (let ci = 0; ci < C; ci++) {
    const a = collectionData[ci];
    let sx = 0, sy = 0, sz = 0;
    for (let cj = 0; cj < C; cj++) {
      if (cj === ci) continue;
      const b = collectionData[cj];
      const dx = a.centroid[0] - b.centroid[0];
      const dy = a.centroid[1] - b.centroid[1];
      const dz = a.centroid[2] - b.centroid[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
      const d = Math.sqrt(d2) + 1e-6;
      const u = 1 - d / SEPARATION_RADIUS;
      const w = u * u;
      sx += (dx / d) * w;
      sy += (dy / d) * w;
      sz += (dz / d) * w;
    }
    const ax2 = a.centroid[0], ay2 = a.centroid[1], az2 = a.centroid[2];
    const sd = sx * ax2 + sy * ay2 + sz * az2;
    sx -= sd * ax2; sy -= sd * ay2; sz -= sd * az2;
    a.separation[0] = sx;
    a.separation[1] = sy;
    a.separation[2] = sz;
  }

  // Per-token integration
  for (let i = 0; i < N; i++) {
    const tok = tokens[i];
    tangentFlow(tok.pos[0], tok.pos[1], tok.pos[2], t + tok.phaseSeed, vbuf);

    const cd = collectionData[collectionIdx[i]];
    if (cd.activeCount > 1) {
      const px = tok.pos[0], py = tok.pos[1], pz = tok.pos[2];
      let chx = cd.centroid[0] - px;
      let chy = cd.centroid[1] - py;
      let chz = cd.centroid[2] - pz;
      const chd = chx * px + chy * py + chz * pz;
      chx -= chd * px; chy -= chd * py; chz -= chd * pz;
      const chm = Math.sqrt(chx * chx + chy * chy + chz * chz);
      if (chm > FLOCK_REST_ARC) {
        const falloff = (chm - FLOCK_REST_ARC) / chm;
        vbuf[0] += chx * falloff * FLOCK_COHESION;
        vbuf[1] += chy * falloff * FLOCK_COHESION;
        vbuf[2] += chz * falloff * FLOCK_COHESION;
      }
      let alx = cd.avgFwd[0], aly = cd.avgFwd[1], alz = cd.avgFwd[2];
      const ald = alx * px + aly * py + alz * pz;
      alx -= ald * px; aly -= ald * py; alz -= ald * pz;
      vbuf[0] += alx * FLOCK_ALIGN;
      vbuf[1] += aly * FLOCK_ALIGN;
      vbuf[2] += alz * FLOCK_ALIGN;
    }

    vbuf[0] += cd.separation[0] * SEPARATION_STRENGTH;
    vbuf[1] += cd.separation[1] * SEPARATION_STRENGTH;
    vbuf[2] += cd.separation[2] * SEPARATION_STRENGTH;

    const ay = Math.abs(tok.pos[1]);
    if (ay > POLE_THRESHOLD) {
      const k = (ay - POLE_THRESHOLD) / (1 - POLE_THRESHOLD);
      vbuf[1] -= Math.sign(tok.pos[1]) * k * POLE_PUSH_MAX;
    }

    const vm = Math.sqrt(vbuf[0] * vbuf[0] + vbuf[1] * vbuf[1] + vbuf[2] * vbuf[2]) + 1e-9;
    let fx = vbuf[0] / vm, fy = vbuf[1] / vm, fz = vbuf[2] / vm;

    let nx = tok.pos[0] + fx * ADVECT_SPEED;
    let ny = tok.pos[1] + fy * ADVECT_SPEED;
    let nz = tok.pos[2] + fz * ADVECT_SPEED;
    const m = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= m; ny /= m; nz /= m;
    tok.pos[0] = nx; tok.pos[1] = ny; tok.pos[2] = nz;

    const d2 = fx * nx + fy * ny + fz * nz;
    fx -= d2 * nx; fy -= d2 * ny; fz -= d2 * nz;
    let fm2 = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (fm2 < 1e-6) {
      fx = tok.forward[0]; fy = tok.forward[1]; fz = tok.forward[2];
      const d3 = fx * nx + fy * ny + fz * nz;
      fx -= d3 * nx; fy -= d3 * ny; fz -= d3 * nz;
      fm2 = Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-6;
    }
    fx /= fm2; fy /= fm2; fz /= fm2;

    const blend = 0.22;
    let ssx = tok.forward[0] * (1 - blend) + fx * blend;
    let ssy = tok.forward[1] * (1 - blend) + fy * blend;
    let ssz = tok.forward[2] * (1 - blend) + fz * blend;
    const sd2 = ssx * nx + ssy * ny + ssz * nz;
    ssx -= sd2 * nx; ssy -= sd2 * ny; ssz -= sd2 * nz;
    const sm = Math.sqrt(ssx * ssx + ssy * ssy + ssz * ssz) + 1e-9;
    tok.forward[0] = ssx / sm;
    tok.forward[1] = ssy / sm;
    tok.forward[2] = ssz / sm;
  }
}

// ── runBake: full LOOP_FRAMES recording.
// Returns { recPos, recFwd, frames, N } as Float32Array buffers laid out
// frame-major: [frame * N * 3 + i * 3 + axis].
// Cross-fades the last LOOP_FADE_FRAMES toward frame 0 so the loop wraps
// without a pop.
export function runBake(walletAddr, metaTokens) {
  const state = initState(walletAddr, metaTokens);
  const { N } = state;
  const recPos = new Float32Array(LOOP_FRAMES * N * 3);
  const recFwd = new Float32Array(LOOP_FRAMES * N * 3);

  for (let f = 0; f < LOOP_FRAMES; f++) {
    const t = f * FRAME_DT;
    stepFrame(state, t);
    const off = f * N * 3;
    for (let i = 0; i < N; i++) {
      const tok = state.tokens[i];
      const o3 = off + i * 3;
      recPos[o3]     = tok.pos[0];
      recPos[o3 + 1] = tok.pos[1];
      recPos[o3 + 2] = tok.pos[2];
      recFwd[o3]     = tok.forward[0];
      recFwd[o3 + 1] = tok.forward[1];
      recFwd[o3 + 2] = tok.forward[2];
    }
  }

  // Cross-fade last LOOP_FADE_FRAMES toward frame 0
  const samples = N * 3;
  for (let k = 0; k < LOOP_FADE_FRAMES; k++) {
    const alpha   = (k + 1) / LOOP_FADE_FRAMES;
    const fadeOff = (LOOP_FRAMES - LOOP_FADE_FRAMES + k) * samples;
    for (let i = 0; i < samples; i++) {
      recPos[fadeOff + i] = recPos[fadeOff + i] * (1 - alpha) + recPos[i] * alpha;
      recFwd[fadeOff + i] = recFwd[fadeOff + i] * (1 - alpha) + recFwd[i] * alpha;
    }
  }

  return { recPos, recFwd, frames: LOOP_FRAMES, N };
}

// ── Wire-format encode: 16-byte header + frame-major int16 payload.
// Mirrors decodeLoopBuffer in embed/index.html. Returns Uint8Array.
export const LOOP_MAGIC        = 0x4C545344; // 'DSTL' little-endian
export const LOOP_VERSION      = 1;
export const LOOP_HEADER_BYTES = 16;
export const LOOP_POS_SCALE    = 16384;
export const LOOP_FWD_SCALE    = 32767;

export function encodeLoopBlob({ recPos, recFwd, frames, N }) {
  const total = LOOP_HEADER_BYTES + frames * N * 6 * 2;
  const buf = new ArrayBuffer(total);
  const dv  = new DataView(buf);
  dv.setUint32(0, LOOP_MAGIC, true);
  dv.setUint8(4, LOOP_VERSION);
  dv.setUint8(5, 0);
  dv.setUint16(6, frames, true);
  dv.setUint16(8, N, true);
  dv.setFloat32(10, LOOP_POS_SCALE, true);
  dv.setInt16(14, LOOP_FWD_SCALE, true);
  const data = new Int16Array(buf, LOOP_HEADER_BYTES);
  const POS_LIM = 32767;
  let qi = 0, ri = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      let qx = Math.round(recPos[ri]     * LOOP_POS_SCALE);
      let qy = Math.round(recPos[ri + 1] * LOOP_POS_SCALE);
      let qz = Math.round(recPos[ri + 2] * LOOP_POS_SCALE);
      if (qx >  POS_LIM) qx =  POS_LIM; else if (qx < -POS_LIM) qx = -POS_LIM;
      if (qy >  POS_LIM) qy =  POS_LIM; else if (qy < -POS_LIM) qy = -POS_LIM;
      if (qz >  POS_LIM) qz =  POS_LIM; else if (qz < -POS_LIM) qz = -POS_LIM;
      data[qi]     = qx;
      data[qi + 1] = qy;
      data[qi + 2] = qz;
      data[qi + 3] = Math.round(recFwd[ri]     * LOOP_FWD_SCALE);
      data[qi + 4] = Math.round(recFwd[ri + 1] * LOOP_FWD_SCALE);
      data[qi + 5] = Math.round(recFwd[ri + 2] * LOOP_FWD_SCALE);
      qi += 6;
      ri += 3;
    }
  }
  return new Uint8Array(buf);
}
