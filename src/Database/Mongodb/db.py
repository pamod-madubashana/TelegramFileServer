# src/Database/Mongodb/typed_db.py

from pydoc import importfile
from pymongo import MongoClient
from typing import Any


from d4rk.Database import db as _db

from src.Database.Mongodb._users import Users
from src.Database.Mongodb._settings import Settings
from src.Database.Mongodb._files import Files

class TypedDatabase:
    Users: Users
    Settings: Settings
    Files: Files
    is_connected: bool

    def connect(self, name: str, DATABASE_URL: str = None) -> None:
        r = _db.connect(name=name, collections=[Users,Settings,Files], DATABASE_URL=DATABASE_URL)
        return r

    def __getattr__(self, item) -> Any:
        return getattr(_db, item)

    async def get_database_stats_async(self):
        try:

            # Get database stats through the underlying _db object
            db_stats = _db.db.command("dbstats")
            return [{
                "db_name": _db.database_name,
                "storageSize": db_stats.get("storageSize", 0),
                "dataSize": db_stats.get("dataSize", 0)
            }]
        except Exception as e:
            print(f"Error getting database stats: {e}")
            # Return fallback stats
            return [{
                "db_name": _db.database_name if hasattr(_db, 'database_name') else "unknown",
                "storageSize": 0,
                "dataSize": 0
            }]

database = TypedDatabase()