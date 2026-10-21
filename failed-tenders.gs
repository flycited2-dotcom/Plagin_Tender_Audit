// Лист «Не состоялись»: несостоявшиеся закупки, к которым стоит вернуться — написать заказчику
// (предложить провести запрос цен) или следить, не объявят ли закупку повторно.
// Третий файл того же проекта Apps Script: использует COLS, col(), getSheet(), readRow(), normNum(),
// SHEET_NAME, HEADER_BG из google-apps-script.gs и tgSend(), tgEsc(), tgShort(), tgMoney() из telegram-reminders.gs.
//
// Как работает:
//   • ставите тендеру статус «Не состоялся» (в таблице или в расширении) — он сам появляется на листе
//     «Не состоялись» с датой и действием «Решить»;
//   • в столбце «Что делаем» выбираете действие — дата «Проверить» ставится сама (её можно поправить);
//   • по будням в FAILED_HOUR в Telegram приходит список тех, кого пора проверить; «Закрыто» — больше не напоминаем.
//
// Настройка (один раз): выполнить failedSetup — создаст лист, перенесёт уже несостоявшиеся тендеры
// и включит ежедневное напоминание (Telegram должен быть подключён через tgSetup).

const FAILED_SHEET = 'Не состоялись';
const FAILED_STATUS = 'Не состоялся';
const FAILED_HOUR = 9; // напоминание по будням, в этом часу (часовой пояс таблицы)
// действие → через сколько дней проверить снова (null — больше не напоминать)
const FAILED_ACTIONS = {
  'Решить': 1,
  'Написать заказчику': 0,
  'Написали, ждём ответ': 3,
  'Мониторим': 3,
  'Объявили повторно': 0,
  'Закрыто': null
};
const FAILED_ACTION_STYLE = {
  'Решить': ['#fff2cc', '#7f6000'],
  'Написать заказчику': ['#f4cccc', '#990000'],
  'Написали, ждём ответ': ['#cfe2f3', '#0b3d91'],
  'Мониторим': ['#d9d2e9', '#4c2a85'],
  'Объявили повторно': ['#34a853', '#ffffff'],
  'Закрыто': ['#e8eaed', '#80868b']
};
// Колонки листа: ключ, заголовок, ширина (px), выравнивание
const FAILED_COLS = [
  ['failedAt', 'Не состоялся', 95, 'center'],
  ['action', 'Что делаем', 150, 'center'],
  ['nextCheck', 'Проверить', 95, 'center'],
  ['customer', 'Заказчик', 220, 'left'],
  ['subject', 'Предмет закупки', 260, 'left'],
  ['nmck', 'НМЦК, ₽', 115, 'right'],
  ['etp', 'Площадка (ЭТП)', 120, 'center'],
  ['number', '№ закупки (ссылка)', 150, 'center'],
  ['note', 'Комментарий: что написали, что ответили', 260, 'left'],
  ['id', 'ID', 60, 'left'] // ID строки на листе «Тендеры» (скрыт)
];
const fcol = k => FAILED_COLS.findIndex(c => c[0] === k) + 1;

// ---------- настройка ----------

function failedSetup() {
  const sh = failedSheet();
  let added = 0;
  tgReadTenders().filter(t => t.status === FAILED_STATUS).forEach(t => { if (failedTrack(t)) added++; });
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'failedTick').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('failedTick').timeBased().everyDays(1).atHour(FAILED_HOUR).create();
  const msg = `Лист «${FAILED_SHEET}» готов, перенесено тендеров: ${added}. Напоминание — по будням в ${FAILED_HOUR}:00.`;
  Logger.log(msg);
  return msg + ' Строк на листе: ' + Math.max(0, sh.getLastRow() - 1);
}

// Отключить ежедневное напоминание
function failedStop() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'failedTick').forEach(t => ScriptApp.deleteTrigger(t));
}

