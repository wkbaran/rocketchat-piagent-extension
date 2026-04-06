# Rocket.Chat Extension for pi

Integrates pi with Rocket.Chat. Incoming messages are routed to isolated
per-channel agent sessions so RC traffic never appears in the main pi TUI.
Each channel gets its own conversation history and can be configured with
a custom system prompt and model via **workflows**.

## Features

- **Per-channel isolated sessions** — each channel has its own agent session with independent conversation history
- **Workflows** — per-channel system prompt overrides and model selection
- **Message queueing** — messages within a channel are processed sequentially; channels are independent
- **Command prefix** — optional prefix to filter which messages the bot responds to (default: `!`)
- **Context management** — clear a channel's conversation history on demand
- **Auto-reconnect** — re-authenticates automatically when the session token expires
- **Logging** — structured log file for troubleshooting

## Setup

### 1. Create a bot user in Rocket.Chat

1. Log into Rocket.Chat as admin
2. Go to **Administration → Users** and create a new user:
   - **Username**: `pi-bot` (or your choice)
   - **Roles**: `bot`
3. Add the bot as a member of every channel you want it to monitor

### 2. Install dependencies

```bash
cd ~/.pi/agent/extensions/rocketchat
npm install
```

### 3. Configure pi

Add to `~/.pi/agent/settings.json`:

```json
{
  "rocketChat": {
    "serverUrl": "https://your-rocket-chat-server.com",
    "username": "pi-bot",
    "password": "your-bot-password",
    "channels": ["general", "ai-assistant"],
    "prefix": "!"
  }
}
```

**Configuration options:**

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `serverUrl` | string | Yes | — | Rocket.Chat server URL |
| `username` | string | Yes | — | Bot username |
| `password` | string | Yes | — | Bot password |
| `channels` | string[] | No | `[]` | Channels to monitor. If empty and no workflows are defined, all rooms the bot is a member of are monitored. Workflow channels are added automatically. |
| `prefix` | string | No | `!` | Only respond to messages starting with this string. Set to `""` to respond to all messages. |
| `workflows` | object | No | — | Per-channel behaviour overrides (see below) |

### 4. Reload pi

Restart pi or run `/reload`.

## Workflows

Workflows let you give a channel a custom system prompt and/or a specific model.
The workflow key is the channel name.

```json
{
  "rocketChat": {
    "serverUrl": "https://chat.example.com",
    "username": "pi-bot",
    "password": "secret",
    "prefix": "",
    "workflows": {
      "quick-answers": {
        "instructions": "Give very short, direct answers only. No explanations unless asked.",
        "model": {
          "provider": "anthropic",
          "id": "claude-haiku-4-5"
        }
      },
      "travel": {
        "instructions": "You are a travel planning expert. Include weather, attractions, and tips.",
        "model": {
          "provider": "anthropic",
          "id": "claude-opus-4-5"
        }
      }
    }
  }
}
```

Workflow channels are automatically added to the polling list — you don't need to
list them in `channels` as well. If a workflow specifies a model that can't be found,
the extension falls back to the default model and logs a warning.

## Commands

### pi slash commands

| Command | Description |
|---------|-------------|
| `/rocketchat-connect` | Connect to Rocket.Chat |
| `/rocketchat-disconnect` | Disconnect and dispose all sessions |
| `/rocketchat-status` | Show connection status, active sessions, and queue depth |
| `/rocketchat-send <channel> <message>` | Send a message to a channel |
| `/rocketchat-clear-context <channel>` | Clear conversation history for a channel |
| `/rocketchat-reset-state` | Clear saved message timestamps (bot re-processes from now) |
| `/rocketchat-logs` | Show the last 50 lines of the extension log |

### In-channel commands (no prefix required)

| Message | Description |
|---------|-------------|
| `!clear-context` | Clear the conversation history for that channel |

## How It Works

1. The extension polls Rocket.Chat every **10 seconds** via the REST API
2. New messages are filtered by channel membership and the configured prefix
3. Each qualifying message is added to a per-channel queue
4. Messages in a channel are processed one at a time (sequentially); different channels process in parallel
5. Each channel's agent session is created lazily on the first message and reused for subsequent messages, preserving conversation context
6. The agent's response is sent back to the originating channel

## Files

| File | Description |
|------|-------------|
| `index.ts` | Extension source |
| `state.json` | Persisted message timestamps (survives restarts) |
| `rocketchat.log` | Extension log file |

## Troubleshooting

**Bot doesn't respond:**
- Check `/rocketchat-logs` for errors
- Verify the bot user is a member of the channel in Rocket.Chat
- Confirm the prefix setting matches how you're sending messages
- Run `/rocketchat-status` to verify the connection is active

**Wrong channel name:**
- On connect, the extension logs all visible room names to `rocketchat.log` — check there for the exact name the server returns

**Stale responses / bot replying to old messages:**
- Run `/rocketchat-reset-state` to clear saved timestamps; the bot will ignore all existing messages and only respond to new ones going forward

## Security Notes

- Credentials are stored in `~/.pi/agent/settings.json` — ensure this file has appropriate permissions (`chmod 600`)
- Use a dedicated bot account, not your personal account
- The bot password is in plaintext; do not commit `settings.json` to version control
