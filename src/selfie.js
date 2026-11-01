// Optional selfie for the multiplayer name tag. The photo is shrunk to a tiny 96x96 JPEG,
// kept in this browser's localStorage and sent only to the people in your room (never stored on the server).

const KEY = 'lordalto.selfie';
const SIZE = 96;
const MAX_LEN = 12_000; // data URL length budget (server accepts up to 14 KB)

export function savedSelfie() {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}
function store(v) {
  try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {}
}

export function selfieSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
}

let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  const s = document.createElement('style');
  s.textContent = `
  .selfie-modal{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(10,8,30,.78);backdrop-filter:blur(6px);padding:16px}
  .selfie-card{width:min(420px,100%);background:#1d1747;border:2px solid #ff9933;border-radius:22px;padding:18px;color:#fff;font-family:"Baloo 2",system-ui,sans-serif;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .selfie-card h3{margin:0 0 4px;font-family:"Bungee",system-ui,sans-serif;font-size:20px;letter-spacing:.5px;color:#ffc533}
  .selfie-card p{margin:0 0 12px;font-size:14px;opacity:.85}
  .selfie-view{position:relative;width:220px;height:220px;margin:0 auto 14px;border-radius:50%;overflow:hidden;border:5px solid #ffc533;background:#000}
  .selfie-view video,.selfie-view img{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
  .selfie-view img{transform:none}
  .selfie-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .selfie-row button{min-height:46px;padding:0 18px;border-radius:14px;border:0;font:700 16px "Baloo 2",system-ui,sans-serif;cursor:pointer;background:#2c2570;color:#fff}
  .selfie-row button.primary{background:#ff9933;color:#1d1747}
  .selfie-row button:focus-visible{outline:3px solid #ffc533;outline-offset:2px}
  .selfie-err{color:#ffb4b4;font-size:14px;margin:6px 0 10px}`;
  document.head.appendChild(s);
}

// Opens the camera modal. Resolves with the new data URL, null if removed, or undefined if cancelled.
export function openSelfie() {
  injectStyle();
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'selfie-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Take a selfie for your racer badge');
    const card = document.createElement('div'); card.className = 'selfie-card';
    const h = document.createElement('h3'); h.textContent = 'RACER SELFIE';
    const p = document.createElement('p'); p.textContent = 'Shown as a tiny badge above your Alto, only to friends in your room.';
    const view = document.createElement('div'); view.className = 'selfie-view';
    const video = document.createElement('video'); video.playsInline = true; video.muted = true; video.autoplay = true;
    const img = document.createElement('img'); img.alt = 'Your selfie'; img.hidden = true;
    view.append(video, img);
    const err = document.createElement('div'); err.className = 'selfie-err'; err.hidden = true;
    const row = document.createElement('div'); row.className = 'selfie-row';
    const mk = (label, cls) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; return b; };
    const snap = mk('SNAP', 'primary'), retake = mk('Retake'), use = mk('USE PHOTO', 'primary'), remove = mk('Remove photo'), cancel = mk('Cancel');
    retake.hidden = use.hidden = true;
    const existing = savedSelfie();
    remove.hidden = !existing;
    row.append(snap, retake, use, remove, cancel);
    card.append(h, p, view, err, row);
    modal.append(card);
    document.body.append(modal);

    let stream = null, shot = null;
    const stop = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; };
    const close = v => { stop(); modal.remove(); removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(undefined); };
    addEventListener('keydown', onKey);
    const fail = msg => { err.textContent = msg; err.hidden = false; snap.disabled = true; };

    async function startCam() {
      img.hidden = true; video.hidden = false; snap.hidden = false; retake.hidden = use.hidden = true;
      if (!selfieSupported()) return fail('Camera needs a secure (https) page. It will work once the game is online.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } }, audio: false });
        video.srcObject = stream;
        snap.disabled = false; snap.focus();
      } catch (e) {
        fail(e && e.name === 'NotAllowedError' ? 'Camera permission was blocked. You can still race with your initials.' : 'No camera found. You can still race with your initials.');
      }
    }

    snap.onclick = () => {
      if (!video.videoWidth) return;
      shot = capture(video);
      stop();
      img.src = shot; img.hidden = false; video.hidden = true;
      snap.hidden = true; retake.hidden = use.hidden = false; use.focus();
    };
    retake.onclick = () => startCam();
    use.onclick = () => { store(shot); close(shot); };
    remove.onclick = () => { store(null); close(null); };
    cancel.onclick = () => close(undefined);
    modal.addEventListener('click', e => { if (e.target === modal) close(undefined); });
    startCam();
  });
}

// Square centre crop, mirrored like a selfie preview, shrunk until it fits the size budget.
function capture(video) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const s = Math.min(video.videoWidth, video.videoHeight);
  const sx = (video.videoWidth - s) / 2, sy = (video.videoHeight - s) / 2;
  g.translate(SIZE, 0); g.scale(-1, 1);
  g.drawImage(video, sx, sy, s, s, 0, 0, SIZE, SIZE);
  let q = 0.8, url = c.toDataURL('image/jpeg', q);
  while (url.length > MAX_LEN && q > 0.3) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
  return url;
}
