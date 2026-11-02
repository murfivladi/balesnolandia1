import os from 'node:os';

/**
 * На части хостингов (контейнеры OpenVZ/gVisor) ядро не отдаёт список сетевых интерфейсов,
 * и os.networkInterfaces() бросает ERR_SYSTEM_ERROR «uv_interface_addresses returned Unknown
 * system error 97» (EAFNOSUPPORT).
 *
 * Fastify читает интерфейсы ради строчки в логе при listen({ host: '0.0.0.0' }). Ошибка
 * вылетает из обработчика события 'listening' уже после успешного bind: порт открыт, но
 * процесс падает, служба поднимает его снова — и так по кругу.
 *
 * Поэтому подменяем вызов на безопасный: если список получить не удалось, считаем его пустым
 * (адреса в логе просто не печатаются) и один раз сообщаем об этом через onError.
 */

/** true — если os.networkInterfaces уже обёрнут этим модулем. */
export function isPatched() {
  return typeof os.networkInterfaces === 'function' && os.networkInterfaces.blnSafe === true;
}

/**
 * @param {(err: Error) => void} [onError] вызывается один раз при первом сбое
 * @returns {boolean} true, если подмена установлена (или уже была установлена)
 */
export function patchNetworkInterfaces(onError = () => {}) {
  if (isPatched()) return true;
  const original = os.networkInterfaces;
  if (typeof original !== 'function') return false;

  let reported = false;
  function networkInterfacesSafe(...args) {
    try {
      return original.apply(os, args);
    } catch (err) {
      if (!reported) {
        reported = true;
        try {
          onError(err);
        } catch {
          // Ошибка обработчика не должна возвращать нас к исходному падению.
        }
      }
      return {};
    }
  }
  networkInterfacesSafe.blnSafe = true;

  try {
    os.networkInterfaces = networkInterfacesSafe;
  } catch {
    return false;
  }
  return isPatched();
}
