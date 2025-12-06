# src/Web/web.py

from fastapi import FastAPI, Request, Form, Depends, Query, HTTPException, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel
from bson import ObjectId
import sys
import io
import tempfile
import logging
import re
import os
import datetime
import hashlib
import secrets
from typing import Dict, Optional
from typing import List, Dict, Any

# Set up logger to match your application's logging format
from d4rk.Logs import setup_logger
logger = setup_logger("web_server")

from ..security.credentials import require_auth, is_authenticated, require_admin, verify_credentials, verify_google_token, ADMIN_PASSWORD_HASH
from .api_routes import list_media_api, delete_media_api, update_media_api, delete_movie_quality_api, delete_tv_quality_api, delete_tv_episode_api, delete_tv_season_api
from .stream_routes import router as stream_router
# Import the new Telegram verification router
from .telegram_verification import router as telegram_router

from src.Config import APP_NAME, OWNER
from src.Database import database
from dataclasses import asdict


# Global variable for workloads (if used by other modules, otherwise just for get_workloads)
work_loads = {}

# Simple in-memory token store for Tauri/desktop app authentication
# Maps tokens to session data
_auth_tokens: Dict[str, Dict] = {}

app = FastAPI(
    title=f"{APP_NAME} Media Server",
    description=f"A powerful, self-hosted {APP_NAME} Media Server built with FastAPI, MongoDB, and PyroFork seamlessly integrated with Stremio for automated media streaming and discovery.",
)

# Include stream routes
app.include_router(stream_router)
# Include Telegram verification routes
app.include_router(telegram_router)

# --- Middleware Setup ---
# Configure session middleware to work with both browsers and Tauri WebView
# For localhost development, we need to handle cookies properly
app.add_middleware(
    SessionMiddleware, 
    secret_key="f6d2e3b9a0f43d9a2e6a56b2d3175cd9c05bbfe31d95ed2a7306b57cb1a8b6f0",
    same_site="lax",     # Use lax for better compatibility with browsers in development
    https_only=False,     # Allow non-HTTPS for localhost development
    max_age=3600,         # 1 hour session timeout
    path="/",             # Explicitly set cookie path
    domain="localhost"     # Explicitly set domain for localhost development
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Add auth token middleware for Tauri/desktop app support ---
@app.middleware("http")
async def auth_token_middleware(request: Request, call_next):
    """Handle token-based authentication for Tauri/desktop apps"""
    auth_header = request.headers.get("X-Auth-Token")
    if auth_header and auth_header in _auth_tokens:
        token_data = _auth_tokens[auth_header]
        # Add token data to session-like storage for the route handlers
        request.state.auth_token_data = token_data
        request.state.authenticated_via_token = True
        logger.debug(f"Authenticated via auth token for user: {token_data.get('username')}")
    return await call_next(request)

# --- Add logging middleware ---
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all HTTP requests using your application's logger"""
    logger.info(f"{request.method} {request.url}")
    try:
        response = await call_next(request)
        logger.info(f"Response status: {response.status_code}")
        return response
    except Exception as e:
        logger.error(f"Request failed with error: {e}")
        raise

class LoginRequest(BaseModel):
    username: str
    password: str

class GoogleLoginRequest(BaseModel):
    token: str

# --- Authentication Routes ---
@app.post("/api/auth/login")
async def login_post_route(request: Request, login_data: LoginRequest):
    logger.info(f"Login attempt for user: {login_data.username}")
    logger.info(f"Login data received: {login_data}")
    
    # Log the verification process
    is_valid = verify_credentials(login_data.username, login_data.password)
    logger.info(f"Credentials verification result: {is_valid}")
    
    if is_valid:
        request.session["authenticated"] = True
        request.session["username"] = login_data.username
        request.session["auth_method"] = "local"
        logger.info(f"Login successful for user: {login_data.username}")
        # Log session data for debugging
        logger.info(f"Session data after login: {dict(request.session)}")
        
        # Generate a token for Tauri/desktop app usage
        auth_token = secrets.token_urlsafe(32)
        _auth_tokens[auth_token] = {
            "authenticated": True,
            "username": login_data.username,
            "auth_method": "local",
            "created_at": datetime.datetime.now().isoformat()
        }
        
        return {
            "message": "Login successful",
            "username": login_data.username,
            "auth_token": auth_token  # Return token for Tauri/desktop apps
        }
    
    logger.warning(f"Login failed for user: {login_data.username}")
    logger.info(f"Expected username: 'admin', Provided username: '{login_data.username}'")
    logger.info(f"Expected password hash: {ADMIN_PASSWORD_HASH}")
    logger.info(f"Provided password hash: {hashlib.sha256(login_data.password.encode()).hexdigest()}")
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Incorrect username or password",
    )

@app.post("/api/auth/google")
async def google_login_route(request: Request, login_data: GoogleLoginRequest):
    user_info = verify_google_token(login_data.token)
    if user_info:
        request.session["authenticated"] = True
        request.session["user_email"] = user_info["email"]
        request.session["username"] = user_info["name"]
        request.session["user_picture"] = user_info["picture"]
        request.session["auth_method"] = "google"
        return {"message": "Login successful", "user": user_info}
    
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid Google token or unauthorized user",
    )

@app.post("/api/auth/logout")
async def logout_route(request: Request):
    # Clear session
    request.session.clear()
    
    # Clear token if provided in headers
    auth_header = request.headers.get("X-Auth-Token")
    if auth_header and auth_header in _auth_tokens:
        del _auth_tokens[auth_header]
        logger.info(f"Cleared auth token on logout")
    
    return {"message": "Logged out successfully"}

