// Реклама ВлодПоиска. Рекламодатель пополняет баланс (квитанция → системный счёт ADS), создаёт кампании:
// объявление, ключевые слова, минус-слова, ставка за клик, дневной бюджет. Аукцион при каждом запросе:
// ранг = ставка × качество (CTR), цена клика — обобщённый аукцион второй цены (GSP). Рекламная сеть показывает
// объявления на сайтах игроков по содержимому страницы; владелец сайта получает долю, выплаты раз в игровой месяц.
// Выручка ВлодПоиска уходит в госбюджет.
import crypto from 'node:crypto';
import { tx, q, one } from '../../db.js';
import { bad, notFound, need } from '../errors.js';
import { getSettings } from '../settings.js';
import { gameSeconds, onMonth } from '../clock.js';
import { post, sys } from '../ledger.js';
import { createInvoice, onInvoicePaid, citizenOf } from '../gov.js';
import { notify } from '../notify.js';
import { primaryAccount } from '../bank.js';
import { bankUserOfCitizen } from '../state.js';
import { parseInput } from '@bln/shared/balnet-url.js';
import { formatMoney, percentOf } from '@bln/shared/money.js';
import { terms } from './text.js';
import { checkUrl } from './safe.js';

const DAY = 86400;
const parse = (v, d = null) => (v == null ? d : typeof v === 'string' ? JSON.parse(v) : v);
export const CAMPAIGN_STATUS = { active: 'показывается', paused: 'остановлена', rejected: 'отклонена модератором', deleted: 'удалена' };

// ——— Счёт рекламодателя ———

export async function adAccount(conn, govUserId) {
  let a = await one('SELECT * FROM search_ad_accounts WHERE gov_user_id = ?', [govUserId], conn);
  if (!a) {
    await q('INSERT IGNORE INTO search_ad_accounts (gov_user_id) VALUES (?)', [govUserId], conn);
    a = await one('SELECT * FROM search_ad_accounts WHERE gov_user_id = ?', [govUserId], conn);
  }
  return a;
}

export async function topup(conn, govUserId, amount) {
  const s = await getSettings();
  const n = Number(amount);
  need(Number.isSafeInteger(n) && n >= Number(s.ad_min_topup || 0) && n <= 100_000_000, `Пополнение — от ${formatMoney(s.ad_min_topup)}`);
  const a = await adAccount(conn, govUserId);
  const t = await q('INSERT INTO search_ad_topups (ad_account_id, amount) VALUES (?, ?)', [a.id, n], conn);
  const citizen = await citizenOf(govUserId, conn);
  const inv = await createInvoice(conn, {
    citizenId: citizen?.id || null, govUserId, kind: 'other', purpose: `Пополнение рекламного баланса ВлодПоиска №${a.id}`, amount: n,
    ref: { type: 'ads_topup', id: t.insertId }, splits: [{ account: await sys('ADS', conn), amount: n }],
  });
  await q('UPDATE search_ad_topups SET invoice = ? WHERE id = ?', [inv.number, t.insertId], conn);
  return { invoice: inv.number, amount: n };
}

onInvoicePaid('ads_topup', async (conn, inv) => {
  const t = await one("SELECT * FROM search_ad_topups WHERE id = ? AND status = 'pending' FOR UPDATE", [inv.ref_id], conn);
  if (!t) return;
  await q("UPDATE search_ad_topups SET status = 'paid' WHERE id = ?", [t.id], conn);
  await q('UPDATE search_ad_accounts SET balance = balance + ? WHERE id = ?', [t.amount, t.ad_account_id], conn);
});

async function payoutAccount(conn, govUserId) {
  const citizen = await citizenOf(govUserId, conn);
  const bu = citizen ? await bankUserOfCitizen(conn, citizen) : null;
  return bu ? primaryAccount(bu.id, conn) : null;
}

/** Вернуть неизрасходованный остаток на счёт во ВлодБанке. */
export async function withdraw(conn, govUserId) {
  const a = await one('SELECT * FROM search_ad_accounts WHERE gov_user_id = ? FOR UPDATE', [govUserId], conn);
  need(a && Number(a.balance) > 0, 'На рекламном балансе нет денег');
  const target = await payoutAccount(conn, govUserId);
  need(target, 'Нужен счёт во ВлодБанке, привязанный к паспорту');
  const amount = Number(a.balance);
  await post(conn, { kind: 'ads_refund', memo: 'Возврат рекламного баланса ВлодПоиска', entries: [{ account: await sys('ADS', conn), amount: -amount }, { account: target.id, amount }], ref: { type: 'ads_account', id: a.id } });
  await q('UPDATE search_ad_accounts SET balance = 0 WHERE id = ?', [a.id], conn);
  return { amount };
}

