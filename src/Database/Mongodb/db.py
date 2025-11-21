# src/Database/Mongodb/typed_db.py

from pydoc import importfile
from pymongo import MongoClient
from typing import Any


from d4rk.Database import db as _db

from src.Database.Mongodb._users import Users
from src.Database.Mongodb._settings import Settings
from src.Database.Mongodb._files import Files

class TypedDatabase:
    Chats: Chats
    Users: Users
    Movies: Movies
    Tv: Tv
    Settings: Settings
    Queue: Queue
    Files: Files
    is_connected: bool

    def connect(self, name: str, DATABASE_URL: str = None) -> None:
        r = _db.connect(name=name, collections=[Chats,Users,Movies,Tv,Settings,Queue,Files], DATABASE_URL=DATABASE_URL)
        self.Movies.list_titles()
        return r

    def __getattr__(self, item) -> Any:
        return getattr(_db, item)

    async def get_database_stats_async(self):
        try:
            # Get counts for movies and TV shows
            movie_count = self.Movies.count_documents({})
            tv_count = self.Tv.count_documents({}) if hasattr(self, 'Tv') else 0
            
            # Get database stats through the underlying _db object
            db_stats = _db.db.command("dbstats")
            return [{
                "db_name": _db.database_name,
                "movie_count": movie_count,
                "tv_count": tv_count,
                "storageSize": db_stats.get("storageSize", 0),
                "dataSize": db_stats.get("dataSize", 0)
            }]
        except Exception as e:
            print(f"Error getting database stats: {e}")
            # Return fallback stats
            return [{
                "db_name": _db.database_name if hasattr(_db, 'database_name') else "unknown",
                "movie_count": self.Movies.count_documents({}) if hasattr(self, 'Movies') else 0,
                "tv_count": self.Tv.count_documents({}) if hasattr(self, 'Tv') else 0,
                "storageSize": 0,
                "dataSize": 0
            }]


database = TypedDatabase()