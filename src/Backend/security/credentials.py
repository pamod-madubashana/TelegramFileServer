from fastapi import HTTPException, Request
from fastapi.security import HTTPBearer
from typing import Optional
import hashlib
import logging
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from src.Config import GOOGLE_CLIENT_ID, AUTHORIZED_ADMIN_EMAILS

# Set up logging
logger = logging.getLogger(__name__)

# Admin credentials
USERNAME = "admin"
PASSWORD = "password"
ADMIN_PASSWORD_HASH = hashlib.sha256(PASSWORD.encode()).hexdigest()

# List of authorized admin emails (from config)
AUTHORIZED_ADMINS = AUTHORIZED_ADMIN_EMAILS

security = HTTPBearer(auto_error=False)

def verify_password(password: str) -> bool:
    password_hash = hashlib.sha256(password.encode()).hexdigest()
    logger.info(f"Verifying password. Expected hash: {ADMIN_PASSWORD_HASH}, Provided hash: {password_hash}")
    return password_hash == ADMIN_PASSWORD_HASH

def verify_credentials(username: str, password: str) -> bool:
    logger.info(f"Verifying credentials for username: '{username}'")
    logger.info(f"Expected username: '{USERNAME}'")
    is_username_valid = username == USERNAME
    is_password_valid = verify_password(password)
    logger.info(f"Username valid: {is_username_valid}, Password valid: {is_password_valid}")
    return is_username_valid and is_password_valid

def verify_google_token(token: str) -> Optional[dict]:
    """Verify Google ID token and return user info if valid"""
    try:
        logger.info(f"Verifying Google token with client ID: {GOOGLE_CLIENT_ID}")
        
        # Check if GOOGLE_CLIENT_ID is set
        if not GOOGLE_CLIENT_ID:
            logger.error("GOOGLE_CLIENT_ID is not set in environment variables")
            return None
            
        # Specify the CLIENT_ID of the app that accesses the backend:
        idinfo = id_token.verify_oauth2_token(token, google_requests.Request(), GOOGLE_CLIENT_ID)
        
        # Check if the user's email is in the authorized admins list
        user_email = idinfo['email']
        if user_email not in AUTHORIZED_ADMINS:
            logger.warning(f"Google user {user_email} is not in the authorized admins list")
            return None
        
        # ID token is valid. Get user info
        user_info = {
            "user_id": idinfo['sub'],
            "email": idinfo['email'],
            "name": idinfo.get('name', ''),
            "picture": idinfo.get('picture', '')
        }
        
        logger.info(f"Google token verified successfully for user: {user_info['email']}")
        return user_info
    except ValueError as e:
        # Invalid token
        logger.error(f"Invalid Google token: {str(e)}")
        return None
    except Exception as e:
        logger.error(f"Google token verification failed: {e}")
        return None

def is_authenticated(request: Request) -> bool:
    auth_status = request.session.get("authenticated", False)
    logger.info(f"Checking authentication status: {auth_status}")
    logger.info(f"Session data: {dict(request.session)}")
    return auth_status

def is_admin(request: Request) -> bool:
    """Check if the authenticated user is an admin"""
    if not is_authenticated(request):
        return False
    
    # Check if user authenticated via username/password (always admin)
    if request.session.get("auth_method") == "local":
        return True
    
    # Check if Google user is in authorized admins list
    if request.session.get("auth_method") == "google":
        user_email = request.session.get("user_email")
        return user_email in AUTHORIZED_ADMINS
    
    return False

def require_auth(request: Request):
    # Check session first
    if request.session.get("authenticated"):
        return True
    
    # Check if authenticated via token (from middleware)
    if hasattr(request.state, 'authenticated_via_token') and request.state.authenticated_via_token:
        return True
    
    raise HTTPException(status_code=401, detail="Authentication required")

def require_admin(request: Request):
    """Require admin privileges"""
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Authentication required")
    
    if not is_admin(request):
        raise HTTPException(status_code=403, detail="Admin privileges required")
    
    return True

def get_current_user(request: Request) -> Optional[str]:
    if is_authenticated(request):
        return request.session.get("username")
    return None