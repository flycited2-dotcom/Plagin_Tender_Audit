// Напоминания о тендерах в Telegram. Второй файл того же проекта Apps Script (рядом с google-apps-script.gs):
// использует COLS, col() и getSheet() оттуда.
//
// Настройка (один раз):
//   1) Проект Apps Script → ⚙ «Настройки проекта» → «Свойства скрипта» → добавить TG_TOKEN = токен от @BotFather.
//   2) Добавить бота в рабочую группу и написать там /start@имя_бота.
//   3) Выполнить функцию tgSetup — найдёт группу, пришлёт тестовое сообщение и включит проверку раз в час.
//
// Что присылается (проверка раз в час, время — по часовому поясу таблицы):
//   • будни, с 9:00 — утренняя сводка: просрочено / сегодня / ≤3 дн / ≤7 дн / торги сегодня-завтра /
//     «обновите итог» / зависшие в «Новый»;
//   • понедельник, с 9:00 — итог недели;
//   • за 24 ч и за 3 ч до окончания подачи (статусы «Новый», «В работе») — отдельное срочное сообщение;
//   • торги/итоги: накануне с 9:00 и в день торгов с 8:00 (статусы «Подано», «Торги»).

const TG_DIGEST_HOUR = 9;      // утренняя сводка и итог недели — не раньше этого часа
const TG_AUCTION_DAY_HOUR = 8; // напоминание в день торгов — не раньше этого часа
const TG_STALE_DAYS = 2;       // «Новый» дольше стольких дней — считается зависшим
const TG_ACTIVE = ['Новый', 'В работе'];
const TG_SENT = ['Подано', 'Торги'];

// ---------- настройка ----------

