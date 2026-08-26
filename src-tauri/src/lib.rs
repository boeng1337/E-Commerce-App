use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{Manager, State};
use tokio::process::Command as TokioCommand;
use tokio::sync::Semaphore;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    pub label: String,
    pub price: Option<f64>,
    pub in_stock: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Listing {
    pub id: String,
    pub title: String,
    pub main_image: Option<String>,
    pub images: Vec<String>,
    pub warehouse: Option<String>,
    pub price_min: Option<f64>,
    pub price_max: Option<f64>,
    pub stock: Option<i64>,
    pub variants: Vec<Variant>,
    pub source: String, // "aliexpress" | "manual"
    pub source_url: Option<String>,
    pub store_name: Option<String>,
    pub brand: Option<String>,
    pub debug_json: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub data_version: Option<i64>,
    #[serde(default)]
    pub last_fetched: Option<i64>, // Unix seconds
    #[serde(default)]
    pub price_override: Option<f64>, // manual edit, protected from refetch
    #[serde(default)]
    pub store_country: Option<String>,
    #[serde(default)]
    pub store_rating: Option<f64>,
    #[serde(default)]
    pub product_rating: Option<f64>,
    #[serde(default)]
    pub sales_count: Option<String>,
    #[serde(default)]
    pub product_status: Option<String>,
    #[serde(default)]
    pub ships: Option<bool>,
    #[serde(default)]
    pub primary_sku_id: Option<String>,
    #[serde(default)]
    pub base_price_min: Option<f64>, // account-neutral base (calculation basis)
    #[serde(default)]
    pub base_price_max: Option<f64>,
    #[serde(default)]
    pub international: Vec<CountryResult>, // per-country price + deliverability, stored
    #[serde(default)]
    pub skus: Vec<SkuDetail>, // full SKU list for continent-aware freight selection
}

/// Bump this whenever a fetch starts capturing new data. Listings stamped with
/// a lower version (or none) are considered "outdated" and can be refetched to
/// bring them up to the current shape.
pub const CURRENT_DATA_VERSION: i64 = 7;

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub concurrency: usize, // 1-3
    pub sleep_seconds: f64, // 1-5
    #[serde(default = "default_home_country")]
    pub home_country: String, // e.g. "FR"
    #[serde(default = "default_home_currency")]
    pub home_currency: String, // e.g. "EUR"
    #[serde(default)]
    pub international_enabled: bool,
    #[serde(default = "default_check_countries")]
    pub check_countries: Vec<String>, // ISO codes to check for international view
    #[serde(default)]
    pub hidden_columns: Vec<String>, // column keys the user has hidden
    #[serde(default)]
    pub sort_key: Option<String>,
    #[serde(default)]
    pub sort_dir: Option<String>, // "asc" | "desc"
}

fn default_home_country() -> String {
    "FR".to_string()
}
fn default_home_currency() -> String {
    "EUR".to_string()
}
fn default_check_countries() -> Vec<String> {
    // EU market by default (mirrors AliExpress ship-to destinations; real
    // markets only, no micro-states).
    vec![
        "FR", "DE", "ES", "IT", "NL", "BE", "PL", "PT", "SE", "AT", "IE", "DK",
        "FI", "GR", "CZ", "RO", "HU", "SK", "BG", "HR", "LT", "LV", "EE", "SI",
        "LU",
    ]
    .into_iter()
    .map(|s| s.to_string())
    .collect()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            concurrency: 1,
            sleep_seconds: 2.0,
            home_country: default_home_country(),
            home_currency: default_home_currency(),
            international_enabled: false,
            check_countries: default_check_countries(),
            hidden_columns: vec![],
            sort_key: None,
            sort_dir: None,
        }
    }
}

impl Settings {
    fn clamp(mut self) -> Self {
        self.concurrency = self.concurrency.clamp(1, 3);
        self.sleep_seconds = self.sleep_seconds.clamp(1.0, 5.0);
        if self.home_country.trim().is_empty() {
            self.home_country = default_home_country();
        }
        if self.home_currency.trim().is_empty() {
            self.home_currency = default_home_currency();
        }
        self
    }
}

/// Currency to use for a given country when querying its price. EU countries
/// use EUR; a few common non-euro ones are mapped. Falls back to the home
/// currency for anything unmapped.
fn currency_for_country(country: &str, home_currency: &str) -> String {
    match country {
        "PL" => "PLN",
        "SE" => "SEK",
        "DK" => "DKK",
        "CZ" => "CZK",
        "RO" => "RON",
        "HU" => "HUF",
        "BG" => "BGN",
        "HR" => "EUR", // Croatia adopted EUR in 2023
        "FR" | "DE" | "ES" | "IT" | "NL" | "BE" | "PT" | "AT" | "IE" | "FI"
        | "GR" | "SK" | "LT" | "LV" | "EE" | "SI" | "LU" => "EUR",
        _ => home_currency,
    }
    .to_string()
}

