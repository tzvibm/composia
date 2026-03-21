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

All endpoints prefixed with `/api`. Auth via JWT Bearer token + Capbit for authorization.

### Auth

```
POST   /auth/register          { email, password, display_name }
POST   /auth/login             { email, password } → { token }
GET    /me                     → user profile
PATCH  /me                     → update profile
```

**Identity vs Authorization:** JWT handles *who you are* (authentication). Capbit handles
*what you can do* (authorization) — down to individual units/items. See Authorization section below.

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

## Architecture — Three Engines

```
                         ┌──────────────┐
                         │  Product API  │  Fastify — speaks user language
                         │  (JWT auth)   │
                         └──────┬───────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                  │
              ▼                 ▼                  ▼
     ┌────────────────┐ ┌─────────────┐  ┌──────────────┐
     │    Composia     │ │   Capbit     │  │   SQLite      │
     │  (RocksDB)      │ │  (RocksDB)   │  │               │
     │                 │ │              │  │               │
     │ • Hierarchies   │ │ • Who can    │  │ • User        │
     │ • Units/items   │ │   do what    │  │   profiles    │
     │ • Namespaces    │ │ • Per-unit   │  │ • List        │
     │ • Mounts        │ │   granularity│  │   metadata    │
     │ • Overlays      │ │ • Role masks │  │ • Discovery   │
     │ • Resolution    │ │ • Grants     │  │ • Subscriptions│
     └────────────────┘ └─────────────┘  └──────────────┘
      hierarchical data   authorization    search/browse
      + personalization   (atomized tuples)  (relational)
```

**Pure Node.js stack.** No Rust, no native module compilation, no NAPI bindings.
Composia and Capbit both rewritten in JavaScript on top of RocksDB (via `rocksdb` npm
or `rocks-level`). RocksDB supports concurrent writes and column families — Composia
and Capbit can share one RocksDB instance with separate column families for isolation.
SQLite via better-sqlite3 for relational queries. Everything in-process, embedded.

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

**Recursive mount safety — preventing infinite loops.** Users only mount list namespaces,
never other user namespaces. But a list's hierarchy can contain items that themselves
mount other list namespaces, which can contain further mounts, and so on. This creates
two risks:

1. **Unbounded depth** — mounts nested arbitrarily deep.
   → Already handled: `MAX_DEPTH` stops resolution regardless of mount nesting.

2. **Circular mounts** — list A contains a mount to list B, which contains a mount
   back to list A. Resolution would bounce between them until hitting depth limit,
   wasting work and returning duplicate/confusing results.
   → **Requires cycle detection:** the resolution engine must track a `visited_namespaces`
   set for each resolution path. When entering a MOUNT, check if the mount namespace
   is already in the set. If so, skip it (treat as a dead end, log it in operations).

```
Resolution path tracking:
  resolve(user_A) → enters list_456 [visited: {user_A, list_456}]
    → item_2 mounts list_789 [visited: {user_A, list_456, list_789}]
      → item_4 mounts list_456 → ALREADY VISITED → skip (cycle detected)
```

This is a Composia engine change — the resolution service needs a `visited` set
threaded through the recursive calls. The product API doesn't need to change.

### What lives in Capbit (authorization engine)

Capbit handles granular, unit-level authorization. Both relationships and permission
semantics are atomized tuples — no schema blobs, no computed rules.

```
SUBJECTS:  (subject, object, role) → granted/revoked
OBJECTS:   (object, role)          → permission bitmask
INHERITS:  (object, role)          → parent role chain
```

**Marketplace authorization model:**

```
# When a user creates a list:
OBJECTS:   (list_456, owner)   → can_read | can_write | can_delete | can_publish | can_grant
OBJECTS:   (list_456, editor)  → can_read | can_write | can_add_items
OBJECTS:   (list_456, viewer)  → can_read | can_check | can_overlay_personal
INHERITS:  (list_456, editor)  → inherits (list_456, viewer)
INHERITS:  (list_456, owner)   → inherits (list_456, editor)
SUBJECTS:  (user_123, list_456, owner) → granted

# When a user subscribes:
SUBJECTS:  (user_789, list_456, viewer) → granted

# Unit-level override (e.g. grant edit on a specific item):
OBJECTS:   (item_abc, editor)  → can_read | can_write
SUBJECTS:  (user_789, item_abc, editor) → granted
```

