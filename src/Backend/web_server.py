# src/Backend/web_server.py

from typing import Literal, Optional
from pyrogram import Client
import asyncio
import uvicorn
import logging
import subprocess
import os
import sys

from d4rk.Logs import setup_logger
from d4rk.Utils import get_public_ip, check_public_ip_reachable

# Try to import D4RK_BotManager, but make it optional
try:
    from d4rk import D4RK_BotManager
except ImportError:
    D4RK_BotManager = None
    
from src.Config import WEB_APP, GOOGLE_CLIENT_ID, PORT

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
        self._frontend_process = None

    def start_frontend(self):
        """Start the frontend development server"""
        try:
            # Get the absolute path to the frontend directory
            # Assuming src/Backend/web_server.py -> src/Frontend
            current_dir = os.path.dirname(os.path.abspath(__file__))
            root_dir = os.path.dirname(os.path.dirname(current_dir))  # src/Backend -> src -> root
            frontend_dir = os.path.join(root_dir, "src", "Frontend")
            
            if not os.path.exists(frontend_dir):
                logger.error(f"Frontend directory not found at {frontend_dir}")
                return

            logger.info(f"Starting frontend from {frontend_dir}...")
            
            # Use npm run dev
            # On Windows, shell=True is often needed for npm
            is_windows = sys.platform.startswith('win')
            npm_cmd = "npm.cmd" if is_windows else "npm"
            
            self._frontend_process = subprocess.Popen(
                [npm_cmd, "run", "dev"],
                cwd=frontend_dir,
                shell=is_windows,  # shell=True for Windows to find npm
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            logger.info(f"Frontend started with PID {self._frontend_process.pid}")
            
        except Exception as e:
            logger.error(f"Failed to start frontend: {e}")

    async def setup_web_server(self, preferred_port=None) -> Literal[True] | Literal[False]:
        try:
            # Use PORT from config if preferred_port is not provided
            self._web_port = preferred_port if preferred_port is not None else PORT
            
            # Start frontend
            self.start_frontend()
            
            logger.info(f"Starting FastAPI server on port {self._web_port}...")

            # Initialize FastAPI app
            self._web_app = await _web_server(self._bot_manager)

            # Configure Uvicorn server with custom logging (programmatic launch)
            config = uvicorn.Config(
                self._web_app,
                host="0.0.0.0",
                port=self._web_port,
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
                    logger.info(f"Web app is running on http://localhost:{self._web_port}")
                else:
                    logger.info(f"Web app is running on {WEB_APP}")
            else:
                my_ip = get_public_ip()
                if my_ip and await check_public_ip_reachable(my_ip):
                    logger.info(f"Web app running on http://{my_ip}:{self._web_port}")
                else:
                    logger.info(f"Web app running on http://localhost:{self._web_port}")

            return True

        except Exception as e:
            logger.error(f"Failed to setup FastAPI server: {e}")
            return False

    async def cleanup(self) -> None:
        try:
            if self._server and self._server.should_exit is False:
                self._server.should_exit = True
                logger.info("FastAPI web server stopped")
            
            # Stop frontend process
            if self._frontend_process:
                logger.info("Stopping frontend process...")
                try:
                    # Try to import psutil for better process management
                    import psutil
                    parent = psutil.Process(self._frontend_process.pid)
                    for child in parent.children(recursive=True):
                        child.terminate()
                    parent.terminate()
                except ImportError:
                    # If psutil is not available, just terminate the main process
                    self._frontend_process.terminate()
                except Exception as e:
                    logger.error(f"Error killing frontend process tree: {e}")
                    self._frontend_process.terminate()
                
                self._frontend_process = None
                logger.info("Frontend process stopped")
                
        except Exception as e:
            logger.error(f"Error during FastAPI cleanup: {e}")

# Add a standalone function to run just the web server
async def run_standalone_web_server():
    """Run just the web server without the Telegram bot"""
    # Create a mock bot manager for standalone mode to avoid errors
    class MockBotManager:
        def __init__(self):
            self.clients = []
            self.client_list = []
            
        def get_least_busy_client(self):
            return None
            
        def get_workload(self):
            return 0
    
    web_manager = WebServerManager(MockBotManager())
    await web_manager.setup_web_server()
    
    # Keep the server running
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        logger.info("Received KeyboardInterrupt, shutting down...")
        await web_manager.cleanup()

if __name__ == "__main__":
    # Run the standalone web server
    asyncio.run(run_standalone_web_server())