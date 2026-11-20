// Storage layer. Everything that touches the database lives here, so swapping
// SQLite for Elasticsearch / ClickHouse later means rewriting only this file.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = process.env.DB_FILE || path.join(import.meta.dirname, 'data', 'network-calls.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS pageviews (
    page_id     TEXT PRIMARY KEY,
    session_id  TEXT,
    page_url    TEXT,
    referrer    TEXT,
    user_agent  TEXT,
    started_at  INTEGER              -- epoch ms
  );

  -- One row per network call. (page_id, seq) is assigned by the browser, so a
  -- call that is re-sent with more detail simply replaces its earlier row.
  CREATE TABLE IF NOT EXISTS network_calls (
    page_id      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    ts           INTEGER,            -- epoch ms the request started
    type         TEXT,               -- script, img, css, xhr, fetch, beacon, iframe, websocket, ...
    method       TEXT,
    url          TEXT,
    host         TEXT,
    third_party  INTEGER,            -- 1 when host differs from the page's host
    status       INTEGER,
    error        TEXT,
    duration_ms  REAL,
    size_bytes   INTEGER,            -- bytes over the wire (0 = cached or hidden by cross-origin rules)
    protocol     TEXT,
    initiator    TEXT,               -- script (url:line:col) that triggered the call, when known
    frame        TEXT,               -- iframe URL when the call was made inside a same-origin iframe
    detail       TEXT,               -- JSON: call stack, timing breakdown
    PRIMARY KEY (page_id, seq)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_calls_host ON network_calls (host);
`);

const insertPageview = db.prepare(`
  INSERT OR IGNORE INTO pageviews (page_id, session_id, page_url, referrer, user_agent, started_at)
  VALUES (?, ?, ?, ?, ?, ?)`);

const upsertCall = db.prepare(`
  INSERT OR REPLACE INTO network_calls
    (page_id, seq, ts, type, method, url, host, third_party, status, error,
     duration_ms, size_bytes, protocol, initiator, frame, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const str = (v, max = 4000) => (v == null ? null : String(v).slice(0, max));
const num = (v) => (Number.isFinite(v) ? v : null);
const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

/** Store one batch posted by the recorder script. Returns the number of calls saved. */
export function saveBatch(batch, userAgent) {
  const pageId = str(batch.page_id, 64);
  if (!pageId || !Array.isArray(batch.events)) throw new Error('page_id and events[] are required');
  const pageHost = hostOf(batch.page_url);

  db.exec('BEGIN');
  try {
    insertPageview.run(pageId, str(batch.session_id, 64), str(batch.page_url), str(batch.referrer),
      str(userAgent, 500), num(batch.started_at));
    for (const e of batch.events) {
      if (!Number.isInteger(e.seq)) continue;
      const host = hostOf(e.url);
      upsertCall.run(pageId, e.seq, num(e.ts), str(e.type, 32), str(e.method, 16), str(e.url), host,
        host && pageHost && host !== pageHost ? 1 : 0, num(e.status), str(e.error, 500),
        num(e.duration), num(e.size), str(e.protocol, 32), str(e.initiator), str(e.frame),
        JSON.stringify({ stack: e.stack, ttfb: e.ttfb, body_size: e.bodySize }));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return batch.events.length;
}

export function listPageviews(limit = 50) {
  return db.prepare(`
    SELECT p.*, COUNT(c.seq) AS calls, COALESCE(SUM(c.third_party), 0) AS third_party_calls,
           COUNT(DISTINCT c.host) AS hosts
    FROM pageviews p LEFT JOIN network_calls c USING (page_id)
    GROUP BY p.page_id ORDER BY p.started_at DESC LIMIT ?`).all(limit);
}

export function listCalls(pageId, limit = 5000) {
  return db.prepare('SELECT * FROM network_calls WHERE page_id = ? ORDER BY ts, seq LIMIT ?')
    .all(pageId, limit)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }));
}

export function clearAll() {
  db.exec('DELETE FROM network_calls; DELETE FROM pageviews;');
}
