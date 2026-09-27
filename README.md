# OldBBS

OldBBS is a Chinese community for older devices, operating systems, software and internet culture. The product principle is **Modern core. Old-school interfaces.** Its forum pages are server-rendered and work without JavaScript; the shared application services also power the SSH and Telnet terminal UI.

This is an independent project. It does not import or depend on MDTBBS/MindForum.

## Stack and requirements

- Node.js 20 or newer and pnpm
- MySQL 8.x
- Redis 6 or newer
- OpenSSH `ssh-keygen` to create the local SSH server host key

The web process uses NestJS, TypeORM migrations and Nunjucks SSR. TypeORM `synchronize` is disabled. `apps/` and `packages/` are kept as logical modules under `src/` while the first release remains a single deployable Nest application.

## Set up a local instance

Create an empty database and a least-privilege database user. For example, in a MySQL administrative session:

```sql
CREATE DATABASE oldbbs CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'oldbbs'@'127.0.0.1' IDENTIFIED BY 'use-a-unique-password-here';
GRANT ALL PRIVILEGES ON oldbbs.* TO 'oldbbs'@'127.0.0.1';
```

Start Redis, then configure the application:

```bash
cp .env.example .env
openssl rand -base64 48
```

Put the generated value in `SESSION_SECRET`, set the database password, and set `COOKIE_SECURE=true` when the public site uses HTTPS. Keep `.env` private and outside version control. In production, terminate HTTPS at the trusted reverse proxy and set `TRUST_PROXY=1` when the app is reached through exactly one trusted local proxy. The origin must not accept direct public traffic when proxy trust is enabled.

Install, migrate, seed, and start:

```bash
pnpm install
pnpm db:migrate
SEED_ADMIN_PASSWORD='a-unique-password-of-at-least-12-characters' pnpm db:seed
pnpm dev
```

The seed command creates the `admin` account and the initial board tree. `SEED_ADMIN_PASSWORD` is required and is never stored in the repository. Set `SEED_TEST_PASSWORD` as well if you want the optional `oldphone` test user, welcome thread, sample Xperia X10 record and QQ 2012 catalog entry. The integrity migration repairs nullable orphan references, then checks every required reference before adding foreign keys. If it finds required orphan rows, it stops with the table and column so the data can be reviewed explicitly.

For a compiled run:

```bash
pnpm build
pnpm start
```

## Initial boards

The seed adds 19 default boards with parent/child organization: 站务 (公告, 建议与反馈), Android (Android 综合, ROOT / Recovery, ROM / 固件, Android 软件), Windows Phone, Symbian / S60, Java / BREW, 老电脑 (Windows, Linux / Unix, Macintosh), 设备收藏, 软件与游戏, 维修与硬件 and 闲聊.

## Web features

- SSR home, boards, paginated threads, posts, profiles and search
- Registration, sign-in/out, Redis-backed sessions, scrypt password hashes, login throttling and CSRF protection
- Markdown rendering with HTML sanitization; posting forms do not require JavaScript
- Stable post floors, soft-deleted posts, replies, quoting, bookmarks, follows, notifications and private messages
- Device and software catalogs, compatibility reports and tags
- Moderation queue, board management, user bans, software review and audit log
- Private local attachment storage with content-type sniffing, size limits, random storage names, per-user quotas, SHA-256 metadata, malware scanning and forced downloads
- `Classic` and `Clean` themes, plus `?lite=1` and the low-bandwidth account preference
- Session-authenticated JSON routes under `/api/v1`

Core CSS uses normal flow, tables and floats instead of Grid or Flexbox. The pages do not need client-side hydration, fetch, WebSocket or a service worker. The terminal app is a line-oriented TUI with UTF-8, GBK/CP936 and ASCII display options, optional ANSI sequences and a default 80-column layout that adapts to SSH PTY resize.

## SSH and Telnet

Ports and bind addresses are configurable. Defaults are SSH `0.0.0.0:2322` and Telnet `0.0.0.0:2323`.

```bash
ssh -p 2322 admin@localhost
telnet localhost 2323
```

