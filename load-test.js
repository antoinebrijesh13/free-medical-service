#!/usr/bin/env node

const { performance } = require('node:perf_hooks');

const DEFAULT_TARGET = 'https://free-medical-service.onrender.com/api/checkin';
const DEFAULT_REQUESTS = 100;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 10000;

const firstNames = [
  'Alex',
  'Jordan',
  'Sam',
  'Taylor',
  'Riley',
  'Morgan',
  'Casey',
  'Jamie',
  'Avery',
  'Drew',
  'Cameron',
  'Devin',
  'Harper',
  'Reese',
  'Quinn',
  'Dakota',
  'Skyler',
  'Rowan',
  'Peyton',
  'Emery',
];

const lastNames = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Miller',
  'Davis',
  'Garcia',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
];

const countries = [
  'United States',
  'Canada',
  'India',
  'China',
  'Nigeria',
  'Kenya',
  'Brazil',
  'Mexico',
  'Germany',
  'France',
  'Japan',
  'South Korea',
  'Australia',
  'New Zealand',
  'South Africa',
  'Ghana',
  'Spain',
  'Italy',
  'Vietnam',
  'Philippines',
];

const detailPhrases = [
  'General checkup requested',
  'Follow-up consultation',
  'Vaccination inquiry',
  'Vision test needed',
  'Hearing concerns',
  'Blood pressure screening',
  'Routine physical',
  'New student orientation',
  'Needs interpreter assistance',
  'Allergy evaluation',
];

const sexOptions = ['Female', 'Male', 'Other', 'Prefer not to say'];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (!arg.startsWith('--')) {
      continue;
    }

    const eqIndex = arg.indexOf('=');
    if (eqIndex !== -1) {
      const key = arg.slice(2, eqIndex);
      const value = arg.slice(eqIndex + 1);
      options[key] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }

  return options;
}

function getStringOption(options, key, envKey, fallback) {
  if (options[key] !== undefined) {
    return String(options[key]);
  }
  if (process.env[envKey] !== undefined) {
    return String(process.env[envKey]);
  }
  return fallback;
}

