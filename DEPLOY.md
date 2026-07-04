# Развёртывание CEXpreTrader на сервере в Токио

Сервер: **Ubuntu 24.04 LTS, AWS Tokyo (ap-northeast-1)** — рядом с Gate, RTT единицы мс.
Лента и стакан Gate идут по WebSocket (ccxt.pro). Всё read-only/paper — реальные
ордера не выставляются.

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
Ключи **не обязательны**: лента и стакан Gate идут по публичному WebSocket.
Gate API-ключи опциональны (только для точных taker/funding-комиссий). При желании
переопределить параметры движка/сканера `OFM_*`/`SCAN_*` (дефолты рабочие).

## 4. Запуск под pm2

```bash
pm2 start npm --name cexpretrader -- start
pm2 save
pm2 startup          # выполнить выданную команду для автозапуска при ребуте
pm2 logs cexpretrader
```
`npm start` сам поднимает всё: сканер кандидатов (REST по всем перпам, раз в час),
WS-фид Gate, paper-движок order-flow momentum и дашборд. Отдельных шагов нет.

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

- БД растёт в `data/cexpre.db` (`cex_trades` + `of_positions`; в git не коммитится).
- Логи: `pm2 logs cexpretrader`; перезапуск: `pm2 restart cexpretrader`.
- Офлайн-ре-бэктест по накопленной ленте — корневыми `_*.mjs` (запускать на сервере).

## Проверочный чек-лист первого запуска
- [ ] `node -e "const c=require('ccxt'); console.log(!!c.pro.gate)"` → `true`.
- [ ] В логах: `[scan] WS-монитор: N; универсум торговли: K`.
- [ ] В логах растёт `[status] трейдов:… | ofm: сделок …`.
- [ ] `curl -s localhost:3001 | head` отдаёт HTML.
- [ ] Через время — записи в `of_positions` (видны на дашборде).
