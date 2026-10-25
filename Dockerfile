# TelegramFileServer — container image for Heroku (container stack) and
# anywhere else a plain Docker runtime is available.
#
# Stage 1 builds the web UI (vite writes into crates/server/static/webui),
# stage 2 builds the release binary against that fresh UI, stage 3 ships
# just the binary and its static assets on a slim base.

# ---- Stage 1: web UI ----------------------------------------------------
FROM node:22-bookworm-slim AS webui
WORKDIR /build
COPY webui/package.json webui/package-lock.json ./webui/
RUN cd webui && npm ci
COPY webui ./webui
RUN cd webui && npm run build

# ---- Stage 2: release binary --------------------------------------------
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# Fresh UI build wins over the committed copy in the source tree.
COPY --from=webui /build/crates/server/static/webui ./crates/server/static/webui
RUN cargo build --release --locked -p tfs

# ---- Stage 3: runtime -----------------------------------------------------
# rustls (no OpenSSL) — the driver and grammers are pure Rust, so the
# runtime only needs CA roots for MongoDB Atlas and Telegram.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/tfs ./tfs
COPY --from=build /src/crates/server/static ./static

# Writable homes for config.tfs, session files, and the thumbnail cache.
# All regenerable: on an ephemeral dyno the connection comes from
# TFS_MONGO_URI/TFS_WIZARD_PASSWORD and the setup config from MongoDB.
ENV TFS_BIN_DIR=/app TFS_DATA_DIR=/app/data

# --showlogs = console mode: logs to stdout (logplex), no pid file, no
# log-file redirection. Heroku injects PORT; HOST must be set to 0.0.0.0
# (see HEROKU.md).
EXPOSE 8090
CMD ["/app/tfs", "--showlogs"]
