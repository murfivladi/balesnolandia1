// HTTPS во ВлодБраузере (этап Н5): хранилище доверия, проверка сертификата сервера (той же криптографией, что у API),
// страница «Ваше подключение не защищено», просмотр сертификата.
import { useEffect, useState } from 'react';
import { get } from '../shared/api.js';
import { verifyTls, certHash, CERT_ERRORS, keyId } from '@bln/shared/balnet-pki.js';
import { HSTS_PRELOAD } from '@bln/shared/balnet-url.js';

// ——— Хранилище доверия (как обновления корневых сертификатов в Chrome) ———

let trustP = null;
let trustAt = 0;
export function trustStore() {
  if (!trustP || Date.now() - trustAt > 5 * 60000) {
    trustAt = Date.now();
    trustP = get('/net/trust').catch((e) => { trustP = null; throw e; });
  }
  return trustP;
}
export function refreshTrust() {
  trustP = null;
  return trustStore();
}

/** Проверка сертификата сервера: { ok, code, leaf, issuer, ev, org, ocsp, ct_index, hash }. */
export async function checkTls(tls, host) {
  const trust = await trustStore();
  const v = await verifyTls({ tls, host, now: tls.time, trust });
  let hash = null;
  try { hash = await certHash(tls.chain[0]); } catch { /* битый сертификат */ }
  return { ...v, hash, time: tls.time };
}

// Исключения «Перейти на сайт (небезопасно)» — до закрытия браузера, как в Chrome.
const bypass = new Set();
export const isBypassed = (host, hash) => bypass.has(`${host}|${hash}`);
export const addBypass = (host, hash) => bypass.add(`${host}|${hash}`);

// ——— Игровое время ———

/** Игровые секунды → «12 д. 3 мес.» (месяц — 30 игровых суток). */
export function gameDate(sec) {
  const s = Number(sec) || 0;
  const month = Math.floor(s / (30 * 86400));
  const day = Math.floor((s % (30 * 86400)) / 86400) + 1;
  return `день ${day}, месяц ${month}`;
}

// ——— Страница ошибки сертификата ———

const EXPLAIN = {
  ERR_CERT_AUTHORITY_INVALID: (h) => `Сервер не смог доказать, что это ${h}: его сертификат выдан центром, которому ВлодБраузер не доверяет. Это бывает при самоподписанном сертификате или если кто-то перехватывает соединение.`,
  ERR_CERT_COMMON_NAME_INVALID: (h, v) => `Сервер не смог доказать, что это ${h}: сертификат выдан для ${(v.leaf?.san || []).join(', ') || 'другого имени'}.`,
  ERR_CERT_DATE_INVALID: (h, v) => `Сервер не смог доказать, что это ${h}: срок сертификата ${v.leaf && v.time > v.leaf.na ? 'истёк' : 'ещё не начался'}. Проверьте часы, или сайт забыл продлить сертификат.`,
  ERR_CERT_REVOKED: (h) => `Сертификат сайта ${h} отозван выпустившим его центром — скорее всего, его ключ украден.`,
  ERR_CERT_INVALID: (h) => `Сертификат сайта ${h} повреждён или подделан: подпись центра сертификации не сходится.`,
  ERR_CERTIFICATE_TRANSPARENCY_REQUIRED: (h) => `Сертификат сайта ${h} не записан в журнал прозрачности. ВлодБраузер принимает только публично записанные сертификаты.`,
};

export function CertErrorPage({ host, cert, onBack, onProceed, onShowCert }) {
  const [adv, setAdv] = useState(false);
  const hsts = HSTS_PRELOAD.has(host);
  const code = cert.code;
  return (
    <div className="bp-page bp-error bp-certerr">
      <div className="bp-error-icon" aria-hidden>⚠️</div>
      <h1>Ваше подключение не защищено</h1>
      <p>Злоумышленники могут пытаться похитить ваши данные с сайта <b>{host}</b> (например, пароли, сообщения или номера карт).</p>
      <p className="bp-code">
        <button className="bp-link" onClick={onShowCert}>{code}</button>
      </p>
      <div className="bp-error-actions">
        <button className="bp-btn" onClick={() => setAdv((v) => !v)}>{adv ? 'Скрыть подробности' : 'Дополнительные'}</button>
        <button className="bp-btn bp-btn-primary" onClick={onBack}>Вернуться к безопасной странице</button>
      </div>
      {adv && (
        <div className="bp-certerr-adv">
          <p>{(EXPLAIN[code] || ((h) => `${CERT_ERRORS[code] || 'Ошибка сертификата'} (${h}).`))(host, cert)}</p>
          {hsts
            ? <p>Сейчас вы не можете перейти на сайт {host}: он использует HSTS (строгую защиту соединения). Ошибки сети и атаки обычно временные — попробуйте позже.</p>
            : <p><button className="bp-link bp-danger" onClick={onProceed}>Перейти на сайт {host} (небезопасно)</button></p>}
        </div>
      )}
    </div>
  );
}

