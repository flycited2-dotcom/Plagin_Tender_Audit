// Распознавание данных тендера на открытой странице.
// Функция выполняется ВНУТРИ страницы площадки, поэтому должна быть полностью самодостаточной.
// Работает по подписям полей ("Заказчик", "Объект закупки", "Начальная (максимальная) цена" и т.п.),
// поэтому подходит для zakupki.gov.ru, РТС-тендер, Сбер-АСТ, Росэлторг, B2B-Center и др.
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
  customer = customer.replace(/^(Заказчик|Организатор)\s+/i, '');

  // --- Предмет ---
  const subject = findByLabel([
    /^(Наименование )?объекта? закупки/i,
    /^Предмет (договора|контракта|закупки|торгов)/i,
    /^Наименование (закупки|процедуры|лота|предмета|торгов)/i
  ]);

  // --- Тип закупки ---
  function mapType(s) {
    s = (s || '').toLowerCase();
    if (/аукцион/.test(s)) return 'Электронный аукцион';
    if (/котиров/.test(s)) return 'Запрос котировок';
    if (/предложени/.test(s)) return 'Запрос предложений';
    if (/конкурс/.test(s)) return 'Конкурс';
    if (/единствен|стать[иья] 93/.test(s)) return 'Ед. поставщик';
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
    [/^Начальная \(?максимальная\)? цена/i, /^НМЦ[КД]?/i, /^Начальная цена/i, /^Цена (договора|контракта|лота)/i],
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
    /окончани[ея] (при[её]ма|подачи) заявок/i,
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
