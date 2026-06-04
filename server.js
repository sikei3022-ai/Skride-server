// Skride backend — посредник между приложением и облачными сервисами.
// Хранит ключи у себя (в переменных окружения), приложение к ключам доступа не имеет.
// Эндпоинты:
//   GET  /            — проверка, что сервер жив
//   POST /api/coach   — умный тренер (Claude или GPT)
//   POST /api/tts     — живой голос (ElevenLabs или Yandex SpeechKit)
//
// Запуск локально:  npm install && npm start
// Деплой: Render / Railway / Cloudflare — см. README.md

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const app = express();
app.use(express.json({ limit: '256kb' }));

// ---- CORS (разрешаем запросы из приложения) ----
// По умолчанию разрешаем всем (*). Для безопасности можно вписать свой домен
// в переменную ALLOW_ORIGIN, например: https://chipper-paprenjak-fb29c7.netlify.app
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- простой лимит: не больше 40 запросов в минуту с одного IP ----
const hits = new Map();
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  if (rec.n > 40) return res.status(429).json({ error: 'Слишком много запросов, подожди минуту.' });
  next();
});

// ===================== МОЗГ ТРЕНЕРА =====================
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'yandex').toLowerCase(); // 'yandex' | 'anthropic' | 'openai'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
// Модель можно менять без правки кода — смотри актуальные имена в документации провайдера.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Yandex Cloud (YandexGPT + SpeechKit). Один API-ключ сервисного аккаунта и один folderId — на оба сервиса.
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || '';
const YANDEX_GPT_MODEL = process.env.YANDEX_GPT_MODEL || 'yandexgpt-lite'; // дешевле; для качества: yandexgpt

const SYSTEM_PROMPT =
`Ты — Skride, дружелюбный и опытный ИИ-тренер по бегу и велоспорту в мобильном приложении.
Отвечай на языке пользователя (обычно русский). Будь тёплым, конкретным и кратким: 2–5 предложений, без воды.
Помогай с планом тренировок, объёмом и его ростом (правило ~10% в неделю), пульсовыми зонами, восстановлением и сном,
техникой бега и педалирования, питанием и водой, мотивацией, подготовкой к забегам.
Ты НЕ врач: при боли, травмах или тревожных симптомах советуй осторожность, отдых и визит к специалисту — без диагнозов и схем лечения.
Если пользователь сообщает свои данные (километраж, темп, пульс) — учитывай их. Не выдумывай цифры о пользователе, которых нет.`;

async function askLLM(messages, context) {
  // messages: [{role:'user'|'assistant', content:'...'}]
  const sys = context ? (SYSTEM_PROMPT + '\n\nДанные пользователя: ' + context) : SYSTEM_PROMPT;

  if (LLM_PROVIDER === 'yandex') {
    if (!YANDEX_API_KEY) throw new Error('Нет YANDEX_API_KEY');
    if (!YANDEX_FOLDER_ID) throw new Error('Нет YANDEX_FOLDER_ID');
    const ymsgs = [{ role: 'system', text: sys },
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.content }))];
    const r = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Api-Key ' + YANDEX_API_KEY },
      body: JSON.stringify({
        modelUri: 'gpt://' + YANDEX_FOLDER_ID + '/' + YANDEX_GPT_MODEL + '/latest',
        completionOptions: { stream: false, temperature: 0.6, maxTokens: '500' },
        messages: ymsgs
      })
    });
    if (!r.ok) throw new Error('YandexGPT ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const d = await r.json();
    return (d.result && d.result.alternatives && d.result.alternatives[0] && d.result.alternatives[0].message.text || '').trim();
  }

  if (LLM_PROVIDER === 'openai') {
    if (!OPENAI_API_KEY) throw new Error('Нет OPENAI_API_KEY');
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 500,
        messages: [{ role: 'system', content: sys }, ...messages]
      })
    });
    if (!r.ok) throw new Error('OpenAI ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || '';
  }

  // по умолчанию — Anthropic Claude
  if (!ANTHROPIC_API_KEY) throw new Error('Нет ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: sys,
      messages: messages
    })
  });
  if (!r.ok) throw new Error('Anthropic ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const d = await r.json();
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

app.post('/api/coach', async (req, res) => {
  try {
    let { messages, context } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
    // оставляем только последние 12 сообщений и подрезаем длину
    messages = messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 2000)
    }));
    const reply = await askLLM(messages, context ? String(context).slice(0, 500) : '');
    res.json({ reply: reply || 'Извини, не смог сформулировать ответ. Попробуй переспросить.' });
  } catch (e) {
    console.error('coach error:', e.message);
    res.status(502).json({ error: 'Тренер недоступен', detail: e.message });
  }
});

// ===================== ЖИВОЙ ГОЛОС =====================
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // мультиязычный голос по умолчанию
const YANDEX_TTS_KEY = process.env.YANDEX_TTS_KEY || YANDEX_API_KEY; // тот же ключ Yandex Cloud
const YANDEX_VOICE = process.env.YANDEX_VOICE || 'alena'; // alena, filipp, ermil, jane, omazh, madirus, zahar

