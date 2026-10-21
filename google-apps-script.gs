// Приёмник данных из расширения «Учёт тендеров» для Google Таблицы.
// Вставьте этот код в: Таблица → Расширения → Apps Script (заменив всё, что там есть).

const TOKEN = 'ЗАМЕНИТЕ-НА-СВОЙ-КЛЮЧ'; // тот же ключ впишите в настройках расширения
const SPREADSHEET_ID = '1FrmX4f42kx-mG3DnQwS2z27ANHWmjoKONOnhiN9PN4E'; // «Учет заявок_ТЕНЕДЕРов_v1»
const SHEET_NAME = 'Тендеры';

// Работает и если скрипт открыт из таблицы, и если создан отдельным проектом
function book() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SPREADSHEET_ID);
}

// Колонки листа: ключ, заголовок, ширина (px), выравнивание
const COLS = [
  ['status', 'Статус', 110, 'center'],
  ['deadline', 'Срок подачи', 110, 'center'],
  ['left', 'Осталось', 115, 'center'],        // считается формулой: дни + время торгов
  ['customer', 'Заказчик', 220, 'left'],
  ['subject', 'Предмет закупки', 260, 'left'],
  ['type', 'Тип закупки', 120, 'center'],
  ['nmck', 'НМЦК, ₽', 115, 'right'],
  ['auctionDate', 'Торги / итоги', 105, 'center'],
  ['takenDate', 'Взяли в работу', 90, 'center'],
  ['comment', 'Комментарий', 220, 'left'],
  ['number', '№ закупки (ссылка)', 150, 'center'],
  ['updatedAt', 'Обновлено', 110, 'center'],
  ['id', 'ID', 60, 'left'], // служебная колонка (скрыта), по ней обновляются строки
  ['etp', 'Площадка (ЭТП)', 140, 'center'] // столбец N
];
// Заголовки прошлых версий листа — чтобы перенести данные при перестройке
const LEGACY_LABELS = { 'Номер': 'number', 'Ссылка': 'url', 'Предмет': 'subject' };

const STATUSES = ['Новый', 'В работе', 'Подано', 'Торги', 'Выиграли', 'Проиграли', 'Не состоялся', 'Опоздали', 'Отказ'];
// Цвет «плашки» статуса: фон, текст
const STATUS_STYLE = {
  'Новый': ['#d9ead3', '#1e5631'],
  'В работе': ['#cfe2f3', '#0b3d91'],
  'Подано': ['#fff2cc', '#7f6000'],
  'Торги': ['#fce5cd', '#a64d00'],
  'Выиграли': ['#34a853', '#ffffff'],
  'Проиграли': ['#f4cccc', '#990000'],
  'Не состоялся': ['#d9d2e9', '#4c2a85'],
  'Опоздали': ['#ead1dc', '#741b47'],
  'Отказ': ['#e8eaed', '#80868b']
};
// Шкала НМЦК: от (включительно), до (не включая; null — без верхней границы), фон, текст, жирный, подпись
const NMCK_TIERS = [
  [0, 100000, '#eceff1', '#90a4ae', false, 'до 100 тыс. — «мусорные»'],
  [100000, 300000, '#e3f2fd', '#0d47a1', false, '100–300 тыс.'],
  [300000, 700000, '#d0f0ec', '#00695c', false, '300–700 тыс.'],
  [700000, 1000000, '#fff2cc', '#7f6000', false, '700 тыс. – 1 млн'],
  [1000000, 1500000, '#fcd9b6', '#a64d00', true, '1–1,5 млн'],
  [1500000, 2000000, '#f4b6b6', '#8b0000', true, '1,5–2 млн'],
  [2000000, null, '#7e57c2', '#ffffff', true, 'свыше 2 млн']
];
const HEADER_BG = '#1f3864';
const MIN_ROW_HEIGHT = 54; // три строки «Осталось»: «сегодня!», пусто, «торги 11:35»

