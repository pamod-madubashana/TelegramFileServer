#!/bin/bash
set -e

# Get the absolute path of the current directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PATH="$PROJECT_DIR/.venv"
REQUIREMENTS="$PROJECT_DIR/requirements.txt"
MAIN_FILE="$PROJECT_DIR/__main__.py"
SERVICE_NAME="telegram-file-server"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

# Create venv if not exists
if [ ! -d "$VENV_PATH" ]; then
    python3 -m venv "$VENV_PATH"
fi

source "$VENV_PATH/bin/activate"
pip install --upgrade pip


if ! pip install -r "$REQUIREMENTS" > /dev/null 2>&1; then
    echo "Installation failed! Retrying with system packages..."
    apt-get update && \
        apt-get install -y gcc libffi-dev build-essential && \
        rm -rf /var/lib/apt/lists/*
    apt-get update && apt-get install -y gcc libffi-dev build-essential
    pip install -r "$REQUIREMENTS"
fi

# Function to create systemd service
create_service() {
    echo "Creating systemd service for $SERVICE_NAME..."
    
    # Create service file
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Telegram File Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)

WorkingDirectory=$PROJECT_DIR

Environment=PATH=$VENV_PATH/bin
Environment="GIT_PYTHON_GIT_EXECUTABLE=/usr/bin/git"
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment=PATH=$VENV_PATH/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ExecStart=/usr/bin/script -q -c "$VENV_PATH/bin/python $MAIN_FILE" /dev/null

Restart=on-failure
RestartSec=10
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=60
SendSIGKILL=no

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

# Security settings (relaxed for proper functionality)
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=full
ReadWritePaths=$PROJECT_DIR

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd and enable service
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    
    echo "Service $SERVICE_NAME created and enabled for auto-start on boot."
    echo "Use the following commands to manage the service:"
    echo "  Start:   sudo systemctl start $SERVICE_NAME"
    echo "  Stop:    sudo systemctl stop $SERVICE_NAME"
    echo "  Status:  sudo systemctl status $SERVICE_NAME"
    echo "  Logs:    journalctl -u $SERVICE_NAME -f -o cat"
}

# Function to install the prime command
install_prime_command() {
    echo "Installing prime command..."
    
    # Create the prime command script
    sudo tee "/usr/local/bin/prime" > /dev/null <<'EOF'
#!/usr/bin/env python3
"""
Prime - Easy command line interface for Telegram File Server
"""

import sys
import subprocess
import os
import signal
import time

SERVICE_NAME = "telegram-file-server"

def run_command(cmd):
    """Run a systemctl command and print the result"""
    try:
        result = subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True)
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
    except subprocess.CalledProcessError as e:
        if e.stdout:
            print(e.stdout)
        if e.stderr:
            print(f"Error: {e.stderr}", file=sys.stderr)
        else:
            print(f"Error running command: {cmd}", file=sys.stderr)

def send_sigint_to_service():
    """Send SIGINT signal to the service process"""
    try:
        # Get the main process ID of the service
        result = subprocess.run(f"systemctl show -p MainPID {SERVICE_NAME} | cut -d= -f2", 
                               shell=True, check=True, capture_output=True, text=True)
        pid = result.stdout.strip()
        
        if pid and pid != "0":
            # Send SIGINT signal (same as Ctrl+C)
            os.kill(int(pid), signal.SIGINT)
            print(f"Sent SIGINT signal to process {pid}")
            return True
        else:
            print("Service is not running or PID not found")
            return False
    except Exception as e:
        print(f"Error sending SIGINT signal: {e}")
        return False

def show_help():
    """Display help information"""
    help_text = """Prime - Telegram File Server Manager

Usage: prime [command]

Commands:
  start     - Start the service
  stop      - Stop the service (sends SIGINT for graceful shutdown)
  restart   - Restart the service (sends SIGINT for graceful shutdown then starts)
  status    - Show service status
  logs      - Follow service logs
  help      - Show this help message

Examples:
  prime start   - Start the bot service
  prime logs    - View real-time logs
  prime status  - Check if the bot is running
"""
    print(help_text)

def main():
    if len(sys.argv) < 2:
        show_help()
        return

    command = sys.argv[1].lower()

    if command == "help":
        show_help()
    elif command == "start":
        print("Starting Telegram File Server service...")
        run_command(f"systemctl start {SERVICE_NAME}")
        run_command(f"systemctl status {SERVICE_NAME} --no-pager")
    elif command == "stop":
        print("Stopping Telegram File Server service (sending SIGINT)...")
        if send_sigint_to_service():
            # Wait for graceful shutdown (up to 30 seconds)
            print("Waiting for graceful shutdown...")
            time.sleep(5)  # Give 5 seconds for initial shutdown
            # Check if service is still running
            for i in range(25):  # Check every second for 25 more seconds
                result = subprocess.run(f"systemctl is-active {SERVICE_NAME}", 
                                       shell=True, capture_output=True, text=True)
                if result.stdout.strip() != "active":
                    print("Service stopped gracefully")
                    return
                time.sleep(1)
            # If still running after 30 seconds, force stop
            print("Graceful shutdown taking too long, forcing stop...")
            run_command(f"systemctl stop {SERVICE_NAME}")
        else:
            # Fallback to systemctl stop if SIGINT fails
            run_command(f"systemctl stop {SERVICE_NAME}")
    elif command == "restart":
        print("Restarting Telegram File Server service...")
        print("Stopping service (sending SIGINT)...")
        if send_sigint_to_service():
            # Wait for graceful shutdown (up to 30 seconds)
            print("Waiting for graceful shutdown...")
            time.sleep(5)  # Give 5 seconds for initial shutdown
            # Check if service is still running
            for i in range(25):  # Check every second for 25 more seconds
                result = subprocess.run(f"systemctl is-active {SERVICE_NAME}", 
                                       shell=True, capture_output=True, text=True)
                if result.stdout.strip() != "active":
                    print("Service stopped gracefully")
                    break
                time.sleep(1)
        else:
            # Fallback to systemctl stop if SIGINT fails
            run_command(f"systemctl stop {SERVICE_NAME}")
        
        # Start the service again
        print("Starting service...")
        run_command(f"systemctl restart {SERVICE_NAME}")
        run_command(f"systemctl status {SERVICE_NAME} --no-pager")
    elif command == "status":
        run_command(f"systemctl status {SERVICE_NAME} --no-pager")
    elif command == "logs":
        print("Following Telegram File Server logs (Press Ctrl+C to exit)...")
        try:
            subprocess.run(f"journalctl -u {SERVICE_NAME} -f -o cat", shell=True)
        except KeyboardInterrupt:
            print("\nStopped following logs.")
    else:
        print(f"Unknown command: {command}")
        show_help()

if __name__ == "__main__":
    main()
EOF

    # Make the prime command executable
    sudo chmod +x "/usr/local/bin/prime"
    
    echo "Prime command installed successfully!"
    echo "You can now use: prime [start|stop|restart|status|logs|help]"
}

# Check if service already exists
if [ -f "$SERVICE_FILE" ]; then
    echo "Service $SERVICE_NAME already exists. Skipping service creation."
else
    create_service
fi

# Install the prime command
install_prime_command

# Run your main bot
if [ "$1" = "--service" ]; then
    echo "Starting $SERVICE_NAME service..."
    sudo systemctl start "$SERVICE_NAME"
    sudo systemctl status "$SERVICE_NAME"
else
    echo "Running bot directly..."
    script -q -c "python3 $MAIN_FILE" /dev/null
fi