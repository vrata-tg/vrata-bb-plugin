# Врата AI для bb

Плагин добавляет в bb провайдер **Врата AI (Pi)** со встроенным полноценным **Pi 1.3.0**. Отдельный CLI устанавливать не нужно. Сессии, инструменты, повторы и сжатие контекста выполняет штатный Pi; плагин связывает его с BB. Нужны bb 0.41+ и Node.js 22.19.0+.

## Установка

```bash
bb plugin install npm:@vrata-ai/bb-plugin
```

## Публикация

Workflow [Release](.github/workflows/release.yml) запускается вручную из `main`
с новой версией `X.X.X`. Он обновляет версии в обоих манифестах, проверяет сборку
и тесты, отправляет коммит и тег, публикует пакет в npm и создаёт GitHub Release.

Публикация использует [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
через OIDC на GitHub-hosted runner. Workflow устанавливает npm 11 и запрашивает
`id-token: write`; секрет `NPM_TOKEN` не требуется.

Перед первым запуском в [настройках пакета npm](https://www.npmjs.com/package/@vrata-ai/bb-plugin/access)
добавьте Trusted Publisher для GitHub Actions:

- Organization or user: `vrata-tg`
- Repository: `vrata-bb-plugin`
- Workflow filename: `release.yml`
- Environment name: оставьте пустым.
- Разрешите прямую публикацию: `Allow npm publish`.

Новая привязка должна пройти первую успешную публикацию в течение двух дней;
если она истекла, создайте её заново перед релизом. После успешной публикации
через OIDC удалите неиспользуемый секрет `NPM_TOKEN` в GitHub и отзовите
соответствующий токен в npm.