// Прислать напоминание прямо сейчас (для проверки): все незакрытые, даже если срок проверки ещё не наступил
function failedTestReminder() {
  const text = failedReminderText(failedReadRows(), new Date(2100, 0, 1));
  if (text) tgSend('🧪 <i>Тест напоминания</i>\n' + text); else Logger.log('На листе нет незакрытых тендеров');
}

// Лист «Не состоялись» (создаётся и оформляется при первом обращении)
function failedSheet() {
  const ss = book();
  let sh = ss.getSheetByName(FAILED_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(FAILED_SHEET);
  const n = FAILED_COLS.length;
  const rows = sh.getMaxRows() - 1;
  sh.getRange(1, 1, 1, n).setValues([FAILED_COLS.map(c => c[1])])
    .setBackground(HEADER_BG).setFontColor('#ffffff').setFontWeight('bold').setFontSize(10)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 44);
  sh.setFrozenRows(1);
  sh.setHiddenGridlines(true);
  sh.setTabColor('#674ea7');
  sh.getRange(2, 1, rows, n).setFontSize(10).setFontColor('#202124').setVerticalAlignment('middle').setWrap(true)
    .setBorder(null, null, true, null, null, true, '#dfe3e8', SpreadsheetApp.BorderStyle.SOLID);
  FAILED_COLS.forEach(([, , width, align], i) => {
    sh.setColumnWidth(i + 1, width);
    sh.getRange(2, i + 1, rows).setHorizontalAlignment(align);
  });
  sh.getRange(2, fcol('failedAt'), rows).setNumberFormat('dd.MM.yyyy');
  sh.getRange(2, fcol('nextCheck'), rows).setNumberFormat('dd.MM.yyyy').setFontWeight('bold');
  sh.getRange(2, fcol('action'), rows).setFontWeight('bold');
  sh.getRange(2, fcol('customer'), rows).setFontWeight('bold');
  sh.getRange(2, fcol('nmck'), rows).setNumberFormat('#,##0.00');
  sh.getRange(2, fcol('number'), rows).setNumberFormat('@').setFontColor('#1a73e8');

  const range = sh.getRange(2, 1, rows, n);
  const A = `$${failedLetter(fcol('action'))}2`;
  const C = `$${failedLetter(fcol('nextCheck'))}2`;
  const rules = [];
  const add = (r, f, bg, color, bold) => {
    let b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setRanges([r]);
    if (bg) b = b.setBackground(bg);
    if (color) b = b.setFontColor(color);
    if (bold) b = b.setBold(true);
    rules.push(b.build());
  };
  // «Закрыто» — вся строка бледная; срок проверки наступил — дата красная
  add(range, `=${A}="Закрыто"`, null, '#9aa0a6', false);
  add(sh.getRange(2, fcol('nextCheck'), rows), `=AND(${C}<>"",${C}<=TODAY())`, '#f4cccc', '#990000', true);
  Object.keys(FAILED_ACTION_STYLE).forEach(a => {
    const [bg, color] = FAILED_ACTION_STYLE[a];
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(a).setBackground(bg).setFontColor(color)
      .setRanges([sh.getRange(2, fcol('action'), rows)]).build());
  });
  sh.setConditionalFormatRules(rules);
  sh.getRange(1, 1, sh.getMaxRows(), n).createFilter();
  sh.getRange(1, fcol('action')).setNote('Выберите, что делаем, — дата «Проверить» поставится сама:\n' +
    Object.keys(FAILED_ACTIONS).map(a => '• ' + a + (FAILED_ACTIONS[a] === null ? ' — больше не напоминать'
      : FAILED_ACTIONS[a] === 0 ? ' — сегодня' : ` — через ${FAILED_ACTIONS[a]} дн.`)).join('\n'));
  sh.hideColumns(fcol('id'));
  return sh;
}

function failedLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// ---------- запись на лист ----------