app.post('/api/tts', async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').slice(0, 800);
    if (!text) return res.status(400).json({ error: 'text required' });
    const voice = (req.body && req.body.voice) ? String(req.body.voice).slice(0, 30) : YANDEX_VOICE;

    if (ELEVENLABS_API_KEY) {
      const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + ELEVEN_VOICE_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
      if (!r.ok) throw new Error('ElevenLabs ' + r.status + ' ' + (await r.text()).slice(0, 200));
      res.setHeader('Content-Type', 'audio/mpeg');
      const buf = Buffer.from(await r.arrayBuffer());
      return res.send(buf);
    }

    if (YANDEX_TTS_KEY) {
      const params = new URLSearchParams({ text, lang: 'ru-RU', voice: voice, format: 'oggopus', speed: '1.0' });
      if (YANDEX_FOLDER_ID) params.set('folderId', YANDEX_FOLDER_ID);
      const r = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
        method: 'POST',
        headers: { 'Authorization': 'Api-Key ' + YANDEX_TTS_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      if (!r.ok) throw new Error('Yandex ' + r.status + ' ' + (await r.text()).slice(0, 200));
      res.setHeader('Content-Type', 'audio/ogg');
      const buf = Buffer.from(await r.arrayBuffer());
      return res.send(buf);
    }

    res.status(501).json({ error: 'Голос не настроен: добавь ELEVENLABS_API_KEY или YANDEX_TTS_KEY' });
  } catch (e) {
    console.error('tts error:', e.message);
    res.status(502).json({ error: 'Голос недоступен', detail: e.message });
  }
});

