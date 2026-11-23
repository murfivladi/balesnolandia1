// Организации БФ (ООО, АО, госучреждения) и лицензии. Счёт организации — в ВлодБанке, владелец счёта — организация.
import { q, one } from '../db.js';
import { bad, forbidden, notFound } from './errors.js';
import { getSettings } from './settings.js';
import { onIssue } from './gov.js';
import { onMonth } from './clock.js';
import { newAccountNumber, randomDigits, withUnique } from './ids.js';

export const ORG_KINDS = { llc: 'ООО', jsc: 'АО', gov: 'Госучреждение' };
/** Лицензии. applicable — можно подать заявление во ВлодУслугах; остальные выдаёт админ. */
export const LICENSE_KINDS = {
  registrar: { title: 'Регистратор доменов', applicable: true },
  registry: { title: 'Администратор доменной зоны', applicable: false },
  hosting: { title: 'Хостинг-провайдер', applicable: true },
  ca: { title: 'Удостоверяющий центр', applicable: true },
};

export async function createOrg(conn, { kind, name, directorGovUserId = null, month }) {
  if (!ORG_KINDS[kind]) throw bad('invalid', 'Неизвестный вид организации');
  return withUnique(async () => {
    const inn = randomDigits(12);
    const acc = await q("INSERT INTO accounts (number, owner_kind, owner_id, type, name, opened_month) VALUES (?, 'org', NULL, 'business', ?, ?)", [newAccountNumber('business'), `Счёт ${ORG_KINDS[kind]} «${name}»`.slice(0, 80), month], conn);
    const org = await q('INSERT INTO organizations (kind, name, inn, director_gov_user_id, account_id, created_month) VALUES (?, ?, ?, ?, ?, ?)', [kind, name, inn, directorGovUserId, acc.insertId, month], conn);
    await q('UPDATE accounts SET owner_id = ? WHERE id = ?', [org.insertId, acc.insertId], conn);
    if (directorGovUserId) await q("INSERT INTO org_members (org_id, gov_user_id, role) VALUES (?, ?, 'director')", [org.insertId, directorGovUserId], conn);
    return { id: org.insertId, inn, account_id: acc.insertId };
  });
}

export async function orgRole(conn, orgId, govUserId) {
  const m = await one('SELECT role FROM org_members WHERE org_id = ? AND gov_user_id = ?', [orgId, govUserId], conn);
  return m?.role || null;
}

/** Организация, где пользователь — сотрудник (или директор, если directorOnly). */
export async function memberOrg(conn, orgId, govUserId, { directorOnly = false } = {}) {
  const org = await one("SELECT * FROM organizations WHERE id = ? AND status = 'active'", [orgId], conn);
  if (!org) throw notFound('Организация не найдена');
  const role = await orgRole(conn, orgId, govUserId);
  if (!role || (directorOnly && role !== 'director')) throw forbidden(directorOnly ? 'Это может только директор организации' : 'Вы не сотрудник этой организации');
  return { ...org, role };
}

export async function hasLicense(conn, orgId, kind, month) {
  return !!(await one("SELECT id FROM licenses WHERE org_id = ? AND kind = ? AND status = 'active' AND (expires_month IS NULL OR expires_month >= ?)", [orgId, kind, month], conn));
}

export async function issueLicense(conn, { orgId, kind, month, months = null }) {
  return withUnique(async () => {
    const number = `L${kind.slice(0, 2).toUpperCase()}${randomDigits(8)}`;
    await q('INSERT INTO licenses (org_id, kind, number, issued_month, expires_month) VALUES (?, ?, ?, ?, ?)', [orgId, kind, number, month, months ? month + months : null], conn);
    return number;
  });
}

// Заявление «Регистрация организации»: после госпошлины — сразу организация и её счёт.
onIssue('org', async (conn, app, citizen, month) => {
  const data = typeof app.data === 'string' ? JSON.parse(app.data) : app.data || {};
  const org = await createOrg(conn, { kind: data.kind, name: data.name, directorGovUserId: app.gov_user_id, month });
  return org.inn;
});

// Заявление на лицензию: после пошлины и одобрения чиновником.
onIssue('license', async (conn, app, citizen, month) => {
  const data = typeof app.data === 'string' ? JSON.parse(app.data) : app.data || {};
  if ((await orgRole(conn, data.org_id, app.gov_user_id)) !== 'director') throw bad('not_director', 'Заявитель больше не директор организации');
  if (await hasLicense(conn, data.org_id, data.kind, month)) throw bad('already_have', 'Лицензия уже действует');
  const s = await getSettings();
  return issueLicense(conn, { orgId: data.org_id, kind: data.kind, month, months: Number(s.license_months) || null });
});

onMonth('licenses', async (month) => {
  await q("UPDATE licenses SET status = 'expired' WHERE status = 'active' AND expires_month IS NOT NULL AND expires_month < ?", [month]);
});

export function orgView(o) {
  return { id: o.id, kind: o.kind, kind_title: ORG_KINDS[o.kind], name: o.name, inn: o.inn, status: o.status, created_month: o.created_month, role: o.role };
}