// Тендер со статусом «Не состоялся» → строка на листе «Не состоялись».
// Новая строка: дата — сегодня, действие «Решить», проверить завтра. Если тендер уже есть —
// обновляются только его данные (заказчик, предмет, НМЦК…), а действие, дата проверки и комментарий не трогаются.
// Возвращает true, если строка добавлена.
function failedTrack(t) {
  if (!t || t.status !== FAILED_STATUS) return false;
  const sh = failedSheet();
  const row = failedFindRow(sh, t);
  const info = {
    customer: t.customer || '', subject: t.subject || '', etp: t.etp || '', id: t.id || '',
    nmck: t.nmck === '' || t.nmck == null || isNaN(Number(t.nmck)) ? (t.nmck || '') : Number(t.nmck)
  };
  const target = row || sh.getLastRow() + 1;
  if (!row) {
    const today = failedToday();
    sh.getRange(target, fcol('failedAt')).setValue(today);
    sh.getRange(target, fcol('action')).setValue('Решить');
    sh.getRange(target, fcol('nextCheck')).setValue(failedNextCheck('Решить', today));
  }
  Object.keys(info).forEach(k => {
    if (row && (info[k] === '' || info[k] == null)) return; // пустое не затирает заполненное
    sh.getRange(target, fcol(k)).setValue(info[k]);
  });
  const number = t.number ? String(t.number) : '';
  if (t.url) {
    sh.getRange(target, fcol('number')).setRichTextValue(
      SpreadsheetApp.newRichTextValue().setText(number || 'открыть').setLinkUrl(String(t.url)).build());
  } else if (number) {
    sh.getRange(target, fcol('number')).setValue(number);
  }
  sh.getRange(target, fcol('action')).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(FAILED_ACTIONS), true).build());
  return !row;
}

// Строка того же тендера: по ID, иначе по номеру закупки
function failedFindRow(sh, t) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, fcol('id'), last - 1).getValues().map(r => r[0]);
  let i = t.id ? ids.indexOf(t.id) : -1;
  if (i < 0 && normNum(t.number).length >= 6) {
    const nums = sh.getRange(2, fcol('number'), last - 1).getDisplayValues().map(r => normNum(r[0]));
    i = nums.indexOf(normNum(t.number));
  }
  return i < 0 ? 0 : i + 2;
}

// Дата следующей проверки для действия (пусто — не напоминать)
function failedNextCheck(action, today) {
  const days = FAILED_ACTIONS[action];
  if (days === null || days === undefined) return '';
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
}

function failedToday() {
  const tz = book().getSpreadsheetTimeZone();
  return Utilities.parseDate(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz, 'yyyy-MM-dd');
}

// ---------- правки вручную в таблице ----------

// Простой триггер Google Таблиц: срабатывает на каждую ручную правку
function onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  const name = sh.getName();
  const top = e.range.getRow(), rows = e.range.getNumRows();
  const left = e.range.getColumn(), right = left + e.range.getNumColumns() - 1;
  const has = c => c >= left && c <= right;

  // «Тендеры»: поставили статус «Не состоялся» — переносим тендер на лист «Не состоялись»
  if (name === SHEET_NAME && has(col('status'))) {
    for (let r = Math.max(top, 2); r < top + rows; r++) {
      if (sh.getRange(r, col('status')).getValue() === FAILED_STATUS) failedTrack(readRow(sh, r));
    }
  }
  // «Не состоялись»: выбрали действие — ставим дату следующей проверки
  if (name === FAILED_SHEET && has(fcol('action'))) {
    const today = failedToday();
    for (let r = Math.max(top, 2); r < top + rows; r++) {
      const action = sh.getRange(r, fcol('action')).getValue();
      if (action in FAILED_ACTIONS) sh.getRange(r, fcol('nextCheck')).setValue(failedNextCheck(action, today));
    }
  }
}

// ---------- ежедневное напоминание ----------

