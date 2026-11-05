# Queue

A minimal, fast patient queue for a one-day free medical camp.

| Page | Who | What |
|---|---|---|
| `/` | Patients (phones, via QR code) | Name, age, country, reason (optional) → get a number. The page then shows how many people are ahead and alerts when it's their turn. |
| `/admin` | You | Full control: call next, edit, reorder, move back to queue, delete, add people, search, export CSV, reset. |
| `/display` | TV in the waiting room | Who is being served (number + name) and how many are waiting. Chimes on each new call. |
| `/poster` | Print once | A4 poster with the QR code to the check-in page. |

One Node process with a local SQLite file — no external database, so every request
is a sub-millisecond local write. Admin and display screens update live (Server-Sent Events).

## Run locally

```bash
npm install
```

```bash
ADMIN_PASSWORD='choose-something' npm start
```

Open http://localhost:3000 (check-in), http://localhost:3000/admin and http://localhost:3000/display.

## Settings

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | **Set this.** Used for `/admin` and `/display`. |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | Where `queue.db` lives. Must be on a persistent disk when deployed. |
| `PUBLIC_URL` | from request | Public address used for the QR code, e.g. `https://queue.example.org`. |

## Load test

```bash
npm run load-test -- --requests 2000 --concurrency 100
```

Point it elsewhere with `URL=https://your-app npm run load-test`. Only run it against
a deployment before the event, then press **Reset day** in admin.

## Run it from a laptop at the venue (recommended)

1. Install [Node.js 22](https://nodejs.org) and
   [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   (macOS: `brew install cloudflared`, Windows: `winget install Cloudflare.cloudflared`).
2. In this folder, install the dependencies:

   ```bash
   npm install
   ```

3. Start the server and the tunnel together:

   ```bash
   ADMIN_PASSWORD='choose-something' npm run venue
   ```

   On Windows PowerShell, set the password first, then start:

   ```powershell
   $env:ADMIN_PASSWORD='choose-something'
   ```

   ```powershell
   npm run venue
   ```

4. It prints your links:
   - **Patients:** the public `https://….trycloudflare.com` link. This is what the QR code opens.
   - **Admin, TV and poster:** the laptop's local address, `http://192.168.x.x:3000/…`.
     Open these on devices connected to the **same Wi-Fi** as the laptop.
     Cloudflare's free quick tunnels don't carry the live-update connection these screens
     use, and the local network is faster anyway.
5. Open `/poster` from that local address and print it. It shows the public link and its QR code.

**Before the event**
- **Rehearse once at home.** Check in with your phone on mobile data, open admin and the TV
  on your Wi-Fi, then press **Reset day**.
- **Keep the public link the same.** Every restart of `npm run venue` creates a new public
  link, so start it once in the morning, then print the poster. For a permanent address, use a
  [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
  on your own domain, start it yourself, and run with `TUNNEL_URL=https://queue.yourdomain.org`.
  A named tunnel also carries live updates, so admin and the TV can use the public link too.
- **Keep the laptop awake.** Plug it in and turn sleep off (macOS: run `caffeinate -d` in
  another window; Windows: Settings → Power → Never).
- **The data is safe if something stops.** The queue lives in `data/queue.db`, so if the
  laptop or the app restarts, nobody loses their number.

## Deploy to a server instead

Run exactly **one** instance (SQLite is a local file) on an always-on machine with a
persistent disk mounted at `/data`. Avoid free tiers that sleep — the first visitor
after a sleep waits ~30–60 s, which is what made the old Render setup feel slow.
A `Dockerfile` is included, so any of these work:

- **Railway** — New project → Deploy from GitHub repo → add a Volume mounted at `/data`
  → set `ADMIN_PASSWORD` → Settings → Networking → Generate domain.
- **Fly.io** — `fly launch` (keep 1 machine), `fly volumes create data --size 1`,
  mount it at `/data` in `fly.toml`, `fly secrets set ADMIN_PASSWORD=…`, and set
  `auto_stop_machines = "off"`.
- **Render** — a paid *Starter* web service (free tier sleeps and has no disk),
  runtime Docker, add a Disk mounted at `/data`, set `ADMIN_PASSWORD`.
- **A laptop at the venue** — see the section above.

On the day: open `/admin` on your device and `/display` on the TV (log in once on each),
print `/poster`, and you're running. Export the CSV at the end.
