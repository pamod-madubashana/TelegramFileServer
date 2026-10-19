//! Mongo-backed virtual file system for the webUI explorer.
//!
//! The browser SPA addresses the saved-messages tree with virtual paths
//! (`tg://saved/...` for folders, `tg://msg/{id}` for files). Phase 3 maps
//! those invokes onto these HTTP endpoints, which speak Mongo paths
//! (`/Home/...`) and message ids:
//!
//! - folders live in `v2_folders` (one doc per directory),
//! - files are `v2_files` rows (shared with `/dl`, uploads, admin),
//! - the recycle bin is a path move into `/Home/Recycle Bin` with
//!   `original_path` recorded for restore,
//! - copy duplicates the `FileDoc` so two rows share one Telegram message,
//! - gallery is a `media_type` query, not a stored folder.

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
};
use futures::TryStreamExt;
use mongodb::bson::doc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    ApiError, ApiResult, AppState, DbError, data_database_name,
    files::{self, FileDoc},
    find_user, require_session,
};

/// Path prefix every VFS endpoint serves (`virtualToSavedPath("tg://saved")`).
const SAVED_ROOT: &str = "/Home";
/// Soft-delete landing zone; also protected from rename/delete.
const RECYCLE_BIN: &str = "/Home/Recycle Bin";
/// Folder paths the explorer refuses to rename, move, or delete.
const PROTECTED_FOLDERS: &[&str] = &[
    "/Home/Recycle Bin",
    "/Home/Notes",
    "/Home/Images",
    "/Home/Videos",
    "/Home/Audio",
    "/Home/Audios",
    "/Home/Documents",
];
/// Page size when the client omits `limit` on `GET /api/fs/items`.
const DEFAULT_PAGE_LIMIT: u32 = 50;
/// Hard ceiling for paging and the gallery query.
const MAX_LIST_LIMIT: u32 = 10_000;

// ===== Documents =====

/// One directory. `_id` is `owner:path` so a name collision inside one
/// folder is a duplicate-key error rather than two rows fighting over the
/// same listing slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FolderDoc {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) owner_id: String,
    /// Full path, e.g. `/Home/Images`.
    pub(crate) path: String,
    pub(crate) parent_path: String,
    pub(crate) name: String,
    /// Stored as an RFC 3339 string (same convention as `FileDoc`, whose
    /// chrono field serializes through serde to BSON text).
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    /// Set while the folder sits in the recycle bin so restore returns it
    /// to exactly where it came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) original_path: Option<String>,
}

impl FolderDoc {
    const COLLECTION_NAME: &'static str = "v2_folders";

    fn id_for(owner_id: &str, path: &str) -> String {
        format!("{owner_id}:{path}")
    }
}

fn folders_collection(client: &mongodb::Client) -> mongodb::Collection<FolderDoc> {
    client
        .database(&data_database_name())
        .collection(FolderDoc::COLLECTION_NAME)
}

fn files_collection(client: &mongodb::Client) -> mongodb::Collection<FileDoc> {
    files::get_files_collection(client)
}

// ===== Response DTOs (field names match webui/src/pages/explorer/shared.ts) =====

#[derive(Debug, Serialize)]
pub(crate) struct SavedItem {
    pub(crate) chat_id: i64,
    pub(crate) message_id: i32,
    /// Always `None` here: Telegram thumbnail bytes are not downloadable
    /// without a message-context client method (Phase 3 maps
    /// `tg_get_message_thumbnail` to null).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thumbnail: Option<String>,
    /// `folder` for directories, `FileDoc.media_type` for files
    /// (`photo`, `video`, `audio`, `document`, …).
    pub(crate) file_type: String,
    pub(crate) file_unique_id: String,
    pub(crate) file_size: i64,
    pub(crate) file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) file_caption: Option<String>,
    /// Parent folder path (the frontend joins name onto it for folders).
    pub(crate) file_path: String,
    pub(crate) modified_date: String,
    pub(crate) owner_id: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SavedItemsPage {
    pub(crate) items: Vec<SavedItem>,
    pub(crate) has_more: bool,
    pub(crate) next_offset: i64,
}

/// `tg_get_indexed_saved_messages` result rows (gallery view).
#[derive(Debug, Serialize)]
pub(crate) struct GalleryMessage {
    pub(crate) message_id: i32,
    pub(crate) chat_id: i64,
    pub(crate) category: String,
    pub(crate) filename: String,
    pub(crate) extension: Option<String>,
    pub(crate) mime_type: String,
    pub(crate) timestamp: String,
    pub(crate) size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    pub(crate) file_reference: String,
}

