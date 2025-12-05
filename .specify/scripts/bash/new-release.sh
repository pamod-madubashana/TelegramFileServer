#!/bin/bash

# New Release Automation Script

# Function to show help
show_help() {
    echo "Usage: ./new-release.sh [--version <version>] [--release-notes <notes>]"
    echo ""
    echo "Options:"
    echo "  --version <version>       Specify the version number (e.g., 1.0.0)"
    echo "  --release-notes <notes>   Specify the release notes"
    echo "  --help                    Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./new-release.sh --version '1.0.0' --release-notes 'Initial release'"
    echo "  ./new-release.sh  # Will prompt for version and release notes"
}

# Parse command line arguments
VERSION=""
RELEASE_NOTES=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --version)
            VERSION="$2"
            shift 2
            ;;
        --release-notes)
            RELEASE_NOTES="$2"
            shift 2
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# If version or release notes are not provided, prompt the user
if [ -z "$VERSION" ]; then
    read -p "What version would you like to release? " VERSION
fi

if [ -z "$RELEASE_NOTES" ]; then
    read -p "What are the release notes? " RELEASE_NOTES
fi

# Update the VERSION file
VERSION_FILE_PATH="src/frontend/VERSION"
echo "$VERSION" > "$VERSION_FILE_PATH"

# Stage the VERSION file
git add "$VERSION_FILE_PATH"

# Create the commit with proper formatting
COMMIT_MESSAGE="new release $VERSION

$RELEASE_NOTES"
git commit -m "$COMMIT_MESSAGE"

# Show the status
git status

echo "Release $VERSION has been prepared successfully!"
echo "To push the release, run: git push"