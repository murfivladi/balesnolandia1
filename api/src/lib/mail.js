import nodemailer from 'nodemailer';
import { config } from '../config.js';

export const DISCLAIMER = 'Игровой сервис. Не является банком, госорганом, платёжным средством или удостоверением личности.';

let transporter = null;
function getTransport() {
  if (config.mail.transport !== 'smtp') return null;
  transporter ??= nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
  });
  return transporter;
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
  const t = getTransport();
  if (!t) {
    if (config.env !== 'test') console.log(`[mail] to=${to} subject=${subject}\n${fullText}`);
    sentMail.push({ to, subject, text: fullText });
    if (sentMail.length > 50) sentMail.shift();
    return;
  }
  await t.sendMail({ from: config.mail.from, to, subject, text: fullText, html: fullHtml, attachments });
}

/** Последние письма в режиме console — для тестов. */
export const sentMail = [];
