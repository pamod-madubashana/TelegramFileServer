# src/Telegram/Plugins/_index.py

import asyncio
from typing import List, Optional, Union
from cachetools import TTLCache

from pyrogram import Client, filters 
from pyrogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton , WebAppInfo

from d4rk.Logs import setup_logger
from d4rk.Utils import CustomFilters , ButtonMaker ,  round_robin ,command , button , progress_bar

from src.Database import database


logger = setup_logger(__name__)

active_indexers = TTLCache(maxsize=1000, ttl=24*3600)

class IndexMessages:
    
    def __init__(self,message,client,owner_id: str) -> None:
        self.message: Message = message
        self.client: Client = client
        self.owner_id: str = owner_id
        
        self.total: int = 0
        self.got: int = 0
        self.index: int = 0
        self.database: int = 0
        self.failed_count: int = 0
        self.skipped_count: int = 0
        self.non_file_count: int = 0
        self.total_file_messages: int = 0
        self.processed_file_messages: int = 0
        self.processed_message_ids: set = set()
        self.messages_list: List[Message] = []
        self.file_queue = asyncio.Queue()
        self.semaphore = asyncio.Semaphore(5)
        self.worker_running = False
        self.index_on_progress = True

    async def save_file(self,message: Message):
        try:
            media = message.document or message.video or message.photo or message.voice or message.audio
            if not media:
                return None
            if message.document:
                file_type = "document"
                file_name = getattr(media, 'file_name', "N/A")
                thumbnail = media.thumbs[0].file_id if media.thumbs else None
            elif message.video:
                file_type = "video"
                # Generate a file name similar to photos if not available
                file_name = getattr(media, 'file_name', None)
                if not file_name or file_name == "N/A":
                    file_name = f"Video_{media.file_unique_id}.mp4"
                thumbnail = media.thumbs[0].file_id if media.thumbs else None
            elif message.photo:
                file_type = "photo"
                file_name = f"Photo_{media.file_unique_id}.jpg"
                thumbnail = media.file_id # Photo itself is the thumbnail/image
            elif message.voice:
                file_type = "voice"
                file_name = f"Voice_{media.file_unique_id}.ogg"
                thumbnail = None
            elif message.audio:
                file_type = "audio"
                file_name = getattr(media, 'file_name', f"Audio_{media.file_unique_id}.mp3")
                thumbnail = media.thumbs[0].file_id if media.thumbs else None
            
            # Determine file path based on media type and extension
            file_path = "/Home/Documents" # Default path
            
            if file_type == "photo":
                file_path = "/Home/Images"
            elif file_type == "video":
                file_path = "/Home/Videos"
            elif file_type == "voice":
                file_path = "/Home/Voice Messages"
            elif file_type == "audio":
                file_path = "/Home/Audio"
            elif file_type == "document":
                # Check extension for documents
                ext = file_name.split('.')[-1].lower() if '.' in file_name else ""
                
                video_exts = ['mp4', 'mkv', 'avi', 'mov', 'webm']
                image_exts = ['jpg', 'jpeg', 'png', 'gif', 'webp']
                audio_exts = ['mp3', 'wav', 'ogg', 'flac', 'm4a']
                
                if ext in video_exts:
                    file_path = "/Home/Videos"
                    file_type = "video" # Update type as well
                elif ext in image_exts:
                    file_path = "/Home/Images"
                    file_type = "photo" # Update type as well
                elif ext in audio_exts:
                    file_path = "/Home/Audio"
                    file_type = "audio" # Update type as well
            
            logger.info(f"Processing file message {message.caption or file_name} -> {file_path}")
            file_unique_id = media.file_unique_id
            file_size = media.file_size
            file_caption = message.caption or "N/A"
            # Use the owner ID from the indexer (the user who initiated the indexing)
            owner_id = self.owner_id
            
            return database.Files.add_file(
                chat_id=message.chat.id,
                message_id=message.id,
                thumbnail=thumbnail,
                file_type=file_type,
                file_unique_id=file_unique_id,
                file_size=file_size,
                file_name=file_name,
                file_caption=file_caption,
                file_path=file_path,
                owner_id=owner_id
            )
        except Exception as e:
            logger.error(f"Error in save_file: {e}")
            return False

    async def get_all_messages(self,client: Client, message: Message, chat_id: Union[int, str], end: int, start: int = 0) -> List[Message]:
        current = start
        self.total = end - start + 1
        messages_per_round = 100
        
        if not hasattr(self, 'update_task_started'):
            self.update_task_started = True
            self.update_task = asyncio.create_task(self.update_message())

        while current <= end and self.worker_running:
            new_diff = min(messages_per_round, end - current + 1)
            if new_diff <= 0:
                break
            try:
                message_ids = list(range(current, current + new_diff))
                messages = await client.get_messages(chat_id=chat_id, message_ids=message_ids)
                valid_messages = [msg for msg in messages if msg is not None]
                file_messages = [msg for msg in valid_messages if msg.document or msg.video or msg.photo or msg.voice or msg.audio]
                
                for msg in valid_messages:
                    if msg.id not in self.processed_message_ids:
                        await self.file_queue.put(msg)
                        if msg.document or msg.video or msg.photo or msg.voice or msg.audio:
                            self.total_file_messages += 1
                
                logger.info(f"Processed {len(valid_messages)} messages ({len(file_messages)} with files), current: {current}, total: {self.total}")
                logger.info(f"Running total of file messages queued: {self.total_file_messages}")
                    
                current += new_diff
                self.index += len(valid_messages)
                
            except Exception as e:
                logger.error(f"Error getting messages {current}-{current + new_diff - 1}: {e}")
                current += new_diff
            
            await asyncio.sleep(15)
        
        logger.info(f"Finished getting messages. Total indexed: {self.index}")

    async def update_message(self) -> None:
        logger.info("Starting message updates")
        try:
            while self.worker_running:
                if self.total > 0:
                    index_percentage = (self.index * 100) / self.total
                    database_percentage = (self.database * 100) / self.total_file_messages if self.total_file_messages > 0 else 0
                else:
                    index_percentage = 0
                    database_percentage = 0

                index_progress = progress_bar(index_percentage) 
                database_progress = progress_bar(database_percentage)
                
                text = f"""🔄 <b>Indexing Progress</b>

📥 <b>Fetching Messages:</b>

{index_progress} {index_percentage:.1f}%
📊 Messages: {self.index} / {self.total}

💾 <b>Saving to Database:</b>

{database_progress} {database_percentage:.1f}%
🎬 Saved: {self.database} / {self.total_file_messages if self.total_file_messages > 0 else self.index}

⏱️ Status: {'Processing...' if self.worker_running else 'Completed'}"""
                
                cancel_button = InlineKeyboardMarkup([[
                    InlineKeyboardButton('Cancel Index', callback_data='cancel_indexing')
                ]])
                
                try:
                    await self.message.edit(text, reply_markup=cancel_button)
                    logger.debug(f"Progress update: {self.index}/{self.total} indexed, {self.database}/{self.processed_file_messages} saved")
                except:pass

                await asyncio.sleep(10)
        except Exception as e:
            logger.error(f"Critical error in update_message: {e}")

    async def update_database(self) -> None:
        logger.info(f"Database worker starting - worker_running: {self.worker_running}")
        total_processed = 0
        
        while self.worker_running:
            if not self.worker_running:
                logger.info("Database worker stopping due to cancellation")
                break
                
            logger.debug(f"Database worker loop - worker_running: {self.worker_running}, queue_empty: {self.file_queue.empty()}")
            
            if not self.index_on_progress and self.processed_file_messages >= self.total_file_messages:
                logger.info(f"All file messages processed ({self.processed_file_messages}/{self.total_file_messages}). Checking queue...")
                if self.file_queue.empty():
                    logger.info("Queue is empty. Exiting processing loop.")
                    break
                else:
                    remaining_messages = 0
                    while not self.file_queue.empty() and remaining_messages < 50:
                        try:
                            message = await asyncio.wait_for(self.file_queue.get(), timeout=1.0)
                            remaining_messages += 1
                            if not (message.document or message.video or message.photo or message.voice or message.audio):
                                self.non_file_count += 1
                                logger.debug(f"Processed remaining non-file message {message.id}")
                            self.file_queue.task_done()
                        except asyncio.TimeoutError:
                            break
                    logger.info(f"Processed {remaining_messages} remaining non-file messages. Exiting.")
                    break
            
            try:
                logger.debug(f"Queue size: {self.file_queue.qsize()}, Worker running: {self.worker_running}")
            
                try:
                    message = await self.file_queue.get()
                    total_processed += 1
                    logger.info("=========================================================================")
                    logger.info(f"Retrieved message {message.id} from queue (#{total_processed})")
                    
                    async with self.semaphore:
                        try:
                            if not self.worker_running:
                                logger.info("Processing cancelled by user")
                                break
                            
                            if message.id in self.processed_message_ids:
                                logger.debug(f"Skipping already processed message {message.id}")
                                continue
                            
                            self.processed_message_ids.add(message.id)
                            
                            if message.document or message.video or message.photo or message.voice or message.audio:
                                self.processed_file_messages += 1
                                logger.info(f"Processing file message {message.id} (#{self.processed_file_messages}/{self.total_file_messages}): {message.caption or getattr(message.document or message.video, 'file_name', 'No filename')}")
                                result = await self.save_file(message)
                                if result is True:
                                    self.database += 1
                                    logger.info(f"Successfully saved message {message.id} to database")
                                elif result is False:
                                    self.failed_count += 1
                                    logger.warning(f"Failed to save message {message.id} to database")
                                elif result is None:
                                    self.skipped_count += 1
                                    logger.debug(f"Message {message.id} was skipped (duplicate/already exists)")
                                else:
                                    logger.warning(f"Unexpected return value from handle_file_task for message {message.id}: {result}")
                                await asyncio.sleep(1)
                            else:

                                self.non_file_count += 1
                                logger.debug(f"Skipping non-file message {message.id}")
                                await asyncio.sleep(0.2)
                        except Exception as e:
                            logger.error(f"Error processing message {message.id}: {e}")
                        finally:
                            self.file_queue.task_done()
                    
                        if not self.index_on_progress and self.processed_file_messages >= self.total_file_messages and self.file_queue.empty():
                            logger.info(f"All files processed! {self.processed_file_messages}/{self.total_file_messages} completed")
                            break
                        
                        
                        
                except Exception as queue_error:
                    if not self.worker_running:
                        logger.info("Worker stopped, exiting queue processing")
                        break
                    else:
                        logger.error(f"Unexpected queue error: {queue_error}")
                        await asyncio.sleep(0.1)
                
            except Exception as e:
                logger.error(f"Unexpected error in database worker: {e}")
                await asyncio.sleep(1)
            await asyncio.sleep(0.1)

        self.worker_running = False
        logger.info(f"Database indexing completed. Total processed: {self.database} files")

    def cancel_indexing(self) -> None:
        """Cancel the indexing process"""
        logger.warning("Indexing process cancelled by user")
        self.worker_running = False
        
        # Remove this indexer from the cache
        if self.owner_id in active_indexers:
            del active_indexers[self.owner_id]
        
        if hasattr(self, 'update_task'):
            self.update_task.cancel()

    async def start(self) -> None:
        # Register this indexer in the cache
        active_indexers[self.owner_id] = self
        logger.info(f"Starting indexing process for chat {self.message.chat.id} up to message {self.message.id} for user {self.owner_id}")
        self.worker_running = True
        
        self.update_task = asyncio.create_task(self.update_message())
        await asyncio.sleep(0.5)
        database_task = asyncio.create_task(self.update_database())
        await asyncio.sleep(1)
        message_task = asyncio.create_task(self.get_all_messages(self.client, self.message, self.message.chat.id, self.message.id, 1))
        try:
            await message_task
            self.index_on_progress = False
            logger.info("Message fetching completed, waiting for database processing to finish")
            await asyncio.sleep(1)
            try:
                await database_task
            except Exception as e:
                logger.error(f"Database processing failed: {e}")
                self.worker_running = False
                
        except Exception as e:
            logger.error(f"Error in indexing process: {e}")
            self.worker_running = False
            raise
        finally:
            if hasattr(self, 'update_task'):
                self.update_task.cancel()
                try:
                    await self.update_task
                except asyncio.CancelledError:
                    pass
        try:
            final_text = f"""✅ <b>Indexing Complete!</b>

📊 <b>Results:</b>
• Total Messages Processed: {self.index}
• File Messages Queued: {self.total_file_messages}
• File Messages Processed: {self.processed_file_messages}
• Non-file Messages: {self.non_file_count}

💾 <b>Database Results:</b>
• Successfully Saved: {self.database}
• Failed to Save: {self.failed_count}
• Skipped (Duplicates): {self.skipped_count}
• Processing Rate: {(self.processed_file_messages/self.total_file_messages*100) if self.total_file_messages > 0 else 0:.1f}%
• Success Rate: {(self.database/self.processed_file_messages*100) if self.processed_file_messages > 0 else 0:.1f}%

🎉 All done!"""
            try:await self.message.edit(final_text)
            except:
                await asyncio.sleep(15)
                await self.message.edit(final_text)
            logger.info(f"Indexing completed: {self.total_file_messages} files queued, {self.processed_file_messages} processed, {self.database} saved, {self.failed_count} failed, {self.skipped_count} skipped")
            
            # Remove this indexer from the cache when completed
            if self.owner_id in active_indexers:
                del active_indexers[self.owner_id]
        except Exception as e:
            logger.error(f"Failed to send completion message: {e}")
            
            # Remove this indexer from the cache on error
            if self.owner_id in active_indexers:
                del active_indexers[self.owner_id]
        

