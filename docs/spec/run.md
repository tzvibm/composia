# Composia Execution Guide

### 🚀 Running the App

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the server in **Development** mode with full logging. |
| `npm start` | Starts the server in **Production** mode. |

---

### 🧪 Testing & TDD

| Command | Description |
| :--- | :--- |
| `npm test` | Wipes the test DB and runs all tests once (CI/CD mode). |
| `npm run test:watch` | **TDD Mode:** Re-runs tests automatically as you save files. |
| `npm run test:ui` | Opens the **Vitest UI** dashboard in your web browser. |
| `npm run test:coverage` | Generates a report showing code coverage percentages. |

---

### 🗄️ Database Management

| Command | Description |
| :--- | :--- |
| `npm run db:test-setup` | Manually resets and re-migrates the `composia_test` database. |
| `npm run migrate -- <file>` | Runs a specific migration (e.g., `npm run migrate -- db/migrations/001_init.sql`). |

---

### 📝 Environment Variables

Ensure your `.env` and `.env.test` files contain the configuration you specified:

* `PORT=3000`
* `DB_USER=composia_admin`
* `DB_PASSWORD=1234`
* `DB_HOST=localhost`
* `DB_PORT=5432`
* `DB_NAME=composia`