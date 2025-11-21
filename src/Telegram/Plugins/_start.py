# src/Telegram/Plugins/_start.py

import random

from pyrogram import Client, filters 
from pyrogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton

from d4rk.Logs import setup_logger
from d4rk.Utils import command , get_commands , button , ButtonMaker

from src.Database import database
from src.Config import START_MSG, START_IMGS , INFO_MSG

logger = setup_logger(__name__)

@command(command="start", description="Start the bot")
async def start_command(client: Client, message: Message) -> None:
    bt = ButtonMaker()
    try:
        await message.react("🔥")
        data = message.command
        if len(data) > 1:
            data = data[1]
            file = database.Movies.get_movie_file_by_id(data)
            if file:
                for f in file.file_data:
                    await client.copy_message(message.chat.id, f.chat_id, f.message_id)
                await client.send_message(chat_id=message.chat.id, text=INFO_MSG.format(user_mention=message.from_user.mention),disable_web_page_preview=True)
            else:
                await message.reply("File not found")
        else:
            logger.info('start command executed')
            user = message.from_user
            bt.ibutton("Help", f'rf:s:{user.id}',"header")
            bt.ibutton("About", f'abt:{user.id}',"header")
            keyboard = bt.build_menu()
            
            if message.from_user.is_self:
                return
            start_image = random.choice(START_IMGS)
            caption = START_MSG.format(user_mention=message.from_user.mention)
            try:
                if message.chat.type.name.lower() == "private":
                    database.Users.SaveUser(message.from_user.id)
                    message_effect_id=5104841245755180586
                else:
                    message_effect_id=None
                    database.Chats.SaveChat(message.chat.id)

                await message.reply_photo(photo=start_image,caption=caption,reply_markup=keyboard,quote=True,message_effect_id=message_effect_id)

            except Exception as e:
                logger.error(f"Failed to send message via API: {e}")
                await message.reply("An error occurred while processing your request.")
                
        await client.delete_message(chat_id=message.chat.id, message_ids=message.id,wait=10)
            
    except Exception as e:
        logger.error(f"Error in start command: {e}")
        await message.reply_text("An error occurred while processing your request.")


async def start_callback_handler(client: Client, callback_query: CallbackQuery) -> None:
    bt = ButtonMaker()
    try:
        user = callback_query.from_user
        bt.ibutton("Help", f'rf:s:{user.id}',"header")
        bt.ibutton("About", f'abt:{user.id}',"header")
        keyboard = bt.build_menu()
        
        await callback_query.edit_message_caption(caption=START_MSG.format(user_mention=user.mention),reply_markup=keyboard)
    except Exception as e:
        logger.error(f"Error in start callback handler: {e}")
        await callback_query.answer("An error occurred!")


@button(pattern="rf:s:")
async def help_callback(client: Client, callback_query: CallbackQuery) -> None:
    bt = ButtonMaker()
    try:
        user_id = int(callback_query.data.split(':')[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return
        commands  = get_commands()
        help_text = "🤖 <b>Available Commands:</b>\n\n"
        for command in commands:
            help_text += f"/{command['command']} - {command['description']}\n"
        bt.ibutton("← Back", f'b2s:{user_id}')
        keyboard = bt.build_menu()
        await callback_query.edit_message_caption(caption=help_text.format(owner='@pamod_madubashana'),reply_markup=keyboard)
        
    except Exception as e:
        logger.error(f"Error in help callback: {e}")
        await callback_query.answer("An error occurred!")

@button(pattern="b2s:")
async def back_callback(client: Client, callback_query: CallbackQuery) -> None:
    """Handle back to start callback"""
    logger.info("back to start")
    try:
        user_id = int(callback_query.data.split(':')[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return
        await start_callback_handler(client, callback_query)
    except Exception as e:
        logger.error(f"Error in back callback: {e}")
        await callback_query.answer("An error occurred!")

@button(pattern="abt:")
async def about_callback(client: Client, callback_query: CallbackQuery) -> None:
    bt = ButtonMaker()
    try:
        user_id = int(callback_query.data.split(':')[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return
        bot_name = (await client.get_me()).first_name
        about_text = """
🤖 <b>About This Bot:</b>

This is {bot_name} - Your assistant for various tasks.

🔧 <b>Version:</b> 1.0
👨‍💻 <b>Developer:</b> {dev}
🌐 <b>designer:</b> {design}

"""     
        bt.ibutton("← Back", f'b2s:{user_id}')
        keyboard = bt.build_menu()
        
        dev_mention = "<a href='tg://user?id=7859877609'>P A M O D [⁧[⚡</a>"
        designe_mention = "<a href='tg://user?id=6606196960'>Randi33p</a>"
        await callback_query.edit_message_caption(caption=about_text.format(bot_name=bot_name,dev=dev_mention,design=designe_mention),reply_markup=keyboard)
        
    except Exception as e:
        logger.error(f"Error in about callback: {e}")
        await callback_query.answer("An error occurred!")