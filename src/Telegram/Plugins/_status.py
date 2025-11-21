import os
import psutil
import shutil
import platform
import datetime
from pyrogram import Client
from pyrogram.types import Message
from d4rk.Utils import round_robin , CustomFilters , command

start_time = datetime.datetime.now()

def get_vps_status():
    uptime_seconds = (datetime.datetime.now() - start_time).total_seconds()
    uptime_str = str(datetime.timedelta(seconds=int(uptime_seconds)))
    os = f"{platform.system()} {platform.release()}"
    cpu_usage = psutil.cpu_percent(interval=1)
    mem = psutil.virtual_memory()
    ram_usage = mem.percent
    swap = psutil.swap_memory()
    swap_usage = swap.percent
    total, used, free = shutil.disk_usage("/")
    free_storage = free / (1024 ** 3)  # Convert bytes to GB

    return f"""🖥️ <b>VPS Status</b>
• OS: {os}
• Uptime: {uptime_str}
• CPU: {cpu_usage:.1f}%
• RAM: {ram_usage:.1f}%
• SWAP: {swap_usage:.1f}%
• FREE: {free_storage:.2f}GB
"""


@command("status", description="Get bots and VPS status", Custom_filter=CustomFilters.authorize(sudo=True))
@round_robin()  # only one bot answers in groups
async def status_handler(client: Client, message:Message):
    # Bot info
    me = await client.get_me()
    bot_status = f"""
🤖 <b>Bot Status</b>
• Name: {me.first_name}
• Username: @{me.username}
• ID: <code>{me.id}</code>
• Status: ✅ Online"""

    vps_status = get_vps_status()

    await message.reply_text(bot_status + "\n\n" + vps_status, quote=True)
