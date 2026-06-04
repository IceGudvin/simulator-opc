# simulator-opc

OPC UA симулятор датчиков с веб-интерфейсом на FastAPI. Подключается к существующему OPC UA серверу, сканирует папку тегов и эмулирует изменения значений аналоговых датчиков с поддержкой ручных тревог.

## Структура проекта

```
simulator-opc/
├── app.py              # FastAPI backend + логика симулятора
├── static/
│   ├── index.html      # Веб-интерфейс
│   ├── styles.css      # Стили
│   └── app.js          # Фронтенд JS
├── requirements.txt
├── Dockerfile
└── .env.example
```

## Быстрый старт

### Локально

```bash
pip install -r requirements.txt
cp .env.example .env
# отредактируй .env под свой сервер
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Открой в браузере: http://localhost:8000

### Docker

```bash
docker build -t simulator-opc .
docker run -p 8000:8000 --env-file .env simulator-opc
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SERVER_IP` | `127.0.0.1:48010` | Адрес OPC UA сервера (без `opc.tcp://`) |
| `OPCUA_USERNAME` | — | Логин (если требуется) |
| `OPCUA_PASSWORD` | — | Пароль (если требуется) |
| `TARGET_FOLDER` | `IEC_DATA` | Папка в пространстве имён OPC UA |
| `LOW_VALUE` | `0` | Нижняя граница генерации |
| `HIGH_VALUE` | `29696` | Верхняя граница генерации |
| `INTERVAL_MIN` | `60` | Интервал нормальной работы, мин |
| `UPPER_SHIFT_TIME_SEC` | `0` | Длительность верхнего сдвига, сек |
| `LOWER_SHIFT_TIME_SEC` | `0` | Длительность нижнего сдвига, сек |
| `RANDOM_MODE` | `y` | Режим генерации: `y` — случайный, `n` — плавный |
| `RESET_DOUBLES` | `true` | Сбрасывать ли Double-теги в нижнее значение при старте |
| `DEBUG` | `false` | Подробные логи в консоль |

## API

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/status` | Состояние симулятора, список групп |
| `POST` | `/api/connect` | Подключиться и запустить генерацию |
| `POST` | `/api/disconnect` | Остановить генерацию |
| `POST` | `/api/group` | Запустить группу ручных тревог |
| `POST` | `/api/alarms/clear` | Снять все ручные тревоги |
| `POST` | `/api/settings` | Обновить параметры генерации на лету |
