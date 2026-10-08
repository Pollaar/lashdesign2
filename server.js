require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const push = require('./push');
// api.whatsapp.com direto: o redirecionamento do wa.me estraga emojis (vira "�") no WhatsApp Web
const buildWaLink = (phone, text) => `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text)}`;

// ---------- Configuração ----------
const TZ = 'America/Sao_Paulo';
const PORT = Number(process.env.PORT || 3000);
const MAX_WEEKS_AHEAD = Number(process.env.MAX_WEEKS_AHEAD || 26); // até onde a dona pode liberar semanas
const ADMIN_KEY = process.env.ADMIN_KEY || '123';
const MAX_SLOTS_PER_DAY = 20;
const MAX_CAPACITY = 20;
const MAX_PENDING_PER_SLOT = 5; // pedidos aguardando confirmação no mesmo horário
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'bookings.json');
const REMOVED_FILE = path.join(DB_DIR, 'removed-bookings.json'); // backup do que for apagado em "Limpar todos"
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}
const OWNER_PHONE = normalizePhone(process.env.OWNER_PHONE || '21972090405');

// Catálogo (serviços, valores, fotos e textos do site): a dona edita catalog.json
// (relido quando o arquivo muda, sem precisar reiniciar o servidor)
const CATALOG_FILE = path.join(__dirname, 'catalog.json');
let catalogCache = { mtime: 0, data: null };
function catalog() {
  const fsSync = require('fs');
  const mtime = fsSync.statSync(CATALOG_FILE).mtimeMs;
  if (mtime !== catalogCache.mtime) {
    try {
      catalogCache = { mtime, data: JSON.parse(fsSync.readFileSync(CATALOG_FILE, 'utf8')) };
    } catch (e) {
      if (!catalogCache.data) throw e;
      console.error('catalog.json inválido, mantendo a versão anterior:', e.message);
    }
  }
  return catalogCache.data;
}
catalog();
const OPTION_LABEL = { aplicacao: 'Aplicação', manutencao: 'Manutenção' };
const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Monta a descrição e o valor do pedido a partir do catálogo (ou lança erro 400)
function resolveOrder(serviceId, option, extraIds) {
  const service = catalog().services.find((s) => s.id === serviceId);
  if (!service) throw httpError(400, 'Escolha o serviço.');
  if (!(option in OPTION_LABEL) || typeof service.prices[option] !== 'number') throw httpError(400, 'Escolha aplicação ou manutenção.');
  const ids = Array.isArray(extraIds) ? [...new Set(extraIds.map(String))] : [];
  const extras = ids.map((id) => catalog().extras.find((e) => e.id === id));
  if (extras.some((e) => !e)) throw httpError(400, 'Adicional inválido.');
  const total = service.prices[option] + extras.reduce((a, e) => a + e.price, 0);
  const model = `${service.name} · ${OPTION_LABEL[option]}` + (extras.length ? ` + ${extras.map((e) => e.name).join(' + ')}` : '');
  return { service, option, extras, total, model };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- Datas (strings YYYY-MM-DD / HH:MM, fuso de São Paulo) ----------
const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
function nowInTz() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}
const todayStr = () => nowInTz().date;
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (s) => new Date(s + 'T00:00:00Z').getUTCDay(); // 0=dom
function mondayOf(s) {
  const wd = weekday(s);
  return addDays(s, wd === 0 ? -6 : 1 - wd);
}
const fmtShort = (s) => `${s.slice(8)}/${s.slice(5, 7)}`;
function formatBR(s) {
  const d = new Date(s + 'T12:00:00Z');
  const dia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(d);
  const [y, m, dd] = s.split('-');
  return `${dia}, ${dd}/${m}/${y}`;
}
function formatPhoneBR(p) {
  const d = p.startsWith('55') ? p.slice(2) : p;
  return d.length === 11
    ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
    : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
}
function isSlotPast(date, time) {
  const now = nowInTz();
  return date < now.date || (date === now.date && time <= now.time);
}

