<!--
Say what this change adds or makes possible. Never describe an unfixed
security weakness here or in a commit; report it privately (SECURITY.md).
Synthetic data only: no customer names, phone numbers or credentials.
-->

## What this adds

Closes # <!-- or "Part of #" when this does not finish the issue -->

## How I checked it

<!-- Commands you ran, pages you opened. -->

## 360 px check

<!--
Chrome DevTools, device toolbar: Responsive, 360 x 640, device type "Mobile"
so touch styles apply (More options > Add device type shows that list).
Open every page this PR changes. If it changes something shared
(src/components/ui, globals.css, a layout), also open a microgrid's
Operations tab, its households list with the Add household dialog, and a
billing period with its Close period dialog. Hovering in the inspector shows
sizes. If one of those pages is removed or renamed, update this list.
-->

- [ ] Nothing renders differently, or I opened at 360 px:
- [ ] The page does not scroll sideways; a wide table scrolls inside its own box
- [ ] Each control this PR adds or changes (button, link, field, menu item, a checkbox with its label) is at least 44 px tall
- [ ] Each dialog this PR opens fits, with its buttons reachable without zooming

## Before merge

<!--
The merger checks these by hand; GitHub does not enforce them. They follow
CLAUDE.md, "Required Merge Controls": when that checklist changes, change
this list with it.
-->

- [ ] `Test`, both `CodeQL` entries and `Build` are green
- [ ] Every commit shows **Verified** and ends with `Signed-off-by:` (`git commit -s`); a merge that only brings in `main` needs no sign-off
- [ ] If this PR changes a path listed in `.github/CODEOWNERS`: approved on the final head commit by a code owner who did not push that change
- [ ] Merged by squash or merge commit, never by rebase
