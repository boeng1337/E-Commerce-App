"""
ae_auth_cli.py — CLI wrapper around the OAuth-ish connect flow in
ae_client.py, so the desktop app never needs a terminal for this.

Usage:
    python3 ae_auth_cli.py url                  -> {"url": "..."} or {"error": "..."}
    python3 ae_auth_cli.py set-redirect <uri>    -> {"ok": true}
    python3 ae_auth_cli.py exchange <code>       -> {"ok": true, "result": {...}} or {"error": "..."}
    python3 ae_auth_cli.py status                -> {"ok": bool, "message": "..."}
"""

import sys
import json

import config


def cmd_url():
    key = config.get("ALIEXPRESS_APP_KEY")
    redirect = config.get("ALIEXPRESS_REDIRECT_URI")
    if not key:
        print(json.dumps({"error": "ALIEXPRESS_APP_KEY not set in api_keys.env"}))
        return
    if not redirect:
        print(json.dumps({"error": "No redirect URI set yet — set one first"}))
        return
    url = (
        "https://api-sg.aliexpress.com/oauth/authorize"
        f"?response_type=code&force_auth=true&client_id={key}&redirect_uri={redirect}"
    )
    print(json.dumps({"url": url}))


def cmd_set_redirect(uri):
    config.set_value("ALIEXPRESS_REDIRECT_URI", uri)
    print(json.dumps({"ok": True}))


def cmd_set_key(key):
    config.set_value("ALIEXPRESS_APP_KEY", key)
    print(json.dumps({"ok": True}))


def cmd_set_secret(secret):
    config.set_value("ALIEXPRESS_APP_SECRET", secret)
    print(json.dumps({"ok": True}))


def cmd_has_credentials():
    key = config.get("ALIEXPRESS_APP_KEY")
    secret = config.get("ALIEXPRESS_APP_SECRET")
    print(json.dumps({"ok": bool(key and secret)}))


def cmd_exchange(code):
    try:
        import ae_client
        result = ae_client.exchange_code_for_token(code)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


def cmd_status():
    try:
        import ae_client
        ok, message = ae_client.test_connection()
        print(json.dumps({"ok": ok, "message": message}))
    except Exception as e:
        print(json.dumps({"ok": False, "message": f"{type(e).__name__}: {e}"}))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: ae_auth_cli.py <url|set-redirect|exchange|status> [arg]"}))
        return

    cmd = sys.argv[1]
    if cmd == "url":
        cmd_url()
    elif cmd == "set-redirect" and len(sys.argv) > 2:
        cmd_set_redirect(sys.argv[2])
    elif cmd == "set-key" and len(sys.argv) > 2:
        cmd_set_key(sys.argv[2])
    elif cmd == "set-secret" and len(sys.argv) > 2:
        cmd_set_secret(sys.argv[2])
    elif cmd == "has-credentials":
        cmd_has_credentials()
    elif cmd == "exchange" and len(sys.argv) > 2:
        cmd_exchange(sys.argv[2])
    elif cmd == "status":
        cmd_status()
    else:
        print(json.dumps({"error": f"unknown command or missing arg: {cmd}"}))


if __name__ == "__main__":
    main()