// ——— Просмотр сертификата ———

const POLICY = { DV: 'Проверка домена (DV)', OV: 'Проверка организации (OV)', EV: 'Расширенная проверка (EV)', self: 'Самоподписанный', ca: 'Промежуточный центр', root: 'Корневой центр' };
const subj = (s) => [s?.cn && `CN = ${s.cn}`, s?.o && `O = ${s.o}`, s?.c && `C = ${s.c}`, s?.inn && `ИНН = ${s.inn}`, s?.jurisdiction && `Юрисдикция = ${s.jurisdiction}`].filter(Boolean).join(', ');

export function CertViewer({ tls, verdict, host, onClose }) {
  const chain = tls?.chain || [];
  const [sel, setSel] = useState(0);
  const [fp, setFp] = useState({});
  useEffect(() => {
    let alive = true;
    Promise.all(chain.map(async (c) => [await certHash(c).catch(() => '—'), await keyId(c.tbs.spki).catch(() => '—')])).then((r) => { if (alive) setFp(r); });
    return () => { alive = false; };
  }, [tls]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = chain[sel]?.tbs;
  return (
    <div className="bb-modal-wrap" role="dialog" aria-label="Сертификат">
      <div className="bb-backdrop" onClick={onClose} />
      <div className="bb-modal bb-cert">
        <header>
          <b>Сертификат: {host}</b>
          <button className="bb-icon" onClick={onClose} aria-label="Закрыть">✕</button>
        </header>
        <p className={verdict?.ok ? 'bb-ok' : 'bb-bad'}>
          {verdict?.ok ? '✔ Сертификат действителен' : `✖ ${CERT_ERRORS[verdict?.code] || 'Сертификат недействителен'} (${verdict?.code})`}
        </p>
        <div className="bb-cert-chain" role="tablist" aria-label="Цепочка">
          {chain.map((x, i) => (
            <button key={i} role="tab" aria-selected={i === sel} className={i === sel ? 'is-sel' : ''} onClick={() => setSel(i)} style={{ paddingLeft: 8 + (chain.length - 1 - i) * 12 }}>
              {i === chain.length - 1 && chain.length > 1 ? '🏛 ' : i === 0 ? '📄 ' : '🔗 '}{x.tbs?.subject?.cn || '—'}
            </button>
          ))}
          {verdict?.ok && chain.length > 0 && chain[chain.length - 1].tbs.policy !== 'root' && <span className="bp-muted">Корень: из хранилища ВлодБраузера</span>}
        </div>
        {c && (
          <dl className="bp-dl bb-cert-dl">
            <dt>Кому выдан</dt><dd>{subj(c.subject)}</dd>
            <dt>Кем выдан</dt><dd>{subj(c.issuer)}</dd>
            <dt>Вид</dt><dd>{POLICY[c.policy] || c.policy}</dd>
            {!!c.san?.length && <><dt>Имена (SAN)</dt><dd className="mono">{c.san.join(', ')}</dd></>}
            <dt>Действует с</dt><dd>{gameDate(c.nb)}</dd>
            <dt>Действует до</dt><dd>{gameDate(c.na)}</dd>
            <dt>Серийный номер</dt><dd className="mono">{c.serial}</dd>
            <dt>Отпечаток SHA-256</dt><dd className="mono bb-break">{fp[sel]?.[0] || '…'}</dd>
            <dt>Открытый ключ</dt><dd className="mono">ECDSA P-256, id {fp[sel]?.[1] || '…'}</dd>
            {sel === 0 && tls.sct && <><dt>Журнал прозрачности</dt><dd>запись № {tls.sct.index}, {gameDate(tls.sct.ts)}</dd></>}
            {sel === 0 && <><dt>Статус (OCSP)</dt><dd>{verdict?.ocsp === 'good' ? 'действителен' : verdict?.ocsp === 'revoked' ? 'отозван' : tls.ocsp ? 'ответ не прошёл проверку' : 'нет ответа'}</dd></>}
          </dl>
        )}
      </div>
    </div>
  );
}