@Client.on_message(filters.regex(r"^/index") & filters.channel)
@round_robin()
async def index_command(client: Client, message: Message) -> None:
    await message.edit("Indexing messages...")
    await asyncio.sleep(1)
    reply_markup = [[InlineKeyboardButton('Index This Chat',callback_data='start_index')]]
    await message.edit("Indexing panel", reply_markup=InlineKeyboardMarkup(reply_markup))


@button(pattern="start_index")
async def index_movie_callback(client: Client, callback: CallbackQuery) -> None:
    bt = ButtonMaker()
    try:
        # Check if user is verified (exists in users list)
        # Only users added by admin can start indexing
        user_id = int(callback.from_user.id)
        user_data = database.Users.getTgUser(user_id)
        
        # If user is not in the database, deny access
        if not user_data:
            await callback.message.edit("❌ <b>Access Denied</b>\n\nOnly verified users can start indexing. Please contact the administrator to be added to the system.")
            logger.warning(f"Unauthorized indexing attempt by user {user_id}")
            return
            
        bt.ibutton("❌ Cancel", 'cancel_indexing')
        keyboard = bt.build_menu()
        await callback.message.edit("🚀 Starting indexing process...", reply_markup=keyboard)
        
        # Add the chat ID to user data as index_chat_id
        database.Users.update_one(
            {"telegram_user_id": str(user_id)},
            {"$set": {"index_chat_id": callback.message.chat.id}},
            upsert=True
        )
        
        indexer = IndexMessages(callback.message, client, str(callback.from_user.id))
        # await indexer.start()
        asyncio.create_task(indexer.start())
    except Exception as e:
        logger.error(f"Error in indexing callback: {e}")
        import traceback
        traceback.print_exc()
        try:
            await callback.message.edit(
                f"❌ <b>Indexing Failed</b>\n\nError: {str(e)}\n\nPlease try again later."
            )
        except:pass

