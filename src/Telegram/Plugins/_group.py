# src/Telegram/Plugins/_group.py

from pyrogram import Client, utils
from pyrogram.types import Message, ChatPermissions , ChatPrivileges
from datetime import datetime, timedelta

from d4rk.Utils import CustomFilters , command
from d4rk.Logs import setup_logger

logger = setup_logger(__name__)

@command(command="mute", description="Mute the group (Admin only)",Custom_filter=CustomFilters.authorize(sudo=True,admin=True,permission="can_restrict_members"))
async def mute_command(client: Client, message: Message) -> Message | None:
    chat = await client.get_chat(message.chat.id)
    current_permissions = chat.permissions
    if current_permissions and current_permissions.can_send_messages == False:
        return await message.reply("Group is already in mute mode.")
    m = await message.reply("Changing group status to mute mode...")
    await client.set_chat_permissions(message.chat.id, permissions=ChatPermissions(all_perms=False))
    await m.edit("Group status changed to mute mode!")

@command(command="unmute", description="Unmute the group (Admin only)",Custom_filter=CustomFilters.authorize(sudo=True,admin=True,permission="can_restrict_members"))
async def unmute_command(client: Client, message: Message) -> Message | None:
    chat = await client.get_chat(message.chat.id)
    current_permissions = chat.permissions
    if current_permissions and current_permissions.can_send_messages == True:
        return await message.reply("Group is already in unmute mode.")
    m = await message.reply("Changing group status to unmute mode...")
    await client.set_chat_permissions(message.chat.id, permissions=ChatPermissions(all_perms=True))
    await m.edit("Group status changed to unmute mode!")

@command(command="ban", description="Ban a user from the group (Admin only)",Custom_filter=CustomFilters.authorize(sudo=True,admin=True,permission="can_restrict_members"))
async def ban_command(client: Client, message: Message) -> Message | None:
    tz = client.TZ
    m = await message.reply("Banning user...")
    if not message.reply_to_message:
        return await m.edit("Reply to a user to ban them.")
    
    # Check if the replied message has a valid user
    if not message.reply_to_message.from_user:
        return await m.edit("Cannot ban: The replied message has no user information (might be from a channel, deleted account, or anonymous admin).")
    
    user = message.reply_to_message.from_user
    until_date = utils.zero_datetime()
    try:
        cmd_parts = message.text.split('-')
        now = datetime.now(tz)
        for part in cmd_parts:
            if part.startswith("m"):
                try:
                    minutes = int(part[2:])
                    until_date = now + timedelta(minutes=minutes)
                except ValueError:pass
            elif part.startswith("h"):
                try:
                    hours = int(part[2:])
                    until_date = now + timedelta(hours=hours)
                except ValueError:pass 
            elif part.startswith("d"):
                try:
                    days = int(part[2:])
                    until_date = now + timedelta(days=days)
                except ValueError:pass

        await client.ban_chat_member(chat_id=message.chat.id,user_id=user.id,until_date=until_date)
        time_msg = ''
        if until_date and 'days' in locals():time_msg += f"{days} day(s)"
        if until_date and 'hours' in locals():time_msg += f"{hours} hour(s)"
        if until_date and 'minutes' in locals():time_msg += f"{minutes} minute(s)"
        time_msg += f"\nUntil {until_date.astimezone(tz).strftime('%Y-%m-%d %H:%M:%S')}"
        await m.edit(f"✅ User banned for {time_msg}!")

    except Exception as e:
        logger.error(f"Error in ban command: {e}")
        await message.reply("❌ Failed to ban user.")

@command(command="promote", description="Promote a user to admin (Admin only)",Custom_filter=CustomFilters.authorize(sudo=True,admin=True,permission='can_promote_members'))
async def promote_command(client: Client, message: Message) -> Message | None:
    if message.reply_to_message:
        # Check if the replied message has a valid user
        if not message.reply_to_message.from_user:
            return await message.reply("Cannot promote: The replied message has no user information (might be from a channel, deleted account, or anonymous admin).")
        user = message.reply_to_message.from_user
    elif len(message.command) > 1:
        username = message.command[1].lstrip('@')
        user = await client.get_users(username)
    else:
        return await message.reply("Please provide a username to promote.")
    try:
        privileges = ChatPrivileges(can_manage_chat=True,can_delete_messages=True,can_restrict_members=True,can_invite_users=True,can_pin_messages=True)
        await client.promote_chat_member(chat_id=message.chat.id,user_id=user.id,privileges=privileges,title="Admin")
        await message.reply(f"✅ User {user.mention} promoted successfully!")
    except Exception as e:
        logger.error(f"Error in promote command: {e}")
        await message.reply("❌ Failed to promote user.")

@command(command="demote", description="Demote a user from admin (Admin only)",Custom_filter=CustomFilters.authorize(sudo=True,admin=True,permission='can_promote_members'))
async def demote_command(client: Client, message: Message) -> Message | None:
    if message.reply_to_message:
        # Check if the replied message has a valid user
        if not message.reply_to_message.from_user:
            return await message.reply("Cannot demote: The replied message has no user information (might be from a channel, deleted account, or anonymous admin).")
        user = message.reply_to_message.from_user
    elif len(message.command) > 1:
        username = message.command[1].lstrip('@')
        logger.info(f"username: {username}")
        user = await client.get_users(username)

    else:
        return await message.reply("Please provide a username to promote.")
    try:
        privileges = ChatPrivileges(
            can_manage_chat=False,
            can_delete_messages=False,
            can_restrict_members=False,
            can_invite_users=False,
            can_pin_messages=False,  
            )
        await client.promote_chat_member(chat_id=message.chat.id,user_id=user.id,privileges=privileges)
        await message.reply(f"✅ User {user.mention} demoted successfully!")
    except Exception as e:
        logger.error(f"Error in demote command: {e}")
        await message.reply("❌ Failed to demote user.")