const col = key => COLS.findIndex(c => c[0] === key) + 1;
function letter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// В локалях с десятичной запятой (ru и др.) аргументы формул разделяются «;»
let commaLocaleCache = null;
function loc(f) {
  if (commaLocaleCache === null) {
    commaLocaleCache = /^(en|ja|ko|zh|th|he|iw|hi|ms|fil)/.test(book().getSpreadsheetLocale());
  }
  return commaLocaleCache ? f : f.replace(/,/g, ';');
}

// Запустите кнопкой «Выполнить»: выдаст доступы, создаст лист «Тендеры» и (пере)настроит его оформление
function setup() {
  setupSheet(getSheet());
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: 'Неверный формат запроса' });
  }
  if (req.token !== TOKEN) return out({ ok: false, error: 'Неверный ключ доступа' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet();
    if (req.action === 'ping') return out({ ok: true });
    if (req.action === 'upsert') {
      const res = (req.tenders || []).map(t => {
        const from = t.id;
        const r = upsert(sh, t);
        return { from, to: r.id, merged: r.merged };
      });
      // merged — записи, которые пришли с другим ID, но совпали по номеру закупки с уже существующей строкой
      return out({ ok: true, count: res.length, merged: res.filter(r => r.merged) });
    }
    if (req.action === 'find') {
      const row = findRowByNumber(sh, req.number);
      return out({ ok: true, found: row ? recordForClient(readRow(sh, row)) : null });
    }
    if (req.action === 'delete') {
      const row = findRow(sh, req.id);
      if (row) sh.deleteRow(row);
      return out({ ok: true });
    }
    return out({ ok: false, error: 'Неизвестное действие' });
  } finally {
    lock.releaseLock();
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  const ss = book();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    const first = ss.getSheets()[0];
    // пустой «Лист1» просто переименовываем
    sh = first.getLastRow() === 0 ? first.setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    setupSheet(sh);
    return sh;
  }
  // лист старого формата — перестраиваем с сохранением данных
  const head = sh.getRange(1, 1, 1, COLS.length).getValues()[0].join('|');
  if (head !== COLS.map(c => c[1]).join('|')) sh = rebuild();
  return sh;
}

// Перестроить лист под текущее оформление, сохранив все тендеры
function rebuild() {
  const ss = book();
  const old = ss.getSheetByName(SHEET_NAME);
  const records = old ? readRecords(old) : [];
  if (old) old.setName(SHEET_NAME + ' (старый)');
  const sh = ss.insertSheet(SHEET_NAME, 0);
  setupSheet(sh);
  records.forEach(t => upsert(sh, t));
  if (old) ss.deleteSheet(old);
  ss.setActiveSheet(sh);
  return sh;
}

