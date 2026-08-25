"""
ae_region_probe.py — tests the hypothesis that a variant's SHIP-FROM region
predicts which destinations it can SHIP-TO, so we can build a regional routing
algorithm instead of freight-checking every SKU against every country.

Idea under test (user's regional groupings):
  - North + South America cluster together
  - Europe serves Europe
  - Asia (China) serves world / Asia-Oceania
  - Russia stands alone

For a product, this picks one SKU per ship-from origin, then freight-queries
each against a spread of destinations covering every region, and prints a grid:
rows = ship-from SKU, cols = destination, cell = ships? (Y / n / price).

Usage:
    python3 ae_region_probe.py [product_id]

Defaults to the UPERFECT monitor (many ship-from origins, good test case).
Run with the app's venv python. Reads product.get to enumerate ship-from SKUs,
then freight-queries them. This is a lot of calls -- it's a one-off experiment.
"""

import sys
import json
import time

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


def _creds():
    k = config.get("ALIEXPRESS_APP_KEY")
    s = config.get("ALIEXPRESS_APP_SECRET")
    if not k or not s:
        raise RuntimeError("missing app key/secret")
    return k, s


if _LIB_OK:
    class _ProductGet(RestApi):
        def __init__(self, d="api-sg.aliexpress.com", p=80):
            RestApi.__init__(self, d, p)
            self.product_id = None
            self.ship_to_country = None
            self.target_currency = None
            self.target_language = None
        def getapiname(self):
            return "aliexpress.ds.product.get"

    class _Freight(RestApi):
        def __init__(self, d="api-sg.aliexpress.com", p=80):
            RestApi.__init__(self, d, p)
            self.queryDeliveryReq = None
        def getapiname(self):
            return "aliexpress.ds.freight.query"


# One representative destination per region we want to probe.
DESTINATIONS = {
    "FR": "Europe (West)",
    "ES": "Europe (South)",
    "PL": "Europe (East)",
    "US": "North America",
    "MX": "North America (MX)",
    "BR": "South America",
    "AU": "Oceania",
    "RU": "Russia",
    "JP": "Asia",
}


def enumerate_ship_from(product_id, token, key, secret):
    """Returns { ship_from_label: sku_id } — one SKU per distinct origin."""
    req = _ProductGet()
    req.set_app_info(_AppInfo(key, secret))
    req.product_id = product_id
    req.ship_to_country = "FR"
    req.target_currency = "EUR"
    req.target_language = "en"
    resp = req.getResponse(authrize=token)

    skus = (resp.get("aliexpress_ds_product_get_response", {})
                .get("result", {})
                .get("ae_item_sku_info_dtos", {})
                .get("ae_item_sku_info_d_t_o", []))
    if isinstance(skus, dict):
        skus = [skus]

    origins = {}
    for sku in skus:
        props = (sku.get("ae_sku_property_dtos", {})
                    .get("ae_sku_property_d_t_o", []))
        if isinstance(props, dict):
            props = [props]
        ship_from = None
        for p in props:
            if p.get("sku_property_name") in ("Expédié depuis", "Ships From", "Shipping from"):
                ship_from = p.get("sku_property_value")
        if ship_from and ship_from not in origins:
            # prefer an in-stock sku for this origin if possible
            origins[ship_from] = sku.get("sku_id")
    return origins


def freight(product_id, sku_id, country, token, key, secret):
    try:
        req = _Freight()
        req.set_app_info(_AppInfo(key, secret))
        req.queryDeliveryReq = json.dumps({
            "quantity": 1, "shipToCountry": country, "productId": str(product_id),
            "language": "en", "locale": "en_US", "selectedSkuId": str(sku_id),
            "currency": "EUR",
        })
        resp = req.getResponse(authrize=req and token)
        r = resp.get("aliexpress_ds_freight_query_response", {}).get("result", {})
        code = r.get("code")
        ships = code == 200 and bool(r.get("delivery_options"))
        return "Y" if ships else "n"
    except Exception as e:
        return "E"


def main():
    if not _LIB_OK:
        print("python-aliexpress-api not installed for this interpreter")
        sys.exit(1)
    product_id = sys.argv[1] if len(sys.argv) > 1 else "1005007900671145"
    token = config.get("ALIEXPRESS_ACCESS_TOKEN")
    if not token:
        print("no access token")
        sys.exit(1)
    key, secret = _creds()

    print(f"Product: {product_id}")
    print("Enumerating ship-from origins...")
    origins = enumerate_ship_from(product_id, token, key, secret)
    print(f"Found {len(origins)} origins: {', '.join(origins.keys())}\n")

    dests = list(DESTINATIONS.keys())
    # header
    print("SHIP-FROM".ljust(20) + "".join(d.ljust(5) for d in dests))
    print("-" * (20 + 5 * len(dests)))
    for origin, sku in origins.items():
        row = origin[:19].ljust(20)
        for d in dests:
            row += freight(product_id, sku, d, token, key, secret).ljust(5)
            time.sleep(0.3)
        print(row)
    print("\nLegend: Y = ships, n = blocked, E = error")
    print("Destinations:", ", ".join(f"{k}={v}" for k, v in DESTINATIONS.items()))


if __name__ == "__main__":
    main()
