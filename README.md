# Network call recorder

Proof of concept: a script embedded in a page captures every network call the
browser makes from that page and stores them in a database.

## Run

Needs Node 22.13+ (uses the built-in `node:sqlite`, so there is nothing to install).

```sh
npm start
```

- Demo page: <http://localhost:3000/> — fires ~50 mixed network calls after loading
- Viewer: <http://localhost:3000/viewer.html> — what ended up in the database

`PORT` and `DB_FILE` environment variables override the defaults.

## Layout

| File | Purpose |
| --- | --- |
| `public/js/recorder.js` | The embedded script. Captures calls, uploads them in batches. |
| `public/index.html`, `public/js/demo.js` | Demo page that generates the calls (AJAX, fetch, images, CDN assets, beacons, iframes, WebSocket, SSE). |
| `public/js/third-party-tag.js` | Fake third-party tag that makes its own calls once injected. |
| `public/viewer.html`, `public/js/viewer.js` | Table view of the captured calls. |
| `server.js` | Static files, `POST /collect`, read API for the viewer, mock endpoints. |
| `db.js` | Storage (SQLite, `data/network-calls.db`). The only file that knows about the database. |

## Using the recorder on another page

Load it as the first script in `<head>`, pointing at the collector:

```html
<script src="http://localhost:3000/js/recorder.js" data-endpoint="http://localhost:3000/collect"></script>
```

## Data

Two tables: `pageviews` (one row per page load) and `network_calls` (one row per
call: type, method, URL, host, first/third party, status, error, duration, size,
protocol, initiating script, iframe, plus call stack and timing in a JSON column).

```sql
-- Third-party hosts contacted, and which script triggered the calls
SELECT host, initiator, COUNT(*) AS calls
FROM network_calls
WHERE third_party = 1
GROUP BY host, initiator
ORDER BY calls DESC;
```

## What the browser does not let a page see

- **Cross-origin iframes**: only the iframe document's own load is visible, not the
  calls made inside it. Same-origin iframes are fully recorded.
- **Cross-origin responses**: status and size are hidden unless the response is
  CORS-readable or sends `Timing-Allow-Origin`. The call, its URL and its duration
  are still recorded.
- **Request/response headers and bodies** are not captured.
