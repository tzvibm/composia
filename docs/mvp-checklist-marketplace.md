# Checklist Marketplace — MVP Product Design

## What Is This

A marketplace where people browse, subscribe to, and complete checklists.
Think "app store for lists" — someone publishes "First-Time Home Buyer Checklist",
thousands subscribe, each tracks their own progress and adds personal notes/photos.

---

## User Stories

### Browser
- Browse lists by category (Travel, Home, Learning, Fitness, ...)
- See list preview: title, description, item count, subscriber count, creator
- Search lists by keyword

### Subscriber
- Subscribe to a list → appears in "My Lists"
- See my personalized view of the list (my progress, my notes, my items)
- Check off items → track progress (7/23 complete)
- Add personal notes, photos, or links to any item
- Add my own items to a subscribed list (only I see them)
- Unsubscribe

### Creator
- Create a new list with items (nested/grouped)
- Publish to marketplace (or keep private)
- Edit list structure and items
- See subscriber count

### Social
- Comment on a list or specific item
- See others' comments

---

## Product API

All endpoints prefixed with `/api`. Auth via JWT Bearer token.

### Auth

```
POST   /auth/register          { email, password, display_name }
POST   /auth/login             { email, password } → { token }
GET    /me                     → user profile
PATCH  /me                     → update profile
```

### Marketplace (public, no auth required)

```
GET    /marketplace/lists                    → paginated browse
GET    /marketplace/lists?q=travel           → search
GET    /marketplace/lists?category=home      → filter by category
GET    /marketplace/categories               → list all categories
GET    /marketplace/lists/:listId            → list detail + items (read-only)
```

### My Lists (auth required)

```
GET    /lists                                → my created + subscribed lists
POST   /lists                                → create a new list
GET    /lists/:listId                        → my personalized view (resolved)
PATCH  /lists/:listId                        → edit my list metadata
DELETE /lists/:listId                        → delete my list
POST   /lists/:listId/publish                → publish to marketplace
POST   /lists/:listId/unpublish              → remove from marketplace
```

### Subscriptions (auth required)

```
POST   /lists/:listId/subscribe              → subscribe
DELETE /lists/:listId/subscribe              → unsubscribe
```

### Items (auth required)

```
POST   /lists/:listId/items                  → add item (to my list or personal item on subscribed list)
PATCH  /lists/:listId/items/:itemId          → edit item
DELETE /lists/:listId/items/:itemId          → remove item
POST   /lists/:listId/items/:itemId/reorder  → move item in list
```

### Progress (auth required)

```
POST   /lists/:listId/items/:itemId/check    → mark done
DELETE /lists/:listId/items/:itemId/check    → unmark
GET    /lists/:listId/progress               → { checked: 7, total: 23, items: [...] }
```

### Personal Content (auth required)

```
PUT    /lists/:listId/items/:itemId/notes    → { text, links }
DELETE /lists/:listId/items/:itemId/notes    → clear notes
POST   /lists/:listId/items/:itemId/uploads  → file upload → { url }
DELETE /lists/:listId/items/:itemId/uploads/:uploadId
```

### Comments (auth required)

```
GET    /lists/:listId/comments                         → list-level
POST   /lists/:listId/comments                         → { text }
GET    /lists/:listId/items/:itemId/comments           → item-level
POST   /lists/:listId/items/:itemId/comments           → { text }
DELETE /lists/:listId/comments/:commentId               → delete own comment
```

---

## Data Model

### What lives in Composia (hierarchical data engine)

Composia handles what it's good at — **shared hierarchical structures with per-user personalization**.

| Concept | Composia Mapping |
|---|---|
| A published list's structure | Namespace (`list_{listId}`) with items linked via `UNIT` verb |
| Item hierarchy (groups/sub-items) | Parent→child via `UNIT` verb in the list namespace |
| Item payload (title, description, etc.) | Unit payload JSON |
| User subscribes to list | User namespace (`user_{userId}`) **MOUNTs** the list namespace |
| User adds personal notes to item | **OVERLAY** verb in user namespace → merges into item payload |
| User adds personal items to list | **UNIT** verb in user namespace (invisible to others) |
| User's personalized view | **Resolve** user namespace → sees shared list + personal items + overlays |

**Not using Composia for:** HIDE verb for checkoffs (user still wants to see checked items),
REPLACE verb (not needed for MVP).

### What lives in a relational DB (Postgres or SQLite)

Everything that Composia wasn't designed for — users, progress, social, discovery.

