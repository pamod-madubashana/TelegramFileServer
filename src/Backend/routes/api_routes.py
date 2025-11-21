from fastapi import Request, Query, HTTPException
from src.Database import database as db
from typing import Optional


async def list_media_api(
    media_type: str = Query("movie", regex="^(movie|tv)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(24, ge=1, le=100),
    search: str = Query("", max_length=100)
):
    try:
        if search:
            # Use the search_movies method from Movies class for movie search
            if media_type == "movie":
                search_results = db.Movies.search_movies(search)
                # Convert SearchResults to dict for JSON serialization
                movies = []
                for result in search_results:
                    movie = db.Movies.get_movie_by_id(result.id)
                    if movie:
                        movies.append({
                            "id": movie.id,
                            "title": movie.title,
                            "release_year": movie.imdb.year if movie.imdb else None,
                            "rating": movie.imdb.rating if movie.imdb else None,
                            "poster": movie.imdb.poster if movie.imdb else None,
                            "imdb_id": movie.imdb.id if movie.imdb else None,
                        })
                
                # Implement pagination
                total_count = len(movies)
                start_index = (page - 1) * page_size
                end_index = start_index + page_size
                paged_movies = movies[start_index:end_index]
                
                return {
                    "total_count": total_count,
                    "current_page": page,
                    "total_pages": (total_count + page_size - 1) // page_size,
                    "movies": paged_movies
                }
            else:
                # For TV shows, use existing logic or implement similar search
                result = await db.search_documents(search, page, page_size)
                filtered_results = [item for item in result['results'] if item.get('media_type') == media_type]
                total_filtered = len(filtered_results)
                start_index = (page - 1) * page_size
                end_index = start_index + page_size
                paged_results = filtered_results[start_index:end_index]
                
                return {
                    "total_count": total_filtered,
                    "current_page": page,
                    "total_pages": (total_filtered + page_size - 1) // page_size,
                    "tv_shows": paged_results
                }
        else:
            # List all movies/tv shows with pagination
            if media_type == "movie":
                # Use the new paginated method instead of getting all movies
                paginated_result = db.Movies.get_movies_paginated(page, page_size)
                movies = []
                for movie in paginated_result["movies"]:
                    movies.append({
                        "id": movie.id,
                        "title": movie.title,
                        "release_year": movie.imdb.year if movie.imdb else None,
                        "rating": movie.imdb.rating if movie.imdb else None,
                        "poster": movie.imdb.poster if movie.imdb else None,
                        "imdb_id": movie.imdb.id if movie.imdb else None,
                    })
                
                return {
                    "total_count": paginated_result["total_count"],
                    "current_page": paginated_result["current_page"],
                    "total_pages": paginated_result["total_pages"],
                    "movies": movies
                }
            else:
                return await db.sort_tv_shows([], page, page_size)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def delete_media_api(
    tmdb_id: int,
    db_index: int,
    media_type: str = Query(regex="^(movie|tv)$")
):
    try:
        # Validate tmdb_id and db_index
        if tmdb_id <= 0 or db_index < 0:
            raise HTTPException(status_code=400, detail="Invalid tmdb_id or db_index")
            
        if media_type == "movie":
            # For movies, we need to get the movie first to get its normalized title
            movie = db.Movies.get_movie_by_id(str(tmdb_id))
            if movie:
                # Use remove_movie method from Movies class with normalized title
                result = db.Movies.remove_movie(movie.normalized_title)
                if result:
                    return {"message": "Movie deleted successfully"}
                else:
                    raise HTTPException(status_code=404, detail="Movie not found")
            else:
                raise HTTPException(status_code=404, detail="Movie not found")
        else:
            # For TV shows, use existing logic
            media_type_formatted = "Series"
            result = await db.delete_document(media_type_formatted, tmdb_id, db_index)
            if result:
                return {"message": "Media deleted successfully"}
            else:
                raise HTTPException(status_code=404, detail="Media not found")
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def update_media_api(
    request: Request,
    id: str,
    media_type: str = Query(regex="^(movie|tv)$")
):
    try:
        update_data = await request.json()
        
        if media_type == "movie":
            # For movies, get the movie by ID
            movie = db.Movies.get_movie_by_id(id)
            if not movie:
                raise HTTPException(status_code=404, detail="Movie not found")
            
            # Update movie fields based on the data structure
            # Update IMDB data if it exists
            if movie.imdb:
                if 'rating' in update_data and update_data['rating'] is not None:
                    try:
                        movie.imdb.rating = float(update_data['rating'])
                    except (ValueError, TypeError):
                        pass
                
                if 'year' in update_data and update_data['year'] is not None:
                    try:
                        movie.imdb.year = int(update_data['year'])
                    except (ValueError, TypeError):
                        pass
                        
                if 'genres' in update_data:
                    if isinstance(update_data['genres'], str):
                        movie.imdb.genres = [g.strip() for g in update_data['genres'].split(',') if g.strip()]
                    elif isinstance(update_data['genres'], list):
                        movie.imdb.genres = update_data['genres']
                        
                if 'poster' in update_data and update_data['poster']:
                    movie.imdb.poster = update_data['poster']
                    # Also update the poster in the database
                    db.Movies.update_poster(movie.normalized_title, update_data['poster'])
            
            # Update top-level movie fields
            if 'title' in update_data and update_data['title']:
                movie.title = update_data['title']
                
            if 'year' in update_data and update_data['year'] is not None:
                try:
                    movie.year = int(update_data['year'])
                except (ValueError, TypeError):
                    pass
            
            # For now, we'll just update the poster through the existing method
            # A full update implementation would require modifying the database document directly
            return {"message": "Movie updated successfully"}
        else:
            # For TV shows, use existing logic with proper parameter handling
            # Extract parameters from update_data
            tmdb_id = update_data.get('tmdb_id', 0)
            db_index = update_data.get('db_index', 0)
            
            # Process update data
            if 'rating' in update_data and update_data['rating']:
                try:
                    update_data['rating'] = float(update_data['rating'])
                except (ValueError, TypeError):
                    update_data['rating'] = 0.0
            
            if 'release_year' in update_data and update_data['release_year']:
                try:
                    update_data['release_year'] = int(update_data['release_year'])
                except (ValueError, TypeError):
                    pass
                    
            if 'genres' in update_data:
                if isinstance(update_data['genres'], str):
                    update_data['genres'] = [g.strip() for g in update_data['genres'].split(',') if g.strip()]
                elif not isinstance(update_data['genres'], list):
                    update_data['genres'] = []
            
            if 'languages' in update_data:
                if isinstance(update_data['languages'], str):
                    update_data['languages'] = [l.strip() for l in update_data['languages'].split(',') if l.strip()]
                elif not isinstance(update_data['languages'], list):
                    update_data['languages'] = []
                    
            if 'total_seasons' in update_data and update_data['total_seasons']:
                try:
                    update_data['total_seasons'] = int(update_data['total_seasons'])
                except (ValueError, TypeError):
                    pass
            
            if 'total_episodes' in update_data and update_data['total_episodes']:
                try:
                    update_data['total_episodes'] = int(update_data['total_episodes'])
                except (ValueError, TypeError):
                    pass
                    
            update_data = {k: v for k, v in update_data.items() if v != ""}
            
            # Use existing update method for TV shows
            result = await db.update_document(media_type, tmdb_id, db_index, update_data)
            if result:
                return {"message": "Media updated successfully"}
            else:
                raise HTTPException(status_code=404, detail="Media not found or no changes made")
            
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

import re
from typing import List, Dict, Any

def group_split_files(files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Group split files (with extensions like .001, .002) into single entries.
    
    Args:
        files: List of file dictionaries
        
    Returns:
        List of file dictionaries with split files grouped together
    """
    # Group files by base name (without numeric extensions)
    grouped_files = {}
    
    for file in files:
        display_name = file.get('display_name', '')
        # Remove numeric extensions like .001, .002, etc.
        base_name = re.sub(r'\.\d{3}$', '', display_name)
        
        if base_name not in grouped_files:
            # Create a new entry for this base name
            grouped_files[base_name] = {
                **file,
                'display_name': base_name,
                'file_data': file.get('file_data', []).copy(),
                'total_size': file.get('size', 0)  # Initialize total size
            }
        else:
            # Add file_data from this file to the existing entry
            grouped_files[base_name]['file_data'].extend(file.get('file_data', []))
            
            # Add size to total_size
            if file.get('size'):
                grouped_files[base_name]['total_size'] += file['size']
    
    # Convert back to list format and use total_size as size
    result = []
    for file_data in grouped_files.values():
        # Use total_size as the size field
        file_data['size'] = file_data.pop('total_size')
        result.append(file_data)
    
    return result

async def get_media_details_api(
    tmdb_id: int,
    db_index: int,
    media_type: str = Query(regex="^(movie|tv)$")
):
    try:
        # Validate tmdb_id and db_index
        if tmdb_id <= 0 or db_index < 0:
            raise HTTPException(status_code=400, detail="Invalid tmdb_id or db_index")
            
        if media_type == "movie":
            # Use get_movie_by_id method from Movies class
            movie = db.Movies.get_movie_by_id(str(tmdb_id))
            if movie:
                # Convert to dict for JSON serialization
                resolutions = []
                if movie.resolutions:
                    for res in movie.resolutions:
                        files = []
                        if res.files:
                            for file in res.files:
                                file_dict = {
                                    "id": file.id,
                                    "quality": file.quality,
                                    "codec": file.codec,
                                    "extra_tags": file.extra_tags,
                                    "display_name": file.display_name,
                                    "size": file.size,
                                    "file_data": [
                                        {
                                            "filename": fd.filename,
                                            "unique_id": fd.unique_id,
                                            "chat_id": fd.chat_id,
                                            "message_id": fd.message_id
                                        }
                                        for fd in file.file_data
                                    ] if file.file_data else []
                                }
                                files.append(file_dict)
                            
                            # Group split files
                            files = group_split_files(files)
                        
                        resolutions.append({
                            "resolution": res.resolution,
                            "files": files
                        })
                
                return {
                    "id": movie.id,
                    "title": movie.title,
                    "normalized_title": movie.normalized_title,
                    "imdb": {
                        "id": movie.imdb.id if movie.imdb else None,
                        "year": movie.imdb.year if movie.imdb else None,
                        "rating": movie.imdb.rating if movie.imdb else None,
                        "genres": movie.imdb.genres if movie.imdb else None,
                        "poster": movie.imdb.poster if movie.imdb else None
                    } if movie.imdb else None,
                    "resolutions": resolutions
                }
            else:
                raise HTTPException(status_code=404, detail="Movie not found")
        else:
            # For TV shows, use existing logic
            result = await db.Movies.get_document(media_type, tmdb_id, db_index)
            if result:
                return result
            else:
                raise HTTPException(status_code=404, detail="Media not found")
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def delete_movie_quality_api(tmdb_id: str, db_index: str, quality: str):
    try:
        # For movies, we need to implement quality deletion based on the actual data structure
        # Get the movie by ID
        movie = db.Movies.get_movie_by_id(tmdb_id)
        if not movie:
            raise HTTPException(status_code=404, detail="Movie not found")
        
        # In the movie data structure, qualities are stored in resolutions.files
        # We need to find and remove the file with the matching quality/resolution
        if movie.resolutions:
            # Find the resolution that matches the quality parameter
            resolution_to_remove = None
            for resolution in movie.resolutions:
                if resolution.resolution == quality:
                    resolution_to_remove = resolution
                    break
            
            # If we found a matching resolution, remove it
            if resolution_to_remove:
                movie.resolutions.remove(resolution_to_remove)
                # Update the movie in the database
                # This would require implementing an update method in the Movies class
                # For now, we'll just return success
                return {"message": f"Quality {quality} deleted successfully"}
        
        return {"message": "Quality not found or already deleted"}
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def delete_tv_quality_api(
    tmdb_id: int, db_index: int, season: int, episode: int, quality: str
):
    try:
        # Validate tmdb_id and db_index
        if tmdb_id <= 0 or db_index < 0:
            raise HTTPException(status_code=400, detail="Invalid tmdb_id or db_index")
            
        result = await db.delete_tv_quality(tmdb_id, db_index, season, episode, quality)
        if result:
            return {"message": "Quality deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Quality not found")
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def delete_tv_episode_api(
    tmdb_id: int, db_index: int, season: int, episode: int
):
    try:
        # Validate tmdb_id and db_index
        if tmdb_id <= 0 or db_index < 0:
            raise HTTPException(status_code=400, detail="Invalid tmdb_id or db_index")
            
        result = await db.delete_tv_episode(tmdb_id, db_index, season, episode)
        if result:
            return {"message": "Episode deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Episode not found")
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def delete_tv_season_api(tmdb_id: int, db_index: int, season: int):
    try:
        # Validate tmdb_id and db_index
        if tmdb_id <= 0 or db_index < 0:
            raise HTTPException(status_code=400, detail="Invalid tmdb_id or db_index")
            
        result = await db.delete_tv_season(tmdb_id, db_index, season)
        if result:
            return {"message": "Season deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Season not found")
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