/// Per-SKU detail parsed from the product, used for continent-aware freight
/// selection (which warehouse can serve which destination).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkuDetail {
    pub sku_id: Option<String>,
    pub label: Option<String>,
    pub ship_from: Option<String>, // warehouse origin, e.g. "China Mainland", "Allemagne"
    pub stock: Option<i64>,
    pub price: Option<f64>,
}

/// Maps a country (ISO-2 or a ship-from label) to a coarse continent bucket.
/// Groups: Europe, Russia (alone), Americas (N+S merged), Oceania, Asia, China.
/// China is special — it ships worldwide, so it's always a candidate.
fn continent_of(name: &str) -> &'static str {
    let n = name.to_lowercase();
    // China detection (label or code) — its own bucket, always checked.
    if n.contains("china") || n.contains("chine") || n == "cn" {
        return "China";
    }
    if n.contains("russia") || n.contains("russie") || n == "ru" {
        return "Russia";
    }
    // Ship-from labels are country names (often French from the API); ISO codes
    // are destinations. Cover both.
    const EUROPE: &[&str] = &[
        "de","fr","es","it","pl","nl","be","se","at","dk","fi","gr","cz","ro","hu",
        "sk","bg","hr","lt","lv","ee","si","lu","pt","ie","uk","gb",
        "allemagne","france","espagne","italie","pologne","pays-bas","belgique",
        "suède","autriche","danemark","finlande","grèce","royaume-uni","portugal",
        "irlande","tchèque","république tchèque","roumanie","hongrie",
        "émirats arabes unis","uae", // gulf warehouses tend to serve EU routes; keep with EU cluster
    ];
    const AMERICAS: &[&str] = &[
        "us","usa","ca","mx","br","ar","cl","co","pe","uy","bo","py","ec","ve",
        "états-unis","etats-unis","canada","mexique","brésil","bresil","argentine",
        "chili","colombie","pérou","perou",
    ];
    const OCEANIA: &[&str] = &["au","nz","australie","nouvelle-zélande","new zealand"];
    const ASIA: &[&str] = &[
        "jp","kr","sg","my","th","vn","id","ph","in","hk","tw",
        "japon","corée","corée du sud","singapour","malaisie","thaïlande",
        "vietnam","indonésie","philippines","inde","hong kong","taïwan",
    ];

    if EUROPE.iter().any(|c| n == *c) {
        "Europe"
    } else if AMERICAS.iter().any(|c| n == *c) {
        "Americas"
    } else if OCEANIA.iter().any(|c| n == *c) {
        "Oceania"
    } else if ASIA.iter().any(|c| n == *c) {
        "Asia"
    } else {
        "Other"
    }
}

/// Per-country result of an international availability/price check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountryResult {
    pub country: String,
    pub ships: bool,
    pub price_min: Option<f64>,
    pub price_max: Option<f64>,
    pub currency: String,
    pub variants: Vec<Variant>,
    pub error: Option<String>,
    // freight (real deliverability) fields
    pub delivery_company: Option<String>,
    pub delivery_days: Option<String>,
    pub free_shipping: Option<bool>,
    pub freight_msg: Option<String>,
    // which warehouse actually served this country, and the matched SKU's price
    pub ship_from: Option<String>,
    pub matched_price: Option<f64>,
    pub matched_variant: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InternationalResult {
    pub id: String,
    pub countries: Vec<CountryResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkSearchResult {
    pub added: usize,
    pub errors: Vec<String>, // "input: error message"
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadResult {
    pub folder: String,
    pub saved: usize,
    pub errors: Vec<String>,
}

pub struct AppState {
    pub listings: Mutex<Vec<Listing>>,
    pub settings: Mutex<Settings>,
    pub settings_path: Mutex<PathBuf>,
    pub listings_path: Mutex<PathBuf>,
}

// ---------------------------------------------------------------------------
// App folder: ~/Documents/AliExpress Manager — one place for everything
// (product list, credentials, downloaded image dossiers).
// ---------------------------------------------------------------------------

fn app_folder() -> PathBuf {
    // Resolve ~/Documents/AliExpress Manager the same way the Python side does,
    // so Rust and Python always agree. Prefer the XDG documents dir, then
    // ~/Documents via home_dir, then $HOME directly. Only as an absolute last
    // resort (no home discoverable at all) do we fall back to the working dir —
    // and even then into a clearly-named subfolder, never scattering files into
    // wherever the app was launched from.
    let home = dirs::home_dir()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    let docs = dirs::document_dir()
        .or_else(|| home.as_ref().map(|h| h.join("Documents")))
        .unwrap_or_else(|| PathBuf::from("./AliExpress-Manager-data"));
    let dir = docs.join("AliExpress Manager");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Sanitises a listing title into a safe folder name: strips path separators
/// and characters illegal on common filesystems, collapses whitespace, and
/// truncates to a conservative length so the full path stays well under OS
/// limits.
fn safe_folder_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => ' ',
            _ => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(80).collect();
    let out = trimmed.trim().to_string();
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn load_settings(path: &PathBuf) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .map(|s| s.clamp())
        .unwrap_or_default()
}

fn save_settings(path: &PathBuf, settings: &Settings) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, json);
    }
}

// ---------------------------------------------------------------------------
// Listings persistence — listings.json survives exit/re-enter
// ---------------------------------------------------------------------------

