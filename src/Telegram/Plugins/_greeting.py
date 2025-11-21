# src/Telegram/Plugins/_greeting.py

from pyrogram import Client, filters
from pyrogram.types import Message, ChatMemberUpdated

from d4rk.Utils import round_robin
from d4rk.Logs import setup_logger

from src.Config import WELCOME_MSG, GOODBYE_MSG , OWNER , ADMIN 

logger = setup_logger(__name__)

@Client.on_chat_member_updated()
@round_robin()
async def greeting_function(client: Client, message: ChatMemberUpdated) -> None:
    if message.chat.type.name.lower() == "channel":return
    old_status = str(message.old_chat_member.status.name).lower() if message.old_chat_member else None
    new_status = str(message.new_chat_member.status.name).lower() if message.new_chat_member else None
    try:
        if old_status in ("left", "banned",None) and new_status == "member":
            user = message.new_chat_member.user
            msg = WELCOME_MSG
            if user.id == OWNER:
                await client.promote_chat_member(chat_id=message.chat.id,user_id=user.id,privileges=ADMIN)
        elif old_status in ('member','administrator') and new_status in ("left", "banned",None):
            user = message.old_chat_member.user
            msg = GOODBYE_MSG
        else:
            return
        text = msg.format(user_mention=user.mention, chat_title=message.chat.title)
        m = await client.send_message(chat_id=message.chat.id, text=text)
        await client.delete_message(chat_id=message.chat.id, message_ids=m.id,wait=600)
    except Exception as e:
        logger.error(f"Error in greeting function: {e}")

@Client.on_message(filters.group & (filters.new_chat_members | filters.left_chat_member | filters.pinned_message) )
@round_robin()
async def delete_system_messages(client: Client, message: Message) -> None:
    await message.delete()