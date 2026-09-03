# How diffs order their files

Diff views put the files that best explain a change first, instead of listing everything
alphabetically. Source files come before the tests that cover them, ordered so that a file appears
after the files it imports — you read the foundation of a change before the code built on it.
Tests sit next in line, sorted to follow the source they cover, and generated output such as
lockfiles, snapshots, and build artifacts comes last.

Files that are not source code are labeled: a muted **tests** or **generated** tag appears beside
the filename so you can see at a glance which part of the diff you are in. Generated files also
start collapsed, on top of respecting your repository's own `.gitattributes` — any path marked
`linguist-generated` is treated as generated even when its name gives nothing away.

This ordering applies to turn diffs, working-tree and branch diffs, and pull request review on web
and desktop, and to the review sheet on mobile. The changed-files card in the chat timeline also
uses it when picking which files to show in its collapsed preview, so a turn is fronted by the
source it changed rather than a test or a lockfile.

## Switching back to alphabetical

Prefer a predictable A-to-Z list? The diff panel and the pull request Code tab each have a sort
toggle in their toolbar, next to the stacked/split view control. Turn it off to sort files
alphabetically by path and hide the tier tags; turn it on to return to relevance ordering. One
choice covers both views and is remembered on that device.
