#!/usr/bin/env bash
set -euo pipefail

APP_NAME="opcua-sim-web"
DEFAULT_TAG="1.0"
ARCHIVE_DIR="dist"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
STATIC_DIR="static"

TAG="${1:-$DEFAULT_TAG}"
IMAGE="${APP_NAME}:${TAG}"
ARCHIVE_NAME="${APP_NAME}_${TAG}.tar"
ARCHIVE_PATH="${ARCHIVE_DIR}/${ARCHIVE_NAME}"
PACKAGE_DIR="${ARCHIVE_DIR}/package_${TAG}"
FINAL_TGZ="${ARCHIVE_DIR}/${APP_NAME}_${TAG}_bundle.tar.gz"

printf '\n[1/6] Проверка файлов проекта...\n'
for f in "$COMPOSE_FILE" "Dockerfile" "app.py" "requirements.txt"; do
  if [[ ! -f "$f" ]]; then
    echo "Ошибка: не найден файл $f"
    exit 1
  fi
done

if [[ ! -d "$STATIC_DIR" ]]; then
  echo "Ошибка: не найдена папка $STATIC_DIR"
  echo "Для веб-версии со статическим фронтендом должны существовать файлы:"
  echo "  static/index.html"
  echo "  static/app.js"
  echo "  static/styles.css"
  exit 1
fi

for f in "$STATIC_DIR/index.html" "$STATIC_DIR/app.js" "$STATIC_DIR/styles.css"; do
  if [[ ! -f "$f" ]]; then
    echo "Ошибка: не найден файл $f"
    exit 1
  fi
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Предупреждение: файл .env не найден. Будут использованы только значения по умолчанию из приложения."
fi

mkdir -p "$ARCHIVE_DIR"

printf '\n[2/6] Сборка образа %s ...\n' "$IMAGE"
docker build -t "$IMAGE" .

printf '\n[3/6] Проверка доступности образа...\n'
docker image inspect "$IMAGE" >/dev/null

printf '\n[4/6] Сохранение образа в архив %s ...\n' "$ARCHIVE_PATH"
docker save -o "$ARCHIVE_PATH" "$IMAGE"

printf '\n[5/6] Создание пакета с compose, env и static...\n'
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"
cp "$COMPOSE_FILE" "$PACKAGE_DIR/"
cp "Dockerfile" "$PACKAGE_DIR/"
cp "requirements.txt" "$PACKAGE_DIR/"
cp "app.py" "$PACKAGE_DIR/"
cp -r "$STATIC_DIR" "$PACKAGE_DIR/"
if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$PACKAGE_DIR/"
fi
cp "$ARCHIVE_PATH" "$PACKAGE_DIR/"

cat > "$PACKAGE_DIR/README.txt" <<EOF
Сборка образа: $IMAGE

Что внутри:
- ${ARCHIVE_NAME} — архив docker image
- docker-compose.yml
- Dockerfile
- requirements.txt
- app.py
- static/ (index.html, app.js, styles.css)
- .env (если был в проекте)

Как загрузить на другой машине:
1. docker load -i ${ARCHIVE_NAME}
2. docker compose up -d

Как пересобрать локально:
./build_opcua_web.sh ${TAG}

Если меняется фронт, обязательно проверяй наличие папки static/ в пакете.
EOF

tar -czf "$FINAL_TGZ" -C "$ARCHIVE_DIR" "package_${TAG}"

printf '\n[6/6] Готово.\n'
echo "Образ: $IMAGE"
echo "Архив образа: $ARCHIVE_PATH"
echo "Пакет для переноса: $FINAL_TGZ"
echo

echo "Полезные команды:"
echo "  Запустить локально: docker compose up --build -d"
echo "  Загрузить образ:    docker load -i ${ARCHIVE_NAME}"
echo "  Проверить образы:   docker images | grep ${APP_NAME}"
