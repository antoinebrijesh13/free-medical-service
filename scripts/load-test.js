#!/usr/bin/env node
'use strict';
// Load test for POST /api/checkin. No dependencies (uses global fetch, Node >= 20).
//   node scripts/load-test.js [URL] [--requests 2000] [--concurrency 100]
//   URL may also come from the URL env var (default http://localhost:3000).
// Exits 1 on any non-2xx response, network error, or duplicate ticket numbers.
// NOTE: this adds real patients to the queue — use a throwaway DATA_DIR or /api/reset afterwards.

function parseArgs(argv) {
  const opts = { url: process.env.URL || 'http://localhost:3000', requests: 2000, concurrency: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split('=');
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--requests' || flag === '-n') opts.requests = Number(val());
    else if (flag === '--concurrency' || flag === '-c') opts.concurrency = Number(val());
    else if (flag === '--url') opts.url = val();
    else if (!a.startsWith('-')) opts.url = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!(opts.requests > 0) || !(opts.concurrency > 0)) throw new Error('requests and concurrency must be positive numbers');
  opts.url = opts.url.replace(/\/+$/, '');
  return opts;
}

const FIRST = ['Maria', 'José', 'Aisha', 'Wei', 'Olga', 'Juan', 'Fatima', 'Ahmed', 'Priya', 'Lucas', 'Amara', 'Kenji', 'Sofía', 'Mohammed', 'Elena', 'Tomás'];
const LAST = ['García', 'Okafor', 'Nguyen', 'Silva', 'Haddad', 'Kowalski', 'Mendoza', 'Rossi', 'Tanaka', 'Hernández', 'Mensah', 'Petrov'];
const COUNTRIES = ['Venezuela', 'Colombia', 'Peru', 'Honduras', 'Ukraine', 'Syria', 'Nigeria', 'Afghanistan', 'Haiti', 'Mexico'];
const REASONS = ['', '', 'Headache for three days', 'Check blood pressure', 'Toothache', 'Child has a fever', 'Prescription refill', 'Back pain', 'Cough'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function patient(i) {
  return {
    name: `${pick(FIRST)} ${pick(LAST)}`,
    age: Math.random() < 0.5 ? Math.floor(Math.random() * 90) : String(Math.floor(Math.random() * 90)),
    country: pick(COUNTRIES),
    reason: pick(REASONS),
    clientId: `load-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN);

async function main() {
  const { url, requests, concurrency } = parseArgs(process.argv.slice(2));
  console.log(`POST ${url}/api/checkin  requests=${requests} concurrency=${concurrency}`);

  const latencies = [];
  const statuses = {};
  const numbers = [];
  const errors = [];
  let next = 0;

  async function worker() {
    while (next < requests) {
      const i = next++;
      const t0 = performance.now();
      let status = 'network-error';
      try {
        const res = await fetch(`${url}/api/checkin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patient(i)),
        });
        status = res.status;
        const body = await res.json().catch(() => null);
        if (res.ok && body && Number.isInteger(body.number)) numbers.push(body.number);
        else if (errors.length < 5) errors.push(`${res.status} ${JSON.stringify(body)}`);
      } catch (e) {
        if (errors.length < 5) errors.push(String(e.cause || e));
      }
      latencies.push(performance.now() - t0);
      statuses[status] = (statuses[status] || 0) + 1;
    }
  }

  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
  const total = (performance.now() - start) / 1000;

  latencies.sort((a, b) => a - b);
  const dupes = numbers.length - new Set(numbers).size;
  const ms = (v) => `${v.toFixed(1)} ms`;
  console.log(`total time   ${total.toFixed(2)} s`);
  console.log(`throughput   ${(requests / total).toFixed(0)} req/s`);
  console.log(`latency      p50 ${ms(percentile(latencies, 50))}  p95 ${ms(percentile(latencies, 95))}  p99 ${ms(percentile(latencies, 99))}  max ${ms(latencies[latencies.length - 1])}`);
  console.log(`status codes ${Object.entries(statuses).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`numbers      ${numbers.length} returned, ${new Set(numbers).size} unique, ${dupes} duplicate(s)`);
  if (errors.length) console.log(`sample errors:\n  ${errors.join('\n  ')}`);

  const bad = Object.keys(statuses).some((s) => !/^2\d\d$/.test(s));
  if (bad || dupes > 0 || numbers.length !== requests) {
    console.log('FAIL');
    process.exit(1);
  }
  console.log('OK');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