// ——— Кампании ———

function cleanKeywords(list, max = 50) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[\n,]/)).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  return [...new Set(arr)].slice(0, max).map((k) => k.slice(0, 60));
}

export async function validateCampaign(b, { partial = false } = {}) {
  const s = await getSettings();
  const out = {};
  if (!partial || b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 80); need(out.name, 'Назовите кампанию'); }
  if (!partial || b.title !== undefined) { out.title = String(b.title || '').trim(); need(out.title && out.title.length <= 56, 'Заголовок — до 56 символов'); }
  if (!partial || b.text !== undefined) { out.text = String(b.text || '').trim(); need(out.text && out.text.length <= 140, 'Текст объявления — до 140 символов'); }
  if (!partial || b.url !== undefined) {
    const u = parseInput(String(b.url || ''));
    need(u && /^https?:\/\//.test(u) && !/\s/.test(String(b.url).trim()), 'Ссылка — адрес сайта в БалНете, например https://shop.bln/');
    need(!(await checkUrl(u)), 'Ссылка ведёт на сайт из списка опасных');
    out.url = u;
  }
  if (!partial || b.keywords !== undefined) { out.keywords = JSON.stringify(cleanKeywords(b.keywords)); need(JSON.parse(out.keywords).length || b.network, 'Добавьте ключевые слова'); }
  if (!partial || b.negatives !== undefined) out.negatives = JSON.stringify(cleanKeywords(b.negatives, 100));
  if (!partial || b.bid !== undefined) { out.bid = Number(b.bid); need(Number.isSafeInteger(out.bid) && out.bid >= Number(s.ad_min_bid || 1), `Ставка — от ${formatMoney(s.ad_min_bid)} за клик`); }
  if (!partial || b.daily_budget !== undefined) { out.daily_budget = Number(b.daily_budget); need(Number.isSafeInteger(out.daily_budget) && out.daily_budget > 0, 'Укажите дневной бюджет'); }
  if (!partial || b.network !== undefined) out.network = b.network ? 1 : 0;
  if (out.bid && out.daily_budget) need(out.daily_budget >= out.bid, 'Дневной бюджет не меньше ставки за клик');
  return out;
}