// Прочитать тендеры с листа любого формата (по заголовкам колонок)
function readRecords(sh) {
  const last = sh.getLastRow(), width = sh.getLastColumn();
  if (last < 2) return [];
  const labelToKey = Object.assign({}, LEGACY_LABELS);
  COLS.forEach(([k, label]) => { labelToKey[label] = k; });
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  const range = sh.getRange(2, 1, last - 1, width);
  const values = range.getValues();
  const rich = range.getRichTextValues();
  const tz = book().getSpreadsheetTimeZone();
  const fmt = (d, withTime) => Utilities.formatDate(d, tz, withTime ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd');

  return values.map((row, r) => {
    const t = {};
    head.forEach((label, i) => {
      const k = labelToKey[label];
      if (!k || k === 'left') return;
      const link = rich[r][i] && rich[r][i].getLinkUrl();
      if (link && (k === 'url' || k === 'number')) t.url = link;
      if (k === 'url') return;
      const v = row[i];
      if (v instanceof Date) {
        t[k] = k === 'updatedAt' ? v.toISOString() : fmt(v, k === 'deadline' || (k === 'auctionDate' && hasTime(v)));
      } else {
        t[k] = v === '' || v == null ? '' : String(v);
      }
    });
    if (t.number === 'открыть') t.number = '';
    return t;
  }).filter(t => t.id);
}

// Оформление листа: шапка, ширины, выравнивание, форматы, статусы-плашки, подсветка сроков, фильтр
function setupSheet(sh) {
  const n = COLS.length;
  const rows = sh.getMaxRows() - 1;

  sh.getRange(1, 1, 1, n).setValues([COLS.map(c => c[1])])
    .setBackground(HEADER_BG).setFontColor('#ffffff').setFontWeight('bold').setFontSize(10)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 44);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setHiddenGridlines(true);
  sh.setTabColor(HEADER_BG);

  const body = sh.getRange(2, 1, rows, n);
  body.setFontSize(10).setFontColor('#202124').setVerticalAlignment('middle').setWrap(true)
    .setBorder(null, null, true, null, null, true, '#dfe3e8', SpreadsheetApp.BorderStyle.SOLID);
  COLS.forEach(([, , width, align], i) => {
    sh.setColumnWidth(i + 1, width);
    sh.getRange(2, i + 1, rows).setHorizontalAlignment(align);
  });

  sh.getRange(2, col('customer'), rows).setFontWeight('bold');
  sh.getRange(2, col('status'), rows).setFontWeight('bold');
  sh.getRange(2, col('nmck'), rows).setNumberFormat('#,##0.00');
  sh.getRange(2, col('deadline'), rows).setNumberFormat('dd.MM.yyyy HH:mm');
  sh.getRange(2, col('left'), rows).setNumberFormat('@').setFontWeight('bold');
  sh.getRange(2, col('auctionDate'), rows).setNumberFormat('dd.MM.yyyy');
  // уже заполненные строки: новая формула «Осталось», у торгов со временем показываем и время
  for (let r = 2; r <= sh.getLastRow(); r++) {
    setFormulaSafe(sh.getRange(r, col('left')), leftFormula(r));
    setAuctionFormat(sh, r);
  }
  sh.getRange(2, col('takenDate'), rows).setNumberFormat('dd.MM.yyyy');
  sh.getRange(2, col('updatedAt'), rows).setNumberFormat('dd.MM.yy HH:mm').setFontSize(8).setFontColor('#80868b');
  sh.getRange(2, col('number'), rows).setNumberFormat('@') // номер — текст, чтобы не терялись нули
    .setFontColor('#1a73e8');                             // и выглядит как ссылка
  // выпадающий список статусов ставится только в заполненные строки (см. upsert), чтобы пустые не пестрели стрелками
  sh.getRange(2, col('status'), rows).clearDataValidations();
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, col('status'), sh.getLastRow() - 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
  }

  // чередование строк
  sh.getBandings().forEach(b => b.remove());
  body.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
    .setFirstRowColor('#ffffff').setSecondRowColor('#f6f8fb');

  // фильтр/сортировка по шапке
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, sh.getMaxRows(), n).createFilter();

  sh.setConditionalFormatRules(buildRules(sh, rows));
  sh.getRange(1, col('nmck')).setNote('Цвет суммы:\n' + NMCK_TIERS.map(t => '• ' + t[5]).join('\n'));
  sh.hideColumns(col('id'));
}

