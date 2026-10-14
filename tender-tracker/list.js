const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

$('filter').innerHTML =
  '<option value="active">Активные</option><option value="all">Все</option>' +
  STATUSES.map(s => `<option value="${s}">${s}</option>`).join('');

function sortKey(t) {
  // активные с ближайшим сроком — наверху, завершённые — внизу
  const active = ACTIVE_STATUSES.includes(t.status) ? 0 : 1;
  return [active, dueDate(t) || '9999'];
}

async function render() {
  const tenders = await loadTenders();
  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;

  const list = tenders
    .filter(t => f === 'all' || (f === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === f))
    .filter(t => !q || [t.number, t.customer, t.subject, t.comment].join(' ').toLowerCase().includes(q))
    .sort((a, b) => {
      const [a1, a2] = sortKey(a), [b1, b2] = sortKey(b);
      return a1 - b1 || a2.localeCompare(b2);
    });

  $('empty').hidden = list.length > 0;
  $('rows').innerHTML = list.map(t => {
    const cls = ACTIVE_STATUSES.includes(t.status) ? urgency(t) : 'done';
    const statusOpts = STATUSES.map(s => `<option${s === t.status ? ' selected' : ''}>${s}</option>`).join('');
    const num = t.url ? `<a href="${esc(t.url)}" target="_blank">${esc(t.number || 'ссылка')}</a>` : esc(t.number);
    return `<tr class="${cls}">
      <td class="num">${num}</td>
      <td>${esc(t.customer)}</td>
      <td><div class="subj">${esc(t.subject)}</div></td>
      <td>${esc(t.type)}</td>
      <td class="money">${esc(fmtMoney(t.nmck))}</td>
      <td class="date">${esc(fmtDate(t.takenDate))}</td>
      <td class="date">${esc(fmtDate(t.deadline))}</td>
      <td class="date">${esc(fmtDate(t.auctionDate))}</td>
      <td><select data-id="${t.id}" class="status">${statusOpts}</select></td>
      <td>${esc(t.comment)}</td>
      <td><button class="link edit" data-id="${t.id}">Изменить</button></td>
    </tr>`;
  }).join('');
}

$('rows').addEventListener('change', async e => {
  if (!e.target.classList.contains('status')) return;
  const tenders = await loadTenders();
  const t = tenders.find(x => x.id === e.target.dataset.id);
  if (!t) return;
  t.status = e.target.value;
  t.updatedAt = new Date().toISOString();
  await saveTenders(tenders);
  await syncTenders([t]);
});

$('rows').addEventListener('click', e => {
  if (!e.target.classList.contains('edit')) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?id=' + e.target.dataset.id) });
});

$('search').addEventListener('input', render);
$('filter').addEventListener('change', render);
chrome.storage.onChanged.addListener(() => { render(); renderSheetState(); });

// ---------- Google Таблица ----------
function sheetMsg(text, isErr) {
  $('sheetMsg').textContent = text;
  $('sheetMsg').className = 'sheet-msg' + (isErr ? ' err' : '');
}

async function renderSheetState() {
  const { url } = await loadSettings();
  const tenders = await loadTenders();
  const { pendingDeletes = [] } = await chrome.storage.local.get('pendingDeletes');
  const waiting = tenders.filter(isUnsynced).length + pendingDeletes.length;
  const el = $('sheetState');
  if (!url) {
    el.textContent = 'не подключена';
    el.className = '';
  } else if (waiting) {
    el.textContent = `подключена · не отправлено: ${waiting}`;
    el.className = 'state-warn';
  } else {
    el.textContent = 'подключена · всё отправлено';
    el.className = 'state-ok';
  }
}

async function initSheetForm() {
  const s = await loadSettings();
  $('sheetUrl').value = s.url || '';
  $('sheetToken').value = s.token || '';
  if (!s.url) $('sheetBox').open = true;
  renderSheetState();
}

$('sheetSave').addEventListener('click', async () => {
  const url = $('sheetUrl').value.trim();
  const token = $('sheetToken').value.trim();
  if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    sheetMsg('Адрес должен начинаться с https://script.google.com/', true);
    return;
  }
  await saveSettings({ url, token });
  if (!url) { sheetMsg('Таблица отключена'); return; }
  sheetMsg('Проверяю…');
  const r = await sheetRequest({ action: 'ping' });
  if (!r.ok) { sheetMsg('Не получилось: ' + r.error, true); return; }
  sheetMsg('Связь есть ✓ Отправляю тендеры…');
  const s = await syncAll();
  sheetMsg(s.ok ? `Готово ✓ Отправлено: ${s.count || 0}` : 'Связь есть, но отправка не удалась: ' + s.error, !s.ok);
});

$('syncNow').addEventListener('click', async () => {
  if (!(await loadSettings()).url) { sheetMsg('Сначала укажите адрес и ключ и нажмите «Сохранить»', true); return; }
  sheetMsg('Отправляю…');
  const s = await syncAll();
  sheetMsg(s.ok ? `Готово ✓ Отправлено: ${s.count || 0}` : 'Ошибка: ' + s.error, !s.ok);
});

initSheetForm();

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// CSV с ";" и BOM — открывается в русском Excel двойным щелчком
$('export').addEventListener('click', async () => {
  const tenders = await loadTenders();
  const cols = [
    ['number', 'Номер'], ['customer', 'Заказчик'], ['subject', 'Предмет'], ['type', 'Тип'],
    ['nmck', 'НМЦК'], ['takenDate', 'Взяли в работу'], ['deadline', 'Срок подачи'],
    ['auctionDate', 'Торги / итоги'], ['status', 'Статус'], ['comment', 'Комментарий'], ['url', 'Ссылка']
  ];
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const val = (t, k) => k === 'nmck' ? String(t.nmck || '').replace('.', ',')
    : ['takenDate', 'deadline', 'auctionDate'].includes(k) ? fmtDate(t[k]) : t[k];
  const csv = [cols.map(c => cell(c[1])).join(';')]
    .concat(tenders.map(t => cols.map(([k]) => cell(val(t, k))).join(';')))
    .join('\r\n');
  download(`тендеры_${todayISO()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
});

$('backup').addEventListener('click', async () => {
  download(`тендеры_backup_${todayISO()}.json`, JSON.stringify(await loadTenders(), null, 2), 'application/json');
});

$('restoreBtn').addEventListener('click', () => $('restore').click());
$('restore').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error();
    // объединяем: записи из файла добавляются, совпадающие по id — заменяются
    const tenders = await loadTenders();
    const byId = new Map(tenders.map(t => [t.id, t]));
    for (const t of data) if (t && t.id) byId.set(t.id, t);
    await saveTenders([...byId.values()]);
    alert(`Восстановлено записей: ${data.length}`);
  } catch {
    alert('Не удалось прочитать файл резервной копии');
  }
  e.target.value = '';
});

render();
