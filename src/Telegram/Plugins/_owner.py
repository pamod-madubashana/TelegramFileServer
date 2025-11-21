# src/Telegram/Plugins/_commands.py

import os
import asyncio
import subprocess

from pyrogram import Client 
from pyrogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton

from datetime import datetime, timezone, timedelta

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters,command , button , get_font

from src.Database import database

logger = setup_logger(__name__)

@command(command="logs", description="Get logs (Owner only)", Custom_filter=CustomFilters.authorize(sudo=True))
async def logs_command(client: Client, message: Message) -> None:
    logger.info(f"Logs command executed by {message.from_user.id} in chat {message.chat.id}")
    m = await message.reply("Fetching logs...")
    try:
        user = message.from_user
        SRI_LANKA_TZ = timezone(timedelta(hours=5, minutes=30))
        sri_lanka_now = datetime.now(SRI_LANKA_TZ)
        file_name = f"logs/log-{sri_lanka_now.strftime('%Y-%m-%d')}.txt"
        if not os.path.exists(file_name):
            await m.edit("No log file found for today.!")
            return
        
        await m.edit("Uploading logs...")
        logger.info(f"User {user.id} requested logs")
        await message.reply_document(file_name)
        await m.edit("Logs uploaded successfully!")
        await asyncio.sleep(1)
        await m.delete()
        
    except Exception as e:
        logger.error(f"Error in logs command: {e}")
        await m.edit("An error occurred while fetching logs.")

@command(command="reboot", description="Reboot the bot (Owner only)",Custom_filter=CustomFilters.authorize(sudo=True))
async def reboot(client: Client, message: Message) -> None:
    m = await message.reply_text("rebooting...",quote=True)
    with open('restart.txt', 'w') as file:
        file.write(f"{m.chat.id} {m.id}")
    result = subprocess.check_output(
                "prime restart",
                shell=True,
                stderr=subprocess.STDOUT,
                text=True,
                executable="/bin/bash",
                env={**os.environ, "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
    )
    await m.edit("Bot Stopped")

@command(command="font", description="Change font style (Owner only)",Custom_filter=CustomFilters.authorize())
async def cange_font(client: Client, message: Message) -> None:
    await message.reply(text="Select a font:", reply_markup=InlineKeyboardMarkup([
        [InlineKeyboardButton(get_font("Font 1",1), callback_data=f"font:1:{message.from_user.id}"),InlineKeyboardButton(get_font("Font 2",2), callback_data=f"font:2:{message.from_user.id}")],
        [InlineKeyboardButton(get_font("Font 3",3), callback_data=f"font:3:{message.from_user.id}"),InlineKeyboardButton(get_font("Font 4",4), callback_data=f"font:4:{message.from_user.id}")],
        [InlineKeyboardButton(get_font("Font 5",5), callback_data=f"font:5:{message.from_user.id}"),InlineKeyboardButton(get_font("Font 6",6), callback_data=f"font:6:{message.from_user.id}")],
        [InlineKeyboardButton("Default", callback_data=f"font:0:{message.from_user.id}")],]))

@button(pattern="font:",CustomFilters=CustomFilters.authorize(sudo=True))
async def font_callback(client: Client, callback_query: CallbackQuery, m=None) -> None:
    data = callback_query.data.split(':')
    font_number = int(data[1])
    database.Settings.set("font", str(font_number))
    logger.info(f"Font changed to {font_number} by user {callback_query.from_user.id}")
    client.font = font_number
    await callback_query.message.edit(
        text=f"Font changed to {font_number}",
        reply_markup=None)