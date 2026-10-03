# Substack digest interests

Copy this file to `$SUBSTACK_DIGEST_DIR/interests.md` and edit it. `digest_begin` passes it to the model on every run, if it exists, to rank the "Read in full" picks; only the first 4,000 characters are shown. If the headline classifier is on (`SUBSTACK_CLASSIFIER`), it ranks every post against the two sections below. A file without these headings still works: all of it is treated as Interests.

## Interests
What you want more of. The classifier ranks posts by how well they fit this.
- Topics you most want to see picked: e.g. software engineering, AI research, economics
- Writers or publications whose posts should rank higher

## Skip
Kinds of post you never want to read, judged by intent, not exact wording. With the classifier on, posts it's confident match are left out of the reading list and counted at the end of the digest. Leave this section out to skip nothing.
- e.g. Podcast episode show notes with no written content
- e.g. Link roundups with no commentary
