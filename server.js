// Blood Reign Blood Gain: multiplayer server
// Shares: world clock, players seeing each other, names, scores, leaderboard, the Village vs Monsters war and player-vs-player hits, status effects, chat and the world bosses.
// Scores are reported by each player's browser (not verified) and the leaderboard is kept in memory only.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, START = Date.now() - (Number(process.env.TIME_OFFSET) || 0) * 1000;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<!--BRBG_ONLINE-->', '<script>window.BRBG_ONLINE=true</script>'));
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
const players = new Map(), best = new Map(), sockets = new Map(), hitLog = new Map(), lastChat = new Map(), lastHit = new Map(), lastDead = new Map();
// World layout (must match the game): villages [x, z, radius] and the three lairs
const VIL = [[0, 0, 62], [-300, -220, 40], [300, -250, 40], [-280, 260, 40], [330, 280, 40]];
const LAIR = [[-90, -80], [95, -75], [85, 94]];
// Every player spawns in a village, next to its well, on their own home stone (villages are filled in turn)
let nextVillage = 0;
function pickRock() {
  const v = VIL[nextVillage++ % VIL.length], cx = v[0] + 12, cz = v[1] + 12;
  const taken = [...players.values()].filter(p => Math.hypot(p.rx - cx, p.rz - cz) < 12).map(p => [p.rx, p.rz]);
  for (let t = 0; t < 60; t++) {
    const a = Math.random() * 6.283, x = Math.round(cx + Math.cos(a) * 6.5), z = Math.round(cz + Math.sin(a) * 6.5);
    if (taken.every(o => Math.hypot(x - o[0], z - o[1]) >= 5)) return [x, z];
  }
  return [Math.round(cx + 6.5), Math.round(cz)];
}
// World bosses: a different boss rises each night (Bone Colossus, Fenrir, Morgana). Everyone fights them together.
const BOSSES = [
  { key: 'bone', n: 'Bone Colossus', base: 3000, per: 1500, speed: 5, keep: 7, trig: 11, r: 11, d: 70, cd: 3, fx: 'stun', sec: 1, howl: 0, msg: 'The BONE COLOSSUS rises in the Main Village! Everyone fight him together!' },
  { key: 'wolf', n: 'Fenrir the Alpha', base: 2500, per: 1200, speed: 9, keep: 4.5, trig: 8, r: 8, d: 90, cd: 1.2, fx: '', sec: 0, howl: 12, msg: 'FENRIR the Alpha Werewolf hunts through the night! Stop him together!' },
  { key: 'witch', n: 'Morgana the Witch Queen', base: 2200, per: 1000, speed: 3, keep: 20, trig: 35, r: 35, d: 45, cd: 4.5, fx: 'blind', sec: 1.5, howl: 0, msg: 'MORGANA the Witch Queen casts her hexes! Bring her down together!' }
];
const boss = { alive: false, x: 0, z: 40, r: 0, hp: 0, mh: 1, cd: 3, howl: 5, cfg: BOSSES[0], hits: new Map() };
let bossNight = -1;
const bossEntry = () => ({ id: 0, n: boss.cfg.n, x: boss.x, y: 0, z: boss.z, r: boss.r, c: 'boss', f: boss.cfg.key, s: 0, h: Math.max(0, Math.round(boss.hp)), mh: boss.mh });
const chatEvent = m => sendAll(JSON.stringify({ t: 'chat', n: 'Event', m }));
const hurtAll = (r, d, fx, sec) => {
  for (const p of players.values()) {
    if (Math.hypot(p.x - boss.x, p.z - boss.z) < r) {
      const s2 = sockets.get(p.id);
      if (s2 && s2.readyState === 1) s2.send(JSON.stringify({ t: 'dmg', d, from: boss.cfg.n, fid: 0, c: 'boss', fx, sec }));
    }
  }
};
function killBoss() {
  boss.alive = false;
  let top = null, topD = 0;
  for (const [pid, dmg] of boss.hits) {
    if (dmg > topD) { topD = dmg; top = pid; }
    if (dmg >= 200) { const s2 = sockets.get(pid); if (s2 && s2.readyState === 1) s2.send(JSON.stringify({ t: 'bonus', s: 500, m: boss.cfg.n + ' defeated! +500' })); }
  }
  const tp = players.get(top);
  chatEvent(boss.cfg.n + ' has been defeated!' + (tp ? ' Most damage: ' + tp.n : ''));
}
function bossTick(dt) {
  const c = 60 + (Date.now() - START) / 1000, night = Math.sin(((c % 120) / 120) * Math.PI * 2) <= 0, m = Math.floor(c / 120);
  if (night && m > 0 && !boss.alive && bossNight !== m && players.size > 0) {
    const cfg = BOSSES[m % 3 === 1 ? 1 : m % 3 === 2 ? 2 : 0];
    bossNight = m; boss.cfg = cfg; boss.alive = true; boss.x = 0; boss.z = 40; boss.cd = cfg.cd; boss.howl = cfg.howl || 0; boss.hits.clear();
    boss.mh = boss.hp = Number(process.env.BOSS_HP) || cfg.base + cfg.per * Math.max(1, players.size);
    chatEvent(cfg.msg);
  }
  if (!night && boss.alive) { boss.alive = false; chatEvent(boss.cfg.n + ' vanishes at dawn...'); }
  if (!boss.alive) return;
  const cfg = boss.cfg;
  let best = null, bd = 260;
  for (const p of players.values()) { const d = Math.hypot(p.x - boss.x, p.z - boss.z); if (d < bd) { bd = d; best = p; } }
  if (!best) return;
  const dx = best.x - boss.x, dz = best.z - boss.z;
  boss.r = Math.atan2(dx, dz);
  if (bd > cfg.keep) { boss.x += dx / bd * cfg.speed * dt; boss.z += dz / bd * cfg.speed * dt; }
  boss.cd -= dt;
  if (bd < cfg.trig && boss.cd <= 0) { boss.cd = cfg.cd; hurtAll(cfg.r, cfg.d, cfg.fx, cfg.sec); }
  if (cfg.howl) { boss.howl -= dt; if (boss.howl <= 0) { boss.howl = cfg.howl; hurtAll(40, 15, 'slow', 3); } }
}
const team = c => (c === 'civ' || c === 'hunter') ? 'v' : 'm';
let nextId = 1;
const num = v => typeof v === 'number' && isFinite(v);

