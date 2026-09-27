# Limited public Beta deployment

This runbook assumes a dedicated Linux host, a MySQL 8 database, Redis, Nginx and a trusted HTTPS edge. OldBBS does not require Docker. Keep MySQL, Redis and the application origin off the public network.

## Before installing a release

1. Create a dedicated `oldbbs` system user and a MySQL database/user with access only to the OldBBS database.
2. Install Node.js 20+, pnpm 11, Redis 6+, MySQL 8+ and OpenSSH `ssh-keygen`. Install ClamAV if uploads will be enabled.
3. Set MySQL `ngram_token_size=2` in its server config before the first OldBBS migration. MySQL's ngram parser is built in and loaded at startup. The migration uses ngram indexes when it sees the parser active; otherwise it creates standard FULLTEXT indexes. If this setting changes after indexes exist, rebuild the affected indexes.
4. Build the release with `pnpm install --frozen-lockfile` and `pnpm build`, then install the release under `/opt/oldbbs/current`.

## Persistent state and secrets

Create `/etc/oldbbs/oldbbs.env`, owner `root:oldbbs`, mode `0640`. Set a unique `SESSION_SECRET` (at least 32 characters), MySQL credentials, Redis credentials as applicable, `APP_URL`, and:

```env
NODE_ENV=production
APP_HOST=127.0.0.1
APP_PORT=3000
COOKIE_SECURE=true
TRUST_PROXY=1
UPLOAD_DIR=/var/lib/oldbbs/uploads
SSH_HOST_KEY_PATH=/var/lib/oldbbs/ssh_host_ed25519
ATTACHMENT_SCANNER=clamav
CLAMAV_COMMAND=clamscan
```

Create the state directory owned by `oldbbs`. Uploads and the SSH host key must persist across release changes. The application generates an SSH ed25519 host key when absent, sets private key permissions to `0600`, and preserves an existing key. Never copy a development key from `data/` into production. Back up the host key with the database, uploads and environment file.

Use `deploy/systemd/oldbbs.service` as the service unit. Apply migrations as a separate release step with `pnpm db:migrate`; review migration output before changing public traffic. Keep TypeORM `synchronize` disabled.

## Web and terminal network

Bind the web process to loopback and proxy it through Nginx/HTTPS. Restrict the origin firewall to the trusted edge and Nginx path; do not let clients connect directly while `TRUST_PROXY=1` is set. Install `deploy/nginx/oldbbs.conf.example`, set only current trusted proxy CIDRs, and have the edge overwrite forwarded host/protocol headers.

SSH defaults to TCP 2322 and Telnet to TCP 2323. Publish SSH only if the terminal access model and network controls are ready. Telnet is unencrypted and should be disabled or restricted to a trusted network. The application rejects SSH exec, subsystem, forwarding, X11 and environment requests. Terminal limits and timeouts are configurable in `.env.example`; monitor connection rejections and authentication failures when setting values for a small Beta.

## Attachments

Uploads are disabled when `ATTACHMENT_SCANNER=disabled`. For production, install ClamAV and make `clamscan` available to the service account, then set `ATTACHMENT_SCANNER=clamav`. A missing scanner returns service unavailable; scanner failures are stored as `scan_failed`; infected files are rejected. Only clean files can be downloaded. Do not use `ATTACHMENT_SCANNER=development` in production.

Run `pnpm storage:reconcile` with the same environment file when investigating storage drift. It removes orphan files, removes database rows whose files are missing, and recalculates per-user quotas. It refuses to operate if the configured upload directory is missing, which helps prevent accidental metadata deletion after a storage mount disappears.

## Readiness, recovery and checks

Use `/healthz` for process liveness and `/readyz` for database/Redis readiness. Back up MySQL, `/var/lib/oldbbs/uploads`, `/var/lib/oldbbs/ssh_host_ed25519` and the protected environment file together. Redis holds expiring sessions and rate-limit counters, not the source of truth for posts or accounts.

Run `pnpm test`, `pnpm build`, `pnpm views:check` and `pnpm legacy:check` before publishing a release. The optional MySQL/Redis integration test runs only when `OLDBBS_INTEGRATION=1` and `DATABASE_NAME` ends in `_test`; use a disposable test database with the migrations applied. A local build does not replace checks from the public network or an Android 2.x browser/device.
