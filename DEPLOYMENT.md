# Deployment

Readlater can run directly with Node.js or as a Docker container. Keep the `data` directory on persistent storage in either setup.

## Docker

Create `.env` from `.env.example`, then build and run:

```bash
docker build -t readlater .
docker run -d \
  --name readlater \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/data:/app/data" \
  readlater
```

Set `HOST=0.0.0.0` inside the container. The host binding above keeps port 3000 private to the machine so a reverse proxy can terminate HTTPS.

## Reverse proxy

Example Nginx configuration:

```nginx
server {
  listen 443 ssl http2;
  server_name readlater.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Use your normal certificate automation and set `PUBLIC_BASE_URL=https://readlater.example.com`.

## Direct Node.js process

```bash
corepack enable
pnpm install --prod --frozen-lockfile
pnpm start
```

For a long-running instance, supervise the process with systemd, PM2, or another process manager.

## Backups

The included script writes timestamped database, media, and transcript archives:

```bash
./scripts/backup-readlater-data.sh
```

Back up `data/readlater.json`, `data/media/`, and `data/transcripts/`. Test restoration before relying on an automated schedule.

## Security checklist

- Set a strong `READLATER_PASSWORD`.
- Set a long random `READLATER_SESSION_SECRET`.
- Serve remote installations over HTTPS only.
- Keep `.env`, `data/`, worker logs, and backups outside Git.
- Give Notion integrations access only to the pages they need.
- Rotate the browser extension bearer token if it is exposed.
