# CEXpreTrader — план сканера (фаза 1, без реальных сделок)

## Контекст

Новый проект-сосед к `C:\claude\DEXArbitrage`. Идея — «вариант 2» из обсуждения:
ловить **уже совершённые** свопы в сети (push, не polling), сравнивать DEX-цену
токена с ценой **USDT-перпа на Gate**, и логировать моменты, когда спред
расширяется и затем сходится. Сейчас — **только сканер возможностей**, без ордеров.

Принципиальное отличие от DEXArbitrage: тот **опрашивает** slot0/1inch по таймеру
(5–30 с). CEXpreTrader — **событийный**: подписка на лог `Swap` через WebSocket
Alchemy, цена пересчитывается в момент свопа. Приоритет — скорость получения данных.

**Решения (из ответов пользователя):**
- RPC-провайдер: **Alchemy** (WSS, по одному соединению на сеть).
- Сети: **Ethereum (1), BSC (56), Base (8453)**.
- Универсум: только символы, у которых есть **USDT-перп на Gate** И токен на одной
  из этих сетей (пересечение с Gate).

## Ключевая техническая находка

Событие Uniswap/Pancake **V3** `Swap` уже содержит постсвоповую цену:
```
Swap(address sender, address recipient, int256 amount0, int256 amount1,
     uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
```
→ `sqrtPriceX96` из события напрямую идёт в существующую `spotPrice()` — **новая
DEX-цена без единого доп. RPC-запроса**. Это идеально под «приоритет скорости».
Поэтому v1 работает **только с V3-пулами** (Uniswap V3 на ETH/Base, Pancake V3 на
BSC). V2-стиль (требует резервов) — отложить.

## Архитектура

```
                          ┌─────────────────────────────┐
  Alchemy WSS (ETH)  ──►  │  DEX event feed (per chain)  │
  Alchemy WSS (BSC)  ──►  │  eth_subscribe logs:         │
  Alchemy WSS (Base) ──►  │  {address:[пулы], topic:Swap}│
                          │  decode sqrtPriceX96 →       │
                          │  spotPrice() → dexPrice      │
                          └──────────────┬──────────────┘
                                         ▼
  Gate REST poll ~1s   ──►  cexPriceMap[symbol]   ──►  spread engine
  (ccxt, через curl+proxy)  {bid,ask,last,mark}        spread=(cex-dex)/dex
                                         │              open/close по порогам
                                         ▼
                                   SQLite (ticks, sim-позиции)  ──► (опц.) дашборд
```

- **DEX feed** идёт к Alchemy **напрямую** (не Gate → прокси не нужен). WSS — это
  поток мелких фреймов, проблема «Node виснет на крупных TLS-ответах» его не
  задевает (это про единичные большие HTTP-ответы, не про WS). Проверить на старте.
- **Gate** забанил IP → его REST идёт через `curl + VPN-прокси` (механизм уже готов
  в `_curlnet.mjs`). Для v1 цена перпа — **поллинг `fetchTickers` ~1 с**; этого
  достаточно, т.к. сигнал определяется скоростью детекта DEX-движения, а перп
  меняется медленнее. Gate-WS через proxy-agent — оптимизация v2.

## Что переиспользуем из DEXArbitrage (копировать/адаптировать)

| Файл-источник | Назначение | Действие |
|---|---|---|
| `_curlnet.mjs` | Gate→прокси, ethers-RPC→напрямую через curl | копировать как есть |
| `src/connectors/cexFactory.js` | ccxt Gate: `listContracts`, `fetchTickers`, `getEvmAddresses`, `takerFee`, `fetchFundingRates` | копировать (уже есть `type:'swap'`) |
| `src/config/chains.js` | `GATE_NETWORK_TO_CHAINID`, `CHAIN_PRIORITY=[1,56,8453]`, `CHAIN_STABLE`, `evmAddressesFromNetworks` | копировать — это **ровно** нужные 3 сети |
| `src/connectors/pancakeV3.js` | `discoverPools`, `readDecimals`, `isTokenFirst`, multicall-чанкер | обобщить под per-chain factory/quoter |
| `src/core/priceEngine.js` → `spotPrice()` | sqrtPriceX96 → цена в USDT | копировать как есть (ядро расчёта) |
| `src/commands/discoverFutures.js` | перп Gate → токен → выбор сети «якорем по цене» | адаптировать: на выходе нужен **poolAddress**, не только адрес токена |
| `src/storage/db.js` | паттерн SQLite (WAL, prepared, миграции) | копировать паттерн, новые таблицы |
| `src/server/{api,ws}.js` | дашборд Express+WS | опционально, для визуализации |

## Что пишем заново

