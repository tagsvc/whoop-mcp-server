# Whoop MCP Server

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. Designed to be hosted remotely and used as a custom connector in Claude.ai.

Built using the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction). Forked from [yuridivonis/whoop-mcp-server](https://github.com/yuridivonis/whoop-mcp-server) and extended to full v2 API parity.

## Architecture

**Raw JSON passthrough at every layer.** All data tools return raw structured JSON containing every field stored in the local SQLite cache. The Whoop v2 API response is captured in full at the client layer, persisted in full at the database layer, and returned in full at the tool layer. No clipping, no formatting, no filtering anywhere in the data pipeline.

The MCP server does not human-render data. The consuming agent (Claude) handles all presentation, unit conversion, timezone formatting, and field selection. This design follows the analytical-MCP pattern (similar to the Garmin community MCP) rather than the conversational-MCP pattern of the original upstream fork.

Available on every call: IDs (workout UUID, sleep UUID, cycle ID, recovery linkage IDs), state flags (score_state, user_calibrating, is_nap), timestamps (created_at, start_time, end_time, synced_at), data quality indicators (percent_recorded), and complete metric breakdowns (all sleep stages including awake time, full sleep_needed components, all six HR zones, distance, altitude).

## Features

Recovery data: daily recovery scores, HRV, resting heart rate, SpO2, skin temperature, user calibration status.

Sleep analysis: duration, stage breakdown, efficiency, performance, consistency, sleep cycles, disturbance count, respiratory rate, sleep debt.

Strain tracking: daily strain scores, calories burned, average and max heart rate.

Workout history: all logged workouts with sport name, duration, strain, heart rate zones, distance, altitude gain, percent recorded.

User data: profile (name, email, user ID), body measurements (height, weight, max heart rate baseline).

Auto-sync: smart sync logic with hourly cache and 90-day rolling history.

Token management: encrypted OAuth token storage, automatic refresh, scoped access revocation.

## MCP Tools

15 tools covering the full Whoop v2 read API. All data tools return raw JSON.

| Tool | Returns |
| --- | --- |
| `get_today` | Full recovery, sleep, and cycle objects for the current physiological day |
| `get_recovery_trends` | Full DbRecovery records across requested day range |
| `get_sleep_analysis` | Full DbSleep records across requested day range |
| `get_strain_history` | Full DbCycle records across requested day range |
| `get_workouts` | Full DbWorkout records across requested day range |
| `get_workout_detail` | Single DbWorkout by UUID |
| `get_cycle_detail` | Single DbCycle by ID |
| `get_sleep_detail` | Single DbSleep by UUID |
| `get_sleep_for_cycle` | DbSleep linked to specific cycle ID |
| `get_recovery_for_cycle` | DbRecovery linked to specific cycle ID |
| `get_profile` | DbProfile (name, email, user ID) |
| `get_body_measurement` | DbBodyMeasurement (height, weight, max HR) |
| `sync_data` | Sync status and record counts |
| `get_auth_url` | OAuth authorization URL (human-readable, intentional) |
| `revoke_access` | Token revocation confirmation (human-readable, intentional) |

## Setup

### 1. Create a Whoop Developer App

Visit [developer.whoop.com](https://developer.whoop.com), create a new application, and note your Client ID and Client Secret. Set the redirect URI to your deployed server's callback URL, for example `https://your-app.railway.app/callback`.

### 2. Deploy to Railway

Push this repo to GitHub, create a new Railway project, and connect the GitHub repo. Add these environment variables:

- `WHOOP_CLIENT_ID`: Whoop app client ID
- `WHOOP_CLIENT_SECRET`: Whoop app client secret
- `WHOOP_REDIRECT_URI`: `https://your-app.railway.app/callback`
- `DB_PATH`: `/data/whoop.db`
- `MCP_MODE`: `http`
- `PORT`: `3000`
- `ENCRYPTION_SECRET`: any secure random string

Mount a volume at `/data` for persistent SQLite storage. Deploy.

### 3. Authorize with Whoop

Visit `https://your-app.railway.app/health` to verify the server is running. In Claude, call the `get_auth_url` tool, visit the returned link, log in to Whoop, and authorize. The callback completes automatically and the initial 90-day sync begins in the background.

### 4. Connect to Claude

In Claude.ai settings, navigate to Connectors, click "Add custom connector", and enter:

- Name: Whoop
- Remote MCP server URL: `https://your-app.railway.app/mcp`

The connector becomes available across web, desktop, and mobile Claude clients.

## Local Development

```
npm install

cat > .env << EOF
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
WHOOP_REDIRECT_URI=http://localhost:3000/callback
MCP_MODE=http
EOF

npm run dev
```

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `ENCRYPTION_SECRET` | AES key for token encryption | Required |
| `DB_PATH` | SQLite database path | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for remote, `stdio` for local | `http` |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Whoop MCP Server                   │
│                                                 │
│  ┌─────────────┐      ┌──────────────────┐    │
│  │ MCP Server  │◄────►│  SQLite Database │    │
│  │ (HTTP)      │      │  - cycles        │    │
│  └─────────────┘      │  - recovery      │    │
│         │             │  - sleep         │    │
│         │             │  - workouts      │    │
│         ▼             │  - profile       │    │
│  ┌─────────────┐      │  - body_meas.    │    │
│  │ Whoop API   │      │  - tokens        │    │
│  │ Client v2   │      └──────────────────┘    │
│  └─────────────┘                               │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Claude.ai (Custom Connector)                   │
│  "What is my recovery today?"                   │
└─────────────────────────────────────────────────┘
```

## API Endpoints Used

The server uses these Whoop API v2 endpoints:

- `GET /v2/user/profile/basic`
- `GET /v2/user/measurement/body`
- `GET /v2/cycle`
- `GET /v2/recovery`
- `GET /v2/activity/sleep`
- `GET /v2/activity/workout`
- `DELETE /v2/user/access`

## Changes from Upstream

This fork extends the original six-tool implementation with:

- Nine additional tools covering workouts, profile, body measurement, detail lookups, cycle-linked queries, and token revocation
- Database schema additions: workout distance and altitude, sport name from API, sleep cycle count and disturbance count, user calibration flag, percent recorded
- Express body parser fix that resolved a 400 error blocking the MCP handshake
- Streamable HTTP session handling refinement (v3.1.3): 24-hour idle TTL, 404 with MCP error code on unknown session, structured logging for session lifecycle events
- Raw JSON passthrough architecture (v3.1.x): removed markdown formatters from tool layer, removed narrow projections from trend query layer, server now returns complete data on every call

## Version history

**3.1.3** (May 14, 2026)
- Fixed session expiration friction. Idle MCP sessions previously expired after 30 minutes, requiring manual "Refresh tools list" in connector settings to recover. Session TTL extended to 24 hours.
- Route handler now returns HTTP 404 with MCP spec error code -32001 when a non-initialize request arrives with an unknown session ID, instead of the SDK's default 400 "Server not initialized" response. The 404 signals "session not found, please reinitialize" so a compliant client can recover transparently.
- Body buffering added to `/mcp` POST handler so the route can inspect the JSON-RPC method before deciding response path while still passing the raw body through to the transport.
- Structured JSON logging added for `/mcp` requests and session evictions. Captures timestamps, session ID prefixes, JSON-RPC methods, action taken, active session count, and request duration. Available in Railway Deploy Logs.

## License

MIT. See [LICENSE](./LICENSE).
