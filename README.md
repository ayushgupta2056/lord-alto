# Lord Alto: Baroda Grand Prix

Browser 3D racing game: race 9 generations of the Alto through Vadodara (Bright Day School on Vasna-Bhayli Road, Laxmi Vilas Palace, Sursagar, Mandvi Gate, Alkapuri, Sayajigunj). Single player against 7 CPU rivals, or up to 8 friends online with a 4-digit room PIN. Works on laptops (keyboard/gamepad) and phones (touch or tilt) in the same room.

Ram someone with nitro on and it's **DHADAAAKK!**

## Run locally
```bash
npm install
npm run build
npm start            # http://localhost:8787  (game + multiplayer server)
```
Friends on the same Wi-Fi can open `http://<your-laptop-ip>:8787`. (Selfies need https, so they only work on the deployed site or on localhost.)

For development with hot reload, run `npm run server` and `npm run dev` in two terminals (Vite proxies `/ws` to the server).

Tests: `npm start` in one terminal, then `node server/test-client.mjs ws://localhost:8787/ws`.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates one Node web service (build `npm install && npm run build`, start `npm start`, health check `/healthz`).
3. Share the `https://<name>.onrender.com` link. Room links look like `https://<name>.onrender.com/?room=1234`.

Render's free plan sleeps after ~15 minutes idle; the first visit then takes ~30–60 s to wake. The Starter plan stays awake.

## Layout
| Path | What |
|---|---|
| `src/config.js` | Cars, tracks (real OpenStreetMap coordinates), economy |
| `src/main.js` | App flow, camera, render loop |
| `src/race.js`, `src/car.js`, `src/ai.js` | Race rules, laps, collisions/DHADAAAKK, name tags, physics, CPU drivers |
| `src/tracks.js`, `src/world.js`, `src/fx.js` | Track spline, Vadodara scenery and landmarks, particles |
| `src/carModel.js` | Procedural Alto models and mods |
| `src/ui.js`, `src/input.js`, `src/audio.js`, `src/style.css`, `index.html` | Screens, controls, procedural sound |
| `src/net.js`, `server/server.mjs` | Multiplayer client and server (rooms, batched state relay, selfie avatars) |
| `src/selfie.js` | Optional racer selfie (kept in the browser, sent only to your room) |

Map data © OpenStreetMap contributors (ODbL). "Alto" is used descriptively; no manufacturer logos are included.
