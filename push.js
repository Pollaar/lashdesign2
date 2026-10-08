// Notificações Web Push para a dona (Android, computador e iPhone com o painel na Tela de Início).
// As chaves VAPID são geradas na primeira execução e guardadas em data/vapid.json
// (ou definidas no .env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DATA_DIR = path.join(__dirname, 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const MAX_SUBS = 20;

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
    console.log('Chaves de notificação (VAPID) criadas em data/vapid.json — guarde junto com o backup da pasta data.');
    return keys;
  }
}

const keys = loadKeys();
// A Apple recusa o envio sem um "subject" válido (mailto: ou https:)
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);

function readSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return []; }
}
function writeSubs(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SUBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, SUBS_FILE);
}

function isValidSub(s) {
  return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 &&
    s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

function subscribe(sub, device) {
  if (!isValidSub(sub)) throw Object.assign(new Error('Inscrição inválida.'), { status: 400 });
  const list = readSubs().filter((s) => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(device || '').slice(0, 80), createdAt: new Date().toISOString() });
  writeSubs(list.slice(-MAX_SUBS));
}

function unsubscribe(endpoint) {
  writeSubs(readSubs().filter((s) => s.endpoint !== endpoint));
}

const isSubscribed = (endpoint) => readSubs().some((s) => s.endpoint === endpoint);

// Envia para todos os aparelhos inscritos; remove os que não existem mais (404/410)
async function sendToAll(payload) {
  const list = readSubs();
  if (!list.length) return { sent: 0, failed: 0 };
  const body = JSON.stringify(payload);
  const dead = new Set();
  let sent = 0;
  let failed = 0;
  await Promise.all(list.map(async (s) => {
    try {
      await webpush.sendNotification(s, body, { TTL: 24 * 60 * 60, urgency: 'high', topic: payload.topic });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint);
      else console.error('Falha ao enviar notificação:', e.statusCode || '', e.body || e.message);
    }
  }));
  if (dead.size) writeSubs(readSubs().filter((s) => !dead.has(s.endpoint)));
  return { sent, failed };
}

module.exports = { publicKey: keys.publicKey, subscribe, unsubscribe, isSubscribed, sendToAll, count: () => readSubs().length };
