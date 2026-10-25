// Сервер очереди на лабораторные. Без зависимостей, нужен только Node.js 18+.
// Запуск: BOT_TOKEN=... ADMIN_IDS=123,456 node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV = !BOT_TOKEN; // без токена проверка подписи Telegram отключена (только для проверки на своём компьютере)
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const DEFAULT_CAPACITY = Number(process.env.CAPACITY) || 30;
const DEFAULT_LABS = Number(process.env.LABS) || 4;

// ---------- хранилище ----------
let db;
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = { admins: [], labs: [] };
    for (let i = 1; i <= DEFAULT_LABS; i++) {
      db.labs.push({ id: 'l' + i, name: 'Лабораторная ' + i, capacity: DEFAULT_CAPACITY, slots: {} });
    }
    saveDb();
  }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
loadDb();

// ---------- авторизация через Telegram initData ----------
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const user = params.get('user');
  if (!user) return null;
  try {
    return { params, user: JSON.parse(user) };
  } catch {
    return null;
  }
}

function authUser(req) {
  const initData = String(req.headers['x-init-data'] || '');
  if (DEV) {
    const parsed = initData && parseInitData(initData);
    return parsed ? parsed.user : { id: 1, first_name: 'Тест' };
  }
  const parsed = parseInitData(initData);
  if (!parsed) return null;
  const hash = parsed.params.get('hash');
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of parsed.params.entries()) if (k !== 'hash') pairs.push(k + '=' + v);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(parsed.params.get('auth_date') || 0);
  if (!(age < 3 * 24 * 3600)) return null;
  return parsed.user;
}

// ---------- логика очереди ----------
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function displayName(u) {
  const f = clean(u.first_name, 24);
  const l = clean(u.last_name, 24);
  return (f + (l ? ' ' + l[0] + '.' : '')).trim() || clean(u.username, 24) || 'Студент';
}

const mySlot = (lab, uid) => {
  for (const [n, s] of Object.entries(lab.slots)) if (s.uid === uid) return Number(n);
  return 0;
};
const firstFree = (lab) => {
  for (let i = 1; i <= lab.capacity; i++) if (!lab.slots[i]) return i;
  return 0;
};

function isAdmin(uid) {
  return ADMIN_IDS.includes(uid) || db.admins.includes(uid);
}

function viewFor(user) {
  return {
    me: { id: user.id, name: displayName(user) },
    isAdmin: isAdmin(user.id),
    labs: db.labs.map((l) => ({
      id: l.id,
      name: l.name,
      capacity: l.capacity,
      slots: Array.from({ length: l.capacity }, (_, i) => {
        const s = l.slots[i + 1];
        return s ? { name: s.name, done: !!s.done, mine: s.uid === user.id } : null;
      }),
    })),
  };
}

class HttpError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

function needAdmin(user) {
  if (!isAdmin(user.id)) throw new HttpError(403, 'Только для админа');
}
function findLab(id) {
  const lab = db.labs.find((l) => l.id === id);
  if (!lab) throw new HttpError(404, 'Такой лабораторной нет');
  return lab;
}

const actions = {
  join(user, b) {
    const ids = Array.isArray(b.labIds) ? b.labIds.slice(0, 40) : [];
    const want = Number.isInteger(b.slot) ? b.slot : 0;
    const results = [];
    for (const id of ids) {
      const lab = findLab(id);
      const has = mySlot(lab, user.id);
      let n = want >= 1 && want <= lab.capacity && !lab.slots[want] ? want : 0;
      if (want && !n && !has) n = 0;
      if (has) {
        if (want && n) {
          const keep = lab.slots[has];
          delete lab.slots[has];
          lab.slots[n] = keep;
          results.push({ labId: id, status: 'moved', slot: n });
        } else {
          results.push({ labId: id, status: want ? 'taken' : 'already', slot: has });
        }
        continue;
      }
      if (!n) {
        if (want) {
          results.push({ labId: id, status: 'taken', slot: 0 });
          continue;
        }
        n = firstFree(lab);
      }
      if (!n) {
        results.push({ labId: id, status: 'full', slot: 0 });
        continue;
      }
      lab.slots[n] = { uid: user.id, name: displayName(user), done: false };
      results.push({ labId: id, status: 'joined', slot: n });
    }
    return { results };
  },
  leave(user, b) {
    const lab = findLab(b.labId);
    const n = mySlot(lab, user.id);
    if (n) delete lab.slots[n];
    return {};
  },
  done(user, b) {
    needAdmin(user);
    const lab = findLab(b.labId);
    const s = lab.slots[b.slot];
    if (s) s.done = !!b.done;
    return {};
  },
  remove(user, b) {
    needAdmin(user);
    const lab = findLab(b.labId);
    delete lab.slots[b.slot];
    return {};
  },
  lab(user, b) {
    needAdmin(user);
    const name = clean(b.name, 30);
    const capacity = Math.round(Number(b.capacity));
    if (!name) throw new HttpError(400, 'Введите название');
    if (!(capacity >= 1 && capacity <= 100)) throw new HttpError(400, 'Мест должно быть от 1 до 100');
    if (b.id) {
      const lab = findLab(b.id);
      const max = Math.max(0, ...Object.keys(lab.slots).map(Number));
      if (capacity < max) throw new HttpError(400, 'Занято место №' + max + ', меньше сделать нельзя');
      lab.name = name;
      lab.capacity = capacity;
    } else {
      if (db.labs.length >= 40) throw new HttpError(400, 'Слишком много лабораторных');
      db.labs.push({ id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, capacity, slots: {} });
    }
    return {};
  },
  labdelete(user, b) {
    needAdmin(user);
    findLab(b.id);
    db.labs = db.labs.filter((l) => l.id !== b.id);
    return {};
  },
};

// ---------- HTTP ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Некорректный запрос'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Не найдено' });

    const user = authUser(req);
    if (!user || !Number.isInteger(user.id)) return send(res, 401, { error: 'Откройте приложение через Telegram' });
    if (!ADMIN_IDS.length && !db.admins.length) {
      db.admins.push(user.id); // первый открывший становится админом, если ADMIN_IDS не задан
      saveDb();
    }

    const name = url.pathname.slice(5);
    if (req.method === 'GET' && name === 'state') return send(res, 200, { state: viewFor(user) });
    if (req.method === 'POST' && actions[name]) {
      const body = await readBody(req);
      const extra = actions[name](user, body) || {};
      saveDb();
      return send(res, 200, { ...extra, state: viewFor(user) });
    }
    return send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log('Очередь запущена: http://localhost:' + PORT + (DEV ? '  (режим проверки: BOT_TOKEN не задан)' : ''));
});