1. **`src/config/dexRegistry.js`** — per-chain параметры V3:
   - ETH(1): Uniswap V3 factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`,
     QuoterV2, feeTiers `[100,500,3000,10000]`, USDC из `CHAIN_STABLE`.
   - BSC(56): Pancake V3 (адреса уже в `config/dex.js`).
   - Base(8453): Uniswap V3 factory (тот же `0x1F98...`), QuoterV2.
   - Multicall3 `0xcA11...` — один адрес на всех трёх сетях.

2. **`src/discovery/buildWatchlist.js`** — расширение `discoverFutures`:
   перп Gate → токен с адресом на ETH/BSC/Base → `discoverPools` на якорной сети →
   выбрать самый ликвидный V3-пул → запись `{symbol, chainId, poolAddress, tokenAddr,
   decimals, tokenIsFirst, fee}`. Сохранить в таблицу `watchlist`. Запуск раз в час
   (новые листинги) либо отдельной командой `npm run discover`.

3. **`src/feed/dexFeed.js`** — ядро. По одному `ethers.WebSocketProvider` на сеть
   (URL Alchemy из env). Подписка `provider.on(filter)` где
   `filter = { address: [пулы этой сети], topics: [SWAP_TOPIC] }`. На событие:
   decode → `sqrtPriceX96` → `spotPrice(...)` → emit `{symbol, chainId, dexPrice, ts}`.
   Reconnect при разрыве сокета + ресабскрайб; при реконнекте — пометка возможного
   пропуска (для сканера некритично).

4. **`src/feed/gateFeed.js`** — таймер ~1 с: `gateFutures.fetchTickers(symbols)` →
   обновляет in-memory `cexPriceMap`. Раз в N минут — `fetchFundingRates`.

5. **`src/core/spreadEngine.js`** — на каждый DEX-тик: считает
   `spread=(cexMid-dexPrice)/dexPrice`. Машина состояний на символ:
   - `FLAT → OPEN` когда `|spread| ≥ OPEN_THRESHOLD` (виртуальное открытие, запись);
   - `OPEN → CLOSED` когда `|spread| ≤ CLOSE_THRESHOLD` (запись round-trip).
   PnL симулируется: спред на открытии − спред на закрытии − 2×taker − funding.
   Реальных ордеров нет.

6. **`src/storage/db.js`** — новые таблицы:
   - `watchlist(symbol, chain_id, pool_address, token_address, decimals, token_is_first, fee, created_ts)`
   - `spread_ticks(ts, symbol, chain_id, dex_price, cex_bid, cex_ask, spread_pct)` — сырьё для анализа
   - `sim_positions(symbol, opened_ts, closed_ts, open_spread_pct, close_spread_pct, sim_pnl_pct, taker_fee_pct, funding_pct, status)`

7. **`src/index.js`** — оркестрация: `db.init()` → загрузить watchlist → старт
   gateFeed + dexFeed (3 сети) → подписать spreadEngine на события → (опц.) дашборд.

8. **`.env`** (по образцу DEXArbitrage `config/env.js`):
   ```
   ALCHEMY_WSS_ETH=wss://eth-mainnet.g.alchemy.com/v2/<KEY>
   ALCHEMY_WSS_BSC=wss://bnb-mainnet.g.alchemy.com/v2/<KEY>
   ALCHEMY_WSS_BASE=wss://base-mainnet.g.alchemy.com/v2/<KEY>
   PROXY_URL=http://127.0.0.1:10809      # для Gate
   PROXY_HOSTS=gateio.ws
   GATE_API_KEY=...   GATE_API_SECRET=...  # опц.; ключи для точных комиссий
   OPEN_THRESHOLD_PCT=0.5   CLOSE_THRESHOLD_PCT=0.1
   GATE_POLL_MS=1000        DB_PATH=./data/cexpre.db   WEB_PORT=3001
   ```

## Этапы (инкрементально, каждый проверяем)

- **M1 — каркас + Gate.** Проект, `_curlnet.mjs`, ccxt-Gate через прокси,
  `listContracts`/`fetchTickers` печатают цены перпов. Проверка: видим живые цены.
- **M2 — watchlist.** `buildWatchlist` строит и сохраняет пулы по 3 сетям.
  Проверка: в БД N символов с poolAddress, разбивка по сетям в логе.
- **M3 — DEX feed.** Подписка Alchemy на `Swap` по пулам; в лог сыпятся
  `symbol/chain/dexPrice` в реальном времени. **Главная проверка скорости/стабильности.**
- **M4 — spread engine + запись.** Считаем спред, пишем `spread_ticks` и
  `sim_positions`. Проверка: открытия/закрытия логируются с корректным знаком.
- **M5 (опц.) — дашборд** на Express+WS (порт 3001): таблица live-спредов + история.
- **M6 — анализ.** Скрипт по `sim_positions`: частота, медианный/суммарный
  sim-PnL **после** комиссий и funding. Это и есть ответ «прибыльна ли идея».

## Риски и реализм (коротко)

- **Сходимость внутри блока.** Часто арб-боты выравнивают цену в том же блоке, и до
  Gate расширенный спред не доходит. `spread_ticks` это покажет — фильтр идеи.
- **Свежесть Gate.** Поллинг 1 с огрубляет CEX-сторону; для сканера ок, для боевой
  торговли — нужен Gate-WS (v2).
- **Стабильность WSS.** Alchemy рвёт сокеты → обязателен reconnect+resubscribe.
- **Издержки решают.** Вывод о прибыльности — только из M6 (нетто после
  2×taker + funding + проскальзывание). На бумаге «спред есть» ≠ прибыль.
- **Ниша.** Шанс edge — на менее ликвидных символах Gate, не на ETH/USDC-классе.

## Верификация

1. `npm run discover` → в БД непустой `watchlist` с разбивкой ETH/BSC/Base.
2. `npm start` → в логе идут live `Swap`-тики (M3) и цены Gate (M1) одновременно.
3. Спровоцировать/дождаться расширения спреда → запись в `sim_positions` с
   парой open/close и ненулевым `sim_pnl_pct`.
4. Через несколько часов сбора — прогнать скрипт анализа M6; смотрим, остаётся ли
   нетто-PnL положительным после всех вычетов.

## Открытые вопросы (не блокируют старт, решим по ходу)

- Один пул на символ (якорная сеть) vs несколько пулов/тиров на символ. v1 — один.
- Нужен ли дашборд в v1 или достаточно логов+SQLite (M5 опционально).
- Gate цена: поллинг (v1) vs WS-через-proxy (v2).
