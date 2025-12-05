---
description: Automate the release process by updating version file and creating commits
---
# New Release Command

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Instructions

1. **Ask for version and release notes**
   - Prompt user: "What version number? (e.g., 1.0.0)"
   - Prompt user: "What are the release notes?"

2. **Update the VERSION file**
   - Read the current version from `src/frontend/VERSION`
   - Validate the new version string format (e.g., 1.0.0)
   - Replace the existing content with the new version value
   - Ensure no trailing spaces or extra lines are added
   - Save the file

3. **Create the commit**
   - Run: `cd src/frontend`
   - Run: `git add .`
   - Run: `git commit -m "new release {version}\n\n{releaseNotes}"`
   - Run: `git push`
   - Run: `cd ../..`

## Files involved
- `src/frontend/VERSION` - Contains the current version number (automatically updated)
- `.github/workflows/tauri.yml` - GitHub Actions workflow that reads the version