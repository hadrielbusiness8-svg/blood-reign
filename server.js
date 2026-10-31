// Blood Reign Blood Gain: multiplayer server
// Shares: world clock, players seeing each other, names, scores, leaderboard and the Village vs Monsters war.
// Scores are reported by each player's browser (not verified) and the leaderboard is kept in memory only.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, START = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
const players = new Map(), best = new Map();
let nextId = 1;
const num = v => typeof v === 'number' && isFinite(v);

wss.on('connection', ws => {
  const id = nextId++;
  const me = { id, n: 'Player ' + id, x: 12, y: 0, z: 17, r: 0, c: 'civ', f: 'normal', s: 0 };
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
    if (typeof d.n === 'string') { const n = d.n.replace(/[^\w \-]/g, '').trim().slice(0, 14); if (n) me.n = n; }
    if (num(d.s)) {
      me.s = Math.max(0, Math.min(Math.floor(d.s), 1e6));
      if (me.s > (best.get(me.n) || 0)) {
        best.set(me.n, me.s);
        if (best.size > 500) best.delete(best.keys().next().value);
      }
    }
  });
  ws.on('close', () => players.delete(id));
  ws.on('error', () => {});
});

const sendAll = m => { for (const c of wss.clients) if (c.readyState === 1) c.send(m); };
setInterval(() => sendAll(JSON.stringify({ t: 'p', list: [...players.values()] })), 100);
setInterval(() => sendAll(JSON.stringify({ t: 'time', e: (Date.now() - START) / 1000 })), 5000);
setInterval(() => {
  let v = 0, m = 0;
  for (const p of players.values()) { if (p.c === 'civ' || p.c === 'hunter') v += p.s; else m += p.s; }
  const top = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  sendAll(JSON.stringify({ t: 't', top, v, m }));
}, 2000);
server.listen(PORT, () => console.log('Listening on ' + PORT));
