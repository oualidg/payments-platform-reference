# Server Configuration

Reference copies of all server-side configuration files for the Utility Account production stack.

## Contents

| File | Description |
|------|-------------|
| `nginx.conf` | Nginx API gateway — rate limiting, reverse proxy, security headers, caching |
| `docker-compose.yml` | Docker Compose stack — Spring Boot + Nginx services |
| `utility-account-manual.docx` | Full server installation and operations manual |
| `load-test.js` | k6 load test — onboards 10 customers, runs payment workload at 100 VUs |

## Important Notes

- These are **reference copies**. The live files on the server are the source of truth.
- `.env` is **never committed** — it contains secrets. See the manual for the required keys.
- After any change on the server, copy the updated file here and commit.

## Live File Locations

| File | Server Path |
|------|-------------|
| `nginx.conf` | `/opt/utility-account/nginx.conf` |
| `docker-compose.yml` | `/opt/utility-account/docker-compose.yml` |
|

## Load Testing

Requires k6 installed:
- Windows: `winget install k6 --source winget`
- Or download: https://dl.k6.io/msi/k6-latest-amd64.msi
```bash
k6 run server/load-test.js
```

Targets `http://192.168.1.168` by default. Update `BASE_URL` in the script if the server IP changes.
> **Note:** The load test will show ~95% failures by default. This is expected — Nginx rate limiting
> (10 req/s per IP) throttles the 100 concurrent virtual users. To test raw throughput, comment out
> the `limit_req` directives in `nginx.conf` and restart Nginx before running. Remember to re-enable
> them afterwards. With rate limiting disabled, expect ~196 payments/second with 0% errors.
```