SSH accepts the OldBBS username and password, a Terminal Access Key, or a registered ed25519/RSA public key. It opens the OldBBS UI; `exec`, SFTP/SCP, TCP/UNIX forwarding, X11, and environment requests are rejected. SSH host keys are generated once at `SSH_HOST_KEY_PATH` and are never replaced when already present. Development defaults to `./data/ssh_host_ed25519`; production defaults to `/var/lib/oldbbs/ssh_host_ed25519`. The private key is mode `0600`, excluded with `data/`, and must persist across releases and backups.

Telnet allows anonymous browsing and Terminal Access Key authentication only. It rejects the main site password. Telnet is unencrypted: Access Keys are revocable, but they are still sent in clear text. Create one under **账号设置 → Terminal Access Keys**, save the one-time value, and revoke it if exposed. SSH public keys and Access Keys are managed from the same account settings page.

The SSH and Telnet listeners share the same TUI and application services. The terminal uses the same users, boards, threads, posts, permissions, notifications, messages, bookmarks and search as the web interface. A single board policy enforces read/write roles across those entry points. Sessions recheck account status, role and `sessionVersion` at login, before sensitive operations and at least every 45 seconds while active. Configurable limits cover global and per-IP connections, authentication time, session lifetime, idle time, SSH channels and shells, shell creation, input size and terminal commands; see `.env.example`.

Every state-changing Web request uses a session CSRF token sent in a hidden form field or `X-CSRF-Token` header. Multipart uploads validate the form token after Multer parses the body. The token is never accepted from a cookie. Anonymous public GET requests do not persist sessions; login and registration forms receive a session token. Same-origin `Origin`/`Referer` checks provide an additional guard.

## Legacy browsers and low bandwidth

The web UI uses semantic HTML, ordinary POST/redirect/GET forms and CSS2-era layout primitives. It does not depend on JavaScript. At narrow widths, forum tables become block rows and posts stack their author information above the content. Use `?lite=1` to remove backgrounds and nonessential images. No web font or frontend framework is required.

## ESA and deployment shape

- `oldbbs.cn` can point through the ESA HTTP/HTTPS proxy to the web origin (`APP_HOST` / `APP_PORT`).
- `bbs.oldbbs.cn` should use DNS-only records to a Terminal Edge host. SSH and Telnet are direct TCP connections; this project does not assume ESA Basic provides TCP proxying.
- Web, SSH and Telnet currently run in one process/host, but their transports call the shared application service. A future Terminal Edge can replace the in-process adapter with a private internal API without introducing a second set of forum tables.
- Never expose Redis or MySQL publicly. Restrict SSH/Telnet at the network edge and monitor failed authentication and connection counts.

### Production service and reverse proxy

Build the source package with the pinned pnpm version (`pnpm install --frozen-lockfile`, then `pnpm build`). Install the compiled release under `/opt/oldbbs/current`, create a dedicated `oldbbs` system account, and install `deploy/systemd/oldbbs.service` as `/etc/systemd/system/oldbbs.service`. Put secrets in `/etc/oldbbs/oldbbs.env` with owner `root:oldbbs` and mode `0640`; set at least `SESSION_SECRET`, database credentials, `COOKIE_SECURE=true`, and `TRUST_PROXY=1`. The unit runs as `oldbbs`, restarts on failure, and stores uploads and the SSH host key under `/var/lib/oldbbs`.

The first process start creates `SSH_HOST_KEY_PATH` if it is absent. The key is private server identity and should persist across releases; back it up and do not copy the development key from `data/`. Uploads are stored outside the code release. The included `deploy/nginx/oldbbs.conf.example` is a starting point: install its `limit_req_zone` in Nginx's `http` context, set the current official ESA edge CIDRs in `set_real_ip_from`, enable `real_ip_header`/`real_ip_recursive`, and restrict the origin firewall to ESA. The app then trusts only the local Nginx hop. If Nginx terminates TLS itself, set `X-Forwarded-Proto` from `$scheme`; if ESA terminates TLS, configure ESA to overwrite that header and forward it to Nginx. Do not trust arbitrary client-supplied forwarding headers.

`/healthz` is an HTTP liveness check. `/readyz` also checks database and Redis connectivity and returns only component status, not connection details. Point deployment readiness checks at `/readyz`.

