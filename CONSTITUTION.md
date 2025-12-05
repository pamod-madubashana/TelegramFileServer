# Telegram File Server Constitution

## 1. Project Overview

The Telegram File Server is a self-hosted media server application that seamlessly integrates with Telegram bots to provide file storage, organization, and streaming capabilities through a modern web interface. The system supports multi-user access with per-file ownership and access control, making it suitable for both personal and team use.

## 2. Core Architecture

### 2.1 Backend (Python/FastAPI)
- **Framework**: FastAPI for high-performance REST API
- **Telegram Integration**: Pyrogram library for bot interactions
- **Database**: MongoDB for storing file metadata and user information
- **Authentication**: Dual authentication system supporting local accounts and Google OAuth
- **Streaming**: Built-in media streaming capabilities for videos, images, documents, and audio

### 2.2 Frontend (React/TypeScript)
- **Framework**: React with TypeScript for type-safe development
- **UI Library**: shadcn/ui components with TailwindCSS styling
- **Build Tool**: Vite for fast development and building
- **Routing**: React Router for client-side navigation
- **State Management**: React Query for server state management

### 2.3 Database Schema (MongoDB Collections)

#### 2.3.1 Users Collection
- Stores user account information
- Fields: user_id, password_hash, email, telegram_user_id, telegram_username, telegram_profile_picture, created_at, last_active

#### 2.3.2 Files Collection
- Stores file metadata from Telegram
- Fields: chat_id, message_id, file_type, thumbnail, file_unique_id, file_size, file_name, file_caption, file_path, owner_id

#### 2.3.3 Settings Collection
- Application-wide configuration settings
- Fields: key, value pairs for various configuration options

#### 2.3.4 TGCodes Collection
- Temporary verification codes for Telegram authentication
- Fields: user_id, code, expires_at

## 3. System Components

### 3.1 Telegram Integration
- Multiple bot support through TOKEN0, TOKEN1, etc. environment variables
- Automatic file uploading from Telegram to the server
- Media categorization and organization
- User verification through Telegram

### 3.2 File Management
- Virtual folder system (Images, Videos, Documents, Audio, Voice Messages)
- Real folder creation and navigation
- File operations: copy, move, delete, rename
- Path-based file organization with ownership controls

### 3.3 Authentication & Authorization
- Multi-user support with per-file ownership
- Role-based access control (user/admin)
- Session management with secure cookies
- Google OAuth integration

### 3.4 Media Streaming
- Range request support for video streaming
- Adaptive streaming capabilities
- Thumbnail generation for media files
- Direct file downloading

## 4. Technical Specifications

### 4.1 Backend Requirements
- Python 3.12+
- FastAPI web framework
- Pyrogram for Telegram integration
- MongoDB database
- Uvicorn ASGI server

### 4.2 Frontend Requirements
- Node.js 16+
- React 18+
- TypeScript
- Vite build tool
- TailwindCSS for styling

### 4.3 Deployment Options
- Systemd service (Linux)
- Docker containerization
- Heroku deployment support

## 5. Data Flow

1. **File Upload**: Users send files to configured Telegram bots
2. **Processing**: Backend processes and stores file metadata in MongoDB
3. **Access**: Authenticated users access files through the web interface
4. **Streaming/Downloading**: Files are streamed or downloaded directly from Telegram

## 6. Security Model

### 6.1 Access Control
- File ownership restricts access to owners and admins
- Session-based authentication with secure tokens
- Password hashing for local accounts

### 6.2 Data Protection
- HTTPS-only communication in production
- Secure storage of Telegram session data
- Environment-based secret management

## 7. Development Principles

### 7.1 Code Quality
- Type-safe development with TypeScript
- Comprehensive error handling
- Logging for debugging and monitoring
- Modular, maintainable code structure

### 7.2 User Experience
- Responsive design for all device sizes
- Dark/light mode support
- Intuitive file organization
- Real-time feedback for user actions

### 7.3 Performance
- Efficient database queries
- Caching where appropriate
- Asynchronous operations for non-blocking execution
- Optimized media streaming

## 8. Governance

### 8.1 Roles
- **Administrators**: Full system access, user management
- **Users**: Access to their own files and shared content

### 8.2 Maintenance
- Regular dependency updates
- Security patches
- Backup procedures for MongoDB data
- Monitoring and alerting for system health

This constitution serves as the foundational document for the Telegram File Server project, guiding its development, maintenance, and evolution while ensuring consistency with its core principles and architecture.