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
from typing import List, Dict, Any

# Set up logger to match your application's logging format
from d4rk.Logs import setup_logger
logger = setup_logger("web_server")

from ..security.credentials import require_auth, is_authenticated, require_admin, verify_credentials, verify_google_token
from .api_routes import list_media_api, delete_media_api, update_media_api, delete_movie_quality_api, delete_tv_quality_api, delete_tv_episode_api, delete_tv_season_api
from .stream_routes import router as stream_router

from src.Config import APP_NAME
from src.Database import database
from dataclasses import asdict

# Global variable for workloads (if used by other modules, otherwise just for get_workloads)
work_loads = {}

app = FastAPI(
    title=f"{APP_NAME} Media Server",
    description=f"A powerful, self-hosted {APP_NAME} Media Server built with FastAPI, MongoDB, and PyroFork seamlessly integrated with Stremio for automated media streaming and discovery.",
)

# Include stream routes
app.include_router(stream_router)

# --- Middleware Setup ---
app.add_middleware(SessionMiddleware, secret_key="f6d2e3b9a0f43d9a2e6a56b2d3175cd9c05bbfe31d95ed2a7306b57cb1a8b6f0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    if verify_credentials(login_data.username, login_data.password):
        request.session["authenticated"] = True
        request.session["username"] = login_data.username
        request.session["auth_method"] = "local"
        return {"message": "Login successful", "username": login_data.username}
    
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
        detail="Invalid Google token",
    )

@app.post("/api/auth/logout")
async def logout_route(request: Request):
    request.session.clear()
    return {"message": "Logged out successfully"}

@app.get("/api/auth/check")
async def check_auth(request: Request):
    return {
        "authenticated": request.session.get("authenticated", False),
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

# --- API Routes ---
@app.get("/api/files")
async def get_all_files_route(
    path: str = Query(default="/", description="Folder path to fetch files from"),
    _: bool = Depends(require_auth)
):
    try:
        # Fetch files for the specified path
        files_data = database.Files.get_files_by_path(path)
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
async def create_folder_route(request: CreateFolderRequest, _: bool = Depends(require_auth)):
    try:
        success = database.Files.create_folder(request.folderName, request.currentPath)
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
async def move_file_route(request: MoveFileRequest, _: bool = Depends(require_auth)):
    try:
        # Get the file by ID
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Update the file's path
        database.Files.update_one(
            {"_id": ObjectId(request.file_id)},
            {"$set": {"file_path": request.target_path}}
        )
        
        return {"message": "File moved successfully"}
    except Exception as e:
        logger.error(f"Error moving file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/copy")
async def copy_file_route(request: CopyFileRequest, _: bool = Depends(require_auth)):
    try:
        # Get the file by ID
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Create a copy of the file with the new path
        new_file_data = file_data.copy()
        new_file_data["_id"] = ObjectId()  # Generate new ID
        new_file_data["file_path"] = request.target_path
        
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

@app.post("/api/files/delete")
async def delete_file_route(request: DeleteFileRequest, _: bool = Depends(require_auth)):
    try:
        # Get the file by ID to check if it exists
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
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
            
            # Delete all files in the folder
            database.Files.delete_many({"file_path": full_folder_path})
            
            # Also delete any subfolders and files inside this folder
            # Delete items that are inside this folder (path starts with full_folder_path + "/")
            database.Files.delete_many({
                "file_path": {"$regex": f"^{re.escape(full_folder_path)}/"}
            })
        
        # Delete the file/folder itself
        result = database.Files.delete_one({"_id": ObjectId(request.file_id)})
        
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
async def get_file_thumbnail(file_id: str, _: bool = Depends(require_auth)):
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

async def _web_server(bot_manager):
    # Store the bot manager instance for use in routes
    app.state.bot_manager = bot_manager
    return app