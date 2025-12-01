import os, math, logging, datetime, pytz

from pyrogram.errors import BadRequest, Unauthorized
from pyrogram import Client
from pyrogram import types
from pyrogram.types import Message
from pyrogram import Client, filters
from asyncio.exceptions import TimeoutError

from d4rk.Logs import setup_logger
logger = setup_logger(__name__)

from src.Config import API_ID, API_HASH, LOGS, DATABASE_URL, APP_NAME
from src.Database import database

# Initialize the database connection
if hasattr(database, 'connect'):
    database.connect(APP_NAME, DATABASE_URL)


class User(Client):
    def __init__(self):
        self.session = None
        self._sign_in = False
        self.running = False
        

    async def create_client(self):
        super().__init__(
            name="Telegram-File-Server",
            api_id=API_ID,
            api_hash=API_HASH,
            session_string=self.session,
            workers=200,
            plugins={'root': 'src/Telegram/UserPlugins'},
            sleep_threshold=10,
        )
        
    async def start(self):    
        self.session = database.Settings.get('session', str, default=None)
        if self.session is None:
            return
        await self.create_client()
        await super().start()
        self.running = True
        await self.send_message(LOGS, f"{self.me.mention} is... Online")
        logger.info(f"{self.me.username} is...  Online")
            
    async def stop(self, *args):
        if self.running:
            await self.send_message(LOGS, f"{self.me.mention} is... Offline")
            logger.info(f"{self.me.username} is...  Offline")
            await super().stop()


user = User()




