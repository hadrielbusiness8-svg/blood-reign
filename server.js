// Blood Reign Blood Gain: tiny multiplayer server (phase 1: shared world clock + players see each other)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, START = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
const players = new Map();
let nextId = 1;
const num = v => typeof v === 'number' && isFinite(v);

wss.on('connection', ws => {
  const id = nextId++;
  const me = { id, n: 'Player ' + id, x: 12, y: 0, z: 17, r: 0, c: 'civ', f: 'normal' };
  players.set(id, me);
  ws.send(JSON.stringify({ t: 'hello', id, e: (Date.now() - START) / 1000 }));
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (d.t !== 's') return;
    if (num(d.x) && num(d.y) && num(d.z) && num(d.r) && Math.abs(d.x) < 200 && Math.abs(d.z) < 200) {
      me.x = d.x; me.y = Math.max(0, Math.min(d.y, 10)); me.z = d.z; me.r = d.r;
    }
    if (['civ', 'hunter', 'vampire', 'wolf', 'witch'].includes(d.c)) me.c = d.c;
    if (['normal', 'bat', 'human', 'cat'].includes(d.f)) me.f = d.f;
  });
  ws.on('close', () => players.delete(id));
  ws.on('error', () => {});
});

const sendAll = m => { for (const c of wss.clients) if (c.readyState === 1) c.send(m); };
setInterval(() => sendAll(JSON.stringify({ t: 'p', list: [...players.values()] })), 100);
setInterval(() => sendAll(JSON.stringify({ t: 'time', e: (Date.now() - START) / 1000 })), 5000);
server.listen(PORT, () => console.log('Listening on ' + PORT));
