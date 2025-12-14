# src/Backend/modules/utilities.py

from typing import Dict
from datetime import datetime
from src.Database import database
from d4rk.Logs import setup_logger

logger = setup_logger("web_server_utilities")

work_loads = {}
_auth_tokens: Dict[str, Dict] = {}

def load_persistent_tokens(app):
    """Load persistent auth tokens from database on startup"""
    try:
        database.Users.cleanup_expired_tokens()
        tokens_cursor = database.Users.database.AuthTokens.find({
            'expires_at': {'$gte': datetime.now()}
        })
        
        loaded_count = 0
        for token_data in tokens_cursor:
            auth_token = token_data['auth_token']
            _auth_tokens[auth_token] = {
                "authenticated": True,
                "username": token_data['username'],
                "auth_method": token_data['auth_method'],
                "created_at": token_data['created_at'].isoformat() if hasattr(token_data['created_at'], 'isoformat') else str(token_data['created_at'])
            }
            loaded_count += 1
        
        logger.info(f"Loaded {loaded_count} persistent auth tokens from database")
    except Exception as e:
        logger.error(f"Failed to load persistent auth tokens: {e}")

__all__ = ['work_loads', '_auth_tokens', 'load_persistent_tokens']