Back up the MySQL database, `/var/lib/oldbbs/uploads`, `/var/lib/oldbbs/ssh_host_ed25519`, and `/etc/oldbbs/oldbbs.env` using your secret-management process. Redis contains expiring sessions and rate-limit counters; it is not the source of truth for community content. Test restoring the database and files together before relying on a backup. Attachment reconciliation refuses to run if the configured upload directory is missing, to avoid treating an unavailable mount as an empty store.

## Scripts

```text
pnpm dev             development server
pnpm build           TypeScript production build
pnpm start           run compiled server
pnpm db:migrate      apply TypeORM migrations
pnpm db:revert       revert the last migration
pnpm db:seed         create admin and initial board data
pnpm test            run unit tests
pnpm test:integration  build and run the optional MySQL/Redis integration test
pnpm views:check     check template structure and legacy form/table markup
pnpm legacy:check    check Legacy JS syntax and reject CSS Grid
pnpm storage:reconcile remove orphan files, stale attachment rows and rebuild quotas
```

The initial migration creates the account, forum, catalog, compatibility, notification, message, moderation, audit, terminal-key, SSH-key, tag, attachment, email-token and login-attempt tables. `1760000001000-AddIntegrityAndSecurity` adds foreign keys, session revocation versions, attachment quotas and scan state, and device soft deletion. `1760000002000-BetaHardening` adds review states, sanitized Markdown cache fields, scanner failure state, repaired counters and FULLTEXT indexes for threads, posts, users, devices and software. All data changes go through TypeORM migrations; production must keep `synchronize` disabled.

The migrations detect whether MySQL's built-in `ngram` full-text parser is active and use it for CJK indexes when available. MySQL loads this parser at startup; set `ngram_token_size=2` in the server configuration before initializing the instance for Chinese bigram search. Changing that setting later requires rebuilding affected FULLTEXT indexes. Without ngram, OldBBS keeps bounded Boolean FULLTEXT queries and Chinese search uses the whole query token; results can be less complete. Main search has a two-character minimum and paginates in SQL after board visibility conditions. See the [MySQL ngram parser reference](https://dev.mysql.com/doc/refman/8.0/en/fulltext-search-ngram.html).

New Markdown posts are rendered and sanitized before storage. The versioned cache is re-rendered lazily on read when old rows have no cache or when `MARKDOWN_RENDER_VERSION` changes; never store unsanitized HTML.

## Current implementation limits

- Email verification and password-recovery token storage is present, but outbound email delivery and the confirmation/reset web flows are not wired yet.
- The admin UI covers boards, users, reports, device and software catalog editing/deletion or review, compatibility reports, audit history and general site settings.
- Attachments have a no-JavaScript disk-backed multipart upload form and private storage. `ATTACHMENT_SCANNER=disabled` (the default) rejects uploads with a service-unavailable response. Production should use `ATTACHMENT_SCANNER=clamav` with `clamscan` installed and readable by the service account; scanner errors are recorded as `scan_failed`, infected files as `rejected`, and only clean files can be downloaded. `ATTACHMENT_SCANNER=development` explicitly marks files clean for local development and is refused under `NODE_ENV=production`. The upload directory must be persistent and writable only by the service. Users can delete their own files; `pnpm storage:reconcile` removes orphan files and rows whose files are missing, then rebuilds quotas. Same-content uploads receive separate random storage keys, so duplicate SHA-256 values do not disclose another account's uploads.
- The terminal supports browsing, search, posting, multi-line composition, replying, quoting, profiles, notifications, messages and bookmarks. It is intentionally line-oriented; rich editing, moderation controls and user-management settings remain Web tasks.
- Automated unit tests cover Markdown sanitization, slug generation, scrypt registration/login, login throttling, session revocation, role checks, hidden-content redaction, Telnet password rejection, migration DDL, private attachment access, latest-message selection, terminal limits and administrator catalog edits. To run the optional MySQL/Redis integration test against a disposable local database, use `OLDBBS_INTEGRATION=1 OLDBBS_INTEGRATION_ALLOW_UNSUFFIXED_DB=1 pnpm test:integration`; it refuses non-local MySQL or Redis hosts, assumes migrations are already applied, and cleans up its generated rows. Database-backed HTTP/SSH/Telnet integration tests and Android 2.3 device acceptance are separate runtime checks; a local unit/build pass does not prove those paths.
- Production deployment, ESA DNS/origin configuration and public-domain verification have not been performed.
