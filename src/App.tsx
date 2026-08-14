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
};

type Settings = {
  concurrency: number;
  sleep_seconds: number;
};

type BulkSearchResult = {
  added: number;
  errors: string[];
};

type AuthStatus = {
  ok: boolean;
  message: string;
};

// Must match CURRENT_DATA_VERSION in src-tauri/src/lib.rs
const CURRENT_DATA_VERSION = 2;

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
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [downloadingImages, setDownloadingImages] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [refetching, setRefetching] = useState(false);

  // price editing in detail view
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceDraft, setPriceDraft] = useState("");

  // image lightbox
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);

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

  async function handleRefetch() {
    if (!detailListing) return;
    setRefetching(true);
    setDownloadMsg(null);
    try {
      await invoke<Listing>("refetch_listing", { id: detailListing.id });
      await refresh();
    } catch (e) {
      setDownloadMsg(String(e));
    } finally {
      setRefetching(false);
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

  async function handleDelete(id: string) {
    try {
      await invoke("delete_listing", { id });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (detailId === id) setDetailId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
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

  return (
    <div className={`app ${detailListing ? "with-detail" : ""}`}>
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
            <th>Title</th>
            <th>Category</th>
            <th>Warehouse</th>
            <th>Price</th>
            <th>Last fetched</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => (
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
                  <button className="title-link" onClick={() => setDetailId(l.id)}>
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
                <td>{l.category ?? "—"}</td>
                <td>{l.warehouse ?? "—"}</td>
                <td>{displayPrice(l)}</td>
                <td className="col-date">{formatDate(l.last_fetched)}</td>
                <td className="col-actions">
                  <button className="delete-btn" onClick={() => handleDelete(l.id)}>
                    ✕
                  </button>
                </td>
              </tr>
              {expandedId === l.id &&
                l.variants.map((v, i) => (
                  <tr key={`${l.id}-variant-${i}`} className="variant-row">
                    <td className="col-check"></td>
                    <td className="col-img"></td>
                    <td className="variant-label">{v.label}</td>
                    <td></td>
                    <td>
                      {v.in_stock === false ? (
                        <span className="badge out-of-stock">out of stock</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{v.price != null ? `$${v.price.toFixed(2)}` : "—"}</td>
                    <td></td>
                    <td></td>
                  </tr>
                ))}
            </Fragment>
          ))}
          {listings.length === 0 && (
            <tr>
              <td colSpan={8} className="empty">
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

      {/* Detail drawer — no backdrop, so the table stays usable beside it */}
      {detailListing && (
        <div className="detail-drawer" onClick={(e) => e.stopPropagation()}>
          <button className="close-x" onClick={() => { setDetailId(null); setDownloadMsg(null); setCopiedDebug(false); setEditingPrice(false); }}>
            ✕
          </button>

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
            <h2>{detailListing.title}</h2>
            <div className="detail-actions">
              {detailListing.source_url && (
                <button
                  className="secondary-btn download-btn"
                  onClick={handleRefetch}
                  disabled={refetching}
                >
                  {refetching ? "Refetching…" : "Refetch data"}
                </button>
              )}
              {detailListing.images.length > 0 && (
                <button
                  className="secondary-btn download-btn"
                  onClick={handleDownloadImages}
                  disabled={downloadingImages}
                >
                  {downloadingImages ? "Downloading…" : "Download images"}
                </button>
              )}
            </div>
            {downloadMsg && <div className="download-msg">{downloadMsg}</div>}

            <div className="detail-meta">
              {detailListing.store_name && <div>Store: {detailListing.store_name}</div>}
              {detailListing.brand && <div>Brand: {detailListing.brand}</div>}
              {detailListing.category && <div>Category: {detailListing.category}</div>}
              <div>Warehouse: {detailListing.warehouse ?? "unknown"}</div>

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
                    {displayPrice(detailListing)}
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

              <div>Last fetched: {formatDate(detailListing.last_fetched)}</div>
              {detailListing.source_url && (
                <div>
                  <a href={detailListing.source_url} target="_blank" rel="noreferrer">
                    View on AliExpress
                  </a>
                </div>
              )}
            </div>

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
              <div className="detail-debug">
                <div className="detail-debug-head">
                  <h3>Debug JSON</h3>
                  <button className="secondary-btn download-btn" onClick={copyDebugJson}>
                    {copiedDebug ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="debug-json">{detailListing.debug_json}</pre>
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
