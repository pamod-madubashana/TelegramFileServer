---
description: Automate the release process by updating version file and creating commits
args:
  version:
    type: string
    required: true
  releaseNotes:
    type: string
    required: true

scripts:
  sh: .specify/scripts/bash/new-release.sh --version "{version}" --release-notes "{releaseNotes}"
  ps: .specify/scripts/powershell/new-release.ps1 -Version "{version}" -ReleaseNotes "{releaseNotes}"

---
# New Release Command

## Command
```
/new
```

## Description
Automates the entire release process by updating the version file, committing changes, and preparing for release.

## Usage
1. Run this command when you want to create a new release
2. The system will prompt you for:
   - Version number (e.g., 1.0.0)
   - Release notes
3. This will automatically:
   - Update the `src/frontend/VERSION` file with the new version
   - Stage the VERSION file with `git add src/frontend/VERSION`
   - Create a commit with `git commit -m "new release {version}\n\n{release notes}"`
   - The commit is ready to be pushed with `git push`

## Scripts
The automation is handled by platform-specific scripts:
- PowerShell: `.specify/scripts/powershell/new-release.ps1`
- Bash: `.specify/scripts/bash/new-release.sh`

## What happens when you run this command
1. You run `/new`
2. System prompts for version and release notes
3. The system executes the appropriate script based on your platform:
   ```bash
   # Update version file
   echo "{version}" > src/frontend/VERSION
   
   # Stage the file
   git add src/frontend/VERSION
   
   # Commit with proper message format
   git commit -m "new release {version}

   {release notes}"
   
   # Show status
   git status
   ```
4. When you push with `git push`, this triggers the GitHub Actions workflow that:
   - Reads the version from `src/frontend/VERSION`
   - Uses the commit body as release notes
   - Creates a GitHub release

## Example workflow
1. You run: `/new`
2. System asks: "What version would you like to release?" -> You respond: "1.0.0"
3. System asks: "What are the release notes?" -> You respond: "This release includes bug fixes"
4. System automatically executes:
   ```bash
   # Update version file
   echo "1.0.0" > src/frontend/VERSION
   
   # Stage the file
   git add src/frontend/VERSION
   
   # Commit with proper message format
   git commit -m "new release 1.0.0

   This release includes bug fixes"
   
   # Show status
   git status
   ```
5. The commit is created and ready to be pushed with `git push`

## Files involved
- `src/frontend/VERSION` - Contains the current version number (automatically updated)
- `.github/workflows/tauri.yml` - GitHub Actions workflow that reads the version
- `.specify/scripts/powershell/new-release.ps1` - PowerShell automation script
- `.specify/scripts/bash/new-release.sh` - Bash automation script