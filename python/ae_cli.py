"""
ae_cli.py — thin CLI wrapper around ae_client.fetch_product.

Usage:
    python3 ae_cli.py <url_or_product_id> [ship_to_country] [target_currency] [base]

ship_to_country / target_currency default to FR / EUR when omitted. Passing the
4th arg as "base" sets remove_personal_benefit=True, returning the account-
neutral base price (no crowd/personal promotions) — the calculation basis.
Omitting it returns the promotional price.

Prints one line of JSON to stdout: either the parsed product dict (including
`_raw`, the full unmodified API response) or {"error": "..."} on failure.
Always exits 0 on a handled error.
"""

import sys
import json

import ae_client


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: ae_cli.py <url_or_id> [country] [currency] [base]"}))
        sys.exit(1)

    country = sys.argv[2] if len(sys.argv) > 2 else "FR"
    currency = sys.argv[3] if len(sys.argv) > 3 else "EUR"
    remove_personal_benefit = len(sys.argv) > 4 and sys.argv[4].lower() == "base"

    try:
        data = ae_client.fetch_product(
            sys.argv[1],
            ship_to_country=country,
            target_currency=currency,
            remove_personal_benefit=remove_personal_benefit,
        )
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
