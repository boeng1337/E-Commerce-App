import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Listing = {
  id: string;
  title: string;
  price: number;
  stock: number;
  source: "aliexpress" | "manual";
};

export default function App() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Listing[]>("get_listings");
      setListings(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function syncAliExpress() {
    setLoading(true);
    setError(null);
    try {
      await invoke("sync_aliexpress");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Listing Manager</h1>
        <div className="actions">
          <button onClick={syncAliExpress} disabled={loading}>
            {loading ? "Syncing..." : "Sync AliExpress"}
          </button>
          <button onClick={refresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Price</th>
            <th>Stock</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => (
            <tr key={l.id}>
              <td>{l.title}</td>
              <td>${l.price.toFixed(2)}</td>
              <td>{l.stock}</td>
              <td>
                <span className={`badge ${l.source}`}>{l.source}</span>
              </td>
            </tr>
          ))}
          {listings.length === 0 && !loading && (
            <tr>
              <td colSpan={4} className="empty">
                No listings yet. Click "Sync AliExpress" or add one manually.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
