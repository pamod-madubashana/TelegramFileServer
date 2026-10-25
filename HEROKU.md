# Deploying TelegramFileServer to Heroku

This guide runs the `tfs` server on a Heroku web dyno using the repo's
`Dockerfile` (Heroku **container stack** — Heroku has no official Rust
buildpack, and the image also builds the web UI and bundles the static
assets).

Two Heroku constraints shaped the setup, and the server now handles both:

- **Ephemeral filesystem** — every dyno restart wipes local files
  (`config.tfs`, `data.tfs`, Telegram session files, thumbnail cache).
  The saved connection can instead come from the `TFS_MONGO_URI` /
  `TFS_WIZARD_PASSWORD` config vars, and when the local config mirror is
  missing it is rebuilt from the setup config in MongoDB. Nothing that
  survives a restart lives on the dyno.
- **Bind address** — Heroku routes traffic to your dyno only if the process
  listens on `0.0.0.0`. The server binds loopback by default and switches
  when `HOST=0.0.0.0` is set.

## Prerequisites

| Requirement | Notes |
|---|---|
| Heroku account + CLI | Eco dynos are ~$5/month (no free tier). Install the CLI and `heroku login`. |
| MongoDB Atlas cluster | Heroku has no managed MongoDB. A free Atlas M0 works for a start; whitelist `0.0.0.0/0` (Heroku egress IPs are not static). |
| Wizard password | Choose it now — it encrypts the setup config in MongoDB and must match `TFS_WIZARD_PASSWORD` below. |

## One-time setup

```bash
heroku create <your-app-name>
heroku stack:set container          # required for heroku.yml + Dockerfile
heroku config:set \
  HOST=0.0.0.0 \
  TFS_MONGO_URI="mongodb+srv://..." \
  TFS_WIZARD_PASSWORD="<the wizard password you chose>"
git add Dockerfile heroku.yml .dockerignore
git commit -m "deploy: heroku container setup"
git push heroku v2:main             # builds the image on Heroku
```

`TFS_MONGO_URI` and `TFS_WIZARD_PASSWORD` are exactly what the setup
wizard's step 1 would persist to disk; on Heroku they take its place.

## First run

Open `https://<your-app-name>.herokuapp.com/` — the setup wizard appears
because MongoDB has no setup config yet. Complete it in the browser:

1. **Step 1** must use the **same MongoDB URI and password** as the config
   vars (the password decrypts the setup config that step 2 writes).
2. Step 2 collects the Telegram API ID/hash, bot tokens, owner and default
   chat as usual. All of it is stored encrypted in MongoDB — it survives
   restarts; the dyno's local files do not, and don't need to.

After that, `heroku logs --tail` should show the server listening on the
Heroku-provided port, and restarts/deploys come back up fully configured.

## Day-2 operations

| Task | Command |
|---|---|
| Deploy an update | `git push heroku v2:main` |
| Logs | `heroku logs --tail` |
| Restart dyno | `heroku restart` |
| Shell into the dyno | `heroku run bash` (files there are ephemeral) |
| Rotate the wizard password | Re-run the wizard's reset flow and update `TFS_WIZARD_PASSWORD` to match |

## Heroku-specific behavior to expect

- **Dynos restart at least daily** (and Eco dynos sleep after 30 min idle).
  Bots re-authenticate from their tokens in seconds; user login sessions
  are in-memory, so signed-in users log in again after a restart.
- **Router timeout**: a response must start within ~30 s (error `H12`).
  Streaming downloads are fine once bytes flow, but very large *uploads*
  that hold the response open may hit it.
- **Idle connections** (SSE progress events) are cut after ~55 s of
  silence — progress streams that pause between events can drop.
- **Thumbnails** re-fetch from Telegram once per dyno lifetime (the disk
  cache is ephemeral).

## Local image build (optional)

The same image runs anywhere Docker does:

```bash
docker build -t tfs .
docker run -e HOST=0.0.0.0 -e PORT=8090 \
  -e TFS_MONGO_URI=... -e TFS_WIZARD_PASSWORD=... \
  -p 8090:8090 tfs
```

To push a locally built image instead of letting Heroku build it:

```bash
heroku container:push web
heroku container:release web
```
