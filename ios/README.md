# ВлодБраузер для iOS

Нативный браузер БалНета для iPhone и iPad (SwiftUI + WKWebView, iOS 16+). Проект Swift Playgrounds: `VlodBrowser.swiftpm`.
ТЗ — `docs/ios-tz.md`, ответы владельца — `docs/ios-interview.md`.

## Запуск
- **iPad / Mac:** скачать архив на `https://bln.vladislavb.qzz.io/ios/`, открыть `VlodBrowser.swiftpm` в Swift Playgrounds, ▶︎.
- **Xcode на Mac:** открыть папку `VlodBrowser.swiftpm`.
- **CI:** `.github/workflows/ios.yml` собирает проект под симулятор iOS на каждый push в `ios/**`.

## Устройство
| Папка | Что внутри |
| --- | --- |
| `Core/` | адреса БалНета (`BalnetURL` — порт `shared/balnet-url.js`), JSON и канонический JSON, клиент API, сеть (`/api/net/lease`, `/api/net/open`), проверка сертификатов (`PKI` — порт `verifyTls` на CryptoKit), файлы профилей |
| `Browser/` | модель браузера: профили, вкладки, переходы, госсайты и сайты игроков в WKWebView, мост shim шлюза, диалоги страниц |
| `UI/` | оболочка в стиле Chrome: строка состояния провайдера, адресная строка, сетка и полоса вкладок, страницы ошибок, новая вкладка, история, закладки, настройки |
| `Terminal/` | `balnet://terminal`: dig, nslookup, host, ping, traceroute, whois, curl, openssl, ssh + nano |
| `DevTools/` | Network, Консоль, Элементы, Хранилище |

## Версия
Версия задаётся в трёх местах и проверяется тестом `shared/app-versions.test.js`: `Package.swift` (displayVersion, bundleVersion), `Core/Config.swift` и `shared/app-versions.js` (её отдаёт `GET /api/app/ios` для баннера обновления).

## И2
- Аккаунт ВлодБраузера (вход через ВлодПочту) и синхронизация с вебом: закладки, история, пароли, открытые вкладки, настройки. Шифрование `Core/SyncCore.swift` совпадает с `web/src/browser/sync.js` (проверено в обе стороны).
- Пароли в Keychain, подстановка и просмотр — после Face ID. PIN карт — в Keychain под Face ID, мост `window.__balnetNative` (`web/src/shared/native.js`): подтверждение переводов, квитанций, долгов; PIN на pay.bank.bln и в банкомате.
- Face ID при входе во ВлодБанк, размытие в переключателе приложений, предупреждение о снимке экрана.
- Загрузки (WKDownload): «Поделиться», «Фото», «Файлы», экран `balnet://downloads`.
- Импорт из веба: файл JSON и QR (VisionKit).
- Безопасный просмотр, подсказки, реклама и БалНовости на новой вкладке, обои, мини-игра, отчёты о сбоях (`POST /api/app/crash`, админка → Система → Сбои приложений).
