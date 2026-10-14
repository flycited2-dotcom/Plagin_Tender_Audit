// Общие справочники и работа с хранилищем (используется в popup, таблице и фоне)

const STATUSES = ['Новый', 'В работе', 'Подано', 'Торги', 'Выиграли', 'Проиграли', 'Отказ'];
const ACTIVE_STATUSES = ['Новый', 'В работе', 'Подано', 'Торги'];
const TYPES = [
  'Электронный аукцион',
  'Конкурс',
  'Запрос котировок',
  'Запрос предложений',
  'Ед. поставщик',
  'Коммерческая / 223-ФЗ',
  'Другое'
];

async function loadTenders() {
  const { tenders = [] } = await chrome.storage.local.get('tenders');
  return tenders;
}

async function saveTenders(tenders) {
  await chrome.storage.local.set({ tenders });
}

// Какая дата сейчас важна: пока готовим заявку — срок подачи, после подачи — дата торгов/итогов
function dueDate(t) {
  if (t.status === 'Новый' || t.status === 'В работе') return t.deadline || '';
  if (t.status === 'Подано' || t.status === 'Торги') return t.auctionDate || '';
  return '';
}

function daysLeft(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T23:59');
  return (d - Date.now()) / 86400000;
}

// '' | 'yellow' (≤7 дней) | 'red' (≤3 дней) | 'overdue' (прошло)
function urgency(t) {
  const d = daysLeft(dueDate(t));
  if (d === null) return '';
  if (d < 0) return 'overdue';
  if (d <= 3) return 'red';
  if (d <= 7) return 'yellow';
  return '';
}

function fmtDate(v) {
  if (!v) return '';
  const [d, time] = v.split('T');
  const [y, m, dd] = d.split('-');
  return `${dd}.${m}.${y}` + (time ? ' ' + time : '');
}

function fmtMoney(v) {
  if (v === '' || v == null || isNaN(Number(v))) return v || '';
  return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

// ---------- Google Таблица ----------
// Настройки: { url: адрес веб-приложения Apps Script, token: ключ доступа }
// Значения по умолчанию лежат в config.js (не публикуется, образец — config.example.js);
// поменять можно в «Все тендеры → Google Таблица»
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || (typeof DEFAULT_SETTINGS !== 'undefined' ? DEFAULT_SETTINGS : {});
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// Запрос к скрипту таблицы. { ok } | { ok: false, error } | { ok: false, skipped: true } — таблица не настроена
async function sheetRequest(body) {
  const { url, token } = await loadSettings();
  if (!url) return { ok: false, skipped: true };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token })
    });
  } catch (e) {
    return { ok: false, error: 'Нет связи с таблицей' };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    // вместо ответа скрипта пришла страница входа или ошибки Google
    return { ok: false, error: 'скрипт не ответил — проверьте адрес и что доступ к веб-приложению «Все»' };
  }
  return data.ok ? data : { ok: false, error: data.error || 'Ошибка таблицы' };
}

function isUnsynced(t) {
  return !t.syncedAt || t.syncedAt < t.updatedAt;
}

// Отправить записи в таблицу и отметить отправленные
async function syncTenders(list) {
  if (!list.length) return { ok: true, count: 0 };
  const res = await sheetRequest({ action: 'upsert', tenders: list });
  if (res.ok) {
    const ids = new Set(list.map(t => t.id));
    const now = new Date().toISOString();
    const tenders = await loadTenders();
    for (const t of tenders) if (ids.has(t.id)) t.syncedAt = now;
    await saveTenders(tenders);
  }
  return res;
}

// Удалить строку из таблицы; если не получилось — повторим позже
async function syncDelete(t) {
  if (!t.syncedAt) return { ok: true };
  const res = await sheetRequest({ action: 'delete', id: t.id });
  if (!res.ok && !res.skipped) {
    const { pendingDeletes = [] } = await chrome.storage.local.get('pendingDeletes');
    await chrome.storage.local.set({ pendingDeletes: [...pendingDeletes, t.id] });
  }
  return res;
}

// Дослать всё, что не ушло (вызывается кнопкой и по таймеру)
async function syncAll() {
  const { pendingDeletes = [] } = await chrome.storage.local.get('pendingDeletes');
  const left = [];
  let lastError = null;
  for (const id of pendingDeletes) {
    const r = await sheetRequest({ action: 'delete', id });
    if (r.skipped) return r;
    if (!r.ok) { left.push(id); lastError = r; }
  }
  if (pendingDeletes.length) await chrome.storage.local.set({ pendingDeletes: left });
  if (lastError) return lastError;
  return syncTenders((await loadTenders()).filter(isUnsynced));
}

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
