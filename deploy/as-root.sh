#!/usr/bin/env bash
# Выполнить команду от root. Первая строка stdin — пароль для sudo (может быть пустой):
#   root            → сразу;
#   пароль передан  → sudo -S с этим паролем (VPS_PASS);
#   пароля нет      → sudo без пароля (NOPASSWD).
IFS= read -r P || true
if [ "$(id -u)" = 0 ]; then exec "$@"; fi
if [ -n "$P" ]; then
  printf '%s\n' "$P" | sudo -S -p '' "$@"
  exit $?
fi
exec sudo -n "$@"
