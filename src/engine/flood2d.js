/* 2D overland flow on a raster (local-inertial shallow water, Bates et al. 2010 / de Almeida et al. 2012)
 * US units: ft, s. Cells are row-major from the north-west corner (row 0 = north).
 * Cell types: 0 open (computed), 1 wall (building), 2 stage boundary (lake or depression; level set from the network engine).
 * Faces: qx[r*(nx+1)+c] between (r,c-1) and (r,c), positive to the east; qy[r*nx+c] between (r-1,c) and (r,c), positive to the south.
 * Per step: (A) face flow with semi-implicit friction and a Froude cap, (B) outflow ratio so no open cell drains below zero,
 * (D) depth update with rain (roof rain moved to the nearest open cell), Green-Ampt infiltration on the pervious fraction,
 * optional drain allowance on road cells, and running maxima. Boundary cells keep their level; the net inflow to them is tallied.
 * Point sources (for example SWMM node flooding) add a flow rate (cfs) to one open cell each; they are booked in the ledger as "inflow".
 * Two back ends with the same arithmetic: CPU (JavaScript, Float32 state) and GPU (WebGPU compute, WGSL).
 * Generic engine of the Flood Simulator; derived from the Lake Kathryn flood tab solver (same numerics and tests).
 */
(function (root) {
  "use strict";
  const G = 32.174, KN = 1.486 * 1.486, HMIN = 1e-3, VEL_H = 0.05;   // velocity maxima only where the water is deeper than VEL_H (ft)

  // ------------------------------------------------------------------ grid
  function b64dec(s, T) {
    let bin;
    if (typeof Buffer !== "undefined") { const b = Buffer.from(s, "base64"); bin = new Uint8Array(b.buffer, b.byteOffset, b.length); }
    else { const t = atob(s); bin = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) bin[i] = t.charCodeAt(i); }
    const out = new Uint8Array(bin.length); out.set(bin); return new T(out.buffer);
  }
  /* raw: {nx, ny, dx, z, type, node, n, perv, ks (ft/s), psimd (ft, suction head x IMD), imd (initial moisture deficit, optional), mult, road (Uint16 ids), K (number of boundary nodes)} */
  function makeGrid(raw) {
    const N = raw.nx * raw.ny, g = Object.assign({}, raw, { N });
    g.aux = new Float32Array(4 * N); g.prm = new Float32Array(4 * N);
    let openArea = 0, multSum = 0;
    for (let k = 0; k < N; k++) {
      const t = raw.type[k], info = t | ((t === 2 ? raw.node[k] : 0) << 4) | ((raw.road && raw.road[k] > 0 ? 1 : 0) << 12);
      g.aux[4 * k] = raw.z[k]; g.aux[4 * k + 1] = t === 0 ? raw.mult[k] : 0; g.aux[4 * k + 2] = info; g.aux[4 * k + 3] = raw.imd ? raw.imd[k] : 0;
      g.prm[4 * k] = raw.n[k]; g.prm[4 * k + 1] = raw.perv[k]; g.prm[4 * k + 2] = raw.ks[k]; g.prm[4 * k + 3] = raw.psimd[k];
      if (t === 0) { openArea++; multSum += raw.mult[k]; }
    }
    g.openCells = openArea; g.multSum = multSum;
    return g;
  }
  // ------------------------------------------------------------------ Green-Ampt step (same arithmetic as the WGSL gaStep)
  // Infiltration over one step with water ponded at the surface, SWMM grnampt form: c1 = (suction + ponded depth) x IMD,
  // u - c1 ln(1 + u/(F1 + c1)) = Ks dt, solved by Newton on the cancellation-free form u F1/a + c1 (x - ln(1+x)), x = u/a, a = F1 + c1.
  function xml1p(x) { return x < 0.05 ? x * x * (0.5 - x * (1 / 3 - x * (0.25 - x * (0.2 - x / 6)))) : x - Math.log(1 + x); }
  // cap = water available per unit pervious area. The capacity over the step is at least Ks dt (1 + c1/(F1 + cap)) whenever it is below cap
  // (the rate only falls as F grows), so when that bound reaches cap all the water infiltrates and Newton is skipped.
  function gaStep(F1, ksdt, c1, cap) {
    if (!(ksdt > 0)) return 0; if (!(c1 > 0)) return ksdt;
    if (cap > 0 && cap <= ksdt * (1 + c1 / (F1 + cap))) return cap;
    const a = F1 + c1; let u = ksdt + Math.sqrt(2 * c1 * ksdt); if (F1 > 0) u = Math.min(u, ksdt * (1 + c1 / F1));   // both bound the root from above; Newton then descends monotonically (convex)
    for (let i = 0; i < 12; i++) { const x = u / a, f = u * F1 / a + c1 * xml1p(x) - ksdt, fp = (F1 + c1 * x / (1 + x)) / a, un = Math.max(u - f / Math.max(fp, 1e-12), 1e-12); if (Math.abs(un - u) <= 1e-9 * u) { u = un; break; } u = un; }
    return u;
  }

  // ------------------------------------------------------------------ CPU back end
  class CpuSolver {
    constructor(g) {
      this.g = g; const N = g.N;
      this.st = new Float32Array(4 * N);   // h, F, hmax, tmax (hours)
      this.r = new Float32Array(N).fill(1);
      this.acc = new Float32Array(4 * N);  // infiltration, drain, edge outflow, boundary inflow (boundary cells) / clamp (open cells)
      this.nqx = (g.nx + 1) * g.ny; this.q = new Float32Array(this.nqx + g.nx * (g.ny + 1)); this.qo = new Float32Array(this.q.length);
      this.theta = g.theta ?? 0.8; this.kind = "cpu"; this.src = new Float32Array(N);   // point-source depth rate (ft/s) per cell
      this.vmx = new Float32Array(N); this.dvmx = new Float32Array(N);   // running maxima of speed (ft/s) and depth x speed (ft2/s)
      this.tvx = new Float32Array(N); this.dur = new Float32Array(N); this.durC = new Float32Array(N);   // time of the maximum speed (hours, the chunk-mid convention of tmax) and seconds with depth x speed above dvThresh
      this.dvThresh = g.dvThresh ?? 0.5;   // ft2/s; the lowest depth x velocity class edge in the app (0.5), unless the run sets it
      this.lim = new Uint8Array(N);   // 1 where a face of the cell hit the Froude limiter (flow capped at critical) with water deeper than VEL_H
    }
    async init() { return this; }
    reset() { this.r.fill(1); this.q.fill(0); this.qo.fill(0); this.acc.fill(0); this.st.fill(0); this.src.fill(0); this.vmx.fill(0); this.dvmx.fill(0); this.tvx.fill(0); this.dur.fill(0); this.durC.fill(0); this.lim.fill(0); }
    async readVel() { return { vmax: this.vmx.slice(), dvmax: this.dvmx.slice(), froude: this.lim.slice(), tvmax: this.tvx.slice(), dvdur: this.dur.slice() }; }
    setVel(v) { this.vmx.set(v.vmax); this.dvmx.set(v.dvmax); if (v.froude) this.lim.set(v.froude); if (v.tvmax) this.tvx.set(v.tvmax); if (v.dvdur) this.dur.set(v.dvdur); this.durC.fill(0); }
    setSources(list) { const A = this.g.dx * this.g.dx; this.src.fill(0); for (const s of list || []) this.src[s.cell] += s.rate / A; }
    setBoundary(stages) {
      const g = this.g, a = g.aux, st = this.st;
      for (let k = 0; k < g.N; k++) {
        const info = a[4 * k + 2]; if ((info & 3) !== 2) continue;
        const s = stages[(info >> 4) & 255]; st[4 * k] = Math.max(s - a[4 * k], 0);
      }
    }
    step(dt, rain, drain, tHours, theta) {
      const g = this.g, N = g.N, nx = g.nx, ny = g.ny, a = g.aux, p = g.prm, st = this.st, r = this.r, acc = this.acc, nqx = this.nqx, dx = g.dx;
      const qo = this.q, q = this.qo; this.q = q; this.qo = qo;   // qo: previous step, q: this step
      const sqKN = Math.sqrt(KN), gdt = G * dt, th = theta ?? this.theta, th2 = (1 - th) / 2, lim = this.lim;
      let hm = 0;
      // (A) faces from the previous step's limited flows (de Almeida et al. 2012 weighting with the two neighbouring faces)
      const edgeQ = (k, opp, e) => {
        if ((a[4 * k + 2] & 3) !== 0) return 0;
        const h = st[4 * k]; if (!(h > HMIN)) return 0;
        const sl = Math.max((a[4 * opp] - a[4 * k]) / dx, 0.001);
        let v = sqKN / p[4 * k] * h * Math.cbrt(h * h) * Math.sqrt(sl); const qm = h * Math.sqrt(G * h); if (v > qm) { v = qm; if (h > VEL_H) lim[k] = 1; }
        if (h > hm) hm = h; return e * v;
      };
      // interior face between L and R; f face index; fa/fb neighbouring faces in the same direction (or -1); La/Rb the cells beyond
      const inner = (f, L, R, fa, La, fb, Rb) => {
        const tL = a[4 * L + 2] & 3, tR = a[4 * R + 2] & 3;
        if (tL === 1 || tR === 1 || (tL === 2 && tR === 2)) return 0;
        const zL = a[4 * L], zR = a[4 * R], eL = zL + st[4 * L], eR = zR + st[4 * R];
        const hf = (eL > eR ? eL : eR) - (zL > zR ? zL : zR);
        if (!(hf > HMIN)) return 0;
        let v0 = qo[f]; const qe = v0 * (v0 > 0 ? r[L] : r[R]);
        let qa = qe, qb = qe;
        if (fa >= 0) { v0 = qo[fa]; qa = v0 * (v0 > 0 ? r[La] : r[L]); }
        if (fb >= 0) { v0 = qo[fb]; qb = v0 * (v0 > 0 ? r[R] : r[Rb]); }
        const n = 0.5 * (p[4 * L] + p[4 * R]);
        let v = (th * qe + th2 * (qa + qb) - gdt * hf * (eR - eL) / dx) / (1 + gdt * n * n * (qe < 0 ? -qe : qe) / (KN * hf * hf * Math.cbrt(hf)));
        const qm = hf * Math.sqrt(G * hf);
        if (v > qm || v < -qm) { v = v > 0 ? qm : -qm; if (hf > VEL_H) { lim[L] = 1; lim[R] = 1; } }
        if (hf > hm) hm = hf; return v;
      };
      for (let rr = 0; rr < ny; rr++) {
        const base = rr * (nx + 1), k0 = rr * nx;
        q[base] = edgeQ(k0, k0 + 1, -1);
        for (let c = 1; c < nx; c++) { const L = k0 + c - 1, R = L + 1; q[base + c] = inner(base + c, L, R, c > 1 ? base + c - 1 : -1, L - 1, c < nx - 1 ? base + c + 1 : -1, R + 1); }
        q[base + nx] = edgeQ(k0 + nx - 1, k0 + nx - 2, 1);
      }
      for (let c = 0; c < nx; c++) { q[nqx + c] = edgeQ(c, c + nx, -1); q[nqx + ny * nx + c] = edgeQ((ny - 1) * nx + c, (ny - 2) * nx + c, 1); }
      for (let rr = 1; rr < ny; rr++) {
        const base = nqx + rr * nx;
        for (let c = 0; c < nx; c++) { const f = base + c, L = (rr - 1) * nx + c, R = L + nx; q[f] = inner(f, L, R, rr > 1 ? f - nx : -1, L - nx, rr < ny - 1 ? f + nx : -1, R + nx); }
      }
      // (B) outflow ratio
      for (let k = 0; k < N; k++) {
        if ((a[4 * k + 2] & 3) !== 0) { r[k] = 1; continue; }
        const rr = (k / nx) | 0, c = k - rr * nx;
        const fW = rr * (nx + 1) + c, fE = fW + 1, fN = nqx + rr * nx + c, fS = fN + nx;
        const qw = q[fW], qE = q[fE], qn = q[fN], qs = q[fS];
        const out = ((qw < 0 ? -qw : 0) + (qE > 0 ? qE : 0) + (qn < 0 ? -qn : 0) + (qs > 0 ? qs : 0)) * dt / dx;
        const h = st[4 * k]; r[k] = (out > h && out > 0) ? h / out : 1;
      }
      // (D) depth update
      const pipes = this.pipes || [], np = pipes.length, stages = this.stages;
      for (let k = 0; k < N; k++) {
        const info = a[4 * k + 2], t = info & 3; if (t === 1) continue;
        const rr = (k / nx) | 0, c = k - rr * nx;
        const fW = rr * (nx + 1) + c, fE = fW + 1, fN = nqx + rr * nx + c, fS = fN + nx;
        let v;
        v = q[fW]; const qW = v * (v > 0 ? (c > 0 ? r[k - 1] : 1) : r[k]);
        v = q[fE]; const qE = v * (v > 0 ? r[k] : (c < nx - 1 ? r[k + 1] : 1));
        v = q[fN]; const qN = v * (v > 0 ? (rr > 0 ? r[k - nx] : 1) : r[k]);
        v = q[fS]; const qS = v * (v > 0 ? r[k] : (rr < ny - 1 ? r[k + nx] : 1));
        const dh = dt / dx * (qW - qE + qN - qS);
        if (t === 2) { acc[4 * k + 3] += dh; continue; }
        const edgeOut = dt / dx * ((c === 0 ? -qW : 0) + (c === nx - 1 ? qE : 0) + (rr === 0 ? -qN : 0) + (rr === ny - 1 ? qS : 0));
        let h = st[4 * k] + dh + rain * a[4 * k + 1] * dt + this.src[k] * dt;
        let pipeOut = 0;
        for (let i = 0; i < np; i++) {
          const pp = pipes[i]; if (pp.cell !== k) continue;
          const sL = stages[pp.lake], eta = a[4 * k] + h, dH = sL - eta;
          let d = pp.cda * Math.sqrt(2 * G * Math.abs(dH)) * dt / (dx * dx);
          if (dH > 0) { d = Math.min(d, dH); h += d; pipeOut -= d; } else if (dH < 0) { d = Math.min(d, -dH, Math.max(h, 0)); h -= d; pipeOut += d; }
        }
        const perv = p[4 * k + 1];
        let inf = 0;
        if (perv > 0 && h > 0) {
          const F = st[4 * k + 1];
          inf = Math.min(perv * gaStep(F, p[4 * k + 2] * dt, p[4 * k + 3] + h * a[4 * k + 3], h / perv), h); h -= inf; st[4 * k + 1] = F + inf / perv;
        }
        let dr = 0;
        if (drain > 0 && (info & 4096) && h > 0) { dr = Math.min(drain * dt, h); h -= dr; }
        let cl = 0; if (h < 0) { cl = -h; h = 0; }
        if (h > VEL_H) {   // cell velocity from the mean of the two face flows in each direction
          const qx = 0.5 * (qW + qE), qy = 0.5 * (qN + qS), dv = Math.sqrt(qx * qx + qy * qy), sp = dv / h;
          if (sp > this.vmx[k]) { this.vmx[k] = sp; this.tvx[k] = tHours; } if (dv > this.dvmx[k]) this.dvmx[k] = dv;
          // seconds above the threshold, summed in Float32 with Kahan compensation (durC), as the GPU does: a plain Float32 sum of
          // ~0.1 s steps drifted by percent over a day (review 0.6.1 ENG6-6)
          if (dv > this.dvThresh) { const y = Math.fround(dt - this.durC[k]), t = Math.fround(this.dur[k] + y); this.durC[k] = Math.fround(Math.fround(t - this.dur[k]) - y); this.dur[k] = t; }
        }
        st[4 * k] = h; acc[4 * k] += inf; acc[4 * k + 1] += dr; acc[4 * k + 2] += edgeOut + pipeOut; acc[4 * k + 3] += cl;
        if (h > st[4 * k + 2]) { st[4 * k + 2] = h; st[4 * k + 3] = tHours; }
      }
      return hm;
    }
    async chunk(o) {   // o: {dt, n, rain, drain, stages, tHours, pipes:[{cell, cda (sq ft), lake}]}
      this.setBoundary(o.stages); this.stages = o.stages; this.pipes = o.pipes || []; if (o.sources) this.setSources(o.sources); let hm = 0;
      for (let i = 0; i < o.n; i++) hm = Math.max(hm, this.step(o.dt, o.rain, o.drain, o.tHours, o.theta));
      return hm;
    }
    async readCells(cells) { const h = new Float32Array(cells.length); for (let i = 0; i < cells.length; i++) h[i] = this.st[4 * cells[i]]; return h; }
    /* the depth clamped at zero so far at a few cells (ft; reset with the other tallies at each reading): a withdrawal the cell could not supply */
    async readClamp(cells) { const c = new Float64Array(cells.length); for (let i = 0; i < cells.length; i++) c[i] = this.acc[4 * cells[i] + 3]; return c; }
    async read(resetAcc = true) {
      const out = { st: this.st.slice(), acc: this.acc.slice() };
      if (resetAcc) this.acc.fill(0);
      return out;
    }
  }

  // ------------------------------------------------------------------ GPU back end
  const WGSL = /* wgsl */`
struct P { nx: u32, ny: u32, nqx: u32, nf: u32, dx: f32, dt: f32, rain: f32, drain: f32, tHours: f32, g: f32, kn: f32, hmin: f32, theta: f32, npipe: f32, dvThresh: f32, p3: f32, stage: array<vec4<f32>, 16>, pipe: array<vec4<f32>, 4> };
@group(0) @binding(0) var<uniform> U: P;
@group(0) @binding(1) var<storage, read> aux: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> prm: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> st: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> rat: array<f32>;
@group(0) @binding(5) var<storage, read_write> q: array<f32>;
@group(0) @binding(6) var<storage, read_write> acc: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> misc: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read> qo: array<f32>;
struct VelC { s: vec4<f32>, v: vec4<f32> };   // s: x point-source depth rate, y max speed, z max depth x speed, w 1 where the Froude limiter acted; v: x time of max speed (hours), y seconds with depth x speed above the threshold
@group(0) @binding(9) var<storage, read_write> src: array<VelC>;
var<workgroup> wmax: atomic<u32>;

fn ctype(k: i32) -> u32 { return u32(aux[k].z) & 3u; }
fn qoe(f: u32, Lk: i32, Rk: i32) -> f32 {
  let v = qo[f];
  if (v > 0.0) { if (Lk >= 0) { return v * rat[Lk]; } return v; }
  if (Rk >= 0) { return v * rat[Rk]; } return v;
}

@compute @workgroup_size(256)
fn faces(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  let f = gid.x + gid.y * nwg.x * 256u;
  var qn: f32 = 0.0; var hf: f32 = 0.0;
  if (f < U.nf) {
    let nx = i32(U.nx); let ny = i32(U.ny);
    var L: i32 = -1; var R: i32 = -1;
    if (f < U.nqx) { let r = i32(f / (U.nx + 1u)); let c = i32(f % (U.nx + 1u)); if (c > 0) { L = r * nx + c - 1; } if (c < nx) { R = r * nx + c; } }
    else { let ff = f - U.nqx; let r = i32(ff / U.nx); let c = i32(ff % U.nx); if (r > 0) { L = (r - 1) * nx + c; } if (r < ny) { R = r * nx + c; } }
    if (L < 0 || R < 0) {
      var k = R; var e: f32 = -1.0; if (R < 0) { k = L; e = 1.0; }
      let h = st[k].x;
      if (ctype(k) == 0u && h > U.hmin) {
        var opp: i32;
        if (f < U.nqx) { if (e > 0.0) { opp = k - 1; } else { opp = k + 1; } } else { if (e > 0.0) { opp = k - nx; } else { opp = k + nx; } }
        let s = max((aux[opp].x - aux[k].x) / U.dx, 0.001);
        var qo = sqrt(U.kn) / prm[k].x * pow(h, 5.0 / 3.0) * sqrt(s);
        let qc = h * sqrt(U.g * h);
        if (qo > qc) { qo = qc; if (h > ${VEL_H}) { src[k].s.w = 1.0; } }
        qn = e * qo; hf = h;
      }
    } else {
      let tL = ctype(L); let tR = ctype(R);
      if (!(tL == 1u || tR == 1u || (tL == 2u && tR == 2u))) {
        let zL = aux[L].x; let zR = aux[R].x; let eL = zL + st[L].x; let eR = zR + st[R].x;
        let d = max(eL, eR) - max(zL, zR);
        if (d > U.hmin) {
          let qe = qoe(f, L, R);
          var qa = qe; var qb = qe;
          if (f < U.nqx) { let c0 = f % (U.nx + 1u); if (c0 > 1u) { qa = qoe(f - 1u, L - 1, L); } if (c0 < U.nx - 1u) { qb = qoe(f + 1u, R, R + 1); } }
          else { let r0 = (f - U.nqx) / U.nx; if (r0 > 1u) { qa = qoe(f - U.nx, L - nx, L); } if (r0 < U.ny - 1u) { qb = qoe(f + U.nx, R, R + nx); } }
          let n = 0.5 * (prm[L].x + prm[R].x);
          var v = (U.theta * qe + 0.5 * (1.0 - U.theta) * (qa + qb) - U.g * d * U.dt * (eR - eL) / U.dx) / (1.0 + U.g * U.dt * n * n * abs(qe) / (U.kn * pow(d, 7.0 / 3.0)));
          let qm = d * sqrt(U.g * d);
          if (abs(v) > qm) { v = clamp(v, -qm, qm); if (d > ${VEL_H}) { src[L].s.w = 1.0; src[R].s.w = 1.0; } }
          qn = v; hf = d;
        }
      }
    }
    q[f] = qn;
  }
  atomicMax(&wmax, bitcast<u32>(hf));
  workgroupBarrier();
  if (li == 0u) { atomicMax(&misc[0], atomicLoad(&wmax)); }
}

fn cellIdx(gid: vec3<u32>, nwg: vec3<u32>) -> u32 { return gid.x + gid.y * nwg.x * 256u; }
// x - ln(1 + x) without cancellation for small x
fn xml1p(x: f32) -> f32 { if (x < 0.05) { return x * x * (0.5 - x * (1.0 / 3.0 - x * (0.25 - x * (0.2 - x / 6.0)))); } return x - log(1.0 + x); }
// Green-Ampt infiltration over one step under ponding (SWMM grnampt form): solve u - c1 ln(1 + u/(F1 + c1)) = Ks dt for u = F2 - F1
fn gaStep(F1: f32, ksdt: f32, c1: f32, cap: f32) -> f32 {
  if (ksdt <= 0.0) { return 0.0; }
  if (c1 <= 0.0) { return ksdt; }
  if (cap > 0.0 && cap <= ksdt * (1.0 + c1 / (F1 + cap))) { return cap; }
  let a = F1 + c1;
  var u = ksdt + sqrt(2.0 * c1 * ksdt);
  if (F1 > 0.0) { u = min(u, ksdt * (1.0 + c1 / F1)); }
  for (var i = 0; i < 12; i = i + 1) {
    let x = u / a;
    let f = u * F1 / a + c1 * xml1p(x) - ksdt;
    let fp = (F1 + c1 * x / (1.0 + x)) / a;
    u = max(u - f / max(fp, 1e-12), 1e-12);
  }
  return u;
}

@compute @workgroup_size(256)
fn ratio(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let k = cellIdx(gid, nwg); if (k >= U.nx * U.ny) { return; }
  if (ctype(i32(k)) != 0u) { rat[k] = 1.0; return; }
  let r = k / U.nx; let c = k % U.nx;
  let fW = r * (U.nx + 1u) + c; let fE = fW + 1u; let fN = U.nqx + r * U.nx + c; let fS = fN + U.nx;
  let out = (max(-q[fW], 0.0) + max(q[fE], 0.0) + max(-q[fN], 0.0) + max(q[fS], 0.0)) * U.dt / U.dx;
  let h = st[k].x;
  var v: f32 = 1.0; if (out > h && out > 0.0) { v = h / out; }
  rat[k] = v;
}

fn qeff(f: u32, Lk: i32, Rk: i32) -> f32 {
  let v = q[f];
  if (v > 0.0) { if (Lk >= 0) { return v * rat[Lk]; } return v; }
  if (Rk >= 0) { return v * rat[Rk]; } return v;
}

@compute @workgroup_size(256)
fn update(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let k = cellIdx(gid, nwg); if (k >= U.nx * U.ny) { return; }
  let a = aux[k]; let info = u32(a.z); let t = info & 3u;
  if (t == 1u) { return; }
  let nx = i32(U.nx); let ki = i32(k);
  let r = k / U.nx; let c = k % U.nx;
  let fW = r * (U.nx + 1u) + c; let fE = fW + 1u; let fN = U.nqx + r * U.nx + c; let fS = fN + U.nx;
  var W: i32 = -1; var E: i32 = -1; var Nn: i32 = -1; var S: i32 = -1;
  if (c > 0u) { W = ki - 1; } if (c < U.nx - 1u) { E = ki + 1; } if (r > 0u) { Nn = ki - nx; } if (r < U.ny - 1u) { S = ki + nx; }
  let qW = qeff(fW, W, ki); let qE = qeff(fE, ki, E); let qN = qeff(fN, Nn, ki); let qS = qeff(fS, ki, S);
  let dh = U.dt / U.dx * (qW - qE + qN - qS);
  var ac = acc[k];
  if (t == 2u) { ac.w = ac.w + dh; acc[k] = ac; return; }
  var eo: f32 = 0.0;
  if (c == 0u) { eo = eo - qW; } if (c == U.nx - 1u) { eo = eo + qE; } if (r == 0u) { eo = eo - qN; } if (r == U.ny - 1u) { eo = eo + qS; }
  eo = eo * U.dt / U.dx;
  var s = st[k];
  var sv = src[k].s; var vv = src[k].v;
  var h = s.x + dh + U.rain * a.y * U.dt + sv.x * U.dt;
  var po: f32 = 0.0;
  for (var i = 0u; i < u32(U.npipe); i = i + 1u) {
    let pp = U.pipe[i];
    if (u32(pp.x) == k) {
      let li = u32(pp.z);
      let sL = U.stage[li / 4u][li % 4u];
      let dH = sL - (a.x + h);
      var d = pp.y * sqrt(2.0 * U.g * abs(dH)) * U.dt / (U.dx * U.dx);
      if (dH > 0.0) { d = min(d, dH); h = h + d; po = po - d; } else if (dH < 0.0) { d = min(min(d, -dH), max(h, 0.0)); h = h - d; po = po + d; }
    }
  }
  let p = prm[k];
  var inf: f32 = 0.0;
  if (p.y > 0.0 && h > 0.0) {
    inf = min(p.y * gaStep(s.y, p.z * U.dt, p.w + h * a.w, h / p.y), h); h = h - inf; s.y = s.y + inf / p.y;
  }
  var dr: f32 = 0.0;
  if (U.drain > 0.0 && (info & 4096u) != 0u && h > 0.0) { dr = min(U.drain * U.dt, h); h = h - dr; }
  var cl: f32 = 0.0; if (h < 0.0) { cl = -h; h = 0.0; }
  if (h > ${VEL_H}) {
    let qx = 0.5 * (qW + qE); let qy = 0.5 * (qN + qS); let dv = sqrt(qx * qx + qy * qy); let sp = dv / h;
    if (sp > sv.y) { vv.x = U.tHours; }
    if (dv > U.dvThresh) { let y = U.dt - vv.z; let t = vv.y + y; vv.z = (t - vv.y) - y; vv.y = t; }   // Kahan sum (vv.z the compensation)
    src[k].s = vec4<f32>(sv.x, max(sv.y, sp), max(sv.z, dv), sv.w); src[k].v = vv;
  }
  s.x = h;
  if (h > s.z) { s.z = h; s.w = U.tHours; }
  st[k] = s;
  acc[k] = ac + vec4<f32>(inf, dr, eo + po, cl);
}

@compute @workgroup_size(256)
fn boundary(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let k = cellIdx(gid, nwg); if (k >= U.nx * U.ny) { return; }
  let info = u32(aux[k].z); if ((info & 3u) != 2u) { return; }
  let i = (info >> 4u) & 255u;
  let s = U.stage[i / 4u][i % 4u];
  st[k].x = max(s - aux[k].x, 0.0);
}
`;
  class GpuSolver {
    constructor(g) { this.g = g; this.kind = "gpu"; this.dvThresh = g.dvThresh ?? 0.5; }
    async init(device) {
      const g = this.g, N = g.N;
      if (!device) {
        if (!(typeof navigator !== "undefined" && navigator.gpu)) throw new Error("WebGPU is not available in this browser");
        const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!ad) throw new Error("No WebGPU adapter");
        this.adapterInfo = ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture, description: ad.info.description } : {};
        if (ad.limits.maxStorageBuffersPerShaderStage < 9) throw new Error("This GPU allows fewer than 9 storage buffers per shader; use the CPU");
        device = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(ad.limits.maxStorageBufferBindingSize, 1 << 30), maxBufferSize: Math.min(ad.limits.maxBufferSize, 1 << 30), maxStorageBuffersPerShaderStage: 9 } });
      }
      const d = this.dev = device;
      this.lost = null; d.lost && d.lost.then((i) => { this.lost = i.message || "device lost"; });
      const B = GPUBufferUsage;
      const mk = (size, usage, data) => { const b = d.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage, mappedAtCreation: !!data }); if (data) { new data.constructor(b.getMappedRange()).set(data); b.unmap(); } return b; };
      this.nqx = (g.nx + 1) * g.ny; this.nf = this.nqx + g.nx * (g.ny + 1);
      this.bU = mk(384, B.UNIFORM | B.COPY_DST); if ((g.K || 0) > 64) throw new Error("At most 64 boundary nodes per tile");
      this.bAux = mk(16 * N, B.STORAGE, g.aux); this.bPrm = mk(16 * N, B.STORAGE, g.prm);
      this.bSt = mk(16 * N, B.STORAGE | B.COPY_SRC | B.COPY_DST); this.bRat = mk(4 * N, B.STORAGE | B.COPY_DST, new Float32Array(N).fill(1));
      this.bQ = mk(4 * this.nf, B.STORAGE | B.COPY_DST); this.bQ2 = mk(4 * this.nf, B.STORAGE | B.COPY_DST); this.par = 0; this.bAcc = mk(16 * N, B.STORAGE | B.COPY_SRC | B.COPY_DST);
      this.bMisc = mk(16, B.STORAGE | B.COPY_SRC | B.COPY_DST); this.bSrc = mk(32 * N, B.STORAGE | B.COPY_DST | B.COPY_SRC); this.srcCells = [];   // 32 bytes per cell: the rates/maxima vec4 and the time/duration vec4
      this.rdMisc = d.createBuffer({ size: 16, usage: B.MAP_READ | B.COPY_DST });
      this.rdSt = d.createBuffer({ size: 16 * N, usage: B.MAP_READ | B.COPY_DST }); this.rdAcc = d.createBuffer({ size: 16 * N, usage: B.MAP_READ | B.COPY_DST });
      const mod = d.createShaderModule({ code: WGSL });
      if (mod.getCompilationInfo) { const ci = await mod.getCompilationInfo(); const err = ci.messages.filter((m) => m.type === "error"); if (err.length) throw new Error("WGSL: " + err.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ")); }
      const layout = d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ...[3, 4, 5, 6, 7].map((b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } })),
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] });
      const pl = d.createPipelineLayout({ bindGroupLayouts: [layout] });
      this.pipe = {}; for (const e of ["faces", "ratio", "update", "boundary"]) this.pipe[e] = d.createComputePipeline({ layout: pl, compute: { module: mod, entryPoint: e } });
      const mkbg = (qn, qold) => d.createBindGroup({ layout, entries: [this.bU, this.bAux, this.bPrm, this.bSt, this.bRat, qn, this.bAcc, this.bMisc, qold, this.bSrc].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.bgs = [mkbg(this.bQ2, this.bQ), mkbg(this.bQ, this.bQ2)];   // step parity 0 writes Q2 from Q; parity 1 writes Q from Q2
      const wg = (n) => { const w = Math.ceil(n / 256); return w <= 65535 ? [w, 1] : [65535, Math.ceil(w / 65535)]; };
      this.wgCells = wg(N); this.wgFaces = wg(this.nf);
      // the kernels index with gid.x + gid.y*nwg.x*256: with a 2D dispatch nwg.x must be the x count
      return this;
    }
    upload(st) { this.dev.queue.writeBuffer(this.bSt, 0, st); }
    reset() {   // clear flows, ratios and tallies so nothing carries over from an earlier run on this solver
      const d = this.dev, enc = d.createCommandEncoder(); enc.clearBuffer(this.bQ); enc.clearBuffer(this.bQ2); enc.clearBuffer(this.bAcc); d.queue.submit([enc.finish()]);
      d.queue.writeBuffer(this.bRat, 0, new Float32Array(this.g.N).fill(1)); this.par = 0;
      const e2 = d.createCommandEncoder(); e2.clearBuffer(this.bSrc); d.queue.submit([e2.finish()]); this.srcCells = [];
    }
    setSources(list) {   // sparse update: zero the cells set last time, then write this chunk's rates (duplicates summed)
      const A = this.g.dx * this.g.dx, m = new Map(); for (const s of list || []) m.set(s.cell, (m.get(s.cell) || 0) + s.rate / A);
      const z = new Float32Array(1); for (const c of this.srcCells) if (!m.has(c)) this.dev.queue.writeBuffer(this.bSrc, 32 * c, z);
      for (const [c, v] of m) this.dev.queue.writeBuffer(this.bSrc, 32 * c, new Float32Array([v]));
      this.srcCells = [...m.keys()];
    }
    async chunk(o) {
      const d = this.dev, g = this.g;
      if (this.lost) throw new Error("GPU device lost: " + this.lost);
      const u = new ArrayBuffer(384), ui = new Uint32Array(u), uf = new Float32Array(u);
      ui[0] = g.nx; ui[1] = g.ny; ui[2] = this.nqx; ui[3] = this.nf; uf[4] = g.dx; uf[5] = o.dt; uf[6] = o.rain; uf[7] = o.drain; uf[8] = o.tHours; uf[9] = G; uf[10] = KN; uf[11] = HMIN; uf[12] = o.theta ?? g.theta ?? 0.8; uf[14] = this.dvThresh;
      for (let i = 0; i < Math.min(o.stages.length, 64); i++) uf[16 + i] = o.stages[i];
      if ((o.pipes || []).length > 4) throw new Error("The GPU solver handles at most 4 pipe connections; use the CPU for more");
      const pipes = o.pipes || []; uf[13] = pipes.length;
      pipes.forEach((pp, i) => { uf[80 + 4 * i] = pp.cell; uf[81 + 4 * i] = pp.cda; uf[82 + 4 * i] = pp.lake; });
      if (pipes.some((pp) => pp.cell >= (1 << 24))) throw new Error("pipe cell index too large for float encoding");
      d.queue.writeBuffer(this.bU, 0, u); if (o.sources) this.setSources(o.sources);
      d.queue.writeBuffer(this.bMisc, 0, new Uint32Array(4));
      const enc = d.createCommandEncoder(), pass = enc.beginComputePass();
      const run = (p, w, bg) => { pass.setPipeline(this.pipe[p]); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(w[0], w[1]); };
      run("boundary", this.wgCells, this.bgs[this.par]);
      for (let i = 0; i < o.n; i++) { const bg = this.bgs[this.par]; run("faces", this.wgFaces, bg); run("ratio", this.wgCells, bg); run("update", this.wgCells, bg); this.par ^= 1; }
      pass.end();
      enc.copyBufferToBuffer(this.bMisc, 0, this.rdMisc, 0, 16);
      d.queue.submit([enc.finish()]);
      await this.rdMisc.mapAsync(GPUMapMode.READ);
      const hm = new Float32Array(this.rdMisc.getMappedRange().slice(0))[0]; this.rdMisc.unmap();
      return hm;
    }
    async cellsOf(buf, cells, comp) {   // one component of a vec4 buffer at a few cells (two-way coupling), copied 16 bytes per cell
      const d = this.dev, M = cells.length; if (!M) return new Float32Array(0);
      if (!this.rdCells || this.rdCells.size < 16 * M) { if (this.rdCells) this.rdCells.destroy(); this.rdCells = d.createBuffer({ size: 16 * M, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); }
      const enc = d.createCommandEncoder(); cells.forEach((k, i) => enc.copyBufferToBuffer(buf, 16 * k, this.rdCells, 16 * i, 16)); d.queue.submit([enc.finish()]);
      await this.rdCells.mapAsync(GPUMapMode.READ, 0, 16 * M); const a = new Float32Array(this.rdCells.getMappedRange(0, 16 * M).slice(0)); this.rdCells.unmap();
      const h = new Float32Array(M); for (let i = 0; i < M; i++) h[i] = a[4 * i + comp]; return h;
    }
    async readCells(cells) { return this.cellsOf(this.bSt, cells, 0); }
    async readClamp(cells) { return Float64Array.from(await this.cellsOf(this.bAcc, cells, 3)); }
    async readVel() {
      const d = this.dev, N = this.g.N, rb = d.createBuffer({ size: 32 * N, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = d.createCommandEncoder(); enc.copyBufferToBuffer(this.bSrc, 0, rb, 0, 32 * N); d.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ); const a = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
      const vmax = new Float32Array(N), dvmax = new Float32Array(N), froude = new Uint8Array(N), tvmax = new Float32Array(N), dvdur = new Float32Array(N);
      for (let k = 0; k < N; k++) { vmax[k] = a[8 * k + 1]; dvmax[k] = a[8 * k + 2]; froude[k] = a[8 * k + 3] > 0 ? 1 : 0; tvmax[k] = a[8 * k + 4]; dvdur[k] = a[8 * k + 5]; }
      return { vmax, dvmax, froude, tvmax, dvdur };
    }
    setVel(v) {   // carry velocity maxima over from an earlier run (hot start); the source rates (x) start at zero
      const N = this.g.N, a = new Float32Array(8 * N); for (let k = 0; k < N; k++) { a[8 * k + 1] = v.vmax[k]; a[8 * k + 2] = v.dvmax[k]; a[8 * k + 3] = v.froude ? v.froude[k] : 0; a[8 * k + 4] = v.tvmax ? v.tvmax[k] : 0; a[8 * k + 5] = v.dvdur ? v.dvdur[k] : 0; }
      this.dev.queue.writeBuffer(this.bSrc, 0, a); this.srcCells = [];
    }
    async read(resetAcc = true) {
      const d = this.dev, enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(this.bSt, 0, this.rdSt, 0, 16 * this.g.N); enc.copyBufferToBuffer(this.bAcc, 0, this.rdAcc, 0, 16 * this.g.N);
      if (resetAcc) enc.clearBuffer(this.bAcc);
      d.queue.submit([enc.finish()]);
      await Promise.all([this.rdSt.mapAsync(GPUMapMode.READ), this.rdAcc.mapAsync(GPUMapMode.READ)]);
      const st = new Float32Array(this.rdSt.getMappedRange().slice(0)), acc = new Float32Array(this.rdAcc.getMappedRange().slice(0));
      this.rdSt.unmap(); this.rdAcc.unmap();
      return { st, acc };
    }
    destroy() { try { this.dev.destroy(); } catch (e) {} }
  }

  // ------------------------------------------------------------------ driver
  /* o: {t0, t1 (hours), rainAt(i) -> in/hr for rain interval i = floor(t / rainStep) (rainStep s, default 3600, so i is the hour),
   *     stageAt(tHours) -> array (ft), drainInHr, pipes, init (initial state; alone it is an initial condition and the depth maxima restart from it),
   *     initVel ({vmax, dvmax, froude, tvmax, dvdur}: with init, a hot start that carries the depth and velocity maxima over), cfl, dtMax, chunkSec, readSec, onRead(frame), shouldStop(),
   *     dvThresh (ft2/s, default 0.5, the app's lowest depth x velocity class edge): the run also records, per cell, the time of the
   *     maximum speed (tvmax, hours) and the seconds with depth x speed above this threshold (dvdur), returned with the maxima,
   *     sources: [{cell, name}] point inflows, sourceAt(tHours0, tHours1) -> array of mean rates (cfs) over the interval, one per source,
   *     afterChunk(tHours0, tHours1, solver) called once the interval has run (tHours1 is where it stopped; two-way coupling reads what the inlets took),
   *     routedLakes: [{lake, areaFt2, level0, stageArea, outlet}] lakes whose level rises and falls with the water they gain instead of following stageAt:
   *       after each chunk, the lake's volume changes by the net 2D inflow at its edge + rain on its area + lakeInflow volume - its outlet's outflow,
   *       and the level follows from its storage: a constant area areaFt2, or stageArea [[stage ft, area sq ft], ...] (stages rising; the area is
   *       interpolated between them and held beyond them). outlet: one of {kind: "weir", crestFt, lengthFt, cw} (a missing kind is a weir),
   *       {kind: "rating", rating: [[stage ft, flow cfs], ...]}, {kind: "pipe", crestFt (its invert), diameterFt, cd} or
   *       {kind: "gate", crestFt (its sill), widthFt, openingFt, cd}; every kind is taken at the level half way through each chunk
   *       and never draws the lake below its control elevation (the crest, the rating's first stage, the invert or the sill),
   *     lakeInflow(tHours0, tHours1, levels) -> volumes (cu ft) that reached each routed lake over the chunk from outside the 2D (for example SWMM outfalls),
   *     lakeOutflow(tHours0, tHours1, volumes) is told the volume each routed lake's outlet released over the chunk (for example to pass it to SWMM)}
   * Chunks never cross a rain-interval boundary, so each chunk has one rain intensity.
   * Invalid input is refused with an error rather than producing NaN depths or a hang. A CPU run yields to the event loop at least every
   * 50 ms so a stop request sent as a message is seen. The solver is reset at the start, so nothing carries over from an earlier run. */
  const now = () => (typeof performance !== "undefined" ? performance : Date).now();
  const yieldTask = () => new Promise((r) => (typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0)));
  /* storage of a routed lake from [[stage, area], ...] (one pair: a constant area): the area is linear between stages and held beyond the
   * first and last; volume is measured from the first stage. levelOf inverts the volume exactly (quadratic within a segment). */
  function storage(tab) {
    const n = tab.length, s = tab.map((x) => x[0]), a = tab.map((x) => x[1]), V = [0];
    for (let m = 1; m < n; m++) V.push(V[m - 1] + 0.5 * (a[m - 1] + a[m]) * (s[m] - s[m - 1]));
    const area = (h) => { if (h <= s[0]) return a[0]; if (h >= s[n - 1]) return a[n - 1]; let m = 1; while (s[m] < h) m++; return a[m - 1] + (a[m] - a[m - 1]) * (h - s[m - 1]) / (s[m] - s[m - 1]); };
    const vol = (h) => { if (h <= s[0]) return (h - s[0]) * a[0]; if (h >= s[n - 1]) return V[n - 1] + (h - s[n - 1]) * a[n - 1]; let m = 1; while (s[m] < h) m++; return V[m - 1] + 0.5 * (a[m - 1] + area(h)) * (h - s[m - 1]); };
    const levelOf = (v) => {
      if (v <= 0) return s[0] + v / a[0]; if (v >= V[n - 1]) return s[n - 1] + (v - V[n - 1]) / a[n - 1];
      let m = 1; while (V[m] < v) m++;
      const dv = v - V[m - 1], a0 = a[m - 1], k = (a[m] - a0) / (s[m] - s[m - 1]);   // a(x) = a0 + k x, volume a0 x + k x^2 / 2
      return s[m - 1] + (Math.abs(k) < 1e-12 ? dv / a0 : 2 * dv / (a0 + Math.sqrt(a0 * a0 + 2 * k * dv)));
    };
    return { area, vol, levelOf, minArea: Math.min(...a), bottom: s[0] };
  }
  async function simulate(g, solver, o) {
    const A = g.dx * g.dx, cfl = o.cfl ?? 0.7, dtMax = o.dtMax ?? 5, chunkSec = o.chunkSec ?? 60, readSec = o.readSec ?? 900;
    if (!(Number.isFinite(o.t0) && Number.isFinite(o.t1) && o.t1 > o.t0)) throw new Error(`Invalid simulation window: start ${o.t0}, end ${o.t1} (hours); the end must be after the start`);
    // Above 0.7 the local-inertial scheme is outside its stable range (Bates et al. 2010 use 0.2-0.7): pockets overshoot (a page
    // example peaked at 10.3-10.7 ft at 0.8-0.95 against 4.67 ft at 0.7 and below), so higher values are refused (review 0.6.1 ENG6-1).
    if (g.theta !== undefined && !(typeof g.theta === "number" && g.theta >= 0.5 && g.theta <= 1)) throw new Error(`Invalid weighting theta ${g.theta}; use a value from 0.5 to 1`);
    if (!(cfl > 0 && cfl <= 0.7)) throw new Error(`Invalid Courant number ${cfl}; use a value above 0 and at most 0.7 (the stable range of the local-inertial scheme)`);
    if (!(dtMax > 0) || !(chunkSec > 0) || !(readSec > 0)) throw new Error("Invalid time-step settings (dtMax, chunkSec and readSec must be positive)");
    const K = g.K || 0, pipes = o.pipes || [], srcs = o.sources || [], rainStep = o.rainStep ?? 3600;
    if (!(rainStep > 0)) throw new Error(`Invalid rain interval ${rainStep} s`);
    for (const sc of srcs) if (!(sc.cell >= 0 && sc.cell < g.N) || (g.aux[4 * sc.cell + 2] & 3) !== 0) throw new Error(`Point inflow ${sc.name || sc.cell} is not on an open cell`);
    if (srcs.length && typeof o.sourceAt !== "function") throw new Error("Point inflows given without a sourceAt function");
    const checkStages = (s, t) => {
      if (!s || s.length < K) throw new Error(`Lake levels missing at hour ${t.toFixed(2)}: ${s ? s.length : 0} given for ${K} lakes`);
      for (let i = 0; i < K; i++) if (!Number.isFinite(s[i])) throw new Error(`Lake level ${i} is not a number at hour ${t.toFixed(2)} (${s[i]})`);
      return s;
    };
    for (const pp of pipes) { const r = (pp.cell / g.nx) | 0, c = pp.cell % g.nx; if (!(pp.cell >= 0 && pp.cell < g.N) || r === 0 || c === 0 || r === g.ny - 1 || c === g.nx - 1) throw new Error("A pipe connection must be on an interior cell"); }
    const N = g.N, st0 = new Float32Array(4 * N);
    // initial state: dry open cells, boundary at the engine level
    // routed lakes: a level pool per lake, driven by the volume that crosses its edge cells (the only lake cells with flux), rain on its area and outside inflow
    const routed = (o.routedLakes || []).map((r, i) => {
      if (!(Number.isInteger(r.lake) && r.lake >= 0 && r.lake < K)) throw new Error(`Routed lake ${i + 1}: lake ${r.lake} is not one of the ${K} level boundaries`);
      const nm = r.name || `Lake ${r.lake + 1}`;
      if (!Number.isFinite(r.level0)) throw new Error(`Routed lake ${nm}: starting level ${r.level0} is not a number`);
      let tab;
      if (r.stageArea !== undefined && r.stageArea !== null) {
        tab = r.stageArea;
        if (!(Array.isArray(tab) && tab.length >= 2 && tab.every((x) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "number" && Number.isFinite(v)) && x[1] > 0)))
          throw new Error(`Routed lake ${nm}: the stage-area table ${JSON.stringify(tab)} needs two or more [stage ft, area sq ft] pairs with positive areas`);
        for (let m = 1; m < tab.length; m++) if (!(tab[m][0] > tab[m - 1][0])) throw new Error(`Routed lake ${nm}: stages in the stage-area table must rise (${tab[m - 1][0]} then ${tab[m][0]})`);
        // a lake's surface does not shrink as it rises; a falling area is a typo or a row in other units (review 0.5.0 round 4 ENG5-4)
        for (let m = 1; m < tab.length; m++) if (tab[m][1] < tab[m - 1][1]) throw new Error(`Routed lake ${nm}: areas in the stage-area table must not fall as the stage rises (${tab[m - 1][1]} sq ft at ${tab[m - 1][0]} ft, then ${tab[m][1]} at ${tab[m][0]} ft)`);
        if (r.level0 < tab[0][0]) throw new Error(`Routed lake ${nm}: its starting level ${r.level0} ft is below the bottom of its stage-area table (${tab[0][0]} ft)`);
      } else {
        if (!(r.areaFt2 > 0 && Number.isFinite(r.areaFt2))) throw new Error(`Routed lake ${nm}: area ${r.areaFt2} is not a positive number`);
        tab = [[r.level0, r.areaFt2]];
      }
      let out = null;
      if (r.outlet !== undefined && r.outlet !== null) {
        /* An outlet is any Q(level) with a control elevation it cannot draw the lake below: a weir (the 0.5.0 form), a rating
         * curve (stage ft : flow cfs pairs, linear between, held beyond), a pipe (EPA SWMM 5.2's side orifice: full, the head
         * to the centre; part full, its weir form; Cd 0.6 unless given) or a gate (an orifice of width x opening at its
         * sill, the head taken to the opening's centroid, the wetted part only while the level is inside the opening).
         * All run through the same midpoint step and chunk limits. */
        const ol = r.outlet, kind = ol.kind ?? "weir";
        if (!Number.isFinite(ol.crestFt) && kind !== "rating") throw new Error(`Routed lake ${nm}: outlet crest ${ol.crestFt} is not a number`);
        const pos = (v, what) => { if (!(v > 0 && Number.isFinite(v))) throw new Error(`Routed lake ${nm}: outlet ${what} ${v} is not a positive number`); return v; };
        if (kind === "weir") {
          const len = pos(ol.lengthFt, "length"), cw = ol.cw ?? 3.0; pos(cw, "weir coefficient");
          const ctl = ol.crestFt;
          out = { kind, ctl, q: (h) => (h > ctl ? cw * len * Math.pow(h - ctl, 1.5) : 0), dq: (h) => (h > ctl ? 1.5 * cw * len * Math.sqrt(h - ctl) : 0) };
        } else if (kind === "rating") {
          const tab = ol.rating;
          if (!(Array.isArray(tab) && tab.length >= 2 && tab.every((x) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "number" && Number.isFinite(v)) && x[1] >= 0)))
            throw new Error(`Routed lake ${nm}: the outlet rating ${JSON.stringify(tab)} needs two or more [stage ft, flow cfs] pairs with flows of zero or more`);
          for (let m = 1; m < tab.length; m++) { if (!(tab[m][0] > tab[m - 1][0])) throw new Error(`Routed lake ${nm}: stages in the outlet rating must rise (${tab[m - 1][0]} then ${tab[m][0]})`); if (tab[m][1] < tab[m - 1][1]) throw new Error(`Routed lake ${nm}: flows in the outlet rating must not fall (${tab[m - 1][1]} then ${tab[m][1]} cfs)`); }
          const ctl = tab[0][0], seg = (h) => { let m = 0; while (m < tab.length - 2 && h > tab[m + 1][0]) m++; return m; };
          out = { kind, ctl, q: (h) => { if (!(h > ctl)) return 0; if (h >= tab[tab.length - 1][0]) return tab[tab.length - 1][1]; const m = seg(h); return tab[m][1] + (tab[m + 1][1] - tab[m][1]) * (h - tab[m][0]) / (tab[m + 1][0] - tab[m][0]); },
            dq: (h) => { if (!(h > ctl)) return 0; if (h >= tab[tab.length - 1][0]) return 0; const m = seg(h); return (tab[m + 1][1] - tab[m][1]) / (tab[m + 1][0] - tab[m][0]); } };
        } else if (kind === "pipe" || kind === "gate") {
          const cd = ol.cd ?? 0.6; pos(cd, "discharge coefficient"); const ctl = ol.crestFt;
          if (kind === "pipe") {
            const D = pos(ol.diameterFt, "diameter"), R = D / 2, Af = Math.PI * R * R;
            /* EPA SWMM 5.2 side orifice (link.c orifice_getFlow): at and above the crown the pipe runs full and the head is to its
             * centre, Q = Cd A sqrt(2 g (d - D/2)); below the crown it acts as a weir, Q = Cd A sqrt(2 g D/2) (d/D)^1.5, which meets
             * the full-pipe flow at the crown. 0.6.1 used the orifice law on the wetted segment instead, which passed up to 2.3 times
             * less than SWMM at shallow depth (review 0.6.1 ENG6-4). */
            const qFull = cd * Af * Math.sqrt(2 * G * R);
            const q = (h) => { const d = h - ctl; if (!(d > 0)) return 0;
              return d >= D ? cd * Af * Math.sqrt(2 * G * (d - R)) : qFull * Math.pow(d / D, 1.5); };
            out = { kind, ctl, q, dq: (h) => { const d = h - ctl; if (!(d > 0)) return 0; return d >= D ? cd * Af * G / Math.sqrt(2 * G * (d - R) || 1e-12) : 1.5 * qFull * Math.sqrt(d / D) / D; } };
          } else {
            const w = pos(ol.widthFt, "gate width"), a = pos(ol.openingFt, "gate opening");
            const q = (h) => { if (!(h > ctl)) return 0; const d = h - ctl; return d < a ? cd * w * d * Math.sqrt(G * d) : cd * w * a * Math.sqrt(2 * G * (d - a / 2)); };
            out = { kind, ctl, q, dq: (h) => (q(h + 0.02) - q(h)) / 0.02 };
          }
        } else throw new Error(`Routed lake ${nm}: outlet type ${JSON.stringify(kind)} is not one of weir, rating, pipe, gate`);
        // the table holds no storage below its first stage, so an outlet set lower would drain water that is not there (review 0.6.1 WRK6-2)
        if (r.stageArea && out.ctl < tab[0][0]) throw new Error(`Routed lake ${nm}: its outlet (${kind}) is set at ${out.ctl} ft, below the bottom of its stage-area table (${tab[0][0]} ft); extend the table down to the outlet`);
      }
      const S = storage(tab);
      return { lake: r.lake, S, out, outVol: 0, tabled: !!r.stageArea, area: S.area(r.level0), level: r.level0, start: r.level0, name: r.name || `Lake ${r.lake + 1}`, cells: [], prev: null, gain2d: 0, gainRain: 0, gainExt: 0, nCells: 0, bed: Infinity, lip: Infinity, faces: 0, cap: 1, lastD: 0, kExt: 0, kSeen: false, linked: r.linked !== false, lastRate: null, lastLv: 0 };
    });
    if (routed.length) {
      const byLake = new Map();
      for (const r of routed) { if (byLake.has(r.lake)) throw new Error(`Routed lake ${r.name}: lake ${r.lake + 1} is listed more than once`); byLake.set(r.lake, r); }
      for (const pp of pipes) if (byLake.has(pp.lake)) throw new Error(`A pipe connects to routed lake ${byLake.get(pp.lake).name}; pipes to routed lakes are not supported`);
      for (let k = 0; k < N; k++) {
        if ((g.aux[4 * k + 2] & 3) !== 2) continue; const r = byLake.get((g.aux[4 * k + 2] >> 4) & 255); if (!r) continue;
        r.nCells++; r.bed = Math.min(r.bed, g.aux[4 * k]);
        const rr = (k / g.nx) | 0, cc = k % g.nx;
        const nb = [cc > 0 ? k - 1 : -1, cc < g.nx - 1 ? k + 1 : -1, rr > 0 ? k - g.nx : -1, rr < g.ny - 1 ? k + g.nx : -1].filter((m) => m >= 0 && (g.aux[4 * m + 2] & 3) === 0);
        if (nb.length) { r.cells.push(k); r.faces += nb.length; for (const m of nb) r.lip = Math.min(r.lip, g.aux[4 * m]); }
      }
      for (const r of routed) {
        // the lake's surface is at least its own cells: a smaller area would move the level too far for every cubic foot
        if (r.area < r.nCells * A * (1 - 1e-9)) throw new Error(`Routed lake ${r.name}: area ${(r.area / 43560).toFixed(3)} ac${r.S.minArea !== r.area ? " at its starting level" : ""} is smaller than its ${r.nCells} cells in the grid (${(r.nCells * A / 43560).toFixed(3)} ac)`);
        r.prev = new Float64Array(r.cells.length);
        // a lake that starts above the land next to it, or above its outlet crest, loses its first water faster than the crest
        // formula in lakeDt says (the first edge flux off a head over dry land is not the broad-crest flux), and the adaptive cap
        // otherwise learns that only from the first overshoot, which can ring the level across the lip (F-13). Seed the cap from
        // the starting head instead: the chunk that moves the level about 0.02 ft at the starting spill + outlet rate.
        let rate0 = 0;   // ft/s the level would fall at the start
        const A0 = r.S.area(r.level), H0 = r.level - r.lip;
        if (H0 > 0 && r.faces) rate0 += Math.sqrt(G) * r.faces * g.dx * Math.pow(2 / 3, 1.5) * Math.pow(H0, 1.5) / A0;
        if (r.out) rate0 += r.out.q(r.level) / A0;
        if (rate0 > 0) r.cap = Math.min(r.cap, Math.max(0.05, 0.02 / rate0));
      }
    }
    /* Longest chunk a routed lake allows. The level is held over a chunk and updated after it (explicit in time), which is stable only for
     * dt < 2 A / (dQ/dh), Q being the lake's outflow over its edge. Over a broad crest at critical depth, Q = Lf sqrt(g) (2H/3)^1.5 with
     * H = level - lip (lowest open ground next to the lake) and Lf the edge length, so dQ/dh = sqrt(g) Lf (2/3)^1.5 1.5 H^0.5. An eighth of the limit is used: the chunk-held level still lags the edge flux, and a lake that starts well above dry land loses its first water faster than this crest formula says. */
    /* Outside inflow that depends on the level (SWMM outfalls taking the lake as their stage) is not in that formula, so each lake also keeps
     * an adaptive cap that keeps its level change to about 0.02 ft per chunk: it starts at 1 s, shrinks in proportion when a chunk moved the
     * level more than that, and grows by half each chunk that moved it less (no cap once it passes an hour). A cap that only reacts
     * can still grow past the stability limit of a level-dependent outside inflow, so each lake also measures that dependence from one
     * chunk to the next, k = -d(outside inflow rate)/d(level) (cfs/ft), and keeps its chunks under A/k, half the explicit limit 2A/k.
     * A level that reverses by more than 0.002 ft two chunks running halves the cap as well. */
    /* An outlet's Q(level) is known exactly, so its limit is set directly from dQ/dh (1.5 cw L H^0.5 for a weir), and chunks stay under A/(dQ/dh). */
    const lakeDt = () => { let m = Infinity; for (const r of routed) { const Ah = r.S.area(r.level);
      m = Math.min(m, r.cap, r.kExt > 0 ? Math.max(0.05, Ah / r.kExt) : Infinity);
      /* A lake fed from outside (lakeInflow) keeps its chunks to 60 s at most, whatever its cap has grown to over a quiet stretch:
       * an outside inflow that switches on level-dependent is only seen after a chunk, and a full chunk at the starting rate moved one
       * probe lake 6.67 ft (review 0.6.0 F-18). 0.6.1 held such a lake to 1 s while its inflow was exactly zero, which any baseflow
       * (1e-6 cfs) defeated and which made idle lakes run in 1 s chunks all run long (review 0.6.1 ENG6-2, ENG6-3). In the app the
       * chunk is already the coupling interval (30 s by default) in two-way runs, the only runs with outside lake inflow. */
      if (o.lakeInflow) m = Math.min(m, 60);
      // until the outside inflow's dependence on the level has been read once, a lake linked from outside (r.linked, default true) takes
      // 1 s chunks, so an inflow that switches on level-dependent meets an adaptive chunk (0.6.0 F-18). The hold no longer ends on a
      // nonzero rate (any baseflow ended it: review 0.6.1 ENG6-2); lakes the caller marks as not linked (linked: false, for example a
      // lake with no SWMM outfall) never take it (ENG6-3).
      if (o.lakeInflow && r.linked && !r.kSeen) m = Math.min(m, 1);
      if (r.out) { const dq = r.out.dq(r.level); if (dq > 0) m = Math.min(m, Math.max(0.05, Ah / dq)); }
      const H = r.level - r.lip; if (!(H > 0) || !r.faces) continue;
      const dqdh = Math.sqrt(G) * r.faces * g.dx * Math.pow(2 / 3, 1.5) * 1.5 * Math.sqrt(H); m = Math.min(m, Math.max(0.05, 0.25 * Ah / dqdh)); } return m; };
    if (o.lakeOutflow !== undefined && o.lakeOutflow !== null && typeof o.lakeOutflow !== "function") throw new Error("lakeOutflow must be a function");
    // the lowest ground of the grid: water drains over the land no lower than this
    let zLow = Infinity; if (routed.length) for (let k = 0; k < N; k++) if ((g.aux[4 * k + 2] & 3) !== 1) zLow = Math.min(zLow, g.aux[4 * k]);
    if (o.lakeInflow !== undefined && o.lakeInflow !== null) {
      if (typeof o.lakeInflow !== "function") throw new Error("lakeInflow must be a function");
      if (!routed.length) throw new Error("lakeInflow is given but no lake is routed: its water would go nowhere");
    }
    const lakeStages = (s) => { if (!routed.length) return s; const out = Array.from(s); for (const r of routed) out[r.lake] = r.level; return out; };
    const lakeSeries = [];
    const s0 = lakeStages(checkStages(o.stageAt(o.t0), o.t0));
    for (let k = 0; k < N; k++) if ((g.aux[4 * k + 2] & 3) === 2) st0[4 * k] = Math.max(s0[(g.aux[4 * k + 2] >> 4) & 255] - g.aux[4 * k], 0);
    if (o.init) { if (o.init.length !== 4 * N) throw new Error("Initial state has the wrong size"); st0.set(o.init); }
    // init alone is an initial condition (for example a lake at rest): the depth and velocity maxima both start at this moment.
    // init with initVel is a hot start that continues an earlier run: both maxima carry over, so they always cover the same period.
    if (o.init && !o.initVel) for (let k = 0; k < N; k++) { st0[4 * k + 2] = st0[4 * k]; st0[4 * k + 3] = st0[4 * k] > 0 ? o.t0 : 0; }
    if (o.initVel) {   // every array carried over must be one finite value per cell (review 0.6.1 ENG6-8: short arrays left NaN tails on the GPU)
      for (const key of ["vmax", "dvmax", "froude", "tvmax", "dvdur"]) {
        const v = o.initVel[key];
        if (v === undefined || v === null) { if (key === "vmax" || key === "dvmax") throw new Error(`initVel.${key} is missing`); continue; }
        if (v.length !== N) throw new Error(`initVel.${key} has ${v.length} values for ${N} cells`);
        for (let k = 0; k < N; k++) if ((!Number.isFinite(v[k]) && !(key === "tvmax" && Number.isNaN(v[k]))) || ((key === "dvdur" || key === "vmax" || key === "dvmax") && v[k] < 0)) throw new Error(`initVel.${key} at cell ${k} is ${v[k]}, not a ${key === "tvmax" || key === "froude" ? "" : "non-negative "}number`);
      }
    }
    for (let k = 0; k < 4 * N; k++) if (!Number.isFinite(st0[k])) throw new Error("Initial state contains a value that is not a number");
    solver.reset();
    if (solver.kind === "gpu") solver.upload(st0); else solver.st.set(st0);
    // the threshold is set for every run, so a value from an earlier run on the same solver does not carry over (review 0.6.1 ENG6-7)
    if (o.dvThresh !== undefined) { if (!(typeof o.dvThresh === "number" && Number.isFinite(o.dvThresh) && o.dvThresh > 0)) throw new Error(`Depth x velocity threshold ${o.dvThresh} is not a positive number`); solver.dvThresh = o.dvThresh; }
    else solver.dvThresh = g.dvThresh ?? 0.5;
    if (o.initVel) solver.setVel(o.initVel);
    let maxMult = 0; for (let k = 0; k < N; k++) if (g.aux[4 * k + 1] > maxMult) maxMult = g.aux[4 * k + 1];
    const sqG = Math.sqrt(G);
    const vol = (st) => { let v = 0; for (let k = 0; k < N; k++) if ((g.aux[4 * k + 2] & 3) === 0) v += st[4 * k]; return v * A; };
    const isPipe = new Uint8Array(N); for (const pp of pipes) isPipe[pp.cell] = 1;
    const L = { rain: 0, inflow: 0, captured: 0, inf: 0, drain: 0, edge: 0, pipe: 0, toLakes: 0, clamp: 0, v0: vol(st0), v1: 0, err: 0, errPct: 0 };
    // first step: sized for the deepest water anywhere that can move, including lake cells next to dry ground
    let h0max = 0.05; for (let k = 0; k < N; k++) if ((g.aux[4 * k + 2] & 3) !== 1 && st0[4 * k] > h0max) h0max = st0[4 * k];
    let t = o.t0 * 3600, tEnd = o.t1 * 3600, hm = Math.max(h0max, o.hInit ?? 0.05), steps = 0, chunks = 0, nextRead = t + readSec, stopped = false, lastYield = now();
    const t0wall = now();
    const frames = [];
    const doRead = async (final) => {
      const r = await solver.read(true), acc = r.acc;
      for (let k = 0; k < N; k++) {
        const ty = g.aux[4 * k + 2] & 3; if (ty === 1) continue;
        if (ty === 2) { L.toLakes += acc[4 * k + 3] * A; continue; }
        L.inf += acc[4 * k] * A; L.drain += acc[4 * k + 1] * A; if (isPipe[k]) L.pipe += acc[4 * k + 2] * A; else L.edge += acc[4 * k + 2] * A; L.clamp += acc[4 * k + 3] * A;
      }
      for (let k = 0; k < N; k++) if (!Number.isFinite(r.st[4 * k])) throw new Error(`The solver produced an invalid depth at hour ${(t / 3600).toFixed(2)}`);
      L.v1 = vol(r.st);
      L.err = L.v1 - L.v0 - (L.rain + L.inflow - L.captured - L.inf - L.drain - L.edge - L.pipe - L.toLakes + L.clamp);
      L.errPct = 100 * L.err / Math.max(L.rain + L.inflow + L.captured + Math.abs(L.toLakes) + Math.abs(L.pipe) + L.v0, 1e-9);
      const wall = (now() - t0wall) / 1000;
      const fr = { tHours: t / 3600, st: r.st, ledger: Object.assign({}, L), steps, chunks, wall, dtLast: o._dt, hmFace: hm, final: !!final, lakeLevels: routed.map((x) => ({ lake: x.lake, level: x.level })) };
      if (o.onRead) await o.onRead(fr);
      return fr;
    };
    while (t < tEnd - 1e-6) {
      if (o.shouldStop && o.shouldStop()) { stopped = true; break; }
      const hourEnd = (Math.floor(t / rainStep + 1e-9) + 1) * rainStep;   // end of this rain interval
      let span = Math.min(chunkSec, hourEnd - t, tEnd - t, nextRead - t, routed.length ? lakeDt() : Infinity);
      const th = (t + span / 2) / 3600, hr = Math.floor(t / rainStep + 1e-9);
      const rainInHr = o.rainAt(hr);
      if (!(Number.isFinite(rainInHr) && rainInHr >= 0)) throw new Error(`Rainfall missing or invalid at hour ${hr} (${rainInHr})`);
      const rain = rainInHr / 12 / 3600, drainInHr = o.drainInHr || 0;
      if (!(Number.isFinite(drainInHr) && drainInHr >= 0)) throw new Error(`Invalid drain allowance ${drainInHr}`);
      const stages = lakeStages(checkStages(o.stageAt(th), th));
      let sources = null, qSrc = 0, qSink = 0, hSrc = 0;
      if (srcs.length) {
        // sourceAt may be async (two-way coupling reads depths and advances SWMM); a negative rate is a withdrawal, allowed only for sources marked sink
        const rates = await o.sourceAt(t / 3600, (t + span) / 3600, solver);
        if (!rates || rates.length !== srcs.length) throw new Error(`Point inflows missing at hour ${(t / 3600).toFixed(2)}`);
        const perCell = new Map();
        sources = srcs.map((sc, i) => { const q = rates[i]; if (!(Number.isFinite(q) && (q >= 0 || sc.sink))) throw new Error(`Point inflow ${sc.name || sc.cell} is invalid at hour ${(t / 3600).toFixed(2)} (${q})`); if (q >= 0) qSrc += q; else qSink -= q; perCell.set(sc.cell, (perCell.get(sc.cell) || 0) + q); return { cell: sc.cell, rate: q }; });
        // depth a point inflow can build in its cell before this chunk ends: the growth with no outflow, but no more than the depth at which
        // the inflow leaves through a single face at critical flow, Q = dx sqrt(g) h^1.5 (the Froude limiter caps every face there)
        for (const q of perCell.values()) if (q > 0) hSrc = Math.max(hSrc, Math.min(hm + q / A * span, Math.pow(q / (g.dx * sqG), 2 / 3)));
      }
      // step size: Courant number cfl at the deepest water expected in this chunk (the last reading, point inflows, rain on the wettest cell)
      const dtWave = g.dx / Math.sqrt(G * Math.max(hm, hSrc, Math.max(hm, 0.05) + rain * maxMult * span)), dtCour = cfl * dtWave, dtC = Math.min(dtMax, dtCour);
      const n = Math.max(1, Math.ceil(span / dtC)), dt = span / n;
      // The de Almeida et al. (2012) weighting smooths each face flow toward its neighbors once per step, a diffusion of about
      // (1 - theta) dx^2 / (2 dt). Taken as is, a shorter step (a short chunk, a low dtMax) would smooth more per second and slow the flow.
      // Scaling (1 - theta) with dt / (0.9 x the reference Courant step) keeps the smoothing per second near that of the reference step, so
      // the answer does not depend on how finely the time is cut. The reference step is the cfl-free wave step at the reference Courant
      // number 0.7 (the default): normalising to the user's own cfl-scaled step instead would leave the smoothing per second proportional
      // to 1/cfl, so lowering the Courant number would silently add diffusion (review F-02). Steps within 90% of the reference step
      // (every step of a chunk of 10 or more steps at the default cfl) keep theta as given. One value per chunk, rounded to Float32, is
      // used by both back ends.
      // Courant numbers above 0.7 are refused (review 0.6.1 ENG6-1), so dt never exceeds the reference step; the 0.6.1 scaling past it,
      // which made results worse there, is gone. Results at Courant numbers of 0.7 and under are unchanged.
      const omt0 = 1 - (g.theta ?? 0.8), scale = Math.min(1, dt / (0.9 * 0.7 * dtWave));   // dt <= cfl dtWave <= 0.7 dtWave always
      const theta = Math.fround(1 - Math.min(0.5, omt0 * scale));
      const co = { dt, n, theta, rain, drain: drainInHr / 12 / 3600, stages, tHours: th, pipes, sources };
      let hmC = 0, done = n;
      if (solver.kind === "cpu") {
        // the CPU runs the chunk in pieces of at most 10 steps, yielding between them so a stop request is seen within a second or two;
        // the step size and chunk time are the same as on the GPU, so both back ends take the same steps
        done = 0;
        while (done < n) {
          const m = Math.min(10, n - done); hmC = Math.max(hmC, await solver.chunk(Object.assign({}, co, { n: m }))); done += m;
          if (now() - lastYield > 50) { await yieldTask(); lastYield = now(); if (done < n && o.shouldStop && o.shouldStop()) { stopped = true; break; } }
        }
        if (stopped) span = dt * done;
      } else hmC = await solver.chunk(co);
      L.rain += rain * dt * done * g.multSum * A; L.inflow += qSrc * dt * done; L.captured += qSink * dt * done;
      if (o.afterChunk) await o.afterChunk(t / 3600, (t + dt * done) / 3600, solver);
      if (routed.length) {
        // the depth each edge cell had to be given (+) or lost (-) to hold the lake level over this chunk, since the last reading reset the tallies
        const levels0 = routed.map((r) => r.level), ext = o.lakeInflow ? await o.lakeInflow(t / 3600, (t + dt * done) / 3600, levels0.slice()) : null;
        if (o.lakeInflow && !(ext && ext.length === routed.length && Array.from(ext).every((v) => typeof v === "number" && Number.isFinite(v))))
          throw new Error(`Inflow to the routed lakes is missing or not a number at hour ${(t / 3600).toFixed(2)} (${JSON.stringify(ext && Array.from(ext))})`);
        const outV = routed.map(() => 0);
        for (const [i, r] of routed.entries()) {
          const cur = r.cells.length ? (solver.kind === "cpu" ? Float64Array.from(r.cells, (k) => solver.acc[4 * k + 3]) : Float64Array.from(await solver.cellsOf(solver.bAcc, r.cells, 3))) : new Float64Array(0);
          let dv = 0; for (let m = 0; m < cur.length; m++) dv += cur[m] - r.prev[m]; r.prev = cur;
          const used = dt * done, lv = levels0[i], V0 = r.S.vol(lv);
          const v2d = dv * A, vr = rain * used * r.S.area(lv), ve = ext ? ext[i] : 0;
          // the outlet runs at the level half way through the chunk (a midpoint step: the outflow at the start level, over half the chunk, gives
          // that level), and never takes the lake below its crest
          const qOut = (h) => (r.out ? r.out.q(h) : 0);
          const hMid = r.S.levelOf(V0 + 0.5 * (v2d + vr + ve - qOut(lv) * used));
          /* a rating curve steep enough can price the whole half-chunk release above the volume stored over its control,
           * which puts hMid below the control and releases nothing, chunk after chunk, a hair above it (0.6.1, review
           * 0.6.0 F-16): evaluate a rating's release at no less than the level whose stored volume is half the volume
           * the chunk leaves above the control. The volume cap below still keeps the release physical. */
          let hEval = hMid;
          if (r.out && r.out.kind === "rating") { const vEnd = V0 + v2d + vr + ve, avail = Math.max(vEnd - r.S.vol(r.out.ctl), 0);
            if (avail > 0) hEval = Math.max(hMid, r.S.levelOf(r.S.vol(r.out.ctl) + 0.5 * avail)); }
          const vo = r.out ? Math.min(qOut(hEval) * used, Math.max(V0 + v2d + vr + ve - r.S.vol(r.out.ctl), 0)) : 0;
          r.gain2d += v2d; r.gainRain += vr; r.gainExt += ve; r.outVol += vo; outV[i] = vo;
          r.level = r.S.levelOf(V0 + v2d + vr + ve - vo);
          const d = r.level - lv, rate = ve / used;
          // level dependence of the outside inflow, measured between this chunk and the last (only from a level change large enough to read)
          // measured against the last reading point, not only the previous chunk, so a slow drift is read too; until the first reading
          // (kSeen) a lake linked from outside is held to 1 s chunks (lakeDt). Without a new reading the estimate decays with a 10 min
          // half-life, so one spike no longer keeps the chunks short for the rest of a still period (round 4 ENG5-5).
          if (ext) {
            if (r.lastRate === null) { r.lastRate = rate; r.lastLv = lv; }
            else if (Math.abs(lv - r.lastLv) > 1e-4) { const k = -(rate - r.lastRate) / (lv - r.lastLv); r.kExt = Math.max(k > 0 ? k : 0, r.kExt * 0.9); r.kSeen = true; r.lastRate = rate; r.lastLv = lv; }
            else r.kExt *= Math.pow(0.5, used / 600);
          }
          if (Math.abs(d) > 0.02) r.cap = Math.max(0.05, used * 0.02 / Math.abs(d));
          else if (d * r.lastD < 0 && Math.min(Math.abs(d), Math.abs(r.lastD)) > 0.002) r.cap = Math.max(0.05, used * 0.5);
          else if (Number.isFinite(r.cap)) r.cap = Math.min(used, r.cap) * 1.5 > 3600 ? Infinity : Math.min(used, r.cap) * 1.5;
          r.lastD = d;
          // Only the 2D exchange is checked: a lake loses water to the land only down to its edge, so its 2D share alone cannot take it below
          // the grid's lowest ground. Outside withdrawals (water flowing back into SWMM) may lower a lidar lake below its flattened surface.
          // Outside inflow counts on the lake's side of the check: water that arrived from outside and then spilled to the land is booked in
          // gain2d as a loss, and a check that ignored its arrival would refuse a spilling, outfall-fed lake as a "numerical failure" (F-01).
          // outside withdrawals: a lake with a stage-area table cannot give up water below its bottom; one without has no known bottom,
          // so it is stopped 10 ft below the grid's lowest ground and asked for a table (round 4 ENG5-2: -5e6 cf a chunk took a lake to
          // -14 million ft, accepted). Withdrawals may still take a lidar lake below its flattened surface (0.4.3, ENG3-E4).
          const floor = r.tabled ? r.S.bottom : Math.min(zLow, r.start) - 10;
          if (r.level < floor - 1e-6) throw new Error(`Routed lake ${r.name} fell to ${r.level.toFixed(2)} ft at hour ${(t / 3600).toFixed(2)}, below ${r.tabled ? `the bottom of its stage-area table (${floor} ft)` : `10 ft under the grid's lowest ground (${floor.toFixed(2)} ft); give a stage-area table for a deeper lake`}: the water taken from it (outside withdrawals ${(-Math.min(r.gainExt, 0)).toFixed(0)} cf) is more than it holds`);
          const lv2d = r.S.levelOf(r.S.vol(r.start) + r.gain2d + r.gainRain + Math.max(r.gainExt, 0));
          if (lv2d < Math.min(zLow, r.start) - 0.01) throw new Error(`Routed lake ${r.name}: the water it exchanged with the 2D grid alone would put it at ${lv2d.toFixed(2)} ft, below the lowest ground of the grid (${zLow.toFixed(2)} ft), at hour ${(t / 3600).toFixed(2)}: a numerical failure`);
        }
        if (o.lakeOutflow && routed.some((r) => r.out)) await o.lakeOutflow(t / 3600, (t + dt * done) / 3600, outV);
        lakeSeries.push({ tHours: (t + dt * done) / 3600, levels: routed.map((r) => r.level) });
      }
      // next chunk: allow for the depth to grow by a quarter before the next reading
      hm = Math.max(hmC * 1.25, 0.05); o._dt = dt;
      t += span; steps += done; chunks++;
      if (stopped) break;
      if (t >= nextRead - 1e-6 || t >= tEnd - 1e-6) { nextRead = t + readSec; frames.push(await doRead(t >= tEnd - 1e-6)); for (const r of routed) r.prev.fill(0); }
      if (now() - lastYield > 50) { await yieldTask(); lastYield = now(); }
    }
    if (stopped && (!frames.length || frames[frames.length - 1].tHours < t / 3600 - 1e-9)) frames.push(await doRead(true));
    const vel = solver.readVel ? await solver.readVel() : null;
    const lakes = routed.length ? { names: routed.map((r) => r.name), lake: routed.map((r) => r.lake), area: routed.map((r) => r.area), start: (o.routedLakes || []).map((r) => r.level0),
      end: routed.map((r) => r.level), peak: routed.map((r, i) => lakeSeries.reduce((m, x) => Math.max(m, x.levels[i]), Math.max(r.level, (o.routedLakes || [])[i].level0))), from2d: routed.map((r) => r.gain2d), rain: routed.map((r) => r.gainRain), outside: routed.map((r) => r.gainExt), outlet: routed.map((r) => r.outVol), series: lakeSeries } : null;
    return { ledger: L, steps, chunks, frames, stopped, vmax: vel && vel.vmax, dvmax: vel && vel.dvmax, froude: vel && vel.froude, tvmax: vel && vel.tvmax, dvdur: vel && vel.dvdur, lakes };
  }

  // ------------------------------------------------------------------ lake-level spill (steady state of the 2D model with no rain)
  /* For each boundary node at level s, every open cell reachable from it through open cells with ground below s is under water to s.
   * Land below the lake's outlet crest (crests[i]) is not filled and stops the spread: below the crest it is the outlet channel,
   * whose flow the network model carries through the outlet structures. Where two lakes reach the same cell the higher level is kept. Returns depth per cell (Float32, 0 where dry; boundary cells get their own depth). */
  function pipeSeeds(pipes) { return pipes || []; }
  function levelFill(g, stages, out, crests, pipes, info) {
    const N = g.N, nx = g.nx, ny = g.ny, a = g.aux, lvl = new Float64Array(N).fill(-1e9), stack = new Int32Array(N);
    const K = stages.length;
    for (let i = 0; i < K; i++) {
      const s = stages[i], lo = crests ? crests[i] : -1e9; let sp = 0;
      for (let k = 0; k < N; k++) { const inf = a[4 * k + 2]; if ((inf & 3) === 2 && ((inf >> 4) & 255) === i) { if (s > lvl[k]) lvl[k] = s; stack[sp++] = k; } }
      // pipe connections: the connected cell fills from the lake when the lake is above its ground
      for (const pp of pipes || []) if (pp.lake === i && a[4 * pp.cell] < s && lvl[pp.cell] < s) { lvl[pp.cell] = s; stack[sp++] = pp.cell; }
      while (sp) {
        const k = stack[--sp], r = (k / nx) | 0, c = k - r * nx;
        const nb = [c > 0 ? k - 1 : -1, c < nx - 1 ? k + 1 : -1, r > 0 ? k - nx : -1, r < ny - 1 ? k + nx : -1];
        for (const j of nb) { if (j < 0) continue; if ((a[4 * j + 2] & 3) !== 0) continue; const zj = a[4 * j]; if (zj < s && zj >= lo && lvl[j] < s) { lvl[j] = s; stack[sp++] = j; } }
      }
    }
    const d = out || new Float32Array(N); let edge = 0;
    for (let k = 0; k < N; k++) {
      const t = a[4 * k + 2] & 3; d[k] = t === 1 ? 0 : Math.max(lvl[k] - a[4 * k], 0);
      if (t === 0 && d[k] > 0) { const r = (k / nx) | 0, c = k - r * nx; if (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) edge++; }
    }
    // lake water standing on an open tile edge would drain out of the tile without limit in the 2D model: report it
    if (info) info.edgeCells = edge;
    return d;
  }

  // ------------------------------------------------------------------ readouts
  /* excl: optional Uint8Array, 1 for cells that were already water at the start (canals, ponds below the lake level); they do not count */
  function readouts(g, st, thr, roadSegCount, excl) {
    const N = g.N, A = g.dx * g.dx; let wet = 0, wetMax = 0, hmx = 0, hmxMax = 0;
    for (let k = 0; k < N; k++) {
      if ((g.aux[4 * k + 2] & 3) !== 0 || (excl && excl[k])) continue;
      const h = st[4 * k], m = st[4 * k + 2];
      if (h > thr.wet_ft) wet++; if (m > thr.wet_ft) wetMax++; if (h > hmx) hmx = h; if (m > hmxMax) hmxMax = m;
    }
    const nb = g.bldStart ? g.bldStart.length - 1 : 0, bNow = new Uint8Array(nb), bMax = new Uint8Array(nb), bDepth = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let dn = 0, dm = 0; for (let i = g.bldStart[b]; i < g.bldStart[b + 1]; i++) { const k = g.bldCells[i]; if (excl && excl[k]) continue; dn = Math.max(dn, st[4 * k]); dm = Math.max(dm, st[4 * k + 2]); }
      bNow[b] = dn > thr.building_ft; bMax[b] = dm > thr.building_ft; bDepth[b] = dm;
    }
    const rNow = new Float32Array((roadSegCount || 0) + 1), rMax = new Float32Array((roadSegCount || 0) + 1);
    if (g.road) for (let k = 0; k < N; k++) { const s = g.road[k]; if (!s || (g.aux[4 * k + 2] & 3) !== 0 || (excl && excl[k])) continue; if (st[4 * k] > rNow[s]) rNow[s] = st[4 * k]; if (st[4 * k + 2] > rMax[s]) rMax[s] = st[4 * k + 2]; }
    let rCutNow = 0, rCutMax = 0; for (let s = 1; s < rNow.length; s++) { if (rNow[s] > thr.road_ft) rCutNow++; if (rMax[s] > thr.road_ft) rCutMax++; }
    let bn = 0, bm = 0; for (let b = 0; b < nb; b++) { bn += bNow[b]; bm += bMax[b]; }
    return { wetAc: wet * A / 43560, wetMaxAc: wetMax * A / 43560, depthMax: hmx, depthMaxEver: hmxMax, bldNow: bn, bldMax: bm, bldTotal: nb, bMax, bDepth, roadNow: rCutNow, roadMax: rCutMax, rNow, rMax };
  }

  const api = { G, KN, HMIN, VEL_H, levelFill, pipeSeeds, makeGrid, CpuSolver, GpuSolver, simulate, readouts, WGSL, b64dec, gaStep };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Flood2D = api;
})(typeof self !== "undefined" ? self : this);
