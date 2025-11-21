
import asyncio

from pyrogram import Client
from pyrogram.types import Message

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters, command  , ButtonMaker 
from src.Config import OWNER , TOKENS
from src.Telegram.UserPlugins import ChannelCreater
from src.Telegram.user import user

logger = setup_logger(__name__)

@command(command="test", description="test command" ,Custom_filter=CustomFilters.authorize())
async def test_command(client: Client, message: Message):
    channel_creater = ChannelCreater(user)
    msgs = []
    m = await message.reply("Testing Channel Creation and Member Addition...")
    msgs.append(m)
    await channel_creater.create_channel("test_channel")
    await m.edit("Channel Created Successfully!")
    m = await message.reply("Adding Members...")
    msgs.append(m)
    await channel_creater.add_members([OWNER])
    await m.edit("Members Added Successfully!")
    m = await message.reply("Promoting Members...")
    msgs.append(m)
    user_ids = [OWNER]
    for i in TOKENS:
        user_ids.append(i.split(":")[0])
    await channel_creater.promote_channel_members(user_ids)
    await m.edit("Members Promoted Successfully!")
    await asyncio.sleep(5)
    for msg in msgs:
        await msg.delete()
    

    