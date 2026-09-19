---
name: deploy-local
description: 'Deploy the MCount math quiz web app to the local network so it is reachable from a TV browser or other LAN devices. Use when the user asks to run, host, serve, expose, share, or deploy the app locally; troubleshoot LAN access, firewall, port, or "cannot reach from TV" issues; bind to 0.0.0.0; find the Mac LAN IP; configure auto-start with pm2 or launchd.'
---

# Deploy MCount to the Local Network

## When to Use

Trigger this skill when the user wants to:
- Run the app and open it from another device on the same Wi-Fi (TV, phone, tablet)
- Diagnose why the TV browser shows "cannot connect" / "site can't be reached"
- Bind the Express server to all interfaces (`0.0.0.0`) instead of `localhost`
- Find the Mac's LAN IP address
- Open the macOS firewall for the chosen port
- Keep the server running in the background (pm2 / launchd)

## Prerequisites

- Node.js 18+ installed (`node -v`)
- TV and Mac on the **same Wi-Fi / VLAN**
- Project dependencies installed (`npm install`)

## Procedure

### 1. Bind the server to all interfaces

In `server.js`, ensure the listener uses `0.0.0.0` (not the default `localhost`):

```js
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCount listening on http://0.0.0.0:${PORT}`);
});
```

`localhost` / `127.0.0.1` only accepts loopback traffic — the TV cannot reach it.

### 2. Find the Mac's LAN IP

```bash
ipconfig getifaddr en0   # Wi-Fi
ipconfig getifaddr en1   # Ethernet (try if en0 returns nothing)
```

Note the address, e.g. `192.168.1.42`.

### 3. Start the server

```bash
npm start
# or
node server.js
```

### 4. Open the macOS firewall (if blocked)

System Settings → Network → Firewall. Either:
- Turn the firewall off temporarily for testing, **or**
- Add `node` to the allowed apps list, **or** allow incoming on the chosen port.

### 5. Open from the TV

In the TV's browser, navigate to:

```
http://<mac-lan-ip>:3000
```

Example: `http://192.168.1.42:3000`

### 6. Run continuously (optional)

Keep it alive across terminal closes / reboots:

```bash
npm install -g pm2
pm2 start server.js --name mcount
pm2 save
pm2 startup    # follow the printed instructions to enable auto-start
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Works on Mac, fails on TV | Server bound to `localhost` | Bind to `0.0.0.0` (step 1) |
| Connection refused from TV | macOS firewall blocking `node` | Allow `node` in firewall (step 4) |
| Page loads but assets 404 | Wrong static path in Express | Verify `app.use(express.static('public'))` |
| TV browser too old (HTTPS errors) | Old WebKit on smart TV | Use plain `http://`, avoid ES2022+ syntax, no service workers |
| IP changes after reboot | DHCP lease | Reserve a static IP for the Mac in the router, or use mDNS: `http://<mac-name>.local:3000` |
| Port 3000 in use | Another process | `lsof -i :3000` then `kill <pid>`, or set `PORT=4000 npm start` |

## Verification Checklist

- [ ] `lsof -i :3000` shows `node` listening on `*:3000` (not `127.0.0.1:3000`)
- [ ] `curl http://<mac-lan-ip>:3000` from the Mac returns the page
- [ ] `curl http://<mac-lan-ip>:3000` from another device on the LAN returns the page
- [ ] TV browser loads the URL and shows a question + countdown

## Anti-patterns

- Hard-coding `localhost` in `app.listen()` — breaks LAN access.
- Using `https://` with a self-signed cert on a smart TV — most TV browsers reject it.
- Relying on `localhost:3000` in client-side `fetch()` calls — use **relative URLs** (`/api/question`) so the TV hits the server it loaded the page from.