**Permission check flow:**
1. JWT middleware extracts user ID from token
2. Product API calls Capbit: `auth(user_id, object_id, required_permission)`
3. Capbit resolves: subject roles → bitmask lookup → bitwise OR → check bit
4. No schema parsing, no rule evaluation — just tuple lookups

**Key advantage over JWT-only or RBAC:**
- Permissions are granular to individual units/items, not just lists
- Changing what a role means is a single tuple write, not a code change
- A creator can grant specific users edit access to specific items

### What lives in SQLite (discovery + user profiles)

SQLite stores what neither Composia nor Capbit handles — searchable metadata and credentials.

```sql
-- User profiles & credentials
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

-- Subscriptions (also mirrored as Capbit grants)
subscriptions (
  user_id         TEXT REFERENCES users(id),
  list_id         TEXT REFERENCES lists(id),
  subscribed_at   TIMESTAMP,
  PRIMARY KEY (user_id, list_id)
)
```

---

## How the Two Layers Work Together

### Creator publishes a list

```
1. POST /lists { title: "Home Buying Checklist", category: "home" }
   → creates row in `lists` table
   → creates Composia namespace "list_{id}"
   → creates Capbit roles for list (owner/editor/viewer bitmasks)
   → grants creator owner role: (user_id, list_id, owner)

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
   → creates Capbit grant: (user_id, list_id, viewer) → granted
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

### Phase 0: Engine Migration (Rust → Node.js, LMDB → RocksDB)
- [ ] Replace Rust native module (`src/lib.rs`) with pure Node.js engine on RocksDB
  - RocksDB column families: `units`, `matrix`, `namespaces`
  - Same key format, same operations, just JavaScript instead of Rust
  - Remove `Cargo.toml`, `src/lib.rs`, `@napi-rs/cli` dependency
  - Add `rocksdb` (or `rocks-level`) npm dependency
- [ ] Port Capbit from Rust to Node.js on RocksDB
  - Column families: `subjects`, `subjects_rev`, `objects`, `inherits`, `inherits_by_obj`, `inherits_by_parent`
  - Same tuple-based auth logic, same bitmask resolution
  - Can share the same RocksDB instance as Composia (separate column families)
- [ ] Verify all existing Composia tests pass on the new engine
- [ ] Update `src/dal/db.js` to initialize RocksDB instead of Rust NAPI module

### Phase 1: Core (week 1-2)
- [ ] Add SQLite (via better-sqlite3) for user profiles, list metadata, subscriptions
- [ ] Auth endpoints (register, login, JWT middleware)
- [ ] Capbit integration — create roles/grants on list creation, subscription, etc.
- [ ] Auth middleware: JWT for identity → Capbit for permission check on every request
- [ ] List CRUD (create, edit, delete, publish) — with Capbit owner/editor checks
- [ ] Item CRUD (add, edit, reorder, delete) — wraps Composia unit/matrix ops
- [ ] Subscribe/unsubscribe — Composia MOUNT + Capbit viewer grant
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
| Language | **Pure Node.js** | No Rust, no NAPI, no native compilation. One language for everything. Simpler to develop, debug, and deploy. |
| Storage engine | **RocksDB** (via `rocksdb` npm or `rocks-level`) | Concurrent writes (LMDB was single-writer). Column families for data isolation. Battle-tested. Good Node.js bindings. |
| DB topology | **One RocksDB instance, column families** | Composia data (units, matrix, namespaces) and Capbit data (subjects, objects, inherits) each get their own column family. Single DB path, single process. |
| Authentication | JWT (jsonwebtoken) | Identity only — who you are. Stateless, well-understood. |
| Authorization | **Capbit** (github.com/tzvibm/capbit) — ported to JS | Granular unit-level permissions as atomized tuples. Ported from Rust to Node.js on RocksDB. Permission changes are tuple writes, not code deploys. |
| Discovery DB | SQLite (better-sqlite3) | Marketplace search/browse metadata. Zero setup, easy to migrate to Postgres later. |
| Social | Post-MVP | Integrate open-source platform. Link discussions to units via payload references. |
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
