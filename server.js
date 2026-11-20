// Zero-dependency dev server:
//   /            static files from ./public (demo page, recorder script, viewer)
//   POST /collect   the recorder script posts captured network calls here
//   /api/*       read API used by viewer.html
//   /mock/*      throwaway endpoints that give the demo page something to call
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { saveBatch, listPageviews, listCalls, clearAll } from './db.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon',
};
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// The recorder may be embedded on pages served from another origin.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...(isJson ? { 'Content-Type': 'application/json' } : {}),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function collect(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, undefined, CORS);
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, CORS);
  try {
    // Sent as text/plain (sendBeacon / no CORS preflight), so parse regardless of content type.
    const saved = saveBatch(JSON.parse(await readBody(req)), req.headers['user-agent']);
    console.log(`collect: ${saved} call(s)`);
    send(res, 204, undefined, CORS);
  } catch (err) {
    send(res, 400, { error: err.message }, CORS);
  }
}

function api(req, res, url) {
  if (url.pathname === '/api/pageviews' && req.method === 'GET') return send(res, 200, listPageviews());
  if (url.pathname === '/api/calls' && req.method === 'GET') {
    return send(res, 200, listCalls(url.searchParams.get('page_id') || ''));
  }
  if (url.pathname === '/api/calls' && req.method === 'DELETE') { clearAll(); return send(res, 204); }
  send(res, 404, { error: 'not found' });
}

async function mock(req, res, url) {
  const delay = Math.min(Number(url.searchParams.get('delay')) || 0, 10000);
  if (delay) await sleep(delay);
  const route = url.pathname.slice('/mock/'.length);

  if (route === 'json') return send(res, 200, { ok: true, id: url.searchParams.get('id'), time: Date.now() });
  if (route === 'echo') return send(res, 200, { method: req.method, body: await readBody(req) });
  if (route === 'pixel.gif') return send(res, 200, PIXEL, { 'Content-Type': 'image/gif' });
  if (route.startsWith('status/')) {
    const code = Number(route.slice('status/'.length));
    return send(res, code >= 200 && code <= 599 ? code : 400, { status: code });
  }
  if (route === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    for (let i = 1; i <= 3; i++) { res.write(`data: tick ${i}\n\n`); await sleep(300); }
    return res.end();
  }
  send(res, 404, { error: 'unknown mock route' });
}

function serveStatic(res, url) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  const file = path.join(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/collect') await collect(req, res);
    else if (url.pathname.startsWith('/api/')) api(req, res, url);
    else if (url.pathname.startsWith('/mock/')) await mock(req, res, url);
    else serveStatic(res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
});

// Bare-minimum WebSocket endpoint (/mock/ws) so the demo can open one without a
// dependency: complete the handshake, send one text frame, then a close frame.
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!req.url.startsWith('/mock/ws') || !key) return socket.destroy();
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const text = Buffer.from('hello from /mock/ws');
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  socket.on('error', () => {});
  setTimeout(() => socket.end(Buffer.from([0x88, 0x00])), 500);
});

server.listen(PORT, () => {
  console.log(`Demo page:  http://localhost:${PORT}/`);
  console.log(`Viewer:     http://localhost:${PORT}/viewer.html`);
});