fn load_listings(path: &PathBuf) -> Vec<Listing> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Listing>>(&s).ok())
        .unwrap_or_default()
}

fn save_listings(path: &PathBuf, listings: &[Listing]) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(listings) {
        let _ = std::fs::write(path, json);
    }
}

/// Persists the current in-memory listings to disk. Call after every mutation
/// so the product list is always current on next launch.
fn persist_listings(state: &AppState) {
    let listings = state.listings.lock().unwrap().clone();
    let path = state.listings_path.lock().unwrap().clone();
    save_listings(&path, &listings);
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Settings) -> Settings {
    let clamped = settings.clamp();
    *state.settings.lock().unwrap() = clamped.clone();
    let path = state.settings_path.lock().unwrap().clone();
    save_settings(&path, &clamped);
    clamped
}

// ---------------------------------------------------------------------------
// Listings CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_listings(state: State<AppState>) -> Vec<Listing> {
    state.listings.lock().unwrap().clone()
}

#[tauri::command]
fn add_manual_listing(state: State<AppState>, title: String, price: f64, stock: i64) -> Listing {
    let listing = Listing {
        id: Uuid::new_v4().to_string(),
        title,
        main_image: None,
        images: vec![],
        warehouse: None,
        price_min: Some(price),
        price_max: Some(price),
        stock: Some(stock),
        variants: vec![],
        source: "manual".to_string(),
        source_url: None,
        store_name: None,
        brand: None,
        debug_json: None,
        category: None,
        data_version: Some(CURRENT_DATA_VERSION),
        last_fetched: Some(now_unix()),
        price_override: None,
        store_country: None,
        store_rating: None,
        product_rating: None,
        sales_count: None,
        product_status: None,
        ships: None,
        primary_sku_id: None,
        base_price_min: None,
        base_price_max: None,
        international: vec![],
        skus: vec![],
    };
    state.listings.lock().unwrap().push(listing.clone());
    persist_listings(&state);
    listing
}

#[tauri::command]
fn delete_listing(state: State<AppState>, id: String) -> bool {
    let mut listings = state.listings.lock().unwrap();
    let before = listings.len();
    listings.retain(|l| l.id != id);
    let changed = listings.len() != before;
    drop(listings);
    if changed {
        persist_listings(&state);
    }
    changed
}

// ---------------------------------------------------------------------------
// Python subprocess bridge (ae_client.py / ae_cli.py)
// ---------------------------------------------------------------------------

/// Locates a python script by name (e.g. "ae_cli.py", "ae_freight_cli.py").
/// Checks (in order): AE_CLI_PATH env override's directory, the repo's python/
/// dir at compile time (dev builds only), then a python/ folder next to the
/// running executable (release layout).
fn resolve_named_script(name: &str) -> PathBuf {
    if let Ok(p) = std::env::var("AE_CLI_PATH") {
        // AE_CLI_PATH points at ae_cli.py; use its directory for siblings.
        let base = PathBuf::from(&p);
        if let Some(dir) = base.parent() {
            let candidate = dir.join(name);
            if candidate.exists() || name != "ae_cli.py" {
                return candidate;
            }
        }
        return base;
    }

    #[cfg(debug_assertions)]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../python")
            .join(name);
        if dev_path.exists() {
            return dev_path;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("python").join(name);
            if p.exists() {
                return p;
            }
        }
    }

    PathBuf::from(format!("python/{name}"))
}

/// Locates ae_cli.py (back-compat wrapper).
fn resolve_script_path() -> PathBuf {
    resolve_named_script("ae_cli.py")
}

fn python_bin() -> String {
    std::env::var("AE_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string())
}

/// Runs ae_cli.py <input> [country] [currency] [base] and parses its JSON.
/// When `base` is true, passes the base-price flag (remove_personal_benefit).
async fn fetch_raw(
    input: &str,
    country: &str,
    currency: &str,
    base: bool,
) -> Result<serde_json::Value, String> {
    let script = resolve_script_path();
    let mut cmd = TokioCommand::new(python_bin());
    cmd.arg(&script).arg(input).arg(country).arg(currency);
    if base {
        cmd.arg("base");
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run python ({}): {e}", script.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout_trimmed = stdout.trim();

    if stdout_trimmed.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("python produced no output. stderr: {stderr}"));
    }

    let json: serde_json::Value = serde_json::from_str(stdout_trimmed).map_err(|e| {
        format!("failed to parse python output as JSON: {e} (raw: {stdout_trimmed})")
    })?;

    if let Some(err) = json.get("error") {
        return Err(err.as_str().unwrap_or("unknown python error").to_string());
    }
    Ok(json)
}

fn prices_from_json(json: &serde_json::Value) -> (Option<f64>, Option<f64>) {
    let prices: Vec<f64> = json
        .get("prices")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
        .unwrap_or_default();
    let min = prices
        .iter()
        .cloned()
        .fold(None, |acc: Option<f64>, p| Some(acc.map_or(p, |a| a.min(p))));
    let max = prices
        .iter()
        .cloned()
        .fold(None, |acc: Option<f64>, p| Some(acc.map_or(p, |a| a.max(p))));
    (min, max)
}

