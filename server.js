import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
};

const ROUTES = { '/': 'game.html', '/controller': 'controller.html' };

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ port: PORT, ips: lanAddresses() }));
  }
  const rel = ROUTES[url.pathname] ?? decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// Roles: "game" (the screen) and "controller" (a phone). Every phone is its own player.
// Controller input is relayed to every game tagged with the phone's id and slot (1, 2, 3, ...).
const wss = new WebSocketServer({ server, path: '/ws' });
const games = new Set();
const controllers = new Set();
let nextId = 1;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(set, msg) { for (const ws of set) send(ws, msg); }
function freeSlot() {
  const used = new Set([...controllers].map((c) => c.slot));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');
  if (role === 'game') {
    games.add(ws);
    for (const c of controllers) send(ws, { t: 'join', id: c.id, slot: c.slot });
    ws.on('close', () => { games.delete(ws); broadcast(controllers, { t: 'status', games: games.size }); });
    broadcast(controllers, { t: 'status', games: games.size });
    return;
  }

  ws.id = `p${nextId++}`;
  ws.slot = freeSlot();
  controllers.add(ws);
  send(ws, { t: 'hello', id: ws.id, slot: ws.slot, games: games.size });
  broadcast(games, { t: 'join', id: ws.id, slot: ws.slot });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'input') broadcast(games, { t: 'input', id: ws.id, slot: ws.slot, s: msg.s });
  });
  ws.on('close', () => {
    controllers.delete(ws);
    broadcast(games, { t: 'leave', id: ws.id });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Juego:     http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) console.log(`Control:   http://${ip}:${PORT}/controller   (abrir en el telefono)`);
});
