# src/Telegram/Plugins/_handle_movie.py

import re
import random
import asyncio

from typing import Union

from pyrogram import Client, filters 
from pyrogram.errors import FloodWait
from pyrogram.types import Message, CallbackQuery, InputMediaPhoto

from d4rk.Logs import setup_logger
from d4rk.Utils import round_robin , button , ButtonMaker

from src.Database import database
from src.Utils import smart_title
from src.Config import MOVIE_GROUP , SEARCH_IMGS , SEARCH_MOVIE_MESSAGE , DOWNLOAD_MSG , MOVIE_NOT_FOUND , SELECT_QUALITY , SELECT_FILES

logger = setup_logger(__name__)

@Client.on_message(filters.text & 
filters.chat(MOVIE_GROUP) 
# filters.private
& ~ filters.regex(r"^/"))
@round_robin()
async def handle_movie_text(client: Client, message: Message) -> None:
    asyncio.create_task(handle_movie(client, message))

@button(pattern="swtts:")
async def switch_to_tv_series(client: Client, callback_query: CallbackQuery) -> None:
    await callback_query.answer("This Feature is still Under Construction", show_alert=True)

@button(pattern="nothere:")
async def nothere(client: Client, callback_query: CallbackQuery) -> None:
    await callback_query.answer("This Feature is still Under Construction", show_alert=True)

@button(pattern="b2mt:")
async def back_to_movie(client: Client, callback_query: CallbackQuery) -> None:
    await handle_movie(client, callback_query)