/// Fetches and builds a full Listing for the given country/currency. Does a
/// DOUBLE fetch of the same product id (no sleep between — same id): the
/// promotional price (default) becomes the listing's price_min/max, and a
/// second base-price fetch (remove_personal_benefit) fills base_price_min/max.
/// If `intl` is Some, also computes per-country international results inline and
/// stores them on the listing (same product id — no sleep between any of it).
async fn fetch_one_in(
    input: &str,
    country: &str,
    currency: &str,
    intl: Option<(&[String], &str)>, // (countries, home_currency)
) -> Result<Listing, String> {
    // promotional fetch (the price shown / priority)
    let promo_json = fetch_raw(input, country, currency, false).await?;
    let mut listing = parse_product_json(&promo_json, input)?;

    // base fetch (calculation basis) — same id, no sleep between
    if let Ok(base_json) = fetch_raw(input, country, currency, true).await {
        let (bmin, bmax) = prices_from_json(&base_json);
        listing.base_price_min = bmin;
        listing.base_price_max = bmax;
    }

    // inline international — same product id, no sleep
    if let Some((countries, home_currency)) = intl {
        if !countries.is_empty() {
            let skus = listing.skus.clone();
            listing.international =
                compute_international(input, &skus, countries, home_currency).await;
        }
    }

    Ok(listing)
}

/// Fetches a Listing using the app's configured home market, optionally with
/// inline international results.
async fn fetch_one(
    input: &str,
    home_country: &str,
    home_currency: &str,
    intl: Option<(&[String], &str)>,
) -> Result<Listing, String> {
    fetch_one_in(input, home_country, home_currency, intl).await
}

/// Extracts the numeric product id from a source URL or raw id string, mirroring
/// the Python _extract_product_id. Falls back to the input trimmed.
fn extract_product_id(input: &str) -> String {
    let s = input.trim();
    // /item/<id>.html
    if let Some(pos) = s.find("/item/") {
        let rest = &s[pos + 6..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            return digits;
        }
        // may have a locale segment before the id; grab the last long digit run
    }
    // longest run of >=8 digits anywhere
    let mut best = String::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() {
            cur.push(ch);
            if cur.len() > best.len() {
                best = cur.clone();
            }
        } else {
            cur.clear();
        }
    }
    if best.len() >= 8 {
        return best;
    }
    s.to_string()
}

/// Queries the AE-Freight endpoint (via ae_freight_cli.py) for real per-country
/// deliverability. Returns the parsed JSON: { ships, code, msg, options: [...] }.
async fn fetch_freight(
    product_id: &str,
    sku_id: &str,
    country: &str,
    currency: &str,
) -> Result<serde_json::Value, String> {
    let script = resolve_named_script("ae_freight_cli.py");
    let output = TokioCommand::new(python_bin())
        .arg(&script)
        .arg(product_id)
        .arg(sku_id)
        .arg(country)
        .arg(currency)
        .output()
        .await
        .map_err(|e| format!("failed to run freight cli ({}): {e}", script.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout_trimmed = stdout.trim();
    if stdout_trimmed.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("freight cli produced no output. stderr: {stderr}"));
    }

    let json: serde_json::Value = serde_json::from_str(stdout_trimmed)
        .map_err(|e| format!("failed to parse freight output: {e} (raw: {stdout_trimmed})"))?;
    if let Some(err) = json.get("error") {
        return Err(err.as_str().unwrap_or("unknown freight error").to_string());
    }
    Ok(json)
}

