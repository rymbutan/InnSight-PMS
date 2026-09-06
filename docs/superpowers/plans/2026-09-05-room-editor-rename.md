# Hotel Room Information Editor Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the "Rooms & Housekeeping" screen to "Hotel Room Information Editor" in the sidebar and the page heading.

**Architecture:** Pure copy change in two React files. No route change, no backend change, no test changes.

**Tech Stack:** React 18, Vite, plain JSX.

**Spec:** `docs/superpowers/specs/2026-09-05-folio-arrivals-room-editor-design.md` §3

## Global Constraints

- The route stays `/rooms`. Do **not** rename the path — existing links, bookmarks and deep links from other pages depend on it. The URL is not the label.
- Exact new string: `Hotel Room Information Editor` (no ampersand, no abbreviation).
- There are exactly **two** occurrences in application code. A repo-wide search confirmed no others; the only other hit is in the spec document itself, which is history and must not be edited.

---

### Task 1: Rename the sidebar label and page heading

**Files:**
- Modify: `web/src/components/Layout.jsx:66`
- Modify: `web/src/pages/Rooms.jsx:150`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task changes only display strings.

- [ ] **Step 1: Confirm the current state of both occurrences**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -rn "Rooms & Housekeeping\|Rooms &amp; Housekeeping" web/src
```

Expected: exactly two lines —

```
web/src/components/Layout.jsx:66:        label: 'Rooms & Housekeeping',
web/src/pages/Rooms.jsx:150:      <h2>Rooms &amp; Housekeeping</h2>
```

If you see a different number of hits, STOP — the file has moved on since this plan was written. Re-run the search without the `&` to find variants before proceeding.

- [ ] **Step 2: Change the sidebar label**

In `web/src/components/Layout.jsx`, inside the `Housekeeping` nav section, change the `/rooms` entry's label. The surrounding object must be left exactly as it is — only the `label` value changes:

```jsx
      {
        to: '/rooms',
        label: 'Hotel Room Information Editor',
        icon: 'bed',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING'],
      },
```

Note `to: '/rooms'` is unchanged. Changing it is the one thing this task must not do.

- [ ] **Step 3: Change the page heading**

In `web/src/pages/Rooms.jsx`, line 150. The old text used `&amp;` because of the ampersand; the new text has no ampersand, so it is a plain string:

```jsx
      <h2>Hotel Room Information Editor</h2>
```

- [ ] **Step 4: Verify both occurrences are gone and the new string is present**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -rn "Rooms & Housekeeping\|Rooms &amp; Housekeeping" web/src; echo "--- old hits above (want none) ---"
grep -rn "Hotel Room Information Editor" web/src
```

Expected: the first grep prints nothing (exit status 1 is correct here). The second prints exactly two lines, one in `Layout.jsx` and one in `Rooms.jsx`.

- [ ] **Step 5: Verify the route still works**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -n "to: '/rooms'" web/src/components/Layout.jsx
grep -n "path=\"/rooms\"\|/rooms" web/src/App.jsx
```

Expected: the nav entry still points at `/rooms`, and `App.jsx` still declares the `/rooms` route. Nothing in `App.jsx` should have been touched by this task.

- [ ] **Step 6: Build the frontend to confirm no syntax error was introduced**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npm run build
```

Expected: build completes successfully. If `npm run build` is not defined or node_modules are absent, fall back to a parse check:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npx --yes esbuild src/pages/Rooms.jsx src/components/Layout.jsx --loader:.jsx=jsx --outdir=/dev/null
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add web/src/components/Layout.jsx web/src/pages/Rooms.jsx
git commit -m "$(cat <<'EOF'
feat: rename Rooms & Housekeeping to Hotel Room Information Editor

Sidebar label and page heading only. The /rooms route is deliberately
unchanged -- renaming the path would break existing links and the deep
links other pages build, and the URL is not the label.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manual verification

1. Start the app (`bash scripts/gen-env.sh` first if `.env` is absent, then `docker compose up -d`; see `README.md`).
2. Sign in as an ADMIN or HOUSEKEEPING user.
3. The sidebar's Housekeeping section should read **Hotel Room Information Editor** where it previously read "Rooms & Housekeeping".
4. Click it. The URL should still be `/rooms`, and the page heading should read **Hotel Room Information Editor**.
5. The two other entries in that nav section — "Hotel Map" and "Amenities & Facilities" — must be unchanged.