```sql
-- Users & Auth
users (
  id              TEXT PRIMARY KEY,   -- uuid
  email           TEXT UNIQUE,
  password_hash   TEXT,
  display_name    TEXT,
  namespace_id    TEXT,               -- their Composia user namespace
  created_at      TIMESTAMP
)

-- List metadata for marketplace discovery
lists (
  id              TEXT PRIMARY KEY,   -- uuid
  namespace_id    TEXT UNIQUE,        -- Composia namespace for this list
  creator_id      TEXT REFERENCES users(id),
  title           TEXT,
  description     TEXT,
  category        TEXT,
  published       BOOLEAN DEFAULT false,
  subscriber_count INTEGER DEFAULT 0,
  item_count      INTEGER DEFAULT 0,
  created_at      TIMESTAMP,
  updated_at      TIMESTAMP
)

-- Subscriptions
subscriptions (
  user_id         TEXT REFERENCES users(id),
  list_id         TEXT REFERENCES lists(id),
  subscribed_at   TIMESTAMP,
  PRIMARY KEY (user_id, list_id)
)

-- Progress tracking (checkoffs)
progress (
  user_id         TEXT REFERENCES users(id),
  list_id         TEXT REFERENCES lists(id),
  item_id         TEXT,               -- Composia unit ID
  checked_at      TIMESTAMP,
  PRIMARY KEY (user_id, list_id, item_id)
)

-- Comments
comments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id),
  list_id         TEXT REFERENCES lists(id),
  item_id         TEXT,               -- NULL = list-level comment
  text            TEXT,
  created_at      TIMESTAMP
)

-- File uploads
uploads (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id),
  list_id         TEXT REFERENCES lists(id),
  item_id         TEXT,
  file_url        TEXT,
  file_name       TEXT,
  created_at      TIMESTAMP
)
```

---

## How the Two Layers Work Together

### Creator publishes a list

```
1. POST /lists { title: "Home Buying Checklist", category: "home" }
   → creates row in `lists` table
   → creates Composia namespace "list_{id}"

2. POST /lists/:id/items { title: "Get pre-approved for mortgage", order: 1 }
   → creates Composia unit with payload { title, description }
   → creates matrix link: namespace:root:UNIT:item_id (order=1)

3. POST /lists/:id/publish
   → sets published=true in lists table
   → now visible in marketplace
```

### User subscribes and uses a list

```
1. POST /lists/:id/subscribe
   → inserts into subscriptions table
   → creates Composia MOUNT: user_namespace:root:MOUNT:list_namespace

2. GET /lists/:id
   → resolves Composia user namespace (sees mounted list items)
   → fetches progress from progress table
   → merges: each item gets { ...resolvedPayload, checked: true/false }

3. POST /lists/:id/items/:itemId/check
   → inserts into progress table (user_id, list_id, item_id)

4. PUT /lists/:id/items/:itemId/notes { text: "Call Bank of America" }
   → creates Composia unit with payload { personal_notes: "Call Bank of America" }
   → creates OVERLAY in user namespace for that item

5. POST /lists/:id/items { title: "Research HOA fees", order: 99 }
   → creates Composia unit in user namespace
   → links via UNIT verb in user namespace (only this user sees it)

6. GET /lists/:id (again)
   → resolves: shared items + personal overlay notes + personal items
   → merges progress (checkoffs) from DB
   → returns complete personalized view with progress
```

---

## MVP Scope — What to Build First

### Phase 1: Core (week 1-2)
- [ ] Add SQLite (via better-sqlite3) for users, lists, subscriptions, progress
- [ ] Auth endpoints (register, login, JWT middleware)
- [ ] List CRUD (create, edit, delete, publish)
- [ ] Item CRUD (add, edit, reorder, delete) — wraps Composia unit/matrix ops
- [ ] Subscribe/unsubscribe — wraps Composia MOUNT
- [ ] Check/uncheck items — writes to progress table
- [ ] Personalized list view — Composia resolve + progress merge

### Phase 2: Marketplace + Personal (week 3)
- [ ] Marketplace browse/search endpoints
- [ ] Categories
- [ ] Personal notes on items (Composia OVERLAY)
- [ ] Personal items on subscribed lists (Composia UNIT in user namespace)
- [ ] Progress summary endpoint

### Phase 3: Social + Polish (week 4)
- [ ] Comments (list-level and item-level)
- [ ] File uploads (S3 or local storage)
- [ ] Subscriber counts
- [ ] Basic rate limiting

### Not in MVP
- Ratings/reviews
- Following other users
- List forking/remixing
- Notifications
- Real-time updates
- Mobile app

---

## Tech Decisions

| Decision | Choice | Why |
|---|---|---|
| Relational DB | SQLite (better-sqlite3) | Zero setup, good enough for MVP, easy to migrate to Postgres later |
| Auth | JWT (jsonwebtoken) | Simple, stateless, well-understood |
| File uploads | Local disk → S3 later | MVP simplicity |
| Social platform | Defer to Phase 3 | Comments are the minimum viable social feature |
| Frontend | Out of scope for this doc | Could be React/Next.js, mobile, etc. |

---

## Open Questions

1. **Should "checked off" items be hidden or just marked?** → Marked (user still sees them, with a checkmark). Don't use Composia HIDE for this.
2. **Can users re-order items in a subscribed list?** → Not in MVP. They see the creator's order.
3. **Should personal items be mixed into the list or shown separately?** → Mixed in, appended at the end of the group they're added to.
4. **What's the social platform integration?** → Start with native comments. Open-source social (e.g., ActivityPub/Mastodon-style) is a future consideration.
