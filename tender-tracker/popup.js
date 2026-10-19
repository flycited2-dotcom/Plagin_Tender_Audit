const $ = id => document.getElementById(id);
const FIELDS = ['number', 'customer', 'subject', 'type', 'nmck', 'etp', 'takenDate', 'deadline', 'auctionDate', 'status', 'comment', 'url'];
const AUTO_FIELDS = ['number', 'customer', 'subject', 'type', 'nmck', 'etp', 'deadline', 'auctionDate'];

const params = new URLSearchParams(location.search);
const editId = params.get('id'); // открыто из таблицы для редактирования
let current = null;

function fillSelect(sel, values, withEmpty) {
  sel.innerHTML = (withEmpty ? '<option value="">—</option>' : '') +
    values.map(v => `<option>${v}</option>`).join('');
}

function setInfo(text, kind = '') {
  $('info').textContent = text;
  $('info').className = 'info ' + kind;
}

function fillForm(t) {
  for (const f of FIELDS) $(f).value = t[f] || '';
}

function readForm() {
  const t = {};
  for (const f of FIELDS) t[f] = $(f).value.trim();
  t.nmck = t.nmck.replace(/\s/g, '').replace(',', '.');
  return t;
}

async function readPage(tab) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractTender });
    return res && res.result;
  } catch (e) {
    return null; // служебные страницы браузера и т.п.
  }
}

async function init() {
  fillSelect($('type'), TYPES, true);
  fillSelect($('status'), STATUSES, false);
  $('etpList').innerHTML = ETPS.map(v => `<option value="${v}">`).join('');
  const tenders = await loadTenders();

  if (editId) {
    document.body.classList.add('page');
    current = tenders.find(t => t.id === editId);
    if (!current) { setInfo('Запись не найдена', 'err'); return; }
    fillForm(current);
    $('delete').hidden = false;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const data = await readPage(tab);
  const url = (data && data.url) || tab.url || '';

  const existing = tenders.find(t =>
    (data && data.number && t.number === data.number) || (url && t.url === url));

  if (existing) {
    current = existing;
    fillForm(current);
    $('delete').hidden = false;
    // площадка появилась позже — дозаполняем у старых записей, если на странице она есть
    if (!current.etp && data && data.etp) {
      $('etp').value = data.etp;
      $('etp').classList.add('auto');
      setInfo('Этот тендер уже в базе. Найдена площадка — нажмите «Сохранить», чтобы дописать её в таблицу', 'ok');
    } else {
      setInfo('Этот тендер уже в базе — обновите статус или данные', 'ok');
    }
    return;
  }

  current = { url, takenDate: todayISO(), status: 'Новый' };
  let found = 0;
  if (data) {
    for (const f of AUTO_FIELDS) {
      if (data[f]) { current[f] = data[f]; found++; }
    }
  }
  fillForm(current);
  for (const f of AUTO_FIELDS) if (data && data[f]) $(f).classList.add('auto');

  if (!data) setInfo('Страницу прочитать не удалось — заполните вручную', 'warn');
  else if (found === 0) setInfo('Поля не распознаны — заполните вручную', 'warn');
  else setInfo(`Распознано полей: ${found} из ${AUTO_FIELDS.length}. Зелёные — заполнены автоматически, проверьте их.`, 'ok');

  // защита от дублей: такой номер уже есть в таблице (например, сохранён из другого браузера)?
  if (current.number) checkSheetDuplicate(current.number);
}

async function checkSheetDuplicate(number) {
  const res = await sheetFind(number);
  if (!res.ok || !res.found || current.id) return;
  const f = res.found;
  // берём запись из таблицы, а пустые поля дополняем распознанным со страницы
  const merged = { ...f };
  for (const k of FIELDS) if (!merged[k] && current[k]) merged[k] = current[k];
  current = merged;
  fillForm(current);
  for (const k of FIELDS) $(k).classList.remove('auto');
  const when = f.updatedAt ? new Date(f.updatedAt).toLocaleDateString('ru-RU') : '';
  setInfo(`⚠️ Этот тендер уже есть в таблице (статус «${f.status || '—'}»${when ? ', обновлён ' + when : ''}). ` +
    'Открыта существующая запись — «Сохранить» обновит её, дубля не будет.', 'warn');
}

$('form').addEventListener('input', e => e.target.classList.remove('auto'));

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = readForm();
  if (!data.number && !data.subject) {
    setInfo('Укажите хотя бы номер или предмет закупки', 'err');
    return;
  }
  const tenders = await loadTenders();
  const now = new Date().toISOString();
  const record = { ...current, ...data, id: current.id || crypto.randomUUID(), updatedAt: now };
  if (!current.id) record.createdAt = now;

  const i = tenders.findIndex(t => t.id === record.id);
  if (i >= 0) tenders[i] = record; else tenders.push(record);
  await saveTenders(tenders);
  current = record;
  $('delete').hidden = false;

  setInfo('Сохранено ✓ Отправляю в таблицу…', 'ok');
  const res = await syncTenders([record]);
  let delay = 900;
  if (res.ok) setInfo('Сохранено ✓ и отправлено в Google Таблицу', 'ok');
  else if (res.skipped) setInfo('Сохранено ✓', 'ok');
  else {
    setInfo(`Сохранено ✓, но в таблицу не ушло: ${res.error}. Отправится автоматически позже.`, 'warn');
    delay = 3000;
  }
  if (!editId) setTimeout(() => window.close(), delay);
});

$('delete').addEventListener('click', async () => {
  if (!current || !current.id || !confirm('Удалить этот тендер из списка?')) return;
  const all = await loadTenders();
  const removed = all.find(t => t.id === current.id) || current;
  await saveTenders(all.filter(t => t.id !== current.id));
  await syncDelete(removed);
  if (editId) window.close(); else { setInfo('Удалено', 'warn'); setTimeout(() => window.close(), 700); }
});

$('openList').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('list.html') });
});

init();
