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

function formatPrice(min: number | null, max: number | null): string {
  if (min == null && max == null) return "—";
  if (min == null) return `$${max!.toFixed(2)}`;
  if (max == null || min === max) return `$${min.toFixed(2)}`;
  return `$${min.toFixed(2)} – $${max.toFixed(2)}`;
}

export default function App() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettingsState] = useState<Settings>({
    concurrency: 1,
    sleep_seconds: 2,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailListing, setDetailListing] = useState<Listing | null>(null);
  const [downloadingImages, setDownloadingImages] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [refetching, setRefetching] = useState(false);

  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hasCredentials, setHasCredentials] = useState<boolean | null>(null);
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [credsSaved, setCredsSaved] = useState(false);

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

  async function runSingleSearch() {
    const value = searchInput.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setStatusMsg(null);
    try {
      await invoke("search_one", { input: value });
      setSearchInput("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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
      const updated = await invoke<Listing>("refetch_listing", { id: detailListing.id });
      setDetailListing(updated);
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
    setLoading(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await invoke<BulkSearchResult>("search_bulk", { input: text });
      setStatusMsg(
        `Added ${result.added} listing${result.added === 1 ? "" : "s"}` +
          (result.errors.length > 0 ? `, ${result.errors.length} failed` : "")
      );
      if (result.errors.length > 0) {
        setError(result.errors.join("\n"));
      }
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
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
      if (detailListing?.id === id) setDetailListing(null);
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

  function toggleExpanded(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div className="app">
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
            disabled={loading}
          />
          {loading && <span className="search-spinner">Searching…</span>}
        </div>
      </div>

      {statusMsg && <div className="status">{statusMsg}</div>}
      {error && <div className="error">{error}</div>}

      {selected.size > 0 && (
        <div className="bulk-actions">
          <span>{selected.size} selected</span>
          <button onClick={handleDeleteSelected}>Delete selected</button>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th className="col-check"></th>
            <th className="col-img"></th>
            <th>Title</th>
            <th>Warehouse</th>
            <th>Price</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => (
            <Fragment key={l.id}>
              <tr>
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
                  <button className="title-link" onClick={() => setDetailListing(l)}>
                    {l.title}
                  </button>
                  {l.variants.length > 0 && (
                    <button
                      className="variant-toggle"
                      onClick={() => toggleExpanded(l.id)}
                    >
                      {expandedId === l.id ? "▲" : "▼"} {l.variants.length} variants
                    </button>
                  )}
                </td>
                <td>{l.warehouse ?? "—"}</td>
                <td>{formatPrice(l.price_min, l.price_max)}</td>
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
                    <td>
                      {v.in_stock === false ? (
                        <span className="badge out-of-stock">out of stock</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{v.price != null ? `$${v.price.toFixed(2)}` : "—"}</td>
                    <td></td>
                  </tr>
                ))}
            </Fragment>
          ))}
          {listings.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
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
              {credsSaved && <div className="auth-status ok">Saved to python/api_keys.env</div>}

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

      {detailListing && (
        <div className="detail-backdrop" onClick={() => { setDetailListing(null); setDownloadMsg(null); setCopiedDebug(false); }}>
          <div className="detail-drawer" onClick={(e) => e.stopPropagation()}>
            <button className="close-x" onClick={() => { setDetailListing(null); setDownloadMsg(null); setCopiedDebug(false); }}>
              ✕
            </button>
            <div className="detail-images">
              {detailListing.images.length > 0 ? (
                detailListing.images.map((img, i) => (
                  <img key={i} src={img} alt="" className="detail-img" />
                ))
              ) : (
                <div className="thumb placeholder large" />
              )}
            </div>
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
                <div>Warehouse: {detailListing.warehouse ?? "unknown"}</div>
                <div>Price: {formatPrice(detailListing.price_min, detailListing.price_max)}</div>
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
        </div>
      )}
    </div>
  );
}
