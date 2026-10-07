<p align="center">
  <img src="assets/social-card.png" width="820" alt="TelegramFileServer — Your files, in Telegram. Served as your own cloud drive.">
</p>

<p align="center">
  <strong>Your files, in Telegram. Served as your own cloud drive.</strong><br>
  A self-hosted file server that keeps your data in Telegram and streams it back to you
  through a browser UI — free-ish storage, no third-party cloud account, multi-user.
</p>

<p align="center">
  <a href="https://github.com/pamod-madubashana/TelegramFileServer"><img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version"></a>
  <a href="https://github.com/pamod-madubashana/TelegramFileServer"><img src="https://img.shields.io/badge/v1-stable-46A75A?logo=python&logoColor=white" alt="v1 stable"></a>
  <a href="https://github.com/pamod-madubashana/TelegramFileServer"><img src="https://img.shields.io/badge/v2-in%20progress-orange?logo=rust&logoColor=white" alt="v2 in progress"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Built%20with-Python-3776AB?logo=python&logoColor=white" alt="Built with Python"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Built%20with-Rust-DEA584?logo=rust&logoColor=white" alt="Built with Rust"></a>
  <a href="https://telegram.org"><img src="https://img.shields.io/badge/Storage-Telegram-269D8F?logo=telegram&logoColor=white" alt="Storage via Telegram"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-46A75A" alt="MIT License"></a>
</p>

