// Распознавание данных тендера на открытой странице.
// Функция выполняется ВНУТРИ страницы площадки, поэтому должна быть полностью самодостаточной.
// Работает по подписям полей ("Заказчик", "Объект закупки", "Начальная (максимальная) цена" и т.п.),
// поэтому подходит для zakupki.gov.ru, РТС-тендер, Сбер-АСТ, Росэлторг, B2B-Center и др.
function extractTender() {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const cut = s => (s.length > 300 ? s.slice(0, 300) + '…' : s);
  const bodyText = document.body ? document.body.innerText : '';
  const lines = bodyText.split('\n').map(clean).filter(Boolean);

  // служебные скрытые подписи ExtJS (Росэлторг): «Cell value has been edited» и т.п.
  // Проверяем только сам элемент: этим же классом ExtJS прячет целые неактивные вкладки с нужными данными
  const isHelper = el => !!(el && el.matches('.x-hidden-offsets, .x-hidden-display'));
  const cache = new Map();
  const txt = el => {
    if (!cache.has(el)) cache.set(el, clean(el.textContent));
    return cache.get(el);
  };
  const candidates = Array.from(
    document.querySelectorAll('span,div,td,th,dt,dd,label,p,b,strong,h2,h3,h4,li')
  ).filter(el => el.childElementCount <= 3 && txt(el).length <= 200 && !isHelper(el));

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
          if (el.nextElementSibling && !isHelper(el.nextElementSibling)) siblings.push(txt(el.nextElementSibling));
          const p = el.parentElement;
          if (p && p.nextElementSibling && p.childElementCount <= 3) siblings.push(clean(p.nextElementSibling.textContent));
          // ExtJS (Росэлторг): подпись лежит внутри <label>, значение — следующий за ним блок
          const lab = el.closest('label');
          if (lab && lab.nextElementSibling) siblings.push(clean(lab.nextElementSibling.textContent));
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
  // даты других видов → «дд.мм.гггг»: «26 окт. 2026» (РТС-тендер), «26.10.26» (Росэлторг)
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const monthNo = w => String(MONTHS.findIndex(p => w.toLowerCase().startsWith(p)) + 1).padStart(2, '0');
  const normDate = s => (s || '')
    .replace(/(\d{1,2})\s+(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*\.?\s+(\d{4})/gi,
      (m, d, mon, y) => `${d.padStart(2, '0')}.${monthNo(mon)}.${y}`)
    .replace(/(^|\D)(\d{2})\.(\d{2})\.(\d{2})(?![\d.])/g, '$1$2.$3.20$4');
  const hasDate = v => DATE_RE.test(normDate(v));
  // withTime: true — всегда со временем (нет времени — 09:00), 'auto' — время, только если оно указано
  function toISO(s, withTime) {
    const m = normDate(s).match(DATE_RE);
    if (!m) return '';
    const d = `${m[3]}-${m[2]}-${m[1]}`;
    if (withTime === 'auto') return m[4] ? `${d}T${m[4].padStart(2, '0')}:${m[5]}` : d;
    return withTime ? `${d}T${(m[4] || '09').padStart(2, '0')}:${m[5] || '00'}` : d;
  }

  // --- Номер закупки ---
  let number = '';
  try {
    const u = new URL(location.href);
    for (const k of ['regNumber', 'purchaseNumber', 'noticeNumber', 'number', 'id']) {
      const v = u.searchParams.get(k);
      // id — часто внутренний номер площадки (Сбер: ?id=11139452), а не номер закупки
      if (v && (k === 'id' ? /^\d{11,}$/ : /^\d{8,}$/).test(v)) { number = v; break; }
    }
    // номер в адресе: roseltorg.ru/procedure/0875300029426000293/1, rts-tender.ru/poisk/id/l0274100000226000110-1/
    if (!number) number = (u.pathname.match(/(?:^|\D)(\d{11}|\d{19})(?!\d)/) || [])[1] || '';
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
    /^(Полное )?(наименование )?заказчика?(?![а-яёa-z])/i, // \b после русских букв в JS не срабатывает
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
    [/^Начальная \(?максимальная\)? цена/i,
      /^НМЦ[КД]?(?=\s*[:(]|\s*$)/i, // подпись, а не имя файла «НМЦК Карамелька 30кВт.xlsx»
      /^Начальная цена/i, /^Цена (договора|контракта|лота)/i,
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
    /^Подать заявку до/i, // РТС-тендер
    /срок подачи заявок/i
  ], hasDate), true);

  // --- Дата и время торгов / итогов ---
  let auctionDate = toISO(findByLabel([
    /^Дата (и время )?(начала )?проведения (электронного )?аукциона/i,
    /^Дата (и время )?(начала )?(проведения )?(торгов|процедуры|аукциона)/i,
    /^(Дата и время )?начал[оа] (торгов|аукциона|проведения)/i,
    /^Дата проведения(?=\s*:)/i, // РТС-тендер: «Дата проведения: 26 окт. 2026 09:00 мск»
    /^Дата (и время )?подведения итогов/i,
    /^Дата (и время )?рассмотрения/i
  ], hasDate), 'auto');
  // время начала торгов бывает отдельным полем: «Время проведения аукциона: 11:35»
  if (auctionDate && !auctionDate.includes('T')) {
    const tm = findByLabel([/^Время (начала )?(проведения )?(электронного )?(аукциона|торгов|процедуры)/i],
      v => /^\D{0,3}\d{1,2}:\d{2}/.test(v)).match(/(\d{1,2}):(\d{2})/);
    if (tm) auctionDate += `T${tm[1].padStart(2, '0')}:${tm[2]}`;
  }

  // --- Электронная площадка (где пройдут торги) ---
  const ETP_BY_HOST = [
    [/rts-tender\.ru/i, 'РТС-тендер'], [/sberbank-ast\.ru/i, 'Сбербанк-АСТ'], [/roseltorg\.ru/i, 'Росэлторг'],
    [/etpgpb\.ru/i, 'ЭТП ГПБ'], [/tektorg\.ru/i, 'ТЭК-Торг'], [/lot-online\.ru|rad\.ru/i, 'РАД (lot-online)'],
    [/zakazrf\.ru/i, 'ZakazRF'], [/fabrikant\.ru/i, 'Фабрикант'], [/b2b-center\.ru/i, 'B2B-Center'],
    [/astgoz\.ru/i, 'АСТ ГОЗ'], [/tender\.?pro/i, 'Tender.Pro'], [/berezka|agregatoreat/i, 'ЕАТ «Берёзка»']
  ];
  const etpByText = s => { const h = ETP_BY_HOST.find(([re]) => re.test(s || '')); return h ? h[1] : ''; };
  let etp = findByLabel(
    [/^Наименование электронной площадки/i, /^(Электронная|Торговая) площадка/i, /^Наименование оператора электронной площадки/i, /^ЭТП(?![а-яёa-z])/i],
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
