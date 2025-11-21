# src/Telegram/Plugins/_group.py

from typing import Literal
import asyncio

from pyrogram import Client, filters
from pyrogram.types import Message, CallbackQuery, InlineKeyboardMarkup , InlineKeyboardButton

from pyrogram.errors import (
    PhoneNumberInvalid,
    PhoneCodeInvalid,
    PhoneCodeExpired,
    SessionPasswordNeeded,
    PasswordHashInvalid
)

from d4rk.Utils import CustomFilters , command , button
from d4rk.Logs import setup_logger

from src.Config import API_ID, API_HASH
from src.Database import database

class UserSignUp(Client):
    def __init__(self):
        super().__init__(
            "Serandip-admin",
            api_id=API_ID,
            api_hash=API_HASH,
            in_memory=True
        )
    async def connect_user(self,phone_number: str) -> Literal[True] | None:  
        await super().connect()
        try:
            self.phone_number = phone_number
            self.code = await super().send_code(phone_number=phone_number)
            return True
        except PhoneNumberInvalid:
            return None

    async def sign_in_user(self,code) -> bool | None:
        try:
            await super().sign_in(self.phone_number,self.code.phone_code_hash,code)
            return True
        except (PhoneCodeInvalid,PhoneCodeExpired):
            return None
        except SessionPasswordNeeded:
            return False
        
    async def sign_in_with_password(self,password: str) -> bool | None:
        try:
            await super().check_password(password=password)
            return True
        except PasswordHashInvalid: return None

    async def export_session(self) -> str:  
        return await super().export_session_string()

    async def disconnect_user(self):
        return await super().disconnect()

logger = setup_logger(__name__)

userBot = UserSignUp()
def keyboard(type:str):

    return [[InlineKeyboardButton("1", callback_data=f"{type}:1"), InlineKeyboardButton("2", callback_data=f"{type}:2"),InlineKeyboardButton("3", callback_data=f"{type}:3")],
            [InlineKeyboardButton("4", callback_data=f"{type}:4"), InlineKeyboardButton("5", callback_data=f"{type}:5"),InlineKeyboardButton("6", callback_data=f"{type}:6")],
            [InlineKeyboardButton("7", callback_data=f"{type}:7"), InlineKeyboardButton("8", callback_data=f"{type}:8"),InlineKeyboardButton("9", callback_data=f"{type}:9")],
            [InlineKeyboardButton("<-", callback_data=f"{type}:erase"),InlineKeyboardButton("0", callback_data=f"{type}:0"),InlineKeyboardButton("Done ✅", callback_data=f"{type}:done")],
            [InlineKeyboardButton("Cancel", callback_data=f"{type}:cancel")]]

@command(command="sign", description="Sign up as a user (Sudo only)",Custom_filter=CustomFilters.authorize(sudo=True))
async def sign_command(client: Client, message: Message):
    if message.chat.type.name.lower() != "private":
        return await message.reply("This command can only be used in private chats.")
    
    await message.reply("Enter your phone number:", reply_markup=InlineKeyboardMarkup(keyboard("num")))


@button(pattern="num:")
async def click_on_numpad(client: Client, callback_query: CallbackQuery):
    data = callback_query.data.split(":")
    try:
        number = data[1]
        text = callback_query.message.text.split('\n')[0]
        phone = callback_query.message.text.split('\n')[-1]
        if text == phone:
            phone = "+"
        if number == "cancel":
            await callback_query.answer("Canceled", show_alert=True)
            return await callback_query.message.delete()
        elif number == "done":
            
            await callback_query.edit_message_text("Code sent to your phone number, enter it below:\n\n<blockquote>* * * * *</blockquote>", reply_markup=InlineKeyboardMarkup(keyboard("code")))
            code = await userBot.connect_user(phone)
            if not code:
                await callback_query.answer("Invalid phone number", show_alert=True)
                await callback_query.edit_message_text("Enter your phone number:", reply_markup=InlineKeyboardMarkup(keyboard("num")))
                return
            return 

        if len(phone)!=12:
            if number == "erase":
                phone = phone[:-1]
            else:
                phone = phone + number
            await callback_query.edit_message_text(text=f"{text}\n\n<blockquote>{phone}</blockquote>", reply_markup=InlineKeyboardMarkup(keyboard("num")))

    except Exception as e:
        logger.error("Error : " + str(e))

@button(pattern="code:")
async def click_on_numpad_otp(client: Client, callback_query: CallbackQuery):
    data = callback_query.data.split(":")
    try:
        total_length = 5
        number = data[1]
        text = callback_query.message.text.split('\n')[0]
        preview = callback_query.message.text.split('\n')[-1]
        if text == preview:
            preview = "* * * * *"
        try:code = str(''.join(preview.split(" ")).replace("*", ""))
        except:code = ''
        if number == "cancel":
            await callback_query.answer("Canceled", show_alert=True)
            return await callback_query.message.delete()
        
        elif number == "done":
            r = await userBot.sign_in_user(code)
            if r is True:
                await callback_query.answer("Successfully signed up", show_alert=True)
                sesstion = await userBot.export_session()
                m = await client.send_message(chat_id=callback_query.message.chat.id,text="Successfully signed up")
                database.Settings.set('session',sesstion)
                await m.edit("Session exported successfully")
                await asyncio.sleep(3)
                await m.delete()
                await userBot.disconnect_user()
                return
            elif r is False:
                await callback_query.message.delete()
                password = await client.ask(chat_id=callback_query.message.chat.id,text="Enter your password:",filters=filters.text, timeout=300)
                await password.delete()
                await password.sent_message.delete()
                p = await userBot.sign_in_with_password(password.text)
                if p is True:
                    m = await client.send_message(chat_id=callback_query.message.chat.id,text="Successfully signed up")
                    sesstion = await userBot.export_session()
                    database.Settings.set('session',sesstion)
                    await m.edit("Session exported successfully")
                    await asyncio.sleep(3)
                    await m.delete()
                    await userBot.disconnect_user()

                    return
                return
            else:
                await callback_query.answer("Code invalid or Expired !", show_alert=True)
                await callback_query.message.delete()
        if len(code)!=5:
            if number == "erase":
                code = code[:-1]
            else:
                code = code + number
            preview = " ".join(list(code) + ["*"] * (total_length - len(code)))
            await callback_query.edit_message_text(text=f"{text}\n\n<blockquote>{preview}</blockquote>", reply_markup=InlineKeyboardMarkup(keyboard("code")))

    except Exception as e:
        logger.error("Error : " + str(e))
