# src/Telegram/Plugins/_file_manager.py

import re
import asyncio

from pyrogram.types import Message , CallbackQuery
from pyrogram import Client, filters

from src.Config import FILTER_CHAT
from src.Database import database
from src.Models import movie_details
from src.Dataclass import MongoMovie , MongoImdb , MongoMovieFile , Resolution , FileData

from d4rk.Logs import setup_logger
from d4rk.Utils import parser , round_robin , button , ButtonMaker

logger = setup_logger(__name__)

file_queue = asyncio.Queue()
semaphore = asyncio.Semaphore(1)
worker_running = False

async def send_error(client: Client,message: Message,e: Exception= None):
    bt = ButtonMaker()
    try:
        bt.ibutton("Try again", 'ta:file')
        keyboad = bt.build_menu()
        if e is not None:caption = message.caption + "\n\n" +f"<blockquote>Error : {str(e)}\n{message.link}</blockquote>"
        else:caption = message.caption + "\n\n" +f"<blockquote>Movie Details not found\n{message.link}</blockquote>"
        await message.copy(chat_id=-1002818538707,caption=caption,reply_markup=keyboad)
        try:await client.delete_messages(chat_id=message.chat.id,message_ids=message.id)
        except Exception as e:
            logger.error(f"Failed to delete message {message.id}: {e}")
    except:pass

@Client.on_message((filters.document | filters.video) & filters.chat(FILTER_CHAT))
@round_robin()
async def handle_file(client: Client, message: Message) -> None:
    global worker_running
    await file_queue.put(message)
    logger.info(f"Queued file from message {message.id}")
    if worker_running is False:
        worker_running = True
        asyncio.create_task(file_worker(client))

async def file_worker(client) -> None:
    global worker_running
    while worker_running:
        if file_queue.empty():
            worker_running = False
            break
        message = await file_queue.get()
        async def job() -> None:
            async with semaphore:
                try:await handle_filter_file_task(client,message)
                except Exception as e:logger.error(f"Worker error: {e}")
                finally:file_queue.task_done()
        await asyncio.sleep(10)
        asyncio.create_task(job())

async def handle_filter_file_task(client: Client,message: Message):
    pass