# src/Database/Mongodb/_telegram_verification.py

from typing import Any, Optional
from datetime import datetime, timedelta
import secrets

from d4rk.Logs import setup_logger

from pymongo.collection import Collection
from pymongo.results import InsertOneResult

logger = setup_logger(__name__)

class TelegramVerification(Collection):
    def __init__(self, collection: Collection) -> None:
        super().__init__(
            collection.database,
            collection.name,
            create=False,
            codec_options=collection.codec_options,
            read_preference=collection.read_preference,
            write_concern=collection.write_concern,
            read_concern=collection.read_concern
        )

    def generate_verification_code(self, user_id: str) -> str:
        """
        Generate a unique verification code for a user
        """
        # Generate a secure random code
        code = secrets.token_urlsafe(16)
        
        # Store the code with expiration (1 hour)
        expiration = datetime.utcnow() + timedelta(hours=1)
        
        try:
            # Remove any existing codes for this user
            self.delete_many({"user_id": user_id})
            
            # Insert the new verification code
            self.insert_one({
                "user_id": user_id,
                "code": code,
                "created_at": datetime.utcnow(),
                "expires_at": expiration
            })
            
            logger.info(f"Generated verification code for user {user_id}")
            return code
        except Exception as e:
            logger.error(f"Error generating verification code for user {user_id}: {e}")
            raise

    def verify_code(self, user_id: str, code: str) -> bool:
        """
        Verify a code for a user and return True if valid
        """
        try:
            # Find the verification record
            record = self.find_one({"user_id": user_id, "code": code})
            
            if not record:
                logger.warning(f"No verification record found for user {user_id}")
                return False
            
            # Check if the code has expired
            if datetime.utcnow() > record["expires_at"]:
                logger.warning(f"Verification code expired for user {user_id}")
                # Remove expired code
                self.delete_one({"user_id": user_id, "code": code})
                return False
            
            # Code is valid, remove it (one-time use)
            self.delete_one({"user_id": user_id, "code": code})
            logger.info(f"Verification code validated for user {user_id}")
            return True
        except Exception as e:
            logger.error(f"Error verifying code for user {user_id}: {e}")
            return False

    def get_verification_data(self, user_id: str) -> Optional[dict]:
        """
        Get verification data for a user
        """
        try:
            return self.find_one({"user_id": user_id})
        except Exception as e:
            logger.error(f"Error retrieving verification data for user {user_id}: {e}")
            return None