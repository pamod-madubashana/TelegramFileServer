# src/Database/Mongodb/_settings.py

from typing import Any

from d4rk.Logs import setup_logger

from pymongo.collection import Collection
from pymongo.results import InsertOneResult

logger = setup_logger(__name__)

class Users(Collection):
    user_cache = set()
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

    def get_user_count(self) -> int:
        try:return self.count_documents()
        except:return 0

    def getUser(self, user_id: str) -> Any | None:
        try:return self.find_one({"user_id": user_id})
        except:return None
            
    def SaveUser(self, user_id: str) -> InsertOneResult | None:
        try:
            if user_id in self.user_cache:return
            self.user_cache.add(user_id)
            saved = self.getUser(user_id)
            if not saved:
                return self.insert_one({'user_id': user_id})
            
        except:return None
        
    def saveUserSetting(self,user_id,setting :str,value :str) -> None:
        try:
            if (self.getUser(user_id)):
                self.update_one({'user_id':user_id},{"$set": {setting: value}})
            else:
                self.insert_one({'user_id':user_id,setting:value})
        except:return None

    def getUserSetting(self,user_id :str, setting :str,default :str = None) -> Any | None:
        try:
            if (saved:=self.getUser(user_id)):
                return saved[setting]
            else:
                self.insert_one({'user_id':user_id,setting:default})
        except:return None