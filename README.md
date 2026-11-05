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

## Deploy

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
- **A laptop at the venue** — `npm start`, then expose it with
  `cloudflared tunnel --url http://localhost:3000` for a public https link. Fastest
  option, but depends on the venue's internet and the laptop staying awake.

On the day: open `/admin` on your device and `/display` on the TV (log in once on each),
print `/poster`, and you're running. Export the CSV at the end.
