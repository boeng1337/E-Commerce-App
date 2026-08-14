"""
ae_client.py — AliExpress DROPSHIPPING product data.

Your app is registered as a Drop Shipping app, so it has permission for the
dropshipping endpoints (aliexpress.ds.*), NOT the affiliate ones. This module
reuses the request/signing engine from the installed `python-aliexpress-api`
library (verified to sign correctly) but points it at the DS endpoints.

Auth is key+secret only (no OAuth).

Install once (in your venv):   pip install python-aliexpress-api
Credentials come from config.py (the gitignored api_keys.env).
"""

import config


# SKU property names that are actually the ship-from location, not a real
# variant dimension — extracted as warehouse instead of folded into the label.
_SHIP_PROPERTY_HINTS = ("ship", "expéd", "exped", "envío", "envio",
                        "versand", "provenance", "origin")

try:
    from aliexpress_api.skd.api.base import RestApi, sign as _lib_sign
    _LIB_OK = True
except Exception:
    _LIB_OK = False


# ---------------------------------------------------------------------------
# Token exchange (reuses the library's proven md5 signer)
# ---------------------------------------------------------------------------
def exchange_code_for_token(code):
    """
    Trade the one-time authorization code for an access token, using the
    library's WORKING signing function. The token endpoint is called as a
    regular method through the /sync gateway (same as business calls).
    Persists access_token + refresh_token into api_keys.env. Returns the raw
    response dict.
    """
    import time, json, urllib.parse, urllib.request
    key, secret = _credentials()

    params = {
        "app_key": key,
        "method": "/auth/token/create",
        "code": code,
        "timestamp": str(int(time.time() * 1000)),
        "format": "json",
        "v": "2.0",
        "sign_method": "md5",
        "partner_id": "taobao-sdk-python-20200924",
    }
    params["sign"] = _lib_sign(secret, params)

    url = "https://api-sg.aliexpress.com/sync"
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(url, data=data)
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))

    # dig out the tokens (response shape can nest)
    def deep_get(d, key):
        if isinstance(d, dict):
            if key in d:
                return d[key]
            for v in d.values():
                r = deep_get(v, key)
                if r is not None:
                    return r
        return None

    access = deep_get(result, "access_token")
    refresh = deep_get(result, "refresh_token")
    if access:
        config.set_value("ALIEXPRESS_ACCESS_TOKEN", access)
    if refresh:
        config.set_value("ALIEXPRESS_REFRESH_TOKEN", refresh)
    return result


if _LIB_OK:
    class _DsProductGetRequest(RestApi):
        """Dropshipping product detail — aliexpress.ds.product.get."""
        def __init__(self, domain="api-sg.aliexpress.com", port=80):
            RestApi.__init__(self, domain, port)
            self.product_id = None
            self.ship_to_country = None
            self.target_currency = None
            self.target_language = None

        def getapiname(self):
            return "aliexpress.ds.product.get"


class _AppInfo:
    def __init__(self, appkey, secret):
        self.appkey = appkey
        self.secret = secret


def library_available():
    return _LIB_OK


def _credentials():
    key = config.get("ALIEXPRESS_APP_KEY")
    secret = config.get("ALIEXPRESS_APP_SECRET")
    if not key or not secret:
        raise RuntimeError("Missing AliExpress app key/secret in api_keys.env")
    return key, secret


def test_connection():
    """Verify keys+token work against a DS endpoint. Returns (ok, message)."""
    if not _LIB_OK:
        return False, "python-aliexpress-api isn't installed. Run: pip install python-aliexpress-api"
    token = config.get("ALIEXPRESS_ACCESS_TOKEN")
    if not token:
        return False, "No access token yet — authorize first (paste the code and Connect)."
    try:
        key, secret = _credentials()
        req = _DsProductGetRequest()
        req.set_app_info(_AppInfo(key, secret))
        req.product_id = "1005006439540084"   # arbitrary public product, just to test access
        req.ship_to_country = "FR"
        req.target_currency = "EUR"
        req.target_language = "fr"
        req.getResponse(authrize=token)   # pass the token as session
        return True, "Connected — DS API responded with your token. Working!"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _extract_product_id(url_or_id):
    import re
    s = str(url_or_id)
    m = re.search(r"/item/(?:[^/]*?/)?(\d+)\.html", s)
    if m:
        return m.group(1)
    m = re.search(r"(\d{8,})", s)
    return m.group(1) if m else s


