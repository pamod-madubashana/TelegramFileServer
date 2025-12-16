---
description: Create a new release by updating version and committing to the frontend submodule
---
# New Release Command

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Important Note
⚠️ **CRITICAL**: `src/frontend` is a **Git submodule** (separate repository). This command commits and pushes **ONLY to the submodule**, NOT to the main TelegramFileServer repository.

## Instructions

1. **Ask for version and release notes**
   - Prompt user: "What version number? (e.g., 1.0.0)"
   - Prompt user: "What are the release notes?"

2. **Update the VERSION file in the submodule**
   - Read the current version from `src/frontend/VERSION`
   - Validate the new version string format (e.g., 1.0.0)
   - Replace the existing content with the new version value
   - Ensure no trailing spaces or extra lines are added
   - Save the file

3. **Commit and push to the SUBMODULE repository (src/frontend) not main repo**
   - Run: `cd src/frontend`
   - Run: `git add .`
   - Run: `git commit -m "new release {version}\n\n{releaseNotes}"`
   - Run: `git push`
   - ✅ Inform user: "Successfully committed and pushed to src/frontend submodule."

4. **Remind user about main repository**
   - ⚠️ Inform user: "Note: The main TelegramFileServer repository was NOT modified. If you need to update the submodule reference in the main repo, you must commit it separately."

## Files involved
- `src/frontend/VERSION` - Version file in the submodule (automatically updated)
- `.github/workflows/tauri.yml` - GitHub Actions workflow that reads the version

## Technical Details
- Uses `git -C src/frontend` to execute git commands in the submodule directory
- This ensures commits go to the submodule, not the parent repository
- The `-C` flag changes git's working directory for that specific command