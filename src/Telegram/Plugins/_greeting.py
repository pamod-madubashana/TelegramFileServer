# src/Telegram/Plugins/_greeting.py

from pyrogram import Client, filters
from pyrogram.types import Message, ChatMemberUpdated , CallbackQuery

from d4rk.Utils import round_robin , ButtonMaker , button
from d4rk.Logs import setup_logger

from src.Database import database
from src.Config import WELCOME_MSG, GOODBYE_MSG , OWNER , ADMIN 

logger = setup_logger(__name__)

@Client.on_chat_member_updated()
@round_robin()
async def greeting_function(client: Client, message: ChatMemberUpdated) -> None:
    if message.new_chat_member.user.id == client.me.id:
        bt = ButtonMaker()
        bt.ibutton("Ok","make_index","header")
        bt.ibutton("Cancel","cancel_index","header")
        keyboard = bt.build_menu()
        await client.send_message(chat_id=message.chat.id, text="Make this chat as Index chat ?", reply_markup=keyboard)
    else:
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

@button(pattern="make_index")
async def make_index(client: Client, callback_query: CallbackQuery) -> None:
    await callback_query.message.edit("♻️")
    user = callback_query.from_user
    user_data = database.Users.get_user_by_telegram_id(user.id)
    if not user_data:
        return await callback_query.message.edit("User not found")
    else:
        try:
            username = user_data.get("username")
            if username:
                    # Update the user's index_chat_id
                    database.Users.update_one(
                        {"username": username},
                        {"$set": {"index_chat_id": callback_query.message.chat.id}},
                        upsert=True
                    )
                    
                    # Send a confirmation message to the group
                    await callback_query.message.edit(
                        f"✅ Thank you for adding me to <b>{callback_query.message.chat.title}</b>!\n\n"
                        f"This group will now be used for indexing your files.\n"
                        f"You can start using the file server features now."
                    )
                    
                    logger.info(f"Bot added to group {callback_query.message.chat.id} ({callback_query.message.chat.title}) by user {username} ({user.mention}). Set as index chat.")
        except Exception as e:
            logger.error(f"Error in bot_added_to_group_handler: {e}")



@button(pattern="cancel_index")
async def cancel_index(client: Client, callback_query: CallbackQuery) -> None:
    await callback_query.message.delete()