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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub concurrency: usize, // 1-3
    pub sleep_seconds: f64, // 1-5
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            concurrency: 1,
            sleep_seconds: 2.0,
        }
    }
}

impl Settings {
    fn clamp(mut self) -> Self {
        self.concurrency = self.concurrency.clamp(1, 3);
        self.sleep_seconds = self.sleep_seconds.clamp(1.0, 5.0);
        self
    }
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
    let docs = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
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

/// Locates ae_cli.py. Checks (in order): AE_CLI_PATH env override, the repo's
/// python/ dir at compile time (dev builds only), then a python/ folder next
/// to the running executable (release layout). Override via AE_CLI_PATH if
/// you keep the python/ folder somewhere else.
fn resolve_script_path() -> PathBuf {
    if let Ok(p) = std::env::var("AE_CLI_PATH") {
        return PathBuf::from(p);
    }

    #[cfg(debug_assertions)]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../python/ae_cli.py");
        if dev_path.exists() {
            return dev_path;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("python/ae_cli.py");
            if p.exists() {
                return p;
            }
        }
    }

    PathBuf::from("python/ae_cli.py")
}

fn python_bin() -> String {
    std::env::var("AE_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string())
}

/// Runs ae_cli.py <input> and parses its JSON stdout into a Listing.
async fn fetch_one(input: &str) -> Result<Listing, String> {
    let script = resolve_script_path();
    let output = TokioCommand::new(python_bin())
        .arg(&script)
        .arg(input)
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

    parse_product_json(&json, input)
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
    })
}

/// Searches a single URL/product ID.
#[tauri::command]
async fn search_one(state: State<'_, AppState>, input: String) -> Result<Listing, String> {
    let listing = fetch_one(input.trim()).await?;
    state.listings.lock().unwrap().push(listing.clone());
    persist_listings(&state);
    Ok(listing)
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

    let mut handles = Vec::with_capacity(lines.len());
    for line in lines {
        let sem = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore closed");
            let result = fetch_one(&line).await;
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
            download_images,
            get_settings,
            set_settings,
            get_auth_status,
            set_redirect_uri,
            open_auth_page,
            exchange_auth_code,
            set_ae_credentials,
            has_ae_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
