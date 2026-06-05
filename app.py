import argparse
import asyncio
import json
import os
import random
import threading
import time
from pathlib import Path
from typing import Set

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
DEFAULT_UPPER = float(os.getenv(