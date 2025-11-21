# src/Telegram/Plugins/_file.py

import asyncio
import re

from typing import Union

from pyrogram.types import  Message , CallbackQuery
from pyrogram import Client, filters

from src.Config import LEECH_SOURCE
from src.Database import database
from src.Models import LeechClient , movie_details , tv_details

from d4rk.Logs import setup_logger
from d4rk.Utils import parser, round_robin ,command , button ,CustomFilters , ButtonMaker


logger = setup_logger(__name__)

file_queue = asyncio.Queue()
semaphore = asyncio.Semaphore(1)
worker_running = False

async def load_queue(client: Client):
    global file_queue , worker_running
    docs = database.Queue.get_queue()
    for doc in docs:
        try:
            msg = await client.get_messages(doc["chat_id"], doc["message_id"])
            await file_queue.put(msg)
            if worker_running is False:
                worker_running = True
                asyncio.create_task(file_worker(client))
        except Exception as e:
            logger.error(f"Failed to restore message {doc['message_id']}: {e}")


@button(pattern="reftasks")
async def reftasks(client: Client, callback_query: CallbackQuery):
    await _monitor_tasks(client, callback_query)

@command(command="tasks",description="view current tasks (Sudo only)",Custom_filter=CustomFilters.authorize(sudo=True))
async def monitor_tasks(client: Client, message: Union[Message,CallbackQuery]) -> None:
    await _monitor_tasks(client, message)

async def _monitor_tasks(client: Client, message: Union[Message,CallbackQuery]) -> None:
    bt = ButtonMaker()
    try:
        if hasattr(message, "data"):
            await message.answer("Refreshing...")
        text = """
=== Task Monitor ===

⌬ Running: {running_tasks_count} 
{running_tasks_str}

⌬ Queued: {queued_tasks_count}
{queued_tasks_str}
"""
        status = LeechClient.get_task_status()
        running_count = int(status.get("count", 0))
        running_tasks = status.get("downloads", [])
  
        queued = list(file_queue._queue)
        queued_count = len(queued)

        running_tasks_str = ""
        queued_tasks_str = ""
        if running_tasks:
            for i, t in enumerate(running_tasks, start=1):
                if i == len(running_tasks):
                    running_tasks_str += f"┗ {i}. {t['status']}ing - {t['name'][:20]}"
                else:
                    running_tasks_str += f"┠ {i}. {t['status']}ing - {t['name'][:20]}\n"
        else:
            running_tasks_str += " - none"

        if queued:
            for i, m in enumerate(queued, start=1):
                file_name = (m.caption.split("\n")[0] or m.document.file_name or m.video.file_name)[:30]
                if i <= 16:
                    if i == len(queued):queued_tasks_str += f"┗ {i}. {file_name}"
                    else:queued_tasks_str += f"┠ {i}. {file_name}\n"
                elif i == 17 and len(queued) > 17: queued_tasks_str += "┠ ----------------------------\n"
                elif i == len(queued): queued_tasks_str += f"┗ {i}. {file_name}\n"

        if running_tasks == [] and queued == []:
            text = "No tasks running or queued."
        bt.ibutton("Refresh", "reftasks")
        keyboard = bt.build_menu()
        text_str = text.format(running_tasks_count=running_count, running_tasks_str=running_tasks_str, queued_tasks_count=queued_count, queued_tasks_str=queued_tasks_str)
        try:
            if hasattr(message, "data"):
                await message.edit_message_text(text=text_str,reply_markup=keyboard)
            else:
                await message.reply_text(text=text_str,reply_markup=keyboard)
        except Exception as e:
            logger.error(f"Monitor error: {e}")
    except Exception as e:
        logger.error(f"Monitor error: {e}")

async def start_file_leecher(client: Client, message: Union[Message,CallbackQuery],data=None) -> None:
    global worker_running
    message = message if isinstance(message, Message) else message.message
    if not data:
        file = message.document or message.video
        file_name = message.caption.split('\n')[0] or file.file_name or 'N/A'
        absolute_file_name = file.file_name
        extention = absolute_file_name.split('.')[-1]
        if extention not in ['mp4','mkv','avi','mov','001','002','003','004','005']: return await message.delete()
        file_name = re.sub(r'[^\x00-\x7F]+', '', file_name) 
        file_details = parser.extract(file_name)
        if file_details.context_type == 'movie':
            movie = movie_details.get(movie_name=file_details.normalized_title,year=file_details.year)
            if movie:file_name = f"{movie.name} {f"({file_details.year})" if file_details.year else f"({movie.year})" or ''} {file_details.resolution or ''} {file_details.quality or ''} {' '.join(file_details.extra) if file_details.extra else ''}.By.Serandip.Fandom.{extention}"
        else:
            file_name = f"{file_details.title} {file_details.season}x{file_details.episode} {file_details.resolution or ''} {file_details.quality or ''} {file_details.codec or ''} {' '.join(file_details.extra) if file_details.extra else ''}.By.Serandip.Fandom.{extention}"
    else:
        file_name = data if data else message.caption.split('\n')[0] or message.document.file_name or message.video.file_name
    await file_queue.put([message,file_name])
    database.Queue.save_queue(chat_id=message.chat.id,message_id=message.id,file_name=file_name) 
    if worker_running is False:
        worker_running = True
        asyncio.create_task(file_worker(client))

@Client.on_message((filters.document | filters.video) & filters.chat(LEECH_SOURCE))
@round_robin()
async def handle_file(client: Client, message: Message) -> None:
    await start_file_leecher(client, message)

async def file_worker(client) -> None:
    global worker_running
    try:
        while worker_running:
            if file_queue.empty():
                
                worker_running = False
                break

            try:message,file_name = await file_queue.get()
            except:
                file_queue.task_done()
                continue
            
            async def job() -> None:
                async with semaphore:
                    try:await handle_leech_task(client,message,file_name)
                    except Exception as e:logger.error(f"Worker error: {e}")
                    finally:file_queue.task_done()

            while int(LeechClient.get_task_status().get('count', 0)) >=3 :
                await asyncio.sleep(10)

            asyncio.create_task(job())
            database.Queue.remove_queue(chat_id=message.chat.id,message_id=message.id)
            await asyncio.sleep(10)
    finally:worker_running = False

async def handle_leech_task(client: Client,message: Message,file_name =None) -> None:
    logger.info(f"Handling file from message {message.id}")
    logger.info(f"File name: {file_name} , file_link: {message.link} command: /leech1 -n {file_name}")
    LeechClient.leech(
        command=f"/leech1 {message.link} -n {file_name}",
    )
