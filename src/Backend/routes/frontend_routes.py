# # src/Backend/routes/frontend_routes.py

# from fastapi import APIRouter, Request, Response
# from fastapi.responses import HTMLResponse
# import os

# router = APIRouter()

# @router.get("/{full_path:path}")
# async def serve_frontend(request: Request, full_path: str):
#     # Don't serve frontend for API routes
#     if full_path.startswith(("auth/", "files/", "folders/", "system/", "user/", "users/", "dl/", "watch/", "api/")):
#         # Let the API routers handle these routes
#         return Response(status_code=404)
    
#     current_dir = os.path.dirname(os.path.abspath(__file__))
#     # Navigate to the frontend build directory
#     frontend_dir = os.path.join(current_dir, "..", "..", "Frontend", "dist")
    
#     # If we're in development mode, serve the Vite development server
#     # Check if we're in development by looking for the vite config
#     vite_config = os.path.join(current_dir, "..", "..", "Frontend", "vite.config.ts")
#     if os.path.exists(vite_config):
#         # In development, we still need to serve the index.html for client-side routing
#         # The Vite proxy will handle API requests, but we need to serve the frontend for all routes
#         # Try to serve the index.html from the frontend/src directory for development
#         dev_index = os.path.join(current_dir, "..", "..", "Frontend", "index.html")
#         if os.path.exists(dev_index):
#             with open(dev_index, "r", encoding="utf-8") as f:
#                 content = f.read()
#                 return Response(content=content, media_type="text/html")
#         # If that doesn't work, fall through to the dist directory check
    
#     # Try to serve the built frontend files
#     if os.path.exists(frontend_dir):
#         index_file = os.path.join(frontend_dir, "index.html")
#         if os.path.exists(index_file):
#             with open(index_file, "r", encoding="utf-8") as f:
#                 content = f.read()
#                 return Response(content=content, media_type="text/html")
    
#     # Fallback to a simple response that serves the frontend for client-side routing
#     return Response(
#         content="""
#         <!DOCTYPE html>
#         <html>
#         <head>
#             <title>File Server</title>
#         </head>
#         <body>
#             <div id="root"></div>
#             <script type="module" src="/src/main.tsx"></script>
#         </body>
#         </html>
#         """,
#         media_type="text/html"
#     )