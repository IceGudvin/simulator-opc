import argparse
import asyncio
import os
import random
import threading
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from opcua import Client, ua
from opcua.ua.uaerrors import BadWriteNotSupported

load_dotenv()

def str_to_bool(value, default=False):
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")

parser = argparse.ArgumentParser(description="Веб-панель OPC UA эмулятора")
parser.add_argument("--debug", action="store_true", help="Включить режим отладки")
parser.add_argument("--env-file", default=None, help="Путь к env-файлу")
args, _ = parser.parse_known_args()

if args.env_file:
    load_dotenv(args.env_file, override=True)

DEBUG = args.debug or str_to_bool(os.getenv("DEBUG", "false"))

TARGET_FOLDER = os.getenv("TARGET_FOLDER", "IEC_DATA")
USERNAME = os.getenv("OPCUA_USERNAME") or None
PASSWORD = os.getenv("OPCUA_PASSWORD") or None
RESET_DOUBLES = str_to_bool(os.getenv("RESET_DOUBLES", "true"), default=True)
DEFAULT_LOW = float(os.getenv("LOW_VALUE", "0"))
DEFAULT_HIGH = float(os.getenv("HIGH_VALUE", "29696"))
DEFAULT_INTERVAL = float(os.getenv("INTERVAL_MIN", "60"))
DEFAULT_UPPER = float(os.getenv("UPPER_SHIFT_TIME_SEC", "0"))
DEFAULT_LOWER = float(os.getenv("LOWER_SHIFT_TIME_SEC", "0"))
DEFAULT_SERVER_IP = os.getenv("SERVER_IP", "127.0.0.1:48010")
DEFAULT_RANDOM = os.getenv("RANDOM_MODE", "y").lower()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

REQUIRED_SUFFIXES = [
    "IN", "IN_HSC", "IN_LSC", "OUT_HSC", "OUT_LSC",
    "HHALIM", "HALIM", "LALIM", "LLALIM",
]

def debug_print(msg):
    if DEBUG:
        print(msg, flush=True)

def is_node_operational(node):
    try:
        data_value = node.get_data_value()
        return data_value.StatusCode.name != "BadOutOfService"
    except Exception as e:
        debug_print(f"Ошибка чтения статуса узла {node}: {e}")
        return False

def reset_double_to_zero(node, access_level, data_type, low_value):
    if not is_node_operational(node):
        return False
    if data_type == ua.VariantType.Double and (access_level & ua.AccessLevel.CurrentWrite):
        try:
            node.set_value(ua.DataValue(ua.Variant(low_value, ua.VariantType.Double)))
            return True
        except Exception as e:
            debug_print(f"[Сброс] Ошибка для {node}: {e}")
    if data_type == ua.VariantType.Float and (access_level & ua.AccessLevel.CurrentWrite):
        try:
            node.set_value(ua.DataValue(ua.Variant(low_value, ua.VariantType.Float)))
            return True
        except Exception as e:
            debug_print(f"[Сброс] Ошибка для {node}: {e}")
    return False

def _nodeid_str(node):
    try:
        return node.nodeid.to_string()
    except Exception:
        return str(node)

def _build_path(parent_path, browse_name):
    return browse_name if not parent_path else f"{parent_path}/{browse_name}"

def _safe_node_value(node):
    try:
        value = node.get_value()
        if isinstance(value, float):
            return round(value, 3)
        if isinstance(value, int):
            return value
        return str(value)
    except Exception as e:
        debug_print(f"Ошибка чтения значения {node}: {e}")
        return None

