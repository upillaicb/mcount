# MCount

Minimal quiz web app: shows one question at a time with a countdown timer. Admin curates questions from a console and publishes them; participants join via a URL.

## Client SPA

The standalone client source lives in `client/`. The existing backend remains in
`server.js` and `db.js`; the original admin and quiz pages remain in `public/`.
There is no frontend build step. Run the same server with `npm start`.

- Client library: `http://<your-ip>:5555/app/`
- Original participant links: `http://<your-ip>:5555/q/<quiz-slug>`
- Original admin console: `http://<your-ip>:5555/admin.html`
- Public, read-only active content catalog: `/api/catalog`

The client lists published runs only. Select Quiz for timed playback or Flashcards
for manual question/answer study of the same published questions. Scores remain
managed by the existing admin console. The library refreshes every 15 seconds;
live scores refresh every 2 seconds. Playback timing is local to each device,
as in the original player.
Touch, keyboard, and directional remote navigation are supported. Escape or the
webOS Back key returns to the library from a player.

The manifest and service worker support installation in compatible browsers.
On iPad, open `/app/` in Safari and use Add to Home Screen. Trusted HTTPS is
required for service-worker caching over the LAN; plain HTTP localhost is allowed
for development on the server machine. Only the client shell is cached, not the
active catalog or quiz data. Newly launched clients need the server to play;
already loaded content can continue during a disconnect, without live scores.
LG TV browser access does not imply home-screen installation: a packaged webOS
application is a separate deployment task, and actual TV compatibility needs
device testing. Existing `/q/<quiz-slug>` links do not use the new service worker.

## Run

```bash
npm install
npm start
```

Server listens on `0.0.0.0:5555` so it's reachable on your LAN.

- Client library: `http://<your-ip>:5555/app/`
- Participant URL: `http://<your-ip>:5555/q/<quiz-slug>`
- Admin console: `http://<your-ip>:5555/admin.html`
- Default admin token: `admin123` (override with `ADMIN_TOKEN=... npm start`)

Questions, runs, participants, and scores are persisted in SQLite (`mcount.db`).

## Flow

1. Open the admin console, enter the token.
2. Create a quiz, add questions, and set question and answer durations.
3. Create a run, add participants, and publish the run.
4. Open the client library or the quiz's participant URL and start playback.
5. Manage participant scores in the admin console. Unpublish or complete the run
	to remove it from the active library.

Run `npm test` for API, asset, and legacy-route regression checks. Tests use
fixtures and do not open or modify the quiz database.
