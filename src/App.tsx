import { Fragment, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Variant = {
  label: string;
  price: number | null;
  in_stock: boolean | null;
};

type Listing = {
  id: string;
  title: string;
  main_image: string | null;
  images: string[];
  warehouse: string | null;
  price_min: number | null;
  price_max: number | null;
  stock: number | null;
  variants: Variant[];
  source: "aliexpress" | "manual";
  source_url: string | null;
  store_name: string | null;
  brand: string | null;
  debug_json: string | null;
  category: string | null;
  data_version: number | null;
  last_fetched: number | null;
  price_override: number | null;
  store_country: string | null;
  store_rating: number | null;
  product_rating: number | null;
  sales_count: string | null;
  product_status: string | null;
  ships: boolean | null;
  primary_sku_id: string | null;
  base_price_min: number | null;
  base_price_max: number | null;
};

type Settings = {
  concurrency: number;
  sleep_seconds: number;
  home_country: string;
  home_currency: string;
  international_enabled: boolean;
  check_countries: string[];
  hidden_columns: string[];
  sort_key: string | null;
  sort_dir: string | null;
};

type CountryResult = {
  country: string;
  ships: boolean;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  variants: Variant[];
  error: string | null;
  delivery_company: string | null;
  delivery_days: string | null;
  free_shipping: boolean | null;
  freight_msg: string | null;
};

type InternationalResult = {
  id: string;
  countries: CountryResult[];
};

// EU market countries (mirrors the Rust default). region grouping for the
// settings selector; extend with more regions later.
const EU_COUNTRIES = [
  "FR", "DE", "ES", "IT", "NL", "BE", "PL", "PT", "SE", "AT", "IE", "DK",
  "FI", "GR", "CZ", "RO", "HU", "SK", "BG", "HR", "LT", "LV", "EE", "SI", "LU",
];

// Columns that can be shown/hidden. Persisted in settings via localStorage-free
// approach: stored in component state, synced to a hidden settings field would
// need backend; here we keep it in the settings.json-independent way below.
const ALL_COLUMNS = [
  { key: "category", label: "Category" },
  { key: "warehouse", label: "Warehouse" },
  { key: "price", label: "Price" },
  { key: "stock", label: "Stock" },
  { key: "store", label: "Store" },
  { key: "store_rating", label: "Store ★" },
  { key: "rating", label: "Rating" },
  { key: "sales", label: "Sales" },
  { key: "brand", label: "Brand" },
  { key: "last_fetched", label: "Last fetched" },
] as const;

type ColumnKey = (typeof ALL_COLUMNS)[number]["key"];

type BulkSearchResult = {
  added: number;
  errors: string[];
};

type AuthStatus = {
  ok: boolean;
  message: string;
};

// Must match CURRENT_DATA_VERSION in src-tauri/src/lib.rs
const CURRENT_DATA_VERSION = 5;

function formatPrice(min: number | null, max: number | null): string {
  if (min == null && max == null) return "—";
  if (min == null) return `$${max!.toFixed(2)}`;
  if (max == null || min === max) return `$${min.toFixed(2)}`;
  return `$${min.toFixed(2)} – $${max.toFixed(2)}`;
}

// The price to show: manual override if set, else the fetched range.
function displayPrice(l: Listing): string {
  if (l.price_override != null) return `$${l.price_override.toFixed(2)}`;
  return formatPrice(l.price_min, l.price_max);
}

// A promotion is active when the account-neutral base price is meaningfully
// higher than the current (promotional) price. Returns the discount % or null.
function promotionDiscount(l: Listing): number | null {
  const promo = l.price_min;
  const base = l.base_price_min;
  if (promo == null || base == null) return null;
  if (base <= promo) return null;
  return Math.round(((base - promo) / base) * 100);
}

function isOutdated(l: Listing): boolean {
  if (l.source !== "aliexpress") return false;
  const behind = (l.data_version ?? 0) < CURRENT_DATA_VERSION;
  const missingCore = l.price_min == null && l.images.length === 0;
  return behind || missingCore;
}

function formatDate(unix: number | null): string {
  if (unix == null) return "—";
  const d = new Date(unix * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function App() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // background fetch in progress

  const [searchInput, setSearchInput] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettingsState] = useState<Settings>({
    concurrency: 1,
    sleep_seconds: 2,
    home_country: "FR",
    home_currency: "EUR",
    international_enabled: false,
    check_countries: EU_COUNTRIES,
    hidden_columns: [],
    sort_key: null,
    sort_dir: null,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [downloadingImages, setDownloadingImages] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);

  // price editing in detail view
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceDraft, setPriceDraft] = useState("");

  // image lightbox
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);

  // international check
  const [intl, setIntl] = useState<InternationalResult | null>(null);
  const [intlBusy, setIntlBusy] = useState(false);

  // column show/hide menu
  const [columnsOpen, setColumnsOpen] = useState(false);

  // conflict popup for batch refetch over manually-edited listings
  const [conflict, setConflict] = useState<{ ids: string[]; edited: Listing[]; release: Set<string> } | null>(null);

  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hasCredentials, setHasCredentials] = useState<boolean | null>(null);
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [credsSaved, setCredsSaved] = useState(false);

  // the currently-open detail listing, derived from live list so it stays fresh
  const detailListing = detailId ? listings.find((l) => l.id === detailId) ?? null : null;

  async function refresh() {
    try {
      const data = await invoke<Listing[]>("get_listings");
      setListings(data);
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadSettings() {
    try {
      const s = await invoke<Settings>("get_settings");
      setSettingsState(s);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
    loadSettings();
  }, []);

  function closeDetail() {
    setDetailId(null);
    setDownloadMsg(null);
    setCopiedDebug(false);
    setEditingPrice(false);
    setIntl(null);
  }

  // Escape closes the detail drawer
  useEffect(() => {
    if (!detailId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailId]);

  // Reset international results when switching to a different listing
  useEffect(() => {
    setIntl(null);
  }, [detailId]);

  async function saveSettings(next: Settings) {
    try {
      const saved = await invoke<Settings>("set_settings", { settings: next });
      setSettingsState(saved);
    } catch (e) {
      setError(String(e));
    }
  }

  async function checkAuthStatus() {
    try {
      const status = await invoke<AuthStatus>("get_auth_status");
      setAuthStatus(status);
    } catch (e) {
      setAuthStatus({ ok: false, message: String(e) });
    }
    try {
      const has = await invoke<boolean>("has_ae_credentials");
      setHasCredentials(has);
    } catch {
      setHasCredentials(false);
    }
  }

  async function handleSaveCredentials() {
    if (!appKey.trim() || !appSecret.trim()) return;
    setAuthBusy(true);
    setCredsSaved(false);
    try {
      await invoke("set_ae_credentials", { appKey: appKey.trim(), appSecret: appSecret.trim() });
      setHasCredentials(true);
      setCredsSaved(true);
      setAppKey("");
      setAppSecret("");
    } catch (e) {
      setAuthStatus({ ok: false, message: String(e) });
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleOpenAuthPage() {
    setAuthBusy(true);
    try {
      if (redirectUri.trim()) {
        await invoke("set_redirect_uri", { uri: redirectUri.trim() });
      }
      await invoke<string>("open_auth_page");
    } catch (e) {
      setAuthStatus({ ok: false, message: String(e) });
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleExchangeCode() {
    if (!authCode.trim()) return;
    setAuthBusy(true);
    try {
      const status = await invoke<AuthStatus>("exchange_auth_code", { code: authCode.trim() });
      setAuthStatus(status);
      if (status.ok) setAuthCode("");
    } catch (e) {
      setAuthStatus({ ok: false, message: String(e) });
    } finally {
      setAuthBusy(false);
    }
  }

  // Search runs in the background: we don't block the whole UI, just show a
  // status line. The table stays fully interactive while it runs.
  async function runSingleSearch() {
    const value = searchInput.trim();
    if (!value) return;
    setSearchInput("");
    setError(null);
    setBusy(true);
    setStatusMsg("Fetching…");
    try {
      await invoke("search_one", { input: value });
      await refresh();
      setStatusMsg(null);
    } catch (e) {
      setError(String(e));
      setStatusMsg(null);
    } finally {
      setBusy(false);
    }
  }

  async function copyDebugJson() {
    if (!detailListing?.debug_json) return;
    try {
      await navigator.clipboard.writeText(detailListing.debug_json);
      setCopiedDebug(true);
      setTimeout(() => setCopiedDebug(false), 1500);
    } catch (e) {
      setDownloadMsg(String(e));
    }
  }

  async function handleDownloadImages() {
    if (!detailListing) return;
    setDownloadingImages(true);
    setDownloadMsg(null);
    try {
      const result = await invoke<{ folder: string; saved: number; errors: string[] }>(
        "download_images",
        { id: detailListing.id }
      );
      setDownloadMsg(
        `Saved ${result.saved} image${result.saved === 1 ? "" : "s"} to ${result.folder}` +
          (result.errors.length > 0 ? ` (${result.errors.length} failed)` : "")
      );
    } catch (e) {
      setDownloadMsg(String(e));
    } finally {
      setDownloadingImages(false);
    }
  }

  async function handleSearchDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const text = await file.text();
    if (!text.trim()) return;
    setError(null);
    setBusy(true);
    setStatusMsg("Fetching dropped file…");
    try {
      const result = await invoke<BulkSearchResult>("search_bulk", { input: text });
      setStatusMsg(
        `Added ${result.added} listing${result.added === 1 ? "" : "s"}` +
          (result.errors.length > 0 ? `, ${result.errors.length} failed` : "")
      );
      if (result.errors.length > 0) setError(result.errors.join("\n"));
      await refresh();
    } catch (err) {
      setError(String(err));
      setStatusMsg(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSelected() {
    for (const id of selected) {
      await invoke("delete_listing", { id }).catch(() => {});
    }
    setSelected(new Set());
    await refresh();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      if (prev.size === listings.length) return new Set();
      return new Set(listings.map((l) => l.id));
    });
  }

  function toggleExpanded(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  // Core batch refetch: if any target listings have a manual price override,
  // open the conflict popup first; otherwise run immediately.
  async function refetchIds(ids: string[]) {
    const editable = ids
      .map((id) => listings.find((l) => l.id === id))
      .filter((l): l is Listing => !!l);
    const withEdits = editable.filter((l) => l.price_override != null && l.source_url);
    const fetchable = editable.filter((l) => l.source_url).map((l) => l.id);

    if (fetchable.length === 0) {
      setError("None of the selected listings can be refetched (no source URL).");
      return;
    }

    if (withEdits.length > 0) {
      setConflict({ ids: fetchable, edited: withEdits, release: new Set() });
      return;
    }
    await runRefetch(fetchable, new Set());
  }

  async function runRefetch(ids: string[], release: Set<string>) {
    setBusy(true);
    setError(null);
    setStatusMsg(`Refetching ${ids.length} listing${ids.length === 1 ? "" : "s"}…`);
    try {
      const result = await invoke<BulkSearchResult>("refetch_many", {
        ids,
        releaseIds: Array.from(release),
      });
      setStatusMsg(
        `Refetched ${result.added} listing${result.added === 1 ? "" : "s"}` +
          (result.errors.length > 0 ? `, ${result.errors.length} failed` : "")
      );
      if (result.errors.length > 0) setError(result.errors.join("\n"));
      await refresh();
    } catch (e) {
      setError(String(e));
      setStatusMsg(null);
    } finally {
      setBusy(false);
    }
  }

  async function fetchSelected() {
    await refetchIds(Array.from(selected));
  }

  async function fetchAllOutdated() {
    try {
      const ids = await invoke<string[]>("get_outdated_ids");
      if (ids.length === 0) {
        setStatusMsg("Everything is up to date.");
        return;
      }
      await refetchIds(ids);
    } catch (e) {
      setError(String(e));
    }
  }

  // price editing
  function startEditPrice() {
    if (!detailListing) return;
    const current =
      detailListing.price_override ??
      detailListing.price_min ??
      detailListing.price_max ??
      0;
    setPriceDraft(String(current));
    setEditingPrice(true);
  }

  async function saveEditPrice() {
    if (!detailListing) return;
    const val = parseFloat(priceDraft);
    if (Number.isNaN(val)) {
      setEditingPrice(false);
      return;
    }
    try {
      await invoke<Listing>("set_price_override", { id: detailListing.id, price: val });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setEditingPrice(false);
    }
  }

  async function clearPriceOverride() {
    if (!detailListing) return;
    try {
      await invoke<Listing>("set_price_override", { id: detailListing.id, price: null });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const outdatedCount = listings.filter(isOutdated).length;
  const allSelected = listings.length > 0 && selected.size === listings.length;

  // --- Column visibility (persisted in settings) ---
  const hidden = new Set(settings.hidden_columns);
  function isColVisible(key: ColumnKey) {
    return !hidden.has(key);
  }
  async function toggleColumn(key: ColumnKey) {
    const next = new Set(settings.hidden_columns);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    await saveSettings({ ...settings, hidden_columns: Array.from(next) });
  }

  // --- Sorting (persisted in settings) ---
  async function sortBy(key: string) {
    let dir = "asc";
    if (settings.sort_key === key) {
      dir = settings.sort_dir === "asc" ? "desc" : "asc";
    }
    await saveSettings({ ...settings, sort_key: key, sort_dir: dir });
  }

  function sortValue(l: Listing, key: string): number | string {
    switch (key) {
      case "title": return l.title.toLowerCase();
      case "category": return l.category ?? "";
      case "warehouse": return l.warehouse ?? "";
      case "price": return l.price_override ?? l.price_min ?? Infinity;
      case "stock": return l.stock ?? -1;
      case "store": return (l.store_name ?? "").toLowerCase();
      case "store_rating": return l.store_rating ?? -1;
      case "rating": return l.product_rating ?? -1;
      case "sales": {
        const n = parseInt((l.sales_count ?? "").replace(/\D/g, ""), 10);
        return Number.isNaN(n) ? -1 : n;
      }
      case "brand": return (l.brand ?? "").toLowerCase();
      case "last_fetched": return l.last_fetched ?? 0;
      default: return 0;
    }
  }

  const sortedListings = (() => {
    if (!settings.sort_key) return listings;
    const key = settings.sort_key;
    const dir = settings.sort_dir === "desc" ? -1 : 1;
    return [...listings].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  })();

  function sortArrow(key: string) {
    if (settings.sort_key !== key) return "";
    return settings.sort_dir === "desc" ? " ▼" : " ▲";
  }

  // --- International check ---
  async function runInternational() {
    if (!detailListing) return;
    if (!settings.international_enabled) {
      setError("Enable the international check in Settings first.");
      return;
    }
    setIntlBusy(true);
    setIntl(null);
    try {
      const result = await invoke<InternationalResult>("check_international", {
        id: detailListing.id,
      });
      setIntl(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setIntlBusy(false);
    }
  }

  // region toggle in settings
  async function toggleAllEU(on: boolean) {
    await saveSettings({ ...settings, check_countries: on ? EU_COUNTRIES : [] });
  }
  async function toggleCountry(code: string) {
    const next = new Set(settings.check_countries);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    await saveSettings({ ...settings, check_countries: Array.from(next) });
  }

  function stockLabel(l: Listing): string {
    if (l.source === "manual") return l.stock != null ? String(l.stock) : "—";
    if (l.ships === false) return "unavailable";
    if (l.warehouse == null && (l.stock == null || l.stock === 0)) return "no shipping";
    if (l.stock == null) return "—";
    if (l.stock === 0) return "unavailable";
    return String(l.stock);
  }

  return (
    <div
      className={`app ${detailListing ? "with-detail" : ""}`}
    >
      <header>
        <h1>Sourced Listings</h1>
        <button className="icon-btn" onClick={() => { setSettingsOpen(true); checkAuthStatus(); }} title="Settings">
          ⚙
        </button>
      </header>

      <div className="search-bar">
        <div
          className="search-row"
          onDrop={handleSearchDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          <input
            type="text"
            placeholder="Link or ID — press Enter, or drop a .txt file to search many…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSingleSearch()}
          />
          {busy && <span className="search-spinner">Working…</span>}
        </div>
      </div>

      {statusMsg && <div className="status">{statusMsg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <div className="columns-wrap">
          <button className="ghost-btn" onClick={() => setColumnsOpen((v) => !v)}>
            Columns ▾
          </button>
          {columnsOpen && (
            <>
              <div className="columns-catcher" onClick={() => setColumnsOpen(false)} />
              <div className="columns-menu">
                <div className="columns-menu-head">
                  <span>Show columns</span>
                  <button className="mini-btn" onClick={() => setColumnsOpen(false)}>Done</button>
                </div>
                {ALL_COLUMNS.map((c) => (
                  <label key={c.key} className="columns-item">
                    <input
                      type="checkbox"
                      checked={isColVisible(c.key)}
                      onChange={() => toggleColumn(c.key)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        {outdatedCount > 0 && (
          <button className="warn-btn" onClick={fetchAllOutdated} disabled={busy}>
            {outdatedCount} outdated — Refetch all
          </button>
        )}
        {selected.size > 0 && (
          <>
            <span>{selected.size} selected</span>
            <button onClick={fetchSelected} disabled={busy}>Fetch selected</button>
            <button className="danger" onClick={handleDeleteSelected}>Delete selected</button>
          </>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th className="col-check">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                title="Select all"
              />
            </th>
            <th className="col-img"></th>
            <th className="sortable" onClick={() => sortBy("title")}>Title{sortArrow("title")}</th>
            {isColVisible("category") && <th className="sortable" onClick={() => sortBy("category")}>Category{sortArrow("category")}</th>}
            {isColVisible("warehouse") && <th className="sortable" onClick={() => sortBy("warehouse")}>Warehouse{sortArrow("warehouse")}</th>}
            {isColVisible("price") && <th className="sortable" onClick={() => sortBy("price")}>Price{sortArrow("price")}</th>}
            {isColVisible("stock") && <th className="sortable" onClick={() => sortBy("stock")}>Stock{sortArrow("stock")}</th>}
            {isColVisible("store") && <th className="sortable" onClick={() => sortBy("store")}>Store{sortArrow("store")}</th>}
            {isColVisible("store_rating") && <th className="sortable" onClick={() => sortBy("store_rating")}>Store ★{sortArrow("store_rating")}</th>}
            {isColVisible("rating") && <th className="sortable" onClick={() => sortBy("rating")}>Rating{sortArrow("rating")}</th>}
            {isColVisible("sales") && <th className="sortable" onClick={() => sortBy("sales")}>Sales{sortArrow("sales")}</th>}
            {isColVisible("brand") && <th className="sortable" onClick={() => sortBy("brand")}>Brand{sortArrow("brand")}</th>}
            {isColVisible("last_fetched") && <th className="sortable" onClick={() => sortBy("last_fetched")}>Last fetched{sortArrow("last_fetched")}</th>}
          </tr>
        </thead>
        <tbody>
          {sortedListings.map((l) => (
            <Fragment key={l.id}>
              <tr className={isOutdated(l) ? "row-outdated" : ""}>
                <td className="col-check">
                  <input
                    type="checkbox"
                    checked={selected.has(l.id)}
                    onChange={() => toggleSelected(l.id)}
                  />
                </td>
                <td className="col-img">
                  {l.main_image ? (
                    <img src={l.main_image} alt="" className="thumb" />
                  ) : (
                    <div className="thumb placeholder" />
                  )}
                </td>
                <td>
                  <button className="title-link" onClick={(e) => { e.stopPropagation(); setDetailId(l.id); }}>
                    {l.title}
                  </button>
                  {isOutdated(l) && <span className="badge outdated">outdated</span>}
                  {l.price_override != null && <span className="badge edited">edited</span>}
                  {l.variants.length > 0 && (
                    <button
                      className="variant-toggle"
                      onClick={() => toggleExpanded(l.id)}
                    >
                      {expandedId === l.id ? "▲" : "▼"} {l.variants.length} variants
                    </button>
                  )}
                </td>
                {isColVisible("category") && <td>{l.category ?? "—"}</td>}
                {isColVisible("warehouse") && <td>{l.warehouse ?? "—"}</td>}
                {isColVisible("price") && (
                  <td>
                    {displayPrice(l)}
                    {promotionDiscount(l) != null && l.price_override == null && (
                      <span className="badge promo">-{promotionDiscount(l)}%</span>
                    )}
                  </td>
                )}
                {isColVisible("stock") && (
                  <td className={stockLabel(l) === "unavailable" || stockLabel(l) === "no shipping" ? "stock-bad" : ""}>
                    {stockLabel(l)}
                  </td>
                )}
                {isColVisible("store") && <td>{l.store_name ?? "—"}</td>}
                {isColVisible("store_rating") && <td>{l.store_rating != null ? l.store_rating.toFixed(1) : "—"}</td>}
                {isColVisible("rating") && <td>{l.product_rating != null && l.product_rating > 0 ? l.product_rating.toFixed(1) : "—"}</td>}
                {isColVisible("sales") && <td>{l.sales_count ?? "—"}</td>}
                {isColVisible("brand") && <td>{l.brand ?? "—"}</td>}
                {isColVisible("last_fetched") && <td className="col-date">{formatDate(l.last_fetched)}</td>}
              </tr>
              {expandedId === l.id &&
                l.variants.map((v, i) => (
                  <tr key={`${l.id}-variant-${i}`} className="variant-row">
                    <td className="col-check"></td>
                    <td className="col-img"></td>
                    <td className="variant-label" colSpan={12}>
                      {v.label}
                      {v.price != null ? ` — $${v.price.toFixed(2)}` : ""}
                      {v.in_stock === false ? (
                        <span className="badge out-of-stock">out of stock</span>
                      ) : null}
                    </td>
                    <td></td>
                  </tr>
                ))}
            </Fragment>
          ))}
          {listings.length === 0 && (
            <tr>
              <td colSpan={14} className="empty">
                No sourced listings yet. Paste a link above to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>

            <label className="field">
              <span>Simultaneous searches: {settings.concurrency}</span>
              <input
                type="range"
                min={1}
                max={3}
                step={1}
                value={settings.concurrency}
                onChange={(e) =>
                  saveSettings({ ...settings, concurrency: Number(e.target.value) })
                }
              />
            </label>

            <label className="field">
              <span>Sleep between searches: {settings.sleep_seconds}s</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={settings.sleep_seconds}
                onChange={(e) =>
                  saveSettings({ ...settings, sleep_seconds: Number(e.target.value) })
                }
              />
            </label>

            <div className="intl-section">
              <h3>Markets & International</h3>

              <div className="intl-home">
                <label className="field-inline">
                  <span>Home country</span>
                  <input
                    type="text"
                    value={settings.home_country}
                    maxLength={2}
                    onChange={(e) =>
                      saveSettings({ ...settings, home_country: e.target.value.toUpperCase() })
                    }
                  />
                </label>
                <label className="field-inline">
                  <span>Currency</span>
                  <input
                    type="text"
                    value={settings.home_currency}
                    maxLength={3}
                    onChange={(e) =>
                      saveSettings({ ...settings, home_currency: e.target.value.toUpperCase() })
                    }
                  />
                </label>
              </div>

              <label className="field-check">
                <input
                  type="checkbox"
                  checked={settings.international_enabled}
                  onChange={(e) =>
                    saveSettings({ ...settings, international_enabled: e.target.checked })
                  }
                />
                <span>Enable international price/availability check</span>
              </label>

              {settings.international_enabled && (
                <div className="intl-region">
                  <div className="intl-region-head">
                    <strong>EU market</strong>
                    <span className="intl-region-actions">
                      <button className="mini-btn" onClick={() => toggleAllEU(true)}>All</button>
                      <button className="mini-btn" onClick={() => toggleAllEU(false)}>None</button>
                    </span>
                  </div>
                  <div className="intl-countries">
                    {EU_COUNTRIES.map((code) => (
                      <label key={code} className="intl-country">
                        <input
                          type="checkbox"
                          checked={settings.check_countries.includes(code)}
                          onChange={() => toggleCountry(code)}
                        />
                        {code}
                      </label>
                    ))}
                  </div>
                  <p className="intl-note">
                    Each product you check is fetched once per selected country — more
                    countries means more API calls and a longer check.
                  </p>
                </div>
              )}
            </div>

            <div className="auth-section">
              <h3>AliExpress Connection</h3>

              {authStatus && (
                <div className={`auth-status ${authStatus.ok ? "ok" : "not-ok"}`}>
                  {authStatus.ok ? "✓ Connected" : "○ Not connected"} — {authStatus.message}
                </div>
              )}

              <div className="cred-status">
                {hasCredentials === true && "✓ App key/secret saved"}
                {hasCredentials === false && "○ No app key/secret saved yet"}
              </div>

              <label className="field">
                <span>App Key</span>
                <input
                  type="text"
                  placeholder={hasCredentials ? "•••••••• (saved — enter to replace)" : "Your AliExpress app key"}
                  value={appKey}
                  onChange={(e) => setAppKey(e.target.value)}
                />
              </label>

              <label className="field">
                <span>App Secret</span>
                <input
                  type="password"
                  placeholder={hasCredentials ? "•••••••• (saved — enter to replace)" : "Your AliExpress app secret"}
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                />
              </label>

              <button
                className="secondary-btn"
                onClick={handleSaveCredentials}
                disabled={authBusy || !appKey.trim() || !appSecret.trim()}
              >
                {authBusy ? "Saving…" : "Save credentials"}
              </button>
              {credsSaved && <div className="auth-status ok">Saved to app folder</div>}

              <label className="field" style={{ marginTop: 12 }}>
                <span>Redirect URI (from your AliExpress app settings)</span>
                <input
                  type="text"
                  placeholder="https://your-redirect-uri"
                  value={redirectUri}
                  onChange={(e) => setRedirectUri(e.target.value)}
                />
              </label>

              <button className="secondary-btn" onClick={handleOpenAuthPage} disabled={authBusy}>
                Open authorization page
              </button>

              <label className="field" style={{ marginTop: 12 }}>
                <span>Paste the code from the redirect URL</span>
                <input
                  type="text"
                  placeholder="Authorization code"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleExchangeCode()}
                />
              </label>

              <button
                className="secondary-btn"
                onClick={handleExchangeCode}
                disabled={authBusy || !authCode.trim()}
              >
                {authBusy ? "Connecting…" : "Connect"}
              </button>
            </div>

            <button className="close-btn" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Full-viewport catcher: clicking anywhere outside the drawer closes it */}
      {detailListing && (
        <div className="detail-catcher" onClick={closeDetail} />
      )}

      {/* Detail drawer — no backdrop, so the table stays usable beside it.
          Closes on Escape, or by clicking a row / empty table area. */}
      {detailListing && (
        <div className="detail-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="detail-hero">
            {detailListing.images.length > 0 ? (
              <img
                src={detailListing.images[0]}
                alt=""
                className="detail-hero-img"
                onClick={() => setLightbox({ images: detailListing.images, index: 0 })}
              />
            ) : (
              <div className="thumb placeholder large" />
            )}
          </div>
          {detailListing.images.length > 1 && (
            <div className="detail-thumbs">
              {detailListing.images.map((img, i) => (
                <img
                  key={i}
                  src={img}
                  alt=""
                  className="detail-thumb"
                  onClick={() => setLightbox({ images: detailListing.images, index: i })}
                />
              ))}
            </div>
          )}

          <div className="detail-body">
            {detailListing.source_url ? (
              <h2>
                <a
                  className="detail-title-link"
                  href={detailListing.source_url}
                  onClick={(e) => {
                    e.preventDefault();
                    invoke("open_url", { url: detailListing.source_url }).catch((err) => setError(String(err)));
                  }}
                >
                  {detailListing.title}
                </a>
              </h2>
            ) : (
              <h2>{detailListing.title}</h2>
            )}
            <div className="detail-actions">
              {detailListing.images.length > 0 && (
                <button
                  className="secondary-btn download-btn"
                  onClick={handleDownloadImages}
                  disabled={downloadingImages}
                >
                  {downloadingImages ? "Downloading…" : "Download images"}
                </button>
              )}
              {detailListing.source_url && settings.international_enabled && (
                <button
                  className="secondary-btn download-btn"
                  onClick={runInternational}
                  disabled={intlBusy}
                >
                  {intlBusy ? "Checking…" : "View international prices"}
                </button>
              )}
            </div>
            {downloadMsg && <div className="download-msg">{downloadMsg}</div>}

            <div className="detail-meta">
              {detailListing.store_name && <div>Store: {detailListing.store_name}</div>}
              {detailListing.store_rating != null && <div>Store rating: {detailListing.store_rating.toFixed(1)} ★</div>}
              {detailListing.product_rating != null && detailListing.product_rating > 0 && <div>Rating: {detailListing.product_rating.toFixed(1)} ★</div>}
              {detailListing.sales_count && <div>Sales: {detailListing.sales_count}</div>}
              {detailListing.brand && <div>Brand: {detailListing.brand}</div>}
              {detailListing.category && <div>Category: {detailListing.category}</div>}
              <div>Warehouse: {detailListing.warehouse ?? "unknown"}</div>
              <div>Availability: {detailListing.ships === false ? "unavailable in home market" : detailListing.ships === true ? "available" : "unknown"}</div>

              <div className="price-line">
                <span>Price: </span>
                {editingPrice ? (
                  <span className="price-edit">
                    <input
                      type="number"
                      step="0.01"
                      value={priceDraft}
                      onChange={(e) => setPriceDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEditPrice();
                        if (e.key === "Escape") setEditingPrice(false);
                      }}
                      autoFocus
                    />
                    <button className="mini-btn" onClick={saveEditPrice}>Save</button>
                    <button className="mini-btn" onClick={() => setEditingPrice(false)}>Cancel</button>
                  </span>
                ) : (
                  <span>
                    {(() => {
                      const disc = promotionDiscount(detailListing);
                      return disc != null && detailListing.price_override == null ? (
                        <>
                          <span className="price-base-strike">
                            {formatPrice(detailListing.base_price_min, detailListing.base_price_max)}
                          </span>{" "}
                          <span className="price-promo">{displayPrice(detailListing)}</span>{" "}
                          <span className="badge promo">-{disc}%</span>
                        </>
                      ) : (
                        displayPrice(detailListing)
                      );
                    })()}
                    {detailListing.price_override != null && (
                      <span className="badge edited">manual</span>
                    )}
                    <button className="mini-btn" onClick={startEditPrice}>Edit</button>
                    {detailListing.price_override != null && (
                      <button className="mini-btn" onClick={clearPriceOverride}>Reset</button>
                    )}
                  </span>
                )}
              </div>
              {detailListing.price_override != null && (
                <div className="price-sub">API price: {formatPrice(detailListing.price_min, detailListing.price_max)}</div>
              )}
              {detailListing.base_price_min != null && promotionDiscount(detailListing) == null && detailListing.price_override == null && (
                <div className="price-sub">Base price (calc. basis): {formatPrice(detailListing.base_price_min, detailListing.base_price_max)}</div>
              )}

              <div>Last fetched: {formatDate(detailListing.last_fetched)}</div>
            </div>

            {intl && (
              <div className="detail-intl">
                <h3>International prices & shipping</h3>
                <table className="variant-table">
                  <thead>
                    <tr>
                      <th>Country</th>
                      <th>Ships</th>
                      <th>Price</th>
                      <th>Delivery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intl.countries.map((c) => (
                      <tr key={c.country} className={c.ships ? "" : "intl-noship"}>
                        <td>{c.country}</td>
                        <td>
                          {c.error ? (
                            <span className="badge out-of-stock" title={c.error}>error</span>
                          ) : c.ships ? (
                            <span className="badge in-stock">yes</span>
                          ) : (
                            <span className="badge out-of-stock" title={c.freight_msg ?? ""}>no</span>
                          )}
                        </td>
                        <td>
                          {c.price_min != null
                            ? `${c.price_min.toFixed(2)}${c.price_max != null && c.price_max !== c.price_min ? `–${c.price_max.toFixed(2)}` : ""} ${c.currency}`
                            : "—"}
                        </td>
                        <td className="intl-delivery">
                          {c.ships ? (
                            <>
                              {c.free_shipping ? "Free" : ""}
                              {c.delivery_company ? ` ${c.delivery_company}` : ""}
                              {c.delivery_days ? ` · ${c.delivery_days}` : ""}
                              {!c.delivery_company && !c.delivery_days ? "—" : ""}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="intl-note">
                  Availability comes from the freight endpoint (real per-country
                  deliverability). Price comes from the product API.
                </p>
              </div>
            )}

            {detailListing.variants.length > 0 && (
              <div className="detail-variants">
                <h3>Variants</h3>
                <table className="variant-table">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      <th>Price</th>
                      <th>Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailListing.variants.map((v, i) => (
                      <tr key={i}>
                        <td>{v.label}</td>
                        <td>{v.price != null ? `$${v.price.toFixed(2)}` : "—"}</td>
                        <td>
                          {v.in_stock === false ? (
                            <span className="badge out-of-stock">out of stock</span>
                          ) : v.in_stock === true ? (
                            <span className="badge in-stock">in stock</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {detailListing.debug_json && (
              <div className="detail-debug-line">
                <span>Debug JSON</span>
                <button className="mini-btn" onClick={copyDebugJson}>
                  {copiedDebug ? "Copied" : "Copy"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lightbox for viewing images large */}
      {lightbox && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" onClick={() => setLightbox(null)}>✕</button>
          {lightbox.images.length > 1 && (
            <button
              className="lightbox-nav prev"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox((lb) =>
                  lb ? { ...lb, index: (lb.index - 1 + lb.images.length) % lb.images.length } : lb
                );
              }}
            >
              ‹
            </button>
          )}
          <img
            src={lightbox.images[lightbox.index]}
            alt=""
            className="lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.images.length > 1 && (
            <button
              className="lightbox-nav next"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox((lb) =>
                  lb ? { ...lb, index: (lb.index + 1) % lb.images.length } : lb
                );
              }}
            >
              ›
            </button>
          )}
        </div>
      )}

      {/* Conflict popup: batch refetch over manually-edited listings */}
      {conflict && (
        <div className="modal-backdrop" onClick={() => setConflict(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Manual edits found</h2>
            <p className="conflict-intro">
              These listings have a manually edited price. Check the ones you want the
              refetch to overwrite with fresh API data. Unchecked listings keep their
              manual price.
            </p>
            <div className="conflict-list">
              {conflict.edited.map((l) => (
                <label key={l.id} className="conflict-row">
                  <input
                    type="checkbox"
                    checked={conflict.release.has(l.id)}
                    onChange={() => {
                      setConflict((c) => {
                        if (!c) return c;
                        const release = new Set(c.release);
                        if (release.has(l.id)) release.delete(l.id);
                        else release.add(l.id);
                        return { ...c, release };
                      });
                    }}
                  />
                  <span className="conflict-title">{l.title}</span>
                  {l.source_url && (
                    <a href={l.source_url} target="_blank" rel="noreferrer" className="conflict-link">
                      open
                    </a>
                  )}
                  <span className="conflict-price">${l.price_override?.toFixed(2)}</span>
                </label>
              ))}
            </div>
            <div className="conflict-actions">
              <button
                className="secondary-btn"
                onClick={() => {
                  const c = conflict;
                  setConflict(null);
                  if (c) runRefetch(c.ids, c.release);
                }}
              >
                Refetch
              </button>
              <button className="secondary-btn" onClick={() => setConflict(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
