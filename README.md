<img src="assets/icon.svg" alt="rediscover icon" width="96" align="right">

# rediscover

A StumbleUpon-style button for your [Karakeep](https://karakeep.app) bookmarks. Open `/random` and it redirects you to a random bookmark from anywhere in your collection. Before sending you there it checks that the page still exists. If it doesn't, it tags the bookmark `dead-link`, archives it, and rolls again.

Small Node service with no dependencies.

## Deploy

You need a running Karakeep instance and an API key. Create the key in Karakeep under **User Settings > API Keys**.

### Docker Compose

```yaml
services:
  rediscover:
    image: ttlequals0/rediscover:0.1.1
    container_name: rediscover
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      KARAKEEP_URL: http://karakeep:3000
      KARAKEEP_API_KEY: ${KARAKEEP_API_KEY}
      KARAKEEP_PUBLIC_URL: https://karakeep.example.com
```

Put `KARAKEEP_API_KEY=...` in a `.env` file next to the compose file, then:

```sh
docker compose up -d
curl http://localhost:8080/healthz   # prints "ok"
```

If Karakeep runs in the same compose project, `http://karakeep:3000` works for `KARAKEEP_URL`. Otherwise use any address the container can reach.

### Docker run

```sh
docker run -d --name rediscover --restart unless-stopped -p 8080:8080 \
  -e KARAKEEP_URL=http://karakeep.lan:3000 \
  -e KARAKEEP_API_KEY=your_api_key \
  -e KARAKEEP_PUBLIC_URL=https://karakeep.example.com \
  ttlequals0/rediscover:0.1.1
```

### Build from source

```sh
git clone https://github.com/ttlequals0/rediscover.git
cd rediscover
docker build -t rediscover .
```

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `KARAKEEP_URL` | (required) | How this container reaches Karakeep |
| `KARAKEEP_API_KEY` | (required) | Karakeep API key |
| `KARAKEEP_PUBLIC_URL` | `KARAKEEP_URL` | How *your browser* reaches Karakeep. Notes, files, and saved copies of dead links open here. |
| `ARCHIVE_DEAD_LINKS` | `true` | Archive bookmarks whose link is dead |
| `DEAD_LINK_TAG` | `dead-link` | Tag added to dead bookmarks before archiving (empty = no tag) |
| `CHECK_LINKS` | `true` | Set `false` to skip link checks entirely |
| `LINKS_ONLY` | `false` | Only pick link bookmarks, never notes or files |
| `MAX_ATTEMPTS` | `5` | Bookmarks to try per click before giving up |
| `CHECK_TIMEOUT_MS` | `8000` | How long to wait for a page, in milliseconds |
| `PORT` | `8080` | Listen port |

## Use

Open `http://<host>:8080/random` in a browser. Each visit picks a new random bookmark. Link bookmarks open the original page; notes and files open in Karakeep.

Bookmark that URL or put it on your toolbar.

### Homepage dashboard

No Homepage changes are needed. Add a service card in `services.yaml`:

```yaml
- Bookmarks:
    - Rediscover:
        icon: karakeep.png
        description: Open a random bookmark
        href: http://rediscover.lan:8080/random
        target: _blank
        # Optional: show your Karakeep stats on the same card
        widget:
          type: karakeep
          url: http://karakeep:3000
          key: your_karakeep_api_key
```

Or add a plain entry in `bookmarks.yaml`:

```yaml
- Rediscover:
    - Random bookmark:
        - abbr: RB
          href: http://rediscover.lan:8080/random
```

### Endpoints

| Endpoint | Returns |
|---|---|
| `GET /random` | 302 redirect to a random live bookmark, or a page listing what was skipped |
| `GET /random?format=json` | `{ bookmark, skipped }` as JSON instead of a redirect |
| `GET /healthz` | `ok`, used by the Docker healthcheck |

### Reviewing dead links

Search Karakeep for `#dead-link` to see what was archived. Unarchive a bookmark to put it back in rotation.

## How it decides

**Picking.** It jumps to a random moment between your oldest and newest bookmark and picks at random from the 100 bookmarks saved around it. That costs three API calls per pick no matter how big the collection is. Old bookmarks get a fair shot, a bulk import doesn't crowd out everything else, and collections under 100 bookmarks are sampled evenly. Archived bookmarks are never picked.

**Dead vs. down.** Only clear-cut failures get archived:

- **Dead (archived and tagged):** the page returns 404 or 410, or the domain no longer resolves, refuses connections, or has a broken certificate. Each one is checked twice before anything is touched.
- **Down (skipped, left alone):** timeouts and 5xx errors. Sites have bad days.
- **Alive:** everything else, including bot walls (401/403/429) and Cloudflare challenges.

**If every try is dead or down,** you get a small page listing what was skipped, with links to Karakeep's saved copies and a "Roll again" link. The page rolls again by itself after 3 seconds, up to 3 times in a row.

## Caveats

- Opening `/random` can change your data by archiving bookmarks. There is no built-in auth. Keep it on your LAN or behind your reverse proxy's auth, because anyone who can reach it can open your bookmarks.
- Some dead sites now show a parked-domain page that returns 200. Those look alive and won't be caught.
- Link checks run from the container, so bookmarks to LAN-only addresses are checked from the container's network.

## Development

Requires Node 20 or newer. No `npm install` needed.

```sh
npm test
KARAKEEP_URL=http://localhost:3000 KARAKEEP_API_KEY=... npm start
```

## License

MIT