async def handle_movie(client: Client, message: Union[Message,CallbackQuery]) -> None:
    bt = ButtonMaker()

    def get_year(title):
        match = re.search(r"\((\d{4})\)$", title)
        return int(match.group(1)) if match else 0  # fallback if no year

    # Sort data by extracted year
    if not isinstance(message, CallbackQuery):
        m = await message.reply("seaching movie..",quote=True)
        query = message
    else:
        callback_query = message
        data = message.data.split(":")
        user_id = int(data[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return
        query = callback_query.message.reply_to_message
    data = database.Movies.search_movies(query.text)
    user_mention = f"<a href='tg://user?id={message.from_user.id}'>{message.from_user.first_name}</a>"
    user_text_link = f"<a href='{query.link}'>{query.text.title()}</a>"
    if data:
        data_sorted = sorted(data, key=lambda d: get_year(d.title),reverse=True)
        bt.ibutton("🟢 Movie 🟢 ",f"swtmv:{message.from_user.id}","header")
        bt.ibutton("🔴 Series 🔴",f"swtts:{message.from_user.id}","header")
        for d in data_sorted: 
            bt.ibutton(d.title,f"mvt:{d.id}:{message.from_user.id}")
        bt.ibutton("⚠️ Its Not Here ⚠️",f"nothere:{message.from_user.id}","footer")
        keyboard = bt.build_menu()
        selected_image = random.choice(SEARCH_IMGS)
        caption = SEARCH_MOVIE_MESSAGE.format(user_mention=user_mention, user_text_link=user_text_link)
        try:
            if not isinstance(message, CallbackQuery):
                await m.edit_media(media=InputMediaPhoto(selected_image, caption=caption), reply_markup=keyboard)
            else:
                await callback_query.message.edit_media(media=InputMediaPhoto(selected_image, caption=caption), reply_markup=keyboard)
        except FloodWait as e:
            logger.error(f"Flood wait for {e.value}s by {message.from_user.first_name}")
            if isinstance(message, CallbackQuery):await message.answer(f"Wait for {e.value}s",show_alert=True)
            await asyncio.sleep(e.value)
            await handle_movie(client, message)
    else:
        await m.edit(MOVIE_NOT_FOUND.format(user_mention=user_mention,user_text_link=user_text_link))
        
@button(pattern="mvt:")
async def move_to_resolutions(client: Client, callback_query: CallbackQuery) -> None:
    bt = ButtonMaker()
    data = callback_query.data.split(":")
    try:
        user_id = int(data[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return
        await callback_query.answer()
        movie_id = data[1] 
        movie = database.Movies.get_movie_by_id(movie_id)
        if movie:
            def resolution_sort_key(resolution):
                """Sort resolutions by quality priority"""
                res = resolution.resolution.upper()
                priority_map = {
                    'SD': 1, '480P': 2, 'HD': 3, '720P': 4, 
                    'FHD': 5, '1080P': 6, '2K': 7, '1440P': 8,
                    '4K': 9, '2160P': 10, '8K': 11, '4320P': 12
                }
                if res in priority_map:return priority_map[res]
                if res.endswith('P') and res[:-1].isdigit():return int(res[:-1]) / 100
                return 999
            for r in sorted(movie.resolutions, key=resolution_sort_key):
                bt.ibutton(r.resolution,f"mvr:{movie_id}:{r.resolution}:{user_id}")
            
            bt.ibutton(" << Back ",f"b2mt:{user_id}","footer")
            keyboard = bt.build_menu()
            caption = SELECT_QUALITY.format(title=f"{movie.title} ({movie.imdb.year})" if movie.imdb.year not in movie.title else smart_title(movie.title))
            if movie.imdb.poster:
                await callback_query.message.edit_media(media=InputMediaPhoto(media=movie.imdb.poster, caption=caption),reply_markup=keyboard)
            else:
                await callback_query.edit_message_caption(caption=caption,reply_markup=keyboard)

    except FloodWait as e:
        logger.error(f"Flood wait for {e.value}s by {callback_query.from_user.first_name}")
        await callback_query.answer(f"Wait for {e.value}s",show_alert=True)
        await asyncio.sleep(e.value)
        await move_to_resolutions(client, callback_query)
    except Exception as e:
        logger.error("Error : " + str(e))

@button(pattern="mvr:")
async def move_to_files(client: Client, callback_query: CallbackQuery) -> None:
    bt = ButtonMaker()
    data = callback_query.data.split(":")
    try:
        user_id = int(data[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return
        
        await callback_query.answer()
        movie_id = data[1]
        resolution = data[2]
        movie = database.Movies.get_movie_by_id(movie_id)
        if movie:
            keyboard = []
            files = [f for r in movie.resolutions if r.resolution == resolution for f in r.files]
            for f in sorted(files, key=lambda f: int(f.size)):
                bt.ibutton(f"{f.codec or ''} {f.quality or ''} {' '.join(f.extra_tags)} - {f"({f.size} MB)" if f.size < 1024 else f"({f.size / 1024:.2f} GB)"}",f"mvf:{movie_id}:{f.id}:{user_id}")
            bt.ibutton(" << Back ",f"mvt:{movie_id}:{user_id}","footer")
            keyboard = bt.build_menu()
            caption = SELECT_FILES.format(title=f"{movie.title} ({movie.imdb.year})",quality=resolution)
            await callback_query.message.edit_caption(caption=caption,reply_markup=keyboard)
    except FloodWait as e:
        logger.error(f"Flood wait for {e.value}s by {callback_query.from_user.first_name}")
        await callback_query.answer(f"Wait for {e.value}s",show_alert=True)
        await asyncio.sleep(e.value)
        await move_to_files(client, callback_query)
    except Exception as e:
        logger.error("Error : " + str(e))


@button(pattern="mvf:")
async def click_on_file(client: Client, callback_query: CallbackQuery) -> None:
    bt = ButtonMaker()
    data = callback_query.data.split(":")
    try:
        user_id = int(data[-1])
        if callback_query.from_user.id != user_id:
            await callback_query.answer("This button is not for you!", show_alert=True)
            return

        await callback_query.answer()
        movie_id = data[1]
        file_id = data[2]
        movie = database.Movies.get_movie_by_id(movie_id)
        title = movie.title
        year = movie.imdb.year
        rating = movie.imdb.rating
        genres = movie.imdb.genres
        for res in movie.resolutions:
            for file in res.files:
                if file.id == int(file_id):
                    file_name = file.display_name
        caption = DOWNLOAD_MSG.format(title=title,year=year,rating=rating,genres=genres,file=file_name)
        bt.ubutton("Download",f"https://t.me/{client.me.username}?start={file_id}","footer")
        keyboard = bt.build_menu()
        await callback_query.edit_message_caption(caption=caption,reply_markup=keyboard)
    except FloodWait as e:
        logger.error(f"Flood wait for {e.value}s by {callback_query.from_user.first_name}")
        await callback_query.answer(f"Wait for {e.value}s",show_alert=True)
        await asyncio.sleep(e.value)
        await click_on_file(client, callback_query)
    except Exception as e:
        logger.error("Error : " + str(e))