def get_nodes_for_sensors(client, folder_name):
    """
    Сканирует дерево OPC UA начиная с папки folder_name.

    Группировка по group_key = полный путь до папки-родителя тега + entity_key.
    entity_key = часть browse_name до последней точки (AI001 из AI001.IN).

    ВАЖНО: group_key включает полный путь (current_path), поэтому датчики
    с одинаковым именем в разных папках (OPC_AIN_1 в Station1 и Station2)
    — это РАЗНЫЕ группы и попадут в симулятор как отдельные датчики.
    Дублями считаются только теги с одинаковым суффиксом внутри одной группы
    (одна и та же физическая точка с двумя nodeId) — из них берётся первый.
    """
    sensors = []
    try:
        root = client.get_root_node()
        objects = root.get_child(["0:Objects"])
        target_folder = None
        for child in objects.get_children():
            if child.get_browse_name().Name == folder_name:
                target_folder = child
                break
        if not target_folder:
            debug_print(f"Папка '{folder_name}' не найдена")
            return sensors

        # groups: group_key → dict с тегами и метаданными
        groups = {}
        nodes_to_scan = [(target_folder, folder_name)]
        total_variables = 0

        while nodes_to_scan:
            current_node, current_path = nodes_to_scan.pop()
            for child in current_node.get_children():
                try:
                    browse_name = child.get_browse_name().Name
                    node_class = child.get_node_class().name
                    child_path = _build_path(current_path, browse_name)

                    if node_class == "Object":
                        nodes_to_scan.append((child, child_path))
                        continue
                    if node_class != "Variable":
                        continue

                    total_variables += 1
                    upper_name = browse_name.upper()

                    if "." not in upper_name:
                        continue

                    # Делим по последней точке:
                    #   "OPC_AIN_1.IN"     → entity_key="OPC_AIN_1", suffix="IN"
                    #   "UNIT.AI001.IN_HSC" → entity_key="UNIT.AI001", suffix="IN_HSC"
                    entity_key, suffix = upper_name.rsplit(".", 1)

                    if suffix not in REQUIRED_SUFFIXES:
                        continue

                    # Ключ группы = папка-родитель + entity_key.
                    # Два тега OPC_AIN_1.IN в разных папках (Station1 vs Station2)
                    # получат разные group_key и не смешаются.
                    group_key = f"{current_path}/{entity_key}"

                    group = groups.setdefault(group_key, {
                        "name": entity_key.split(".")[-1],   # последний сегмент для отображения
                        "entity_key": entity_key,
                        "path": current_path,
                        "full_path": group_key,
                        "parent_path": current_path,
                        "tags": {},      # suffix → node
                        "nodeids": {},   # suffix → str
                        "entities": [], # все теги для UI
                    })

                    entity_info = {
                        "suffix": suffix,
                        "tag_name": browse_name,
                        "entity_key": entity_key,
                        "path": child_path,
                        "group_path": group_key,
                        "nodeid": _nodeid_str(child),
                        "node": child,
                    }
                    group["entities"].append(entity_info)

                    if suffix in group["tags"]:
                        # Настоящий дубль: тот же суффикс в той же папке с тем же именем.
                        # Оставляем первый найденный — они ссылаются на одну точку.
                        debug_print(
                            f"Дубль суффикса {suffix} в группе {group_key}: "
                            f"оставляем {group['nodeids'][suffix]}, "
                            f"пропускаем {_nodeid_str(child)}"
                        )
                        continue

                    group["tags"][suffix] = child
                    group["nodeids"][suffix] = _nodeid_str(child)

                except Exception as e:
                    debug_print(f"Ошибка обработки узла {child}: {e}")

        incomplete = 0
        for group_key, group in groups.items():
            missing = [s for s in REQUIRED_SUFFIXES if s not in group["tags"]]
            if missing:
                incomplete += 1
                debug_print(f"Неполная группа {group_key}: отсутствуют {', '.join(missing)}")
                continue

            entities_sorted = sorted(
                group["entities"],
                key=lambda x: (x["suffix"], x["path"], x["nodeid"])
            )
            nodes_dict = {s: group["tags"][s] for s in REQUIRED_SUFFIXES}
            nodes_dict["node"]         = group["tags"]["IN"]
            nodes_dict["name"]         = group["name"]
            nodes_dict["path"]         = group["full_path"]
            nodes_dict["nodeid"]       = group["nodeids"]["IN"]
            nodes_dict["entity_key"]   = group["entity_key"]
            nodes_dict["entity_count"] = len(entities_sorted)
            nodes_dict["entities"]     = entities_sorted
            sensors.append(nodes_dict)

        debug_print(
            f"Сканирование завершено: variables={total_variables}, "
            f"groups={len(groups)}, complete={len(sensors)}, incomplete={incomplete}"
        )
    except Exception as e:
        debug_print(f"Ошибка сканирования папки: {e}")
    return sensors

