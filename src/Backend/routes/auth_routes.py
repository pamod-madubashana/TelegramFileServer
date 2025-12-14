# src/Backend/routes/auth_routes.py

from fastapi import APIRouter, Request, Depends, HTTPException, status
from pydantic import BaseModel
import hashlib
import secrets
import datetime
from typing import Optional

from ..security.credentials import require_auth, is_authenticated, require_admin, verify_credentials, verify_google_token, ADMIN_PASSWORD_HASH, User

from src.Database import database
from src.Config import APP_NAME
from d4rk.Logs import setup_logger

logger = setup_logger("auth_routes")

# Create router with updated prefix
router = APIRouter(prefix="/auth", tags=["Authentication"])

class LoginRequest(BaseModel):
    username: str
    password: str

class GoogleLoginRequest(BaseModel):
    token: str

@router.post("/login")
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
        
        # Check if user has verified their Telegram account before creating default folders
        user_data = database.Users.getUser(login_data.username)
        if user_data and user_data.get("telegram_user_id"):
            # User has verified their Telegram account, create default folders
            user_id = str(user_data.get("telegram_user_id"))
            created_folders = database.Files.create_default_folders(user_id)
            logger.info(f"Default folders created for user {login_data.username}: {created_folders}")
        else:
            logger.info(f"User {login_data.username} has not verified Telegram account, skipping default folder creation")
        
        # Generate a token for Tauri/desktop app usage
        auth_token = secrets.token_urlsafe(32)
        token_data = {
            "authenticated": True,
            "username": login_data.username,
            "auth_method": "local",
            "created_at": datetime.datetime.now().isoformat()
        }
        # Note: _auth_tokens dictionary should be passed from main app or imported
        # For now, we'll handle this in the main web.py file
        
        # Save token to database for persistence
        database.Users.save_auth_token(login_data.username, auth_token, "local")
        
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

@router.post("/google")
async def google_login_route(request: Request, login_data: GoogleLoginRequest):
    user_info = verify_google_token(login_data.token)
    if user_info:
        request.session["authenticated"] = True
        request.session["user_email"] = user_info["email"]
        request.session["username"] = user_info["name"]
        request.session["user_picture"] = user_info["picture"]
        request.session["auth_method"] = "google"
        
        # Check if user has verified their Telegram account before creating default folders
        user_data = database.Users.getUser(user_info["name"])
        if user_data and user_data.get("telegram_user_id"):
            # User has verified their Telegram account, create default folders
            user_id = str(user_info["name"])
            created_folders = database.Files.create_default_folders(user_id)
            logger.info(f"Default folders created for user {user_info['name']}: {created_folders}")
        else:
            logger.info(f"User {user_info['name']} has not verified Telegram account, skipping default folder creation")
        
        # Generate a token for Tauri/desktop app usage
        auth_token = secrets.token_urlsafe(32)
        token_data = {
            "authenticated": True,
            "username": user_info["name"],
            "auth_method": "google",
            "created_at": datetime.datetime.now().isoformat()
        }
        # Note: _auth_tokens dictionary should be passed from main app or imported
        # For now, we'll handle this in the main web.py file
        
        # Save token to database for persistence
        database.Users.save_auth_token(user_info["name"], auth_token, "google")
        
        return {"message": "Login successful", "user": user_info, "auth_token": auth_token}
    
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid Google token or unauthorized user",
    )

@router.post("/logout")
async def logout_route(request: Request):
    request.session.clear()
    auth_header = request.headers.get("X-Auth-Token")
    if auth_header:database.Users.remove_auth_token(auth_header)
    return {"message": "Logged out successfully"}

@router.get("/check")
async def check_auth(request: Request):
    # Log session data for debugging
    logger.info(f"Auth check request. Session data: {dict(request.session)}")
    from ..modules.utilities import _auth_tokens
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