@button(pattern="cancel_indexing",CustomFilters=CustomFilters.authorize(sudo=True))
async def cancel_indexing_callback(client: Client, callback: CallbackQuery) -> None:
    try:
        # Get the indexer for the user who initiated the cancel request
        indexer = active_indexers.get(str(callback.from_user.id))
        if indexer:
            indexer.cancel_indexing()
            
            cancel_text = f"""❌ <b>Indexing Cancelled!</b>

📊 <b>Progress When Stopped:</b>
• Messages Processed: {indexer.index}/{indexer.total}
• Files Processed: {indexer.processed_file_messages}/{indexer.total_file_messages}
• Files Saved: {indexer.database}
• Files Failed: {indexer.failed_count}
• Files Skipped: {indexer.skipped_count}

🚫 Process stopped by user request."""
            
            await callback.message.edit(cancel_text)
            logger.warning(f"Indexing cancelled by user. Progress: {indexer.processed_file_messages}/{indexer.total_file_messages} files processed")
        else:
            await callback.message.edit("❌ <b>No Active Indexing</b>\n\nNo indexing process found to cancel.")
            
    except Exception as e:
        logger.error(f"Error cancelling indexing: {e}")
        try:
            await callback.message.edit("❌ <b>Cancellation Failed</b>\n\nError occurred while cancelling the indexing process.")
        except:
            pass

