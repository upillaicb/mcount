# MCount

Minimal quiz web app: shows one question at a time with a countdown timer. Admin curates questions from a console and publishes them; participants join via a URL.

The same Express app runs locally on your Mac (`npm start`) and on Vercel. Data lives
in Supabase Postgres: a local Supabase stack in Docker for development, and one hosted
Supabase project for the Vercel deployment.

## Layout

- `server.js` — Express API; exports the app for Vercel and listens when run directly
- `db.js` — Postgres data layer (postgres.js)
- `dictionary.js` — dictionaryapi.dev lookups and flashcard helpers
- `supabase/migrations/` — database schema
- `public/admin.html`, `public/quiz.html` — admin console and original participant view
- `public/app/` — client SPA (no build step); `flashcards.js` is the vocabulary flashcard view
- `scripts/import-sqlite.js` — one-off import from the legacy `mcount.db`

## Run locally

Requires Node 22.13+ and Docker Desktop.

```bash
npm install
npm run db:start   # starts local Supabase and applies migrations
npm start
```

Server listens on `0.0.0.0:5555` so it's reachable on your LAN.

- Client library: `http://<your-ip>:5555/app/`
- Participant URL: `http://<your-ip>:5555/q/<quiz-slug>`
- Admin console: `http://<your-ip>:5555/admin.html`
- Supabase Studio (browse data): `http://localhost:54323`

Optional `.env` (loaded by `npm start`):

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres   # local default
ADMIN_TOKEN=admin123                                                     # local default
```

`npm run db:reset` wipes the local database and reapplies migrations. `npm run db:stop`
stops the Docker containers (data is kept).

### Importing the old SQLite data

```bash
npm run db:import-sqlite              # reads ./mcount.db into DATABASE_URL
npm run db:import-sqlite -- other.db  # or a specific file
```

The import refuses to run if the target already has quizzes.

## Deploy to Vercel

1. Create a Supabase project. Pick the region closest to your Vercel functions region.
2. Apply the schema: `npx supabase link --project-ref <ref>` then `npm run db:push`.
   Optionally import data with `DATABASE_URL=<hosted url> npm run db:import-sqlite`.
3. Import the repo in Vercel. Set environment variables:
   - `DATABASE_URL` — Supabase **transaction pooler** connection string (port 6543,
     from Project Settings → Database → Connect)
   - `ADMIN_TOKEN` — a long random string. Required; the app refuses to start on Vercel without it.
4. Verify a preview deployment before promoting it to production.

On Vercel, `public/` is served by the CDN (`npm run build` copies the lucide icons
into `public/app/vendor/`), `vercel.json` maps `/q/<slug>` and `/`, and `/api/*`
runs as a serverless function.

Notes:
- Free Supabase projects pause after a week without activity; restore from the dashboard.
- Tables have row-level security on with no policies, so the public Supabase Data API
  cannot read them. Only the server's `DATABASE_URL` connection can.

## Vocabulary flashcards

1. In the admin console, create a deck under **Flashcard decks** and paste or upload
   a word list (one per line, or comma-separated; up to 300 per upload).
2. Each word is looked up at `api.dictionaryapi.dev` in small batches, with a
   progress bar. Responses are cached in the `dictionary_cache` table, so a word is
   only fetched once across all decks. The chosen pronunciation recording is then
   copied into the `audio_files` table and served from `/api/audio/<id>`, because
   dictionaryapi.dev is too slow to play from directly. Words without a saved
   recording use the device's voice.
3. Click **Choose meanings** on a word to see every meaning grouped by part of
   speech. Tick up to the deck's **Meanings per card** limit (default 3), reword
   any meaning, or write your own (for words the dictionary doesn't have). Pick
   a US/UK recording or the device voice for pronunciation.
4. **Preview** opens the student view with the unpublished cards (uses the admin
   token saved in this browser). **Publish** freezes a copy for students; later
   edits stay invisible until you publish again.

Students open `/app/#/flashcards` to see published decks and study them: tap a
card to flip it, use ‹ › (or swipe, or the arrow keys) to move between cards,
and tap Listen for pronunciation. Shuffle and meaning-first are optional toggles.

## Client SPA

The client lists published runs only. Select Quiz for timed playback. Scores remain
managed by the existing admin console. The library refreshes every 15 seconds;
live scores refresh every 2 seconds. Playback timing is local to each device,
as in the original player.
Touch, keyboard, and directional remote navigation are supported. Escape or the
webOS Back key returns to the library from a player.

The manifest and service worker support installation in compatible browsers.
On iPad, open `/app/` in Safari and use Add to Home Screen. Trusted HTTPS is
required for service-worker caching (the Vercel deployment provides it); plain
HTTP localhost is allowed for development on the server machine. Only the client
shell is cached, not the active catalog or quiz data. Newly launched clients need
the server to play; already loaded content can continue during a disconnect,
without live scores.
LG TV browser access does not imply home-screen installation: a packaged webOS
application is a separate deployment task, and actual TV compatibility needs
device testing. Existing `/q/<quiz-slug>` links do not use the new service worker.

## Flow

1. Open the admin console, enter the token.
2. Create a quiz, add questions, and set question and answer durations.
3. Create a run, add participants, and publish the run.
4. Open the client library or the quiz's participant URL and start playback.
5. Manage participant scores in the admin console. Unpublish or complete the run
	to remove it from the active library.

Run `npm test` for API, asset, and legacy-route regression checks. Tests use
fixtures and do not touch the database.