// ---------- Armazenamento (JSON) com trava para evitar overbooking ----------
// db = {
//   weeks: { "<segunda>": { released: bool, days: { "<data>": [ { time, capacity } ] } } },
//   bookings: [ { id, name, phone, date, time, model, status, createdAt, decidedAt? } ]
// }
// status: 'pending' (cliente pediu, ainda não ocupa vaga) | 'confirmed' (dona confirmou, ocupa vaga) | 'rejected'
//         | 'cancelled' (dona cancelou um confirmado; a vaga volta para a agenda)
// Agendamentos antigos sem status são tratados como confirmados.
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
async function readDb() {
  let db;
  try {
    db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    db = {};
  }
  db.bookings = db.bookings || [];
  db.weeks = db.weeks || {};
  return db;
}
async function writeDb(db) {
  await fs.mkdir(DB_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DB_FILE);
}
const statusOf = (b) => b.status || 'confirmed';
const isConfirmed = (b) => statusOf(b) === 'confirmed';
const isActive = (b) => statusOf(b) === 'pending' || statusOf(b) === 'confirmed';
// só agendamentos confirmados tiram vaga da agenda
const countBooked = (db, date, time) => db.bookings.filter((b) => b.date === date && b.time === time && isConfirmed(b)).length;
const countPending = (db, date, time) => db.bookings.filter((b) => b.date === date && b.time === time && statusOf(b) === 'pending').length;
const findSlot = (db, date, time) => {
  const week = db.weeks[mondayOf(date)];
  return ((week && week.days && week.days[date]) || []).find((s) => s.time === time) || null;
};
// pedido pendente que ainda cabe (horário existe, não passou e não lotou)
function canConfirm(db, b) {
  const slot = findSlot(db, b.date, b.time);
  return statusOf(b) === 'pending' && !!slot && !isSlotPast(b.date, b.time) && countBooked(db, b.date, b.time) < slot.capacity;
}

