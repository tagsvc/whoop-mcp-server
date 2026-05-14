# Whoop MCP Server

TypeScript MCP server exposing Whoop v2 API to Claude via Streamable HTTP transport. Deployed on Railway, used as a custom connector in Claude.ai across web, desktop, and mobile clients.

## Repository context

Forked from `yuridivonis/whoop-mcp-server` (May 2026, after upstream went quiet 5 months). This fork extends the original 6-tool implementation to full v2 API parity with 15 MCP tools, persistent SQLite caching, encrypted token storage, and architectural fixes for the StreamableHTTPServerTransport.

Owner: tagsvc. Personal use, not published to MCP registries. No upstream PR contributions planned.

**Current version: 3.1.4** (single-source version, raw JSON passthrough at every layer, 24-hour session TTL, 10-minute sync freshness gate)

## Architectural philosophy

The MCP server is a **raw data passthrough at every layer**. The Whoop v2 API response is captured in full by the client, persisted in full in SQLite, and returned in full by the tool layer. All 12 data tools return raw `JSON.stringify(record, null, 2)` strings. The server does not format, filter, render, or convert data. The consuming agent (Claude) handles presentation logic.

This design choice was made to:
1. Maximise data discoverability for analytical workflows
2. Eliminate field-surfacing gaps (every field flows on every call)
3. Enable tool chaining (IDs visible for `_detail` lookups)
4. Match the analytical-MCP pattern (similar to garmin community MCPs)
5. Decouple server logic from presentation concerns

When adding new tools or extending existing ones, **do not introduce human-readable formatting**. Return raw structured data. Do not narrow database SELECT statements to specific columns. Use `SELECT *` and return full row objects. Let the consuming agent handle the presentation layer.

## Production deployment

- **Railway project**: heroic-reprieve / production
- **Public URL**: https://whoop-mcp-server-production-bdf7.up.railway.app
- **Repo**: github.com/tagsvc/whoop-mcp-server
- **Stable rollback tags**: 
  - `v3.0.0-stable` (formatted markdown architecture, original design)
  - `v3.1.0-stable` (raw JSON passthrough, tool layer only)
  - `v3.1.1-stable` (raw JSON passthrough, complete pipeline)
  - `v3.1.2-stable` (single-source version)
  - `v3.1.3-stable` (session expiration fix)
  - `v3.1.4-stable` (sync freshness gate reduced to 10 minutes, current production)
- **Database**: SQLite at /data/whoop.db on Railway volume

## Architecture

```
Claude.ai client
    ↓ (MCP over Streamable HTTP)
Express server on Railway
    ↓
Whoop client (OAuth 2.0)
    ↓
Whoop Developer API v2
    ↓
SQLite cache (90-day rolling)
```

Token storage encrypted with AES via ENCRYPTION_SECRET. By-ID lookups served from local SQLite to eliminate API round-trips.

## Build and run

```bash
# Local development
npm install
cp .env.example .env  # fill in WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, ENCRYPTION_SECRET
npm run dev

# Production
npm run build
npm start

# Deploy
git push origin main  # Railway auto-deploys
```

## Environment variables

Required:
- `WHOOP_CLIENT_ID` - from developer.whoop.com app
- `WHOOP_CLIENT_SECRET` - from developer.whoop.com app
- `WHOOP_REDIRECT_URI` - must match exactly what's registered at Whoop (currently `https://whoop-mcp-server-production-bdf7.up.railway.app/callback`)
- `ENCRYPTION_SECRET` - any secure random string, used for token encryption
- `DB_PATH` - SQLite database path (production: `/data/whoop.db`)
- `MCP_MODE` - `http` for remote deployment, `stdio` for local

Optional:
- `PORT` - HTTP server port (default 3000)

## MCP tool surface (15 total)

All data retrieval tools return raw JSON via `JSON.stringify(record, null, 2)`. Operational tools return human-readable text where the URL or message needs to be readable.

Data retrieval (12, all raw JSON):
- `get_today` - full recovery + sleep + cycle objects for current day
- `get_recovery_trends` - full DbRecovery records across N days
- `get_sleep_analysis` - full DbSleep records across N days
- `get_strain_history` - full DbCycle records across N days
- `get_workouts` - full DbWorkout records across N days
- `get_workout_detail` - single DbWorkout by UUID
- `get_cycle_detail` - single DbCycle by ID
- `get_sleep_detail` - single DbSleep by UUID
- `get_sleep_for_cycle` - DbSleep linked to cycle ID
- `get_recovery_for_cycle` - DbRecovery linked to cycle ID
- `get_profile` - DbProfile (name, email, user ID)
- `get_body_measurement` - DbBodyMeasurement (height in metres, weight in kg, max HR)

