# src/Telegram/Plugins/_backup.py

import os
import asyncio
from unittest import TestResult
import requests

from telegram import Bot

from pyrogram import Client, filters 
from pyrogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton ,ChatPrivileges
from datetime import datetime, timezone, timedelta

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters , get_font , command , get_commands

from src.Database import database
from src.Telegram.user import user
from src.Config import START_MSG, START_IMGS , MOVIE , INFO_MSG

from src.Telegram.user import user

logger = setup_logger(__name__)

@command(command='backup',description='Backup chat to another chat')
async def backup(client: Client, message: Message):
    
    workers = [
        "6867011982:AAGgzb1NEtqUyPMW0my16oRx0Cpi1xLoK9w",
        "6902236685:AAFJAJTfiy9bwaehzNglPGB4GcCwYPYZlRw",
        "6955375887:AAEzIeb3TUMLe8dqWXrNyQF02q8NZsE9Nio",
        "6675784160:AAHeoAQUqSFBcRAzyOMznh3BaZKxZ-IhHsw",
        # "6714411264:AAHUiCNR0nt7wb-xwHVQ9sZtO_wJdyH-AQE",
        # "6848386996:AAEajKW-4NsZSC_QM3T9cxfo2dPLwSKjenk",
        # "6756920733:AAGvj463Oi7lJeA5uOGrPmjoZwmpusBiGs4",
        # "6423875316:AAFSF1ycrShZM_nRFnLjeoULpW2DaqtMtOE",
        # "6809021280:AAF9PcXtxLZcJyWXIX0owr7doHCBYWThCi8",
        # "6296275549:AAH92k3lPNUup84cD3Wr-08PwdhO8NWyyRQ",
        # "7099216292:AAGrrnrAGTKXBtOGNCMJILs2-yZXm5C5Cgg",
        # "7144772271:AAF2xuFB7e17AE9jLulgRxS4ftOkBrM2Dv4",
        # "6700599695:AAHyf3-q52x-2L_zFD8pbHGDtaA88SkYVqA",
        # "7134784070:AAFebtfvrE4uN5hACW-ibrf5klPxB7rOoOI",
        # "7058049176:AAHe6CghebEjPBCzUcylBr4kLJeI_TdGr5c",
        # "7038291324:AAEA74ZUB6-D9DG88HkWi-cVtIBUip_3EVc",
        # "7129067508:AAFkYpE-6VKxxXwoMLSDpKSVE7s2KAPwK_g",
        # "7041775025:AAErty4OCIHY_ORoYd2RaknNkrRXGtO7PZU",
    ]
    workersIDs = [i.split(":")[0] for i in workers]
    chat_id = message.text.split()[1]
    from_chat_id = message.chat.id
    for workerID in workers:
        try:await Bot(workerID).send_message(chat_id=user.me.id, text=f"{from_chat_id}")
        except Exception as e: logger.error(e)
        await asyncio.sleep(2)
        try:
            # await user.send_message(chat_id=workerID.split(':')[0], text="/start")
            logger.info(f"Adding {workerID} to {from_chat_id}")
            # await user.promote_chat_member(chat_id=from_chat_id, user_id=workerID, privileges=ChatPrivileges(
            #     can_manage_chat = True,
            #     can_post_messages = True,
            # ))
        except Exception as e: logger.error(e)
    