# Врата AI для bb

Плагин добавляет в bb провайдер **Врата AI (Pi)** со встроенным полноценным **Pi 1.3.0**. Отдельный CLI устанавливать не нужно. Сессии, инструменты, повторы и сжатие контекста выполняет штатный Pi; плагин связывает его с BB. Нужны bb 0.41+ и Node.js 22.19.0+.

## Установка

```bash
bb plugin install npm:@vrata-ai/bb-plugin
```

## Релиз

Откройте **Actions → Release → Run workflow**, выберите `main` и введите новую
версию без `v`, например `0.1.1`. Workflow сам обновит версию, выполнит проверки,
запушит коммит и тег `vX.X.X`, опубликует `@vrata-ai/bb-plugin` в npm и создаст
GitHub Release.

Один раз добавьте в Actions secrets `NPM_TOKEN` —
[npm-токен](https://docs.npmjs.com/creating-and-viewing-access-tokens)
с правом публикации в `@vrata-ai` и включённым **Bypass 2FA**.
