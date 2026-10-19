// ==UserScript==
// @name         Учёт тендеров
// @namespace    plagin-tender-audit
// @version      1.3.0
// @updateURL    https://raw.githubusercontent.com/flycited2-dotcom/Plagin_Tender_Audit/main/yandex/tender-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/flycited2-dotcom/Plagin_Tender_Audit/main/yandex/tender-tracker.user.js
// @description  Кнопка «В учёт» на страницах закупок: поля заполняются сами, тендер уходит в Google Таблицу
// @match        https://zakupki.gov.ru/*
// @match        https://rts-tender.ru/*
// @match        https://*.rts-tender.ru/*
// @match        https://sberbank-ast.ru/*
// @match        https://*.sberbank-ast.ru/*
// @match        https://roseltorg.ru/*
// @match        https://*.roseltorg.ru/*
// @match        https://b2b-center.ru/*
// @match        https://*.b2b-center.ru/*
// @match        https://*.fabrikant.ru/*
// @match        https://*.etpgpb.ru/*
// @match        https://*.tektorg.ru/*
// @match        https://*.lot-online.ru/*
// @match        https://*.zakazrf.ru/*
// @match        https://*.rad.ru/*
// @match        https://agregatoreat.ru/*
// @match        https://*.agregatoreat.ru/*
// @match        https://*.tender.pro/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Версия для Яндекс Браузера (Tampermonkey). Пишет в ту же Google Таблицу, что и расширение для Chrome.
// Файл собирается скриптом build.ps1 из userscript.src.js + tender-tracker/extract.js — правьте исходники, не результат.

