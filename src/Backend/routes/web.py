# src/Web/web.py

from fastapi import FastAPI, Request, Form, Depends, Query, HTTPException, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
import sys
import io
import tempfile
import logging

# Set up logger to match your application's logging format
from d4rk.Logs import setup_logger
logger = setup_logger("web_server")

from ..security.credentials import require_auth, is_authenticated , require_admin
from .template_routes import (
    login_page, login_post, logout, dashboard_page, admin_dashboard_page,
    media_management_page, edit_media_page_template,
    public_movies_page, public_movie_details_page, movie_details_page, home_page,  # Add home_page import
    google_login_callback, user_profile_page
)
from .api_routes import list_media_api, delete_media_api, update_media_api, delete_movie_quality_api, delete_tv_quality_api, delete_tv_episode_api, delete_tv_season_api
from .stream_routes import router as stream_router

from .template_routes import templates
from ..templates.theme import get_theme
from .template_routes import get_template_context
from src.Config import APP_NAME

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

# --- Static Files ---
app.mount("/static", StaticFiles(directory="src/Web/static"), name="static")

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

# --- Authentication Routes ---
@app.get("/login", response_class=HTMLResponse)
async def login(request: Request):
    return await login_page(request)

@app.post("/login")
async def login_post_route(request: Request, username: str = Form(...), password: str = Form(...)):
    return await login_post(request, username, password)

@app.post("/auth/google")
async def google_login_route(request: Request, token: str = Form(...)):
    return await google_login_callback(request, token)

@app.get("/logout")
async def logout_route(request: Request):
    return await logout(request)

# --- Main Routes ---
# Change root route to serve home view for everyone
@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    return await home_page(request)

# Add route for movies page
@app.get("/movies", response_class=HTMLResponse)
async def movies_page(request: Request):
    return await public_movies_page(request)

# Redirect dashboard route to profile for consistency
@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_route(request: Request, _: bool = Depends(require_auth)):
    return RedirectResponse(url="/profile", status_code=302)

# Add profile route that points to the user profile page
@app.get("/profile", response_class=HTMLResponse)
async def profile_route(request: Request, _: bool = Depends(require_auth)):
    return await user_profile_page(request, _)

@app.get("/admin", response_class=HTMLResponse)
async def admin_dashboard_route(request: Request, _: bool = Depends(require_admin)):
    return await admin_dashboard_page(request, _)

@app.get("/movie/{id}", response_class=HTMLResponse)
async def movie_details(request: Request, id: str):
    return await movie_details_page(request, id)

@app.get("/media/manage", response_class=HTMLResponse)
async def media_management_old(request: Request, media_type: str = "movie", _: bool = Depends(require_auth)):
    # Store media type in session for cleaner URLs
    request.session["media_type"] = media_type
    return RedirectResponse(url="/media", status_code=302)

@app.post("/media/type", response_class=HTMLResponse)
async def media_type_post(request: Request, media_type: str = Form(...), _: bool = Depends(require_auth)):
    # Store media type in session for cleaner URLs
    request.session["media_type"] = media_type
    return RedirectResponse(url="/media", status_code=302)

@app.get("/media", response_class=HTMLResponse)
async def media_management(request: Request, media_type: str = None, _: bool = Depends(require_auth)):
    # If media_type is provided as query parameter, store it in session
    if media_type:
        request.session["media_type"] = media_type
        return RedirectResponse(url="/media", status_code=302)
    
    # Retrieve media type from session, default to "movie"
    media_type = request.session.get("media_type", "movie")
    return await media_management_page(request, media_type, _)

@app.get("/media/edit", response_class=HTMLResponse)
async def edit_media_get(request: Request, id: str = None, media_type: str = None, _: bool = Depends(require_auth)):
    # If id and media_type are provided, store them in session
    if id and media_type:
        request.session["edit_media_id"] = id
        request.session["edit_media_type"] = media_type
        return RedirectResponse(url="/media/edit", status_code=302)
    
    # Retrieve media info from session
    id = request.session.get("edit_media_id")
    media_type = request.session.get("edit_media_type")
    
    if not id or not media_type:
        # Redirect to media management if no session data
        return RedirectResponse(url="/media/manage?media_type=movie", status_code=302)
    
    return await edit_media_page_template(request, id, media_type, _)

@app.post("/media/edit", response_class=HTMLResponse)
async def edit_media_post(request: Request, id: str = Form(...), media_type: str = Form(...), _: bool = Depends(require_auth)):
    # Store media info in session for cleaner URLs
    request.session["edit_media_id"] = id
    request.session["edit_media_type"] = media_type
    return RedirectResponse(url="/media/edit", status_code=302)

@app.get("/media/edit", response_class=HTMLResponse)
async def edit_media_page(request: Request, _: bool = Depends(require_auth)):
    # Retrieve media info from session
    id = request.session.get("edit_media_id")
    media_type = request.session.get("edit_media_type")
    
    if not id or not media_type:
        # Redirect to media management if no session data
        return RedirectResponse(url="/media/manage?media_type=movie", status_code=302)
    
    return await edit_media_page_template(request, id, media_type, _)

@app.get("/api/media/list")
async def list_media(
    media_type: str = Query("movie", regex="^(movie|tv)$"), 
    page: int = Query(1, ge=1), 
    page_size: int = Query(24, ge=1, le=100), 
    search: str = Query("", max_length=100),
    _: bool = Depends(require_auth)
):
    return await list_media_api(media_type, page, page_size, search)

