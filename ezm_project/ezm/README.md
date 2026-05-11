# EZM

EZM is a shift scheduling web app with a Python HTTP server, a vanilla HTML/CSS/JS frontend, and SQLite storage.

## Project Files

- `server.py` - HTTP server and REST API.
- `index.html`, `app.js`, `styles.css` - frontend.
- `manifest.json` and icon files - PWA/browser assets.
- `data/` - local SQLite runtime data. Do not commit this directory.
- `.env` - local secrets. Do not commit this file.

## Local Run

Requires Python 3.12 or newer.

```bash
cp .env.example .env
python server.py
```

Open:

```text
http://localhost:5050
```

## Docker Run

```bash
cp .env.example .env
docker compose up -d --build
```

Open:

```text
http://SERVER_IP:5050
```

## Production Checklist

Before pushing or deploying:

- Set a strong `EZM_TOKEN_SECRET`.
- Leave `EZM_DEV_PASSWORD` unset unless you intentionally want to enable the developer console.
- Configure SMTP settings, otherwise OTP login email will fail.
- Keep `.env` out of Git.
- Keep `data/` out of Git and back it up on the server.
- Put the app behind HTTPS with Nginx, Caddy, Cloudflare Tunnel, or another reverse proxy.

## Data

The Docker setup stores SQLite data in the named volume `ezm_data`.

To inspect volumes:

```bash
docker volume ls
```

## Backups

Create a consistent SQLite backup from the running Docker container:

```bash
./scripts/backup-ezm.sh
```

By default, backups are written to `~/ezm-backups` and only the newest 90 files are kept.
You can override defaults:

```bash
BACKUP_DIR=/path/to/backups KEEP_BACKUPS=120 ./scripts/backup-ezm.sh
```