def write_node_value(node, value, data_type):
    if not is_node_operational(node):
        return False
    try:
        variant = ua.Variant(value, data_type)
        dv = ua.DataValue(variant)
        dv.ServerTimestamp = None
        dv.SourceTimestamp = None
        node.set_value(dv)
        return True
    except BadWriteNotSupported:
        debug_print("Сервер не поддерживает запись этого типа данных")
    except Exception as e:
        debug_print(f"Ошибка записи: {e}")
    return False


class AnalogSensorSimulator:
    def __init__(self, nodes_dict, low, high, interval_min, upper_shift_time_sec, lower_shift_time_sec, random_mode):
        self.name          = nodes_dict.get("name", "UNKNOWN")
        self.path          = nodes_dict.get("path", self.name)
        self.entity_key    = nodes_dict.get("entity_key", self.name)
        self.source_nodeid = nodes_dict.get("nodeid", "")
        self.entities      = nodes_dict.get("entities", [])
        self.entity_count  = nodes_dict.get("entity_count", len(self.entities))
        self.node          = nodes_dict.get("node")
        self.IN_HSC  = nodes_dict.get("IN_HSC")
        self.IN_LSC  = nodes_dict.get("IN_LSC")
        self.OUT_HSC = nodes_dict.get("OUT_HSC")
        self.OUT_LSC = nodes_dict.get("OUT_LSC")
        self.HHALIM  = nodes_dict.get("HHALIM")
        self.HALIM   = nodes_dict.get("HALIM")
        self.LALIM   = nodes_dict.get("LALIM")
        self.LLALIM  = nodes_dict.get("LLALIM")
        self.interval_sec       = interval_min * 60
        self.upper_shift_time   = upper_shift_time_sec
        self.lower_shift_time   = lower_shift_time_sec
        self.random_mode        = random_mode
        self.manual_alarm       = None
        self.manual_alarm_until = 0
        self.last_active_state  = "normal"
        self.in_lsc_val  = self._safe_get(self.IN_LSC,  0.0)
        self.in_hsc_val  = self._safe_get(self.IN_HSC,  1.0)
        self.out_lsc_val = self._safe_get(self.OUT_LSC, low)
        self.out_hsc_val = self._safe_get(self.OUT_HSC, high)
        halim_val  = self._safe_get(self.HALIM,  high)
        lalim_val  = self._safe_get(self.LALIM,  low)
        hhalim_val = self._safe_get(self.HHALIM, halim_val)
        llalim_val = self._safe_get(self.LLALIM, lalim_val)
        self.normal_work_low   = lalim_val
        self.normal_work_high  = halim_val
        self.upper_work_low    = halim_val
        self.upper_work_high   = hhalim_val
        self.lower_work_low    = llalim_val
        self.lower_work_high   = lalim_val
        span    = self.out_hsc_val - self.out_lsc_val
        reserve = max(abs(span) * 0.05, 0.001)
        self.crit_high_low  = max(hhalim_val, self.upper_work_high)
        self.crit_high_high = max(self.out_hsc_val, self.crit_high_low + reserve)
        self.crit_low_high  = min(llalim_val, self.lower_work_low)
        self.crit_low_low   = min(self.out_lsc_val, self.crit_low_high - reserve)
        self.current_value  = (self.normal_work_low + self.normal_work_high) / 2
        self.internal_value = self.inverse_scale_output_to_input(self.current_value)
        self.state            = "normal"
        self.state_start_time = time.time()
        self._tick = 0

    def _safe_get(self, node, default):
        try:
            if node:
                return float(node.get_value())
        except Exception:
            pass
        return float(default)

    def inverse_scale_output_to_input(self, current_value):
        if self.out_hsc_val == self.out_lsc_val:
            return self.in_lsc_val
        scale = (current_value - self.out_lsc_val) / (self.out_hsc_val - self.out_lsc_val)
        return self.in_lsc_val + scale * (self.in_hsc_val - self.in_lsc_val)

    def trigger_manual_alarm(self, alarm_type, duration):
        self.manual_alarm       = alarm_type
        self.manual_alarm_until = time.time() + float(duration)

    def clear_manual_alarm(self):
        self.manual_alarm       = None
        self.manual_alarm_until = 0

    def get_active_range(self):
        now = time.time()
        if self.manual_alarm and now < self.manual_alarm_until:
            if self.manual_alarm == "warn_high":
                self.last_active_state = "manual_warn_high"
                return self.upper_work_low, self.upper_work_high
            if self.manual_alarm == "warn_low":
                self.last_active_state = "manual_warn_low"
                return self.lower_work_low, self.lower_work_high
            if self.manual_alarm == "crit_high":
                self.last_active_state = "manual_crit_high"
                return self.crit_high_low, self.crit_high_high
            if self.manual_alarm == "crit_low":
                self.last_active_state = "manual_crit_low"
                return self.crit_low_low, self.crit_low_high
        if self.manual_alarm and now >= self.manual_alarm_until:
            self.clear_manual_alarm()
        elapsed = now - self.state_start_time
        if self.state == "normal" and elapsed >= self.interval_sec:
            self.state = random.choice(["upper_shift", "lower_shift"])
            self.state_start_time = now
        elif self.state == "upper_shift" and elapsed >= self.upper_shift_time:
            self.state = "normal"
            self.state_start_time = now
        elif self.state == "lower_shift" and elapsed >= self.lower_shift_time:
            self.state = "normal"
            self.state_start_time = now
        if self.state == "normal":
            self.last_active_state = "normal"
            return self.normal_work_low, self.normal_work_high
        if self.state == "upper_shift":
            self.last_active_state = "upper_shift"
            return self.upper_work_low, self.upper_work_high
        self.last_active_state = "lower_shift"
        return self.lower_work_low, self.lower_work_high

    def build_entities_status(self):
        entities = []
        for item in self.entities:
            node = item.get("node")
            current_value = _safe_node_value(node) if node else None
            entities.append({
                "tag_name": item.get("tag_name") or "-",
                "suffix":   item.get("suffix")   or "-",
                "value":    current_value,
                "nodeid":   item.get("nodeid")   or "-",
                "path":     item.get("path")     or "-",
            })
        return entities

    async def update(self, stop_event):
        while not stop_event.is_set():
            try:
                work_low, work_high = self.get_active_range()
                if self.random_mode == "y":
                    self.current_value = random.uniform(work_low, work_high)
                else:
                    target = (work_low + work_high) / 2
                    self.current_value += (target - self.current_value) * 0.1
                self.current_value  = max(work_low, min(self.current_value, work_high))
                self.internal_value = self.inverse_scale_output_to_input(self.current_value)
                write_ok = write_node_value(
                    self.node,
                    self.internal_value,
                    self.node.get_data_type_as_variant_type(),
                )
                self._tick += 1
                if DEBUG and self._tick % 5 == 0:
                    debug_print(
                        f"[{self.name}] state={self.last_active_state} "
                        f"out={self.current_value:.3f} in={self.internal_value:.3f} "
                        f"write_ok={write_ok} node={self.source_nodeid}"
                    )
            except Exception as e:
                debug_print(f"Ошибка в обновлении датчика {self.name}: {e}")
            await asyncio.sleep(1)


