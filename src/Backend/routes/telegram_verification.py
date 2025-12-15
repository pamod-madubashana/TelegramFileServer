# src/Backend/routes/telegram_verification.py

from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
import logging
import secrets

from src.Backend.security.credentials import require_auth , User
from src.Database import database

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/telegram", tags=["telegram"])

class TelegramVerificationRequest(BaseModel):
    user_id: str

class TelegramVerificationResponse(BaseModel):
    bot_username: str
    verification_link: str
    code: str

@router.post("/generate-verification", response_model=TelegramVerificationResponse)
async def generate_telegram_verification(
    verification_request: TelegramVerificationRequest,
    request: Request,
    user: User = Depends(require_auth)
):
    """
    Generate a Telegram verification code and return the least busy bot link
    """
    try:
        # Check if bot manager is available
        if not hasattr(request.app.state, 'bot_manager') or not request.app.state.bot_manager:
            raise HTTPException(status_code=503, detail="Bot manager not available - Telegram functionality is disabled")

        bot_manager = request.app.state.bot_manager
            
        # Use the authenticated user from the require_auth dependency
        username = user.username
        
        # Generate verification code using the username
        verification_code = database.Tgcodes.generate_verification_code(username)
            
        # Get clients
        clients = None
        if hasattr(bot_manager, 'clients'):
            clients = bot_manager.clients
        elif hasattr(bot_manager, 'client_list'):
            clients = bot_manager.client_list
        else:
            # Try to get clients from bot_manager directly
            clients = getattr(bot_manager, 'clients', None) or getattr(bot_manager, 'client_list', None)
        
        if not clients:
            raise HTTPException(status_code=503, detail="No bot clients available")
        
        # Find the least busy bot
        least_busy_bot = None
        least_workload = float('inf')
        
        for client in clients:
            try:
                workload = client.get_workload() if hasattr(client, 'get_workload') else 0
                if workload < least_workload:
                    least_workload = workload
                    least_busy_bot = client
            except:
                # If we can't get workload for a bot, skip it
                continue
        
        if not least_busy_bot:
            raise HTTPException(status_code=503, detail="No available bot clients")
        
        # Get bot information
        bot_me = None
        try:
            bot_me = least_busy_bot.me
        except:
            pass
            
        if not bot_me or not hasattr(bot_me, 'username') or not bot_me.username:
            raise HTTPException(status_code=503, detail="Bot information unavailable")
        
        # Create verification link
        verification_link = f"https://t.me/{bot_me.username}?start={verification_code}"
        
        logger.info(f"Generated verification link for user {username} using bot {bot_me.username}")
        
        return TelegramVerificationResponse(
            bot_username=bot_me.username,
            verification_link=verification_link,
            code=verification_code
        )
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        logger.error(f"Error generating Telegram verification: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/verify-code")
async def verify_telegram_code(
    verification_request: TelegramVerificationRequest,
    code: str,
    request: Request,
    user: User = Depends(require_auth)
):
    """
    Verify a Telegram code for a user
    """
    try:
        user_id = verification_request.user_id
        is_valid = database.Tgcodes.verify_code(user_id, code)
        
        if is_valid:
            logger.info(f"Telegram verification successful for user {user_id}")
            return {"verified": True, "message": "Telegram verification successful"}
        else:
            logger.warning(f"Telegram verification failed for user {user_id}")
            raise HTTPException(status_code=400, detail="Invalid or expired verification code")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error verifying Telegram code: {e}")
        raise HTTPException(status_code=500, detail=str(e))