function getNumberOption(options, key, envKey, fallback) {
  const value = getStringOption(options, key, envKey, undefined);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBooleanOption(options, key, envKey, fallback) {
  const value = getStringOption(options, key, envKey, undefined);
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomName() {
  return `${randomElement(firstNames)} ${randomElement(lastNames)}`;
}

function randomCountry() {
  return randomElement(countries);
}

function randomDetails() {
  return Math.random() < 0.6 ? randomElement(detailPhrases) : '';
}

function randomAge() {
  return Math.floor(Math.random() * 48) + 18;
}

function randomSex() {
  return randomElement(sexOptions);
}

function randomPhone() {
  const countryCode = ['+1', '+44', '+61', '+81', '+91', '+254'][Math.floor(Math.random() * 6)];
  const subscriber = Math.floor(100000000 + Math.random() * 900000000).toString();
  return `${countryCode} ${subscriber}`;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) {
    return 0;
  }

  if (p <= 0) {
    return sortedValues[0];
  }

  if (p >= 100) {
    return sortedValues[sortedValues.length - 1];
  }

  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

async function makeRequest(target, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    name: randomName(),
    age: randomAge(),
    country: randomCountry(),
    details: randomDetails(),
    sex: randomSex(),
    phone: randomPhone(),
  };

  const started = performance.now();
  let status = 'ERR';

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    status = response.status;

    let data = null;
    try {
      data = await response.json();
    } catch (parseErr) {
      // Ignore JSON parse errors, they will be handled below.
    }

    if (!response.ok || !data?.success) {
      const message = data?.error || `Request failed with status ${response.status}`;
      throw new Error(message);
    }

    const latency = performance.now() - started;
    return { latency, status, success: true };
  } catch (error) {
    if (error?.name === 'AbortError') {
      status = 'TIMEOUT';
    }

    const latency = performance.now() - started;
    return { latency, status, success: false, error };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runLoadTest(config) {
  const {
    target,
    totalRequests,
    concurrency,
    timeoutMs,
    ignoreFailures,
    verboseFailures,
  } = config;

  console.log(
    [
      `Starting load test`,
      `target=${target}`,
      `requests=${totalRequests}`,
      `concurrency=${concurrency}`,
      `timeout=${timeoutMs}ms`,
    ].join(' | ')
  );

  const latencies = [];
  const statusCounts = new Map();
  let successCount = 0;
  let failureCount = 0;

  let launched = 0;
  let inFlight = 0;

  const startedAt = performance.now();

  await new Promise((resolve) => {
    const pump = () => {
      while (inFlight < concurrency && launched < totalRequests) {
        launched += 1;
        inFlight += 1;

        makeRequest(target, timeoutMs)
          .then((result) => {
            latencies.push(result.latency);
            const key = String(result.status);
            statusCounts.set(key, (statusCounts.get(key) || 0) + 1);

            if (result.success) {
              successCount += 1;
            } else {
              failureCount += 1;
              if (verboseFailures) {
                console.warn(`Request #${launched} failed:`, result.error?.message || result.error);
              } else if (failureCount <= 5) {
                console.warn(`Request #${launched} failed:`, result.error?.message || result.error);
              }
            }
          })
          .catch((err) => {
            failureCount += 1;
            console.warn('Unexpected error:', err);
          })
          .finally(() => {
            inFlight -= 1;
            if (launched === totalRequests && inFlight === 0) {
              resolve();
            } else {
              pump();
            }
          });
      }
    };

    pump();
  });

  const totalDurationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);

  const avgLatency = latencies.reduce((sum, value) => sum + value, 0) / (latencies.length || 1);
  const throughput = totalDurationMs ? totalRequests / (totalDurationMs / 1000) : 0;

  console.log('--- Load Test Results ---');
  console.log(`Total duration: ${totalDurationMs.toFixed(2)} ms`);
  console.log(`Throughput: ${throughput.toFixed(2)} requests/sec`);
  console.log(`Success: ${successCount}, Failure: ${failureCount}`);
  console.log('Status counts:', Object.fromEntries(statusCounts));

  if (latencies.length) {
    console.log('Latency (ms):');
    console.log(`  min: ${latencies[0].toFixed(2)}`);
    console.log(`  p50: ${percentile(latencies, 50).toFixed(2)}`);
    console.log(`  p90: ${percentile(latencies, 90).toFixed(2)}`);
    console.log(`  p95: ${percentile(latencies, 95).toFixed(2)}`);
    console.log(`  max: ${latencies[latencies.length - 1].toFixed(2)}`);
    console.log(`  avg: ${avgLatency.toFixed(2)}`);
  }

  if (!ignoreFailures && failureCount > 0) {
    console.error(`Load test completed with ${failureCount} failure(s).`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs();

  const target = getStringOption(options, 'target', 'LOAD_TEST_TARGET', DEFAULT_TARGET);
  const totalRequests = getNumberOption(options, 'requests', 'LOAD_TEST_REQUESTS', DEFAULT_REQUESTS);
  const concurrency = getNumberOption(options, 'concurrency', 'LOAD_TEST_CONCURRENCY', DEFAULT_CONCURRENCY);
  const timeoutMs = getNumberOption(options, 'timeout', 'LOAD_TEST_TIMEOUT', DEFAULT_TIMEOUT_MS);
  const ignoreFailures = getBooleanOption(options, 'ignore-failures', 'LOAD_TEST_IGNORE_FAILURES', false);
  const verboseFailures = getBooleanOption(options, 'verbose-failures', 'LOAD_TEST_VERBOSE_FAILURES', false);

  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    console.error(`Invalid target URL: ${target}`);
    process.exit(1);
  }

  await runLoadTest({
    target,
    totalRequests,
    concurrency,
    timeoutMs,
    ignoreFailures,
    verboseFailures,
  });
}

main().catch((error) => {
  console.error('Load test failed:', error);
  process.exitCode = 1;
});
