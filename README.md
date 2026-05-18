# ADEPT — AI Production Studio

Сайт-портфолио ADEPT: AI + CG продакшн для брендов.

## Структура

- `index.html` — главная: hero, тэглайн, асимметричная карусель из 17 кейсов, CTA-форма
- `case.html` — детальная страница кейса, hash-routing (`#dragon`, `#rosatom`, ...)
- `serve.json` — конфиг `serve` (clean URLs)
- `package.json` — `serve` как статический сервер

## Локально

```bash
npm install
npm start
# → http://localhost:3000
```

## Деплой

Railway автоматически подхватывает `npm start`. `PORT` пробрасывается из окружения.
