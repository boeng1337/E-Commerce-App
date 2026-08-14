"""
config.py — minimal credential store backing ae_client.py.

Reads/writes simple KEY=VALUE lines from api_keys.env, sitting next to this
file. If you already have your own config.py with this same get()/set_value()
interface, just drop this file and use yours instead — ae_client.py doesn't
care which one it's talking to.
"""

import os


def _xdg_documents_dir():
    """Read the XDG documents dir from ~/.config/user-dirs.dirs if present, so
    this matches Rust's dirs::document_dir(). Returns None if not configured."""
    home = os.path.expanduser("~")
    cfg = os.path.join(home, ".config", "user-dirs.dirs")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("XDG_DOCUMENTS_DIR"):
                    # e.g. XDG_DOCUMENTS_DIR="$HOME/Documents"
                    val = line.split("=", 1)[1].strip().strip('"')
                    val = val.replace("$HOME", home)
                    if val:
                        return val
    except OSError:
        pass
    return None


def _app_folder():
    """The one shared app folder: <Documents>/AliExpress Manager.
    Keeps credentials in the same place as the product list and image dossiers
    written by the Rust side. Resolution order matches Rust: XDG documents dir,
    then ~/Documents, then $HOME/Documents. Only falls back to this file's own
    directory if no home can be found at all."""
    home = os.path.expanduser("~")
    candidates = []
    xdg = _xdg_documents_dir()
    if xdg:
        candidates.append(xdg)
    candidates.append(os.path.join(home, "Documents"))
    for docs in candidates:
        folder = os.path.join(docs, "AliExpress Manager")
        try:
            os.makedirs(folder, exist_ok=True)
            return folder
        except OSError:
            continue
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
