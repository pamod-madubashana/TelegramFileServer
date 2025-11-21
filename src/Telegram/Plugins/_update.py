# src/Telegram/Plugins/_update.py

import subprocess
import os
import shutil

from pyrogram import Client
from pyrogram.types import Message

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters , command

logger = setup_logger(__name__)

def is_git_available():
    """Check if git is available on the system"""
    try:
        # Try to find git in PATH
        git_path = shutil.which("git")
        if git_path is None:
            return False
        
        # Try to run git command to verify it works
        subprocess.run(["git", "--version"], 
                      stdout=subprocess.DEVNULL, 
                      stderr=subprocess.DEVNULL, 
                      check=True)
        return True
    except (subprocess.SubprocessError, OSError):
        return False

@command(command='update',description='Update bot (Owner only)',Custom_filter=CustomFilters.authorize(sudo=True))
async def update(client: Client, message:Message):
    # Check if git is available
    if not is_git_available():
        await message.reply_text("Git is not available on this system. Cannot perform update.", quote=True)
        return
        
    m = await message.reply_text("Updating...",quote=True)
    with open('restart.txt', 'w') as file:
        file.write(f"{m.chat.id} {m.id}")
    
    try:
        # Get the current git repository path
        repo_path = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], 
                                          stderr=subprocess.STDOUT, text=True).strip()
    except subprocess.CalledProcessError:
        repo_path = os.getcwd()
    
    try:
        # Reset any local changes
        subprocess.run(["git", "reset", "--hard"], cwd=repo_path, check=True,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        logger.error(f"Git reset failed: {e}")
        pass
    
    try:
        # Pull latest changes
        subprocess.run(["git", "pull"], cwd=repo_path, check=True,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        logger.error(f"Git pull failed: {e}")
        pass
    
    try:
        # Update requirements if requirements.txt exists
        requirements_path = os.path.join(repo_path, "requirements.txt")
        if os.path.exists(requirements_path):
            venv_pip = os.path.join(repo_path, ".venv", "bin", "pip")
            if os.path.exists(venv_pip):
                subprocess.run([venv_pip, "install", "-r", "requirements.txt"], 
                              cwd=repo_path, check=True,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(["pip", "install", "-r", "requirements.txt"], 
                              cwd=repo_path, check=True,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        logger.error(f"Requirements installation failed: {e}")
        pass
    
    await m.edit("Updated, now restarting...")
    subprocess.run(["/usr/local/bin/prime", "restart"], cwd=repo_path)