// Blood Reign Blood Gain: multiplayer server
// Shares: world clock, players seeing each other, names, scores, leaderboard, the Village vs Monsters war and player-vs-player hits, status effects and chat.
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
const players = new Map(), best = new Map(), sockets = new Map(), hitLog = new Map(), lastChat = new Map(), lastHit = new Map(), lastDead = new Map();
const team = c => (c === 'civ' || c === 'hunter') ? 'v' : 'm';
let nextId = 1;
const num = v => typeof v === 'number' && isFinite(v);

wss.on('connection', ws => {
  const id = nextId++;
  const me = { id, n: 'Player ' + id, x: 12, y: 0, z: 17, r: 0, c: 'civ', f: 'normal', s: 0, h: 100, mh: 100 };
  players.set(id, me);
  sockets.set(id, ws);
  ws.send(JSON.stringify({ t: 'hello', id, e: (Date.now() - START) / 1000 }));
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (d.t === 'dead') {
      const lh = lastHit.get(id), now = Date.now();
      if (!lh || lh.by !== d.by || now - lh.at > 15000 || now - (lastDead.get(id) || 0) < 5000) return;
      lastDead.set(id, now); lastHit.delete(id);
      const killer = players.get(d.by), ks = sockets.get(d.by);
      if (killer && ks && ks.readyState === 1) ks.send(JSON.stringify({ t: 'kill', victim: me.n }));
      if (killer) sendAll(JSON.stringify({ t: 'chat', n: 'Kill feed', m: killer.n + ' killed ' + me.n }));
      return;
    }
    if (d.t === 'chat') {
      if (typeof d.m !== 'string') return;
      const now = Date.now();
      if (now - (lastChat.get(id) || 0) < 800) return;
      lastChat.set(id, now);
      const m = d.m.replace(/[<>]/g, '').trim().slice(0, 120);
      if (m) sendAll(JSON.stringify({ t: 'chat', n: me.n, m }));
      return;
    }
    if (d.t === 'hit') {
      const t = players.get(d.to);
      if (!t || t === me || !num(d.d) || (team(t.c) === 'v' && team(me.c) === 'v')) return;
      if (Math.hypot(t.x - me.x, t.z - me.z) > 35) return;
      const now = Date.now(), log = (hitLog.get(id) || []).filter(x => now - x < 1000);
      if (log.length >= 8) return;
      log.push(now); hitLog.set(id, log); lastHit.set(t.id, { by: id, at: now });
      const s2 = sockets.get(t.id);
      if (s2 && s2.readyState === 1) s2.send(JSON.stringify({ t: 'dmg', d: Math.max(1, Math.min(Math.floor(d.d), 250)), from: me.n, fid: id, c: me.c, fx: ['stun', 'slow', 'blind'].includes(d.fx) ? d.fx : '', sec: num(d.sec) ? Math.max(0, Math.min(d.sec, 6)) : 0 }));
      return;
    }
    if (d.t !== 's') return;
    if (num(d.x) && num(d.y) && num(d.z) && num(d.r) && Math.abs(d.x) < 200 && Math.abs(d.z) < 200) {
      me.x = d.x; me.y = Math.max(0, Math.min(d.y, 10)); me.z = d.z; me.r = d.r;
    }
    if (['civ', 'hunter', 'vampire', 'wolf', 'witch'].includes(d.c)) me.c = d.c;
    if (['normal', 'bat', 'human', 'cat'].includes(d.f)) me.f = d.f;
    if (typeof d.n === 'string') { const n = d.n.replace(/[^\w \-]/g, '').trim().slice(0, 14); if (n) me.n = n; }
    if (num(d.h) && num(d.mh)) { me.h = Math.max(0, Math.min(d.h, 2e6)); me.mh = Math.max(1, Math.min(d.mh, 2e6)); }
    if (num(d.s)) {
      me.s = Math.max(0, Math.min(Math.floor(d.s), 1e6));
      if (me.s > (best.get(me.n) || 0)) {
        best.set(me.n, me.s);
        if (best.size > 500) best.delete(best.keys().next().value);
      }
    }
  });
  ws.on('close', () => { players.delete(id); sockets.delete(id); hitLog.delete(id); lastChat.delete(id); lastHit.delete(id); lastDead.delete(id); });
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