@app.delete("/api/media/delete/{tmdb_id}")
async def delete_media(tmdb_id: str, db_index: str, media_type: str, _: bool = Depends(require_auth)):
    # Handle "undefined" values from frontend
    try:
        # Convert to integers if they're valid numbers, otherwise use defaults
        if tmdb_id == "undefined" or not tmdb_id.isdigit():
            tmdb_id_int = 0
        else:
            tmdb_id_int = int(tmdb_id)
            
        if db_index == "undefined" or not db_index.isdigit():
            db_index_int = 0
        else:
            db_index_int = int(db_index)
    except ValueError:
        # Fallback to defaults if conversion fails
        tmdb_id_int = 0
        db_index_int = 0
    
    return await delete_media_api(tmdb_id_int, db_index_int, media_type)

@app.put("/api/media/update/{id}")
async def update_media(request: Request, id: str, media_type: str, _: bool = Depends(require_auth)):
    
    return await update_media_api(request, id, media_type)

@app.delete("/api/media/delete-quality/{tmdb_id}")
async def delete_movie_quality(tmdb_id: str, db_index: str, quality: str, _: bool = Depends(require_auth)):
    # Handle "undefined" values from frontend
    try:
        # Convert to integers if they're valid numbers, otherwise use defaults
        if tmdb_id == "undefined" or not tmdb_id.isdigit():
            tmdb_id_int = 0
        else:
            tmdb_id_int = int(tmdb_id)
            
        if db_index == "undefined" or not db_index.isdigit():
            db_index_int = 0
        else:
            db_index_int = int(db_index)
    except ValueError:
        # Fallback to defaults if conversion fails
        tmdb_id_int = 0
        db_index_int = 0
    
    return await delete_movie_quality_api(tmdb_id_int, db_index_int, quality)

@app.delete("/api/media/delete-tv-quality/{tmdb_id}")
async def delete_tv_quality(tmdb_id: str, db_index: str, season: int, episode: int, quality: str, _: bool = Depends(require_auth)):
    # Handle "undefined" values from frontend
    try:
        # Convert to integers if they're valid numbers, otherwise use defaults
        if tmdb_id == "undefined" or not tmdb_id.isdigit():
            tmdb_id_int = 0
        else:
            tmdb_id_int = int(tmdb_id)
            
        if db_index == "undefined" or not db_index.isdigit():
            db_index_int = 0
        else:
            db_index_int = int(db_index)
    except ValueError:
        # Fallback to defaults if conversion fails
        tmdb_id_int = 0
        db_index_int = 0
    
    return await delete_tv_quality_api(tmdb_id_int, db_index_int, season, episode, quality)

@app.delete("/api/media/delete-tv-episode/{tmdb_id}")
async def delete_tv_episode(tmdb_id: str, db_index: str, season: int, episode: int, _: bool = Depends(require_auth)):
    # Handle "undefined" values from frontend
    try:
        # Convert to integers if they're valid numbers, otherwise use defaults
        if tmdb_id == "undefined" or not tmdb_id.isdigit():
            tmdb_id_int = 0
        else:
            tmdb_id_int = int(tmdb_id)
            
        if db_index == "undefined" or not db_index.isdigit():
            db_index_int = 0
        else:
            db_index_int = int(db_index)
    except ValueError:
        # Fallback to defaults if conversion fails
        tmdb_id_int = 0
        db_index_int = 0
    
    return await delete_tv_episode_api(tmdb_id_int, db_index_int, season, episode)

@app.delete("/api/media/delete-tv-season/{tmdb_id}")
async def delete_tv_season(tmdb_id: str, db_index: str, season: int, _: bool = Depends(require_auth)):
    # Handle "undefined" values from frontend
    try:
        # Convert to integers if they're valid numbers, otherwise use defaults
        if tmdb_id == "undefined" or not tmdb_id.isdigit():
            tmdb_id_int = 0
        else:
            tmdb_id_int = int(tmdb_id)
            
        if db_index == "undefined" or not db_index.isdigit():
            db_index_int = 0
        else:
            db_index_int = int(db_index)
    except ValueError:
        # Fallback to defaults if conversion fails
        tmdb_id_int = 0
        db_index_int = 0
    
    return await delete_tv_season_api(tmdb_id_int, db_index_int, season)


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

# Add this new API route for public movie listing (no authentication required)
@app.get("/api/public/media/list")
async def list_public_media(
    media_type: str = Query("movie", regex="^(movie|tv)$"), 
    page: int = Query(1, ge=1), 
    page_size: int = Query(24, ge=1, le=100), 
    search: str = Query("", max_length=100)
):
    return await list_media_api(media_type, page, page_size, search)

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
    return RedirectResponse(url="/login", status_code=302)

@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    # Use theme helper
    context = get_template_context("midnight_carbon", request)
    context["error"] = "Page not found"
    context["message"] = "The requested page could not be found."
    
    return templates.TemplateResponse(
        "error.html", 
        context,
        status_code=404
    )

@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    # Use theme helper
    context = get_template_context("midnight_carbon", request)
    context["error"] = "Internal server error"
    context["message"] = "An unexpected error occurred."
    
    return templates.TemplateResponse(
        "error.html", 
        context,
        status_code=500
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

async def _web_server(bot_manager):
    # Store the bot manager instance for use in routes
    app.state.bot_manager = bot_manager
    return app