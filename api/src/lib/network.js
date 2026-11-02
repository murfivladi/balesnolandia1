// На части VPS системный вызов uv_interface_addresses недоступен (errno 97,
// "Address family not supported by protocol"), и os.networkInterfaces() бросает
// ERR_SYSTEM_ERROR. Fastify вызывает его в обработчике 'listening', когда сервер
// слушает 0.0.0.0, чтобы вывести список адресов. Исключение из event handler
// не перехватывается и убивает процесс сразу после успешного bind().
// Обёртка отдаёт оригинальный результат, где это возможно, а при ошибке —
// минимальный loopback: сервер остаётся доступным, лог адреса не критичен.
import os from 'node:os';

const FALLBACK = {
  lo: [{
    address: '127.0.0.1',
    netmask: '255.0.0.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: true,
    cidr: '127.0.0.1/8',
  }],
};

let warned = false;

/** Вызвать один раз до app.listen(): делает os.networkInterfaces() безопасным. */
export function guardNetworkInterfaces() {
  const original = os.networkInterfaces;
  if (typeof original !== 'function' || original.__blnGuarded) return;

  const guarded = function networkInterfaces() {
    try {
      return original.call(os);
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn(`[BLN] os.networkInterfaces() недоступен (${err?.code || err?.message || 'неизвестная ошибка'}): для лога адреса используем 127.0.0.1`);
      }
      return FALLBACK;
    }
  };
  guarded.__blnGuarded = true;
  os.networkInterfaces = guarded;
}