@app.get("/api/auth/check")
async def check_auth(request: Request):
    # Log session data for debugging
    logger.info(f"Auth check request. Session data: {dict(request.session)}")
    
    # Check if there's an auth token in headers (for Tauri/desktop apps)
    auth_header = request.headers.get("X-Auth-Token")
    if auth_header and auth_header in _auth_tokens:
        token_data = _auth_tokens[auth_header]
        logger.info(f"Auth check result using token: authenticated=True, user={token_data.get('username')}")
        return {
            "authenticated": True,
            "username": token_data.get("username"),
            "user_picture": token_data.get("user_picture"),
            "is_admin": token_data.get("username") == "admin" or token_data.get("auth_method") == "local"
        }
    
    authenticated = request.session.get("authenticated", False)
    logger.info(f"Auth check result: authenticated={authenticated}")
    return {
        "authenticated": authenticated,
        "username": request.session.get("username"),
        "user_picture": request.session.get("user_picture"),
        "is_admin": request.session.get("username") == "admin" or request.session.get("auth_method") == "local"
    }

@app.get("/")
async def root():
    return {
        "app": f"{APP_NAME} Media Server",
        "version": "1.0.0",
        "status": "running",
        "docs_url": "/docs"
    }

# Add a health check endpoint
@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.datetime.now().isoformat()}

# Add an OPTIONS endpoint for health check to handle preflight requests
@app.options("/api/health")
async def health_check_options():
    return {"status": "ok"}

# --- API Routes ---
@app.get("/api/files")
async def get_all_files_route(
    path: str = Query(default="/", description="Folder path to fetch files from"),
    user_id: str = Depends(require_auth)
):
    try:
        # Fetch files for the specified path and user
        logger.info(f"Fetching files for path {path} and user_id {user_id}")
        files_data = database.Files.get_files_by_path(path, user_id)
        files_list = []
        for f in files_data:
            f_dict = asdict(f)
            f_dict['id'] = str(f_dict['id']) # Convert ObjectId to string
            f_dict['file_unique_id'] = f.file_unique_id  # Include file_unique_id for streaming
            
            files_list.append(f_dict)
        return {"files": files_list}
    except Exception as e:
        logger.error(f"Error fetching files for path {path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class CreateFolderRequest(BaseModel):
    folderName: str
    currentPath: str

@app.post("/api/folders/create")
async def create_folder_route(request: CreateFolderRequest, user_id: str = Depends(require_auth)):
    try:
        success = database.Files.create_folder(request.folderName, request.currentPath, user_id)
        if success:
            return {"message": f"Folder '{request.folderName}' created successfully"}
        else:
            raise HTTPException(status_code=400, detail="Folder already exists")
    except Exception as e:
        logger.error(f"Error creating folder: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class MoveFileRequest(BaseModel):
    file_id: str
    target_path: str

class CopyFileRequest(BaseModel):
    file_id: str
    target_path: str

@app.post("/api/files/move")
async def move_file_route(request: MoveFileRequest, user_id: str = Depends(require_auth)):
    try:
        # Check if user owns the file
        if not database.Files.check_file_owner(request.file_id, user_id):
            raise HTTPException(status_code=403, detail="Access denied")
            
        # Get the file by ID
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Update the file's path and modified date
        database.Files.update_one(
            {"_id": ObjectId(request.file_id), "owner_id": user_id},
            {"$set": {"file_path": request.target_path, "modified_date": datetime.utcnow().isoformat()}}
        )
        
        return {"message": "File moved successfully"}
    except Exception as e:
        logger.error(f"Error moving file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/copy")
async def copy_file_route(request: CopyFileRequest, user_id: str = Depends(require_auth)):
    try:
        # Check if user owns the file
        if not database.Files.check_file_owner(request.file_id, user_id):
            raise HTTPException(status_code=403, detail="Access denied")
            
        # Get the file by ID
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Create a copy of the file with the new path
        new_file_data = file_data.copy()
        new_file_data["_id"] = ObjectId()  # Generate new ID
        new_file_data["file_path"] = request.target_path
        new_file_data["modified_date"] = datetime.utcnow().isoformat()  # Set new modified date for copied file
        # Preserve the owner when copying
        new_file_data["owner_id"] = user_id
        
        # For copied files, we need to handle the unique ID properly
        # For now, we'll keep the same file_unique_id since it refers to the Telegram file
        # In a real implementation, you might want to duplicate the file in Telegram as well
        
        database.Files.insert_one(new_file_data)
        
        return {"message": "File copied successfully", "new_file_id": str(new_file_data["_id"])}
    except Exception as e:
        logger.error(f"Error copying file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class DeleteFileRequest(BaseModel):
    file_id: str

class RenameFileRequest(BaseModel):
    file_id: str
    new_name: str

@app.post("/api/files/rename")
async def rename_file_route(request: RenameFileRequest, user_id: str = Depends(require_auth)):
    try:
        # Rename the file/folder with owner validation
        success = database.Files.rename_file(request.file_id, request.new_name, user_id)
        
        if success:
            return {"message": "Item renamed successfully"}
        else:
            raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        logger.error(f"Error renaming file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/delete")
async def delete_file_route(request: DeleteFileRequest, user_id: str = Depends(require_auth)):
    try:
        # Check if user owns the file
        if not database.Files.check_file_owner(request.file_id, user_id):
            raise HTTPException(status_code=403, detail="Access denied")
            
        # Get the file by ID to check if it exists
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id), "owner_id": user_id})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Check if this is a folder
        if file_data.get("file_type") == "folder":
            # For folders, we also need to delete all files inside the folder
            folder_path = file_data.get("file_path", "/")
            folder_name = file_data.get("file_name", "")
            
            # Construct the full folder path
            if folder_path == "/":
                full_folder_path = f"/{folder_name}"
            else:
                full_folder_path = f"{folder_path}/{folder_name}"
            
            # Delete all files in the folder (owned by the user)
            database.Files.delete_many({"file_path": full_folder_path, "owner_id": user_id})
            
            # Also delete any subfolders and files inside this folder
            # Delete items that are inside this folder (path starts with full_folder_path + "/")
            database.Files.delete_many({
                "file_path": {"$regex": f"^{re.escape(full_folder_path)}/"},
                "owner_id": user_id
            })
        
        # Delete the file/folder itself
        result = database.Files.delete_one({"_id": ObjectId(request.file_id), "owner_id": user_id})
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="File not found")
        
        return {"message": "Item deleted successfully"}
    except Exception as e:
        logger.error(f"Error deleting file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/system/workloads")
