# src/Web/web.py

from fastapi import FastAPI, Request, Form, Depends, Query, HTTPException, Response, status, File, UploadFile
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
import aiofiles

# Set up logger to match your application's logging format
from d4rk.Logs import setup_logger
logger = setup_logger("web_server")

from .security.credentials import require_auth, is_authenticated, require_admin, verify_credentials, verify_google_token, ADMIN_PASSWORD_HASH , User
from .routes.api_routes import list_media_api, delete_media_api, update_media_api, delete_movie_quality_api, delete_tv_quality_api, delete_tv_episode_api, delete_tv_season_api
from .routes.stream_routes import router as stream_router
# Import the new Telegram verification router
from .routes.telegram_verification import router as telegram_router

# Import our new routers
from .routes.auth_routes import router as auth_router
from .routes.files_routes import router as files_router
from .routes.folders_routes import router as folders_router
from .routes.system_routes import router as system_router
from .routes.user_routes import router as user_router
# from .routes.frontend_routes import router as frontend_router
# Import exception handlers
from .routes.error_handlers import exception_handlers

from src.Config import APP_NAME, OWNER
from src.Database import database
from dataclasses import asdict

# Import utility functions and global variables
from .modules.utilities import work_loads, _auth_tokens, load_persistent_tokens

app = FastAPI(
    title=f"{APP_NAME} Media Server",
    description=f"A powerful, self-hosted {APP_NAME} built with FastAPI, MongoDB, and PyroFork seamlessly integrated with Stremio for automated media streaming and discovery.",
)

# Load persistent tokens on startup
@app.on_event("startup")
async def startup_event():
    load_persistent_tokens(app)
    
    # Ensure admin user has telegram_user_id set to match OWNER env var
    if OWNER is not None:
        try:
            admin_user = database.Users.getUser("admin")
            if not admin_user or admin_user.get("telegram_user_id") != OWNER:
                # Update admin user with OWNER Telegram ID
                telegram_data = {
                    "telegram_user_id": OWNER
                }
                success = database.Users.update_telegram_info("admin", telegram_data)
                if success:
                    logger.info(f"Updated admin user with OWNER Telegram ID: {OWNER}")
                else:
                    logger.error("Failed to update admin user with OWNER Telegram ID")
        except Exception as e:
            logger.error(f"Error ensuring admin user has correct Telegram ID: {e}")


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
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080", "http://localhost:8000", "http://127.0.0.1:8000", "http://localhost:8081", "tauri://localhost", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Add auth token middleware for Tauri/desktop app support ---
@app.middleware("http")
async def auth_token_middleware(request: Request, call_next):
    """Handle token-based authentication for Tauri/desktop apps"""
    auth_header = request.headers.get("X-Auth-Token")
    if auth_header:
        # First check in-memory cache
        if auth_header in _auth_tokens:
            token_data = _auth_tokens[auth_header]
            # Add token data to session-like storage for the route handlers
            request.state.auth_token_data = token_data
            request.state.authenticated_via_token = True
        else:
            # Check in database if not found in memory
            db_token_data = database.Users.get_auth_token(auth_header)
            if db_token_data:
                # Add to in-memory cache for future requests
                _auth_tokens[auth_header] = {
                    "authenticated": True,
                    "username": db_token_data['username'],
                    "auth_method": db_token_data['auth_method'],
                    "created_at": db_token_data['created_at'].isoformat() if hasattr(db_token_data['created_at'], 'isoformat') else str(db_token_data['created_at'])
                }
                # Add token data to session-like storage for the route handlers
                request.state.auth_token_data = _auth_tokens[auth_header]
                request.state.authenticated_via_token = True
    response = await call_next(request)
    return response

# Include our new routers with updated prefixes
app.include_router(auth_router)
app.include_router(files_router)
app.include_router(folders_router)
app.include_router(system_router)
app.include_router(user_router)
app.include_router(stream_router)
app.include_router(telegram_router)
# app.include_router(frontend_router)

# Register exception handlers
for exc_class, handler in exception_handlers.items():
    app.add_exception_handler(exc_class, handler)

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

@app.options("/api/health")
async def health_check_options():
    return {"status": "ok"}


async def _web_server(bot_manager):
    app.state.bot_manager = bot_manager
    return app