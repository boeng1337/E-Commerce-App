"""
config.py — minimal credential store backing ae_client.py.

Reads/writes simple KEY=VALUE lines from api_keys.env, sitting next to this
file. If you already have your own config.py with this same get()/set_value()
interface, just drop this file and use yours instead — ae_client.py doesn't
care which one it's talking to.
"""

import os


def _app_folder():
    """The one shared app folder: ~/Documents/AliExpress Manager.
    Keeps credentials in the same place as the product list and image
    dossiers written by the Rust side. Falls back to this file's own
    directory if the Documents folder can't be determined."""
    home = os.path.expanduser("~")
    docs = os.path.join(home, "Documents")
    if os.path.isdir(docs):
        folder = os.path.join(docs, "AliExpress Manager")
        try:
            os.makedirs(folder, exist_ok=True)
            return folder
        except OSError:
            pass
    return os.path.dirname(__file__)


_ENV_PATH = os.path.join(_app_folder(), "api_keys.env")


def _read_all():
    values = {}
    if os.path.exists(_ENV_PATH):
        with open(_ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip()
    return values


def get(key, default=None):
    # Environment variables take priority over the file, useful for CI/testing
    if key in os.environ:
        return os.environ[key]
    return _read_all().get(key, default)


def set_value(key, value):
    values = _read_all()
    values[key] = value
    with open(_ENV_PATH, "w", encoding="utf-8") as f:
        for k, v in values.items():
            f.write(f"{k}={v}\n")
