// Дымовые тесты этапа 8: страницы ВлодУслуг, ВлодБанка и админки рисуются
// на реальных формах ответов API и не падают на пустых/заполненных данных.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../shared/api.js', () => ({
  get: vi.fn(),
  post: vi.fn(async () => ({ ok: true })),
  patch: vi.fn(async () => ({ ok: true })),
  del: vi.fn(async () => ({ ok: true })),
  api: vi.fn(),
  appUrl: (app, hash = '') => `#${hash}`,
  newIdemKey: () => 'idem',
  onUnauthorized: () => () => {},
  onOffline: () => () => {},
  wsUrl: () => '',
}));

import { get, post } from '../shared/api.js';
import { TaxesPage } from '../services/taxes.jsx';
import { FinesPage } from '../services/fines.jsx';
import { BenefitsPage } from '../services/benefits.jsx';
import { PropertyPage } from '../services/property.jsx';
import { DoctorPage } from '../services/doctor.jsx';
import { ElectionsPage } from '../services/elections.jsx';
import { AppealsPage } from '../services/appeals.jsx';
import { NewsPage } from '../services/news.jsx';
import { DocumentsPage } from '../services/documents.jsx';
import { WorkPage } from '../services/work.jsx';
import { StateChargesPage } from '../bank/state.jsx';
import { BankPropertyPage } from '../bank/property.jsx';
import { FineArticles, FineAppeals, GovBudget, Sanctions, AdminProperties, CountriesAdmin, ElectionsAdmin, NewsAdmin } from '../admin/services.jsx';

function routes(map) {
  get.mockImplementation(async (p) => {
    const key = Object.keys(map).sort((a, b) => b.length - a.length).find((k) => p === k || p.startsWith(k));
    if (!key) throw new Error(`нет фикстуры для ${p}`);
    const v = map[key];
    return typeof v === 'function' ? v(p) : v;
  });
}

const invoice = { number: 'BLN-1', kind: 'fine', purpose: 'Штраф: Превышение скорости', amount: 1100, penalty: 100, due_month: 12, frozen: false, status: 'unpaid', created_at: '2026-01-01', paid_at: null, paid_via: null };

const account = { id: 1, name: 'Расчётный', balance: 50000, status: 'active', type: 'current' };

beforeEach(() => {
  get.mockReset();
  post.mockClear();
});

