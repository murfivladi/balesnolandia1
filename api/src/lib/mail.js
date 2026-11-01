import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { getSettings } from './settings.js';

export const DISCLAIMER = 'Игровой сервис. Не является банком, госорганом, платёжным средством или удостоверением личности.';

let transporter = null;
let transporterKey = '';

/** SMTP из админки (если задан сервер), иначе из .env; без SMTP письма пишутся в лог. */
async function mailSettings() {
  const s = await getSettings();
  if (String(s.smtp_host || '').trim()) {
    return { transport: 'smtp', host: s.smtp_host.trim(), port: Number(s.smtp_port) || 465, secure: !!s.smtp_secure, user: s.smtp_user, password: s.smtp_password, from: s.mail_from || config.mail.from };
  }
  return { ...config.mail, from: s.mail_from || config.mail.from };
}

async function getTransport() {
  const m = await mailSettings();
  if (m.transport !== 'smtp' || !m.host) return { t: null, m };
  const key = JSON.stringify([m.host, m.port, m.secure, m.user, m.password]);
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport({ host: m.host, port: m.port, secure: m.secure, auth: m.user ? { user: m.user, pass: m.password } : undefined });
    transporterKey = key;
  }
  return { t: transporter, m };
}

/** Проверка SMTP из админки: соединение и вход. */
export async function verifyMail() {
  const { t } = await getTransport();
  if (!t) return false;
  await t.verify();
  return true;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Письмо с обязательным дисклеймером. html — необязательный фрагмент тела. */
export async function sendMail({ to, subject, text, html, brand = 'Балесноландия', attachments }) {
  const fullText = `${text}\n\n—\n${DISCLAIMER}`;
  const body = html || `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
  const fullHtml = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 12px">${esc(brand)}</h2>${body}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 8px">
<p style="font-size:12px;color:#666">${esc(DISCLAIMER)}</p></body></html>`;
  const { t, m } = await getTransport();
  if (!t) {
    if (config.env !== 'test') console.log(`[mail] to=${to} subject=${subject}\n${fullText}`);
    sentMail.push({ to, subject, text: fullText });
    if (sentMail.length > 50) sentMail.shift();
    return;
  }
  await t.sendMail({ from: m.from, to, subject, text: fullText, html: fullHtml, attachments });
}

/** Последние письма в режиме console — для тестов. */
export const sentMail = [];