fn parse_product_json(json: &serde_json::Value, source_input: &str) -> Result<Listing, String> {
    let name = json
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled product")
        .to_string();

    let images: Vec<String> = json
        .get("images")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let warehouse = json
        .get("warehouse")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let stock = json.get("stock").and_then(|v| v.as_i64());

    let variants: Vec<Variant> = json
        .get("variant_prices")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let label = v.get("variant")?.as_str()?.to_string();
                    let price = v.get("price").and_then(|p| p.as_f64());
                    let in_stock = v.get("in_stock").and_then(|p| p.as_bool());
                    Some(Variant {
                        label,
                        price,
                        in_stock,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let prices: Vec<f64> = json
        .get("prices")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
        .unwrap_or_default();

    let price_min = prices
        .iter()
        .cloned()
        .fold(None, |acc: Option<f64>, p| Some(acc.map_or(p, |a| a.min(p))));
    let price_max = prices
        .iter()
        .cloned()
        .fold(None, |acc: Option<f64>, p| Some(acc.map_or(p, |a| a.max(p))));

    let source_url = json
        .get("clean_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| Some(source_input.to_string()));

    let store_name = json
        .get("store_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let brand = json
        .get("brand")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let debug_json = json
        .get("_raw")
        .map(|v| serde_json::to_string_pretty(v).unwrap_or_default());

    // category comes from Python as api_category_id (may be a number or string)
    let category = json.get("api_category_id").and_then(|v| {
        if let Some(s) = v.as_str() {
            Some(s.to_string())
        } else if let Some(n) = v.as_i64() {
            Some(n.to_string())
        } else {
            None
        }
    });

    let store_country = json
        .get("store_country")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let store_rating = json.get("store_rating").and_then(|v| v.as_f64());
    let product_rating = json.get("product_rating").and_then(|v| v.as_f64());
    let sales_count = json
        .get("sales_count")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let product_status = json
        .get("product_status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let ships = json.get("ships").and_then(|v| v.as_bool());
    let primary_sku_id = json
        .get("primary_sku_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let skus: Vec<SkuDetail> = json
        .get("skus")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|s| SkuDetail {
                    sku_id: s.get("sku_id").and_then(|v| v.as_str()).map(|x| x.to_string()),
                    label: s.get("label").and_then(|v| v.as_str()).map(|x| x.to_string()),
                    ship_from: s.get("ship_from").and_then(|v| v.as_str()).map(|x| x.to_string()),
                    stock: s.get("stock").and_then(|v| v.as_i64()),
                    price: s.get("price").and_then(|v| v.as_f64()),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Listing {
        id: Uuid::new_v4().to_string(),
        title: name,
        main_image: images.first().cloned(),
        images,
        warehouse,
        price_min,
        price_max,
        stock,
        variants,
        source: "aliexpress".to_string(),
        source_url,
        store_name,
        brand,
        debug_json,
        category,
        data_version: Some(CURRENT_DATA_VERSION),
        last_fetched: Some(now_unix()),
        price_override: None,
        store_country,
        store_rating,
        product_rating,
        sales_count,
        product_status,
        ships,
        primary_sku_id,
        base_price_min: None,
        base_price_max: None,
        international: vec![],
        skus,
    })
}

/// Searches a single URL/product ID.
#[tauri::command]
async fn search_one(state: State<'_, AppState>, input: String) -> Result<Listing, String> {
    let (hc, hcur, intl_countries) = {
        let s = state.settings.lock().unwrap();
        let countries = if s.international_enabled {
            s.check_countries.clone()
        } else {
            vec![]
        };
        (s.home_country.clone(), s.home_currency.clone(), countries)
    };
    let intl = if intl_countries.is_empty() {
        None
    } else {
        Some((intl_countries.as_slice(), hcur.as_str()))
    };
    let listing = fetch_one(input.trim(), &hc, &hcur, intl).await?;
    state.listings.lock().unwrap().push(listing.clone());
    persist_listings(&state);
    Ok(listing)
}

/// Re-fetches an existing listing from the API and replaces it in place,
/// preserving its id and position in the list. The manual price override is
/// preserved by default (protected from refetch); pass release_override=true
/// to drop it and let the API price win. Manual listings, which have no
/// source_url, can't be refetched.
#[tauri::command]
async fn refetch_listing(
    state: State<'_, AppState>,
    id: String,
    release_override: Option<bool>,
) -> Result<Listing, String> {
    let (source, prior_override, prior_intl) = {
        let listings = state.listings.lock().unwrap();
        let existing = listings
            .iter()
            .find(|l| l.id == id)
            .ok_or_else(|| "listing not found".to_string())?;
        let src = existing
            .source_url
            .clone()
            .ok_or_else(|| "this listing has no source URL to refetch".to_string())?;
        (src, existing.price_override, existing.international.clone())
    };
    let (hc, hcur) = {
        let s = state.settings.lock().unwrap();
        (s.home_country.clone(), s.home_currency.clone())
    };

    let mut fresh = fetch_one(source.trim(), &hc, &hcur, None).await?;
    fresh.id = id.clone();
    // keep the manual price override unless the caller explicitly releases it
    if release_override != Some(true) {
        fresh.price_override = prior_override;
    }
    // preserve stored international data (refetch doesn't redo the sweep)
    fresh.international = prior_intl;

    {
        let mut listings = state.listings.lock().unwrap();
        if let Some(slot) = listings.iter_mut().find(|l| l.id == id) {
            *slot = fresh.clone();
        } else {
            return Err("listing disappeared during refetch".to_string());
        }
    }
    persist_listings(&state);
    Ok(fresh)
}

/// True if a listing is behind the current data version or missing core data
/// (no price and no images) — i.e. "not correctly fetched" / outdated.
fn is_outdated(l: &Listing) -> bool {
    if l.source != "aliexpress" {
        return false; // manual listings are never "outdated"
    }
    let behind_version = l.data_version.unwrap_or(0) < CURRENT_DATA_VERSION;
    let missing_core = l.price_min.is_none() && l.images.is_empty();
    behind_version || missing_core
}

/// Returns the ids of all listings considered outdated.
#[tauri::command]
fn get_outdated_ids(state: State<AppState>) -> Vec<String> {
    state
        .listings
        .lock()
        .unwrap()
        .iter()
        .filter(|l| is_outdated(l))
        .map(|l| l.id.clone())
        .collect()
}

/// Sets (or clears, with null) the manual price override for a listing.
#[tauri::command]
fn set_price_override(
    state: State<AppState>,
    id: String,
    price: Option<f64>,
) -> Result<Listing, String> {
    let mut listings = state.listings.lock().unwrap();
    let slot = listings
        .iter_mut()
        .find(|l| l.id == id)
        .ok_or_else(|| "listing not found".to_string())?;
    slot.price_override = price;
    let updated = slot.clone();
    drop(listings);
    persist_listings(&state);
    Ok(updated)
}

/// Refetches many listings by id, sequentially, respecting the sleep setting.
/// `release_ids` lists the ids whose manual price override should be dropped;
/// all others keep their override. Returns how many succeeded and any errors.
#[tauri::command]
async fn refetch_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
    release_ids: Option<Vec<String>>,
) -> Result<BulkSearchResult, String> {
    let release: std::collections::HashSet<String> =
        release_ids.unwrap_or_default().into_iter().collect();
    let (sleep_secs, hc, hcur) = {
        let s = state.settings.lock().unwrap();
        (s.sleep_seconds, s.home_country.clone(), s.home_currency.clone())
    };

    let mut updated = 0usize;
    let mut errors = Vec::new();

    for id in ids {
        let (source, prior_override, prior_intl) = {
            let listings = state.listings.lock().unwrap();
            match listings.iter().find(|l| l.id == id) {
                Some(l) => match l.source_url.clone() {
                    Some(src) => (src, l.price_override, l.international.clone()),
                    None => {
                        errors.push(format!("{id}: no source URL"));
                        continue;
                    }
                },
                None => {
                    errors.push(format!("{id}: not found"));
                    continue;
                }
            }
        };

        match fetch_one(source.trim(), &hc, &hcur, None).await {
            Ok(mut fresh) => {
                fresh.id = id.clone();
                if !release.contains(&id) {
                    fresh.price_override = prior_override;
                }
                fresh.international = prior_intl;
                let mut listings = state.listings.lock().unwrap();
                if let Some(slot) = listings.iter_mut().find(|l| l.id == id) {
                    *slot = fresh;
                    updated += 1;
                }
            }
            Err(e) => errors.push(format!("{id}: {e}")),
        }
        sleep(Duration::from_secs_f64(sleep_secs)).await;
    }

    persist_listings(&state);
    Ok(BulkSearchResult {
        added: updated,
        errors,
    })
}

/// Computes per-country price + real deliverability for a product. Shared by the
/// inline fetch (when international is enabled) and the manual check command.
/// No sleep between countries: it's all one product id.
async fn compute_international(
    source: &str,
    skus: &[SkuDetail],
    countries: &[String],
    home_currency: &str,
) -> Vec<CountryResult> {
    let product_id = extract_product_id(source);
    let mut results = Vec::with_capacity(countries.len());

    // In-stock SKUs only (out-of-stock can never ship — never freight-check them).
    let in_stock: Vec<&SkuDetail> = skus
        .iter()
        .filter(|s| s.sku_id.is_some() && s.stock.map(|n| n > 0).unwrap_or(false))
        .collect();

    for country in countries {
        let currency = currency_for_country(country, home_currency);
        let dest_continent = continent_of(country);

        // price + variants (per-country) from product.get
        let (price_min, price_max, variants, mut price_err) =
            match fetch_raw(source.trim(), country, &currency, false).await {
                Ok(json) => {
                    let (pmin, pmax) = prices_from_json(&json);
                    let vars: Vec<Variant> = json
                        .get("variant_prices")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| {
                                    let label = v.get("variant")?.as_str()?.to_string();
                                    let price = v.get("price").and_then(|p| p.as_f64());
                                    let in_stock = v.get("in_stock").and_then(|p| p.as_bool());
                                    Some(Variant { label, price, in_stock })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (pmin, pmax, vars, None)
                }
                Err(e) => (None, None, vec![], Some(e)),
            };

        // Candidate SKUs for this destination: in-stock warehouses on the SAME
        // continent as the destination, PLUS China (ships worldwide). Skip
        // other continents entirely — cross-continental almost never ships and
        // we don't want to waste freight calls proving it.
        let mut candidates: Vec<&SkuDetail> = in_stock
            .iter()
            .filter(|s| {
                let origin = s.ship_from.as_deref().unwrap_or("");
                let oc = continent_of(origin);
                oc == "China" || oc == dest_continent
            })
            .map(|s| *s)
            .collect();
        // Check cheaper warehouses first so the first that ships is the cheapest.
        candidates.sort_by(|a, b| {
            a.price
                .unwrap_or(f64::INFINITY)
                .partial_cmp(&b.price.unwrap_or(f64::INFINITY))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut ships = false;
        let mut delivery_company = None;
        let mut delivery_days = None;
        let mut free_shipping = None;
        let mut freight_msg = None;
        let mut ship_from = None;
        let mut matched_price = None;
        let mut matched_variant = None;

        if candidates.is_empty() {
            freight_msg = Some("no in-stock warehouse on this continent or China".to_string());
        }

        for cand in &candidates {
            let sku = match cand.sku_id.as_deref() {
                Some(s) => s,
                None => continue,
            };
            match fetch_freight(&product_id, sku, country, &currency).await {
                Ok(fjson) => {
                    let this_ships = fjson.get("ships").and_then(|v| v.as_bool()).unwrap_or(false);
                    if this_ships {
                        ships = true;
                        ship_from = cand.ship_from.clone();
                        matched_price = cand.price;
                        matched_variant = cand.label.clone();
                        freight_msg = fjson.get("msg").and_then(|v| v.as_str()).map(|s| s.to_string());
                        if let Some(opts) = fjson.get("options").and_then(|v| v.as_array()) {
                            if let Some(first) = opts.first() {
                                delivery_company = first.get("company").and_then(|v| v.as_str()).map(|s| s.to_string());
                                free_shipping = first.get("free_shipping").and_then(|v| v.as_bool());
                                let min_d = first.get("min_days").and_then(|v| v.as_i64());
                                let max_d = first.get("max_days").and_then(|v| v.as_i64());
                                delivery_days = match (min_d, max_d) {
                                    (Some(a), Some(b)) => Some(format!("{a}–{b} days")),
                                    (Some(a), None) => Some(format!("{a}+ days")),
                                    _ => first.get("delivery_date_desc").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                };
                            }
                        }
                        break; // cheapest shipping candidate found — stop
                    } else if freight_msg.is_none() {
                        freight_msg = fjson.get("msg").and_then(|v| v.as_str()).map(|s| s.to_string());
                    }
                }
                Err(e) => {
                    if price_err.is_none() {
                        price_err = Some(format!("freight: {e}"));
                    }
                }
            }
        }

        results.push(CountryResult {
            country: country.clone(),
            ships,
            price_min,
            price_max,
            currency,
            variants,
            error: price_err,
            delivery_company,
            delivery_days,
            free_shipping,
            freight_msg,
            ship_from,
            matched_price,
            matched_variant,
        });
    }

    results
}

/// Manual per-country check command (kept for refreshing a single listing).
/// Stores the result on the listing so it persists.
#[tauri::command]
async fn check_international(
    state: State<'_, AppState>,
    id: String,
) -> Result<InternationalResult, String> {
    let (source, skus) = {
        let listings = state.listings.lock().unwrap();
        let existing = listings
            .iter()
            .find(|l| l.id == id)
            .ok_or_else(|| "listing not found".to_string())?;
        let src = existing
            .source_url
            .clone()
            .ok_or_else(|| "this listing has no source URL".to_string())?;
        (src, existing.skus.clone())
    };
    let (countries, home_currency) = {
        let s = state.settings.lock().unwrap();
        (s.check_countries.clone(), s.home_currency.clone())
    };

    let results = compute_international(&source, &skus, &countries, &home_currency).await;

    // persist onto the listing
    {
        let mut listings = state.listings.lock().unwrap();
        if let Some(slot) = listings.iter_mut().find(|l| l.id == id) {
            slot.international = results.clone();
        }
    }
    persist_listings(&state);

    Ok(InternationalResult { id, countries: results })
}

/// Searches many URLs/IDs (one per line of `input`), respecting the current
/// concurrency limit (max simultaneous python processes) and sleep-between-
/// searches setting from Settings.
#[tauri::command]
async fn search_bulk(
    state: State<'_, AppState>,
    input: String,
) -> Result<BulkSearchResult, String> {
    let lines: Vec<String> = input
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if lines.is_empty() {
        return Ok(BulkSearchResult {
            added: 0,
            errors: vec![],
        });
    }

    let settings = state.settings.lock().unwrap().clone();
    let semaphore = Arc::new(Semaphore::new(settings.concurrency));
    let sleep_secs = settings.sleep_seconds;
    let hc = settings.home_country.clone();
    let hcur = settings.home_currency.clone();
    let intl_countries: Vec<String> = if settings.international_enabled {
        settings.check_countries.clone()
    } else {
        vec![]
    };

    let mut handles = Vec::with_capacity(lines.len());
    for line in lines {
        let sem = semaphore.clone();
        let hc = hc.clone();
        let hcur = hcur.clone();
        let countries = intl_countries.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore closed");
            let intl = if countries.is_empty() {
                None
            } else {
                Some((countries.as_slice(), hcur.as_str()))
            };
            let result = fetch_one(&line, &hc, &hcur, intl).await;
            sleep(Duration::from_secs_f64(sleep_secs)).await;
            (line, result)
        }));
    }

    let mut added = 0usize;
    let mut errors = Vec::new();
    let mut new_listings = Vec::new();

    for handle in handles {
        match handle.await {
            Ok((line, Ok(listing))) => {
                new_listings.push(listing);
                added += 1;
                let _ = line;
            }
            Ok((line, Err(e))) => errors.push(format!("{line}: {e}")),
            Err(e) => errors.push(format!("task panicked: {e}")),
        }
    }

    state.listings.lock().unwrap().extend(new_listings);
    persist_listings(&state);

    Ok(BulkSearchResult { added, errors })
}

/// Downloads a listing's images into ~/Documents/AliExpress Manager/<title>/
/// as 1.jpg, 2.jpg, … in the order they appear on the listing. Returns the
/// folder path and how many saved. Determines each image's extension from its
/// URL, defaulting to .jpg.
#[tauri::command]
async fn download_images(state: State<'_, AppState>, id: String) -> Result<DownloadResult, String> {
    let listing = {
        let listings = state.listings.lock().unwrap();
        listings
            .iter()
            .find(|l| l.id == id)
            .cloned()
            .ok_or_else(|| "listing not found".to_string())?
    };

    if listing.images.is_empty() {
        return Err("this listing has no images".to_string());
    }

    let folder = app_folder().join(safe_folder_name(&listing.title));
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("could not create folder {}: {e}", folder.display()))?;

    let client = reqwest::Client::new();
    let mut saved = 0usize;
    let mut errors = Vec::new();

    for (i, url) in listing.images.iter().enumerate() {
        let ext = url
            .rsplit('/')
            .next()
            .and_then(|seg| seg.rsplit('.').next())
            .map(|e| e.split(['?', '#']).next().unwrap_or(e))
            .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or("jpg");
        let filename = format!("{}.{}", i + 1, ext);
        let dest = folder.join(&filename);

        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(bytes) => {
                    if let Err(e) = std::fs::write(&dest, &bytes) {
                        errors.push(format!("{filename}: write failed: {e}"));
                    } else {
                        saved += 1;
                    }
                }
                Err(e) => errors.push(format!("{filename}: read failed: {e}")),
            },
            Ok(resp) => errors.push(format!("{filename}: HTTP {}", resp.status())),
            Err(e) => errors.push(format!("{filename}: request failed: {e}")),
        }
    }

    Ok(DownloadResult {
        folder: folder.display().to_string(),
        saved,
        errors,
    })
}

// ---------------------------------------------------------------------------
// AliExpress connection / auth flow (via ae_auth_cli.py)
// ---------------------------------------------------------------------------

async fn run_auth_cli(args: &[&str]) -> Result<serde_json::Value, String> {
    let script = resolve_script_path()
        .parent()
        .map(|p| p.join("ae_auth_cli.py"))
        .ok_or_else(|| "could not resolve ae_auth_cli.py path".to_string())?;

    let output = TokioCommand::new(python_bin())
        .arg(&script)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to run python ({}): {e}", script.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("python produced no output. stderr: {stderr}"));
    }

    serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse python output as JSON: {e} (raw: {trimmed})"))
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
async fn get_auth_status() -> Result<AuthStatus, String> {
    let json = run_auth_cli(&["status"]).await?;
    Ok(AuthStatus {
        ok: json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        message: json
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown status")
            .to_string(),
    })
}

#[tauri::command]
async fn set_redirect_uri(uri: String) -> Result<(), String> {
    let json = run_auth_cli(&["set-redirect", &uri]).await?;
    if json.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err(json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to save redirect URI")
            .to_string())
    }
}

/// Returns the AliExpress authorization URL and opens it in the system's
/// default browser.
#[tauri::command]
async fn open_auth_page() -> Result<String, String> {
    let json = run_auth_cli(&["url"]).await?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let url = json
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("no url returned")?
        .to_string();

    open_in_browser(&url)?;
    Ok(url)
}

/// Opens an arbitrary URL in the system browser (used by the detail-view title
/// link, so it lands in a real browser rather than the app webview).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open_in_browser(&url)
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", url])
        .spawn();

    result
        .map(|_| ())
        .map_err(|e| format!("failed to open browser: {e}"))
}