(function () {
  'use strict';

  // Адрес веб-приложения, ключ и ссылка на таблицу. В публичной копии пусто — задаются в меню Tampermonkey
  // «⚙ Настройки таблицы»; локальная сборка (*.local.user.js) берёт их из tender-tracker/config.js.
  const DEFAULT_SETTINGS = { url: '', token: '', sheetUrl: '' };

  const STATUSES = ['Новый', 'В работе', 'Подано', 'Торги', 'Выиграли', 'Проиграли', 'Отказ'];
  const TYPES = ['Электронный аукцион', 'Конкурс', 'Запрос котировок', 'Запрос предложений',
    'Ед. поставщик', 'Закупка малого объёма', 'Коммерческая / 223-ФЗ', 'Другое'];
  const ETPS = ['РТС-тендер', 'Сбербанк-АСТ', 'Росэлторг', 'ЭТП ГПБ', 'ТЭК-Торг', 'РАД (lot-online)', 'ZakazRF',
    'Фабрикант', 'B2B-Center', 'АСТ ГОЗ', 'Tender.Pro', 'ЕАТ «Берёзка»', 'Малые закупки Крыма'];
  const FIELDS = ['number', 'customer', 'subject', 'type', 'nmck', 'etp', 'takenDate', 'deadline', 'auctionDate', 'status', 'comment', 'url'];
  const AUTO_FIELDS = ['number', 'customer', 'subject', 'type', 'nmck', 'etp', 'deadline', 'auctionDate'];

  // --- распознавание полей (копия tender-tracker/extract.js) ---
  function extractTender() {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const cut = s => (s.length > 300 ? s.slice(0, 300) + '…' : s);
    const bodyText = document.body ? document.body.innerText : '';
    const lines = bodyText.split('\n').map(clean).filter(Boolean);
  
    const cache = new Map();
    const txt = el => {
      if (!cache.has(el)) cache.set(el, clean(el.textContent));
      return cache.get(el);
    };
    const candidates = Array.from(
      document.querySelectorAll('span,div,td,th,dt,dd,label,p,b,strong,h2,h3,h4,li')
    ).filter(el => el.childElementCount <= 3 && txt(el).length <= 200);
  
    const notEmpty = v => v.length > 2;
  
    // Ищем элемент-подпись и берём значение: из него самого (после подписи), из соседа или из соседа родителя
    function findByLabel(patterns, valid = notEmpty) {
      for (const re of patterns) {
        for (const el of candidates) {
          const t = txt(el);
          const m = t.match(re);
          if (!m) continue;
          // берём самый глубокий элемент с подписью
          if (Array.from(el.children).some(c => re.test(txt(c)))) continue;
  
          // текст после подписи (без уточнений в скобках, напр. "(подрядчика, исполнителя)")
          const tail = t.slice(m.index + m[0].length).replace(/^\s*\([^)]*\)/, '');
          const inline = clean(tail.replace(/^[\s:：–—-]+/, ''));
          const siblings = [];
          if (el.tagName !== 'TH') { // у заголовка таблицы сосед — тоже заголовок, а не значение
            if (el.nextElementSibling) siblings.push(txt(el.nextElementSibling));
            const p = el.parentElement;
            if (p && p.nextElementSibling && p.childElementCount <= 3) siblings.push(clean(p.nextElementSibling.textContent));
          }
          // "Подпись: значение" — значение внутри; иначе сначала смотрим соседний элемент
          const options = /^\s*[:：]/.test(tail) ? [inline, ...siblings] : [...siblings, inline];
          for (const v of options) if (v && v.length < 1000 && valid(v)) return cut(v);
        }
      }
      // запасной вариант: построчно по тексту страницы
      for (const re of patterns) {
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(re);
          if (!m || lines[i].length > 400) continue;
          const rest = clean(lines[i].slice(m.index + m[0].length).replace(/^[\s:：–—-]+/, ''));
          if (rest && valid(rest)) return cut(rest);
          const next = lines[i + 1];
          // короткая строка КАПСОМ — обычно соседний заголовок таблицы, а не значение
          const looksLikeHeader = next && next.length < 30 && next === next.toUpperCase();
          if (next && !looksLikeHeader && valid(next)) return cut(next);
        }
      }
      return '';
    }
  
    const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})(?:[^\d]{1,6}(\d{1,2}):(\d{2}))?/;
    const hasDate = v => DATE_RE.test(v);
    function toISO(s, withTime) {
      const m = (s || '').match(DATE_RE);
      if (!m) return '';
      const d = `${m[3]}-${m[2]}-${m[1]}`;
      return withTime ? `${d}T${(m[4] || '09').padStart(2, '0')}:${m[5] || '00'}` : d;
    }
  
    // --- Номер закупки ---
    let number = '';
    try {
      const u = new URL(location.href);
      for (const k of ['regNumber', 'purchaseNumber', 'noticeNumber', 'number', 'id']) {
        const v = u.searchParams.get(k);
        if (v && /^\d{8,}$/.test(v)) { number = v; break; }
      }
    } catch (e) { /* ignore */ }
    if (!number) {
      const v = findByLabel(
        [/^(Номер извещения|Реестровый номер|Номер закупки|Номер процедуры|Номер торгов|Извещение №|Закупка №|Процедура №)/i],
        v => /\d{6,}/.test(v)
      );
      const m = v.match(/[A-ZА-Я]{0,4}\d{6,}/);
      if (m) number = m[0];
    }
    if (!number) {
      const m = bodyText.match(/№\s?(\d{11,19})\b/) || document.title.match(/(\d{11,19})/);
      if (m) number = m[1];
    }
  
    // --- Заказчик ---
    let customer = findByLabel([
      /^(Полное )?(наименование )?заказчика?\b/i,
      /^Организация,? осуществляющая (размещение|закупку)/i,
      /^Размещение осуществляет/i,
      /^Организатор( закупки| торгов)?/i,
      /^Наименование организации/i
    ]);
    // ЕАТ «Берёзка»: заказчик подписан просто «Наименование» в блоке «Информация о заказчике» (идёт первым на странице)
    if (!customer && /Информация о заказчике/i.test(bodyText)) customer = findByLabel([/^Наименование$/i]);
    customer = customer.replace(/^(Заказчик|Организатор)\s+/i, '');
  
    // --- Предмет ---
    const subject = findByLabel([
      /^(Наименование )?объекта? закупки/i,
      /^Предмет (договора|контракта|закупки|торгов)/i,
      /^Наименование (закупки|процедуры|лота|предмета|торгов)/i,
      /^Наименование (товара|товаров|работ|услуг|объекта)/i // ЕАТ: «Наименование товара, работ, услуг»
    ]);
  
    // --- Тип закупки ---
    function mapType(s) {
      s = (s || '').toLowerCase();
      if (/аукцион/.test(s)) return 'Электронный аукцион';
      if (/котиров/.test(s)) return 'Запрос котировок';
      if (/предложени/.test(s)) return 'Запрос предложений';
      if (/конкурс/.test(s)) return 'Конкурс';
      if (/единствен/.test(s)) return 'Ед. поставщик';
      // малые закупки: ЕАТ «Берёзка» (закупочная сессия, «закупка до 600 000 руб.»), п. 4/5 и ч. 12 ст. 93
      if (/закупочная сессия|малого объ[её]м|закупка до \d|стать[иья] 93|ст\.\s*93/.test(s)) return 'Закупка малого объёма';
      return '';
    }
    let type = mapType(findByLabel([
      /^Способ определения поставщика/i,
      /^Способ (проведения |осуществления )?(закупки|торгов|процедуры)/i,
      /^Способ размещения/i,
      /^(Форма|Вид|Тип) (проведения )?(торгов|процедуры|закупки)/i
    ]));
    if (!type) {
      const m = bodyText.match(/(электронный аукцион|аукцион в электронной форме|открытый конкурс|конкурс в электронной форме|запрос котировок|запрос предложений)/i);
      if (m) type = mapType(m[1]);
    }
  
    // --- НМЦК ---
    let nmck = '';
    const priceText = findByLabel(
      [/^Начальная \(?максимальная\)? цена/i, /^НМЦ[КД]?/i, /^Начальная цена/i, /^Цена (договора|контракта|лота)/i,
        /^Стартовая( \/ максимальная)? цена/i, /^Максимальная цена/i], // ЕАТ: «Стартовая / Максимальная цена»
      v => /\d/.test(v)
    );
    const pm = priceText.match(/\d[\d\s ]*(?:[.,]\d{1,2})?/);
    if (pm) {
      const n = Number(pm[0].replace(/[\s ]/g, '').replace(',', '.'));
      if (!isNaN(n) && n > 0) nmck = String(n);
    }
  
    // --- Срок подачи заявок ---
    const deadline = toISO(findByLabel([
      /окончания срока подачи заявок/i,
      /окончани[ея] (при[её]ма|подачи) (заявок|предложений)/i, // ЕАТ: «Дата окончания подачи предложений»
      /(при[её]м|подача) заявок до/i,
      /срок подачи заявок/i
    ], hasDate), true);
  
    // --- Дата торгов / итогов ---
    const auctionDate = toISO(findByLabel([
      /^Дата (и время )?проведения (электронного )?аукциона/i,
      /^Дата (и время )?(проведения )?(торгов|процедуры)/i,
      /^Дата (и время )?подведения итогов/i,
      /^Дата (и время )?рассмотрения/i
    ], hasDate), false);
  
    // --- Электронная площадка (где пройдут торги) ---
    const ETP_BY_HOST = [
      [/rts-tender\.ru/i, 'РТС-тендер'], [/sberbank-ast\.ru/i, 'Сбербанк-АСТ'], [/roseltorg\.ru/i, 'Росэлторг'],
      [/etpgpb\.ru/i, 'ЭТП ГПБ'], [/tektorg\.ru/i, 'ТЭК-Торг'], [/lot-online\.ru|rad\.ru/i, 'РАД (lot-online)'],
      [/zakazrf\.ru/i, 'ZakazRF'], [/fabrikant\.ru/i, 'Фабрикант'], [/b2b-center\.ru/i, 'B2B-Center'],
      [/astgoz\.ru/i, 'АСТ ГОЗ'], [/tender\.?pro/i, 'Tender.Pro'], [/berezka|agregatoreat/i, 'ЕАТ «Берёзка»']
    ];
    const etpByText = s => { const h = ETP_BY_HOST.find(([re]) => re.test(s || '')); return h ? h[1] : ''; };
    let etp = findByLabel(
      [/^Наименование электронной площадки/i, /^(Электронная|Торговая) площадка/i, /^Наименование оператора электронной площадки/i, /^ЭТП\b/i],
      v => v.length > 1 && v.length < 120 && !/^в информационно/i.test(v)
    );
    // вместо названия бывает адрес площадки (223-ФЗ) или соседняя строка «Адрес электронной площадки… http://…»
    if (!etp || /https?:|www\.|^Адрес/i.test(etp)) etp = etpByText(etp) || etpByText(location.hostname) ||
      etpByText(findByLabel([/^Адрес электронной площадки/i], v => /\./.test(v)));
    // единые короткие названия, чтобы таблицу было удобно фильтровать по площадке
    const ETP_BY_NAME = [
      [/РТС/i, 'РТС-тендер'], [/Сбер/i, 'Сбербанк-АСТ'], [/ЕЭТП|Росэлторг/i, 'Росэлторг'], [/ГПБ|Газпромбанк/i, 'ЭТП ГПБ'],
      [/ТЭК/i, 'ТЭК-Торг'], [/РАД|аукционный дом/i, 'РАД (lot-online)'], [/АГЗ|ZakazRF/i, 'ZakazRF'],
      [/Фабрикант/i, 'Фабрикант'], [/B2B/i, 'B2B-Center'], [/АСТ ГОЗ/i, 'АСТ ГОЗ'], [/Берёзк|Березк/i, 'ЕАТ «Берёзка»']
    ];
    const named = ETP_BY_NAME.find(([re]) => re.test(etp || ''));
    if (named) etp = named[1];
  
    return { number, customer, subject, type, nmck, deadline, auctionDate, etp, url: location.href };
  }

  // ---------- хранилище Tampermonkey ----------
  // Личные настройки из локальной сборки запоминаем в Tampermonkey — тогда автообновление
  // с GitHub (там настройки пустые) их не сотрёт
  if (DEFAULT_SETTINGS.url && !GM_getValue('settings', null)) GM_setValue('settings', DEFAULT_SETTINGS);
  const settings = () => Object.assign({}, DEFAULT_SETTINGS, GM_getValue('settings', {}));
  const loadStore = () => GM_getValue('tenders', {});            // id → запись, сохранённая из этого браузера
  const saveStore = s => GM_setValue('tenders', s);
  const loadQueue = () => GM_getValue('queue', { upsert: [], del: [] }); // что не удалось отправить
  const saveQueue = q => GM_setValue('queue', q);

  const todayISO = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  const pageUrl = () => location.href.split('#')[0];
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function findSaved(data) {
    const store = loadStore();
    return Object.values(store).find(t =>
      (data && data.number && t.number === data.number) || t.url === pageUrl()) || null;
  }

  // ---------- связь с Google Таблицей ----------
  function post(body) {
    const s = settings();
    if (!s.url) return Promise.resolve({ ok: false, skipped: true });
    return new Promise(resolve => GM_xmlhttpRequest({
      method: 'POST',
      url: s.url,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      data: JSON.stringify(Object.assign({}, body, { token: s.token })),
      timeout: 60000,
      onload: r => {
        try {
          const d = JSON.parse(r.responseText);
          resolve(d.ok ? d : { ok: false, error: d.error || 'Ошибка таблицы' });
        } catch (e) {
          resolve({ ok: false, error: 'скрипт таблицы не ответил — проверьте адрес и доступ «Все»' });
        }
      },
      onerror: () => resolve({ ok: false, error: 'нет связи с таблицей' }),
      ontimeout: () => resolve({ ok: false, error: 'таблица не ответила вовремя' })
    }));
  }

  async function sendRecords(records) {
    const res = await post({ action: 'upsert', tenders: records });
    const q = loadQueue();
    const ids = records.map(r => r.id);
    q.upsert = res.ok ? q.upsert.filter(id => !ids.includes(id)) : Array.from(new Set(q.upsert.concat(ids)));
    saveQueue(q);
    // таблица склеила запись с уже существующей строкой (тот же номер) — берём её ID
    if (res.ok && res.merged && res.merged.length) {
      const store = loadStore();
      res.merged.forEach(m => {
        if (m.to && m.to !== m.from && store[m.from]) {
          store[m.to] = Object.assign({}, store[m.from], { id: m.to });
          delete store[m.from];
          if (current && current.id === m.from) current.id = m.to;
        }
      });
      saveStore(store);
    }
    return res;
  }

  // Защита от дублей: такой номер уже есть в таблице (например, сохранён из другого браузера)?
  async function checkSheetDuplicate(number) {
    const res = await post({ action: 'find', number });
    if (!res.ok || !res.found || current.id) return;
    const f = res.found;
    const merged = Object.assign({}, f);
    for (const k of FIELDS) if (!merged[k] && current[k]) merged[k] = current[k];
    current = merged;
    fillForm(current);
    for (const k of FIELDS) field(k).classList.remove('auto');
    const when = f.updatedAt ? new Date(f.updatedAt).toLocaleDateString('ru-RU') : '';
    setInfo(`⚠️ Этот тендер уже есть в таблице (статус «${f.status || '—'}»${when ? ', обновлён ' + when : ''}). ` +
      'Открыта существующая запись — «Сохранить» обновит её, дубля не будет.', 'warn');
  }

  async function sendDelete(id) {
    const res = await post({ action: 'delete', id });
    if (!res.ok && !res.skipped) {
      const q = loadQueue();
      q.del = Array.from(new Set(q.del.concat(id)));
      saveQueue(q);
    }
    return res;
  }

  // Дослать всё, что не ушло раньше
  async function flushQueue() {
    const q = loadQueue();
    if (!q.upsert.length && !q.del.length) return { ok: true, count: 0 };
    const left = [];
    for (const id of q.del) {
      const r = await post({ action: 'delete', id });
      if (r.skipped) return r;
      if (!r.ok) left.push(id);
    }
    q.del = left;
    saveQueue(q);
    const store = loadStore();
    const records = q.upsert.map(id => store[id]).filter(Boolean);
    if (!records.length) {
      saveQueue({ upsert: [], del: left });
      return { ok: !left.length, count: 0 };
    }
    return sendRecords(records);
  }

  // ---------- интерфейс (в Shadow DOM, чтобы стили сайта не мешали) ----------
  const host = document.createElement('div');
  host.id = 'tender-tracker-host';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 0; bottom: 0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .fab { position: fixed; right: 20px; bottom: 20px; padding: 10px 16px; border: 0; border-radius: 999px;
    background: #1f3864; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .fab.saved { background: #1e7e34; }
  .fab:hover { filter: brightness(1.15); }
  .panel { position: fixed; top: 0; right: 0; width: 400px; max-width: 100vw; height: 100vh; overflow-y: auto;
    background: #fff; color: #1f2328; box-shadow: -6px 0 24px rgba(0,0,0,.2); padding: 14px 16px 20px;
    font-size: 13px; line-height: 1.4; display: none; }
  .panel.open { display: block; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  h1 { font-size: 17px; margin: 0; margin-right: auto; }
  header a { color: #1a73e8; text-decoration: none; font-size: 13px; }
  .x { background: none; border: 0; font-size: 22px; line-height: 1; cursor: pointer; color: #656d76; }
  .info { font-size: 12px; padding: 7px 9px; border-radius: 6px; margin-bottom: 10px; display: none; }
  .info.ok, .info.warn, .info.err { display: block; }
  .info.ok { background: #e6f4ea; } .info.warn { background: #fef7e0; } .info.err { background: #fce8e6; color: #c5221f; }
  label { display: block; margin-bottom: 8px; color: #656d76; font-size: 12px; }
  input, select, textarea { display: block; width: 100%; margin-top: 2px; padding: 6px 8px; font-size: 13px;
    border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328; }
  textarea { resize: vertical; }
  .auto { background: #e6f4ea; border-color: #81c995; }
  .row { display: flex; gap: 8px; } .row > label { flex: 1; min-width: 0; }
  .actions { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; }
  .btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #d0d7de; background: #fff; cursor: pointer; font-size: 13px; }
  .primary { background: #1a73e8; border-color: #1a73e8; color: #fff; font-weight: 600; }
  .danger { color: #c5221f; }
</style>
<button class="fab" type="button">📋 В учёт</button>
<div class="panel">
  <header>
    <h1>Тендер</h1>
    <a class="sheet" href="#" target="_blank" rel="noopener">Таблица ↗</a>
    <button class="x" type="button" title="Закрыть">×</button>
  </header>
  <div class="info"></div>
  <form>
    <label>Номер закупки<input name="number"></label>
    <label>Заказчик<input name="customer"></label>
    <label>Предмет<textarea name="subject" rows="2"></textarea></label>
    <div class="row">
      <label>Тип закупки<select name="type"></select></label>
      <label>НМЦК, ₽<input name="nmck" inputmode="decimal"></label>
    </div>
    <label>Площадка (ЭТП)<input name="etp" list="etpList" placeholder="где пройдут торги"></label>
    <datalist id="etpList"></datalist>
    <div class="row">
      <label>Взяли в работу<input name="takenDate" type="date"></label>
      <label>Статус<select name="status"></select></label>
    </div>
    <div class="row">
      <label>Срок подачи заявки<input name="deadline" type="datetime-local"></label>
      <label>Дата торгов / итогов<input name="auctionDate" type="date"></label>
    </div>
    <label>Комментарий<textarea name="comment" rows="2"></textarea></label>
    <label>Ссылка<input name="url"></label>
    <div class="actions">
      <button class="btn primary" type="submit">Сохранить</button>
      <button class="btn danger del" type="button" hidden>Удалить</button>
    </div>
  </form>
</div>`;

  const $ = sel => root.querySelector(sel);
  const fab = $('.fab'), panel = $('.panel'), form = $('form'), info = $('.info');
  const field = name => form.elements[name];
  const opts = (values, withEmpty) => (withEmpty ? '<option value="">—</option>' : '') +
    values.map(v => `<option>${v}</option>`).join('');
  field('type').innerHTML = opts(TYPES, true);
  field('status').innerHTML = opts(STATUSES, false);
  $('#etpList').innerHTML = ETPS.map(v => `<option value="${v}">`).join('');

  let current = null;

  function setInfo(text, kind) {
    info.textContent = text;
    info.className = 'info ' + (kind || '');
  }

  function refreshFab() {
    const saved = findSaved(null);
    fab.textContent = saved ? '✓ В учёте' : '📋 В учёт';
    fab.classList.toggle('saved', !!saved);
  }

  function fillForm(t) {
    for (const f of FIELDS) field(f).value = t[f] || '';
  }

  function openPanel() {
    let data = null;
    try { data = extractTender(); } catch (e) { /* страница необычная — заполним вручную */ }
    const s = settings();
    $('.sheet').style.display = s.sheetUrl ? '' : 'none';
    if (s.sheetUrl) $('.sheet').href = s.sheetUrl;
    for (const f of FIELDS) field(f).classList.remove('auto');

    const saved = findSaved(data);
    if (saved) {
      current = saved;
      fillForm(current);
      $('.del').hidden = false;
      // площадка появилась позже — дозаполняем у старых записей
      if (!current.etp && data && data.etp) {
        field('etp').value = data.etp;
        field('etp').classList.add('auto');
        setInfo('Этот тендер уже в учёте. Найдена площадка — нажмите «Сохранить», чтобы дописать её в таблицу', 'ok');
      } else {
        setInfo('Этот тендер уже в учёте — обновите статус или данные', 'ok');
      }
    } else {
      current = { url: pageUrl(), takenDate: todayISO(), status: 'Новый' };
      let found = 0;
      if (data) for (const f of AUTO_FIELDS) if (data[f]) { current[f] = data[f]; found++; }
      fillForm(current);
      if (data) for (const f of AUTO_FIELDS) if (data[f]) field(f).classList.add('auto');
      $('.del').hidden = true;
      setInfo(found
        ? `Распознано полей: ${found} из ${AUTO_FIELDS.length}. Зелёные — заполнены сами, проверьте их.`
        : 'Поля не распознаны — заполните вручную', found ? 'ok' : 'warn');
      if (current.number) checkSheetDuplicate(current.number);
    }
    if (!s.url) setInfo('Таблица не подключена: меню Tampermonkey → «⚙ Настройки таблицы». Сохранить можно и сейчас — отправится позже.', 'warn');
    panel.classList.add('open');
  }

  const closePanel = () => panel.classList.remove('open');

  form.addEventListener('input', e => e.target.classList && e.target.classList.remove('auto'));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = {};
    for (const f of FIELDS) data[f] = String(field(f).value || '').trim();
    data.nmck = data.nmck.replace(/\s/g, '').replace(',', '.');
    if (!data.number && !data.subject) { setInfo('Укажите хотя бы номер или предмет закупки', 'err'); return; }

    const record = Object.assign({}, current, data, { id: current.id || newId(), updatedAt: new Date().toISOString() });
    const store = loadStore();
    store[record.id] = record;
    saveStore(store);
    current = record;
    $('.del').hidden = false;
    refreshFab();

    setInfo('Сохранено ✓ Отправляю в таблицу…', 'ok');
    const res = await sendRecords([record]);
    if (res.ok) { setInfo('Сохранено ✓ и отправлено в Google Таблицу', 'ok'); setTimeout(closePanel, 1200); }
    else if (res.skipped) setInfo('Сохранено ✓ Таблица не подключена — отправится после настройки.', 'warn');
    else setInfo(`Сохранено ✓, но в таблицу не ушло: ${res.error}. Отправится автоматически позже.`, 'warn');
  });

  $('.del').addEventListener('click', async () => {
    if (!current || !current.id || !confirm('Удалить этот тендер из учёта и из таблицы?')) return;
    const store = loadStore();
    delete store[current.id];
    saveStore(store);
    await sendDelete(current.id);
    setInfo('Удалено', 'warn');
    refreshFab();
    setTimeout(closePanel, 800);
  });

  fab.addEventListener('click', () => (panel.classList.contains('open') ? closePanel() : openPanel()));
  $('.x').addEventListener('click', closePanel);
  root.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // ---------- меню Tampermonkey ----------
  GM_registerMenuCommand('📋 Добавить тендер', openPanel);
  GM_registerMenuCommand('⚙ Настройки таблицы', async () => {
    const s = settings();
    const url = prompt('Адрес веб-приложения Apps Script (…/exec):', s.url);
    if (url === null) return;
    const token = prompt('Ключ доступа (TOKEN из скрипта таблицы):', s.token);
    if (token === null) return;
    const sheetUrl = prompt('Ссылка на саму Google Таблицу (для кнопки «Таблица ↗», можно пусто):', s.sheetUrl);
    GM_setValue('settings', { url: url.trim(), token: token.trim(), sheetUrl: (sheetUrl || '').trim() });
    const r = await post({ action: 'ping' });
    alert(r.ok ? 'Связь с таблицей есть ✓' : 'Не получилось: ' + (r.error || 'адрес не указан'));
    if (r.ok) flushQueue();
  });
  GM_registerMenuCommand('↻ Отправить неотправленное', async () => {
    const r = await flushQueue();
    alert(r.ok ? `Готово ✓ Отправлено: ${r.count || 0}` : 'Ошибка: ' + (r.error || 'таблица не подключена'));
  });

  document.documentElement.appendChild(host);
  refreshFab();
  setTimeout(flushQueue, 3000);
})();