// ===== Request DTOs =====

/// How the frontend names an item: folders (and stray files) by Mongo path,
/// files by the `tg://msg/{id}` message id (Phase 3 splits the two shapes).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum ItemRef {
    ByPath { path: String },
    ByMessage { message_id: i32 },
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListQuery {
    pub(crate) path: String,
    pub(crate) offset: Option<u32>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreateFolderBody {
    pub(crate) parent_path: String,
    pub(crate) name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MoveBody {
    pub(crate) source: ItemRef,
    pub(crate) destination_path: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RenameBody {
    pub(crate) source: ItemRef,
    pub(crate) new_name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SourceBody {
    pub(crate) source: ItemRef,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeleteBody {
    pub(crate) items: Vec<ItemRef>,
    #[serde(default)]
    pub(crate) permanent: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GalleryQuery {
    pub(crate) category: String,
}

// ===== Path helpers =====

/// Normalize a client path: both separators, no trailing slash, no `..`,
/// must live under `/Home`.
fn normalize_saved_path(raw: &str) -> Result<String, ApiError> {
    let unified = raw.replace('\\', "/");
    if unified.contains('\0') {
        return Err(ApiError::InvalidInput(
            "path may not contain a NUL byte".into(),
        ));
    }
    let mut parts: Vec<&str> = Vec::new();
    for segment in unified.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                return Err(ApiError::InvalidInput(
                    "path may not contain '..' segments".into(),
                ));
            }
            other => parts.push(other),
        }
    }
    if parts.first() != Some(&"Home") {
        return Err(ApiError::InvalidInput(format!(
            "path must live under {SAVED_ROOT}"
        )));
    }
    let joined = parts.join("/");
    Ok(format!("/{joined}"))
}

fn parent_of(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(idx) => path[..idx].to_string(),
    }
}

fn is_protected(path: &str) -> bool {
    PROTECTED_FOLDERS.contains(&path)
}

fn is_in_recycle_bin(path: &str) -> bool {
    path == RECYCLE_BIN || path.starts_with(&format!("{RECYCLE_BIN}/"))
}

/// Escape a path for use inside a `$regex` pattern.
fn regex_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

// ===== Resolved items =====

enum Resolved {
    File(FileDoc),
    Folder(FolderDoc),
}

impl Resolved {
    fn parent(&self) -> &str {
        match self {
            Resolved::File(doc) => &doc.file_path,
            Resolved::Folder(doc) => &doc.path,
        }
    }

    fn name(&self) -> &str {
        match self {
            Resolved::File(doc) => &doc.file_name,
            Resolved::Folder(doc) => &doc.name,
        }
    }

    fn full_path(&self) -> String {
        match self {
            Resolved::File(doc) => format!("{}/{}", doc.file_path, doc.file_name),
            Resolved::Folder(doc) => doc.path.clone(),
        }
    }

    fn into_saved_item(self, owner_id: &str) -> SavedItem {
        match self {
            Resolved::File(doc) => SavedItem {
                chat_id: doc.chat_id,
                message_id: doc.message_id,
                // Offer the cheap Telegram preview straight away: the webui
                // paints it immediately and upgrades to the larger tier once
                // that has been fetched and cached. Only offered when
                // indexing actually saw a thumbnail, so a row without one
                // never costs a round trip to Telegram to learn it is absent.
                thumbnail: if doc.thumbnail_id.is_some() && doc.message_id > 0 {
                    Some(format!(
                        "/api/fs/thumbnail?message_id={}&quality=low",
                        doc.message_id
                    ))
                } else {
                    None
                },
                file_type: doc.media_type.clone(),
                file_unique_id: doc.file_unique_id.clone(),
                file_size: doc.file_size,
                file_name: doc.file_name.clone(),
                file_caption: doc.caption.clone(),
                file_path: doc.file_path.clone(),
                modified_date: doc.created_at.to_rfc3339(),
                owner_id: doc.owner_id.clone(),
            },
            Resolved::Folder(doc) => SavedItem {
                chat_id: 0,
                message_id: 0,
                thumbnail: None,
                file_type: "folder".to_string(),
                file_unique_id: String::new(),
                file_size: 0,
                file_name: doc.name.clone(),
                file_caption: None,
                file_path: doc.parent_path.clone(),
                modified_date: doc.created_at.to_rfc3339(),
                owner_id: owner_id.to_string(),
            },
        }
    }
}

async fn resolve_item(
    client: &mongodb::Client,
    owner_id: &str,
    reference: &ItemRef,
) -> Result<Option<Resolved>, ApiError> {
    match reference {
        ItemRef::ByMessage { message_id } => Ok(files_collection(client)
            .find_one(doc! { "owner_id": owner_id, "message_id": message_id })
            .await
            .map_err(mongo_err)?
            .map(Resolved::File)),
        ItemRef::ByPath { path } => {
            let normalized = normalize_saved_path(path)?;
            if let Some(folder) = folders_collection(client)
                .find_one(doc! { "_id": FolderDoc::id_for(owner_id, &normalized) })
                .await
                .map_err(mongo_err)?
            {
                return Ok(Some(Resolved::Folder(folder)));
            }
            if let Some(doc) = files_collection(client)
                .find_one(doc! {
                    "owner_id": owner_id,
                    "file_path": parent_of(&normalized),
                    "file_name": files::basename(&normalized),
                })
                .await
                .map_err(mongo_err)?
            {
                return Ok(Some(Resolved::File(doc)));
            }
            Ok(None)
        }
    }
}

/// True when any folder or file already occupies `path`.
async fn path_taken(
    client: &mongodb::Client,
    owner_id: &str,
    path: &str,
) -> Result<bool, ApiError> {
    if folders_collection(client)
        .find_one(doc! { "_id": FolderDoc::id_for(owner_id, path) })
        .await
        .map_err(mongo_err)?
        .is_some()
    {
        return Ok(true);
    }
    Ok(files_collection(client)
        .find_one(doc! {
            "owner_id": owner_id,
            "file_path": parent_of(path),
            "file_name": files::basename(path),
        })
        .await
        .map_err(mongo_err)?
        .is_some())
}

/// Insert the folder at `path` plus any missing ancestors
/// (`/Home/A/B` creates `/Home/A` then `/Home/A/B`).
pub(crate) async fn insert_folder_with_ancestors(
    client: &mongodb::Client,
    owner_id: &str,
    path: &str,
) -> Result<(), ApiError> {
    if path == SAVED_ROOT {
        return Ok(());
    }
    let mut prefix = String::from(SAVED_ROOT);
    let relative = path.trim_start_matches(SAVED_ROOT).trim_start_matches('/');
    for segment in relative.split('/').filter(|s| !s.is_empty()) {
        prefix.push('/');
        prefix.push_str(segment);
        folders_collection(client)
            .update_one(
                doc! { "_id": FolderDoc::id_for(owner_id, &prefix) },
                doc! {
                    "$setOnInsert": {
                        "owner_id": owner_id,
                        "path": prefix.clone(),
                        "parent_path": parent_of(&prefix),
                        "name": segment,
                        "created_at": chrono::Utc::now().to_rfc3339(),
                    }
                },
            )
            .upsert(true)
            .await
            .map_err(mongo_err)?;
    }
    Ok(())
}

/// Destinations `folder_for_media` writes indexed items into. Indexing
/// upserts `FileDoc`s straight into these paths without ever creating their
/// `FolderDoc` rows, so unless they are seeded the explorer never lists
/// `/Home/Images` & co. and every indexed item stays unreachable.
const MEDIA_FOLDERS: &[&str] = &[
    "/Home/Images",
    "/Home/Videos",
    "/Home/Audio",
    "/Home/Documents",
];

/// Seed the default media folders for `owner_id`. Idempotent: the rows are
/// written with `$setOnInsert`, so folders a user already made are untouched.
pub(crate) async fn ensure_media_folders(
    client: &mongodb::Client,
    owner_id: &str,
) -> Result<(), ApiError> {
    for path in MEDIA_FOLDERS {
        insert_folder_with_ancestors(client, owner_id, path).await?;
    }
    Ok(())
}

/// Rewrite `old_prefix` → `new_prefix` across every descendant folder and file.
async fn rewrite_prefix(
    client: &mongodb::Client,
    owner_id: &str,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<(), ApiError> {
    if old_prefix == new_prefix {
        return Ok(());
    }
    let pattern = format!("^{}(/|$)", regex_escape(old_prefix));
    let folder_docs: Vec<FolderDoc> = {
        let cursor = folders_collection(client)
            .find(doc! { "owner_id": owner_id, "path": { "$regex": &pattern } })
            .await
            .map_err(mongo_err)?;
        cursor.try_collect().await.map_err(mongo_err)?
    };
    for doc in folder_docs {
        let Some(suffix) = doc.path.strip_prefix(old_prefix) else {
            continue;
        };
        let path = format!("{new_prefix}{suffix}");
        let mut new_doc = doc;
        new_doc.id = FolderDoc::id_for(owner_id, &path);
        new_doc.parent_path = parent_of(&path);
        new_doc.name = files::basename(&path).to_string();
        new_doc.path = path;
        folders_collection(client)
            .delete_one(doc! { "_id": &new_doc.id })
            .await
            .map_err(mongo_err)?;
        folders_collection(client)
            .insert_one(new_doc)
            .await
            .map_err(mongo_err)?;
    }

    let file_docs: Vec<FileDoc> = {
        let cursor = files_collection(client)
            .find(doc! { "owner_id": owner_id, "file_path": { "$regex": &pattern } })
            .await
            .map_err(mongo_err)?;
        cursor.try_collect().await.map_err(mongo_err)?
    };
    for doc in file_docs {
        let Some(suffix) = doc.file_path.strip_prefix(old_prefix) else {
            continue;
        };
        let file_path = format!("{new_prefix}{suffix}");
        let mut new_doc = doc;
        new_doc.id = FileDoc::id_for(owner_id, &file_path, &new_doc.file_name.clone());
        new_doc.file_path = file_path;
        files_collection(client)
            .delete_one(doc! { "_id": &new_doc.id })
            .await
            .map_err(mongo_err)?;
        files_collection(client)
            .insert_one(new_doc)
            .await
            .map_err(mongo_err)?;
    }
    Ok(())
}

// ===== Session + permissions =====

async fn require_user(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    need_write: bool,
) -> Result<String, ApiError> {
    let username = require_session(headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if need_write && !user.permissions.write {
        return Err(ApiError::Forbidden(
            "this account cannot change files".to_string(),
        ));
    }
    if !need_write && !user.permissions.read {
        return Err(ApiError::Forbidden(
            "this account cannot browse files".to_string(),
        ));
    }
    Ok(user.id)
}

fn mongo_err(e: mongodb::error::Error) -> ApiError {
    ApiError::Database(DbError::from(e))
}

// ===== Handlers =====

/// GET /api/fs/items?path=/Home&offset=&limit= — folders then files, sorted.
///
/// `tg_list_saved_items_page` maps here directly; `tg_list_saved_items`
/// (the un-paged shape) maps here without offset/limit.
pub(crate) async fn list_items(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<SavedItemsPage>> {
    let owner = require_user(&state, &headers, false).await?;
    let path = normalize_saved_path(&query.path)?;
    let offset = query.offset.unwrap_or(0) as usize;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_LIST_LIMIT) as usize;
    let client = state.mongo_client().await?;

    // Folders first (alphabetical), then files (alphabetical), one merged
    // page across both collections.
    let mut folder_docs: Vec<FolderDoc> = {
        let cursor = folders_collection(&client)
            .find(doc! { "owner_id": &owner, "parent_path": &path })
            .sort(doc! { "name": 1 })
            .await
            .map_err(mongo_err)?;
        cursor.try_collect().await.map_err(mongo_err)?
    };
    let folder_total = folder_docs.len();
    let visible_folders = if offset < folder_total {
        folder_docs.drain(offset..).collect::<Vec<_>>()
    } else {
        folder_docs.clear();
        Vec::new()
    };
    let folders_taken = visible_folders.len().min(limit);
    let visible_folders: Vec<FolderDoc> = visible_folders.into_iter().take(folders_taken).collect();

    // Peek one extra file to learn has_more without a count query.
    let file_offset = offset.saturating_sub(folder_total) as u64;
    let file_need = (limit - folders_taken) as i64 + 1;
    let mut file_docs: Vec<FileDoc> = {
        let cursor = files_collection(&client)
            .find(doc! { "owner_id": &owner, "file_path": &path })
            .sort(doc! { "file_name": 1 })
            .skip(file_offset)
            .limit(file_need)
            .await
            .map_err(mongo_err)?;
        cursor.try_collect().await.map_err(mongo_err)?
    };
    let has_more = (file_docs.len() as i64) >= file_need;
    if has_more {
        file_docs.pop();
    }

    let mut items: Vec<SavedItem> = visible_folders
        .into_iter()
        .map(|doc| Resolved::Folder(doc).into_saved_item(&owner))
        .collect();
    items.extend(
        file_docs
            .into_iter()
            .map(|doc| Resolved::File(doc).into_saved_item(&owner)),
    );

    let returned = items.len();
    Ok(Json(SavedItemsPage {
        items,
        has_more,
        next_offset: (offset + returned) as i64,
    }))
}

/// GET /api/fs/items/by-message/:message_id — `tg_get_saved_item_by_message_id`.
pub(crate) async fn item_by_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(message_id): AxumPath<i32>,
) -> ApiResult<Json<Option<SavedItem>>> {
    let owner = require_user(&state, &headers, false).await?;
    let client = state.mongo_client().await?;
    let item = resolve_item(&client, &owner, &ItemRef::ByMessage { message_id })
        .await?
        .map(|resolved| resolved.into_saved_item(&owner));
    Ok(Json(item))
}

/// POST /api/fs/folders — `tg_create_saved_folder` / `fs_create_dir`.
pub(crate) async fn create_folder(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateFolderBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let parent = normalize_saved_path(&body.parent_path)?;
    let name = files::sanitize_file_name(&body.name)?;
    let path = format!("{parent}/{name}");
    if is_protected(&path) {
        return Err(ApiError::Conflict(format!("{path} is a reserved folder")));
    }
    let client = state.mongo_client().await?;
    if path_taken(&client, &owner, &path).await? {
        return Err(ApiError::Conflict(format!(
            "an item named {name} already exists here"
        )));
    }
    insert_folder_with_ancestors(&client, &owner, &path).await?;
    state.publish_event("fs-updated", serde_json::json!({ "path": parent }));
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/fs/move — folders and files; `tg_move_saved_item`, `move_file`.
pub(crate) async fn move_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MoveBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let destination = normalize_saved_path(&body.destination_path)?;
    let client = state.mongo_client().await?;
    let Some(item) = resolve_item(&client, &owner, &body.source).await? else {
        return Err(ApiError::NotFound("item not found".into()));
    };
    let source_path = item.full_path();
    if is_protected(&source_path) {
        return Err(ApiError::Conflict(format!(
            "{source_path} is a reserved folder"
        )));
    }
    if is_in_recycle_bin(&source_path) {
        return Err(ApiError::Conflict(
            "restore items from the Recycle Bin instead of moving them".into(),
        ));
    }
    let name = files::sanitize_file_name(item.name())?;
    let new_path = format!("{destination}/{name}");
    if new_path == source_path {
        return Ok(StatusCode::NO_CONTENT);
    }
    if destination == source_path || destination.starts_with(&format!("{source_path}/")) {
        return Err(ApiError::InvalidInput(
            "cannot move a folder into itself".into(),
        ));
    }
    if path_taken(&client, &owner, &new_path).await? {
        return Err(ApiError::Conflict(format!(
            "an item named {name} already exists at the destination"
        )));
    }
    insert_folder_with_ancestors(&client, &owner, &destination).await?;

    match item {
        Resolved::File(mut doc) => {
            files_collection(&client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.id = FileDoc::id_for(&owner, &destination, &doc.file_name);
            doc.file_path = destination.clone();
            files_collection(&client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
        }
        Resolved::Folder(mut doc) => {
            folders_collection(&client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.id = FolderDoc::id_for(&owner, &new_path);
            doc.parent_path = destination.clone();
            doc.path = new_path.clone();
            folders_collection(&client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
            rewrite_prefix(&client, &owner, &source_path, &new_path).await?;
        }
    }
    state.publish_event("fs-updated", serde_json::json!({ "path": destination }));
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/fs/copy — files only; the copy shares the Telegram message.
pub(crate) async fn copy_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MoveBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let destination = normalize_saved_path(&body.destination_path)?;
    let client = state.mongo_client().await?;
    let Some(item) = resolve_item(&client, &owner, &body.source).await? else {
        return Err(ApiError::NotFound("item not found".into()));
    };
    let Resolved::File(doc) = item else {
        return Err(ApiError::InvalidInput("only files can be copied".into()));
    };
    let new_path = format!("{destination}/{}", doc.file_name);
    if path_taken(&client, &owner, &new_path).await? {
        return Err(ApiError::Conflict(format!(
            "an item named {} already exists at the destination",
            doc.file_name
        )));
    }
    insert_folder_with_ancestors(&client, &owner, &destination).await?;
    let mut copy = doc;
    copy.id = FileDoc::id_for(&owner, &destination, &copy.file_name.clone());
    copy.file_path = destination.clone();
    // chat_id/message_id/file_id stay shared: one Telegram message, two rows.
    files_collection(&client)
        .insert_one(copy)
        .await
        .map_err(mongo_err)?;
    state.publish_event("fs-updated", serde_json::json!({ "path": destination }));
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/fs/rename — same parent, new name; folders rewrite descendants.
pub(crate) async fn rename_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RenameBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let new_name = files::sanitize_file_name(&body.new_name)?;
    let client = state.mongo_client().await?;
    let Some(item) = resolve_item(&client, &owner, &body.source).await? else {
        return Err(ApiError::NotFound("item not found".into()));
    };
    let source_path = item.full_path();
    if is_protected(&source_path) {
        return Err(ApiError::Conflict(format!(
            "{source_path} is a reserved folder"
        )));
    }
    if is_in_recycle_bin(&source_path) {
        return Err(ApiError::Conflict(
            "cannot rename items inside the Recycle Bin".into(),
        ));
    }
    let parent = item.parent().to_string();
    let new_path = format!("{parent}/{new_name}");
    if new_path == source_path {
        return Ok(StatusCode::NO_CONTENT);
    }
    if path_taken(&client, &owner, &new_path).await? {
        return Err(ApiError::Conflict(format!(
            "an item named {new_name} already exists here"
        )));
    }

    match item {
        Resolved::File(mut doc) => {
            files_collection(&client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.id = FileDoc::id_for(&owner, &parent, &new_name);
            doc.file_name = new_name;
            files_collection(&client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
        }
        Resolved::Folder(mut doc) => {
            folders_collection(&client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.id = FolderDoc::id_for(&owner, &new_path);
            doc.name = new_name;
            doc.path = new_path.clone();
            folders_collection(&client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
            rewrite_prefix(&client, &owner, &source_path, &new_path).await?;
        }
    }
    state.publish_event("fs-updated", serde_json::json!({ "path": parent }));
    Ok(StatusCode::NO_CONTENT)
}

/// Move one already-resolved, non-protected item into the recycle bin,
/// de-duplicating its name and recording `original_path`.
async fn recycle_resolved(
    client: &mongodb::Client,
    owner: &str,
    item: Resolved,
) -> Result<(), ApiError> {
    let source_path = item.full_path();
    if is_in_recycle_bin(&source_path) {
        return Ok(());
    }
    let name = files::sanitize_file_name(item.name())?;
    let unique = unique_in_bin(client, owner, &name).await?;
    let new_path = format!("{RECYCLE_BIN}/{unique}");
    insert_folder_with_ancestors(client, owner, RECYCLE_BIN).await?;

    match item {
        Resolved::File(mut doc) => {
            files_collection(client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.original_path = Some(source_path);
            doc.id = FileDoc::id_for(owner, RECYCLE_BIN, &unique);
            doc.file_name = unique;
            doc.file_path = RECYCLE_BIN.to_string();
            files_collection(client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
        }
        Resolved::Folder(mut doc) => {
            folders_collection(client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.original_path = Some(source_path.clone());
            doc.id = FolderDoc::id_for(owner, &new_path);
            doc.name = unique;
            doc.path = new_path.clone();
            doc.parent_path = RECYCLE_BIN.to_string();
            folders_collection(client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
            rewrite_prefix(client, owner, &source_path, &new_path).await?;
        }
    }
    Ok(())
}

/// First free name in the recycle bin: `name`, `name (2)`, `name (3)`, …
async fn unique_in_bin(
    client: &mongodb::Client,
    owner: &str,
    name: &str,
) -> Result<String, ApiError> {
    if !path_taken(client, owner, &format!("{RECYCLE_BIN}/{name}")).await? {
        return Ok(name.to_string());
    }
    for n in 2u32..10_000 {
        let candidate = format!("{name} ({n})");
        if !path_taken(client, owner, &format!("{RECYCLE_BIN}/{candidate}")).await? {
            return Ok(candidate);
        }
    }
    Err(ApiError::Conflict(
        "could not find a free name in the Recycle Bin".into(),
    ))
}

/// POST /api/fs/recycle — soft delete: move into `/Home/Recycle Bin`.
pub(crate) async fn recycle_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SourceBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let client = state.mongo_client().await?;
    let Some(item) = resolve_item(&client, &owner, &body.source).await? else {
        return Err(ApiError::NotFound("item not found".into()));
    };
    if is_protected(&item.full_path()) {
        return Err(ApiError::Conflict(format!(
            "{} is a reserved folder",
            item.full_path()
        )));
    }
    recycle_resolved(&client, &owner, item).await?;
    state.publish_event("fs-updated", serde_json::json!({ "path": RECYCLE_BIN }));
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/fs/restore — return an item from the recycle bin to its
/// original spot (or `/Home` when the original is gone).
pub(crate) async fn restore_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SourceBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let client = state.mongo_client().await?;
    let Some(item) = resolve_item(&client, &owner, &body.source).await? else {
        return Err(ApiError::NotFound("item not found".into()));
    };
    let source_path = item.full_path();
    if !is_in_recycle_bin(&source_path) {
        return Err(ApiError::InvalidInput(
            "item is not in the Recycle Bin".into(),
        ));
    }
    let original: Option<String> = match &item {
        Resolved::File(doc) => doc.original_path.clone(),
        Resolved::Folder(doc) => doc.original_path.clone(),
    };

    // Prefer the recorded original spot; fall back to the recycle-bin
    // parent's parent (i.e. /Home) or the item's current name.
    let (target_parent, name) = match original {
        Some(original_path) => {
            let parent = parent_of(&original_path);
            let name = files::basename(&original_path).to_string();
            if path_taken(&client, &owner, &format!("{parent}/{name}")).await? {
                let fallback = files::sanitize_file_name(item.name())?;
                (parent, fallback)
            } else {
                (parent, name)
            }
        }
        None => (
            SAVED_ROOT.to_string(),
            files::sanitize_file_name(item.name())?,
        ),
    };
    let new_path = format!("{target_parent}/{name}");
    if path_taken(&client, &owner, &new_path).await? {
        return Err(ApiError::Conflict(format!(
            "an item named {name} already exists at the restore target"
        )));
    }
    insert_folder_with_ancestors(&client, &owner, &target_parent).await?;

    match item {
        Resolved::File(mut doc) => {
            files_collection(&client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.original_path = None;
            doc.id = FileDoc::id_for(&owner, &target_parent, &name);
            doc.file_name = name;
            doc.file_path = target_parent.clone();
            files_collection(&client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
        }
        Resolved::Folder(mut doc) => {
            folders_collection(&client)
                .delete_one(doc! { "_id": &doc.id })
                .await
                .map_err(mongo_err)?;
            doc.original_path = None;
            doc.id = FolderDoc::id_for(&owner, &new_path);
            doc.name = name;
            doc.path = new_path.clone();
            doc.parent_path = target_parent.clone();
            folders_collection(&client)
                .insert_one(doc)
                .await
                .map_err(mongo_err)?;
            rewrite_prefix(&client, &owner, &source_path, &new_path).await?;
        }
    }
    state.publish_event("fs-updated", serde_json::json!({ "path": target_parent }));
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/fs/delete — `permanent: false` recycles, `true` drops rows.
///
/// Permanent delete removes Mongo records only. Telegram-side message
/// deletion needs a `delete_messages` client method that does not exist yet;
/// the orphaned messages stay invisible to the VFS.
pub(crate) async fn delete_items(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DeleteBody>,
) -> ApiResult<StatusCode> {
    let owner = require_user(&state, &headers, true).await?;
    let client = state.mongo_client().await?;
    for reference in &body.items {
        let Some(item) = resolve_item(&client, &owner, reference).await? else {
            continue;
        };
        if is_protected(&item.full_path()) {
            return Err(ApiError::Conflict(format!(
                "{} is a reserved folder",
                item.full_path()
            )));
        }
        if !body.permanent {
            recycle_resolved(&client, &owner, item).await?;
            continue;
        }
        match item {
            Resolved::File(doc) => {
                files_collection(&client)
                    .delete_one(doc! { "_id": &doc.id })
                    .await
                    .map_err(mongo_err)?;
            }
            Resolved::Folder(doc) => {
                let pattern = format!("^{}(/|$)", regex_escape(&doc.path));
                folders_collection(&client)
                    .delete_many(doc! { "owner_id": &owner, "path": { "$regex": &pattern } })
                    .await
                    .map_err(mongo_err)?;
                files_collection(&client)
                    .delete_many(doc! { "owner_id": &owner, "file_path": { "$regex": &pattern } })
                    .await
                    .map_err(mongo_err)?;
            }
        }
    }
    state.publish_event("fs-updated", serde_json::json!({ "path": SAVED_ROOT }));
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/fs/gallery?category=images|videos — media query, newest first.
pub(crate) async fn gallery(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<GalleryQuery>,
) -> ApiResult<Json<Vec<GalleryMessage>>> {
    let owner = require_user(&state, &headers, false).await?;
    let filter = match query.category.as_str() {
        "images" => doc! { "owner_id": &owner, "$or": [
            { "media_type": "photo" },
            { "media_type": "image" },
            { "mime_type": { "$regex": "^image/" } },
        ]},
        "videos" => doc! { "owner_id": &owner, "$or": [
            { "media_type": "video" },
            { "mime_type": { "$regex": "^video/" } },
        ]},
        other => {
            return Err(ApiError::InvalidInput(format!(
                "unknown gallery category: {other}"
            )));
        }
    };
    let client = state.mongo_client().await?;
    let docs: Vec<FileDoc> = {
        let cursor = files_collection(&client)
            .find(filter)
            .sort(doc! { "created_at": -1 })
            .limit(MAX_LIST_LIMIT as i64)
            .await
            .map_err(mongo_err)?;
        cursor.try_collect().await.map_err(mongo_err)?
    };
    let messages = docs
        .into_iter()
        .map(|doc| {
            let extension = std::path::Path::new(&doc.file_name)
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_string);
            GalleryMessage {
                message_id: doc.message_id,
                chat_id: doc.chat_id,
                category: query.category.clone(),
                filename: doc.file_name.clone(),
                extension,
                mime_type: doc.mime_type.clone(),
                timestamp: doc.created_at.to_rfc3339(),
                size: doc.file_size,
                text: doc.caption.clone(),
                file_reference: doc.file_unique_id.clone(),
            }
        })
        .collect();
    Ok(Json(messages))
}

// ===== Tests =====

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_accepts_home_and_children() {
        assert_eq!(normalize_saved_path("/Home").unwrap(), "/Home");
        assert_eq!(normalize_saved_path("/Home/").unwrap(), "/Home");
        assert_eq!(normalize_saved_path("Home/Images").unwrap(), "/Home/Images");
        assert_eq!(
            normalize_saved_path("/Home\\Images").unwrap(),
            "/Home/Images"
        );
        assert_eq!(
            normalize_saved_path("/Home//Images/").unwrap(),
            "/Home/Images"
        );
    }

    #[test]
    fn normalize_rejects_escapes_and_foreign_roots() {
        assert!(normalize_saved_path("/etc/passwd").is_err());
        assert!(normalize_saved_path("/Home/../etc").is_err());
        assert!(normalize_saved_path("/").is_err());
        assert!(normalize_saved_path("").is_err());
    }

    #[test]
    fn parent_and_basename_match_explorer_semantics() {
        assert_eq!(parent_of("/Home"), "/");
        assert_eq!(parent_of("/Home/Images"), "/Home");
        assert_eq!(files::basename("/Home/Images"), "Images");
        assert_eq!(files::basename("/Home/a.mp4"), "a.mp4");
    }

    #[test]
    fn protected_and_recycle_checks() {
        assert!(is_protected("/Home/Notes"));
        assert!(!is_protected("/Home/MyNotes"));
        assert!(is_in_recycle_bin(RECYCLE_BIN));
        assert!(is_in_recycle_bin("/Home/Recycle Bin/a.mp4"));
        assert!(!is_in_recycle_bin("/Home/Recycle Binner"));
    }

    #[test]
    fn regex_escape_neutralizes_pattern_metacharacters() {
        assert_eq!(regex_escape("/Home/a.b"), "/Home/a\\.b");
        assert_eq!(regex_escape("/Home/(x)"), "/Home/\\(x\\)");
        assert_eq!(regex_escape("/Home/plain"), "/Home/plain");
    }

    #[test]
    fn item_ref_accepts_both_shapes() {
        let by_path: ItemRef = serde_json::from_str(r#"{"path":"/Home/Images"}"#).unwrap();
        assert!(matches!(by_path, ItemRef::ByPath { .. }));
        let by_message: ItemRef = serde_json::from_str(r#"{"message_id": 42}"#).unwrap();
        assert!(matches!(by_message, ItemRef::ByMessage { message_id: 42 }));
    }

    #[test]
    fn saved_item_serializes_like_the_frontend_contract() {
        let item = SavedItem {
            chat_id: -100123,
            message_id: 7,
            thumbnail: None,
            file_type: "photo".to_string(),
            file_unique_id: "abc".to_string(),
            file_size: 42,
            file_name: "cat.jpg".to_string(),
            file_caption: Some("a cat".to_string()),
            file_path: "/Home/Images".to_string(),
            modified_date: "2026-01-01T00:00:00+00:00".to_string(),
            owner_id: "alice".to_string(),
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["message_id"], 7);
        assert_eq!(json["file_type"], "photo");
        // `thumbnail` is skipped when absent — frontend treats it as optional.
        assert!(json.get("thumbnail").is_none());
        assert_eq!(json["file_caption"], "a cat");
    }
}