describe('ВлодУслуги, этап 8', () => {
  it('налоги: декларации, пени и меры', async () => {
    routes({
      '/gov/taxes': {
        month: 14, overdue: 1100,
        declarations: [{ id: 1, year: 1, document_id: 2, period_from: '2026-01-01', period_to: '2026-12-01', income_auto: 10000, income: null, rate_bp: 600, tax: null, status: 'draft', due_month: 16, invoice: null, full_name: 'Анна', passport_no: 'BLN-1', submitted_at: null }],
        invoices: [invoice],
        sanctions: [{ id: 1, kind: 'travel_ban', reason: 'Неуплата налогов', active: true, created_at: '2026-02-01' }],
        rates: { ndfl_bp: 1300, ip_tax_bp: 600, property_tax_bp: 100, vat_bp: 2000, penalty_bp: 100, sanction_months: 3 },
      },
    });
    render(<TaxesPage />);
    expect(await screen.findByText('Налоги и декларации')).toBeTruthy();
    expect(screen.getByText('Декларации ИП')).toBeTruthy();
    expect(screen.getByText('Черновик')).toBeTruthy();
    expect(screen.getByText('Запрет выезда из БФ')).toBeTruthy();
    expect(screen.getByText(/Просрочено налогов и штрафов/)).toBeTruthy();
    // Кнопка «Подать» открывает форму декларации.
    fireEvent.click(screen.getByRole('button', { name: 'Подать' }));
    expect(await screen.findByText('Подать декларацию')).toBeTruthy();
  });

  it('штрафы: список, жалоба и модальное окно', async () => {
    routes({
      '/gov/fines': {
        fines: [{
          id: 5, article_id: 1, article: 'Превышение скорости', amount: 1000, note: null, status: 'issued', invoice: 'BLN-1', invoice_amount: 1100,
          appeal_status: null, appeal_text: null, appeal_note: null, created_at: '2026-01-01', officer: 'Пётр',
        }],
      },
    });
    render(<FinesPage />);
    expect(await screen.findByText('Превышение скорости')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Обжаловать' }));
    expect(await screen.findByText('Обжалование штрафа')).toBeTruthy();
  });

  it('пособия: карточки и заявки', async () => {
    routes({
      '/gov/benefits': {
        benefits: [{ id: 1, kind: 'child', title: 'Детское пособие', status: 'pending', months_left: null, note: null, created_at: '2026-01-01' }],
        amounts: { child: 1000, pension: 20000, unemployment: 10000 },
        rules: { pension_age: 65, unemployment_months: 6, child_each: 1000, children: 2, age: 36 },
      },
    });
    render(<BenefitsPage />);
    expect(await screen.findByText('Детское пособие')).toBeTruthy();
    expect(screen.getAllByText('На рассмотрении').length).toBeGreaterThan(0);
    expect(screen.getByText(/Детей: 2/)).toBeTruthy();
  });

  it('имущество: моё, рынок и сделки', async () => {
    const prop = { id: 1, kind: 'car', title: 'Волга', reg_number: 'А123ВЛ', address: null, details: null, photo: null, value: 100000, owner_citizen_id: 1, list_price: null, lien_loan_id: null, status: 'active' };
    routes({
      '/gov/properties/market': { properties: [{ ...prop, id: 2, title: 'Квартира', list_price: 500000, owner_name: 'Государство БФ' }] },
      '/gov/properties': {
        properties: [prop],
        deals: [{ id: 9, property_id: 2, title: 'Квартира', kind: 'realty', reg_number: 'НД-1', seller_citizen_id: null, seller_name: 'Государство БФ', buyer_citizen_id: 1, buyer_name: 'Анна', price: 500000, status: 'pending', loan_id: null, created_at: '2026-01-01', closed_at: null }],
        me: 1,
      },
    });
    render(<PropertyPage />);
    expect(await screen.findByText('Волга')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Рынок' }));
    expect(await screen.findByText('Квартира')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Сделки' }));
    expect(await screen.findByText('Ждёт оплаты')).toBeTruthy();
  });

  it('врач: слоты, страховка и приёмы', async () => {
    routes({
      '/gov/doctor': {
        free: [{ id: 1, doctor: 'Доктор Айболит', starts_at: '2026-06-01T10:00:00', duration_min: 15, priority: true, status: 'free', insured: false }],
        visits: [{ id: 2, doctor: 'Доктор Айболит', starts_at: '2026-05-01T10:00:00', duration_min: 15, priority: false, status: 'done', insured: true, complaint: 'Кашель', conclusion: 'ОРВИ' }],
        insured: false, insurance: null, insurance_invoice: null, insurance_price: 5000, insurance_months: 12,
      },
    });
    render(<DoctorPage />);
    expect(await screen.findByText('Медицинская страховка')).toBeTruthy();
    expect(screen.getByText('Нужна страховка')).toBeTruthy();
    expect(screen.getByText(/ОРВИ/)).toBeTruthy();
  });

  it('выборы: кандидаты и голосование', async () => {
    routes({
      '/gov/elections': {
        vote_age: 18,
        elections: [{
          id: 1, title: 'Мэр Влодограда', description: null, status: 'voting', created_at: '2026-01-01', finished_at: null, turnout: 2, voted: false, my_candidate: false,
          candidates: [{ id: 3, full_name: 'Анна Гражданская', program: 'Парки и кафе', status: 'approved', mine: false }],
        }],
      },
    });
    render(<ElectionsPage />);
    expect(await screen.findByText('Мэр Влодограда')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Голосовать' }));
    expect(await screen.findByText('Подтвердить голос')).toBeTruthy();
  });

  it('обращения: список и форма', async () => {
    routes({ '/gov/appeals': { appeals: [{ id: 1, addressee: 'police', subject: 'Шумные соседи', body: 'Шумят ночью', status: 'answered', answer: 'Наряд направлен', created_at: '2026-01-01', answered_at: '2026-01-02' }] } });
    render(<AppealsPage />);
    expect(await screen.findByText('Шумные соседи')).toBeTruthy();
    expect(screen.getByText(/Наряд направлен/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Написать обращение' }));
    expect(await screen.findByText('Новое обращение')).toBeTruthy();
  });

  it('новости: типы и текст', async () => {
    routes({ '/gov/news': { news: [{ id: 1, kind: 'decree', title: 'Указ №1', body: 'Объявить день кафе', pinned: true, created_at: '2026-01-01' }] } });
    render(<NewsPage />);
    expect(await screen.findByText('Указ №1')).toBeTruthy();
    expect(screen.getByText('закреплено')).toBeTruthy();
  });

  it('документы: права, загранпаспорт и визы', async () => {
    routes({
      '/gov/me': {
        month: 5,
        passport: { id: 1, number: 'BLN-0001', status: 'active', full_name: 'Анна', birth_date: '1990-05-01', address: 'Влодоград', marital_status: 'single', children: [] },
        documents: [{ id: 1, type: 'visa', number: 'VSVL001', status: 'active', data: { country: 'Северная Влодония', country_code: 'SVL' }, verify_code: 'v1', issued_month: 4, expires_month: 10 }],
        applications: [{ id: 1, type: 'driver', title: 'Права', status: 'awaiting_payment', data: {}, created_at: '2026-01-01' }],
        links: [],
        invoices: [],
      },
      '/public/settings': { fee_inn: 0, fee_ip: 5000, fee_driver: 2000, fee_foreign_passport: 5000, fee_marriage: 1000, fee_birth: 0 },
      '/gov/countries': { countries: [{ id: 1, name: 'Северная Влодония', code: 'SVL', visa_required: true, visa_fee: 2000, visa_months: 6 }] },
    });
    render(<DocumentsPage />);
    expect(await screen.findByText('Северная Влодония')).toBeTruthy();
    expect(screen.getByText('Оплатить госпошлину')).toBeTruthy();
    expect(screen.getByText('Водительские права')).toBeTruthy();
  });

  it('рабочие места: обращения, полиция, налоговая, врач, пособия', async () => {
    routes({
      '/gov/work/appeals': { appeals: [{ id: 1, addressee: 'police', subject: 'Шум', body: 'Шумят', status: 'open', answer: null, created_at: '2026-01-01', author: 'Анна' }] },
      '/gov/fine-articles': { articles: [{ id: 1, code: '12.9', title: 'Превышение скорости', amount: 1000 }] },
      '/gov/work/police/fines': { fines: [{ id: 1, full_name: 'Анна', passport_no: 'BLN-1', article: 'Превышение скорости', amount: 1000, status: 'issued', created_at: '2026-01-01' }] },
      '/gov/work/tax/declarations': { declarations: [{ id: 1, full_name: 'Иван', passport_no: 'BLN-2', year: 1, income_auto: 10000, income: 10000, rate_bp: 600, tax: 600, status: 'submitted', due_month: 16 }] },
      '/gov/work/tax/debtors': { month: 14, debtors: [{ id: 1, full_name: 'Нищий', passport_no: 'BLN-3', n: 2, total: 1100, penalty: 100, since: 10, months_late: 4 }], sanctions: [{ id: 1, kind: 'arrest', reason: 'Неуплата', full_name: 'Нищий', passport_no: 'BLN-3', created_at: '2026-01-01' }] },
      '/gov/work/doctor': { slots: [{ id: 1, doctor: 'Доктор', starts_at: '2026-06-01T10:00:00', duration_min: 15, priority: false, status: 'booked', patient: 'Анна', insured: true, complaint: 'Кашель', conclusion: null }] },
      '/gov/work/benefits': { benefits: [{ id: 1, kind: 'child', title: 'Детское пособие', status: 'pending', full_name: 'Анна', passport_no: 'BLN-1', age: 36, children: 2, amount: 2000, months_left: null, created_at: '2026-01-01' }] },
    });
    const me = { id: 1, roles: ['admin'] };
    const { unmount } = render(<WorkPage me={me} route={{ path: '/work/appeals', query: {} }} />);
    expect(await screen.findByText('Шум')).toBeTruthy();
    unmount();
    const p1 = render(<WorkPage me={me} route={{ path: '/work/police', query: {} }} />);
    expect(await screen.findByText('Мои выписанные штрафы')).toBeTruthy();
    p1.unmount();
    const p2 = render(<WorkPage me={me} route={{ path: '/work/tax', query: {} }} />);
    expect(await screen.findByText('Должники')).toBeTruthy();
    expect(screen.getByText('Доначислить налог')).toBeTruthy();
    p2.unmount();
    const p3 = render(<WorkPage me={me} route={{ path: '/work/doctor', query: {} }} />);
    expect(await screen.findByText('Добавить слоты')).toBeTruthy();
    expect(screen.getByText('Заключение')).toBeTruthy();
    expect(screen.getByText('Пациент')).toBeTruthy();
    p3.unmount();
    render(<WorkPage me={me} route={{ path: '/work/benefits', query: {} }} />);
    expect(await screen.findByText('Детское пособие')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Назначить' })).toBeTruthy();
  });
});

describe('ВлодБанк, этап 8', () => {
  it('госуслуги: квитанции и меры', async () => {
    routes({
      '/bank/state-charges': { invoices: [invoice], paid: [], sanctions: [{ kind: 'arrest', reason: 'Неуплата', created_at: '2026-01-01' }] },
      '/bank/overview': { accounts: [account], cards: [], recent: [], user: { full_name: 'Анна' } },
    });
    render(<StateChargesPage tick={0} />);
    expect(await screen.findByText('Госуслуги и налоги')).toBeTruthy();
    expect(screen.getByText('Арест счетов')).toBeTruthy();
    expect(screen.getAllByText(/Штраф: Превышение скорости/).length).toBeGreaterThan(0);
  });

  it('имущество: сделка, оплата и ипотека', async () => {
    routes({
      '/bank/property': {
        deals: [{ id: 9, property_id: 2, title: 'Квартира', kind: 'realty', reg_number: 'НД-1', seller_citizen_id: null, seller_name: 'Государство БФ', buyer_citizen_id: 1, buyer_name: 'Анна', price: 500000, status: 'pending', loan_id: null, created_at: '2026-01-01', closed_at: null }],
        properties: [{ id: 3, kind: 'car', title: 'Волга', reg_number: 'А123ВЛ', value: 100000, lien_loan_id: 4, list_price: null, status: 'active' }],
        terms: { mortgage_rate_bp: 100, auto_loan_rate_bp: 150, max_months: 120, min_down_bp: 2000 },
      },
      '/bank/overview': { accounts: [account], cards: [], recent: [], user: { full_name: 'Анна' } },
    });
    render(<BankPropertyPage tick={0} />);
    expect(await screen.findByText('Квартира')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'В ипотеку / автокредит' }));
    expect(await screen.findByText('Отправить заявку')).toBeTruthy();
    expect(screen.getByText('в залоге')).toBeTruthy();
  });
});

describe('админка «Услуги», этап 8', () => {
  it('статьи штрафов и жалобы', async () => {
    routes({
      '/admin/fine-articles': { articles: [{ id: 1, code: '12.9', title: 'Превышение скорости', amount: 1000, active: true }] },
      '/admin/fines': { fines: [{ id: 5, article: 'Превышение скорости', full_name: 'Анна', passport_no: 'BLN-1', amount: 1000, status: 'issued', appeal_status: 'pending', appeal_text: 'Не я', appeal_note: null, note: null, created_at: '2026-01-01', officer: 'Пётр' }] },
    });
    const a = render(<FineArticles />);
    expect(await screen.findByText('Превышение скорости')).toBeTruthy();
    a.unmount();
    render(<FineAppeals />);
    expect(await screen.findByText('Удовлетворить', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Не я/)).toBeTruthy();
  });

  it('госбюджет, санкции и имущество', async () => {
    routes({
      '/admin/budget': {
        days: 30, balance: 100000, income: 5000, expense: 3000,
        by_kind: [{ kind: 'vat', title: 'НДС с безналичных продаж', income: 5000, expense: 0, count: 3 }],
        invoices: [{ kind: 'fine', count: 2, total: 2000 }], daily: [{ day: '2026-01-01', income: 5000, expense: 3000 }],
        receivable: { count: 2, total: 2000 },
      },
      '/admin/sanctions': { sanctions: [{ id: 1, kind: 'arrest', reason: 'Неуплата', active: true, created_at: '2026-01-01', lifted_at: null, full_name: 'Анна', passport_no: 'BLN-1' }] },
      '/admin/properties': { properties: [{ id: 1, kind: 'realty', title: 'Квартира', reg_number: 'НД-1', address: 'Влодоград', value: 500000, owner_name: 'Анна', list_price: 600000, lien_loan_id: null, status: 'active' }] },
    });
    const b = render(<GovBudget />);
    expect(await screen.findByText('Остаток госбюджета')).toBeTruthy();
    expect(screen.getByText('НДС с безналичных продаж')).toBeTruthy();
    b.unmount();
    const s = render(<Sanctions />);
    expect(await screen.findByText('Арест счетов')).toBeTruthy();
    s.unmount();
    render(<AdminProperties />);
    expect((await screen.findAllByText('Квартира')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Анна').length).toBeGreaterThan(0);
  });

  it('страны, выборы и новости', async () => {
    routes({
      '/admin/countries': { countries: [{ id: 1, name: 'Северная Влодония', code: 'SVL', visa_required: true, visa_fee: 2000, visa_months: 6, active: true }] },
      '/admin/elections': { elections: [{ id: 1, title: 'Мэр', description: null, status: 'nomination', created_at: '2026-01-01', finished_at: null, turnout: 0, candidates: [{ id: 3, full_name: 'Анна', program: 'Парки', status: 'approved', votes: 0 }] }] },
      '/gov/news': { news: [{ id: 1, kind: 'news', title: 'Новость', body: 'Текст', pinned: false, created_at: '2026-01-01' }] },
    });
    const c = render(<CountriesAdmin />);
    expect(await screen.findByText('Северная Влодония')).toBeTruthy();
    c.unmount();
    const e = render(<ElectionsAdmin />);
    expect(await screen.findByText('Мэр')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Начать голосование' })).toBeTruthy();
    e.unmount();
    render(<NewsAdmin />);
    expect(await screen.findByText('Новость')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Написать новость' })).toBeTruthy());
  });
});
