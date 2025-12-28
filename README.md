# TMDB API Server (converted from Cloudflare Worker)

This repository adapts the previous Cloudflare Worker code to run as a local Node/Express API and includes Docker configuration.

Quick start

1. Copy environment values:

```bash
cp .env.example .env
# edit .env and set TMDB_API_KEY and other values
```

2. Build and run with Docker Compose:

```bash
docker compose up --build
```

3. Or run locally:

```bash
npm install
node server.js
```

Notes

- The code implements a small DB shim using `better-sqlite3` under `./data/db.sqlite3`.
- Some Cloudflare-only features (edge `caches.default`) are shimmed as no-op.
- Environment variables are read from `.env`.