async def get_workloads(_: bool = Depends(require_auth)):
    try:
        return {
            "loads": {
                f"bot{c + 1}": l
                for c, (_, l) in enumerate(
                    sorted(work_loads.items(), key=lambda x: x[1], reverse=True)
                )
            } if work_loads else {}
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- GitHub Webhook for Auto-Update ---
@app.post("/github")
async def github_webhook(request: Request):
    """Handle GitHub webhook for automatic updates on Linux servers"""
    import subprocess
    import os
    import sys
    from d4rk.Logs import setup_logger
    
    logger = setup_logger("github_webhook")
    
    # Get the GitHub event type
    event_type = request.headers.get("X-GitHub-Event")
    
    logger.info(f"Received GitHub event: {event_type}")
    
    # Handle push events
    if event_type == "push":
        # Run git pull to update the code
        try:
            # Get the current directory
            repo_path = os.getcwd()
            
            # Use the system git binary (not the venv one)
            git_cmd = "/usr/bin/git"
            prime = "/usr/local/bin/prime"
            # Verify git is available
            try:
                subprocess.run([git_cmd, "--version"], cwd=repo_path, check=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (subprocess.CalledProcessError, FileNotFoundError):
                logger.error("Git is not installed at /usr/bin/git")
                return {"status": "error", "message": "Git is not installed. Please install git: sudo apt-get install git"}
            
            # Set up git configuration to avoid interactive prompts
            subprocess.run([git_cmd, "config", "--local", "credential.helper", "store"], 
                         cwd=repo_path, capture_output=True)
            subprocess.run([git_cmd, "config", "--local", "credential.modalprompt", "false"], 
                         cwd=repo_path, capture_output=True)
            
            # Use git pull with environment to avoid prompts
            env = os.environ.copy()
            env["GIT_TERMINAL_PROMPT"] = "0"
            env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            
            logger.info("Running git pull")
            result = subprocess.run([git_cmd, "pull"], cwd=repo_path, 
                                 capture_output=True, text=True, env=env)
            
            if result.returncode != 0:
                logger.error(f"Git pull failed: {result.stderr}")
                # Try alternative approach - fetch and reset
                fetch_result = subprocess.run([git_cmd, "fetch"], cwd=repo_path, 
                                           capture_output=True, text=True, env=env)
                if fetch_result.returncode == 0:
                    reset_result = subprocess.run([git_cmd, "reset", "--hard", "origin/main"], 
                                               cwd=repo_path, capture_output=True, text=True)
                    if reset_result.returncode == 0:
                        logger.info("Successfully updated via fetch and reset")
                    else:
                        return {"status": "error", "message": f"Git reset failed: {reset_result.stderr}"}
                else:
                    return {"status": "error", "message": f"Git fetch failed: {fetch_result.stderr}"}
            else:
                logger.info(f"Git pull output: {result.stdout}")
            
            # Update requirements if requirements.txt exists
            requirements_path = os.path.join(repo_path, "requirements.txt")
            try:
                if os.path.exists(requirements_path):
                    logger.info("Running pip install")
                    # Use system pip with full PATH
                    pip_env = os.environ.copy()
                    pip_env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                    pip_result = subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], 
                                            cwd=repo_path, capture_output=True, text=True, env=pip_env)
                    if pip_result.returncode != 0:
                        logger.error(f"Pip install failed: {pip_result.stderr}")
                        # return {"status": "warning", "message": f"Repository updated but pip install failed: {pip_result.stderr}"}
                    logger.info(f"Pip install output: {pip_result.stdout}")
                logger.info("Successfully updated from GitHub webhook")
            except:pass
            result = subprocess.run([prime, "restart"], cwd=repo_path, 
                                 capture_output=True, text=True, env=env)
            if result.returncode != 0:
                logger.error(f"Prime restart failed: {result.stderr}")
            return {"status": "success", "message": "Repository updated successfully"}
            
        except Exception as e:
            logger.error(f"Unexpected error during update: {e}")
            return {"status": "error", "message": f"Update failed: {str(e)}"}
    else:
        logger.info(f"Unhandled GitHub event type: {event_type}")
        return {"status": "ignored", "message": f"Event type {event_type} not handled"}

# --- Error Handlers ---
@app.exception_handler(401)
async def unauthorized_handler(request: Request, exc):
    return JSONResponse(
        status_code=401,
        content={"detail": "Authentication required"}
    )

@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    return JSONResponse(
        status_code=404,
        content={"detail": "Resource not found"}
    )

@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"}
    )

