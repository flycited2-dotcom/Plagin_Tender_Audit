// Лист «Не состоялись»: перенос тендера, сохранение ручных отметок, дата проверки по действию, напоминание.
// Запуск: node tests/failed-tenders.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Упрощённый лист Google Таблиц: ячейки в Map, ссылки — отдельно
function fakeSheet(name) {
  const cells = new Map(), links = new Map();
  const key = (r, c) => r + ':' + c;
  const sh = {
    name, cells, links,
    getName: () => name,
    getSheetId: () => 42,
    getLastRow: () => Math.max(1, ...[...cells.keys()].map(k => Number(k.split(':')[0]))),
    getMaxRows: () => 1000,
    getRange(row, column, height = 1, width = 1) {
      const all = f => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => f(row + i, column + j)));
      const get = (r, c) => cells.has(key(r, c)) ? cells.get(key(r, c)) : '';
      return {
        getSheet: () => sh,
        getRow: () => row, getColumn: () => column, getNumRows: () => height, getNumColumns: () => width,
        getValue: () => get(row, column),
        setValue: v => { if (v === '') cells.delete(key(row, column)); else cells.set(key(row, column), v); },
        getValues: () => all(get),
        getDisplayValues: () => all((r, c) => String(get(r, c))),
        setRichTextValue: v => { cells.set(key(row, column), v.text); links.set(key(row, column), v.url); },
        getRichTextValues: () => all((r, c) => ({ getLinkUrl: () => links.get(key(r, c)) || null })),
        setDataValidation: () => {}
      };
    }
  };
  return sh;
}

