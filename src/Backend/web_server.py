# src/Web/web_server.py

from typing import Literal, Optional
from pyrogram import Client
import uvicorn
import logging

from d4rk.Logs import setup_logger
from d4rk.Utils import get_public_ip, check_public_ip_reachable

# Try to import D4RK_BotManager, but make it optional
try:
    from d4rk import D4RK_BotManager
except ImportError:
    D4RK_BotManager = None
    
from src.Config import WEB_APP, GOOGLE_CLIENT_ID

# Log the Google Client ID for debugging (remove this in production)
logger = setup_logger(__name__)
logger.info(f"Google Client ID from config: {GOOGLE_CLIENT_ID}")

from .routes.web import _web_server  # should return FastAPI instance

logger = setup_logger(__name__)

class WebServerManager:
    def __init__(self, bot_manager = None) -> None:
        self._bot_manager = bot_manager
        self._web_app = None
        self._server = None
        self._web_port = None

    async def setup_web_server(self, preferred_port=8000) -> Literal[True] | Literal[False]:
        try:
            self._web_port = preferred_port
            logger.info(f"Starting FastAPI server on port {preferred_port}...")

            # Initialize FastAPI app
            self._web_app = await _web_server(self._bot_manager)

            # Configure Uvicorn server with custom logging (programmatic launch)
            config = uvicorn.Config(
                self._web_app,
                host="0.0.0.0",
                port=preferred_port,
                log_level="info",
                log_config=None  # This tells Uvicorn to use the existing Python logging configuration
            )
            self._server = uvicorn.Server(config)

            # Run in background
            import asyncio
            loop = asyncio.get_event_loop()
            loop.create_task(self._server.serve())

            # Info output
            if WEB_APP:
                if "localhost" in WEB_APP:
                    logger.info(f"Web app is running on http://localhost:{preferred_port}")
                else:
                    logger.info(f"Web app is running on {WEB_APP}")
            else:
                my_ip = get_public_ip()
                if my_ip and await check_public_ip_reachable(my_ip):
                    logger.info(f"Web app running on http://{my_ip}:{preferred_port}")
                else:
                    logger.info(f"Web app running on http://localhost:{preferred_port}")

            return True

        except Exception as e:
            logger.error(f"Failed to setup FastAPI server: {e}")
            return False

    async def cleanup(self) -> None:
        try:
            if self._server and self._server.should_exit is False:
                self._server.should_exit = True
                logger.info("FastAPI web server stopped")
        except Exception as e:
            logger.error(f"Error during FastAPI cleanup: {e}")