class Backend:
    def __init__(self):
        self.client        = None
        self.sensors       = []
        self.connected     = False
        self.connecting    = False
        self.stop_event    = threading.Event()
        self.loop          = None
        self.worker_thread = None
        self.params = {
            "server_url":       f"opc.tcp://{DEFAULT_SERVER_IP}",
            "low":              DEFAULT_LOW,
            "high":             DEFAULT_HIGH,
            "interval":         DEFAULT_INTERVAL,
            "upper_shift_time": DEFAULT_UPPER,
            "lower_shift_time": DEFAULT_LOWER,
            "random_mode":      DEFAULT_RANDOM if DEFAULT_RANDOM in ("y", "n") else "y",
        }
        self.lock = threading.Lock()
        self.logs = []

    def log(self, message):
        line = f"[{time.strftime('%H:%M:%S')}] {message}"
        self.logs.append(line)
        self.logs = self.logs[-300:]
        print(line, flush=True)

    def status(self):
        with self.lock:
            rows   = []
            groups = []
            now    = time.time()
            total_entities  = 0
            active_entities = 0
            for idx, sensor in enumerate(self.sensors):
                remaining = max(0, int(sensor.manual_alarm_until - now)) if sensor.manual_alarm else 0
                entities  = sensor.build_entities_status()
                total_entities += len(entities)
                if sensor.manual_alarm:
                    active_entities += len(entities)
                base_row = {
                    "idx":               idx,
                    "name":              sensor.name,
                    "path":              sensor.path,
                    "entity_key":        sensor.entity_key,
                    "nodeid":            sensor.source_nodeid,
                    "value":             round(sensor.current_value, 3),
                    "state":             sensor.last_active_state,
                    "manual_alarm":      sensor.manual_alarm or "-",
                    "remaining":         remaining,
                    "mode":              sensor.random_mode,
                    "entity_count":      sensor.entity_count,
                    "active_entity_count": len(entities) if sensor.manual_alarm else 0,
                }
                rows.append(base_row)
                groups.append({**base_row, "entities": entities})
            return {
                "connected":       self.connected,
                "connecting":      self.connecting,
                "total":           len(self.sensors),
                "active":          sum(1 for s in self.sensors if s.manual_alarm),
                "total_entities":  total_entities,
                "active_entities": active_entities,
                "params":          self.params,
                "logs":            self.logs[-80:],
                "rows":            rows,
                "groups":          groups,
            }

    def connect(self, params):
        with self.lock:
            if self.connecting:
                return False, "Подключение уже выполняется"
            if self.worker_thread and self.worker_thread.is_alive():
                return False, "Эмулятор уже запущен"
        self.params = params
        self.stop_event.clear()
        self.connecting = True
        self.connected  = False
        self.log("Получена команда на запуск из веб-интерфейса")
        self.worker_thread = threading.Thread(target=self._run_loop, daemon=True)
        self.worker_thread.start()
        return True, "Запуск отправлен"

    def disconnect(self):
        self.stop_event.set()
        self.log("Остановка эмулятора запрошена")
        return True, "Остановка запрошена"

    def _run_loop(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._async_main())
        except Exception as e:
            self.log(f"Фоновая ошибка: {e}")
        finally:
            try:
                pending = asyncio.all_tasks(self.loop)
                for task in pending:
                    task.cancel()
                if pending:
                    self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception:
                pass
            try:
                self.loop.close()
            except Exception:
                pass
            self.loop = None
        with self.lock:
            self.connected  = False
            self.connecting = False
            self.sensors    = []
        self.log("Эмулятор остановлен")

    async def _async_main(self):
        url         = self.params["server_url"]
        low         = self.params["low"]
        high        = self.params["high"]
        interval    = self.params["interval"]
        upper_shift = self.params["upper_shift_time"]
        lower_shift = self.params["lower_shift_time"]
        mode        = self.params["random_mode"]
        client = None
        try:
            client = Client(url, timeout=5)
            if USERNAME and PASSWORD:
                client.set_user(USERNAME)
                client.set_password(PASSWORD)
            self.client = client
            self.log(f"Подключение к {url}...")
            client.connect()
            self.log("Подключение успешно")
            nodes_dicts = get_nodes_for_sensors(client, TARGET_FOLDER)
            if not nodes_dicts:
                self.log(f"В папке {TARGET_FOLDER} не найдено датчиков")
                return
            if RESET_DOUBLES:
                for nd in nodes_dicts:
                    try:
                        reset_double_to_zero(
                            nd["node"],
                            nd["node"].get_attribute(ua.AttributeIds.UserAccessLevel).Value.Value,
                            nd["node"].get_data_type_as_variant_type(),
                            low,
                        )
                    except Exception as e:
                        debug_print(f"Ошибка сброса для узла {nd['node']}: {e}")
            sensors = [
                AnalogSensorSimulator(nd, low, high, interval, upper_shift, lower_shift, mode)
                for nd in nodes_dicts
            ]
            with self.lock:
                self.sensors    = sensors
                self.connected  = True
                self.connecting = False
            self.log(f"Найдено датчиков: {len(sensors)}")
            tasks = [asyncio.create_task(sensor.update(self.stop_event)) for sensor in sensors]
            try:
                while not self.stop_event.is_set():
                    await asyncio.sleep(1)
            finally:
                self.stop_event.set()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except Exception as e:
            with self.lock:
                self.connected  = False
                self.connecting = False
            self.log(f"Ошибка запуска: {e}")
        finally:
            if client is not None:
                try:
                    client.disconnect()
                    self.log("Отключено от сервера")
                except Exception as e:
                    self.log(f"Ошибка отключения: {e}")
                self.client = None

    def choose_alarm_type(self, mode):
        if mode == "warn":
            return random.choice(["warn_high", "warn_low"])
        if mode == "crit":
            return random.choice(["crit_high", "crit_low"])
        return random.choice(["warn_high", "warn_low", "crit_high", "crit_low"])

    def trigger_group(self, count, mode, duration):
        with self.lock:
            if not self.connected or not self.sensors:
                return False, "Нет активных датчиков"
            if count <= 0:
                return False, "count должен быть больше 0"
            selected = random.sample(self.sensors, min(count, len(self.sensors)))
            for sensor in selected:
                sensor.trigger_manual_alarm(self.choose_alarm_type(mode), duration)
            self.log(
                f"Запущена группа alarm: count={min(count, len(self.sensors))}, "
                f"mode={mode}, duration={duration} сек"
            )
            return True, "Группа запущена"

    def stop_alarms(self):
        with self.lock:
            for sensor in self.sensors:
                sensor.clear_manual_alarm()
            self.log("Все ручные алармы сняты")
            return True, "Алармы сняты"

    def apply_generation_settings(self, interval, upper_shift, lower_shift, random_mode):
        with self.lock:
            self.params["interval"]         = interval
            self.params["upper_shift_time"] = upper_shift
            self.params["lower_shift_time"] = lower_shift
            self.params["random_mode"]      = random_mode
            for sensor in self.sensors:
                sensor.interval_sec       = interval * 60
                sensor.upper_shift_time   = upper_shift
                sensor.lower_shift_time   = lower_shift
                sensor.random_mode        = random_mode
            self.log("Параметры генерации обновлены")
            return True, "Параметры обновлены"


