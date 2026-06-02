# RabbitMQ Local Dev Setup

## Overview

RabbitMQ is configured via two files:

- `definitions.json` — declares the full broker topology (users, vhosts, permissions, exchanges, queues, bindings)
- `rabbitmq.conf` — tells RabbitMQ to load the definitions file on startup

Together they reproduce the complete broker state automatically every time the container starts from scratch.

---

## Files

```
rabbitmq-dev/
  definitions.json   ← full broker topology
  rabbitmq.conf      ← points RabbitMQ at the definitions file
  README.md
```

---

## Prerequisites

- Docker Desktop running
- PowerShell

---

## First-Time Setup

### 1. Clone or copy these files to your local machine

Place both files in the same directory, e.g. `C:\Users\<you>\rabbitmq-dev\`.

### 2. Remove the BOM from definitions.json

Windows text editors (including Notepad) add an invisible BOM (`EF BB BF`) to
UTF-8 files. RabbitMQ cannot parse a file with a BOM and will crash on startup
with `exit:{error,not_json}`. After copying or editing `definitions.json`,
always run this command to strip the BOM:

```powershell
$content = [System.IO.File]::ReadAllText("$env:USERPROFILE\rabbitmq-dev\definitions.json")
[System.IO.File]::WriteAllText("$env:USERPROFILE\rabbitmq-dev\definitions.json", $content, [System.Text.UTF8Encoding]::new($false))
```

Verify the BOM is gone — first bytes must start with `7B` (`{`), not `EF BB BF`:

```powershell
Format-Hex "$env:USERPROFILE\rabbitmq-dev\definitions.json" | Select-Object -First 1
```

### 3. Start RabbitMQ

```powershell
docker run -d `
  --name rabbitmq-dev `
  --restart always `
  -p 5672:5672 `
  -p 15672:15672 `
  -v rabbitmq-dev-data:/var/lib/rabbitmq `
  -v "$env:USERPROFILE\rabbitmq-dev\definitions.json:/etc/rabbitmq/definitions.json" `
  -v "$env:USERPROFILE\rabbitmq-dev\rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf" `
  rabbitmq:3.13-management
```

### 4. Verify

Check the container is stable (not restarting):

```powershell
docker ps --filter name=rabbitmq-dev
```

Open the Management UI at http://localhost:15672 and log in with:

- **Username:** `mpesa-dev`
- **Password:** `mpesa-dev-pass`

Verify the following are present:

- **Virtual Hosts:** `/` and `/payments`
- **Exchanges** (switch vhost to `/payments`): `payments.exchange`, `payments.dlx`
- **Queues** (switch vhost to `/payments`): `provisioning.queue`, `mpesa.results.queue`, `provisioning.dlq`, `results.dlq`

---

## Recreating from Scratch

If you need to wipe and rebuild (e.g. after topology changes):

```powershell
docker stop rabbitmq-dev
docker rm rabbitmq-dev
docker volume rm rabbitmq-dev-data
```

Then strip the BOM from `definitions.json` (step 2 above) and run the start
command again (step 3).

> **Important:** Always wipe the volume when recreating. If the volume already
> contains RabbitMQ state, the definitions file is ignored on startup.

---

## Changing the Password

The password in `definitions.json` is stored as a SHA-256 hash, not plaintext.
To use a different password:

### 1. Start RabbitMQ with the default user temporarily

```powershell
docker run -d --name rabbitmq-temp -p 15672:15672 -e RABBITMQ_DEFAULT_USER=admin -e RABBITMQ_DEFAULT_PASS=admin rabbitmq:3.13-management
```

### 2. Generate the hash

```powershell
docker exec rabbitmq-temp rabbitmqctl hash_password <your-new-password>
```

### 3. Update definitions.json

Replace the `password_hash` value in the `users` section with the new hash.

### 4. Clean up the temp container

```powershell
docker stop rabbitmq-temp && docker rm rabbitmq-temp
```

### 5. Strip BOM and recreate

Follow the recreate steps above.

---

## Topology

| Resource | Type | Vhost | Purpose |
|---|---|---|---|
| `payments.exchange` | direct, durable | `/payments` | Routes provisioning and result messages |
| `payments.dlx` | direct, durable | `/payments` | Routes failed messages to dead-letter queues |
| `provisioning.queue` | durable, DLX | `/payments` | Receives provisioning requests |
| `mpesa.results.queue` | durable, DLX | `/payments` | Receives provisioning results for M-Pesa Gateway |
| `provisioning.dlq` | durable | `/payments` | Holds failed provisioning messages |
| `results.dlq` | durable | `/payments` | Holds failed result messages |

### Bindings

| Exchange | Routing Key | Queue |
|---|---|---|
| `payments.exchange` | `provisioning.request` | `provisioning.queue` |
| `payments.exchange` | `mpesa.result` | `mpesa.results.queue` |
| `payments.dlx` | `provisioning.request` | `provisioning.dlq` |
| `payments.dlx` | `mpesa.result` | `results.dlq` |

---

## Ownership

This setup file will be moved to the `provisioning-service` repository under
`rabbitmq/` once that service is scaffolded. The provisioning service owns the
shared broker infrastructure (exchanges, shared queues, DLQs). Gateway-specific
queues (`mpesa.results.queue`, `results.dlq`) are declared here for convenience
but are owned by the M-Pesa Gateway service.

---

## Production Strategy

Local dev and production use different approaches for credentials. The topology
(exchanges, queues, bindings) is identical across environments — only credential
handling differs.

### Local Dev (current)

The `definitions.json` file contains the full topology **including** the user
and hashed password. This is acceptable locally because the file is not
sensitive in a personal dev environment and simplifies setup to a single file.

### Production

In production, credentials are never stored in git. The split is:

| What | How | In git? |
|---|---|---|
| Topology (vhosts, exchanges, queues, bindings) | `definitions.json` | Yes |
| RabbitMQ username | `RABBITMQ_DEFAULT_USER` in `.env` | No |
| RabbitMQ password | `RABBITMQ_DEFAULT_PASS` in `.env` | No |
| `rabbitmq.conf` | mounted file | Yes |

**Production `definitions.json`** — remove the `users` block entirely. Only
keep vhosts, permissions, exchanges, queues, and bindings. The user is created
by Docker Compose via environment variables sourced from the `.env` file on the
server:

```json
{
  "vhosts": [
    { "name": "/" },
    { "name": "/payments" }
  ],
  "permissions": [
    {
      "user": "${RABBITMQ_DEFAULT_USER}",
      "vhost": "/payments",
      "configure": ".*",
      "write": ".*",
      "read": ".*"
    }
  ],
  "exchanges": [ ... ],
  "queues": [ ... ],
  "bindings": [ ... ]
}
```

**Production `.env`** (on the server, never committed to git):

```
RABBITMQ_DEFAULT_USER=mpesa-prod
RABBITMQ_DEFAULT_PASS=<strong-password-here>
```

**Production `docker-compose.yml`** (RabbitMQ service excerpt):

```yaml
rabbitmq:
  image: rabbitmq:3.13-management
  restart: always
  env_file:
    - .env
  volumes:
    - rabbitmq-data:/var/lib/rabbitmq
    - ./rabbitmq/definitions.json:/etc/rabbitmq/definitions.json
    - ./rabbitmq/rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf
  ports:
    - "5672:5672"
```

This matches the existing secrets pattern used by the UA Service — credentials
live in `.env` on the host, restricted to the deploy user, and are never
committed to source control.

> **Note:** The permission entry in `definitions.json` references the username.
> In production this must match `RABBITMQ_DEFAULT_USER` exactly. Keep them in
> sync when rotating credentials.

---

## Notes

- `--restart always` means RabbitMQ starts automatically when Docker Desktop starts
- The named volume `rabbitmq-dev-data` persists all broker state across container restarts
- The definitions file is the single source of truth for broker topology — never configure the broker manually via the UI for anything that needs to survive a recreate
- `rabbitmq.conf` contains a single line: `management.load_definitions = /etc/rabbitmq/definitions.json`
