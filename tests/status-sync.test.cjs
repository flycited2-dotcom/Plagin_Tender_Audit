const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../google-apps-script.gs'), 'utf8');
function run({oldStatus, incomingStatus, existing = true, otherBrowser = false, number = '0348100015526000593'}) {
  let written;
  const chain = new Proxy({}, {get: (_, key) => key === 'build' ? () => ({}) : () => chain});
  const range = {
    getValue: () => oldStatus,
    setValues: values => { written = values[0]; },
    setDataValidation: () => {},
    setNumberFormat: () => {},
    setRichTextValue: () => {},
  };
  const sh = {
    getLastRow: () => existing ? 2 : 1,
    getRange: (row, column, height, width) => ({
      ...range,
      getValues: () => width === 14
        ? [[oldStatus, '', '', '', '', '', '', '', '', '', number, '', 'existing-id', 'РТС-тендер']]
        : existing ? [['existing-id']] : [],
      getDisplayValues: () => existing ? [[number]] : [],
      getRichTextValues: () => [Array(14).fill(null)],
    }),
    autoResizeRows: () => {},
    getRowHeight: () => 48,
    setRowHeight: () => {},
  };
  const context = vm.createContext({
    SpreadsheetApp: {newDataValidation: () => chain, flush: () => {}},
  });
  vm.runInContext(source, context);
  context.setFormulaSafe = () => {};
  context.toDate = value => value || '';
  context.upsert(sh, {
    id: otherBrowser ? 'another-browser-id' : 'existing-id', status: incomingStatus, number,
    subject: 'Updated description', etp: 'РТС-тендер',
  });
  assert.equal(written[0], existing && oldStatus ? oldStatus : incomingStatus);
  assert.equal(written[4], 'Updated description');
  assert.equal(written[10], number);
  if (existing) assert.equal(written[12], 'existing-id');
}

for (const status of ['Отказ', 'В работе', 'Подано', 'Торги', 'Выиграли', 'Проиграли']) {
  run({oldStatus: status, incomingStatus: 'Новый'});
}
run({oldStatus: 'Отказ', incomingStatus: 'В работе'});
run({oldStatus: '', incomingStatus: 'В работе'});
run({incomingStatus: 'Новый', existing: false});
run({incomingStatus: 'Отказ', existing: false});
run({oldStatus: 'Отказ', incomingStatus: 'Новый', otherBrowser: true});
run({oldStatus: 'Подано', incomingStatus: 'Новый', otherBrowser: true});
console.log('PASS: 12 status synchronization cases, including another browser ID; other fields still update');
