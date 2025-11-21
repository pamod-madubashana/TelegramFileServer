# src/Telegram/Plugins/_file.py

import re
import asyncio

from pyrogram.types import Message , CallbackQuery, Reaction
from pyrogram import Client, filters

from src.Config import MOVIE
from src.Database import database
from src.Models import movie_details , tv_details
from src.Dataclass import MongoMovie , MongoImdb , MongoMovieFile , Resolution , FileData

from d4rk.Logs import setup_logger
from d4rk.Utils import parser , round_robin , button , ButtonMaker , Reacts
from ._leech import start_file_leecher


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
        
@button(pattern="ta:file")
async def process_file_retry(client: Client, callback_query: CallbackQuery):
    await callback_query.answer("Retrying...")
    data = await check_file(client,callback_query)
    if data is not False:
        m = await callback_query.message.reply("File processing started again. You will be notified once it's done.")
        await start_file_leecher(client,callback_query)
    else:
        m = await callback_query.message.reply("File processing failed again. Please check the file and try again later.")

    await client.delete_message(chat_id=m.chat.id,message_ids=m.id,wait=10)


async def check_file(client: Client, callback_query: CallbackQuery):
    movie = None
    tv = None
    await callback_query.answer()
    file = callback_query.message.document or callback_query.message.video
    caption = callback_query.message.caption.split('\n')[0]
    file_name = caption or file.file_name
    file_details = parser.extract(file_name)
    logger.info(f"Extracted file details for {file_name}: title='{file_details.normalized_title}', year={file_details.year}")
    if file_details.context_type == "movie":
        movie = movie_details.get(file_details.normalized_title,year=file_details.year)
        if not movie.name:
            return False
        return movie
    elif file_details.context_type == "tv":
        tv = tv_details.get(file_details.normalized_title)
        if not tv.name: 
            return False
        return tv
    else:
        return False


@Client.on_message((filters.document | filters.video) & filters.chat(MOVIE))
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
                try:
                    await handle_file_task(client,message)
                except Exception as e:
                    logger.error(f"Worker error: {e}")
                finally:
                    file_queue.task_done()
        await asyncio.sleep(10)
        asyncio.create_task(job())

async def handle_file_task(client: Client,message: Message) -> bool:
    normalized_title = ''
    try:
        if not message.document and not message.video:
            return False
        file = message.document or message.video
        file_name = message.caption or file.file_name or 'N/A'
        absolute_file_name = file.file_name
        extention = absolute_file_name.split('.')[-1]
        if extention not in ['mp4','mkv','avi','mov','001','002','003','004','005']: 
            await message.delete()
            return False
        file_name = re.sub(r'[^\x00-\x7F]+', '', file_name) 
        file_size = int(file.file_size/1024/1024)
        file_unique_id = file.file_unique_id
        file_details = parser.extract(file_name)
        
        if not file_details.normalized_title:
            return False
        
        movie = movie_details.get(file_details.normalized_title,year=file_details.year)
        if not movie.name:
            try:
                asyncio.create_task(send_error(client,message))
            except:
                pass
            return False

        normalized_title = re.sub(r'[^a-z0-9&\+]+', ' ', movie.name.lower()).strip()
        normalized_title = str(normalized_title)
        if normalized_title == '':
            normalized_title = file_details.title
        saved = database.Movies.get_movie(normalized_title)

        movie_class = None
        
        if not saved:
            display_name = f"{movie.name} {f"({file_details.year})" if file_details.year else f"({movie.year})" or ''} {file_details.resolution or ''} {file_details.quality or ''} {' '.join(file_details.extra) if file_details.extra else ''}"
            movie_class = MongoMovie(
                            id=movie.id,
                            title=f"{movie.name} {movie.year}" if movie.year else movie.name,
                            normalized_title=normalized_title,
                            imdb=MongoImdb(movie.id,movie.year,movie.rating,movie.genres,movie.image,movie.backdrop),
                            resolutions= [
                                Resolution(
                                    resolution=file_details.resolution if file_details.resolution else 'HD',
                                    files=[
                                        MongoMovieFile(
                                            id=message.id,
                                            quality=file_details.quality,
                                            codec=file_details.codec,
                                            extra_tags=file_details.extra,
                                            display_name=display_name,
                                            file_data=[
                                                FileData(
                                                    filename=absolute_file_name,
                                                    unique_id=file_unique_id,
                                                    message_id=message.id,
                                                    chat_id=message.chat.id
                                                )
                                            ],
                                            size=file_size
                                            )
                                    ]
                                )
                            ]
                        )
        else:
            display_name = f"{file_details.normalized_title} {f"({file_details.year})" if file_details.year else f"({saved.imdb.year})" or ''} {file_details.resolution or ''} {file_details.quality or ''} {' '.join(file_details.extra) if file_details.extra else ''}"
            movie_class =  MongoMovie(
                title=saved.title,
                normalized_title=saved.normalized_title,
                imdb=MongoImdb(saved.imdb.id,saved.imdb.year,saved.imdb.rating,saved.imdb.genres,saved.imdb.poster,saved.imdb.backdrop),
                resolutions= [
                    Resolution(
                        resolution=file_details.resolution if file_details.resolution else 'HD',
                        files=[
                            MongoMovieFile(
                                id=message.id,
                                quality=file_details.quality,
                                codec=file_details.codec,
                                extra_tags=file_details.extra,
                                display_name=display_name,
                                file_data=[
                                    FileData(
                                        filename=absolute_file_name,
                                        unique_id=file_unique_id,
                                        message_id=message.id,
                                        chat_id=message.chat.id
                                    )
                                ],
                                size=file_size
                                )
                        ]
                    )
                ]
            )
            
        if movie_class is None:
            logger.error(f"movie_class is None for {normalized_title} - this should not happen")
            return False
            

        loop = asyncio.get_running_loop()
        save = await loop.run_in_executor(None, database.Movies.save, movie_class)

        if save is True:
            logger.info(f"Successfully saved movie {normalized_title} to database")
            await message.react(Reacts.like)
            return True
        elif save is False:
            logger.warning(f"Failed to save movie {normalized_title} to database")
            await message.react(Reacts.unlike)
            return False
        else:
            logger.debug(f"Movie {normalized_title} already exists")
            return None
    except Exception as e:
        logger.error(f"Error processing message {message.id}: {str(e)}")
        try:
            asyncio.create_task(send_error(client,message, e))
        except:
            pass
        return False