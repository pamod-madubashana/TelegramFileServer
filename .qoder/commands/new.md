---
description: Automate the release process by updating version file and creating commits
args:
  version:
    type: string
    required: true
  releaseNotes:
    type: string
    required: true
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
   - go to frontend `cd src/frontend` !Important . you are currenty in Root , you must go to src/frontend to execute this
   - Update the `VERSION` file with the new version
   - Stage the VERSION file with `git add VERSION`
   - Create a commit with `git commit -m "new release {version}\n\n{release notes}"`
   - The commit is ready to be pushed with `git push`


## What happens when you run this command
1. You run `/new`
2. System prompts for version and release notes
3. The system executes the appropriate script based on your platform:
   ```bash
   # Update version file
   echo "{version}" > VERSION
   
   # Stage the file
   git add VERSION
   
   # Commit with proper message format
   git commit -m "new release {version}

   {release notes}"
   
   # Show status
   git status
   ```
4. When you push with `git push`, this triggers the GitHub Actions workflow that:
   - Reads the version from `VERSION`
   - Uses the commit body as release notes
   - Creates a GitHub release