// ===================== АККАУНТЫ + БАЗА + СИНХРОНИЗАЦИЯ =====================
const DATABASE_URL = process.env.DATABASE_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function initDb() {
  if (!pool) { console.warn('Нет DATABASE_URL — аккаунты выключены'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS users(
    id serial PRIMARY KEY,
    email text UNIQUE,
    pass_hash text,
    yandex_id text UNIQUE,
    name text,
    runs jsonb DEFAULT '[]'::jsonb,
    week_km double precision DEFAULT 0,
    total_km double precision DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`);
  console.log('База готова');
}
initDb().catch(e => console.error('initDb error:', e.message));

function dbReady(res) {
  if (!pool) { res.status(503).json({ error: 'Аккаунты не настроены на сервере (нет DATABASE_URL)' }); return false; }
  if (!JWT_SECRET) { res.status(503).json({ error: 'Аккаунты не настроены на сервере (нет JWT_SECRET)' }); return false; }
  return true;
}
function makeToken(u) { return jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '180d' }); }
function publicUser(u) { return { id: u.id, email: u.email || null, name: u.name || null, yandex: !!u.yandex_id }; }
async function auth(req, res) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) { res.status(401).json({ error: 'Нужен вход' }); return null; }
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    const r = await pool.query('SELECT * FROM users WHERE id=$1', [p.uid]);
    if (!r.rows[0]) { res.status(401).json({ error: 'Сессия не найдена' }); return null; }
    return r.rows[0];
  } catch (e) { res.status(401).json({ error: 'Сессия истекла, войди заново' }); return null; }
}
function computeKm(runs) {
  let total = 0, week = 0; const wk = Date.now() - 7 * 86400000;
  (Array.isArray(runs) ? runs : []).forEach(r => {
    const km = +r.km || 0; total += km;
    const d = r.date ? new Date(r.date + 'T00:00').getTime() : 0;
    if (d >= wk) week += km;
  });
  return { total: Math.round(total * 100) / 100, week: Math.round(week * 100) / 100 };
}
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// --- Регистрация: почта + пароль ---
app.post('/api/register', async (req, res) => {
  if (!dbReady(res)) return;
  try {
    let { email, password, name } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    if (!emailRe.test(email)) return res.status(400).json({ error: 'Неверный e-mail' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const ex = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (ex.rows[0]) return res.status(409).json({ error: 'Такая почта уже зарегистрирована' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(email, pass_hash, name) VALUES($1,$2,$3) RETURNING *',
      [email, hash, String(name || '').slice(0, 40) || null]);
    const u = r.rows[0];
    res.json({ token: makeToken(u), user: publicUser(u) });
  } catch (e) { console.error('register:', e.message); res.status(500).json({ error: 'Ошибка регистрации' }); }
});

// --- Вход: почта + пароль ---
app.post('/api/login', async (req, res) => {
  if (!dbReady(res)) return;
  try {
    let { email, password } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    const u = r.rows[0];
    if (!u || !u.pass_hash) return res.status(401).json({ error: 'Почта или пароль неверны' });
    const ok = await bcrypt.compare(password, u.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Почта или пароль неверны' });
    res.json({ token: makeToken(u), user: publicUser(u) });
  } catch (e) { console.error('login:', e.message); res.status(500).json({ error: 'Ошибка входа' }); }
});

// --- Вход через Яндекс ID (приложение присылает access_token) ---
app.post('/api/yandex', async (req, res) => {
  if (!dbReady(res)) return;
  try {
    const token = String((req.body && req.body.token) || '');
    if (!token) return res.status(400).json({ error: 'Нет токена Яндекса' });
    const yr = await fetch('https://login.yandex.ru/info?format=json', { headers: { 'Authorization': 'OAuth ' + token } });
    if (!yr.ok) return res.status(401).json({ error: 'Яндекс не подтвердил вход' });
    const info = await yr.json();
    const yid = String(info.id || ''); if (!yid) return res.status(401).json({ error: 'Яндекс не вернул профиль' });
    const yemail = (info.default_email || '').toLowerCase() || null;
    const yname = info.real_name || info.display_name || info.first_name || null;
    let r = await pool.query('SELECT * FROM users WHERE yandex_id=$1', [yid]);
    let u = r.rows[0];
    if (!u && yemail) {
      const byMail = await pool.query('SELECT * FROM users WHERE email=$1', [yemail]);
      if (byMail.rows[0]) { u = (await pool.query('UPDATE users SET yandex_id=$1 WHERE id=$2 RETURNING *', [yid, byMail.rows[0].id])).rows[0]; }
    }
    if (!u) { u = (await pool.query('INSERT INTO users(yandex_id, email, name) VALUES($1,$2,$3) RETURNING *', [yid, yemail, yname])).rows[0]; }
    res.json({ token: makeToken(u), user: publicUser(u) });
  } catch (e) { console.error('yandex:', e.message); res.status(500).json({ error: 'Ошибка входа через Яндекс' }); }
});

// --- Кто я ---
app.get('/api/me', async (req, res) => {
  if (!dbReady(res)) return; const u = await auth(req, res); if (!u) return;
  res.json({ user: publicUser(u) });
});

// --- Получить мои тренировки из облака ---
app.get('/api/sync', async (req, res) => {
  if (!dbReady(res)) return; const u = await auth(req, res); if (!u) return;
  res.json({ runs: u.runs || [], updated_at: u.updated_at });
});

// --- Сохранить мои тренировки в облако ---
app.post('/api/sync', async (req, res) => {
  if (!dbReady(res)) return; const u = await auth(req, res); if (!u) return;
  try {
    let runs = (req.body && req.body.runs) || [];
    if (!Array.isArray(runs)) runs = [];
    runs = runs.slice(0, 5000);
    const km = computeKm(runs);
    await pool.query('UPDATE users SET runs=$1, week_km=$2, total_km=$3, updated_at=now() WHERE id=$4',
      [JSON.stringify(runs), km.week, km.total, u.id]);
    res.json({ ok: true, count: runs.length, week_km: km.week, total_km: km.total });
  } catch (e) { console.error('sync:', e.message); res.status(500).json({ error: 'Ошибка синхронизации' }); }
});

// --- Анонимный рейтинг среди пользователей (по недельному объёму) ---
app.get('/api/rank', async (req, res) => {
  if (!dbReady(res)) return; const u = await auth(req, res); if (!u) return;
  try {
    const totalR = await pool.query('SELECT count(*)::int AS n FROM users WHERE total_km > 0');
    const total = Math.max(1, totalR.rows[0].n);
    const my = +u.week_km || 0;
    const ahead = await pool.query('SELECT count(*)::int AS n FROM users WHERE week_km > $1', [my]);
    const position = ahead.rows[0].n + 1;
    const better = total > 1 ? Math.round((total - position) / (total - 1) * 100) : 50;
    res.json({ position, total, percentile: Math.max(0, Math.min(100, better)), week_km: my });
  } catch (e) { console.error('rank:', e.message); res.status(500).json({ error: 'Ошибка рейтинга' }); }
});


app.get('/api/voicecheck', async (req, res) => {
  try {
    if (!YANDEX_TTS_KEY) return res.json({ ok: false, where: 'config', error: 'нет ключа YANDEX_API_KEY' });
    const v = (req.query.voice ? String(req.query.voice) : YANDEX_VOICE);
    const params = new URLSearchParams({ text: 'тест', lang: 'ru-RU', voice: v, format: 'oggopus' });
    if (YANDEX_FOLDER_ID) params.set('folderId', YANDEX_FOLDER_ID);
    const r = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
      method: 'POST',
      headers: { 'Authorization': 'Api-Key ' + YANDEX_TTS_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!r.ok) { const t = await r.text(); return res.json({ ok: false, where: 'yandex', status: r.status, voice: v, error: t.slice(0, 300) }); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.json({ ok: true, voice: v, bytes: buf.length });
  } catch (e) { res.json({ ok: false, where: 'exception', error: String(e.message) }); }
});

app.get('/', (req, res) => res.json({
  ok: true,
  service: 'Skride backend',
  version: '5.0-accounts',
  llm: LLM_PROVIDER,
  voice: ELEVENLABS_API_KEY ? 'elevenlabs' : (YANDEX_TTS_KEY ? 'yandex' : 'none'),
  accounts: !!(pool && JWT_SECRET)
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Skride backend на порту ' + PORT));
