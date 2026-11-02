import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const PROJECT_NOT_FOUND = 8000007;
const PROJECT_ALREADY_EXISTS = new Set([8000002, 8000077]);
const PRODUCTION_BRANCH = 'main';

class SetupError extends Error {}

function errorCodes(body) {
  return Array.isArray(body.errors)
    ? body.errors.map((error) => error?.code).filter(Number.isSafeInteger)
    : [];
}

function apiError(action, response, body) {
  const codes = errorCodes(body);
  const detail = codes.length ? `, код ${codes.join(', ')}` : '';
  const authHint = response.status === 401 || response.status === 403 || codes.includes(10000)
    ? ' Проверьте Account ID и действующий токен с правом Cloudflare Pages: Edit.'
    : '';
  return new SetupError(`Cloudflare отклонил ${action} (HTTP ${response.status}${detail}).${authHint}`);
}

async function request(fetchImpl, url, apiToken, method = 'GET', payload) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: globalThis.AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SetupError('Не удалось связаться с API Cloudflare при проверке или создании проекта Pages.');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new SetupError(`Cloudflare вернул некорректный ответ (HTTP ${response.status}).`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SetupError(`Cloudflare вернул некорректный ответ (HTTP ${response.status}).`);
  }
  return { response, body };
}

function isSuccess({ response, body }) {
  return response.ok && body.success === true;
}

function isMissingProject({ response, body }) {
  // 8000007 — именно отсутствие Pages-проекта, а не общая ошибка 404/авторизации.
  return (response.status === 400 || response.status === 404)
    && body.success === false
    && Array.isArray(body.errors)
    && body.errors.length === 1
    && body.errors[0]?.code === PROJECT_NOT_FOUND;
}

function validateProject(project, expectedName) {
  if (!project || project.name !== expectedName) {
    throw new SetupError('Cloudflare вернул неожиданный проект Pages; публикация остановлена.');
  }
  if (project.source != null) {
    throw new SetupError('Проект Pages использует Git-интеграцию. Для этого workflow нужен проект Direct Upload.');
  }
  if (project.production_branch !== PRODUCTION_BRANCH) {
    throw new SetupError('Production-ветка проекта Pages не main. Менять её автоматически нельзя.');
  }
}

/** Проверяет проект в указанном аккаунте и создаёт Direct Upload только при его отсутствии. */
export async function ensurePagesProject({ accountId, apiToken, projectName, fetchImpl = globalThis.fetch }) {
  if (!accountId || !apiToken || !projectName) {
    throw new SetupError('Не заданы секреты CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN или CLOUDFLARE_PAGES_PROJECT.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) {
    throw new SetupError('CLOUDFLARE_ACCOUNT_ID содержит недопустимые символы.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    throw new SetupError('CLOUDFLARE_PAGES_PROJECT должен начинаться с маленькой буквы или цифры и содержать только маленькие буквы, цифры и дефисы.');
  }

  const collectionUrl = `${API_ROOT}/accounts/${encodeURIComponent(accountId)}/pages/projects`;
  const projectUrl = `${collectionUrl}/${encodeURIComponent(projectName)}`;
  const existing = await request(fetchImpl, projectUrl, apiToken);
  if (isSuccess(existing)) {
    validateProject(existing.body.result, projectName);
    return 'existing';
  }
  if (!isMissingProject(existing)) {
    throw apiError('проверку проекта Pages', existing.response, existing.body);
  }

  const created = await request(fetchImpl, collectionUrl, apiToken, 'POST', {
    name: projectName,
    production_branch: PRODUCTION_BRANCH,
  });
  if (isSuccess(created)) {
    validateProject(created.body.result, projectName);
    return 'created';
  }

  // Другая публикация могла создать проект после GET. Используем его только
  // после повторной успешной проверки, не скрывая остальные ошибки создания.
  const duplicate = created.response.status === 409
    || errorCodes(created.body).some((code) => PROJECT_ALREADY_EXISTS.has(code));
  if (duplicate) {
    const raced = await request(fetchImpl, projectUrl, apiToken);
    if (isSuccess(raced)) {
      validateProject(raced.body.result, projectName);
      return 'existing';
    }
    if (!isMissingProject(raced)) {
      throw apiError('повторную проверку проекта Pages', raced.response, raced.body);
    }
  }
  throw apiError('создание проекта Pages', created.response, created.body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensurePagesProject({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      projectName: process.env.CLOUDFLARE_PAGES_PROJECT,
    });
    console.log(result === 'created'
      ? 'Создан проект Cloudflare Pages Direct Upload с production-веткой main.'
      : 'Существующий проект Cloudflare Pages готов к публикации; его настройки не изменялись.');
  } catch (error) {
    const message = error instanceof SetupError ? error.message : 'Непредвиденная ошибка подготовки проекта Cloudflare Pages.';
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
