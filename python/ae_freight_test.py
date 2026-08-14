"""
ae_freight_test.py — one-off probe: does the DS freight/shipping endpoint
return real per-country deliverability that aliexpress.ds.product.get does NOT?

We proved product.get echoes ship_to_country but reports the same availability
regardless of destination (FR and ES both showed stock 52 / onSelling for a
product that can't actually ship to ES). The freight endpoint is purpose-built
to answer "can this reach country X, and at what shipping cost", so it MIGHT
carry the honest answer — if this DS app has permission to call it.

Usage:
    python3 ae_freight_test.py [product_id]

Defaults to the Anker product we've been testing. Prints the raw response for
FR and for ES so they can be compared. If it errors with a permission/auth
message, this DS app can't call freight and country-level deliverability is
genuinely out of reach through this access.
"""

import sys
import json

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


def _credentials():
    key = config.get("ALIEXPRESS_APP_KEY")
    secret = config.get("ALIEXPRESS_APP_SECRET")
    if not key or not secret:
        raise RuntimeError("Missing AliExpress app key/secret in api_keys.env")
    return key, secret


# The DS freight query. Method name follows AliExpress's DS family naming; if
# this exact method isn't granted, the API returns an error we can read.
class _DsFreightRequest(RestApi):
    def __init__(self, method, domain="api-sg.aliexpress.com", port=80):
        RestApi.__init__(self, domain, port)
        self._method = method
        # common freight params across DS freight variants
        self.queryDeliveryReq = None      # some variants take a JSON blob
        self.product_id = None
        self.ship_to_country = None
        self.currency = None
        self.language = None
        self.product_num = 1
        self.send_goods_country_code = None
        self.price = None
        self.sku_id = None

    def getapiname(self):
        return self._method


def probe(method, product_id, country, token, key, secret):
    """Try one freight method for one country. Returns (ok, response_or_error)."""
    try:
        req = _DsFreightRequest(method)
        req.set_app_info(_AppInfo(key, secret))
        req.product_id = product_id
        req.ship_to_country = country
        req.currency = "EUR"
        req.language = "en"
        req.product_num = 1
        # Some freight endpoints want a JSON query object instead of flat params
        req.queryDeliveryReq = json.dumps({
            "productId": product_id,
            "quantity": 1,
            "shipToCountry": country,
            "language": "en",
            "currency": "EUR",
        })
        resp = req.getResponse(authrize=token)
        return True, resp
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def main():
    if not _LIB_OK:
        print("python-aliexpress-api isn't installed.")
        sys.exit(1)

    product_id = sys.argv[1] if len(sys.argv) > 1 else "1005008564267252"
    token = config.get("ALIEXPRESS_ACCESS_TOKEN")
    if not token:
        print("No access token — authorize in the app first.")
        sys.exit(1)
    key, secret = _credentials()

    # Candidate method names to try, most-likely first. AliExpress has renamed
    # freight endpoints over time; we try the known DS variants and report which
    # (if any) the app is allowed to call.
    methods = [
        "aliexpress.ds.freight.query",
        "aliexpress.logistics.buyer.freight.calculate",
        "aliexpress.ds.recommend.feed.get",  # sanity: known DS method shape
    ]

    for method in methods:
        print("=" * 70)
        print(f"METHOD: {method}")
        for country in ("FR", "ES"):
            ok, result = probe(method, product_id, country, token, key, secret)
            print(f"\n--- {country} ---")
            if ok:
                print(json.dumps(result, ensure_ascii=False, indent=2)[:4000])
            else:
                print(f"ERROR: {result}")
        print()


if __name__ == "__main__":
    main()
