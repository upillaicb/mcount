# MCount

Minimal quiz web app: shows one question at a time with a countdown timer. Admin curates questions from a console and publishes them; participants join via a URL.

## Run

```bash
npm install
npm start
```

Server listens on `0.0.0.0:5555` so it's reachable on your LAN.

- Participant URL: `http://<your-ip>:5555/`
- Admin console: `http://<your-ip>:5555/admin.html`
- Default admin token: `admin123` (override with `ADMIN_TOKEN=... npm start`)

Questions and state are persisted in `questions.json`.

## Flow

1. Open the admin console, enter the token.
2. Add questions and set the timer duration.
3. Click **Publish** to start — participants see question 1 and a timer.
4. Use **Next / Previous** to advance. Timer resets on each move.
5. **Unpublish** hides questions from participants.
