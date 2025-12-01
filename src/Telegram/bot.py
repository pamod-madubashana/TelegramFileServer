#src/Telegram/bot.py

import asyncio
import threading

from datetime import datetime

from pyrogram import Client

from d4rk.Handlers import BotManager , FontMessageMixin
from d4rk.Logs import setup_logger , get_timezone_offset

from src.Backend import WebServerManager
from d4rk import D4RK_BotManager
from src.Database import database
from src.Config import API_ID , API_HASH , TOKENS , APP_NAME , TIME_ZONE ,LOGS , DATABASE_URL , OWNER , LOGGER_BOT , WEB_APP , PORT


from .user import user

logger = setup_logger(__name__)

# Global variable to hold the bot manager instance
_bot_manager = None

def get_bot_manager():
    """Return the bot manager instance"""
    global _bot_manager
    return _bot_manager

def start_bot():
    global _bot_manager
    _bot_manager = D4RK_BotManager(
        app_name=APP_NAME,
        api_id=API_ID,
        api_hash=API_HASH,
        tokens=TOKENS,
        plugins={'root': 'src/Telegram/Plugins'},
        max_bots_count=1,
        logger_bot_token=LOGGER_BOT,
        log_chat_id=LOGS,
        database_url=DATABASE_URL,
        database=database,
        owner_id=OWNER,
        web_app_url=WEB_APP,
        web_server=WebServerManager,
        web_server_port=PORT,
        # call_back=start_auto_update_service
    )
    
    try:
        _bot_manager.run_bots()
    except KeyboardInterrupt:
        logger.info("Received KeyboardInterrupt, shutting down...")
        stop_bot()

def stop_bot():
    """Stop the bot manager gracefully"""
    global _bot_manager
    if _bot_manager:
        logger.info("Stopping bot manager...")
        try:
            # If the bot manager has a stop method, call it
            if hasattr(_bot_manager, 'stop'):
                _bot_manager.stop()
            # If the bot manager has a stop_all_bots method, call it
            elif hasattr(_bot_manager, 'stop_all_bots'):
                _bot_manager.stop_all_bots()
            # Stop the user client if it's running
            if user and hasattr(user, 'stop'):
                logger.info("Stopping user client...")
                user.stop()
                
            # Give some time for cleanup
            import time
            time.sleep(1)
        except Exception as e:
            logger.error(f"Error during bot shutdown: {e}")
        finally:
            logger.info("Bot stopped")
    else:
        logger.info("No bot manager to stop")