#[tauri::command]
async fn exchange_auth_code(code: String) -> Result<AuthStatus, String> {
    let json = run_auth_cli(&["exchange", &code]).await?;
    if json.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(AuthStatus {
            ok: true,
            message: "Connected successfully.".to_string(),
        })
    } else {
        let err = json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("exchange failed")
            .to_string();
        Ok(AuthStatus { ok: false, message: err })
    }
}

#[tauri::command]
async fn set_ae_credentials(app_key: String, app_secret: String) -> Result<(), String> {
    let key_json = run_auth_cli(&["set-key", &app_key]).await?;
    if key_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(key_json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to save app key")
            .to_string());
    }
    let secret_json = run_auth_cli(&["set-secret", &app_secret]).await?;
    if secret_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(secret_json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to save app secret")
            .to_string());
    }
    Ok(())
}

#[tauri::command]
async fn has_ae_credentials() -> Result<bool, String> {
    let json = run_auth_cli(&["has-credentials"]).await?;
    Ok(json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let folder = app_folder();
            let settings_path = folder.join("settings.json");
            let listings_path = folder.join("listings.json");
            let settings = load_settings(&settings_path);
            let listings = load_listings(&listings_path);

            app.manage(AppState {
                listings: Mutex::new(listings),
                settings: Mutex::new(settings),
                settings_path: Mutex::new(settings_path),
                listings_path: Mutex::new(listings_path),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_listings,
            add_manual_listing,
            delete_listing,
            search_one,
            search_bulk,
            refetch_listing,
            refetch_many,
            check_international,
            get_outdated_ids,
            set_price_override,
            download_images,
            get_settings,
            set_settings,
            get_auth_status,
            set_redirect_uri,
            open_auth_page,
            open_url,
            exchange_auth_code,
            set_ae_credentials,
            has_ae_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
