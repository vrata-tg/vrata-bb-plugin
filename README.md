# Врата AI для bb

Плагин добавляет в bb провайдер **Врата AI (Pi)** со встроенным полноценным **Pi 1.3.0**. Отдельный CLI устанавливать не нужно. Сессии, инструменты, повторы и сжатие контекста выполняет штатный Pi; плагин связывает его с BB. Нужны bb 0.41+ и Node.js 22.19.0+.

## Установка

```bash
bb plugin install npm:@vrata-ai/bb-plugin
```

## Публикация в npm

В GitHub Actions secrets репозитория добавьте `NPM_TOKEN` — granular access token
с правом публикации в scope `@vrata-ai` и включённым **Bypass 2FA** для CI.
Это требуется и для первой публикации пакета. Токен должен оставаться действующим.
См. [настройку npm-токенов](https://docs.npmjs.com/creating-and-viewing-access-tokens).

Для релиза обновите версию через `npm version X.X.X --no-git-tag-version`,
закоммитьте оба манифеста и влейте PR в `main`. Затем на релизном коммите:

```bash
git switch main
git pull --ff-only origin main
git tag "v$(node -p 'require("./package.json").version')"
git push origin "v$(node -p 'require("./package.json").version')"
```

Тег должен быть новым: существующий `v0.1.0` повторно использовать нельзя.
Workflow `release.yml` проверяет формат `vX.X.X`, совпадение версии в обоих
манифестах и наличие коммита в `origin/main`. После typecheck, сборки и тестов
публикует `@vrata-ai/bb-plugin` в публичный npm. На PR и push в `main` выполняются
только проверки. Публикация использует уже проверенную сборку без повторного `prepack`.