function tgSetup() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TG_TOKEN');
  if (!token) throw new Error('Нет TG_TOKEN: «Настройки проекта» → «Свойства скрипта» → TG_TOKEN = токен от @BotFather');

  // ищем группу, где написали боту (последнее сообщение из группы)
  const res = JSON.parse(UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/getUpdates`, { muteHttpExceptions: true }).getContentText());
  if (!res.ok) throw new Error('Telegram не принял токен: ' + (res.description || 'ошибка'));
  const chats = res.result.map(u => (u.message || u.my_chat_member || u.channel_post || {}).chat).filter(Boolean);
  const group = chats.reverse().find(c => c.type === 'group' || c.type === 'supergroup');
  const chat = group || (props.getProperty('TG_CHAT') ? { id: props.getProperty('TG_CHAT'), title: '(сохранённый чат)' } : null);
  if (!chat) throw new Error('Бот не видит группу: добавьте его в группу и напишите там /start@имя_бота, затем запустите tgSetup ещё раз');
  props.setProperty('TG_CHAT', String(chat.id));

  // одна проверка в час; старые триггеры этой функции убираем
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'tgTick').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tgTick').timeBased().everyHours(1).create();

  tgSend('✅ <b>Напоминания о тендерах подключены</b>\n' +
    'Утренняя сводка по будням с 9:00, срочные — за 24 ч и за 3 ч до конца подачи, торги — накануне и в день торгов, ' +
    'итог недели — по понедельникам.');
  return 'Группа: ' + (chat.title || chat.id);
}

// Отключить напоминания
function tgStop() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'tgTick').forEach(t => ScriptApp.deleteTrigger(t));
}

// Прислать утреннюю сводку прямо сейчас (для проверки)
function tgTestDigest() {
  tgSend(tgDigestText(tgReadTenders(), new Date()));
}

// ---------- проверка раз в час ----------

function tgTick() {
  const props = PropertiesService.getScriptProperties();
  const tz = book().getSpreadsheetTimeZone();
  const now = new Date();
  const day = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const weekday = Number(Utilities.formatDate(now, tz, 'u')); // 1 = понедельник … 7 = воскресенье
  const tenders = tgReadTenders();

  const sent = JSON.parse(props.getProperty('TG_SENT_KEYS') || '{}'); // что уже отправляли (ключ → дата)
  const once = (key, text) => { if (!sent[key]) { tgSend(text); sent[key] = day; } };

  // утренняя сводка (будни) и итог недели (понедельник)
  if (weekday <= 5 && hour >= TG_DIGEST_HOUR) once('digest:' + day, tgDigestText(tenders, now));
  if (weekday === 1 && hour >= TG_DIGEST_HOUR) once('weekly:' + day, tgWeeklyText(tenders, now));

  tenders.forEach(t => {
    // срочно: скоро конец подачи
    if (TG_ACTIVE.includes(t.status) && t.deadline instanceof Date) {
      const h = (t.deadline - now) / 3600000;
      const k = t.id + ':' + t.deadline.getTime();
      if (h > 0 && h <= 3) {
        sent['24:' + k] = sent['24:' + k] || day; // если 3-часовое, 24-часовое уже не нужно
        once('3:' + k, `🔥 <b>Через ${tgHours(h)} конец подачи заявки</b>\n\n${tgCard(t, tz, now)}`);
      } else if (h > 3 && h <= 24) {
        once('24:' + k, `⏰ <b>Меньше суток до конца подачи</b> (${tgFmt(t.deadline, tz, true)})\n\n${tgCard(t, tz, now)}`);
      }
    }
    // торги / подведение итогов
    if (TG_SENT.includes(t.status) && t.auctionDate instanceof Date) {
      const d = Utilities.formatDate(t.auctionDate, tz, 'yyyy-MM-dd');
      const tomorrow = Utilities.formatDate(new Date(now.getTime() + 86400000), tz, 'yyyy-MM-dd');
      if (d === tomorrow && hour >= TG_DIGEST_HOUR) once('auc-1:' + t.id + ':' + d, `🏁 <b>Завтра торги / итоги</b>\n\n${tgCard(t, tz, now)}`);
      if (d === day && hour >= TG_AUCTION_DAY_HOUR) once('auc-0:' + t.id + ':' + d, `🏁 <b>Сегодня торги / итоги</b>\n\n${tgCard(t, tz, now)}`);
    }
  });

  // чистим старые отметки (старше 14 дней)
  const limit = Utilities.formatDate(new Date(now.getTime() - 14 * 86400000), tz, 'yyyy-MM-dd');
  Object.keys(sent).forEach(k => { if (sent[k] < limit) delete sent[k]; });
  props.setProperty('TG_SENT_KEYS', JSON.stringify(sent));
}

// ---------- тексты ----------

function tgDigestText(tenders, now) {
  const tz = book().getSpreadsheetTimeZone();
  const today = tgDayStart(now, tz);
  const daysTo = d => Math.round((tgDayStart(d, tz) - today) / 86400000);
  const sec = { over: [], today: [], d3: [], d7: [], auction: [], result: [], stale: [] };

  tenders.forEach(t => {
    if (TG_ACTIVE.includes(t.status) && t.deadline instanceof Date) {
      const n = daysTo(t.deadline);
      if (t.deadline < now) sec.over.push(t);
      else if (n === 0) sec.today.push(t);
      else if (n <= 3) sec.d3.push(t);
      else if (n <= 7) sec.d7.push(t);
    }
    if (TG_SENT.includes(t.status) && t.auctionDate instanceof Date) {
      const n = daysTo(t.auctionDate);
      if (n < 0) sec.result.push(t);
      else if (n <= 1) sec.auction.push(t);
    }
    if (t.status === 'Новый' && t.takenDate instanceof Date && daysTo(t.takenDate) <= -TG_STALE_DAYS) sec.stale.push(t);
  });

  const count = st => tenders.filter(t => t.status === st).length;
  const parts = [
    `📋 <b>Сводка по тендерам · ${tgDate(now, tz)}</b>`,
    `Новых: ${count('Новый')} · В работе: ${count('В работе')} · Подано: ${count('Подано')} · Торги: ${count('Торги')}`
  ];
  const add = (title, list) => {
    if (!list.length) return;
    parts.push('', `${title} — ${list.length}`, TG_LINE);
    parts.push(list.map(t => tgCard(t, tz, now)).join('\n' + TG_LINE + '\n'));
  };
  add('⛔ <b>ПРОСРОЧЕНА ПОДАЧА</b>', sec.over);
  add('🔥 <b>ПОДАЧА СЕГОДНЯ</b>', sec.today);
  add('⚠️ <b>ПОДАЧА В БЛИЖАЙШИЕ 3 ДНЯ</b>', sec.d3);
  add('🟡 <b>ПОДАЧА В ТЕЧЕНИЕ НЕДЕЛИ</b>', sec.d7);
  add('🔨 <b>ТОРГИ / ИТОГИ СЕГОДНЯ-ЗАВТРА</b>', sec.auction);
  add('❓ <b>ДАТА ТОРГОВ ПРОШЛА — ОБНОВИТЕ ИТОГ</b>', sec.result);
  add(`💤 <b>«НОВЫЙ» ДОЛЬШЕ ${TG_STALE_DAYS} ДН — ВЗЯТЬ В РАБОТУ ИЛИ ОТКАЗАТЬСЯ?</b>`, sec.stale);

  if (parts.length === 2) parts.push('', '✅ Срочного нет.');
  return parts.join('\n');
}

const TG_LINE = '────────────────';
const TG_WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
// Значок суммы — те же ступени, что и цвета НМЦК в таблице
const TG_MONEY_MARKS = [[100000, '⚪'], [300000, '🔵'], [700000, '🟢'], [1000000, '🟡'], [1500000, '🟠'], [2000000, '🔴'], [Infinity, '🟣']];

function tgWeeklyText(tenders, now) {
  const tz = book().getSpreadsheetTimeZone();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const recent = t => t.updatedAt instanceof Date && t.updatedAt >= weekAgo;
  const sum = list => list.reduce((s, t) => s + (Number(t.nmck) || 0), 0);
  const money = tgMoney;
  const by = st => tenders.filter(t => t.status === st);

  const added = tenders.filter(t => t.takenDate instanceof Date && t.takenDate >= tgDayStart(weekAgo, tz));
  const won = by('Выиграли').filter(recent);
  const lost = by('Проиграли').filter(recent);
  const lines = [
    `📊 <b>Итог недели</b> (${Utilities.formatDate(weekAgo, tz, 'dd.MM')}–${Utilities.formatDate(now, tz, 'dd.MM')})`,
    `• Взяли в работу новых: <b>${added.length}</b>`,
    `• Выиграли: <b>${won.length}</b>${won.length ? ' на ' + money(sum(won)) : ''}`,
    `• Проиграли: <b>${lost.length}</b>`,
    '',
    '<b>Сейчас в работе:</b>',
    ...['Новый', 'В работе', 'Подано', 'Торги'].map(st => `• ${st}: ${by(st).length}`),
    `НМЦК активных: <b>${money(sum(tenders.filter(t => TG_ACTIVE.concat(TG_SENT).includes(t.status))))}</b>`
  ];
  if (won.length) lines.push('', '🏆 <b>Победы недели:</b>', TG_LINE, won.map(t => tgCard(t, tz, now)).join('\n' + TG_LINE + '\n'));
  return lines.join('\n');
}

// Карточка тендера: каждая часть — отдельной строкой
function tgCard(t, tz, now) {
  const lines = [];
  lines.push('🏛 <b>' + tgEsc(tgShort(t.customer || 'Заказчик не указан', 160)) + '</b>');
  if (t.subject) lines.push('📦 ' + tgEsc(tgShort(t.subject, 200)));
  lines.push('📌 Статус: <b>' + tgEsc(t.status || '—') + '</b>' + (t.type ? ' · ' + tgEsc(t.type) : ''));
  if (t.etp) lines.push('🏢 Площадка: <b>' + tgEsc(t.etp) + '</b>');
  if (t.deadline instanceof Date) lines.push('⏰ Подача до: <b>' + tgFmt(t.deadline, tz, true) + '</b> — ' + tgWhen(t.deadline, tz, now, true));
  if (t.auctionDate instanceof Date) lines.push('🔨 Торги / итоги: <b>' + tgFmt(t.auctionDate, tz, false) + '</b> — ' + tgWhen(t.auctionDate, tz, now, false));
  if (Number(t.nmck)) {
    const mark = TG_MONEY_MARKS.find(([limit]) => Number(t.nmck) < limit)[1];
    lines.push(mark + ' НМЦК: <b>' + tgMoney(Number(t.nmck)) + '</b>');
  }
  if (t.url) lines.push('🔗 <a href="' + tgEsc(t.url) + '">' + (t.number ? '№ ' + tgEsc(t.number) : 'Открыть закупку') + '</a>');
  else if (t.number) lines.push('🔗 № ' + tgEsc(t.number));
  if (t.comment) lines.push('💬 ' + tgEsc(tgShort(t.comment, 200)));
  return lines.join('\n');
}

// «сегодня», «завтра», «через 5 дн.», «через 3 ч», «просрочено»
function tgWhen(d, tz, now, withTime) {
  if (withTime ? d < now : tgDayStart(d, tz) < tgDayStart(now, tz)) return '⛔ <b>просрочено</b>';
  const h = (d - now) / 3600000;
  if (withTime && h < 24) return '<b>через ' + tgHours(h) + '</b>';
  const n = Math.round((tgDayStart(d, tz) - tgDayStart(now, tz)) / 86400000);
  if (n === 0) return '<b>сегодня</b>';
  if (n === 1) return '<b>завтра</b>';
  return 'через ' + n + ' дн.';
}

function tgMoney(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
}

function tgDate(d, tz) {
  return TG_WEEKDAYS[Number(Utilities.formatDate(d, tz, 'u')) % 7] + ', ' + Utilities.formatDate(d, tz, 'dd.MM.yyyy');
}

// ---------- данные и отправка ----------

// Все строки листа «Тендеры» как объекты по ключам COLS (+ ссылка из номера закупки)
function tgReadTenders() {
  const sh = getSheet();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const range = sh.getRange(2, 1, last - 1, COLS.length);
  const values = range.getValues();
  const rich = range.getRichTextValues();
  return values.map((row, r) => {
    const t = {};
    COLS.forEach(([k], i) => { t[k] = row[i]; });
    const link = rich[r][col('number') - 1] && rich[r][col('number') - 1].getLinkUrl();
    if (link) t.url = link;
    if (t.number === 'открыть') t.number = '';
    return t;
  }).filter(t => t.id);
}

function tgSend(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TG_TOKEN');
  const chat = props.getProperty('TG_CHAT');
  if (!token || !chat) throw new Error('Telegram не настроен: запустите tgSetup');
  // Telegram принимает до 4096 символов — длинные сводки режем по строкам
  const chunks = [];
  let cur = '';
  String(text).split('\n').forEach(line => {
    if ((cur + '\n' + line).length > 3900) { chunks.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
  });
  if (cur) chunks.push(cur);
  chunks.forEach(chunk => {
    const r = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chat, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }),
      muteHttpExceptions: true
    });
    const res = JSON.parse(r.getContentText());
    if (!res.ok) throw new Error('Telegram: ' + res.description);
  });
}

// ---------- мелочи ----------

function tgDayStart(d, tz) {
  return Utilities.parseDate(Utilities.formatDate(d, tz, 'yyyy-MM-dd'), tz, 'yyyy-MM-dd');
}
function tgFmt(d, tz, withTime) {
  return Utilities.formatDate(d, tz, withTime ? 'dd.MM HH:mm' : 'dd.MM');
}
function tgHours(h) {
  return h < 1 ? Math.max(1, Math.round(h * 60)) + ' мин' : Math.round(h) + ' ч';
}
function tgShort(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function tgEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