// Правила подсветки. Для ячейки срабатывает первое подходящее правило, поэтому порядок важен.
function buildRules(sh, rows) {
  const S = `$${letter(col('status'))}2`;
  const D = `$${letter(col('deadline'))}2`;
  const A = `$${letter(col('auctionDate'))}2`;
  const active = `OR(${S}="Новый",${S}="В работе")`;
  const sent = `OR(${S}="Подано",${S}="Торги")`;
  // дней до ближайшего важного срока — то же число, что в «Осталось» (там теперь текст)
  const C = `IF(${active},IF(${D}="","",INT(${D})-TODAY()),IF(${sent},IF(${A}="","",INT(${A})-TODAY()),""))`;
  // просрочено: срок подачи прошёл (с точностью до времени) или дата торгов уже позади
  const over = `OR(AND(${active},${D}<>"",${D}<NOW()),AND(${sent},${A}<>"",INT(${A})<TODAY()))`;

  const rules = [];
  const add = (range, formula, bg, color, bold) => {
    let b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(loc(formula))
      .setFontColor(color).setRanges([range]);
    if (bg) b = b.setBackground(bg);
    if (bold) b = b.setBold(true);
    rules.push(b.build());
  };

  // 1. Статус — цветная плашка
  const statusRange = sh.getRange(2, col('status'), rows);
  Object.keys(STATUS_STYLE).forEach(st => {
    const [bg, color] = STATUS_STYLE[st];
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(st)
      .setBackground(bg).setFontColor(color).setBold(true).setRanges([statusRange]).build());
  });

  // 2. Сроки: просрочено / ≤ 3 дней / ≤ 7 дней / есть время — по тому же числу дней, что в «Осталось»,
  //    чтобы цвет всегда совпадал с цифрой. Дата подачи красится до подачи, дата торгов — после.
  const urgency = (range, guard) => {
    const g = guard ? `${guard},` : '';
    add(range, `=AND(${g}${over})`, '#e06666', '#ffffff', true);
    add(range, `=AND(${g}${C}<>"",${C}<=3)`, '#f4cccc', '#990000', true);
    add(range, `=AND(${g}${C}<>"",${C}<=7)`, '#fff2cc', '#7f6000', false);
    add(range, `=AND(${g}${C}<>"")`, '#d9ead3', '#1e5631', false);
  };
  urgency(sh.getRange(2, col('left'), rows), '');
  urgency(sh.getRange(2, col('deadline'), rows), active);
  urgency(sh.getRange(2, col('auctionDate'), rows), sent);

  // 3. Дубли: номер закупки встречается в таблице больше одного раза — оранжевый
  const K = `$${letter(col('number'))}2`;
  const KK = `$${letter(col('number'))}$2:$${letter(col('number'))}`;
  add(sh.getRange(2, col('number'), rows), `=AND(${K}<>"",COUNTIF(${KK},${K})>1)`, '#ffd8a8', '#7a3e00', true);

  // 4. Завершённые тендеры — вся строка бледная
  add(sh.getRange(2, 1, rows, COLS.length), `=OR(${S}="Выиграли",${S}="Проиграли",${S}="Не состоялся",${S}="Опоздали",${S}="Отказ")`,
    null, '#9aa0a6', false);

  // 5. Шкала НМЦК: чем крупнее тендер, тем «теплее» цвет (у завершённых не красится — сработало правило 4)
  const nmckRange = sh.getRange(2, col('nmck'), rows);
  NMCK_TIERS.forEach(([from, to, bg, color, bold]) => {
    let b = SpreadsheetApp.newConditionalFormatRule().setBackground(bg).setFontColor(color).setRanges([nmckRange]);
    b = to === null ? b.whenNumberGreaterThanOrEqualTo(from) : b.whenNumberBetween(from, to - 0.01);
    if (bold) b = b.setBold(true);
    rules.push(b.build());
  });
  return rules;
}

function findRow(sh, id) {
  if (!id || sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, col('id'), sh.getLastRow() - 1).getValues();
  const i = ids.findIndex(r => r[0] === id);
  return i < 0 ? 0 : i + 2;
}

// ---------- дубли ----------

const normNum = s => String(s || '').replace(/\D/g, '');

// Строка с тем же номером закупки (номер сравнивается только по цифрам)
function findRowByNumber(sh, number) {
  const n = normNum(number);
  if (n.length < 6 || sh.getLastRow() < 2) return 0;
  const nums = sh.getRange(2, col('number'), sh.getLastRow() - 1).getDisplayValues();
  const i = nums.findIndex(r => normNum(r[0]) === n);
  return i < 0 ? 0 : i + 2;
}

// Строка листа → запись (ключи COLS, ссылка — из номера закупки)
function readRow(sh, row) {
  const range = sh.getRange(row, 1, 1, COLS.length);
  const v = range.getValues()[0];
  const link = range.getRichTextValues()[0][col('number') - 1];
  const t = {};
  COLS.forEach(([k], i) => { if (k !== 'left') t[k] = v[i]; });
  const url = link && link.getLinkUrl();
  if (url) t.url = url;
  if (t.number === 'открыть') t.number = '';
  return t;
}