Operational (3, human-readable):
- `sync_data` - returns JSON with status and stats
- `get_auth_url` - returns clickable OAuth URL with instructions
- `revoke_access` - returns confirmation message, requires confirm:true guard

## File structure

```
src/
├── index.ts         # Express server, MCP route handlers, tool registration
├── database.ts      # SQLite schema, migrations, query methods
├── whoop-client.ts  # OAuth flow, API calls, token refresh
└── types.ts         # TypeScript interfaces for Whoop v2 API responses
```

## Critical implementation notes

### Body parser middleware (resolved bug)

The `/mcp` route must NOT have `express.json()` applied. The StreamableHTTPServerTransport reads the request body stream directly. If `express.json()` consumes the body first, the transport throws "stream is not readable" with a 400 error.

Fix in `src/index.ts`:
```typescript
app.use((req, res, next) => {
  if (req.path === '/mcp') return next();
  express.json()(req, res, next);
});
```

This is the most common upstream issue and the reason Yuri's original v0 connector was hard to deploy successfully. Do not revert.

### Database migrations

`runMigrations()` in database.ts runs at startup and applies in-place schema changes. When adding columns or tables:

1. Add the migration block to `runMigrations()`
2. Use `ALTER TABLE` with try/catch for idempotency
3. Test locally before deploying

### Session handling

Streamable HTTP uses `randomUUID()` for session IDs. Sessions are stateless on the server side; reconnection requires re-authentication. Token storage in SQLite persists across sessions.

### Whoop API quirks

- `sport_name` is returned as a snake_case string (e.g. "weightlifting_msk"). The consuming agent translates this for display.
- `sport_id` is the numeric Whoop sport taxonomy ID (e.g. 123 = Strength Trainer, 45 = Weightlifting). Used for classification when sport_name is null on legacy records.
- `user_calibrating` flag is true (stored as integer 1 in SQLite) for the first 30 days of strap use. Recovery scores during this period use population norms, not personal baseline.
- `percent_recorded` is returned as a decimal fraction (0-1), not a percentage (0-100). A value of 1 means 100% recorded.
- `sleep_consistency_percentage` returns 0 when insufficient history exists to compute it (typically first few days of usage).
- Body Measurement endpoint returns height in metres, weight in kilograms. Imperial conversion handled by consuming agent.
- All timestamps stored as ISO 8601 UTC strings. Timezone conversion handled by consuming agent.
- Rate limit: 100 requests per minute per user. Local cache eliminates most calls via smartSync logic.

### Trend queries return full records (v3.1.1+)

`getRecoveryTrends`, `getSleepTrends`, and `getStrainTrends` use `SELECT *` and return full DbRecovery, DbSleep, and DbCycle records respectively. The earlier narrow projection (RecoveryTrendRow, SleepTrendRow, StrainTrendRow types) was removed in v3.1.1 because it violated the raw passthrough architecture.

If extending trend queries in the future, do not reintroduce column projection. Filter rows (WHERE clauses) but return all columns.

## Conventions

Server-side:
- All times stored as ISO 8601 UTC strings in database
- All measurements stored in metric units (meters, kilograms, Celsius, milliseconds)
- Booleans stored as SQLite integers (0/1)
- Tool responses are pure JSON with no formatting, rounding, or unit conversion

Consuming agent (Claude):
- Converts metric to imperial when displaying to user (per userPreferences)
- Converts UTC timestamps to user's local timezone for display
- Rounds values to operator-appropriate precision (HRV 1 decimal, RHR integer, recovery integer %)
- Uses American date format, comma thousands separators
- British English in prose, no emojis or icons

The division of responsibilities: server handles data integrity, agent handles presentation.

## Testing approach

No formal test suite. Manual verification workflow:

1. Deploy to Railway, watch build complete
2. Visit `/health` endpoint, verify response
3. In Claude, disconnect and reconnect the Whoop connector to load updated tool definitions
4. Call `get_auth_url`, complete OAuth flow if needed
5. Call `sync_data`, verify JSON response with non-zero stats counts
6. Call `get_today`, verify JSON output structure with recovery, sleep, cycle nested objects
7. Call `get_workouts` with days:2, verify each record has full field set including UUID, sport_id, percent_recorded, all zone_milli fields, score_state
8. Call `get_recovery_trends` with days:3, verify each record has full DbRecovery shape (id, sleep_id, score_state, user_calibrating, spo2, skin_temp, not just summary fields)

If get_today returns a markdown string starting with `## Recovery:` instead of JSON, the deploy did not pick up v3.1.x changes.