backend = Backend()
app = FastAPI(title="OPC UA Simulator Web")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class ConnectRequest(BaseModel):
    server_url:       str
    low:              float
    high:             float
    interval:         float
    upper_shift_time: float
    lower_shift_time: float
    random_mode:      str


class GroupRequest(BaseModel):
    count:    int
    mode:     str
    duration: float


class SettingsRequest(BaseModel):
    interval:         float
    upper_shift_time: float
    lower_shift_time: float
    random_mode:      str


@app.get("/api/status")
def api_status():
    return backend.status()


@app.post("/api/connect")
def api_connect(req: ConnectRequest):
    if req.random_mode not in ("y", "n"):
        raise HTTPException(status_code=400, detail="random_mode должен быть y или n")
    ok, msg = backend.connect(req.model_dump())
    return {"ok": ok, "message": msg}


@app.post("/api/disconnect")
def api_disconnect():
    ok, msg = backend.disconnect()
    return {"ok": ok, "message": msg}


@app.post("/api/group")
def api_group(req: GroupRequest):
    if req.mode not in ("warn", "crit", "mixed"):
        raise HTTPException(status_code=400, detail="mode должен быть warn, crit или mixed")
    ok, msg = backend.trigger_group(req.count, req.mode, req.duration)
    return {"ok": ok, "message": msg}


@app.post("/api/alarms/clear")
def api_clear_alarms():
    ok, msg = backend.stop_alarms()
    return {"ok": ok, "message": msg}


@app.post("/api/settings")
def api_settings(req: SettingsRequest):
    if req.random_mode not in ("y", "n"):
        raise HTTPException(status_code=400, detail="random_mode должен быть y или n")
    ok, msg = backend.apply_generation_settings(
        req.interval, req.upper_shift_time, req.lower_shift_time, req.random_mode,
    )
    return {"ok": ok, "message": msg}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
