// Счётчик на иконке: сколько тендеров со сроком ≤ 3 дней или уже просроченных
try { importScripts('config.js'); } catch (e) { /* личных настроек нет — берутся из «Все тендеры → Google Таблица» */ }
importScripts('common.js');

async function updateBadge() {
  const tenders = await loadTenders();
  const n = tenders.filter(t => ['red', 'overdue'].includes(urgency(t))).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

function ensureAlarm() {
  chrome.alarms.create('badge', { periodInMinutes: 30 });
}

// после установки/обновления сразу отправляем в таблицу всё, что уже сохранено
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); updateBadge(); syncAll(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); });
// по таймеру ещё и досылаем в Google Таблицу то, что не ушло сразу (нет интернета и т.п.)
chrome.alarms.onAlarm.addListener(async () => {
  await updateBadge();
  await syncAll();
});
chrome.storage.onChanged.addListener(updateBadge);
