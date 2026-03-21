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

### Personal Content (auth required)

All personal data on an item — checkoffs, notes, photos, links — is a single overlay.
No separate "progress" concept. A check is just `{ checked: true }` in your overlay.

```
GET    /lists/:listId/items/:itemId/personal → get my overlay for this item
PUT    /lists/:listId/items/:itemId/personal → upsert overlay (merge into existing)
DELETE /lists/:listId/items/:itemId/personal → clear all personal content
POST   /lists/:listId/items/:itemId/uploads  → file upload → adds to overlay attachments
DELETE /lists/:listId/items/:itemId/uploads/:uploadId
GET    /lists/:listId/progress               → computed from overlays: count items where checked=true
```

Example overlay payloads — all go through the same endpoint:

```json
// Check off an item
PUT /lists/:listId/items/:itemId/personal
{ "checked": true }

// Add a note
PUT /lists/:listId/items/:itemId/personal
{ "notes": "Call the bank first" }

// Both at once
PUT /lists/:listId/items/:itemId/personal
{ "checked": true, "notes": "Call the bank first", "rating": 5 }
```

The overlay is **open-ended JSON** — the frontend can put whatever it wants in there.
Composia merges it onto the shared item during resolution. One verb, any content type.

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
| User adds personal content to item (checks, notes, photos, links — all the same) | **OVERLAY** verb in user namespace → merges into item payload |
| User adds personal items to list | **UNIT** verb in user namespace (invisible to others) |
| User's personalized view | **Resolve** user namespace → sees shared list + personal items + overlays |

**Key insight:** There is no separate "progress" or "checkoff" system. A checkoff is just
personal content (`{ checked: true }`) stored as an OVERLAY, same as notes or photos.
Everything personal is an overlay. One mechanism for all user content on shared items.

### What lives in a relational DB (Postgres or SQLite)

Everything that Composia wasn't designed for — users and discovery.

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

-- No progress/comments/uploads tables in MVP.
-- Checkoffs and personal content live in Composia as OVERLAYs.
-- File upload URL tracking can be added later if needed.
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
   → resolves Composia user namespace (sees mounted list items + overlays merged in)
   → each item already has personal content (checked, notes, photos) baked in via overlay
   → returns complete personalized view

3. PUT /lists/:id/items/:itemId/personal { checked: true }
   → creates/updates Composia overlay unit with payload { checked: true }
   → creates OVERLAY in user namespace for that item (if not exists)
   → next resolve automatically merges it in

4. PUT /lists/:id/items/:itemId/personal { notes: "Call Bank of America" }
   → same mechanism — merges into existing overlay: { checked: true, notes: "Call Bank of America" }

5. POST /lists/:id/items { title: "Research HOA fees", order: 99 }
   → creates Composia unit in user namespace
   → links via UNIT verb in user namespace (only this user sees it)

6. GET /lists/:id (again)
   → resolves: shared items + overlays (checks, notes, photos) + personal items
   → everything comes from Composia resolution — no extra DB queries for progress
```

---

## MVP Scope — What to Build First

### Phase 1: Core (week 1-2)
- [ ] Add SQLite (via better-sqlite3) for users, lists, subscriptions
- [ ] Auth endpoints (register, login, JWT middleware)
- [ ] List CRUD (create, edit, delete, publish)
- [ ] Item CRUD (add, edit, reorder, delete) — wraps Composia unit/matrix ops
- [ ] Subscribe/unsubscribe — wraps Composia MOUNT
- [ ] Personal content endpoint (check, notes, photos — all via Composia OVERLAY)
- [ ] Personalized list view — Composia resolve (overlays merged automatically)

### Phase 2: Marketplace + Personal (week 3)
- [ ] Marketplace browse/search endpoints
- [ ] Categories
- [ ] Personal items on subscribed lists (Composia UNIT in user namespace)
- [ ] Progress summary (computed: count resolved items where overlay has checked=true)
- [ ] Subscriber counts
- [ ] Basic rate limiting

### Not in MVP
- Social features (comments, discussions) — integrate open-source platform later
- File uploads
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
| Social | Post-MVP | Integrate open-source platform (Discourse, Matrix, ActivityPub, etc.) rather than building from scratch. Link discussions to units/collections via payload references. Map Composia users to social platform users. |
| Frontend | Out of scope for this doc | Could be React/Next.js, mobile, etc. |

---

## Open Questions

1. ~~Should "checked off" items be hidden or just marked?~~ → **Resolved.** Checks are just personal content (OVERLAY with `{ checked: true }`), same as notes or photos. No special treatment.
2. **Can users re-order items in a subscribed list?** → Not in MVP. They see the creator's order.
3. **Should personal items be mixed into the list or shown separately?** → Mixed in, appended at the end of the group they're added to.
4. **What's the social platform integration?** → Post-MVP. Integrate an open-source platform (Discourse, Matrix, ActivityPub, etc.) rather than building social from scratch. Each unit or collection of units gets a linked discussion thread. Composia users map to social platform users.

---

## Future: Social Platform Integration (Post-MVP)

Rather than building comments/discussions/reactions from scratch, integrate an
open-source social platform. The integration pattern:

```
Composia Unit or Collection of Units
       │
       │  unit payload stores: { social_thread_id: "abc123" }
       │
       ▼
Open-source social platform (Discourse / Matrix / ActivityPub-based)
       │
       │  thread/channel/post linked to the unit(s)
       │
       ▼
Users discuss, comment, react — all handled by the social platform

User identity mapping:
  Composia user (user_{id}) ←→ Social platform user account
  Created at registration time, SSO or token-based auth sync
```

**Candidate platforms to evaluate:**
- **Discourse** — forum-style, great API, embeddable, mature moderation tools
- **Matrix (Element)** — real-time chat, decentralized, good for item-level discussions
- **Lemmy / Kbin** — Reddit-style, ActivityPub-based, good for list-level discussions
- **Custom ActivityPub** — federated, future-proof, but more integration work

**What Composia needs to support this:**
- A `social_thread_id` field in unit payloads (or a dedicated link)
- User registration flow that also creates the social platform account
- An API endpoint or webhook to create a discussion thread when a list is published
- Frontend embeds the social platform's UI (most support iframe/embed or API-driven rendering)
