# Развёртывание CEXpreTrader на сервере в Токио

Сервер: **Ubuntu 24.04 LTS, AWS Tokyo (ap-northeast-1)** — рядом с Gate, RTT единицы мс,
Gate доступен напрямую (без VPN). Цены Gate идут по WebSocket (ccxt.pro), curl не нужен.

## 1. Node.js и инструменты сборки

Node 22 уже ставится рецептом «Nodejs+Yarn+pm2». Дополнительно — инструменты сборки
на случай, если для нативного `better-sqlite3` не окажется готового бинарника:

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 git
node -v   # ожидаем v22.x
```

## 2. Клонирование и зависимости

```bash
git clone <URL_РЕПОЗИТОРИЯ> cexpretrader
cd cexpretrader
npm install          # соберёт better-sqlite3 под Linux; node_modules с Windows НЕ переносить
```

## 3. Конфигурация

```bash
cp .env.example .env
nano .env
```
Вписать ключи **Alchemy** (`ALCHEMY_WSS_*` и `ALCHEMY_HTTP_*`, все три сети enabled
в приложении Alchemy). Gate-ключи опциональны (только для точных taker/funding).
`PROXY_*` больше нет. Проверить `EXCLUDE_SYMBOLS=BTC,ETH` и `EXECUTION_LATENCY_MS=100`.

## 4. Запуск под pm2

```bash
pm2 start npm --name cexpretrader -- start
pm2 save
pm2 startup          # выполнить выданную команду для автозапуска при ребуте
pm2 logs cexpretrader
```
Отдельный `npm run discover` запускать не нужно — первый `npm start` сам соберёт
watchlist (и пересоберёт автоматически, если он старше 7 дней). Для ручного обновления:
`pm2 stop cexpretrader && npm run discover && pm2 start cexpretrader`.

## 5. Как открыть веб-дашборд (:3001)

VPS обычно **без графической оболочки**, поэтому браузер на сервере ставить не нужно —
открываем дашборд из браузера на своём ПК. По возрастанию сложности:

1. **SSH-туннель (рекомендуется, ничего не ставить).** На своём компьютере:
   ```bash
   ssh -L 3001:localhost:3001 user@SERVER_IP
   ```
   затем открыть в обычном браузере **http://localhost:3001**. Порт наружу не торчит.

2. **Быстрая проверка с самого сервера, что дашборд жив:**
   ```bash
   curl -s localhost:3001 | head
   ```
   (должен прийти HTML). Текстовые браузеры `lynx`/`w3m` не подойдут — дашборд на JS.

3. **Открыть порт наружу** (доступ без туннеля, менее безопасно):
   ```bash
   sudo ufw allow 3001/tcp
   ```
   затем `http://SERVER_IP:3001`. Лучше ограничить правило своим IP
   (`sudo ufw allow from <ВАШ_IP> to any port 3001`) или закрыть реверс-прокси с авторизацией.

4. **Графический браузер прямо на сервере (не рекомендуется).** Требует десктоп-
   окружение и VNC — для VPS избыточно:
   ```bash
   sudo apt-get install -y firefox xfce4 tightvncserver
   vncserver :1            # задать пароль, подключиться VNC-клиентом с ПК
   # в сессии VNC открыть Firefox на http://localhost:3001
   ```
   Тяжело ради одного дашборда — вариант 1 почти всегда лучше.

## 6. Эксплуатация

- БД растёт в `data/cexpre.db` (в git не коммитится).
- Логи: `pm2 logs cexpretrader`; перезапуск: `pm2 restart cexpretrader`.
- Анализ накопленных sim-позиций: `npm run analyze`.
- Бэктест по сохранённым тикам: `npm run backtest`.

## Проверочный чек-лист первого запуска
- [ ] `node -e "const c=require('ccxt'); console.log(!!c.pro.gate)"` → `true`.
- [ ] В логах: «watchlist пуст — собираю символы…», затем непустой watchlist
      (ETH/BSC/Base), и **BTC/ETH отсутствуют**.
- [ ] В логах: «WS-стакан по N перпам (ccxt.pro)», идут DEX-тики, растёт `[status]`.
- [ ] `curl -s localhost:3001 | head` отдаёт HTML.
- [ ] Через время — записи в `sim_positions` (`npm run analyze`).