function failedTick() {
  const tz = book().getSpreadsheetTimeZone();
  const now = new Date();
  if (Number(Utilities.formatDate(now, tz, 'u')) > 5) return; // по выходным не беспокоим
  const text = failedReminderText(failedReadRows(), now);
  if (text) tgSend(text);
}

// Строки листа «Не состоялись» как объекты (+ ссылка из номера закупки)
function failedReadRows() {
  const sh = book().getSheetByName(FAILED_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const range = sh.getRange(2, 1, sh.getLastRow() - 1, FAILED_COLS.length);
  const rich = range.getRichTextValues();
  return range.getValues().map((v, r) => {
    const t = {};
    FAILED_COLS.forEach(([k], i) => { t[k] = v[i]; });
    const link = rich[r][fcol('number') - 1] && rich[r][fcol('number') - 1].getLinkUrl();
    if (link) t.url = link;
    if (t.number === 'открыть') t.number = '';
    return t;
  }).filter(t => t.customer || t.subject || t.number);
}

// Кого пора проверить: не «Закрыто» и дата проверки сегодня или раньше; самые давние — первыми
function failedDue(rows, now) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return rows
    .filter(t => t.action !== 'Закрыто' && t.nextCheck instanceof Date && t.nextCheck < end)
    .sort((a, b) => a.nextCheck - b.nextCheck);
}

// Текст напоминания; пустая строка — напоминать не о ком
function failedReminderText(rows, now) {
  const due = failedDue(rows, now);
  if (!due.length) return '';
  const tz = book().getSpreadsheetTimeZone();
  const sh = book().getSheetByName(FAILED_SHEET);
  const hint = {
    'Решить': 'решите: написать заказчику про запрос цен или мониторить',
    'Написать заказчику': 'напишите заказчику — предложите провести запрос цен',
    'Написали, ждём ответ': 'проверьте, ответил ли заказчик',
    'Мониторим': 'проверьте, не объявили ли закупку повторно',
    'Объявили повторно': 'посмотрите новую закупку и решите, участвуем ли'
  };
  const cards = due.map(t => {
    const lines = ['🏛 <b>' + tgEsc(tgShort(t.customer || 'Заказчик не указан', 160)) + '</b>'];
    if (t.subject) lines.push('📦 ' + tgEsc(tgShort(t.subject, 200)));
    if (Number(t.nmck)) lines.push('💰 НМЦК: <b>' + tgMoney(Number(t.nmck)) + '</b>' + (t.etp ? ' · ' + tgEsc(t.etp) : ''));
    else if (t.etp) lines.push('🏢 ' + tgEsc(t.etp));
    if (t.failedAt instanceof Date) lines.push('📅 Не состоялся: ' + Utilities.formatDate(t.failedAt, tz, 'dd.MM.yyyy'));
    lines.push('➡️ <b>' + tgEsc(t.action || 'Решить') + '</b> — ' + (hint[t.action] || hint['Решить']));
    if (t.url) lines.push('🔗 <a href="' + tgEsc(t.url) + '">' + (t.number ? '№ ' + tgEsc(t.number) : 'Открыть закупку') + '</a>');
    else if (t.number) lines.push('🔗 № ' + tgEsc(t.number));
    if (t.note) lines.push('💬 ' + tgEsc(tgShort(t.note, 200)));
    return lines.join('\n');
  });
  const link = sh ? book().getUrl() + '#gid=' + sh.getSheetId() : '';
  return `🔁 <b>Несостоявшиеся тендеры: пора проверить (${due.length})</b>\n\n` +
    cards.join('\n\n') +
    '\n\nОтметьте на листе ' + (link ? `<a href="${tgEsc(link)}">«${FAILED_SHEET}»</a>` : `«${FAILED_SHEET}»`) +
    ': что сделали, и выберите новое действие (дата проверки сдвинется сама) или «Закрыто».';
}