export async function createCampaign(conn, govUserId, body) {
  const a = await adAccount(conn, govUserId);
  const v = await validateCampaign(body);
  const r = await q('INSERT INTO search_campaigns (ad_account_id, name, title, text, url, keywords, negatives, bid, daily_budget, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [a.id, v.name, v.title, v.text, v.url, v.keywords, v.negatives, v.bid, v.daily_budget, v.network], conn);
  resetAdCache();
  return r.insertId;
}

export async function ownCampaign(conn, id, govUserId) {
  const c = await one('SELECT c.* FROM search_campaigns c JOIN search_ad_accounts a ON a.id = c.ad_account_id WHERE c.id = ? AND a.gov_user_id = ? AND c.status <> \'deleted\'', [id, govUserId], conn);
  if (!c) throw notFound('Кампания не найдена');
  return c;
}

export async function updateCampaign(conn, c, body) {
  const v = await validateCampaign(body, { partial: true });
  if (body.status !== undefined) {
    need(['active', 'paused', 'deleted'].includes(body.status), 'Статус: active, paused или deleted');
    need(c.status !== 'rejected' || body.status === 'deleted' || v.url || v.title || v.text, 'Кампания отклонена — исправьте объявление');
    v.status = body.status;
  }
  // Исправили отклонённое объявление — снова на показ (модерация после показа, как у больших систем).
  if (c.status === 'rejected' && (v.url || v.title || v.text) && body.status !== 'deleted') { v.status = 'active'; v.reject_reason = null; }
  if ((v.bid ?? Number(c.bid)) > (v.daily_budget ?? Number(c.daily_budget))) throw bad('budget', 'Дневной бюджет не меньше ставки за клик');
  const keys = Object.keys(v);
  if (keys.length) await q(`UPDATE search_campaigns SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => v[k]), c.id], conn);
  resetAdCache();
}

export function campaignView(c) {
  return {
    id: c.id, name: c.name, title: c.title, text: c.text, url: c.url, keywords: parse(c.keywords, []), negatives: parse(c.negatives, []),
    bid: Number(c.bid), daily_budget: Number(c.daily_budget), network: !!c.network, status: c.status, status_text: CAMPAIGN_STATUS[c.status], reject_reason: c.reject_reason,
    impressions: Number(c.impressions), clicks: Number(c.clicks), spent: Number(c.spent), ctr: Number(c.impressions) ? Math.round((Number(c.clicks) / Number(c.impressions)) * 10000) / 100 : 0,
  };
}

// ——— Аукцион ———

let adCache = null;
export function resetAdCache() { adCache = null; }

async function liveCampaigns() {
  if (adCache && Date.now() - adCache.at < 3000) return adCache.list;
  const rows = await q("SELECT c.*, a.balance, a.gov_user_id FROM search_campaigns c JOIN search_ad_accounts a ON a.id = c.ad_account_id WHERE c.status = 'active' AND a.balance > 0");
  const list = rows.map((c) => ({
    ...c, bid: Number(c.bid), daily_budget: Number(c.daily_budget), balance: Number(c.balance),
    kw: parse(c.keywords, []).map((k) => ({ k, stems: terms(k, { keepStop: true }) })).filter((x) => x.stems.length),
    neg: parse(c.negatives, []).flatMap((k) => terms(k, { keepStop: true })),
  }));
  adCache = { at: Date.now(), list };
  return list;
}

async function spentToday(campaignId, day) {
  const r = await one('SELECT COALESCE(SUM(cost), 0) AS s FROM search_ad_impressions WHERE campaign_id = ? AND day = ? AND clicked = 1', [campaignId, day]);
  return Number(r.s);
}

/** Качество объявления: сглаженный CTR относительно среднего 3 %, от 0,3 до 3. */
const quality = (c) => Math.min(3, Math.max(0.3, ((Number(c.clicks) + 1) / (Number(c.impressions) + 30)) / 0.033));

/**
 * Аукцион: stems — основы запроса (поиск) или текста страницы (сеть).
 * placement: serp | network | newtab. Возвращает объявления с ценой клика и записывает показы.
 */
export async function runAuction({ stems, placement, limit = 3, client = '', siteId = null, host = null, excludeGovUser = null }) {
  const s = await getSettings();
  const minBid = Number(s.ad_min_bid || 1);
  const now = await gameSeconds();
  const day = Math.floor(now / DAY);
  const set = new Set(stems);
  const cands = [];
  for (const c of await liveCampaigns()) {
    if (placement !== 'serp' && !c.network) continue;
    if (excludeGovUser && c.gov_user_id === excludeGovUser) continue; // свой сайт — свои объявления не показываем
    if (c.neg.some((t) => set.has(t))) continue;
    const hit = c.kw.find((x) => x.stems.every((t) => set.has(t)));
    let rel = 1;
    if (!hit) {
      if (placement === 'serp') continue;
      // Сеть без совпадения: показ «по всей сети» с пониженным приоритетом.
      if (placement === 'network' && c.kw.length && !c.kw.some((x) => x.stems.some((t) => set.has(t)))) rel = 0.3;
      else if (placement === 'network' && c.kw.length) rel = 0.6;
    }
    if (c.balance < c.bid) continue;
    if ((await spentToday(c.id, day)) + c.bid > c.daily_budget) continue;
    cands.push({ c, keyword: hit?.k || null, qs: quality(c) * rel, rank: c.bid * quality(c) * rel });
  }
  cands.sort((a, b) => b.rank - a.rank);
  const winners = [];
  const seenAcc = new Set();
  for (const x of cands) {
    if (seenAcc.has(x.c.ad_account_id)) continue; // одно объявление на рекламодателя
    if (await checkUrl(x.c.url)) continue;
    seenAcc.add(x.c.ad_account_id);
    winners.push(x);
    if (winners.length > limit) break;
  }
  const out = [];
  for (let i = 0; i < Math.min(limit, winners.length); i++) {
    const w = winners[i];
    const next = winners[i + 1];
    const price = Math.min(w.c.bid, Math.max(minBid, next ? Math.floor(next.rank / w.qs) + 1 : minBid));
    const token = crypto.randomBytes(18).toString('base64url').slice(0, 24);
    await q('INSERT INTO search_ad_impressions (token, campaign_id, placement, at, day, keyword, site_id, host, client, position, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [token, w.c.id, placement, now, day, w.keyword, siteId, host, client, i + 1, price]);
    await q('UPDATE search_campaigns SET impressions = impressions + 1 WHERE id = ?', [w.c.id]);
    out.push({ token, title: w.c.title, text: w.c.text, url: w.c.url, display: w.c.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), position: i + 1 });
  }
  return out;
}

/**
 * Клик по объявлению: списание по цене аукциона, не больше остатка и дневного бюджета. Повторный клик того же
 * посетителя по той же кампании за игровые сутки бесплатен (фильтр недействительных кликов).
 */
export async function click(token, client) {
  return tx(async (conn) => {
    const imp = await one('SELECT * FROM search_ad_impressions WHERE token = ? FOR UPDATE', [String(token || '')], conn);
    if (!imp) throw notFound('Объявление устарело');
    const c = await one('SELECT * FROM search_campaigns WHERE id = ?', [imp.campaign_id], conn);
    if (imp.clicked) return { url: c.url, charged: 0 };
    const now = await gameSeconds();
    const day = Math.floor(now / DAY);
    const dup = await one('SELECT id FROM search_ad_impressions WHERE campaign_id = ? AND client = ? AND day = ? AND clicked = 1 AND cost > 0 LIMIT 1', [c.id, client || imp.client, day], conn);
    const acc = await one('SELECT * FROM search_ad_accounts WHERE id = ? FOR UPDATE', [c.ad_account_id], conn);
    const spent = Number((await one('SELECT COALESCE(SUM(cost), 0) AS s FROM search_ad_impressions WHERE campaign_id = ? AND day = ? AND clicked = 1', [c.id, day], conn)).s);
    let cost = dup || now - Number(imp.at) > DAY ? 0 : Math.min(Number(imp.price), Number(acc.balance), Math.max(0, Number(c.daily_budget) - spent));
    cost = Math.max(0, cost);
    await q('UPDATE search_ad_impressions SET clicked = 1, cost = ? WHERE id = ?', [cost, imp.id], conn);
    await q('UPDATE search_campaigns SET clicks = clicks + 1, spent = spent + ? WHERE id = ?', [cost, c.id], conn);
    if (cost > 0) {
      await q('UPDATE search_ad_accounts SET balance = balance - ?, spent_total = spent_total + ? WHERE id = ?', [cost, cost, acc.id], conn);
      let share = 0;
      if (imp.placement === 'network' && imp.site_id) {
        const s = await getSettings();
        share = percentOf(cost, Number(s.ad_network_share_bp || 0));
        await q('UPDATE search_sites SET earned_unpaid = earned_unpaid + ?, earned_total = earned_total + ? WHERE id = ?', [share, share, imp.site_id], conn);
      }
      // Доля сайта остаётся на счёте ADS до ежемесячной выплаты; остальное — выручка государства.
      if (cost - share > 0) {
        await post(conn, { kind: 'ads_revenue', memo: `Клик по объявлению «${c.title}» (ВлодПоиск)`, entries: [{ account: await sys('ADS', conn), amount: -(cost - share) }, { account: await sys('BUDGET', conn), amount: cost - share }], ref: { type: 'ad_click', id: imp.id } });
      }
      resetAdCache();
    }
    return { url: c.url, charged: cost };
  });
}

/** Выплаты сайтам рекламной сети: раз в игровой месяц всё накопленное. */
export async function payPublishers(month) {
  for (const s of await q('SELECT * FROM search_sites WHERE earned_unpaid > 0')) {
    await tx(async (conn) => {
      const site = await one('SELECT * FROM search_sites WHERE id = ? FOR UPDATE', [s.id], conn);
      const amount = Number(site.earned_unpaid);
      if (amount <= 0) return;
      const target = await payoutAccount(conn, site.gov_user_id);
      if (!target) return;
      await post(conn, {
        kind: 'ads_payout', memo: `Рекламная сеть ВлодПоиска: доход сайта ${site.host}`,
        entries: [{ account: await sys('ADS', conn), amount: -amount }, { account: target.id, amount }],
        idem: `adnet:${site.id}:${month}`, ref: { type: 'search_site', id: site.id },
      });
      await q('UPDATE search_sites SET earned_unpaid = 0 WHERE id = ?', [site.id], conn);
      await notify(conn, 'gov', site.gov_user_id, { title: 'Выплата рекламной сети', body: `${site.host}: ${formatMoney(amount)}`, link: '#/' });
    });
  }
}
onMonth('ads_payout', (month) => payPublishers(month));

/** Статистика кампании по дням (последние 14 игровых суток). */
export async function campaignStats(campaignId) {
  const day = Math.floor((await gameSeconds()) / DAY);
  const rows = await q('SELECT day, COUNT(*) AS impressions, SUM(clicked) AS clicks, SUM(cost) AS cost FROM search_ad_impressions WHERE campaign_id = ? AND day > ? GROUP BY day ORDER BY day', [campaignId, day - 14]);
  const kws = await q('SELECT keyword, placement, COUNT(*) AS impressions, SUM(clicked) AS clicks, SUM(cost) AS cost, AVG(position) AS pos FROM search_ad_impressions WHERE campaign_id = ? GROUP BY keyword, placement ORDER BY impressions DESC LIMIT 50', [campaignId]);
  const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'keyword' || k === 'placement' ? v : Number(v || 0)]));
  return { days: rows.map(num), keywords: kws.map(num) };
}
