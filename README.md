# Whoop MCP Server

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. Designed to be hosted remotely and used as a custom connector in Claude.ai.

Built using the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction). Forked from [yuridivonis/whoop-mcp-server](https://github.com/yuridivonis/whoop-mcp-server) and extended to full v2 API parity.

## Features

Recovery data: daily recovery scores, HRV, resting heart rate, SpO2, skin temperature, user calibration status.

Sleep analysis: duration, stage breakdown, efficiency, performance, consistency, sleep cycles, disturbance count, respiratory rate, sleep debt.

Strain tracking: daily strain scores, calories burned, average and max heart rate.

Workout history: all logged workouts with sport name, duration, strain, heart rate zones, distance, altitude gain, percent recorded.

User data: profile (name, email, user ID), body measurements (height, weight, max heart rate baseline).

Auto-sync: smart sync logic with hourly cache and 90-day rolling history.

Token management: encrypted OAuth token storage, automatic refresh, scoped access revocation.

## MCP Tools

15 tools covering the full Whoop v2 read API.

| Tool | Description |
| --- | --- |
| `get_today` | Morning briefing with recovery, sleep, and strain |
| `get_recovery_trends` | Recovery patterns over time with HRV and RHR |
| `get_sleep_analysis` | Sleep duration, performance, and efficiency trends |
| `get_strain_history` | Daily strain and calorie history |
| `get_workouts` | List workouts with sport, duration, strain, distance, zones |
| `get_workout_detail` | Single workout with full zone time and metrics |
| `get_cycle_detail` | Single cycle with strain, heart rate, and calories |
| `get_sleep_detail` | Single sleep with stages, debt, disturbances, consistency |
| `get_sleep_for_cycle` | Sleep linked to a specific cycle ID |
| `get_recovery_for_cycle` | Recovery linked to a specific cycle ID |
| `get_profile` | Name, email, and user ID |
| `get_body_measurement` | Height, weight, and max heart rate baseline |
| `sync_data` | Manually trigger a data sync |
| `get_auth_url` | Get authorization URL for Whoop connection |
| `revoke_access` | Revoke OAuth tokens and clear local state |

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
- Streamable HTTP session handling refinement

## License

MIT. See [LICENSE](./LICENSE).
