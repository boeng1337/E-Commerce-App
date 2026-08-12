use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Listing {
    pub id: String,
    pub title: String,
    pub price: f64,
    pub stock: i64,
    pub source: String, // "aliexpress" | "manual"
}

pub struct AppState {
    pub listings: Mutex<Vec<Listing>>,
}

#[tauri::command]
fn get_listings(state: State<AppState>) -> Vec<Listing> {
    state.listings.lock().unwrap().clone()
}

#[tauri::command]
fn add_manual_listing(
    state: State<AppState>,
    title: String,
    price: f64,
    stock: i64,
) -> Listing {
    let listing = Listing {
        id: Uuid::new_v4().to_string(),
        title,
        price,
        stock,
        source: "manual".to_string(),
    };
    state.listings.lock().unwrap().push(listing.clone());
    listing
}

// TODO: wire this to the real AliExpress Open Platform API.
// Read your app key / secret / access token from env vars or a config file
// you load at startup (do NOT hardcode credentials here).
// AliExpress's API requires request signing (HMAC-SHA256 over sorted params) -
// see https://openservice.aliexpress.com/doc/doc.htm for the exact signing spec.
#[tauri::command]
async fn sync_aliexpress(state: State<'_, AppState>) -> Result<usize, String> {
    // Placeholder: replace with a real reqwest call to the AliExpress API,
    // parse the response into Listing structs, and merge/update the store.
    let fetched: Vec<Listing> = vec![];

    let mut listings = state.listings.lock().unwrap();
    listings.retain(|l| l.source != "aliexpress");
    let count = fetched.len();
    listings.extend(fetched);

    Ok(count)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            listings: Mutex::new(vec![]),
        })
        .invoke_handler(tauri::generate_handler![
            get_listings,
            add_manual_listing,
            sync_aliexpress
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