wss.on('connection', ws => {
  const id = nextId++;
  const [rx, rz] = pickRock();
  const me = { id, n: 'Player ' + id, rx, rz, x: rx + 4, y: 0, z: rz + 4, r: 0, c: 'civ', f: 'normal', s: 0, h: 100, mh: 100, au: 0 };
  players.set(id, me);
  sockets.set(id, ws);
  ws.send(JSON.stringify({ t: 'hello', id, rx, rz, e: (Date.now() - START) / 1000 }));
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
      if (d.to === 0) {
        if (!boss.alive || !num(d.d)) return;
        if (Math.hypot(boss.x - me.x, boss.z - me.z) > 45) return;
        const nowB = Date.now(), logB = (hitLog.get(id) || []).filter(x => nowB - x < 1000);
        if (logB.length >= 8) return;
        logB.push(nowB); hitLog.set(id, logB);
        const dmg = Math.max(1, Math.min(Math.floor(d.d), 250));
        boss.hp -= dmg; boss.hits.set(id, (boss.hits.get(id) || 0) + dmg);
        if (boss.hp <= 0) killBoss();
        return;
      }
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
    if (num(d.x) && num(d.y) && num(d.z) && num(d.r) && Math.abs(d.x) < 1120 && Math.abs(d.z) < 1120) {
      me.x = d.x; me.y = Math.max(0, Math.min(d.y, 10)); me.z = d.z; me.r = d.r;
    }
    if (['civ', 'hunter', 'vampire', 'wolf', 'witch', 'shader', 'boogeyman', 'discoguy', 'hawkman', 'reaper', 'drumpler', 'ghost', 'mimicy', 'wizarde', 'techai', 'fwog'].includes(d.c)) me.c = d.c;
    if (['normal', 'bat', 'human', 'cat'].includes(d.f)) me.f = d.f;
    if (typeof d.n === 'string') { const n = d.n.replace(/[^\w \-]/g, '').trim().slice(0, 14); if (n) me.n = n; }
    if (Number.isInteger(d.au) && d.au >= 0 && d.au <= 5) me.au = d.au;
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
setInterval(() => { bossTick(0.1); sendAll(JSON.stringify({ t: 'p', list: [...players.values(), ...(boss.alive ? [bossEntry()] : [])] })); }, 100);
setInterval(() => sendAll(JSON.stringify({ t: 'time', e: (Date.now() - START) / 1000 })), 5000);
setInterval(() => {
  let v = 0, m = 0;
  for (const p of players.values()) { if (p.c === 'civ' || p.c === 'hunter') v += p.s; else m += p.s; }
  const top = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  sendAll(JSON.stringify({ t: 't', top, v, m }));
}, 2000);
server.listen(PORT, () => console.log('Listening on ' + PORT));
