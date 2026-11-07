-- Этап Н7: SSH-доступ к хостингу. Пароль задаёт владелец в панели; логин — u<номер аккаунта>.
ALTER TABLE hosting_accounts ADD COLUMN ssh_hash VARCHAR(100) NULL;
