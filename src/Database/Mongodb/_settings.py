# src/Database/Mongodb/_settings.py

from typing import Any, Literal

from d4rk.Logs import setup_logger

from pymongo.collection import Collection
from pymongo.results import InsertOneResult, UpdateResult

logger = setup_logger(__name__)

class Settings(Collection):
    def __init__(self,collection: Collection) -> None:
        super().__init__(
            collection.database,
            collection.name,
            create=False,
            codec_options=collection.codec_options,
            read_preference=collection.read_preference,
            write_concern=collection.write_concern,
            read_concern=collection.read_concern
        )

    def get(self, key: str, datatype=str,default=None) -> list[str] | Any | str | None:
        try:
            setting = self.find_one({"key": key})
            if setting:
                value = setting.get("value", None)
                if datatype:
                    if datatype is list:
                        return str(value).split(',') if value is not None else default
                    return datatype(value) if value is not None else default
                return value
            return default
        except Exception as e:
            logger.error(f"Error getting setting '{key}': {e}")
            return default
    def set(self, key: str, value) -> UpdateResult | InsertOneResult | Literal[False]:
        try:
            if self.find_one({"key": key}):
                return self.update_one({"key": key}, {"$set": {"value": value}})
            else:
                return self.insert_one({"key": key, "value": value})
        except Exception as e:
            logger.error(f"Error setting value for '{key}': {e}")
            return False