If trend queries return only date/score/hrv/rhr (4 fields), database.ts changes did not pick up. The fix is in the SQL query layer, not the index.ts tool layer.

## Rollback procedure

If a deployment breaks the server:

```bash
# Primary rollback: previous stable
git checkout v3.1.2-stable
git reset --hard v3.1.2-stable
git push origin main --force
```

Railway auto-deploys from main. Within 2-3 minutes the v3.1.2-stable state is restored.

If v3.1.x architecture itself appears broken (e.g. Claude unable to parse raw JSON output), fall back to v3.0.0-stable:

```bash
git checkout v3.0.0-stable
git reset --hard v3.0.0-stable
git push origin main --force
```

SQLite database persists across deployments (volume not affected by code rollback). Schema is forward-compatible: v3.0.0 can read tables created by v3.1.x.

## Known limitations

- Single-user server (one OAuth identity per deployment)
- No webhook support (pull-only, not push)
- Strength Trainer exercise-level data not exposed by Whoop API
- Performance Assessment PDFs are web-only, not API-accessible
- Journal entries write-only, not exposed for read

## Cost basis

- Railway Hobby tier: $5/month (eliminates cold starts)
- Whoop subscription: $30/month (required for data access)
- Total: $35/month for personal recovery analytics infrastructure

## When working on this codebase

Default behaviour expected:

1. Read this file first to establish context
2. Review src/index.ts to confirm tool registration before adding new tools
3. Check Whoop developer docs (developer.whoop.com/docs) before assuming API capabilities
4. Test locally with `npm run dev` before pushing to Railway
5. Never commit `.env` or token data
6. Maintain v3.0.0-stable, v3.1.0-stable, v3.1.1-stable, v3.1.2-stable, v3.1.3-stable, and v3.1.4-stable tags as rollback points; do not delete

Architectural rules (do not violate):

1. **Tool responses are JSON.** Use `JSON.stringify(record, null, 2)`. Do not build markdown strings.
2. **Database queries return full rows.** Use `SELECT *`. Do not narrow projection at the SQL layer.
3. **Server stores metric/UTC, agent presents imperial/local.** Do not convert in the server.
4. **No new type aliases for narrow projections.** Use existing Db* interfaces or extend them when the schema actually grows.
5. **Version is single-source.** Read from `package.json` only. Never hardcode version strings in source files. To bump version, edit `package.json` and nothing else.
6. **Session handling returns 404 on unknown session for non-initialize requests.** The `/mcp` route inspects the JSON-RPC method before deciding response path. Initialize requests create new transports; tool calls with unknown sessions return HTTP 404 with JSON-RPC error code -32001. Do not call `transport.handleRequest()` on a fresh transport with a non-initialize request body — the SDK rejects this with "Server not initialized" and the 400 response does not signal recovery to clients.

When asked to add features, confirm:
- Does the Whoop API expose the data?
- Is there an existing endpoint or does this require a new one?
- Should this be a new tool or extend an existing one?
- Will it require a database migration?
- Does the proposed implementation maintain raw passthrough at every layer?

When debugging, check in order:
1. Railway deployment status (Active vs Crashed)
2. Railway Deploy Logs filtered by `event:"mcp_request"` to see /mcp request flow
3. Railway Deploy Logs filtered by `event:"session_eviction"` to detect TTL evictions
4. Railway HTTP Logs for status codes (200/202 healthy, 404 unknown session, 400 SDK rejection)
5. OAuth token validity (try `get_auth_url` to test server responsiveness)
6. Whoop API status at status.whoop.com
7. Connector freshness in Claude (refresh tools list to reinitialize after deploy or extended outage)
8. Cold start (first call after server restart may need refresh; subsequent calls within 24h TTL should reuse session)

When troubleshooting MCP tool failures across devices, isolate client vs server first:
- Works on one device, fails on another → client issue (try Claude Desktop update, app restart)
- Fails on all devices → server issue (check Railway logs, then API)
- Returns markdown instead of JSON → deploy did not pick up v3.1.x changes
- Returns truncated trend data → database.ts v3.1.1 changes did not deploy
- 400 "Server not initialized" returned → v3.1.3 changes did not deploy; route handler still using old transport.handleRequest path

## Version history

