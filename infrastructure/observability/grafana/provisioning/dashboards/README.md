# Grafana Dashboards

This directory contains the Grafana dashboard definitions for the Payments
Platform observability stack. Each file is a standalone dashboard JSON export.

## Dashboards

| File                              | Title                          | Purpose                                                                 |
|------------------------------------|---------------------------------|--------------------------------------------------------------------------|
| `mpesa-payment-flow-health.json`   | M-Pesa payment flow health      | Confirmation/validation latency and throughput, event state counts, outbox health, state transition rates |
| `mpesa-queue-backlog-health.json`  | M-Pesa queue and backlog health | RabbitMQ connections and throughput, outbox backlog over time, publish/consume balance |
| `ua-service-health.json`           | Utility Account service health  | Payment/validation latency and throughput, DB connection pool health   |
| `log-explorer.json`                | Log explorer                    | Loki-based log search by correlation ID and transaction reference, cross-service trace view |
| `server-health.json`               | Server health                   | Host-level CPU, memory, disk, load average, and network (via node-exporter) |

All dashboards use the `${DS_PROMETHEUS}` template variable for their
datasource, except the log explorer which additionally uses Loki.

## Loading the dashboards

This stack uses Grafana's dashboard provisioning (see `dashboards.yml` in
this directory). Any dashboard JSON file placed in
`infrastructure/observability/grafana/provisioning/dashboards/` is
automatically loaded into Grafana on startup, and re-synced every
30 seconds if changed.

To load these dashboards:

1. Copy all `*.json` files from this directory into
   `infrastructure/observability/grafana/provisioning/dashboards/`
   (alongside `dashboards.yml`).

2. The existing volume mount in `docker-compose.observability.yml`
   (`./observability/grafana/provisioning:/etc/grafana/provisioning:ro`)
   already covers this path -- no compose changes needed.

3. Start or restart Grafana:

   ```bash
   docker compose -f docker-compose.observability.yml up -d grafana
   ```

4. The dashboards will appear in Grafana under the **General** folder
   (since `foldersFromFilesStructure: false`).

Because `disableDeletion: true` is set, removing a JSON file from this
directory will not delete the dashboard from Grafana -- remove it manually
via the UI if needed.

## Datasource resolution

The `${DS_PROMETHEUS}` variable resolves automatically if your Grafana
instance has exactly one Prometheus datasource configured (the default for
this stack). If provisioned dashboards show "No data" on first load, check
that the Prometheus datasource is provisioned and named/UID-matched
correctly under `observability/grafana/provisioning/datasources/`.

## Notes

- The "Server health" dashboard requires `node-exporter` to be running and
  scraped by Prometheus (see `prometheus.yml` job `node-exporter`).
  Per-container metrics via cAdvisor were evaluated but found incompatible
  with Docker 29's containerd-snapshotter storage layout as of this writing
  (cAdvisor v0.49.1 and v0.52.1 both fail with "failed to identify the
  read-write layer ID" against `/var/lib/docker/image/overlayfs/layerdb`,
  which no longer exists under Docker 29.5.3). Host-level metrics via
  node-exporter are sufficient for current needs; revisit if a
  cAdvisor release adds support for the new storage layout.
