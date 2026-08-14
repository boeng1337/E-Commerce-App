"""
ae_freight_cli.py — thin CLI wrapper around the AE-Freight query, so the Rust
side can get REAL per-country deliverability (which aliexpress.ds.product.get
does not provide).

Usage:
    python3 ae_freight_cli.py <product_id> <sku_id> <ship_to_country> <currency>

Prints one line of JSON to stdout:
  {
    "ships": true/false,
    "code": 200,
    "msg": "...",
    "options": [ {company, free_shipping, cost, currency, min_days, max_days,
                  delivery_date_desc, ship_from_country, tracking}, ... ]
  }
or {"error": "..."} on failure. Availability is derived from the freight
response: code 200 with delivery options => ships; DELIVERY_NOT_AVAILABLE or
any non-200 => does not ship.
"""

import sys
import json

import ae_client  # reuse credentials/token plumbing
import config

try:
    from aliexpress_api.skd.api.base import RestApi
    _LIB_OK = True
except Exception:
    _LIB_OK = False


class _AppInfo:
    def __init__(self, appkey, secret):
        self.appkey = appkey
        self.secret = secret


if _LIB_OK:
    class _FreightRequest(RestApi):
        def __init__(self, domain="api-sg.aliexpress.com", port=80):
            RestApi.__init__(self, domain, port)
            self.queryDeliveryReq = None

        def getapiname(self):
            return "aliexpress.ds.freight.query"


def _credentials():
    key = config.get("ALIEXPRESS_APP_KEY")
    secret = config.get("ALIEXPRESS_APP_SECRET")
    if not key or not secret:
        raise RuntimeError("Missing AliExpress app key/secret")
    return key, secret


def query_freight(product_id, sku_id, country, currency):
    key, secret = _credentials()
    token = config.get("ALIEXPRESS_ACCESS_TOKEN")
    req = _FreightRequest()
    req.set_app_info(_AppInfo(key, secret))
    req.queryDeliveryReq = json.dumps({
        "quantity": 1,
        "shipToCountry": country,
        "productId": str(product_id),
        "language": "en",
        "locale": "en_US",
        "selectedSkuId": str(sku_id),
        "currency": currency,
    })
    resp = req.getResponse(authrize=token)

    # unwrap response -> result
    result = resp
    for k in ("aliexpress_ds_freight_query_response", "result"):
        if isinstance(result, dict) and k in result:
            result = result[k]
    if not isinstance(result, dict):
        result = {}

    code = result.get("code")
    msg = result.get("msg")
    success = bool(result.get("success"))

    opts_wrap = result.get("delivery_options") or {}
    raw_opts = opts_wrap.get("delivery_option_d_t_o", []) if isinstance(opts_wrap, dict) else []
    if isinstance(raw_opts, dict):
        raw_opts = [raw_opts]

    options = []
    for o in raw_opts:
        options.append({
            "company": o.get("company"),
            "free_shipping": bool(o.get("free_shipping")),
            "cost": o.get("shipping_fee_cent") or o.get("displayAmount") or o.get("amount"),
            "currency": currency,
            "min_days": o.get("min_delivery_days"),
            "max_days": o.get("max_delivery_days"),
            "delivery_date_desc": o.get("delivery_date_desc"),
            "ship_from_country": o.get("ship_from_country"),
            "tracking": bool(o.get("tracking")),
        })

    ships = (code == 200 or success) and len(options) > 0
    return {
        "ships": ships,
        "code": code,
        "msg": msg,
        "options": options,
    }


def main():
    if not _LIB_OK:
        print(json.dumps({"error": "python-aliexpress-api isn't installed."}))
        sys.exit(1)
    if len(sys.argv) < 5:
        print(json.dumps({"error": "usage: ae_freight_cli.py <product_id> <sku_id> <country> <currency>"}))
        sys.exit(1)
    try:
        data = query_freight(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