# Add new API route for bot information
@app.get("/api/bots/info")
async def get_bots_info(_: bool = Depends(require_auth)):
    try:
        bot_manager = app.state.bot_manager
        if not bot_manager:
            return {"bots": [], "logger_bot": None, "workloads": {}}
        
        # Get regular bot clients
        bots_info = []
        clients = None
        if hasattr(bot_manager, 'clients'):
            clients = bot_manager.clients
        elif hasattr(bot_manager, 'client_list'):
            clients = bot_manager.client_list
        
        if clients is not None:
            for i, client in enumerate(clients):
                try:
                    bot_me = client.me
                    if bot_me:
                        # Set profile photo URL for this bot
                        profile_photo_url = f"/api/bot/{bot_me.id}/photo?bot_type=bot" if bot_me.id else None
                        
                        # Get workload from the client
                        workload = client.get_workload() if hasattr(client, 'get_workload') else 0
                        # Calculate workload percentage (assuming max 100 tasks for display)
                        workload_percent = min(workload, 100)
                        
                        bots_info.append({
                            "id": bot_me.id,
                            "username": bot_me.username or f"Bot {i+1}",
                            "first_name": bot_me.first_name,
                            "is_bot": bot_me.is_bot,
                            "index": i,
                            "workload": workload,
                            "workload_percent": workload_percent,
                            "profile_photo_url": profile_photo_url
                        })
                    else:
                        # Get workload from the client
                        workload = client.get_workload() if hasattr(client, 'get_workload') else 0
                        # Calculate workload percentage (assuming max 100 tasks for display)
                        workload_percent = min(workload, 100)
                        
                        # Set profile photo URL for this bot (when offline)
                        profile_photo_url = None
                        
                        bots_info.append({
                            "id": None,
                            "username": f"Bot {i+1} (Offline)",
                            "first_name": f"Bot {i+1}",
                            "is_bot": True,
                            "index": i,
                            "workload": workload,
                            "workload_percent": workload_percent,
                            "profile_photo_url": profile_photo_url
                        })
                except Exception as e:
                    # Get workload from the client
                    workload = client.get_workload() if hasattr(client, 'get_workload') else 0
                    # Calculate workload percentage (assuming max 100 tasks for display)
                    workload_percent = min(workload, 100)
                    
                    bots_info.append({
                        "id": None,
                        "username": f"Bot {i+1} (Error)",
                        "first_name": f"Bot {i+1}",
                        "is_bot": True,
                        "index": i,
                        "workload": workload,
                        "workload_percent": workload_percent,
                        "profile_photo_url": None,
                        "error": str(e)
                    })
        
        # Get logger bot client
        logger_bot_info = None
        logger_bot_client = getattr(bot_manager, 'logger_bot_util', None)
        
        return {"bots": bots_info, "logger_bot": logger_bot_info, "workloads": {}}
    except Exception as e:
        return {"bots": [], "logger_bot": None, "workloads": {}, "error": str(e)}

@app.get("/api/bot/{bot_id}/photo")
async def get_bot_photo(bot_id: int, bot_type: str = "bot", _: bool = Depends(require_auth)):
    try:
        bot_manager = app.state.bot_manager
        if not bot_manager:
            # Return default avatar if bot manager not found
            # Use a simple SVG avatar as fallback
            color = "#10B981" if bot_type == "logger" else "#3B82F6"
            text = "L" if bot_type == "logger" else "@"
            default_avatar = f'''<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                <rect width="40" height="40" fill="{color}"/>
                <text x="20" y="27" font-family="Arial" font-size="20" fill="white" text-anchor="middle">{text}</text>
            </svg>'''
            return Response(
                content=default_avatar,
                media_type="image/svg+xml",
                headers={"Cache-Control": "no-cache"}
            )

        # First check if this is the logger bot
        logger_bot_client = getattr(bot_manager, 'logger_bot_util', None)
        if logger_bot_client:
            try:
                # For python-telegram-bot, we need to get the bot info from the bot attribute
                if hasattr(logger_bot_client, 'bot') and logger_bot_client.bot:
                    logger_bot_me = await logger_bot_client.bot.get_me()
                    if logger_bot_me and logger_bot_me.id == bot_id:
                        # This is the logger bot, try to get its profile photo
                        try:
                            # Get user profile photos for the logger bot
                            user_photos = await logger_bot_client.bot.get_user_profile_photos(bot_id, limit=1)
                            if user_photos and user_photos.photos:
                                # Get the first (most recent) photo
                                photo = user_photos.photos[0][0]  # First size of first photo
                                # Download the photo file content
                                photo_file = await logger_bot_client.bot.get_file(photo.file_id)
                                # Download the actual file content to memory
                                try:
                                    # Create a BytesIO object to store the file content
                                    out = io.BytesIO()
                                    # Download the file content to the BytesIO object
                                    await photo_file.download_to_memory(out)
                                    # Get the bytes from the BytesIO object
                                    photo_bytes = out.getvalue()
                                    if len(photo_bytes) > 0:
                                        # Return the photo data
                                        return Response(
                                            content=photo_bytes,
                                            media_type="image/jpeg",
                                            headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                                        )
                                except AttributeError as e:
                                    print(f"Error downloading file with download_to_memory: {e}")
                                    # If download_to_memory is not available, try the older method
                                    try:
                                        # Create a temporary file to download to
                                        with tempfile.NamedTemporaryFile() as temp_file:
                                            await photo_file.download_to_drive(temp_file.name)
                                            # Read the file content
                                            with open(temp_file.name, 'rb') as f:
                                                photo_bytes = f.read()
                                                if len(photo_bytes) > 0:
                                                    # Return the photo data
                                                    return Response(
                                                        content=photo_bytes,
                                                        media_type="image/jpeg",
                                                        headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                                                    )
                                    except Exception as download_error:
                                        print(f"Error downloading file to drive: {download_error}")
                                        pass
                        except Exception as logger_photo_error:
                            # If we can't get the logger bot photo, return default avatar
                            color = "#10B981"  # Green for logger bot
                            text = "L"
                            default_avatar = f'''<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                                <rect width="40" height="40" fill="{color}"/>
                                <text x="20" y="27" font-family="Arial" font-size="20" fill="white" text-anchor="middle">{text}</text>
                            </svg>'''
                            return Response(
                                content=default_avatar,
                                media_type="image/svg+xml",
                                headers={"Cache-Control": "no-cache"}
                            )
            except:
                pass
        
        # Find the client with the matching bot ID in regular bots
        clients = None
        if hasattr(bot_manager, 'clients'):
            clients = bot_manager.clients
        elif hasattr(bot_manager, 'client_list'):
            clients = bot_manager.client_list
        
        if clients is not None:
            for client in clients:
                try:
                    bot_me = client.me
                    if bot_me and bot_me.id == bot_id:
                        # Try to get the profile photo
                        try:
                            # Get the chat photos (profile photos)
                            async for photo in client.get_chat_photos(bot_id, limit=1):
                                # Download the photo
                                photo_data = await client.download_media(photo, in_memory=True)
                                if photo_data:
                                    # Check if it's a BytesIO object
                                    if hasattr(photo_data, 'getvalue'):
                                        photo_bytes = photo_data.getvalue()
                                        if len(photo_bytes) > 0:
                                            # Return the photo data
                                            return Response(
                                                content=photo_bytes,
                                                media_type="image/jpeg",
                                                headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                                            )
                                    else:
                                        # If it's already bytes, return directly
                                        if len(photo_data) > 0:
                                            return Response(
                                                content=photo_data,
                                                media_type="image/jpeg",
                                                headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                                            )
                                break  # Only get the first (most recent) photo
                        except Exception as photo_error:
                            # If we can't get the photo, fall through to return default avatar
                            pass
                except:
                    continue
        
        # Return a default avatar if we can't get the real photo
        # Use a simple SVG avatar as fallback
        color = "#10B981"  # Green for logger bot as default
        text = "L"  # L for logger bot as default
        default_avatar = f'''<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
            <rect width="40" height="40" fill="{color}"/>
            <text x="20" y="27" font-family="Arial" font-size="20" fill="white" text-anchor="middle">{text}</text>
        </svg>'''
        return Response(
            content=default_avatar,
            media_type="image/svg+xml",
            headers={"Cache-Control": "no-cache"}
        )
    except Exception as e:
        # Return default avatar on any error
        # Use a simple SVG avatar as fallback
        color = "#10B981"  # Green for logger bot as default
        text = "L"  # L for logger bot as default
        default_avatar = f'''<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
            <rect width="40" height="40" fill="{color}"/>
            <text x="20" y="27" font-family="Arial" font-size="20" fill="white" text-anchor="middle">{text}</text>
        </svg>'''
        return Response(
            content=default_avatar,
            media_type="image/svg+xml",
            headers={"Cache-Control": "no-cache"}
        )