const TODAY = new Date(2026, 9, 21); // 21.10.2026, среда
const failed = fakeSheet('Не состоялись');
const main = fakeSheet('Тендеры');
const chain = new Proxy({}, { get: (_, k) => k === 'build' ? () => ({}) : () => chain });
const rich = { text: '', url: '' };
const richBuilder = {
  setText(t) { rich.text = t; return richBuilder; },
  setLinkUrl(u) { rich.url = u; return richBuilder; },
  build: () => ({ ...rich })
};
const context = vm.createContext({
  SpreadsheetApp: { newDataValidation: () => chain, newRichTextValue: () => richBuilder },
  Utilities: {
    formatDate: (d, tz, p) => p === 'u' ? String(d.getDay() || 7)
      : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`,
    parseDate: () => new Date(TODAY)
  },
  // из google-apps-script.gs и telegram-reminders.gs
  SHEET_NAME: 'Тендеры',
  HEADER_BG: '#1f3864',
  COLS: [['status'], ['customer'], ['subject'], ['nmck'], ['etp'], ['number'], ['id']],
  normNum: s => String(s || '').replace(/\D/g, ''),
  tgEsc: s => String(s),
  tgShort: s => String(s),
  tgMoney: v => v + ' ₽',
  book: () => ({ getSheetByName: n => n === 'Не состоялись' ? failed : main, getSpreadsheetTimeZone: () => 'Europe/Moscow', getUrl: () => 'https://sheet' })
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../failed-tenders.gs'), 'utf8'), context);
vm.runInContext(`
  col = k => COLS.findIndex(c => c[0] === k) + 1;
  readRow = (sh, r) => { const t = {}; COLS.forEach(([k], i) => { t[k] = sh.getRange(r, i + 1).getValue(); }); return t; };
  failedSheet = () => book().getSheetByName(FAILED_SHEET);
`, context);
const f = vm.runInContext('fcol', context); // const из файла не попадают в свойства контекста
const cell = (r, k) => failed.getRange(r, f(k)).getValue();
// дата из vm — из другого «мира», instanceof Date для неё ложно
const day = d => Object.prototype.toString.call(d) === '[object Date]'
  ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}` : d;

// 1. Другой статус — на лист не попадает
assert.equal(context.failedTrack({ status: 'Отказ', id: 'a', number: '0375300090926000001' }), false);
assert.equal(failed.getLastRow(), 1);

// 2. «Не состоялся» — новая строка: дата сегодня, «Решить», проверить завтра, данные и ссылка
const t = { status: 'Не состоялся', id: 'a', number: '0375300090926000001', customer: 'Детский сад', subject: 'Генератор',
  nmck: '706492.8', etp: 'Росэлторг', url: 'https://gos.roseltorg.ru/#lotinfo/1' };
assert.equal(context.failedTrack(t), true);
assert.equal(day(cell(2, 'failedAt')), '21.10');
assert.equal(cell(2, 'action'), 'Решить');
assert.equal(day(cell(2, 'nextCheck')), '22.10');
assert.equal(cell(2, 'nmck'), 706492.8);
assert.equal(cell(2, 'number'), '0375300090926000001');
assert.equal(failed.links.get(`2:${f('number')}`), 'https://gos.roseltorg.ru/#lotinfo/1');

// 3. Повторно (другой браузер, другой ID, тот же номер) — новая строка не появляется,
//    ручные отметки сохраняются, данные обновляются, пустое не затирает
failed.getRange(2, f('action')).setValue('Мониторим');
failed.getRange(2, f('note')).setValue('звонили, обещали повторить');
assert.equal(context.failedTrack({ ...t, id: 'b', subject: 'Установка электрогенераторная', customer: '' }), false);
assert.equal(failed.getLastRow(), 2);
assert.equal(cell(2, 'action'), 'Мониторим');
assert.equal(cell(2, 'note'), 'звонили, обещали повторить');
assert.equal(cell(2, 'subject'), 'Установка электрогенераторная');
assert.equal(cell(2, 'customer'), 'Детский сад');

// 4. Выбрали действие на листе — дата проверки ставится сама; «Закрыто» — дата пустая
const edit = (sh, row, column) => context.onEdit({ range: sh.getRange(row, column) });
for (const [action, expected] of [['Мониторим', '24.10'], ['Написали, ждём ответ', '24.10'],
  ['Написать заказчику', '21.10'], ['Решить', '22.10'], ['Закрыто', '']]) {
  failed.getRange(2, f('action')).setValue(action);
  edit(failed, 2, f('action'));
  assert.equal(day(cell(2, 'nextCheck')), expected, action);
}

// 5. Ручная смена статуса на листе «Тендеры» — тендер переносится; другой статус — нет
const row = (r, v) => context.COLS.forEach(([k], i) => main.getRange(r, i + 1).setValue(v[k] || ''));
row(2, { status: 'Не состоялся', id: 'c', number: '0875300029426000293', customer: 'Департамент', subject: 'Конверты', nmck: 1800000 });
row(3, { status: 'Проиграли', id: 'd', number: '0274100000226000110', customer: 'СФР' });
edit(main, 2, context.col('status'));
edit(main, 3, context.col('status'));
assert.equal(failed.getLastRow(), 3);
assert.equal(cell(3, 'customer'), 'Департамент');
assert.equal(cell(3, 'action'), 'Решить');

// 6. Напоминание: только незакрытые со сроком сегодня или раньше, самые давние первыми
// даты как в Apps Script: созданы в том же «мире», что и код листа
const D = vm.runInContext('(...a) => new Date(...a)', context);
const rows = [
  { customer: 'Закрытый', action: 'Закрыто', nextCheck: D(2026, 9, 1) },
  { customer: 'Завтрашний', action: 'Мониторим', nextCheck: D(2026, 9, 22) },
  { customer: 'Сегодняшний', action: 'Написать заказчику', nextCheck: D(2026, 9, 21) },
  { customer: 'Давний', action: 'Решить', nextCheck: D(2026, 9, 18), number: '1', url: 'https://x' },
  { customer: 'Без даты', action: 'Мониторим', nextCheck: '' }
];
const now = D(2026, 9, 21, 9, 30);
assert.deepEqual(context.failedDue(rows, now).map(t => t.customer), ['Давний', 'Сегодняшний']);
const text = context.failedReminderText(rows, now);
assert.match(text, /пора проверить \(2\)/);
assert.ok(text.indexOf('Давний') < text.indexOf('Сегодняшний'));
assert.doesNotMatch(text, /Закрытый|Завтрашний|Без даты/);
assert.match(text, /напишите заказчику/);
assert.equal(context.failedReminderText(rows.slice(0, 2), now), '');

console.log('PASS: лист «Не состоялись» — перенос, ручные отметки, даты проверки, напоминание');
