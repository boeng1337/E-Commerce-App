"""
ae_freight_test.py — probe the AE-Freight (Shipment) endpoint, which returns
REAL per-country deliverability that aliexpress.ds.product.get does NOT.

Confirmed from the API docs: the freight query takes a `queryDeliveryReq`
object and, when a product can't ship to the requested country, returns the
error DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS instead of delivery_options.

Usage:
    python3 ae_freight_test.py [product_id] [sku_id]

IMPORTANT: run this with the SAME Python that has python-aliexpress-api
installed — i.e. the app's venv, not the system python3. If you see
"python-aliexpress-api isn't installed", you're on the wrong interpreter; use
the venv (see the message this script prints for the path hint).
"""

import sys
import json
import os

import config

try:
    from aliexpress_api.skd.api.base import RestApi
    _LIB_OK = True
except Exception as _imp_err:
    _LIB_OK = False
    _IMPORT_ERROR = _imp_err


class _AppInfo:
    def __init__(self, appkey, secret):
        self.appkey = appkey
        self.secret = secret


def _credentials():
    key = config.get("ALIEXPRESS_APP_KEY")
    secret = config.get("ALIEXPRESS_APP_SECRET")
    if not key or not secret:
        raise RuntimeError("Missing AliExpress app key/secret in api_keys.env")
    return key, secret


# Request classes are only defined when the library imported, so a missing
# library fails with a clear message instead of a NameError at load time.
if _LIB_OK:
    class _FreightRequest(RestApi):
        """AE-Freight query — single queryDeliveryReq object."""
        def __init__(self, method, domain="api-sg.aliexpress.com", port=80):
            RestApi.__init__(self, domain, port)
            self._method = method
            self.queryDeliveryReq = None

        def getapiname(self):
            return self._method

    class _DsProductGetRequest(RestApi):
        def __init__(self, domain="api-sg.aliexpress.com", port=80):
            RestApi.__init__(self, domain, port)
            self.product_id = None
            self.ship_to_country = None
            self.target_currency = None
            self.target_language = None

        def getapiname(self):
            return "aliexpress.ds.product.get"


def _first_sku_id(product_id, token, key, secret):
    try:
        req = _DsProductGetRequest()
        req.set_app_info(_AppInfo(key, secret))
        req.product_id = product_id
        req.ship_to_country = "FR"
        req.target_currency = "EUR"
        req.target_language = "en"
        resp = req.getResponse(authrize=token)

        def deep_find(d, wanted):
            if isinstance(d, dict):
                for k, v in d.items():
                    if k == wanted:
                        return v
                    r = deep_find(v, wanted)
                    if r is not None:
                        return r
            elif isinstance(d, list):
                for it in d:
                    r = deep_find(it, wanted)
                    if r is not None:
                        return r
            return None

        return deep_find(resp, "sku_id")
    except Exception as e:
        print(f"(couldn't auto-fetch sku_id: {e})")
        return None


def probe(method, product_id, sku_id, country, currency, token, key, secret):
    try:
        req = _FreightRequest(method)
        req.set_app_info(_AppInfo(key, secret))
        req.queryDeliveryReq = json.dumps({
            "quantity": 1,
            "shipToCountry": country,
            "productId": str(product_id),
            "language": "en",
            "locale": "en_US",
            "selectedSkuId": str(sku_id) if sku_id else "",
            "currency": currency,
        })
        resp = req.getResponse(authrize=token)
        return True, resp
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def main():
    if not _LIB_OK:
        print("python-aliexpress-api isn't installed for THIS python interpreter.")
        print(f"  import error: {_IMPORT_ERROR}")
        print(f"  interpreter:  {sys.executable}")
        print("")
        print("Run it with the app's venv instead, e.g.:")
        print("  ~/.local/share/aliexpress-manager/venv/bin/python3 ae_freight_test.py")
        print("(adjust the venv path if your .run script puts it elsewhere)")
        sys.exit(1)

    product_id = sys.argv[1] if len(sys.argv) > 1 else "1005008564267252"
    sku_id = sys.argv[2] if len(sys.argv) > 2 else None

    token = config.get("ALIEXPRESS_ACCESS_TOKEN")
    if not token:
        print("No access token — authorize in the app first.")
        sys.exit(1)
    key, secret = _credentials()

    if not sku_id:
        sku_id = _first_sku_id(product_id, token, key, secret)
        print(f"Using sku_id: {sku_id}")

    methods = [
        "aliexpress.ds.freight.query",
        "aliexpress.logistics.buyer.freight.calculate",
        "aliexpress.ds.recommend.feed.get",
    ]

    for method in methods:
        print("=" * 70)
        print(f"METHOD: {method}")
        for country, currency in (("FR", "EUR"), ("ES", "EUR")):
            ok, result = probe(method, product_id, sku_id, country, currency, token, key, secret)
            print(f"\n--- {country} ---")
            if ok:
                print(json.dumps(result, ensure_ascii=False, indent=2)[:4000])
            else:
                print(f"ERROR: {result}")
        print()


if __name__ == "__main__":
    main()
