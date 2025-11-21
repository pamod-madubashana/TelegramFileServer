# src/Config/_data.py

import os 
from dotenv import load_dotenv
from pyrogram.types import ChatPrivileges
load_dotenv()

APP_NAME = os.getenv("APP_NAME", "MyApp")
TIME_ZONE = os.getenv("TIME_ZONE", "+5:30")
WEB_APP = os.getenv("WEB_APP", None)
API_ID = int(os.getenv("API_ID"))
API_HASH = str(os.getenv("API_HASH"))
LOGGER_BOT = os.getenv("LOGGER_BOT")
OWNER = int(os.getenv("OWNER")) if os.getenv("OWNER") else None
GROUP = int(os.getenv("GROUP")) if os.getenv("GROUP") else None
LOGS = int(os.getenv("LOGS")) if os.getenv("LOGS") else None
MOVIE = int(os.getenv("MOVIE")) if os.getenv("MOVIE") else None
MOVIE_GROUP = int(os.getenv("MOVIE_GRP")) if os.getenv("MOVIE_GRP") else None
FILTER_CHAT = int(os.getenv("FILTER_CHAT")) if os.getenv("FILTER_CHAT") else None
LEECH_SOURCE = int(os.getenv("LEECH_SOURCE")) if os.getenv("LEECH_SOURCE") else None
LEECH_CHAT = int(os.getenv("LEECH_CHAT")) if os.getenv("LEECH_CHAT") else None
DATABASE_URL = str(os.getenv("DATABASE_URL", None))

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "84378109897-qec6lh4u5g1c4koi3h7vegn25ssnpbn3.apps.googleusercontent.com")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "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")

AUTHORIZED_ADMIN_EMAILS = [
    "premiumqtrst@gmail.com",
    "pamodmadubashna2003@gmail.com",
    "randi33pquest@gmail.com"
]


TOKENS = []
for i in range(6):
    if (t :=os.getenv(f"TOKEN{i}")):
        TOKENS.append(os.getenv(f"TOKEN{i}"))


ADMIN=ChatPrivileges(
    can_manage_chat=True,
    can_delete_messages=True,
    can_manage_video_chats=True,
    can_restrict_members=True,
    can_promote_members=True,
    can_change_info=True,
    can_invite_users=True,
    can_pin_messages=True,
    )