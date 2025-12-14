# src/Backend/routes/system_routes.py

from fastapi import APIRouter, Depends, HTTPException, Request
from ..security.credentials import require_auth, User
from d4rk.Logs import setup_logger
import subprocess
import os
import sys
import re

logger = setup_logger("system_routes")

# Create router with updated prefix
router = APIRouter(prefix="/system", tags=["System"])

# Global variable for workloads (if used by other modules, otherwise just for get_workloads)
# Note: This should ideally be managed at the application level
work_loads = {}

@router.get("/workloads")
async def get_workloads(user: User = Depends(require_auth)):
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
@router.post("/github")
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

# Add new API route for bot information
@router.get("/bots/info")
async def get_bots_info(user: User = Depends(require_auth)):
    try:
        # Note: bot_manager should be accessed from app state in the main application
        # This will be handled in the main web.py file
        return {"bots": [], "logger_bot": None, "workloads": {}}
    except Exception as e:
        return {"bots": [], "logger_bot": None, "workloads": {}, "error": str(e)}

@router.get("/bots/workloads")
async def get_bots_workloads():
    try:
        # Note: bot_manager should be accessed from app state in the main application
        # This will be handled in the main web.py file
        return {
            "bots_available": False, 
            "workloads": {}, 
            "bots_count": 0, 
            "active_bots": 0
        }
    except Exception as e:
        return {
            "bots_available": False, 
            "workloads": {}, 
            "bots_count": 0, 
            "active_bots": 0,
            "error": str(e)
        }