// Запись для расширения: даты — в формате полей формы
function recordForClient(t) {
  const tz = book().getSpreadsheetTimeZone();
  const f = (d, p) => d instanceof Date ? Utilities.formatDate(d, tz, p) : (d || '');
  return Object.assign({}, t, {
    takenDate: f(t.takenDate, 'yyyy-MM-dd'),
    deadline: f(t.deadline, "yyyy-MM-dd'T'HH:mm"),
    auctionDate: f(t.auctionDate, t.auctionDate instanceof Date && hasTime(t.auctionDate) ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd'),
    updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : (t.updatedAt || ''),
    nmck: t.nmck === '' || t.nmck == null ? '' : String(t.nmck)
  });
}

// Склеить уже существующие дубли (запускать вручную кнопкой «Выполнить»):
// остаётся самая свежая строка, пустые поля в ней дозаполняются из остальных, лишние строки удаляются
function dedupe() {
  const sh = getSheet();
  const last = sh.getLastRow();
  if (last < 3) return 'Дублей нет';
  const nums = sh.getRange(2, col('number'), last - 1).getDisplayValues();
  const groups = {};
  nums.forEach((r, i) => { const n = normNum(r[0]); if (n.length >= 6) (groups[n] = groups[n] || []).push(i + 2); });
  const toDelete = [];
  Object.values(groups).filter(rows => rows.length > 1).forEach(rows => {
    const recs = rows.map(r => ({ row: r, t: readRow(sh, r) }))
      .sort((a, b) => (b.t.updatedAt instanceof Date ? b.t.updatedAt : 0) - (a.t.updatedAt instanceof Date ? a.t.updatedAt : 0));
    const keep = recs[0].t;
    recs.slice(1).forEach(({ t }) => {
      Object.keys(t).forEach(k => { if ((keep[k] === '' || keep[k] == null) && t[k] !== '' && t[k] != null) keep[k] = t[k]; });
    });
    upsert(sh, keep);
    recs.slice(1).forEach(({ row }) => toDelete.push(row));
  });
  toDelete.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  const msg = toDelete.length ? 'Удалено дублей: ' + toDelete.length : 'Дублей нет';
  Logger.log(msg);
  return msg;
}

// "2026-10-21T10:00" / "2026-10-21" (местное время) → дата в часовом поясе таблицы;
// "…Z" (момент времени UTC, напр. updatedAt) → как есть
function toDate(v) {
  if (!v) return '';
  if (v instanceof Date) return v;
  const s = String(v);
  if (/Z$|[+-]\d\d:\d\d$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m) return s;
  const tz = book().getSpreadsheetTimeZone();
  return Utilities.parseDate(`${m[1]} ${m[2] || '00:00'}`, tz, 'yyyy-MM-dd HH:mm');
}

// У даты торгов указано время (не ровно полночь)
function hasTime(d) {
  return Utilities.formatDate(d, book().getSpreadsheetTimeZone(), 'HH:mm') !== '00:00';
}

// Дата торгов со временем — «дд.мм.гггг чч:мм», без времени — только дата
function setAuctionFormat(sh, row, v) {
  const cell = sh.getRange(row, col('auctionDate'));
  if (v === undefined) v = cell.getValue();
  cell.setNumberFormat(v instanceof Date && hasTime(v) ? 'dd.MM.yyyy HH:mm' : 'dd.MM.yyyy');
}

// Формула «Осталось» для строки. Первая строка — дни: до подачи — до срока подачи, после — до даты торгов
// («просрочено» / «сегодня!» / «N дн.»). Через пустую строку — начало торгов: «торги 11:35»
// (если торги не сегодня — «торги 23.10 11:35»), пока тендер не завершён и торги не прошли.
function leftFormula(row) {
  const S = `${letter(col('status'))}${row}`;
  const D = `${letter(col('deadline'))}${row}`;
  const A = `${letter(col('auctionDate'))}${row}`;
  const active = `OR(${S}="Новый",${S}="В работе")`;
  const sent = `OR(${S}="Подано",${S}="Торги")`;
  const word = n => `IF(${n}<0,"просрочено",IF(${n}=0,"сегодня!",${n}&" дн."))`;
  const days = `IF(${active},IF(${D}="","",${word(`(INT(${D})-TODAY())`)}),` +
    `IF(${sent},IF(${A}="","",${word(`(INT(${A})-TODAY())`)}),""))`;
  const when = `TRIM(IF(INT(${A})=TODAY(),"",TEXT(${A},"dd.MM"))&" "&IF(MOD(${A},1)=0,"",TEXT(${A},"HH:mm")))`;
  const auction = `IF(OR(${A}="",NOT(OR(${active},${sent}))),"",IF(INT(${A})<TODAY(),"",IF(${when}="","","торги "&${when})))`;
  return `=IF(${auction}="",${days},IF(${days}="",${auction},${days}&CHAR(10)&CHAR(10)&${auction}))`;
}

// Формула с запятыми; если таблица её не поняла (локаль с «;») — пробуем вариант с «;»
function setFormulaSafe(range, f) {
  const variants = [f, f.replace(/,/g, ';')];
  for (const v of variants) {
    try {
      range.setFormula(v);
      SpreadsheetApp.flush();
      if (!/^#(ERROR|NAME)/.test(range.getDisplayValue())) return;
    } catch (e) { /* пробуем следующий вариант */ }
  }
}

// Добавить или обновить тендер. Ищется по ID, а если такого ID нет — по номеру закупки,
// чтобы один тендер из разных браузеров не превращался в две строки.
function upsert(sh, t) {
  let existing = findRow(sh, t.id);
  let merged = false;
  if (!existing) {
    existing = findRowByNumber(sh, t.number);
    merged = !!existing;
  }
  if (existing) {
    // пустые поля не затирают уже заполненные (старые записи без площадки, другой браузер и т.п.)
    const old = readRow(sh, existing);
    // Google-таблица — источник статуса существующей закупки.
    // Старые копии браузеров не должны возвращать ручной «Отказ» в «Новый».
    if (old.status !== '' && old.status != null) t.status = old.status;
    COLS.forEach(([k]) => {
      if (k !== 'left' && (t[k] === '' || t[k] == null) && old[k] !== '' && old[k] != null) t[k] = old[k];
    });
    if (!t.url && old.url) t.url = old.url;
    if (old.number && normNum(old.number) === normNum(t.number)) t.number = old.number; // номер в прежнем виде
    if (merged && old.id) t.id = old.id; // строка сохраняет свой ID
  }
  const values = COLS.map(([k]) => {
    const v = t[k];
    if (k === 'left') return '';
    if (k === 'nmck') return v === '' || v == null || isNaN(Number(v)) ? (v || '') : Number(v);
    if (['takenDate', 'deadline', 'auctionDate', 'updatedAt'].includes(k)) return toDate(v);
    return v == null ? '' : v;
  });
  const row = existing || sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, COLS.length).setValues([values]);
  setFormulaSafe(sh.getRange(row, col('left')), leftFormula(row));
  setAuctionFormat(sh, row, values[col('auctionDate') - 1]);
  sh.getRange(row, col('status')).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
  // номер закупки — ссылка на страницу тендера
  if (t.url) {
    sh.getRange(row, col('number')).setRichTextValue(
      SpreadsheetApp.newRichTextValue().setText(t.number || 'открыть').setLinkUrl(String(t.url)).build());
  }
  // высота строки — по содержимому, но не ниже MIN_ROW_HEIGHT
  SpreadsheetApp.flush();
  sh.autoResizeRows(row, 1);
  if (sh.getRowHeight(row) < MIN_ROW_HEIGHT) sh.setRowHeight(row, MIN_ROW_HEIGHT);
  // «Не состоялся» — тендер попадает на лист «Не состоялись» (failed-tenders.gs)
  if (typeof failedTrack === 'function') failedTrack(t);
  return { id: t.id, merged };
}