**3.1.4** (May 14, 2026)
- Sync freshness gate reduced from 60 minutes to 10 minutes. Supports active usage patterns (GTGs, post-workout checks, BP readings) where the prior 60-minute window forced users to call `sync_data(full: true)` to bypass.
- `SYNC_FRESHNESS_MS` extracted to a named class constant in `src/sync.ts`. Value: `10 * 60 * 1000` (10 minutes). Replaces the prior `hoursSinceSync < 1` inline check.
- `FULL_SYNC_THRESHOLD_HOURS` extracted to a named class constant. Value: `24`. Documents the threshold at which `needsFullSync()` triggers a 90-day re-sync versus a 7-day quick sync.
- Structured JSON logging on gate hit. Event type: `event: "sync_gate_active"` with `timestamp`, `seconds_since_last_sync`, `gate_window_seconds`, and `action: "skipped"`. Visible in Railway Deploy Logs.
- Rate limit safety verified: 10-minute gate at theoretical maximum produces 42 API calls per hour (well under Whoop's 100/min limit). Realistic usage produces ~40-56 calls per day (0.5% of daily 10,000 ceiling).
- Architectural addition (rule 7): Sync gates extracted to named class constants in `src/sync.ts`. Future tuning is a single-line change.

**3.1.3** (May 14, 2026)
- Session expiration fix. The `/mcp` route now handles unknown session IDs correctly and the idle session window is extended to a working day.
- `SESSION_TTL_MS` extended from `30 * 60 * 1000` (30 min) to `24 * 60 * 60 * 1000` (24 hours). The 30-minute window was causing observable failures during normal idle gaps. With 24 hours, sessions survive any normal day of usage. Memory cost negligible at single-user scale.
- Unknown session ID on a non-initialize request now returns HTTP 404 with JSON-RPC error code `-32001` and message "Session not found. Please reinitialize." The old behaviour was: server created a fresh transport, then `transport.handleRequest()` rejected the tool call with the SDK's "Server not initialized" 400 error. The 400 response did not signal recovery to clients. The 404 is the MCP spec convention for "session not found, please re-handshake."
- Body buffering: the POST `/mcp` handler now reads the raw request body into a Buffer, JSON-parses it to inspect the JSON-RPC `method` and `id` fields, then replays the buffered body to the transport via `Readable.from([rawBody])`. This enables route-level decisions (404 vs. new transport vs. reuse) based on whether the request is an `initialize` or a tool call, while preserving the streaming consumption pattern the transport expects.
- Structured JSON logging on stdout (Railway Deploy Logs captures). Two event types:
  - `event: "mcp_request"` per `/mcp` call with `timestamp`, `method`, `sessionIdPrefix` (first 8 chars only), `sessionKnown`, `bodyMethod`, `isInitialize`, `action` (reused_session, new_session_initialize, new_session_implicit, rejected_unknown_session, session_closed), `activeSessions`, `durationMs`, and `httpStatus` for rejected requests.
  - `event: "session_eviction"` when the TTL cleanup loop closes idle sessions. Includes `evictedCount`, evicted session prefixes, and `remainingSessions`.
- Architectural addition (rule 6): MCP transport state lives in an in-memory `Map`. Session loss occurs on server restart, container suspension, or our TTL eviction. Recovery behaviour is governed by client. The 404 response gives spec-compliant clients a clear signal but cannot force a non-compliant proxy (e.g., `mcp-proxy.anthropic.com` per Issue #228) to refresh transparently. Manual "Refresh tools list" remains the fallback for failures we cannot mediate from the server.

**3.1.2** (May 13, 2026)
- Single-source version: `package.json` is the canonical version field. `src/index.ts` reads it at startup via `readFileSync` and exposes it as `SERVER_VERSION` constant. Both MCP handshake and GET `/mcp` health check use the constant.
- Fixed GET `/mcp` health check which was hardcoded to `3.0.0` through two version bumps.
- Updated `package.json` metadata to reflect tagsvc fork: version 3.1.2, author tagsvc, repository URL github.com/tagsvc/whoop-mcp-server. Original author (Yuri Dvoinos) retained in contributors per MIT license.
- New version-bump workflow: edit `package.json` version field only. No source code changes for routine version bumps.

**3.1.1** (May 13, 2026)
- Fixed trend query clipping at database layer
- `getRecoveryTrends`, `getSleepTrends`, `getStrainTrends` now `SELECT *` returning full DbRecovery, DbSleep, DbCycle records
- Removed unused narrow projection type aliases
- Completes raw passthrough at every architectural layer

**3.1.0** (May 13, 2026)
- Architectural shift to raw JSON passthrough at tool layer
- All 12 data tools return `JSON.stringify(record, null, 2)`
- Removed markdown formatters, unit converters, zone classifiers from index.ts
- 282 lines removed
- Server now decoupled from presentation concerns

**3.0.0** (May 12, 2026)
- Initial fork from yuridivonis/whoop-mcp-server
- Extended to full v2 API parity with 15 tools
- SQLite persistent caching with 90-day rolling history
- Encrypted OAuth token storage with refresh
- Express body parser middleware fix for StreamableHTTPServerTransport
