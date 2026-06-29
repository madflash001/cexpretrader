# CEXpreTrader

Событийный сканер спреда **DEX ↔ Gate-перп** (read-only, без реальных ордеров).

Ловит уже совершённые свопы V3-пулов в сети через WebSocket Alchemy (цена — прямо
из события `Swap`, поле `sqrtPriceX96`), сравнивает с ценой USDT-перпа на Gate и
логирует виртуальные позиции: открытие при расширении спреда, закрытие при
схождении. Сосед к `DEXArbitrage`, переиспользует его сетевой слой и ccxt-Gate.

## Архитектура

```
Alchemy WSS (ETH/BSC/Base) → dexFeed: Swap → sqrtPriceX96 → цена ─┐
Gate watchOrderBook (ccxt.pro, WebSocket) → cexPriceMap ─────────┴→ spreadEngine
                                                                    FLAT→OPEN→CLOSED (sim)
                                                                         → SQLite → дашборд :3001
```

Семантика: торгуем **только перп** (DEX — сигнал тайминга). `spread = (perpMid −
dexPrice)/dexPrice`. spread>0 → перп дорог → short; spread<0 → long. sim-PnL =
фактическое движение перпа между открытием/закрытием − 2×taker ± funding.

## Требования

- **Ключи Alchemy** (ETH/BSC/Base, все три enabled в приложении) — WSS для
  горячего пути, HTTP для discovery.
- **Сервер рядом с Gate (AWS Tokyo, ap-northeast-1)** — Gate доступен напрямую,
  VPN/прокси не нужны; цены идут по WebSocket с RTT в единицы мс. Развёртывание —
  см. [DEPLOY.md](DEPLOY.md).
- Node ≥ 20. Gate API-ключи опциональны (нужны лишь для точных taker/funding).

## Настройка

```bash
cp .env.example .env
# вписать ALCHEMY_WSS_* / ALCHEMY_HTTP_*. PROXY_* больше нет.
```

## Запуск

```bash
# Запустить сканер + дашборд http://localhost:3001.
# При первом старте (и раз в 7 дней) watchlist собирается автоматически.
npm start

# Пересобрать универсум вручную (опционально):
npm run discover

# Сравнить стратегии по накопленным sim-позициям (можно без сети):
npm run analyze
```

## Сравнение стратегий

`npm start` поднимает по движку на каждую запись из `src/config/strategies.js` —
все видят один поток данных, решают независимо, позиции тегируются `strategy`.
Текущий набор: пороговые `1.0/0.2`, `1.5/0.3`, `2.0/0.4` и mean-reversion по
отклонению спреда от своей EMA (`mr-fast/mid/slow`). `npm run analyze` печатает
сравнительную таблицу (PnL в USD: реализованное + MTM открытых остатков).
Добавить стратегию = одна строка в `strategies.js`. Символы `BTC,ETH` исключены из
универсума как высококонкурентные (`EXCLUDE_SYMBOLS` в `.env`).

Сеть: цены Gate идут по **WebSocket** (ccxt.pro `watchOrderBook`) — нативный `ws`,
без curl. DEX — Alchemy WSS через `ethers.WebSocketProvider`. На сервере в Токио
Gate доступен напрямую, VPN не нужен.

## Статус (фаза 1)

| Этап | Что | Статус |
|---|---|---|
| M1 | Каркас + Gate-фид (WebSocket-стакан) | ✅ live |
| M2 | `buildWatchlist` (пулы ETH/BSC/Base, якорь по цене) | ✅ live (40 символов) |
| M3 | `dexFeed` (WSS Swap → цена, reconnect) | ✅ live |
| M4 | `spreadEngine` (spread + sim-позиции) | ✅ live |
| M5 | Дашборд `:3001` | ✅ live |
| M6 | `analyze` (PnL после издержек) | ✅ проверен |

Первый живой прогон (2026-06-28): watchlist 40 символов (ETH:16/BSC:18/Base:6),
пойман спред ARIA/BSC 0.783% → открылась sim-позиция.

## Важные оговорки

- Сходимость спреда часто происходит **внутри блока**, и до Gate он не доходит —
  смотрите реальную статистику в `analyze`, прежде чем делать выводы.
- Цены Gate идут по WebSocket (живой стакан) — задержка единицы мс на токийском
  сервере; `EXECUTION_LATENCY_MS` моделирует реакцию сигнал→исполнение (дефолт 100).
- Адреса в `src/config/dexRegistry.js` (особенно квотеры/стейблы Base) свериться
  при первом боевом прогоне.
- Вывод о прибыльности — только из `npm run analyze` (нетто после 2×taker +
  funding). «Спред есть» ≠ прибыль.
