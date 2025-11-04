# Load Testing

Use the bundled script to simulate concurrent check-ins against the deployed service.

## Quick start

```bash
npm run load:test
```

The command above targets the production Render deployment with 100 total requests and a concurrency of 10 to mirror anticipated peak traffic.

## Customising runs

Override behaviour with CLI flags or environment variables:

| Option | Description | Default | Environment |
| --- | --- | --- | --- |
| `--target` | URL to post check-ins to | Render production API | `LOAD_TEST_TARGET` |
| `--requests` | Total number of requests to issue | `100` | `LOAD_TEST_REQUESTS` |
| `--concurrency` | Maximum in-flight requests | `10` | `LOAD_TEST_CONCURRENCY` |
| `--timeout` | Abort individual requests after this many milliseconds | `10000` | `LOAD_TEST_TIMEOUT` |
| `--ignore-failures` | Do not exit with an error code when any requests fail | `false` | `LOAD_TEST_IGNORE_FAILURES` |
| `--verbose-failures` | Log every failed request instead of the first five | `false` | `LOAD_TEST_VERBOSE_FAILURES` |

Examples:

```bash
# Run 200 total requests with concurrency 20
npm run load:test -- --requests 200 --concurrency 20

# Hit a local server
LOAD_TEST_TARGET=http://localhost:3000/api/checkin npm run load:test
```