# Add new public API route for bot workloads (no authentication required)
@app.get("/api/bots/workloads")
async def get_bots_workloads():
    try:
        bot_manager = app.state.bot_manager
        if not bot_manager:
            return {"bots_available": False, "workloads": {}, "bots_count": 0, "active_bots": 0}
        
        # Get regular bot clients
        bots_available = False
        bots_count = 0
        active_bots = 0
        workloads = {}
        
        clients = None
        if hasattr(bot_manager, 'clients'):
            clients = bot_manager.clients
        elif hasattr(bot_manager, 'client_list'):
            clients = bot_manager.client_list
        
        if clients is not None:
            bots_count = len(clients)
            for i, client in enumerate(clients):
                try:
                    bot_name = f"bot{i+1}"
                    # Get workload from the client
                    workload = client.get_workload() if hasattr(client, 'get_workload') else 0
                    
                    # Store workload info
                    workloads[bot_name] = workload
                    
                    # Check if bot is available
                    bot_me = client.me
                    if bot_me:
                        active_bots += 1
                        bots_available = True
                    else:
                        # Try to get workload even if bot is not fully initialized
                        if workload >= 0:  # If we can get workload, bot is likely available
                            active_bots += 1
                            bots_available = True
                except:
                    # If we get an exception, continue checking other bots
                    continue
        
        return {
            "bots_available": bots_available, 
            "workloads": workloads, 
            "bots_count": bots_count, 
            "active_bots": active_bots
        }
    except Exception as e:
        return {
            "bots_available": False, 
            "workloads": {}, 
            "bots_count": 0, 
            "active_bots": 0,
            "error": str(e)
        }

