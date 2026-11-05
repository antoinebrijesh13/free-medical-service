#!/usr/bin/env node
// Run the queue on a laptop at the venue and share it publicly through a Cloudflare Tunnel.
//
//   ADMIN_PASSWORD=... npm run venue
//
// Patients use the public https link (QR poster). Admin and TV should use the laptop's
// local address on the venue Wi-Fi: Cloudflare quick tunnels don't carry the live-update
// stream those screens use, and the local network is faster anyway.
//
// With your own named tunnel (stable address), start it yourself and run:
//   TUNNEL_URL=https://queue.example.org ADMIN_PASSWORD=... npm run venue

const { spawn } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || '3000';
let tunnel = null;

function startQuickTunnel() {
  return new Promise((resolve, reject) => {
    tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('cloudflared did not report a public URL within 45 s')), 45000);
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    tunnel.stdout.on('data', onData);
    tunnel.stderr.on('data', onData);
    tunnel.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT'
        ? new Error('cloudflared is not installed. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
        : err);
    });
    tunnel.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (code ${code})`));
      if (!stopping) { console.error('\ncloudflared stopped — the public link is down. Restart `npm run venue`.'); }
    });
  });
}

let stopping = false;
function stop() {
  stopping = true;
  if (tunnel) tunnel.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);

(async () => {
  let url = process.env.TUNNEL_URL;
  if (!url) {
    console.log('Starting Cloudflare tunnel…');
    try {
      url = await startQuickTunnel();
    } catch (err) {
      console.error('\n' + err.message);
      process.exit(1);
    }
  }
  url = url.replace(/\/+$/, '');
  process.env.PUBLIC_URL = url + '/';
  require('../server.js');

  const lan = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) lan.push(`http://${n.address}:${PORT}`);
  }
  const local = lan[0] || `http://localhost:${PORT}`;
  setTimeout(() => {
    console.log(`
  ────────────────────────────────────────────────────────────
   Patients (public):   ${url}/
   QR poster to print:  ${local}/poster

   On the venue Wi-Fi (same network as this laptop):
   Admin:               ${local}/admin
   TV display:          ${local}/display
  ────────────────────────────────────────────────────────────
   Keep this window open and the laptop plugged in and awake.
   Restarting creates a NEW public link — reprint the poster.
`);
  }, 300);
})();
