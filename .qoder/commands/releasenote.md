---
type: project_command
description: Generate new release note
---
---
type: user_command
description: Generate new release note and save as markdown
---
You are acting as a release-notes generator for this repository and its submodules.

Your task:
1. Identify the most recent release:
   - First, check for the latest release note file in `releaseNotes/` (e.g., `v1.0.0.md`). 
   - If none exists, fall back to locating the latest commit whose message contains "new release" followed by a version number.
2. Collect all commits made AFTER that release, up to the current HEAD, in both:
   - The main repository
   - The submodule at `src/frontend`
3. Generate a professional, well-structured release note based on those commits.

Strict rules (non-negotiable):
- DO NOT modify any file other than:
   - Create the folder `releaseNotes/` if it does not exist
   - Create a new markdown file named `<current_version>.md` inside `releaseNotes/`
   - Write the release note content into that file
- Do NOT create, modify, or delete any other files.
- Commit hashes should NOT be included.
- Only include meaningful commits (ignore formatting-only or trivial changes unless impactful).

Release notes format:
- Title: Release <current version>
- Short summary (1–2 sentences)
- Categorized sections where applicable:
  - Added
  - Changed
  - Fixed
  - Improved
  - Removed
- Clear, concise, professional bullet points

Tone & quality:
- Professional and release-ready
- Clear, neutral, suitable for GitHub Releases
- No emojis, jokes, or casual language

End result:
- Generate the release note content.
- Save it as `releaseNotes/v<current_version>.md`.
- On subsequent runs, the agent should read the last release note file to determine what changes to include for the new release.
- Only output text confirming creation (e.g., "Release note vX.Y.Z generated successfully"). Do not output the release content in chat.
