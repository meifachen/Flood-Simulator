/* 3D view (three.js r147, WebGL): terrain from the grid, extruded buildings, animated water surface, SWMM nodes. */
"use strict";
const V3 = {
  r: null, scene: null, cam: null, ctl: null, grid: null, exag: 3, raf: 0, ro: null,
  available() { try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch (e) { return false; } },
  dispose() {
    if (!this.r) return; cancelAnimationFrame(this.raf);
    this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.r.dispose(); if (this.ro) this.ro.disconnect(); this.r.domElement.remove(); this.r = null; this.grid = null;
  },
  render() { if (this.r) this.r.render(this.scene, this.cam); },
  y(z) { return (z - this.zRef) * this.exag; },
  build() {
    const host = $("#v3d");
    if (!S.grid) { $("#b3d").textContent = "Run the model to see it in 3D."; return; }
    if (!this.available()) { $("#b3d").textContent = "3D needs WebGL, which this browser does not provide."; return; }
    if (this.r && this.grid === S.grid) { this.frame(); return; }
    this.dispose(); this.grid = S.grid;
    const G = S.grid.G, gz = S.grid.z, gt = S.grid.type, uf = S.dem.hUnitFt || 1, dx = G.cs * uf;   // horizontal ft per cell
    const s = this.s = Math.max(1, Math.ceil(Math.sqrt(G.nx * G.ny / 250000))), NX = this.NX = Math.floor(G.nx / s), NY = this.NY = Math.floor(G.ny / s);
    const W = G.nx * dx, H = G.ny * dx; this.W = W; this.H = H; this.dx = dx;
    let zs = [], zmin = Infinity; for (let k = 0; k < gz.length; k += 7) if (gt[k] !== 1 || gz[k] !== 0) { zs.push(gz[k]); if (gz[k] < zmin) zmin = gz[k]; }
    zs.sort((a, b) => a - b); this.zRef = zs.length ? zs[Math.floor(zs.length * 0.05)] - 2 : 0;
    const r = this.r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); r.setSize(host.clientWidth, host.clientHeight); host.appendChild(r.domElement);
    const sc = this.scene = new THREE.Scene(); sc.background = new THREE.Color(css("--bg"));
    const cam = this.cam = new THREE.PerspectiveCamera(40, host.clientWidth / host.clientHeight, 5, Math.max(W, H) * 20);
    sc.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 0.75)); const sun = new THREE.DirectionalLight(0xffffff, 0.65); sun.position.set(-W, Math.max(W, H) * 1.5, H * 0.7); sc.add(sun);
    const cell = (i, j) => (j * s) * G.nx + i * s;
    const n = NX * NY, pos = new Float32Array(3 * n), col = new Float32Array(3 * n);
    const zr = (zs[Math.floor(zs.length * 0.98)] || this.zRef + 10) - this.zRef || 1;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const v = j * NX + i, k = cell(i, j); pos[3 * v] = (i * s + 0.5) * dx - W / 2; pos[3 * v + 2] = (j * s + 0.5) * dx - H / 2;
      const t = Math.min(1, Math.max(0, (gz[k] - this.zRef) / zr)); col.set(gt[k] === 1 && gz[k] === 0 ? [0.5, 0.5, 0.5] : [0.52 + 0.25 * t, 0.62 + 0.15 * t, 0.46 + 0.22 * t], 3 * v);
    }
    const idx = new Uint32Array((NX - 1) * (NY - 1) * 6); let q = 0;
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, c = a + NX, e = c + 1; idx.set([a, c, b, b, c, e], q); q += 6; }
    const tg = new THREE.BufferGeometry(); tg.setAttribute("position", new THREE.BufferAttribute(pos, 3)); tg.setAttribute("color", new THREE.BufferAttribute(col, 3)); tg.setIndex(new THREE.BufferAttribute(idx, 1));
    this.terr = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true })); this.terr.frustumCulled = false; sc.add(this.terr);
    const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * n), 3)); wg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * n), 3)); wg.setIndex(new THREE.BufferAttribute(new Uint32Array(idx.length), 1));
    this.wat = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false })); this.wat.renderOrder = 2; this.wat.frustumCulled = false; sc.add(this.wat);
    // buildings
    const bpos = [], bidx = [], ranges = [], bz = [];
    const toLocal = (x, y) => [(x - G.x0) * uf - W / 2, (G.y1 - y) * uf - H / 2];
    const feats = S.grid.opts.useBuildings && S.bld ? S.bld.feats : [];
    feats.forEach((ft) => {
      const g = ft.geometry, rings = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]), v0 = bpos.length / 3;
      for (const ring of rings) {
        const pts = ring.map(([x, y]) => toLocal(x, y)); if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop(); if (pts.length < 3) continue;
        let area = 0, cx = 0, cz = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; area += x1 * z2 - x2 * z1; cx += x1; cz += z1; } area = Math.abs(area) / 2; cx /= pts.length; cz /= pts.length;
        const ci = Math.min(G.nx - 1, Math.max(0, Math.floor((cx + W / 2) / dx))), cj = Math.min(G.ny - 1, Math.max(0, Math.floor((cz + H / 2) / dx)));
        let zb = 1e9; for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) { const jj = cj + dj, ii = ci + di; if (jj < 0 || ii < 0 || jj >= G.ny || ii >= G.nx) continue; const kk = jj * G.nx + ii; if (gt[kk] === 0 && gz[kk] < zb) zb = gz[kk]; } if (zb > 1e8) zb = gz[cj * G.nx + ci];
        const hp = ft.properties && +ft.properties.height, ht = hp > 0 ? hp * uf : area < 3000 ? 13 : area < 10000 ? 18 : 26;   // heights assumed from footprint area when not given
        const base = bpos.length / 3, m = pts.length;
        for (const [x, z] of pts) { bpos.push(x, 0, z, x, 0, z); bz.push(zb, zb + ht); }
        for (let i = 0; i < m; i++) { const a = base + 2 * i, b = base + 2 * ((i + 1) % m); bidx.push(a, b, a + 1, b, b + 1, a + 1); }
        for (const t of THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), [])) bidx.push(base + 2 * t[0] + 1, base + 2 * t[1] + 1, base + 2 * t[2] + 1);
      }
      ranges.push([v0, bpos.length / 3]);
    });
    this.bZ = Float32Array.from(bz);
    const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bpos), 3)); bg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(bpos.length).fill(0.78), 3)); bg.setIndex(bidx);
    this.bld = new THREE.Mesh(bg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); this.bld.ranges = ranges; this.bld.frustumCulled = false; sc.add(this.bld);
    // SWMM nodes: small posts at the node, red while flooding
    this.nodes = [];
    if (S.swmm) for (const nd of S.swmm.nodes) {
      if (!Number.isFinite(nd.x) || !nd.inside) continue; const [x, z] = toLocal(nd.x, nd.y);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(2, dx * 0.6), Math.max(2, dx * 0.6), 1, 12), new THREE.MeshLambertMaterial({ color: css("--link") }));
      m.position.set(x, 0, z); m.userData = nd; sc.add(m); this.nodes.push(m);
    }
    // camera: oblique view from the south-west
    this.target = new THREE.Vector3(0, 0, 0); cam.position.set(-W * 0.55, Math.max(W, H) * 0.55, H * 0.85);
    const ctl = this.ctl = new THREE.OrbitControls(cam, r.domElement); ctl.target.copy(this.target); ctl.enableDamping = true; ctl.maxPolarAngle = Math.PI * 0.49; ctl.minDistance = dx * 5; ctl.maxDistance = Math.max(W, H) * 6;
    ctl.addEventListener("change", () => this.render());
    const loop = () => { this.raf = requestAnimationFrame(loop); if (ctl.update()) this.render(); }; loop();
    this.ro = new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; r.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); this.render(); }); this.ro.observe(host);
    this.heights(); this.frame();
  },
  heights() {
    const G = S.grid.G, s = this.s, NX = this.NX, NY = this.NY, p = this.terr.geometry.attributes.position.array, gz = S.grid.z, gt = S.grid.type;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const v = j * NX + i, k = (j * s) * G.nx + i * s; p[3 * v + 1] = this.y(gt[k] === 1 && gz[k] === 0 ? this.zRef : gz[k]); }
    this.terr.geometry.attributes.position.needsUpdate = true; this.terr.geometry.computeVertexNormals();
    const bp = this.bld.geometry.attributes.position.array; for (let v = 0; v < this.bZ.length; v++) bp[3 * v + 1] = this.y(this.bZ[v]);
    this.bld.geometry.attributes.position.needsUpdate = true; this.bld.geometry.computeVertexNormals();
    for (const m of this.nodes) { const nd = m.userData, top = this.y(nd.rimFt + 6), bot = this.y(nd.rimFt - 1); m.scale.y = Math.max(1, top - bot); m.position.y = (top + bot) / 2; }
  },
  frame() {
    if (!this.r || !S.frames.length) { this.render(); return; }
    const G = S.grid.G, s = this.s, NX = this.NX, NY = this.NY, gz = S.grid.z, gt = S.grid.type, wet = S.grid.opts.wetFt;
    const wp = this.wat.geometry.attributes.position.array, wc = this.wat.geometry.attributes.color.array, tp = this.terr.geometry.attributes.position.array;
    const rp = ramp().map((c) => c.map((x) => x / 255)), lw = css("--water"), lake = [parseInt(lw.slice(1, 3), 16) / 255, parseInt(lw.slice(3, 5), 16) / 255, parseInt(lw.slice(5, 7), 16) / 255];
    const w = new Uint8Array(NX * NY);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const v = j * NX + i, k = (j * s) * G.nx + i * s, d = gt[k] === 1 ? 0 : depthAt(k);
      wp[3 * v] = tp[3 * v]; wp[3 * v + 2] = tp[3 * v + 2]; wp[3 * v + 1] = this.y(gz[k] + d) + 0.4;
      if (gt[k] === 2 || d >= wet) w[v] = 1;   // a level boundary is always water
      wc.set(gt[k] === 2 ? lake : rp[Math.max(0, dclass(d))], 3 * v);
    }
    const ix = this.wat.geometry.index.array; let q = 0;
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, c = a + NX, e = c + 1; if (w[a] + w[b] + w[c] + w[e] >= 2) { ix[q++] = a; ix[q++] = c; ix[q++] = b; ix[q++] = b; ix[q++] = c; ix[q++] = e; } }
    const g = this.wat.geometry; g.setDrawRange(0, q); g.index.needsUpdate = true; g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.computeVertexNormals();
    // buildings red when the water beside them is over the threshold (from the worker's per-building maxima for "max", else this frame)
    const bc = this.bld.geometry.attributes.color.array, thr = S.grid.opts.buildingFt, t = curT();
    this.bld.ranges.forEach(([a, b], i) => { const hit = S.view === "max" && S.final ? S.final.bMax[i] > thr : false; for (let v = a; v < b; v++) bc.set(hit ? [0.70, 0.15, 0.12] : [0.80, 0.78, 0.74], 3 * v); });
    this.bld.geometry.attributes.color.needsUpdate = true;
    for (const m of this.nodes) { const qn = rateNow(m.userData); m.material.color.set(qn > 0 ? css("--node") : css("--link")); }
    const f = S.frames[S.frame];
    $("#b3d").innerHTML = `${S.view === "max" ? "Maximum depth over the run" : esc(clock(f.sum.tHours))}<br>Flooded ${fmt(f.sum.wetAc, 2)} ac; SWMM flooding ${fmt(f.sum.inflowCfs, 1)} cfs<br>
      <label>Vertical exaggeration <select id="v3-ex">${[1, 2, 3, 5, 10].map((x) => `<option ${x === this.exag ? "selected" : ""}>${x}</option>`).join("")}</select></label><br><span class="note">Drag to rotate, right-drag to pan, scroll to zoom. Building heights are assumed from footprint area unless the file gives them.</span>`;
    $("#v3-ex").onchange = (e) => { this.exag = +e.target.value; this.heights(); this.frame(); };
    this.render();
  },
};