> **Branch note.** `v1` is the stable Python release (formerly the default branch).
> **`v2` is the new default** and is a Rust rewrite, in progress. Everything
> under [Using v1 today](#quickstart) works right now; everything under
> [v2 in progress](#v2-in-progress) is honest status, not a promise.

---

## Purpose

TelegramFileServer stores your files in Telegram chats via bots and serves them back to
you as if they were your own cloud drive — because Telegram's per-chat storage is far
larger and cheaper than any mainstream cloud provider, and most people already have
that storage sitting there unused.

It exists to give that storage a real file-server interface: a browser UI, per-user
ownership, folders, search, resumable downloads, and direct links — instead of digging
through bot chat history by hand.

## Structure

```
TelegramFileServer/
├── apps/                      # Application shells (v2)
│   └── fileServerApp/         # Cross-platform app — placeholder (win/linux/mac/android)
├── crates/                    # Rust workspace members (v2)
│   ├── telegram/              # ★ Working PoC — Telegram transfer engine (Grammers)
│   ├── api/                   # ★ Axum setup endpoints
│   ├── config/                # ★ Setup config + Argon2/XChaCha encryption
│   ├── db/                    # ★ MongoDB layer — `tfs_v2` database
│   ├── server/                # 🔨 Setup-wizard HTTP server — in progress
│   ├── app-core/              # Planned shared domain logic (placeholder)
│   ├── auth/                  # Planned authn/authz (placeholder)
│   └── jobs/                  # Planned background job runner (placeholder)
├── legacy/                    # ★ v1 — the stable Python/FastAPI release
│   ├── Dockerfile             # Container image for v1
│   ├── install.sh             # Linux service installer (tgserver ...)
│   ├── requirements.txt       # Python dependencies
│   └── .env.example           # Configuration template
├── tests/                     # Cross-crate integration tests (v2) — placeholder
├── assets/
│   └── social-card.png        # Social preview card (README hero)
├── ROADMAP.md                 # v2 plan
└── LICENSE                    # MIT
```

`crates/telegram`, `crates/config`, `crates/db`, and `crates/api` have real code today;
`crates/server` is under construction. `crates/auth`, `crates/app-core`, `crates/jobs`,
`apps/fileServerApp`, and `tests/` are deliberately kept as empty placeholders (`.gitkeep`
only) — they are roadmap, not stubs.

## Features

### v1 — working today (`legacy/`)

- **Telegram as the storage backend** — uploads and downloads run through bot chats, so your
  data lives in Telegram's storage.
- **Resumable range streaming** — HTTP `206` with `Range` support, so large downloads resume
  instead of restarting.
- **Direct links** — `/dl/{file_name}` to download, `/watch/{file_name}` to play inline.
- **Multi-user with roles** — per-file ownership, admin guards, users see only their own files.
- **Telegram-verified login**, plus optional **Google OAuth** for allowed admin emails.
- **Folders, search, and thumbnails**, with work spread across several bot tokens.
- **Auto-update webhook** — `POST /system/github` triggers a deployment update.
- **Interactive API docs** — FastAPI's Swagger UI at `/docs`.

### v2 — in progress

See [v2 in progress](#v2-in-progress).

## Quickstart

```bash
git clone https://github.com/pamod-madubashana/TelegramFileServer.git
cd TelegramFileServer
git checkout v1        # stable Python release — the only branch that serves files today
```

**Prerequisites:** Python and MongoDB, Telegram `API_ID`/`API_HASH` from
[my.telegram.org](https://my.telegram.org), and one or more bot tokens from
[@BotFather](https://t.me/BotFather). Docker is optional. A browser for the UI.

```bash
cd legacy
python -m venv .venv
source .venv/bin/activate            # Windows PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                # Windows PowerShell: Copy-Item .env.example .env
python __main__.py                   # serves on http://localhost:8000
```

Alternative installs:

```bash
docker build -t telegram-file-server legacy && docker run -p 8000:8000 telegram-file-server
cd legacy && chmod +x install.sh && ./install.sh   # systemd service, driven by `tgserver`
```

> ⚠️ **Before you expose this to anyone:** `legacy/_data.py` ships hardcoded fallback Google
> OAuth credentials. They are committed, therefore public — replace them in `.env` and never
> treat them as a secret.

**v2 (Rust, still a proof of concept):**

```bash
git checkout v2
cargo build --workspace
cargo run -p tfs                   # setup wizard on http://127.0.0.1:8090
```

`crates/server` reads `PORT` (default `8090`) and `MONGO_URI` (default
`mongodb://localhost:27017`), serves a `/healthz` probe, and hosts the setup page. It is a
setup wizard, not a file server yet — see [v2 in progress](#v2-in-progress).

## Configuration

All v1 configuration is environment-driven, starting from `legacy/.env`:

| Variable | Description | Required |
|---|---|---|
| `API_ID` / `API_HASH` | Telegram credentials from my.telegram.org | Yes |
| `TOKEN0` | Primary bot token | Yes |
| `TOKEN1` … `TOKEN5` | Additional bot tokens | No |
| `DATABASE_URL` | MongoDB connection string | Yes |
| `PORT` | v1 web port (default `8000`); the v2 wizard honours it too (default `8090`) | No |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth | No |
| `AUTHORIZED_ADMIN_EMAILS` | Emails allowed to sign in as admins | No |
| `OWNER` | Owner user ID | No |

**Multiple bots.** The code scans exactly six slots, `TOKEN0`–`TOKEN5`; tokens outside that
range are ignored.

## Usage

Start the server, open `http://localhost:8000`, sign in with Telegram or Google, then browse
folders, search, upload, preview, and share direct links.

| Route | Purpose |
|---|---|
| `/dl/{file_name}` | Force download |
| `/watch/{file_name}` | Inline playback |
| `/files/thumbnail/{file_id}` | Thumbnail image |
| `/system/bots/info`, `/system/bots/workloads` | Which bots are loaded, and their work split |
| `/docs` | Interactive Swagger UI |

Resume works out of the box through `Range` support:

```bash
curl -C - -o video.mp4 http://localhost:8000/dl/video.mp4   # interrupt and re-run to continue
```

### If something goes wrong

| Symptom | Likely cause and fix |
|---|---|
| UI empty | `DATABASE_URL` is wrong or MongoDB is unreachable |
| Bot silent | Re-check `API_ID`/`API_HASH`/token against my.telegram.org and @BotFather |
| Only some uploads land on one bot | Expected — work is spread across loaded tokens; see `/system/bots/workloads` |
| Port already in use | Set a different `PORT` in `.env` |
| v2 builds but nothing transfers | Expected — live Telegram scenarios are `NOT RUN`, see [POC results](crates/telegram/POC_RESULTS.md) |

## Shortcuts

| Command | Does |
|---|---|
| `tgserver start` / `stop` / `restart` / `status` / `logs` / `help` | Drive the v1 systemd service installed by `legacy/install.sh` |
| `cargo build --workspace` | Build every workspace member |
| `cargo test --workspace` | Run all tests |
| `cargo clippy --workspace` · `cargo fmt --all` | Lint · format |

## v2 in progress

The rewrite lives on `v2`, which is becoming the default branch as `v1` retires.

| Piece | State |
|---|---|
| `crates/telegram` transfer engine (Grammers behind a `TelegramClient` trait) | ✅ Written |
| Upload / download / ranged streaming / cancellation / FloodWait retry | ✅ Implemented |
| Offline unit tests · clippy · fmt · release build | ✅ 7 passing, all clean |
| Live Telegram scenarios | ⏳ **Not yet run — all `NOT RUN`** |
| Setup wizard (`crates/config` + `crates/db` + `crates/api` + `crates/server`) | 🔨 In progress |
| `crates/auth`, `crates/app-core`, `crates/jobs`, `apps/fileServerApp`, `tests/` | ⏳ Placeholders |

Read it as: **the engine and its test harness are ready and the setup wizard is being
built; the live Telegram run is still pending.** Do not expect v2 to move real files yet.

- [`crates/telegram/README.md`](crates/telegram/README.md) — the engine's own docs
- [`crates/telegram/POC_RESULTS.md`](crates/telegram/POC_RESULTS.md) — live-scenario checklist, currently `NOT RUN`
- [`ROADMAP.md`](ROADMAP.md) — what v2 plans to become

## Architecture

**v1 (Python, running).** The FastAPI app owns the routes: `stream_routes.py` does `206` range
streaming and thumbnails, `auth` handles Telegram login / Google OAuth / roles, and `/system`
exposes bot info, workloads, and the update webhook. Metadata (name, size, owner, folder)
lives in MongoDB; **bytes live in Telegram**, streamed through the bot layer in both
directions — uploads Telegram → bot → MongoDB → storage, downloads replayed back out.

**v2 (Rust, in progress).**

```
  apps/fileServerApp (planned) ─┐
  crates/server ────────────────┼──► crates/api ──► crates/{db,config}
                                │
                                └──► crates/telegram   ← implemented today
```

`crates/telegram` is the foundation: a `TelegramClient` trait hiding a Grammers-based engine
for upload, download, ranged streaming, cancellation, and FloodWait retry. Everything above
it is written against that trait, so swapping the transport or the app shell does not ripple
upward. The point of the rewrite is fewer copies of every file, bounded concurrency, and
better retries than the Python bot path — plus one cross-platform app shell alongside the
server.

## Tech Stack

- **v2 (Rust)** — Grammers 0.10 (Telegram MTProto), Axum + tower-http (HTTP), MongoDB driver
  3.0, Argon2 + XChaCha20-Poly1305 (credential encryption), Tokio
- **v1 (Python)** — FastAPI, Pyrogram / PyroFork, MongoDB, Docker
- **App UI (separate repo)** — React, TypeScript, TailwindCSS, Vite, Tauri

Exact versions are not pinned per-component in the README; check `legacy/requirements.txt`
and the workspace `Cargo.toml`.

## Downloads

Nothing is published to a package registry — install from a clone.

- **v1** — `pip install -r requirements.txt` inside `legacy/`, or `docker build -t telegram-file-server legacy`
- **v2** — `cargo build --workspace --release`; no releases published yet
- **Desktop builds (Windows/Linux/macOS)** — [FileServerApp releases](https://github.com/pamod-madubashana/FileServerApp/releases) (`UNVERIFIED`: asset filenames were not re-confirmed — use the releases page)

The web UI and desktop app are maintained separately in
[FileServerApp](https://github.com/pamod-madubashana/FileServerApp); it was once wired in as a
submodule, but that reference has been removed.

## Links

| Resource | Link |
|---|---|
| Repository | [github.com/pamod-madubashana/TelegramFileServer](https://github.com/pamod-madubashana/TelegramFileServer) |
| v1 (stable) branch | [branch/v1](https://github.com/pamod-madubashana/TelegramFileServer/tree/v1) |
| v2 (rewrite) branch | [branch/v2](https://github.com/pamod-madubashana/TelegramFileServer/tree/v2) |
| Web UI & desktop app | [FileServerApp](https://github.com/pamod-madubashana/FileServerApp) |
| Issues | [Issues](https://github.com/pamod-madubashana/TelegramFileServer/issues) |
| Pull requests | [Pull requests](https://github.com/pamod-madubashana/TelegramFileServer/pulls) |
| License | [LICENSE](LICENSE) |
| Roadmap | [ROADMAP.md](ROADMAP.md) |
| Telegram credentials | [my.telegram.org](https://my.telegram.org) · [@BotFather](https://t.me/BotFather) |

There is no `CONTRIBUTING.md`, no `CODE_OF_CONDUCT.md`, and no Discussions board — the issue
tracker and pull requests are the channels.

## Credits

**Pamod Madubashana** — sole author and maintainer of TelegramFileServer and FileServerApp ·
[Grammers](https://github.com/puregrammers/grammers) (v2 MTProto) · [Pyrogram](https://github.com/pyrogram/pyrogram) + [PyroFork](https://github.com/pyrofork/pyrogram) (v1 clients) · [FastAPI](https://fastapi.tiangolo.com/) and [MongoDB](https://www.mongodb.com/) · everyone who filed an issue or sent a PR.

## Contributing

Fork, branch off `v2` for Rust work or `v1` for Python fixes, keep one concern per commit with
an imperative message, verify with `cargo test --workspace && cargo clippy --workspace && cargo
fmt --all` (or by clicking through the affected v1 flow), then open a pull request describing
what changed and how you tested it. Please never commit `.env`, bot tokens, API hashes, or
database URIs.

## License

**MIT** — Copyright (c) 2025 P A M O D.

Full text: [LICENSE](LICENSE).