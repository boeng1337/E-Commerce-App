"""
ae_cli.py — thin CLI wrapper around ae_client.fetch_product.

Usage:
    python3 ae_cli.py <url_or_product_id> [ship_to_country] [target_currency]

ship_to_country / target_currency default to FR / EUR when omitted, preserving
the original behaviour. Passing them lets the caller query a product's price
and availability for a specific country.

Prints one line of JSON to stdout: either the parsed product dict (including
`_raw`, the full unmodified API response, so the caller can surface it) or
{"error": "..."} on failure. Always exits 0 on a handled error so the caller
gets structured JSON instead of having to also parse stderr/exit codes for the
common failure case.
"""

import sys
import json

import ae_client


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: ae_cli.py <url_or_id> [country] [currency]"}))
        sys.exit(1)

    country = sys.argv[2] if len(sys.argv) > 2 else "FR"
    currency = sys.argv[3] if len(sys.argv) > 3 else "EUR"

    try:
        data = ae_client.fetch_product(
            sys.argv[1], ship_to_country=country, target_currency=currency
        )
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
