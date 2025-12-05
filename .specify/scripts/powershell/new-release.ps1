#!/usr/bin/env pwsh
# New Release Automation Script

[CmdletBinding()]
param(
    [string]$Version,
    [string]$ReleaseNotes,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# Show help if requested
if ($Help) {
    Write-Host "Usage: ./new-release.ps1 [-Version <version>] [-ReleaseNotes <notes>]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Version <version>       Specify the version number (e.g., 1.0.0)"
    Write-Host "  -ReleaseNotes <notes>    Specify the release notes"
    Write-Host "  -Help                    Show this help message"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  ./new-release.ps1 -Version '1.0.0' -ReleaseNotes 'Initial release'"
    Write-Host "  ./new-release.ps1  # Will prompt for version and release notes"
    exit 0
}

# If version or release notes are not provided, prompt the user
if (-not $Version) {
    $Version = Read-Host "What version would you like to release?"
}

if (-not $ReleaseNotes) {
    $ReleaseNotes = Read-Host "What are the release notes?"
}

cd src/frontend

# Update the VERSION file
$versionFilePath = "VERSION"

Set-Content -Path $versionFilePath -Value $Version

# Stage the VERSION file
git add $versionFilePath

# Create the commit with proper formatting
$commitMessage = "new release $Version`n`n$ReleaseNotes"
git commit -m $commitMessage

# Show the status
git status

# Push the changes
git push

Write-Host "Release $Version has been prepared successfully!" -ForegroundColor Green
Write-Host "To push the release, run: git push" -ForegroundColor Yellow