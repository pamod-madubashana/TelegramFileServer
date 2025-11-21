# src/Telegram/Plugins/_sudo.py

import os
import asyncio
import subprocess

from pyrogram import Client, filters 
from pyrogram.types import Message , ForceReply

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters , command 

from src.Database import database


logger = setup_logger(__name__)


@command(command='auth',description='Authorize a user (Owner only)',Custom_filter=CustomFilters.authorize())
async def auth_command(client: Client, message: Message):
    user = None
    
    if message.entities:
        for entity in message.entities:
            if entity.type.name == 'MENTION' or entity.type.name == 'TEXT_MENTION':
                if entity.type.name == 'TEXT_MENTION' and entity.user:
                    user = entity.user
                    break
                elif entity.type.name == 'MENTION':
                    username = message.text[entity.offset:entity.offset + entity.length].lstrip('@')
                    try:
                        user = await client.get_users(username)
                        break
                    except:
                        continue
    
    if not user:
        if not message.reply_to_message:
            await message.reply_text("Please reply to a message or mention a user.")
            return
        
        if not message.reply_to_message.from_user:
            await message.reply_text("Cannot authorize: The replied message has no user information (might be from a channel, deleted account, or anonymous admin).")
            return
        
        user = message.reply_to_message.from_user
    
    user_id = user.id
    sudo_users_str = database.Settings.get('sudo_users', str) or ''
    sudo_users = sudo_users_str.split(',') if sudo_users_str else []
    
    # Convert user_id to string for comparison (since we store as comma-separated string)
    user_id_str = str(user_id)
    
    if user_id_str in sudo_users:
        await message.reply_text("User is already authorized.")
        return
    
    sudo_users.append(user_id_str)
    database.Settings.set('sudo_users', ','.join(sudo_users))
    client.sudo_users = sudo_users
    await message.reply_text(f"{user.mention} authorized successfully.")


@command(command='unauth',description='Unauthorize a user (Owner only)',Custom_filter=CustomFilters.authorize())
async def unauth_command(client: Client, message: Message):
    user = None
    if message.entities:
        for entity in message.entities:
            if entity.type.name == 'MENTION' or entity.type.name == 'TEXT_MENTION':
                if entity.type.name == 'TEXT_MENTION' and entity.user:
                    user = entity.user
                    break
                elif entity.type.name == 'MENTION':
                    username = message.text[entity.offset:entity.offset + entity.length].lstrip('@')
                    try:
                        user = await client.get_users(username)
                        break
                    except:
                        continue
    
    if not user:
        if not message.reply_to_message:
            await message.reply_text("Please reply to a message or mention a user.")
            return
        
        if not message.reply_to_message.from_user:
            await message.reply_text("Cannot unauthorize: The replied message has no user information (might be from a channel, deleted account, or anonymous admin).")
            return
        
        user = message.reply_to_message.from_user
    
    user_id = user.id
    sudo_users_str = database.Settings.get('sudo_users', str) or ''
    sudo_users = sudo_users_str.split(',') if sudo_users_str else []
    user_id_str = str(user_id)
    
    if user_id_str in sudo_users:
        sudo_users.remove(user_id_str)
        database.Settings.set('sudo_users', ','.join(sudo_users))
        client.sudo_users = sudo_users
        await message.reply_text(f"{user.mention} unauthorized successfully.")
        return
    await message.reply_text("User is not authorized.")


@Client.on_message(filters.command("cmd") & CustomFilters.authorize())
async def cmd_command(client: Client, message: Message):
    asyncio.create_task(run_shell_task(client, message))

async def run_shell_task(client:Client, message: Message):
    result = None
    default_path = "root@serandip:~/Telegram/Bots/Serandip-prime#"
    def get_path():
        try:
            cwd = os.getcwd()
        except Exception:
            try:
                cwd = subprocess.check_output("pwd", shell=True, stderr=subprocess.STDOUT, text=True).strip()
            except subprocess.CalledProcessError:
                return default_path
        if cwd:
            return f"{cwd.replace('/root/', 'root@serandip:~/')}#"
        return default_path
    output = ""
    while True:
        if output == "":
            command = await client.ask(message.chat.id, f"Enter command:\n<pre language='bash'>{get_path()}</pre>", reply_markup=ForceReply(True))
        else:
            command = await client.ask(message.chat.id, f"<pre language='bash'>{"\n".join(output.splitlines()[-20:])}\n{get_path()}</pre>", reply_markup=ForceReply(True,"Enter command:"))
        cmd = command.text
        if cmd == "exit":
            break
        try:
            result = subprocess.check_output(
                cmd,
                shell=True,
                stderr=subprocess.STDOUT,
                text=True,
                executable="/bin/bash",
                env={**os.environ, "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
            )
        except subprocess.CalledProcessError as e:
            result = e.output

        if len(result) > 4000:
            result = result[:4000] + "\n...truncated..."
        output += f"\n\n{get_path()}{cmd}\n{result}"
    await message.reply("Exited shell.")