// ---------- Visão pública de um dia ----------
function buildDayView(db, date, slots) {
  const sl = slots.map((s) => {
    const remaining = Math.max(0, s.capacity - countBooked(db, date, s.time));
    const status = isSlotPast(date, s.time) ? 'past' : remaining === 0 ? 'full' : 'available';
    return { time: s.time, remaining, status };
  });
  const remaining = sl.filter((s) => s.status === 'available').reduce((a, s) => a + s.remaining, 0);
  const status = remaining > 0 ? 'available' : sl.every((s) => s.status === 'past') ? 'past' : 'full';
  return { date, weekday: weekday(date), status, remaining, slots: sl };
}
function releasedWeeks(db) {
  const first = mondayOf(todayStr());
  return Object.keys(db.weeks).filter((w) => db.weeks[w].released && w >= first).sort();
}
function weekHasAvailability(db, monday) {
  const days = db.weeks[monday].days || {};
  return Object.entries(days).some(([date, slots]) => buildDayView(db, date, slots).status === 'available');
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Catálogo e dados do estúdio para o site
app.get('/api/config', (req, res) => res.json({
  business: { ...catalog().business, instagram: String(catalog().business.instagram || '').replace(/^@/, '') },
  services: catalog().services,
  extras: catalog().extras,
}));

// Semanas liberadas: dias, horários e vagas (para a cliente)
app.get('/api/availability', async (req, res) => {
  try {
    const db = await readDb();
    const list = releasedWeeks(db);
    if (!list.length) return res.json({ empty: true });

    let start;
    if (isDateStr(req.query.week)) {
      const ref = mondayOf(req.query.week);
      start = list.includes(ref) ? ref : list.find((w) => w >= ref) || list[list.length - 1];
    } else {
      start = list.find((w) => weekHasAvailability(db, w)) || list[0];
    }
    const idx = list.indexOf(start);
    const cfg = db.weeks[start].days || {};
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      if (!cfg[date] || !cfg[date].length) continue;
      days.push(buildDayView(db, date, cfg[date]));
    }
    res.json({
      weekStart: start,
      weekEnd: addDays(start, 6),
      days,
      hasPrev: idx > 0,
      hasNext: idx < list.length - 1,
      prevWeek: list[idx - 1] || null,
      nextWeek: list[idx + 1] || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao carregar a disponibilidade.' });
  }
});

// Criar agendamento (dia + horário)
app.post('/api/bookings', async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const phone = normalizePhone(req.body.phone);
  const date = String(req.body.date || '');
  const time = String(req.body.time || '');
  let order;
  try {
    order = resolveOrder(String(req.body.serviceId || ''), String(req.body.option || ''), req.body.extras);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { model, total } = order;

  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Informe seu nome.' });
  if (phone.length < 12 || phone.length > 13) return res.status(400).json({ error: 'Informe um WhatsApp válido com DDD.' });
  if (!isDateStr(date)) return res.status(400).json({ error: 'Data inválida.' });
  if (!TIME_RE.test(time)) return res.status(400).json({ error: 'Horário inválido.' });

  let booking;
  try {
    booking = await withLock(async () => {
      const db = await readDb();
      const week = db.weeks[mondayOf(date)];
      const slots = week && week.released ? (week.days || {})[date] : null;
      const slot = slots && slots.find((s) => s.time === time);
      if (!slot) throw httpError(409, 'Esse horário não está disponível. Escolha outro.');
      if (isSlotPast(date, time)) throw httpError(400, 'Esse horário já passou.');
      if (countBooked(db, date, time) >= slot.capacity) throw httpError(409, 'Esse horário acabou de lotar. Escolha outro.');
      if (db.bookings.some((b) => b.date === date && b.phone === phone && isActive(b))) {
        throw httpError(409, 'Você já tem um agendamento (ou pedido) nesse dia.');
      }
      if (countPending(db, date, time) >= MAX_PENDING_PER_SLOT) {
        throw httpError(409, 'Esse horário já tem muitos pedidos aguardando confirmação. Escolha outro.');
      }
      const b = {
        id: crypto.randomUUID(), name, phone, date, time, model, total,
        serviceId: order.service.id, option: order.option, extras: order.extras.map((e) => e.id),
        status: 'pending', createdAt: new Date().toISOString(),
      };
      db.bookings.push(b);
      await writeDb(db);
      return b;
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Erro ao salvar o agendamento.' });
  }

  // Mensagem pronta que a cliente envia à dona pelo WhatsApp (link wa.me)
  const message =
    `Olá, ${catalog().business.name.split(' ')[0]}! Acabei de solicitar um horário pelo site. 💖\n\n` +
    `Nome: ${name}\n` +
    `Dia: ${formatBR(date)}\n` +
    `Horário: ${time}\n` +
    `Serviço: ${order.service.name} (${OPTION_LABEL[order.option]})\n` +
    (order.extras.length ? `Adicionais: ${order.extras.map((e) => e.name).join(', ')}\n` : '') +
    `Valor: ${brl(total)}\n\n` +
    `Pode confirmar, por favor?`;

  res.status(201).json({
    ok: true,
    booking: {
      id: booking.id, name: booking.name, date: booking.date, time: booking.time,
      model: booking.model, total: booking.total, status: booking.status, dateLabel: formatBR(booking.date),
    },
    message,
    whatsappLink: buildWaLink(OWNER_PHONE, message),
  });

  // avisa a dona no celular/computador (não atrasa a resposta para a cliente)
  notifyNewBooking(booking).catch((e) => console.error('Notificação:', e.message));
});

async function notifyNewBooking(b) {
  if (!push.count()) return;
  const db = await readDb();
  const pending = db.bookings.filter((x) => statusOf(x) === 'pending' && !isSlotPast(x.date, x.time)).length;
  const wd = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(b.date + 'T12:00:00Z')).replace('.', '');
  await push.sendToAll({
    title: 'Novo pedido 💖',
    body: `${b.name} · ${wd} ${fmtShort(b.date)} às ${b.time}\n${b.model}${typeof b.total === 'number' ? ' · ' + brl(b.total) : ''}`,
    url: '/admin#pedidos',
    tag: 'pedido-' + b.id,
    badge: pending,
  });
}

// ---------- Área da dona (protegida por chave) ----------
const adminFails = new Map();
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Painel desativado: defina ADMIN_KEY no arquivo .env.' });
  const now = Date.now();
  const f = adminFails.get(req.ip) || { n: 0, until: 0 };
  if (f.until > now) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  if (!safeEqual(req.get('x-admin-key') || '', ADMIN_KEY)) {
    f.n += 1;
    if (f.n >= 10) { f.until = now + 10 * 60 * 1000; f.n = 0; }
    adminFails.set(req.ip, f);
    return res.status(401).json({ error: 'Chave incorreta.' });
  }
  adminFails.delete(req.ip);
  next();
}

function weekBounds() {
  const minWeek = mondayOf(todayStr());
  return { minWeek, maxWeek: addDays(minWeek, MAX_WEEKS_AHEAD * 7) };
}

// Configuração de uma semana (+ agendamentos dela)
app.get('/api/admin/weeks/:week', requireAdmin, async (req, res) => {
  try {
    const { minWeek, maxWeek } = weekBounds();
    let monday = req.params.week === 'current' || !isDateStr(req.params.week) ? minWeek : mondayOf(req.params.week);
    if (monday < minWeek) monday = minWeek;
    if (monday > maxWeek) monday = maxWeek;

    const db = await readDb();
    const week = db.weeks[monday];
    const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    res.json({
      weekStart: monday,
      minWeek,
      maxWeek,
      released: !!(week && week.released),
      days: dates.map((date) => ({
        date,
        weekday: weekday(date),
        slots: ((week && week.days && week.days[date]) || []).map((s) => ({
          time: s.time,
          capacity: s.capacity,
          booked: countBooked(db, date, s.time),
          pending: countPending(db, date, s.time),
        })),
      })),
      bookings: db.bookings
        .filter((b) => dates.includes(b.date))
        .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
        .map((b) => ({
          id: b.id, name: b.name, phone: b.phone, date: b.date, time: b.time || '', model: b.model || '',
          total: typeof b.total === 'number' ? b.total : null,
          status: statusOf(b), canConfirm: canConfirm(db, b),
        })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao carregar a semana.' });
  }
});

function normalizeWeekConfig(body, monday) {
  const released = !!body && body.released === true;
  const rawDays = (body && body.days) || {};
  const days = {};
  for (const [date, slots] of Object.entries(rawDays)) {
    if (!isDateStr(date) || mondayOf(date) !== monday) throw httpError(400, `Dia fora da semana: ${date}`);
    if (!Array.isArray(slots) || slots.length === 0) continue;
    if (slots.length > MAX_SLOTS_PER_DAY) throw httpError(400, `Máximo de ${MAX_SLOTS_PER_DAY} horários por dia.`);
    const seen = new Set();
    const clean = [];
    for (const s of slots) {
      const time = String((s && s.time) || '');
      const capacity = Number(s && s.capacity);
      if (!TIME_RE.test(time)) throw httpError(400, `Horário inválido em ${fmtShort(date)}.`);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
        throw httpError(400, `As vagas devem ser de 1 a ${MAX_CAPACITY} (${fmtShort(date)} às ${time}).`);
      }
      if (seen.has(time)) throw httpError(400, `Horário repetido em ${fmtShort(date)}: ${time}.`);
      seen.add(time);
      clean.push({ time, capacity });
    }
    days[date] = clean.sort((a, b) => a.time.localeCompare(b.time));
  }
  if (released && Object.keys(days).length === 0) {
    throw httpError(400, 'Adicione pelo menos um dia com horário para liberar a semana.');
  }
  return { released, days };
}

// Salvar / liberar / retirar uma semana
app.put('/api/admin/weeks/:week', requireAdmin, async (req, res) => {
  try {
    if (!isDateStr(req.params.week)) return res.status(400).json({ error: 'Semana inválida.' });
    const monday = mondayOf(req.params.week);
    const { minWeek, maxWeek } = weekBounds();
    if (monday < minWeek) return res.status(400).json({ error: 'Não é possível alterar semanas que já passaram.' });
    if (monday > maxWeek) return res.status(400).json({ error: 'Essa semana está longe demais no futuro.' });

    const cfg = normalizeWeekConfig(req.body, monday);
    await withLock(async () => {
      const db = await readDb();

      // não deixa apagar horário (ou cortar vagas) que já tem gente agendada
      const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
      const counts = {};
      db.bookings.filter((b) => b.time && dates.includes(b.date) && isConfirmed(b)).forEach((b) => {
        const k = `${b.date} ${b.time}`;
        counts[k] = (counts[k] || 0) + 1;
      });
      for (const [k, n] of Object.entries(counts)) {
        const [date, time] = k.split(' ');
        const slot = (cfg.days[date] || []).find((s) => s.time === time);
        if (!slot) throw httpError(409, `Já existe agendamento em ${fmtShort(date)} às ${time}; esse horário não pode ser removido.`);
        if (slot.capacity < n) throw httpError(409, `Em ${fmtShort(date)} às ${time} já há ${n} agendado(s); as vagas não podem ser menos que isso.`);
      }

      db.weeks[monday] = cfg;
      await writeDb(db);
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar a semana.' });
  }
});

// Apagar todos os agendamentos de uma semana (dupla verificação: body { confirm: "LIMPAR", expected: <qtd vista no painel> })
app.delete('/api/admin/weeks/:week/bookings', requireAdmin, async (req, res) => {
  try {
    if (!isDateStr(req.params.week)) return res.status(400).json({ error: 'Semana inválida.' });
    const monday = mondayOf(req.params.week);
    if (monday < weekBounds().minWeek) return res.status(400).json({ error: 'Não é possível alterar semanas que já passaram.' });
    if (String((req.body && req.body.confirm) || '').trim().toUpperCase() !== 'LIMPAR') {
      return res.status(400).json({ error: 'Digite LIMPAR para confirmar.' });
    }
    const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const removed = await withLock(async () => {
      const db = await readDb();
      const gone = db.bookings.filter((b) => dates.includes(b.date));
      // se chegou pedido novo depois que a dona abriu a tela, não apaga sem ela ver
      if (Number(req.body.expected) !== gone.length) {
        throw httpError(409, 'A lista mudou (chegou ou saiu algum agendamento). Confira de novo antes de limpar.');
      }
      if (!gone.length) return [];
      let backup = [];
      try { backup = JSON.parse(await fs.readFile(REMOVED_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const removedAt = new Date().toISOString();
      backup.push(...gone.map((b) => ({ ...b, removedAt })));
      await fs.writeFile(REMOVED_FILE, JSON.stringify(backup, null, 2));
      db.bookings = db.bookings.filter((b) => !dates.includes(b.date));
      await writeDb(db);
      return gone;
    });
    res.json({ ok: true, removed: removed.length });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Erro ao limpar os agendamentos.' });
  }
});

// Lista completa de agendamentos (?status=pending|confirmed|rejected|cancelled para filtrar)
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const db = await readDb();
  const list = db.bookings
    .map((b) => ({ ...b, status: statusOf(b), canConfirm: canConfirm(db, b) }))
    .filter((b) => !req.query.status || b.status === req.query.status);
  res.json(list.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))));
});

// Dona confirma ou recusa um pedido. Só ao confirmar o horário sai da agenda.
function clientMessage(b, status) {
  const first = b.name.split(' ')[0];
  if (status === 'confirmed') {
    return `Olá, ${first}! Seu agendamento (${b.model}) está confirmado para ${formatBR(b.date)} às ${b.time}. Te esperamos! 💖`;
  }
  if (status === 'cancelled') {
    return `Olá, ${first}! Precisei cancelar seu agendamento de ${formatBR(b.date)} às ${b.time}. ` +
      `Desculpe pelo transtorno! Se quiser, escolha outro horário pelo site. 💖`;
  }
  return `Olá, ${first}! Infelizmente não consigo te atender em ${formatBR(b.date)} às ${b.time}. ` +
    `Se quiser, escolha outro horário pelo site. 💖`;
}

const ACTIONS = { confirm: 'confirmed', reject: 'rejected', cancel: 'cancelled' };
app.post('/api/admin/bookings/:id/:action(confirm|reject|cancel)', requireAdmin, async (req, res) => {
  const status = ACTIONS[req.params.action];
  try {
    const booking = await withLock(async () => {
      const db = await readDb();
      const b = db.bookings.find((x) => x.id === req.params.id);
      if (!b) throw httpError(404, 'Agendamento não encontrado.');
      if (status === 'cancelled') {
        if (statusOf(b) !== 'confirmed') throw httpError(409, 'Só é possível cancelar agendamentos confirmados.');
      } else if (statusOf(b) !== 'pending') {
        throw httpError(409, 'Esse pedido já foi respondido.');
      }
      if (status === 'confirmed') {
        const slot = findSlot(db, b.date, b.time);
        if (!slot) throw httpError(409, 'Esse horário não existe mais na agenda. Recuse o pedido.');
        if (isSlotPast(b.date, b.time)) throw httpError(409, 'Esse horário já passou.');
        if (countBooked(db, b.date, b.time) >= slot.capacity) {
          throw httpError(409, 'Esse horário já está lotado com agendamentos confirmados. Recuse o pedido.');
        }
      }
      b.status = status;
      b.decidedAt = new Date().toISOString();
      await writeDb(db);
      return b;
    });
    res.json({
      ok: true,
      booking: { ...booking },
      whatsappLink: buildWaLink(booking.phone, clientMessage(booking, status)),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Erro ao atualizar o agendamento.' });
  }
});

// ---------- Notificações (Web Push) ----------
app.get('/api/admin/push/key', requireAdmin, (req, res) => res.json({ publicKey: push.publicKey, devices: push.count() }));
app.post('/api/admin/push/status', requireAdmin, (req, res) => {
  res.json({ subscribed: push.isSubscribed(String((req.body && req.body.endpoint) || '')), devices: push.count() });
});
app.post('/api/admin/push/subscribe', requireAdmin, (req, res) => {
  try {
    push.subscribe(req.body && req.body.subscription, req.body && req.body.device);
    res.json({ ok: true, devices: push.count() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao ativar as notificações.' });
  }
});
app.post('/api/admin/push/unsubscribe', requireAdmin, (req, res) => {
  push.unsubscribe(String((req.body && req.body.endpoint) || ''));
  res.json({ ok: true, devices: push.count() });
});
app.post('/api/admin/push/test', requireAdmin, async (req, res) => {
  try {
    const r = await push.sendToAll({ title: 'Notificações ativas ✨', body: 'Você vai receber um aviso aqui a cada novo pedido.', url: '/admin', tag: 'teste' });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao enviar o teste.' });
  }
});

app.listen(PORT, () => {
  console.log(`Agendamento rodando em http://localhost:${PORT}`);
  console.log(`Painel da dona em http://localhost:${PORT}/admin`);
  if (!ADMIN_KEY || ADMIN_KEY === 'troque-esta-chave') {
    console.warn('ATENÇÃO: defina uma ADMIN_KEY própria no arquivo .env (a chave atual é fraca ou está vazia).');
  }
});