def fetch_product(url_or_id):
    """Fetch one product via the DS API, normalised into the scraper's dict shape.
    Parses the REAL aliexpress.ds.product.get response structure."""
    if not _LIB_OK:
        raise RuntimeError("python-aliexpress-api isn't installed.")
    key, secret = _credentials()
    pid = _extract_product_id(url_or_id)

    req = _DsProductGetRequest()
    req.set_app_info(_AppInfo(key, secret))
    req.product_id = pid
    req.ship_to_country = "FR"
    req.target_currency = "EUR"
    req.target_language = "fr"
    token = config.get("ALIEXPRESS_ACCESS_TOKEN")
    resp = req.getResponse(authrize=token)

    # unwrap: response -> result
    result = resp
    for k in ("aliexpress_ds_product_get_response", "result"):
        if isinstance(result, dict) and k in result:
            result = result[k]
    if not isinstance(result, dict):
        result = {}

    # --- base info (title, main images) ---
    base = result.get("ae_item_base_info_dto", {}) or {}
    name = (base.get("subject") or result.get("subject")
            or result.get("product_title"))

    # category id (the API provides this, unlike the scraped page) + store info
    category_id_api = base.get("category_id") or result.get("category_id")
    store = result.get("ae_store_info", {}) or {}
    store_name = store.get("store_name")
    store_country = store.get("store_country_code")

    # brand — often in the property list; useful for auto-tagging
    brand = None
    prop_wrap = result.get("ae_item_properties", {}) or {}
    prop_list = prop_wrap.get("ae_item_property", []) or []
    if isinstance(prop_list, dict):
        prop_list = [prop_list]
    for pr in prop_list:
        pname = str(pr.get("attr_name") or "").lower()
        if "brand" in pname or "marque" in pname:
            brand = pr.get("attr_value")
            break

    # main images: try known fields, then fall back to scanning the whole
    # response for any alicdn image URLs (field names vary by product).
    images = []
    media = result.get("ae_multimedia_info_dto", {}) or {}
    img_field = (media.get("image_urls") or media.get("image_u_r_ls")
                 or base.get("image_u_r_ls") or base.get("image_urls") or "")
    if isinstance(img_field, str) and img_field:
        images = [u for u in img_field.split(";") if u.startswith("http")]
    elif isinstance(img_field, list):
        images = [u for u in img_field if isinstance(u, str) and u.startswith("http")]

    # fallback: deep-scan for image urls anywhere in the response
    if not images:
        found = []
        def _scan(obj):
            if isinstance(obj, dict):
                for v in obj.values():
                    _scan(v)
            elif isinstance(obj, list):
                for v in obj:
                    _scan(v)
            elif isinstance(obj, str):
                low = obj.lower()
                if obj.startswith("http") and any(
                    low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")
                ) and ("alicdn" in low or "aliexpress" in low):
                    if obj not in found:
                        found.append(obj)
        _scan(result)
        images = found

    # --- SKUs (variants with real prices/stock) ---
    variants = []           # labels
    variant_prices = []     # dicts: {variant, price, in_stock}
    prices = []             # all sku prices, for the page range
    sku_wrap = result.get("ae_item_sku_info_dtos", {}) or {}
    sku_list = sku_wrap.get("ae_item_sku_info_d_t_o", []) or []
    if isinstance(sku_list, dict):
        sku_list = [sku_list]

    warehouse = None  # ship-from location, extracted from SKU properties

    for sku in sku_list:
        stock = sku.get("sku_available_stock")
        try:
            stock_n = int(stock) if stock is not None else None
        except (TypeError, ValueError):
            stock_n = None

        # build a readable label. Prefer property_value_definition_name (the
        # MEANINGFUL value, e.g. "500GB") over sku_property_value (a code).
        label_parts = []
        props = (sku.get("ae_sku_property_dtos", {}) or {}).get("ae_sku_property_d_t_o", []) or []
        if isinstance(props, dict):
            props = [props]
        for p in props:
            pname = str(p.get("sku_property_name") or "").lower()
            val = (p.get("property_value_definition_name")
                   or p.get("sku_property_value"))
            if not val or val == "NONE":
                continue
            if any(h in pname for h in _SHIP_PROPERTY_HINTS):
                if warehouse is None:
                    warehouse = str(val)
                continue
            label_parts.append(str(val))
        label = " / ".join(label_parts) if label_parts else (sku.get("sku_id") or "variant")

        raw_price = (sku.get("offer_sale_price") or sku.get("sku_price")
                     or sku.get("offer_bulk_sale_price"))
        try:
            price = float(raw_price) if raw_price is not None else None
        except (TypeError, ValueError):
            price = None

        # KEEP out-of-stock variants (don't hide them) — just mark unavailable.
        in_stock = (stock_n > 0) if stock_n is not None else None

        for p in props:
            if p.get("sku_image") and p["sku_image"] not in images:
                images.append(p["sku_image"])

        variants.append(label)
        variant_prices.append({"variant": label, "price": price, "in_stock": in_stock})
        # only in-stock prices count toward the product's headline price range,
        # so an out-of-stock decoy price doesn't drag the range down
        if price is not None and in_stock:
            prices.append(price)

    # overall stock = sum of the in-stock sku stock
    total_stock = None
    stocks = [int(s.get("sku_available_stock")) for s in sku_list
              if str(s.get("sku_available_stock", "")).isdigit()
              and int(s.get("sku_available_stock")) > 0]
    if stocks:
        total_stock = sum(stocks)

    # if no SKU prices, try a top-level price
    if not prices:
        top = base.get("sale_price") or result.get("target_sale_price")
        try:
            if top is not None:
                prices = [float(top)]
        except (TypeError, ValueError):
            pass

    # a clean, canonical product URL from the id (fr. subdomain for France)
    clean_url = f"https://fr.aliexpress.com/item/{pid}.html"
    # prefer the API's own detail url if it gave a real one
    api_url = base.get("detail_url") or result.get("product_detail_url")
    if isinstance(api_url, str) and api_url.startswith("http"):
        clean_url = api_url

    # real ship-from: check logistics/freight fields before falling back.
    # Do NOT default to the store's country — a Chinese seller can ship from a
    # France warehouse, so store_country is misleading.
    if warehouse is None:
        logi = result.get("logistics_info_dto", {}) or {}
        pkg = result.get("package_info_dto", {}) or {}
        ship_from = (logi.get("ship_from_country") or logi.get("send_goods_country")
                     or logi.get("delivery_country") or pkg.get("ship_from"))
        if ship_from:
            warehouse = str(ship_from)

    parsed = {
        "name": name,
        "prices": prices,
        "stock": total_stock,
        "images": images[:10],
        "variants": variants,
        "variant_prices": variant_prices,
        "warehouse": warehouse,   # None if genuinely unknown (better than wrong)
        "source": "api",
        "clean_url": clean_url,
        "store_name": store_name,
        "api_category_id": category_id_api,
        "brand": brand,
        "_raw": resp,
    }
    return parsed
