import * as THREE from 'three';

// Checkpoint gates: an arch spanning the road at each ordered checkpoint, with the checkpoint's name on
// both faces. The next checkpoint's gate glows; passed ones dim. Pillars stand just outside the drivable
// strip (the physics wall is at halfWidth + 4.8), so they never block the road.

const PILLAR = 0.9, HEIGHT = 7.2, BEAM_H = 1.7;

function bannerTexture(num, total, name) {
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
  // label
  g.textAlign = 'left';
  g.fillStyle = '#ffc533'; g.font = '800 30px "Baloo 2", system-ui, sans-serif';
  g.fillText(`CHECKPOINT ${num}/${total}`, 178, 50);
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
  // cps: [{ id, name, index, finish? }] in race order (the finish is skipped: the start gantry is the finish gate)
  constructor(scene, track, cps) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'checkpoint-gates';
    this.gates = [];
    this.disposables = [];
    const total = cps.length;
    const pillarMat = new THREE.MeshStandardMaterial({ color: '#e8862a', roughness: 0.55, metalness: 0.1 });
    const bandMat = new THREE.MeshStandardMaterial({ color: '#1d1747', roughness: 0.6 });
    const capMat = new THREE.MeshStandardMaterial({ color: '#ffc533', roughness: 0.4, metalness: 0.3 });
    this.disposables.push(pillarMat, bandMat, capMat);
    const pillarGeo = new THREE.BoxGeometry(PILLAR, HEIGHT, PILLAR).translate(0, HEIGHT / 2, 0);
    const bandGeo = new THREE.BoxGeometry(PILLAR + 0.12, 0.45, PILLAR + 0.12);
    const capGeo = new THREE.ConeGeometry(0.75, 1.0, 4).rotateY(Math.PI / 4);
    this.disposables.push(pillarGeo, bandGeo, capGeo);

    cps.forEach((cp, k) => {
      if (cp.finish || cp.index == null) return;
      const i = cp.index;
      const px = track.x[i], pz = track.z[i], py = track.y ? track.y[i] || 0 : 0;
      const tx = track.tx[i], tz = track.tz[i];
      const half = track.halfWidth + 5.15;
      const gate = new THREE.Group();
      gate.position.set(px, py, pz);
      gate.rotation.y = Math.atan2(tx, tz); // local +Z = travel direction, local X = across the road
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(pillarGeo, pillarMat); p.position.x = s * half; p.castShadow = true; gate.add(p);
        for (const y of [1.2, HEIGHT - 2.4]) { const b = new THREE.Mesh(bandGeo, bandMat); b.position.set(s * half, y, 0); gate.add(b); }
        const c = new THREE.Mesh(capGeo, capMat); c.position.set(s * half, HEIGHT + BEAM_H + 0.5, 0); gate.add(c);
      }
      // Beam with the name banner on both faces
      const span = half * 2 + PILLAR;
      const beamGeo = new THREE.BoxGeometry(span, BEAM_H, 0.6);
      const beam = new THREE.Mesh(beamGeo, bandMat); beam.position.y = HEIGHT + BEAM_H / 2; beam.castShadow = true; gate.add(beam);
      const tex = bannerTexture(k + 1, total, cp.name);
      const bannerMat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.55, roughness: 0.7 });
      const bw = Math.min(span - 1.2, 18), bh = bw * 176 / 1024;
      const bannerGeo = new THREE.PlaneGeometry(bw, bh);
      for (const face of [-1, 1]) {
        const m = new THREE.Mesh(bannerGeo, bannerMat);
        m.position.set(0, HEIGHT + BEAM_H / 2, face * 0.31);
        if (face < 0) m.rotation.y = Math.PI; // the face looking back at oncoming cars
        gate.add(m);
      }
      // Light strip under the beam: glows on the next checkpoint
      const stripMat = new THREE.MeshStandardMaterial({ color: '#3a3360', emissive: new THREE.Color('#ffc533'), emissiveIntensity: 0 });
      const stripGeo = new THREE.BoxGeometry(span - 0.4, 0.16, 0.66);
      const strip = new THREE.Mesh(stripGeo, stripMat); strip.position.y = HEIGHT - 0.08; gate.add(strip);
      this.disposables.push(beamGeo, bannerGeo, tex, bannerMat, stripMat, stripGeo);
      this.group.add(gate);
      this.gates.push({ cp, gate, bannerMat, stripMat, order: k });
    });
    scene.add(this.group);
    this.setNext(0);
  }

  // n = index of the next checkpoint (0-based, in race order); gates before it are "passed"
  setNext(n) {
    if (this.next === n) return;
    this.next = n;
    for (const g of this.gates) {
      const isNext = g.order === n, passed = g.order < n;
      g.stripMat.emissiveIntensity = isNext ? 2.2 : passed ? 0 : 0.35;
      g.bannerMat.emissiveIntensity = isNext ? 0.75 : passed ? 0.25 : 0.5;
      g.bannerMat.color.setScalar(passed ? 0.6 : 1);
    }
  }

  update(t) {
    // gentle pulse on the next gate's light strip
    const g = this.gates.find(x => x.order === this.next);
    if (g) g.stripMat.emissiveIntensity = 1.6 + Math.sin(t * 5) * 0.8;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.gates = [];
  }
}
