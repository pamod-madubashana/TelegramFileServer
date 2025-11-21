#__main__.py
import asyncio
import signal
import sys
import subprocess
import os
from d4rk.Logs import setup_logger
from src.Telegram import start_bot, stop_bot
from src.Config import APP_NAME


logger = setup_logger(APP_NAME)

# Global variables
bot_manager = None
loop = None
auto_update_task = None

def signal_handler(signum, frame):
    """Handle shutdown signals gracefully"""
    logger.info(f"Received signal {signum}, shutting down gracefully...")
    
    # Stop the auto-update service
    global auto_update_task
    if auto_update_task:
        auto_update_task.cancel()
    
    # Call the stop_bot function for proper shutdown
    try:
        stop_bot()
    except Exception as e:
        logger.error(f"Error during bot shutdown: {e}")
    
    # Stop the event loop gracefully
    global loop
    if loop and loop.is_running():
        logger.info("Stopping event loop gracefully...")
        # Schedule the loop to stop on the next iteration
        loop.call_soon_threadsafe(loop.stop)
        
        # Give some time for tasks to complete
        try:
            # Run the loop once more to process any pending tasks
            loop.run_until_complete(asyncio.sleep(0.1))
        except:
            pass
    
    logger.info("Shutdown complete")
    sys.exit(0)

def main():
    
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    
    # Store the event loop
    global loop
    loop = asyncio.get_event_loop()
    
    logger.info(f"Starting {APP_NAME}...")
    
    global bot_manager
    from src.Telegram.bot import get_bot_manager
    bot_manager = get_bot_manager()
    
    try:
        start_bot()
    except KeyboardInterrupt:
        logger.info("Received KeyboardInterrupt, shutting down...")
        signal_handler(signal.SIGINT, None)
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        with open("crash.log", "w") as f:
            import traceback
            traceback.print_exc(file=f)
        print(e.__traceback__)
        signal_handler(signal.SIGTERM, None)

if __name__ == "__main__":
    main()