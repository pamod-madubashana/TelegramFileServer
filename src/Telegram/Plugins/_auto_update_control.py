# src/Telegram/Plugins/_auto_update_control.py

import shutil
import subprocess

from pyrogram import Client
from pyrogram.types import Message

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters, command
from src.Models import auto_updater, check_for_updates_now

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

@command(command='autoupdate', description='Manage auto-update settings (Owner only)', 
         Custom_filter=CustomFilters.authorize(sudo=True))
async def auto_update_control(client: Client, message: Message):
    """Command to control auto-update settings"""
    # Check if git is available
    if not is_git_available():
        await message.reply_text("Git is not available on this system. Auto-update features are disabled.", quote=True)
        return
        
    args = message.text.split()[1:] if len(message.text.split()) > 1 else []
    
    if not args:
        # Show current status
        status = "enabled" if auto_updater.enabled else "disabled"
        interval_hours = auto_updater.check_interval / 3600
        last_check = auto_updater.last_update_check.strftime("%Y-%m-%d %H:%M:%S") if auto_updater.last_update_check else "Never"
        
        response = f"""Auto-update Status:
- Status: {status}
- Check Interval: {interval_hours} hours
- Last Check: {last_check}
        
Commands:
/autoupdate enable - Enable auto-update
/autoupdate disable - Disable auto-update
/autoupdate interval <hours> - Set check interval (1-24 hours)
/autoupdate check - Check for updates now
/autoupdate update - Force update now"""
        
        await message.reply_text(response, quote=True)
        return
    
    action = args[0].lower()
    
    if action == "enable":
        auto_updater.enabled = True
        auto_updater.start_auto_update_task()
        await message.reply_text("Auto-update enabled.", quote=True)
        
    elif action == "disable":
        auto_updater.enabled = False
        auto_updater.stop_auto_update_task()
        await message.reply_text("Auto-update disabled.", quote=True)
        
    elif action == "interval":
        if len(args) < 2:
            await message.reply_text("Please specify interval in hours: /autoupdate interval <hours>", quote=True)
            return
            
        try:
            hours = float(args[1])
            if hours < 1 or hours > 24:
                await message.reply_text("Interval must be between 1 and 24 hours.", quote=True)
                return
                
            auto_updater.check_interval = int(hours * 3600)
            await message.reply_text(f"Auto-update interval set to {hours} hours.", quote=True)
        except ValueError:
            await message.reply_text("Invalid interval. Please specify a number.", quote=True)
            
    elif action == "check":
        try:
            if auto_updater.check_for_updates():
                await message.reply_text("Updates are available. Use /autoupdate update to apply them.", quote=True)
            else:
                await message.reply_text("No updates available.", quote=True)
        except Exception as e:
            await message.reply_text(f"Error checking for updates: {e}", quote=True)
            
    elif action == "update":
        try:
            await message.reply_text("Checking for updates...", quote=True)
            result = await check_for_updates_now()
            if not result:
                await message.reply_text("Update failed.", quote=True)
        except Exception as e:
            await message.reply_text(f"Error during update: {e}", quote=True)
    else:
        await message.reply_text("Unknown action. Use /autoupdate for help.", quote=True)