# --- Thumbnail Endpoint ---
@app.get("/api/file/{file_id}/thumbnail")
async def get_file_thumbnail(file_id: str, request: Request, auth_token: str = None):
    # Check authentication - first try the normal auth, then check for token in query params
    try:
        # This will raise an exception if not authenticated via normal means
        require_auth(request)
    except HTTPException:
        # If normal auth fails, check for auth_token in query params
        if auth_token and auth_token in _auth_tokens:
            # Token is valid, proceed
            pass
        else:
            # No valid authentication method
            raise HTTPException(status_code=401, detail="Authentication required")
    
    try:
        bot_manager = app.state.bot_manager
        if not bot_manager:
            raise HTTPException(status_code=503, detail="Bot manager not available")

        # Get a client to use for downloading
        client: Client = bot_manager.get_least_busy_client() if hasattr(bot_manager, 'get_least_busy_client') else None
        if not client:
            raise HTTPException(status_code=500, detail="No available bot clients")
        
        photo_data = await client.download_media(file_id, in_memory=True)
        if photo_data:
            # Check if it's a BytesIO object
            if hasattr(photo_data, 'getvalue'):
                photo_bytes = photo_data.getvalue()
                if len(photo_bytes) > 0:
                    # Return the photo data
                    return Response(
                        content=photo_bytes,
                        media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                    )
            else:
                # If it's already bytes, return directly
                if len(photo_data) > 0:
                    return Response(
                        content=photo_data,
                        media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                    )
    except Exception as e:
        logger.error(f"Error downloading file thumbnail: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class UserProfileResponse(BaseModel):
    username: str
    email: Optional[str] = None
    telegram_user_id: Optional[int] = None
    telegram_username: Optional[str] = None
    telegram_first_name: Optional[str] = None
    telegram_last_name: Optional[str] = None
    telegram_profile_picture: Optional[str] = None


class IsOwnerResponse(BaseModel):
    is_owner: bool
    owner_telegram_id: Optional[int] = None


class UserPermission(BaseModel):
    read: bool = True
    write: bool = False


class UserResponse(BaseModel):
    id: str
    username: str
    email: Optional[str] = None
    telegram_user_id: Optional[int] = None
    telegram_username: Optional[str] = None
    permissions: UserPermission
    created_at: str
    last_active: Optional[str] = None
    user_type: Optional[str] = None  # "local" or "google"


class UsersResponse(BaseModel):
    users: List[UserResponse]


class AddUserRequest(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    permissions: UserPermission


class UpdateUserRequest(BaseModel):
    email: Optional[str] = None
    permissions: UserPermission

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

@app.get("/api/user/profile", response_model=UserProfileResponse)
async def get_user_profile(request: Request, _: bool = Depends(require_auth)):
    """
    Get detailed user profile information including Telegram verification status
    """
    try:
        # Get the authenticated user
        username = request.session.get("username")
        if not username:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        # Get user data from database
        user_data = database.Users.getUser(username)
        if not user_data:
            # Create user if not exists
            database.Users.SaveUser(username)
            user_data = database.Users.getUser(username)
        
        # Build response
        profile = UserProfileResponse(
            username=username,
            email=request.session.get("user_email"),
            telegram_user_id=user_data.get("telegram_user_id") if user_data else None,
            telegram_username=user_data.get("telegram_username") if user_data else None,
            telegram_first_name=user_data.get("telegram_first_name") if user_data else None,
            telegram_last_name=user_data.get("telegram_last_name") if user_data else None,
            telegram_profile_picture=user_data.get("telegram_profile_picture") if user_data else None
        )
        
        return profile
        
    except Exception as e:
        logger.error(f"Error fetching user profile: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/user/is-owner", response_model=IsOwnerResponse)
async def is_user_owner(request: Request, user_id: str = Depends(require_auth)):
    """
    Check if the current user is the owner (defined in OWNER env variable)
    """
    try:
        # Get user data from database
        user_data = database.Users.getUser(request.session.get("username"))
        
        # Check if user has telegram_user_id and if it matches OWNER
        is_owner = False
        owner_telegram_id = None
        
        if OWNER is not None and user_data and user_data.get("telegram_user_id"):
            is_owner = int(user_data.get("telegram_user_id")) == OWNER
            owner_telegram_id = OWNER
        
        return IsOwnerResponse(is_owner=is_owner, owner_telegram_id=owner_telegram_id)
    except Exception as e:
        logger.error(f"Error checking owner status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/users", response_model=UsersResponse)
async def get_users(request: Request, user_id: str = Depends(require_auth)):
    """
    Get all users (owner only)
    """
    try:
        # Check if user is owner
        user_data = database.Users.getUser(request.session.get("username"))
        if not user_data or not user_data.get("telegram_user_id") or int(user_data.get("telegram_user_id")) != OWNER:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Get all users from database
        # Get all users from database
        all_users = database.Users.get_all_users()
        
        users = []
        
        # Process each user
        for user_doc in all_users:
            # Skip admin user as we'll add it separately with full details
            if user_doc.get("user_id") == "admin":
                continue
                
            # Get user permissions
            user_permissions = user_doc.get("permissions", {})
            
            # Determine user type
            user_type = "local" if (user_doc.get("user_id") and not user_doc.get("user_id").startswith("google_")) else "google"
            
            # Add user to the list
            users.append(UserResponse(
                id=str(user_doc.get("_id")),
                username=user_doc.get("user_id", ""),
                email=user_doc.get("email"),
                permissions=UserPermission(
                    read=user_permissions.get("read", True),
                    write=user_permissions.get("write", False)
                ),
                created_at=user_doc.get("created_at", datetime.datetime.now().strftime("%Y-%m-%d")),
                user_type=user_type
            ))
        
        # Add admin user with full details
        admin_user = database.Users.getUser("admin")
        users.insert(0, UserResponse(
            id="1",
            username="admin",
            email=admin_user.get("email") if admin_user else "admin@example.com",
            telegram_user_id=user_data.get("telegram_user_id"),
            telegram_username=user_data.get("telegram_username"),
            permissions=UserPermission(read=True, write=True),
            created_at=admin_user.get("created_at", "2023-01-01") if admin_user else "2023-01-01",
            last_active=admin_user.get("last_active", "2023-12-01") if admin_user else "2023-12-01",
            user_type="local"
        ))
        
        return UsersResponse(users=users)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching users: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/users", response_model=UserResponse)
async def add_user(request: Request, user_request: AddUserRequest, user_id: str = Depends(require_auth)):
    """
    Add a new user (owner only)
    """
    try:
        # Check if user is owner
        user_data = database.Users.getUser(request.session.get("username"))
        if not user_data or not user_data.get("telegram_user_id") or int(user_data.get("telegram_user_id")) != OWNER:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Validate input based on user type
        if not user_request.email:
            raise HTTPException(status_code=400, detail="Email is required")
        
        # For local users, username and password are required
        if user_request.username and not user_request.password:
            raise HTTPException(status_code=400, detail="Password is required for local users")
        
        # For Google users, only email is required
        if not user_request.username and user_request.password:
            raise HTTPException(status_code=400, detail="Username is required for local users")
        
        # Check if user already exists by username
        existing_user = None
        if user_request.username:
            existing_user = database.Users.getUser(user_request.username)
        
        # Also check if a Google user with this email already exists
        if not user_request.username:
            # Look for existing Google user with this email
            all_users = database.Users.get_all_users()
            for user in all_users:
                if user.get("user_id", "").startswith("google_") and user.get("email") == user_request.email:
                    existing_user = user
                    break
        
        if existing_user:
            raise HTTPException(status_code=400, detail="User already exists")
        
        # Hash password if provided
        password_hash = None
        if user_request.password:
            password_hash = hashlib.sha256(user_request.password.encode()).hexdigest()
        
        # Save user to database
        user_id_for_db = user_request.username if user_request.username else f"google_{user_request.email}"
        save_result = database.Users.SaveUser(
            user_id=user_id_for_db,
            password_hash=password_hash,
            email=user_request.email
        )
        
        # Save permissions
        permissions_dict = {
            "read": user_request.permissions.read,
            "write": user_request.permissions.write
        }
        database.Users.update_permissions(user_id_for_db, permissions_dict)
        
        # Determine user type
        user_type = "local" if user_request.username else "google"
        
        # Create response
        new_user = UserResponse(
            id=str(save_result.inserted_id) if save_result else "unknown",
            username=user_request.username or "",
            email=user_request.email,
            permissions=user_request.permissions,
            created_at=datetime.datetime.now().strftime("%Y-%m-%d"),
            user_type=user_type
        )
        
        return new_user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding user: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/users/{user_id_param}", response_model=UserResponse)
async def update_user(request: Request, user_id_param: str, user_request: UpdateUserRequest, user_id: str = Depends(require_auth)):
    """
    Update a user (owner only)
    """
    try:
        # Check if user is owner
        user_data = database.Users.getUser(request.session.get("username"))
        if not user_data or not user_data.get("telegram_user_id") or int(user_data.get("telegram_user_id")) != OWNER:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Get current user data by identifier
        current_user = database.Users.get_user_by_identifier(user_id_param)
        if not current_user:
            raise HTTPException(status_code=404, detail="User not found")
        
        # Prepare update data
        update_data = {}
        
        # Update user email in database
        if user_request.email:
            update_data["email"] = user_request.email
        
        # Update user in database
        if update_data:
            success = database.Users.update_user_by_identifier(user_id_param, update_data)
            if not success:
                raise HTTPException(status_code=500, detail="Failed to update user")
        
        # Update user permissions in database
        permissions_dict = {
            "read": user_request.permissions.read,
            "write": user_request.permissions.write
        }
        database.Users.update_permissions(current_user.get("user_id"), permissions_dict)
        
        # Get updated user data
        updated_user_data = database.Users.get_user_by_identifier(user_id_param)
        
        # Determine user type based on whether username exists
        user_type = "local" if (updated_user_data and updated_user_data.get("user_id") and not updated_user_data.get("user_id").startswith("google_")) else "google"
        
        updated_user = UserResponse(
            id=user_id_param,
            username=updated_user_data.get("user_id", "Unknown") if updated_user_data else "Unknown",
            email=user_request.email or (updated_user_data.get("email") if updated_user_data else None),
            permissions=UserPermission(
                read=user_request.permissions.read,
                write=user_request.permissions.write
            ),
            created_at=updated_user_data.get("created_at", datetime.datetime.now().strftime("%Y-%m-%d")) if updated_user_data else datetime.datetime.now().strftime("%Y-%m-%d"),
            last_active=updated_user_data.get("last_active") if updated_user_data else None,
            user_type=user_type
        )
        
        return updated_user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/users/{user_id_param}")
async def delete_user(request: Request, user_id_param: str, user_id: str = Depends(require_auth)):
    """
    Delete a user (owner only)
    """
    try:
        # Check if user is owner
        user_data = database.Users.getUser(request.session.get("username"))
        if not user_data or not user_data.get("telegram_user_id") or int(user_data.get("telegram_user_id")) != OWNER:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Prevent deleting admin user
        # First check if this is the admin user by identifier
        admin_user = database.Users.getUser("admin")
        if admin_user and str(admin_user.get("_id")) == user_id_param:
            raise HTTPException(status_code=400, detail="Cannot delete admin user")
        
        # Also check if the identifier is "admin" directly
        if user_id_param == "admin" or user_id_param == "1":
            raise HTTPException(status_code=400, detail="Cannot delete admin user")
        
        # Delete user from database
        success = database.Users.delete_user(user_id_param)
        if not success:
            raise HTTPException(status_code=404, detail="User not found")
        
        return {"message": "User deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/users/{user_id_param}/password")
async def change_user_password(request: Request, user_id_param: str, password_request: ChangePasswordRequest, user_id: str = Depends(require_auth)):
    """
    Change a user's password (owner only or user themselves)
    """
    try:
        logger.info(f"Attempting to change password for user_id_param: {user_id_param}")
        
        # Get current user data
        current_user_data = database.Users.getUser(request.session.get("username"))
        logger.info(f"Current user data: {current_user_data}")
        
        # Check if user is owner or trying to change their own password
        is_owner = (current_user_data and current_user_data.get("telegram_user_id") and 
                   int(current_user_data.get("telegram_user_id")) == OWNER)
        logger.info(f"Is owner: {is_owner}")
        
        # Handle special case for admin user with ID "1"
        actual_user_id_param = user_id_param
        if user_id_param == "1":
            actual_user_id_param = "admin"
        
        # Get target user data
        target_user = database.Users.get_user_by_identifier(actual_user_id_param)
        logger.info(f"Target user data: {target_user}")
        
        if not target_user:
            logger.warning(f"User not found for user_id_param: {actual_user_id_param}")
            raise HTTPException(status_code=404, detail="User not found")
        
        # Allow if user is owner or if user is changing their own password
        target_username = target_user.get("user_id")
        is_self = target_username == request.session.get("username")
        logger.info(f"Target username: {target_username}, Is self: {is_self}")
        
        if not is_owner and not is_self:
            logger.warning(f"Access denied - not owner ({is_owner}) and not self ({is_self})")
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Verify current password using the new method that doesn't auto-save hash
        logger.info(f"Verifying current password for user: {target_username}")
        is_password_correct = database.Users.verify_current_password(target_username, password_request.current_password)
        logger.info(f"Current password verification result: {is_password_correct}")
        
        if not is_password_correct:
            logger.warning(f"Incorrect current password for user: {target_username}")
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        
        # Hash new password
        logger.info(f"Hashing new password for user: {target_username}")
        new_password_hash = hashlib.sha256(password_request.new_password.encode()).hexdigest()
        
        # Update password in database
        logger.info(f"Updating password in database for user: {target_username}")
        success = database.Users.update_user_by_identifier(actual_user_id_param, {"password_hash": new_password_hash})
        logger.info(f"Database update result: {success}")
        
        if not success:
            logger.error(f"Failed to update password for user: {target_username}")
            raise HTTPException(status_code=500, detail="Failed to update password")
        
        logger.info(f"Password updated successfully for user {target_username}")
        return {"message": "Password updated successfully"}
        
    except HTTPException:
        logger.info("Re-raising HTTPException")
        raise
    except Exception as e:
        logger.error(f"Error changing user password: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

class IndexChatResponse(BaseModel):
    index_chat_id: Optional[int] = None


class UpdateIndexChatRequest(BaseModel):
    index_chat_id: Optional[int] = None


@app.get("/api/user/index-chat", response_model=IndexChatResponse)
async def get_user_index_chat(request: Request, user_id: str = Depends(require_auth)):
    """
    Get the index chat ID for the current user
    """
    try:
        # Get the authenticated user
        username = request.session.get("username")
        if not username:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        # Get user data from database
        user_data = database.Users.getUser(username)
        if not user_data:
            # Create user if not exists
            database.Users.SaveUser(username)
            user_data = database.Users.getUser(username)
        
        # Get index chat ID from user data
        index_chat_id = user_data.get("index_chat_id") if user_data else None
        
        return IndexChatResponse(index_chat_id=index_chat_id)
        
    except Exception as e:
        logger.error(f"Error fetching user index chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/user/index-chat", response_model=IndexChatResponse)
async def update_user_index_chat(request: Request, update_request: UpdateIndexChatRequest, user_id: str = Depends(require_auth)):
    """
    Update the index chat ID for the current user
    """
    try:
        # Get the authenticated user
        username = request.session.get("username")
        if not username:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        # Update index chat ID in database
        update_data = {}
        if update_request.index_chat_id is not None:
            update_data["index_chat_id"] = update_request.index_chat_id
        else:
            # If None, remove the field
            update_data["$unset"] = {"index_chat_id": ""}
        
        # Perform the update
        if update_data:
            if "$unset" in update_data:
                # Handle removal of the field
                database.Users.update_one(
                    {"user_id": username},
                    {"$unset": update_data["$unset"]}
                )
            else:
                # Handle setting the field
                database.Users.update_one(
                    {"user_id": username},
                    {"$set": update_data}
                )
        
        # Get updated user data
        user_data = database.Users.getUser(username)
        index_chat_id = user_data.get("index_chat_id") if user_data else None
        
        return IndexChatResponse(index_chat_id=index_chat_id)
        
    except Exception as e:
        logger.error(f"Error updating user index chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Add a catch-all route to serve the frontend for client-side routing
@app.get("/{full_path:path}")
async def serve_frontend(request: Request, full_path: str):
    """Serve the frontend application for all routes to support client-side routing"""
    import os
    # Get the directory where this file is located
    current_dir = os.path.dirname(os.path.abspath(__file__))
    # Navigate to the frontend build directory
    frontend_dir = os.path.join(current_dir, "..", "..", "Frontend", "dist")
    
    # If we're in development mode, serve the Vite development server
    # Check if we're in development by looking for the vite config
    vite_config = os.path.join(current_dir, "..", "..", "Frontend", "vite.config.ts")
    if os.path.exists(vite_config):
        # In development, we still need to serve the index.html for client-side routing
        # The Vite proxy will handle API requests, but we need to serve the frontend for all routes
        # Try to serve the index.html from the frontend/src directory for development
        dev_index = os.path.join(current_dir, "..", "..", "Frontend", "index.html")
        if os.path.exists(dev_index):
            with open(dev_index, "r", encoding="utf-8") as f:
                content = f.read()
                return Response(content=content, media_type="text/html")
        # If that doesn't work, fall through to the dist directory check
    
    # Try to serve the built frontend files
    if os.path.exists(frontend_dir):
        import os
        index_file = os.path.join(frontend_dir, "index.html")
        if os.path.exists(index_file):
            with open(index_file, "r", encoding="utf-8") as f:
                content = f.read()
                return Response(content=content, media_type="text/html")
    
    # Fallback to a simple response that serves the frontend for client-side routing
    return Response(
        content="""
        <!DOCTYPE html>
        <html>
        <head>
            <title>File Server</title>
        </head>
        <body>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
        </body>
        </html>
        """,
        media_type="text/html"
    )

async def _web_server(bot_manager):
    # Store the bot manager instance for use in routes
    app.state.bot_manager = bot_manager
    return app