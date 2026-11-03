import * as THREE from 'three';

// Checkpoint photo gates (School Se Ghar Tak). Each ordered checkpoint gets an arch spanning the road:
//   - the player's own photo of the place, whole, in a big gold-trimmed frame on top (both faces)
//   - a name banner on the beam ("CHECKPOINT 2/5 · ADDA")
//   - light strips + pillar lamps that glow on the NEXT checkpoint and dim once it is passed
// The finish (Petals) gets the same gate just before the start/finish line.
// Pillars stand just outside the drivable strip (the physics wall is at halfWidth + 4.8), so they never block the road.

const PILLAR = 1.0, HEIGHT = 7.4, BEAM_H = 1.8;

// The player's photos, shown whole (graded to the game palette, nothing cropped)
const PHOTOS = {
  shangrila: { file: 'full-shangrila.jpg', aspect: 1024 / 768 },
  adda: { file: 'full-adda.jpg', aspect: 1024 / 495 },
  vidhi: { file: 'full-vidhi.jpg', aspect: 1024 / 898 },
  brightday: { file: 'full-brightday.jpg', aspect: 1024 / 768 },
  petals: { file: 'full-petals.jpg', aspect: 1024 / 585 },
};
const loader = new THREE.TextureLoader();

function bannerTexture(label, total, num, name) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 176;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 176);
  grd.addColorStop(0, '#2a2266'); grd.addColorStop(1, '#16113f');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 176);
  // bandhani-style dot border
  g.fillStyle = '#ffc533';
  for (let x = 14; x < 1024; x += 22) { g.beginPath(); g.arc(x, 10, 3.2, 0, 6.29); g.fill(); g.beginPath(); g.arc(x, 166, 3.2, 0, 6.29); g.fill(); }
  // number badge
  g.beginPath(); g.arc(98, 88, 56, 0, 6.29); g.fillStyle = '#ff9933'; g.fill();
  g.lineWidth = 6; g.strokeStyle = '#ffc533'; g.stroke();
  g.fillStyle = '#1d1747'; g.font = '900 64px "Bungee", "Baloo 2", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), 98, 92);
  g.textAlign = 'left';
  g.fillStyle = '#ffc533'; g.font = '800 30px "Baloo 2", system-ui, sans-serif';
  g.fillText(label === 'finish' ? 'FINISH LINE' : `CHECKPOINT ${num}/${total}`, 178, 50);
  g.fillStyle = '#ffffff';
  let size = 76;
  const fontFor = (s) => `900 ${s}px "Bungee", "Baloo 2", "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif`;
  g.font = fontFor(size);
  while (g.measureText(name).width > 800 && size > 40) { size -= 4; g.font = fontFor(size); }
  g.fillText(name, 176, 116);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class CheckpointGates {
  // cps: [{ id, name, index?, finish? }] in race order
  constructor(scene, track, cps) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'checkpoint-gates';
    this.gates = [];
    this.disposables = [];
    const total = cps.length;
    const M = (o) => { const m = new THREE.MeshStandardMaterial(o); this.disposables.push(m); return m; };
    const pillarMat = M({ color: '#e8862a', roughness: 0.55, metalness: 0.1 });
    const bandMat = M({ color: '#1d1747', roughness: 0.6 });
    const goldMat = M({ color: '#ffc533', roughness: 0.35, metalness: 0.45 });
    const G = (geo) => { this.disposables.push(geo); return geo; };
    const pillarGeo = G(new THREE.BoxGeometry(PILLAR, HEIGHT, PILLAR).translate(0, HEIGHT / 2, 0));
    const bandGeo = G(new THREE.BoxGeometry(PILLAR + 0.14, 0.45, PILLAR + 0.14));
    const plinthGeo = G(new THREE.BoxGeometry(PILLAR + 0.5, 1.0, PILLAR + 0.5).translate(0, 0.5, 0));
    const domeGeo = G(new THREE.SphereGeometry(0.62, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2));
    const finialGeo = G(new THREE.ConeGeometry(0.14, 0.7, 8));
    const lampGeo = G(new THREE.SphereGeometry(0.2, 10, 8));

    cps.forEach((cp, k) => {
      const isFinish = !!cp.finish;
      const i = isFinish ? (track.N - 45) % track.N : cp.index;
      if (i == null) return;
      const px = track.x[i], pz = track.z[i], py = track.y ? track.y[i] || 0 : 0;
      const tx = track.tx[i], tz = track.tz[i];
      const half = track.halfWidth + 5.2;
      const span = half * 2 + PILLAR;
      const gate = new THREE.Group();
      gate.position.set(px, py, pz);
      gate.rotation.y = Math.atan2(tx, tz); // local +Z = direction of travel, local X = across the road

      // pillars: plinth, two bands, a little dome + finial on top, and a lamp facing oncoming cars
      const lampMat = M({ color: '#3a3360', emissive: new THREE.Color('#ffc533'), emissiveIntensity: 0.3 });
      for (const s of [-1, 1]) {
        const x = s * half;
        const pl = new THREE.Mesh(plinthGeo, bandMat); pl.position.x = x; gate.add(pl);
        const p = new THREE.Mesh(pillarGeo, pillarMat); p.position.x = x; p.castShadow = true; gate.add(p);
        for (const y of [1.5, HEIGHT - 2.2]) { const b = new THREE.Mesh(bandGeo, bandMat); b.position.set(x, y, 0); gate.add(b); }
        const lamp = new THREE.Mesh(lampGeo, lampMat); lamp.position.set(x - s * 0.1, HEIGHT - 3.4, -PILLAR / 2 - 0.12); gate.add(lamp);
      }

      // beam + name banner on both faces
      const beam = new THREE.Mesh(G(new THREE.BoxGeometry(span, BEAM_H, 0.7)), bandMat);
      beam.position.y = HEIGHT + BEAM_H / 2; beam.castShadow = true; gate.add(beam);
      const tex = bannerTexture(isFinish ? 'finish' : 'cp', total, k + 1, isFinish ? 'FINISH · ' + cp.name : cp.name);
      this.disposables.push(tex);
      const bannerMat = M({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.55, roughness: 0.7 });
      const bw = Math.min(span - 1.2, 18), bh = Math.min(BEAM_H - 0.1, bw * 176 / 1024);
      const bannerGeo = G(new THREE.PlaneGeometry(bh * 1024 / 176, bh));
      for (const face of [-1, 1]) {
        const m = new THREE.Mesh(bannerGeo, bannerMat);
        m.position.set(0, HEIGHT + BEAM_H / 2, face * 0.36);
        if (face < 0) m.rotation.y = Math.PI;
        gate.add(m);
      }
      // glowing strip under the beam
      const stripMat = M({ color: '#3a3360', emissive: new THREE.Color('#ffc533'), emissiveIntensity: 0 });
      const strip = new THREE.Mesh(G(new THREE.BoxGeometry(span - 0.4, 0.18, 0.76)), stripMat); strip.position.y = HEIGHT - 0.09; gate.add(strip);

      // the player's photo, whole, in a gold-trimmed frame on top of the gate (both faces)
      const ph = PHOTOS[cp.id];
      let photoTop = HEIGHT + BEAM_H;
      if (ph) {
        let W = Math.min(span * 0.62, 15.5), H = W / ph.aspect;
        if (H > 9) { H = 9; W = H * ph.aspect; }
        const y0 = HEIGHT + BEAM_H + 0.35;
        const ptex = loader.load('/photos/' + ph.file);
        ptex.colorSpace = THREE.SRGBColorSpace; ptex.anisotropy = 8;
        this.disposables.push(ptex);
        const photoMat = M({ map: ptex, emissiveMap: ptex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.28, roughness: 0.85 });
        const frame = new THREE.Mesh(G(new THREE.BoxGeometry(W + 0.9, H + 0.9, 0.5)), bandMat);
        frame.position.set(0, y0 + H / 2 + 0.45, 0); frame.castShadow = true; gate.add(frame);
        const photoGeo = G(new THREE.PlaneGeometry(W, H));
        for (const face of [-1, 1]) {
          const ph3 = new THREE.Mesh(photoGeo, photoMat);
          ph3.position.set(0, y0 + H / 2 + 0.45, face * 0.27);
          if (face < 0) ph3.rotation.y = Math.PI;
          gate.add(ph3);
        }
        // gold trim around the frame
        const trimH = G(new THREE.BoxGeometry(W + 1.3, 0.24, 0.62));
        const trimV = G(new THREE.BoxGeometry(0.24, H + 1.3, 0.62));
        for (const y of [y0 - 0.02, y0 + H + 0.92]) { const t = new THREE.Mesh(trimH, goldMat); t.position.set(0, y, 0); gate.add(t); }
        for (const x of [-(W + 1.06) / 2, (W + 1.06) / 2]) { const t = new THREE.Mesh(trimV, goldMat); t.position.set(x, y0 + H / 2 + 0.45, 0); gate.add(t); }
        // little gold crown in the middle of the top edge
        const crown = new THREE.Mesh(domeGeo, goldMat); crown.position.set(0, y0 + H + 1.04, 0); crown.scale.set(1.3, 0.9, 0.6); gate.add(crown);
        const fin = new THREE.Mesh(finialGeo, goldMat); fin.position.set(0, y0 + H + 1.9, 0); gate.add(fin);
        photoTop = y0 + H + 1.0;
      }
      // pillar caps
      for (const s of [-1, 1]) {
        const d = new THREE.Mesh(domeGeo, goldMat); d.position.set(s * half, HEIGHT + BEAM_H, 0); gate.add(d);
        const f = new THREE.Mesh(finialGeo, goldMat); f.position.set(s * half, HEIGHT + BEAM_H + 0.95, 0); gate.add(f);
      }
      gate.userData.top = photoTop;
      this.group.add(gate);
      this.gates.push({ cp, gate, bannerMat, stripMat, lampMat, order: k });
    });
    scene.add(this.group);
    this.setNext(0);
  }

  // n = index of the next checkpoint in race order; gates before it are "passed"
  setNext(n) {
    if (this.next === n) return;
    this.next = n;
    for (const g of this.gates) {
      const isNext = g.order === n, passed = g.order < n;
      g.stripMat.emissiveIntensity = isNext ? 2.2 : passed ? 0 : 0.35;
      g.lampMat.emissiveIntensity = isNext ? 2.4 : passed ? 0.1 : 0.4;
      g.bannerMat.emissiveIntensity = isNext ? 0.75 : passed ? 0.3 : 0.5;
      g.bannerMat.color.setScalar(passed ? 0.65 : 1);
    }
  }

  update(t) {
    // gentle pulse on the next gate's lights
    const g = this.gates.find(x => x.order === this.next);
    if (g) { const p = Math.sin(t * 5); g.stripMat.emissiveIntensity = 1.6 + p * 0.8; g.lampMat.emissiveIntensity = 1.8 + p * 0.9; }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.gates = [];
  }
}
