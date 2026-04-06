/**
 * Rocket.Chat Integration Extension for pi
 *
 * Processes RC messages in isolated per-channel AgentSessions so that
 * RC traffic never appears in the main TUI session.
 *
 * Configuration (in settings.json):
 * {
 *   "rocketChat": {
 *     "serverUrl": "https://chat.example.com",
 *     "username": "pi-bot",
 *     "password": "secret",
 *     "channels": ["general"],
 *     "prefix": "!",
 *     "workflows": {
 *       "channel-name": {
 *         "instructions": "Be concise.",
 *         "model": { "provider": "anthropic", "id": "claude-haiku-4-5" }
 *       }
 *     }
 *   }
 * }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface RocketChatConfig {
  serverUrl: string;
  username: string;
  password: string;
  channels: string[];
  prefix?: string;
  dm?: boolean;
}

interface WorkflowConfig {
  description?: string;
  instructions?: string;
  model?: { provider: string; id: string };
}

interface Room {
  _id: string;
  name: string;
  t: string; // 'c' = channel, 'p' = private, 'd' = DM
}

interface ChatMessage {
  _id: string;
  msg: string;
  u: { username: string; _id: string };
  ts: string;
  rid: string;
  editedAt?: string;
  tmid?: string;
}

interface QueuedMessage {
  roomId: string;
  roomName: string;
  messageId: string;
  text: string;
  timestamp: Date;
}

// Per-channel isolated agent session
interface ChannelState {
  session: any | null; // AgentSession — typed as any to avoid import gymnastics
  queue: QueuedMessage[];
  processing: boolean;
}

// ---------------------------------------------------------------------------
// Stale jiti-cache cleanup (keeps hot-reload fast)
// ---------------------------------------------------------------------------
try {
  const _fs = require("fs") as typeof import("fs");
  const _os = require("os") as typeof import("os");
  const _path = require("path") as typeof import("path");
  const _cacheDir = _path.join(_os.tmpdir(), "jiti");
  for (const _f of _fs.readdirSync(_cacheDir).filter((f: string) => f.startsWith("rocketchat-"))) {
    _fs.unlinkSync(_path.join(_cacheDir, _f));
  }
} catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Constants & logging
// ---------------------------------------------------------------------------

const RC_STATE_FILE = `${process.env.HOME}/.pi/agent/extensions/rocketchat/state.json`;
const RC_LOG_FILE   = `${process.env.HOME}/.pi/agent/extensions/rocketchat/rocketchat.log`;

async function rcLog(level: string, message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    const fs = await import("node:fs/promises");
    await fs.appendFile(RC_LOG_FILE, line);
  } catch {
    console.log(`[RC] ${line.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Rocket.Chat REST API client
// ---------------------------------------------------------------------------

class RocketChatClient {
  private serverUrl: string;
  private authToken = "";
  private userId = "";
  private username = "";
  private connected = false;
  private rooms: Map<string, Room> = new Map();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  hasLoggedRoomNames = false;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
  }

  async login(username: string, password: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/v1/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error(`Login failed: ${res.statusText}`);
      const data = await res.json() as { status: string; data?: { authToken: string; userId: string } };
      if (data.status === "success" && data.data) {
        this.authToken = data.data.authToken;
        this.userId = data.data.userId;
        this.username = username;
        this.connected = true;
        this.reconnectAttempts = 0;
        return true;
      }
      return false;
    } catch (err) {
      console.error("Rocket.Chat login error:", err);
      return false;
    }
  }

  isConnected(): boolean { return this.connected; }
  getUsername(): string  { return this.username; }
  shouldReconnect(): boolean { return this.reconnectAttempts < this.maxReconnectAttempts; }
  incrementReconnect(): void { this.reconnectAttempts++; }
  markDisconnected(): void   { this.connected = false; }

  private headers(): Record<string, string> {
    return {
      "X-Auth-Token": this.authToken,
      "X-User-Id": this.userId,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(endpoint: string, init?: RequestInit): Promise<T | null> {
    try {
      const res = await fetch(`${this.serverUrl}/api/v1${endpoint}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers ?? {}) },
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        // Non-JSON almost always means the session has expired (login page / plain-text error)
        rcLog("WARN", `Non-JSON response from ${endpoint} (${ct}) — marking session as disconnected`);
        this.connected = false;
        return null;
      }
      const body = await res.json() as any;
      if (!res.ok) {
        rcLog("WARN", `API error ${res.status} ${endpoint}: ${body.message ?? res.statusText}`);
        if (res.status === 401) this.connected = false;
        return null;
      }
      return body as T;
    } catch (err: any) {
      rcLog("ERROR", `Request failed ${endpoint}: ${err.message}`);
      return null;
    }
  }

  /** Returns null on API/network error, [] if server says no rooms. */
  async getRooms(): Promise<Room[] | null> {
    const data = await this.request<{ update?: Room[] }>("/rooms.get");
    if (data === null) return null;          // API or auth error
    if (!data.update) return [];             // Legitimate empty list
    this.rooms.clear();
    for (const r of data.update) this.rooms.set(r._id, r);
    return data.update;
  }

  getRoom(id: string): Room | undefined { return this.rooms.get(id); }

  async getMessages(roomId: string, since?: Date, limit = 50): Promise<ChatMessage[]> {
    const room = this.rooms.get(roomId);
    const qs = `roomId=${encodeURIComponent(roomId)}&count=${limit}${since ? `&oldest=${since.toISOString()}` : ""}`;
    let endpoint: string;
    if (room?.t === "c")      endpoint = `/channels.history?${qs}`;
    else if (room?.t === "p") endpoint = `/groups.history?${qs}`;
    else if (room?.t === "d") endpoint = `/im.history?${qs}`;
    else {
      // Unknown type — try each in turn
      for (const base of ["/channels.history", "/groups.history", "/im.history"]) {
        const d = await this.request<{ messages?: ChatMessage[]; success?: boolean }>(`${base}?${qs}`);
        if (d?.success) return d.messages ?? [];
      }
      return [];
    }
    const data = await this.request<{ messages?: ChatMessage[] }>(endpoint);
    return data?.messages ?? [];
  }

  async sendMessage(roomId: string, message: string, threadId?: string): Promise<boolean> {
    // Rocket.Chat rejects messages longer than ~5000 chars with 400 Bad Request.
    // Split into chunks at natural paragraph/line/word boundaries.
    const MAX_CHUNK = 4000;
    const chunks: string[] = [];
    let remaining = message.trim();
    while (remaining.length > MAX_CHUNK) {
      // Prefer double-newline (paragraph), then single newline, then space.
      let splitAt = remaining.lastIndexOf("\n\n", MAX_CHUNK);
      if (splitAt < MAX_CHUNK / 2) splitAt = remaining.lastIndexOf("\n", MAX_CHUNK);
      if (splitAt < MAX_CHUNK / 2) splitAt = remaining.lastIndexOf(" ", MAX_CHUNK);
      if (splitAt <= 0) splitAt = MAX_CHUNK;
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);

    let allSent = true;
    for (const chunk of chunks) {
      const msg: Record<string, string> = { rid: roomId, msg: chunk };
      if (threadId) msg.tmid = threadId;
      const data = await this.request<{ success?: boolean }>("/chat.sendMessage", {
        method: "POST",
        body: JSON.stringify({ message: msg }),
      });
      if (data?.success !== true) allSent = false;
    }
    return allSent;
  }

  async getDirectRoomId(username: string): Promise<string | null> {
    const data = await this.request<{ room?: { _id: string } }>("/im.create", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    return data?.room?._id ?? null;
  }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let rocketChatClient: RocketChatClient | null = null;
let config: RocketChatConfig | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let lastMessageTimestamps: Map<string, Date> = new Map();
let channelWorkflows: Record<string, WorkflowConfig> = {};

// Per-channel isolated sessions (the core of the new architecture)
const channelStates: Map<string, ChannelState> = new Map();

// Shared auth across all RC sessions (avoids multiple instances hitting auth.json)
let sharedAuth: { authStorage: any; modelRegistry: any } | null = null;

function getSharedAuth() {
  if (!sharedAuth) {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    sharedAuth = { authStorage, modelRegistry };
  }
  return sharedAuth;
}

// ---------------------------------------------------------------------------
// Per-channel isolated AgentSession management
// ---------------------------------------------------------------------------

async function createChannelSession(channelName: string): Promise<any> {
  const { authStorage, modelRegistry } = getSharedAuth();
  const workflow = channelWorkflows[channelName];

  // Build system prompt override with workflow instructions
  const systemPromptOverride = workflow?.instructions
    ? (base: string | undefined) =>
        (base ?? "") +
        `\n\nYou are responding to messages from the Rocket.Chat channel "#${channelName}". ${workflow.instructions}`
    : undefined;

  // Resolve workflow model if specified
  let model: any;
  if (workflow?.model) {
    model = modelRegistry.find(workflow.model.provider, workflow.model.id);
    if (model) {
      rcLog("INFO", `Channel #${channelName} → model ${workflow.model.provider}/${workflow.model.id}`);
    } else {
      rcLog("WARN", `Model ${workflow.model.provider}/${workflow.model.id} not found for #${channelName}, using default`);
    }
  }

  // noExtensions: true is CRITICAL — without it the rocketchat extension loads
  // itself into the sub-session, starts a competing poller, and creates an
  // infinite loop.
  const loader = new DefaultResourceLoader({
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    ...(model ? { model } : {}),
  });

  const modelLabel = model
    ? `${workflow?.model?.provider}/${workflow?.model?.id}`
    : "default model (no workflow model configured)";
  rcLog("INFO", `Created isolated RC session for #${channelName} using ${modelLabel}`);
  return session;
}

/** Send a prompt to a channel session and return the final text response. */
async function promptSession(session: any, text: string): Promise<string> {
  let lastText = "";
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "turn_end" && event.message?.role === "assistant") {
      const t = (event.message.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text ?? "")
        .join("");
      if (t.trim()) lastText = t.trim();
    }
  });
  try {
    await session.prompt(text);
    return lastText;
  } finally {
    unsubscribe();
  }
}

/** Process the next queued message for a channel (recursive tail-call). */
async function processChannelQueue(channelName: string): Promise<void> {
  const state = channelStates.get(channelName);
  if (!state || state.processing || state.queue.length === 0) return;

  state.processing = true;
  const item = state.queue[0];

  try {
    // Lazily create session on first message
    if (!state.session) {
      state.session = await createChannelSession(channelName);
    }

    const wf = channelWorkflows[channelName];
    const modelLabel = wf?.model ? `${wf.model.provider}/${wf.model.id}` : "default model";
    rcLog("INFO", `[#${channelName}] Processing with ${modelLabel}: "${item.text.substring(0, 80)}"`);
    const response = await promptSession(state.session, item.text);

    if (response) {
      const sent = await rocketChatClient!.sendMessage(item.roomId, response);
      if (sent) {
        rcLog("INFO", `[#${channelName}] Response sent`);
      } else {
        rcLog("ERROR", `[#${channelName}] Failed to send response to Rocket.Chat`);
      }
    } else {
      rcLog("WARN", `[#${channelName}] Agent produced no text response`);
    }
  } catch (err: any) {
    rcLog("ERROR", `[#${channelName}] Error processing message: ${err.message}`);
  } finally {
    state.queue.shift();
    state.processing = false;
    if (state.queue.length > 0) {
      processChannelQueue(channelName).catch((e: any) =>
        rcLog("ERROR", `[#${channelName}] Queue continuation error: ${e.message}`)
      );
    }
  }
}

/** Add a message to a channel's queue and kick off processing. */
function enqueueMessage(msg: QueuedMessage): void {
  let state = channelStates.get(msg.roomName);
  if (!state) {
    state = { session: null, queue: [], processing: false };
    channelStates.set(msg.roomName, state);
  }
  state.queue.push(msg);
  processChannelQueue(msg.roomName).catch((e: any) =>
    rcLog("ERROR", `[#${msg.roomName}] Failed to start queue: ${e.message}`)
  );
}

/** Dispose and remove a channel's session (clears conversation history). */
function clearChannelSession(channelName: string): void {
  const state = channelStates.get(channelName);
  if (state?.session) {
    try { state.session.dispose(); } catch { /* ignore */ }
  }
  channelStates.delete(channelName);
  rcLog("INFO", `Session cleared for #${channelName}`);
}

/** Dispose all channel sessions (called on shutdown). */
function disposeAllSessions(): void {
  for (const [name, state] of channelStates) {
    if (state.session) {
      try { state.session.dispose(); } catch { /* ignore */ }
    }
    rcLog("INFO", `Disposed session for #${name}`);
  }
  channelStates.clear();
}

// ---------------------------------------------------------------------------
// State persistence (message timestamps → survive restarts)
// ---------------------------------------------------------------------------

async function loadState(): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(RC_STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    if (state.lastMessageTimestamps) {
      lastMessageTimestamps = new Map(
        Object.entries(state.lastMessageTimestamps).map(([k, v]) => [k, new Date(v as string)])
      );
    }
  } catch { /* no state file yet */ }
}

async function saveState(): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      RC_STATE_FILE,
      JSON.stringify({ lastMessageTimestamps: Object.fromEntries(lastMessageTimestamps) }, null, 2)
    );
  } catch {
    rcLog("WARN", "Failed to save state");
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function getConfig(): Promise<RocketChatConfig | null> {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(`${process.env.HOME}/.pi/agent/settings.json`, "utf-8");
    const settings = JSON.parse(raw);
    const rc = settings.rocketChat ?? null;
    if (!rc) return null;
    if (!rc.channels) rc.channels = [];
    if (settings.rocketChat?.workflows) {
      channelWorkflows = settings.rocketChat.workflows;
      for (const ch of Object.keys(channelWorkflows)) {
        if (!rc.channels.includes(ch)) {
          rc.channels.push(ch);
          rcLog("INFO", `Added workflow channel "${ch}" to polling list`);
        }
      }
    }
    return rc;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function checkMessages(): Promise<void> {
  if (!rocketChatClient || !config) return;

  // Re-authenticate if session expired
  if (!rocketChatClient.isConnected()) {
    rcLog("INFO", "Session expired, re-logging in…");
    const ok = await rocketChatClient.login(config.username, config.password);
    if (!ok) { rcLog("ERROR", "Re-login failed, skipping poll"); return; }
    rcLog("INFO", "Re-login successful");
  }

  try {
    const rooms = await rocketChatClient.getRooms();

    if (rooms === null) {
      // API error (auth expired, network problem) — force re-login on next tick
      rcLog("WARN", "getRooms() failed — marking disconnected so next poll re-authenticates");
      rocketChatClient.markDisconnected();
      return;
    }

    // Log room names once when we first get a non-empty list, to help diagnose name mismatches
    if (rooms.length > 0 && !rocketChatClient.hasLoggedRoomNames) {
      rocketChatClient.hasLoggedRoomNames = true;
      const names = rooms.map((r) => `${r.name}(${r.t})`).join(", ");
      rcLog("INFO", `Rooms visible to bot: ${names}`);
    }

    // Do NOT prune the configured channel list based on getRooms() results —
    // an empty or partial list may just reflect an API hiccup, not a missing channel.
    // Instead, skip rooms that aren't in config and warn once per unknown channel.
    const warnedChannels = new Set<string>();
    for (const ch of config.channels) {
      if (!rooms.some((r) => r.name === ch || r.name === ch.replace(/^#/, ""))) {
        if (!warnedChannels.has(ch)) {
          warnedChannels.add(ch);
          rcLog("WARN", `Channel "${ch}" not in rooms list — bot may not be a member, or name mismatch`);
        }
      }
    }

    for (const room of rooms) {
      // Normalise name for matching (strip leading # if present)
      const roomName = room.name?.replace(/^#/, "") ?? "";
      if (config.channels.length > 0 && !config.channels.some((ch) => ch === roomName || ch === room.name)) continue;

      const since = lastMessageTimestamps.get(room._id);
      const messages = await rocketChatClient.getMessages(room._id, since);

      for (const msg of messages) {
        // Skip own messages
        if (msg.u.username === config.username) continue;

        // Advance timestamp so we don't re-process this message next poll
        const ts = new Date(msg.ts);
        ts.setMilliseconds(ts.getMilliseconds() + 1);
        lastMessageTimestamps.set(room._id, ts);

        // Built-in clear-context command (always recognised, no prefix needed)
        if (msg.msg.toLowerCase() === "!clear-context") {
          clearChannelSession(roomName);
          await rocketChatClient.sendMessage(
            room._id,
            "Context cleared. Next message will start with fresh history."
          );
          continue;
        }

        // Prefix filtering
        const prefix = config.prefix !== undefined ? config.prefix : "!";
        if (prefix && !msg.msg.startsWith(prefix)) continue;
        const text = prefix ? msg.msg.slice(prefix.length).trim() : msg.msg;
        if (!text) continue;

        const wf = channelWorkflows[roomName];
        const modelLabel = wf?.model ? `${wf.model.provider}/${wf.model.id}` : "default model";
        rcLog("INFO", `Queuing from ${msg.u.username} in #${roomName} (${modelLabel}): "${text.substring(0, 60)}"`);
        enqueueMessage({
          roomId: room._id,
          roomName,
          messageId: msg._id,
          text,
          timestamp: new Date(msg.ts),
        });
      }
    }

    await saveState();
  } catch (err: any) {
    rcLog("ERROR", `Polling error: ${err.message}`);
  }
}

async function startPolling(): Promise<void> {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(() => {
    checkMessages().catch((e: any) => rcLog("ERROR", `Poll tick error: ${e.message}`));
  }, 10_000);
}

async function stopPolling(): Promise<void> {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

async function connect(): Promise<boolean> {
  if (!config) config = await getConfig();
  if (!config) return false;

  rocketChatClient = new RocketChatClient(config.serverUrl);
  let ok = await rocketChatClient.login(config.username, config.password);

  if (!ok && rocketChatClient.shouldReconnect()) {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      ok = await rocketChatClient.login(config.username, config.password);
      if (ok) break;
    }
  }

  if (ok) {
    rcLog("INFO", `Connected as ${config.username}`);
    await loadState();
    await startPolling();
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Lifecycle
  pi.on("session_start", async () => { await connect(); });
  pi.on("session_shutdown", async () => {
    disposeAllSessions();
    await stopPolling();
    rocketChatClient = null;
  });

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  pi.registerCommand("rocketchat-connect", {
    description: "Connect to Rocket.Chat",
    handler: async (_args, ctx) => {
      const ok = await connect();
      ctx.ui.notify(ok ? "Connected to Rocket.Chat" : "Failed to connect", ok ? "success" : "error");
    },
  });

  pi.registerCommand("rocketchat-disconnect", {
    description: "Disconnect from Rocket.Chat",
    handler: async (_args, ctx) => {
      disposeAllSessions();
      await stopPolling();
      rocketChatClient = null;
      ctx.ui.notify("Disconnected from Rocket.Chat", "info");
    },
  });

  pi.registerCommand("rocketchat-status", {
    description: "Show Rocket.Chat connection status",
    handler: async (_args, ctx) => {
      if (!rocketChatClient?.isConnected()) {
        ctx.ui.notify("Rocket.Chat: Not connected", "info");
        return;
      }
      const sessions = channelStates.size;
      const queued = [...channelStates.values()].reduce((n, s) => n + s.queue.length, 0);
      ctx.ui.notify(
        `Rocket.Chat: Connected as ${rocketChatClient.getUsername()} · ${sessions} channel session(s) · ${queued} queued`,
        "success"
      );
    },
  });

  pi.registerCommand("rocketchat-send", {
    description: "Send a message to a Rocket.Chat channel",
    getArgumentCompletions: () => config?.channels.map((c) => ({ value: c, label: c })) ?? [],
    handler: async (args, ctx) => {
      if (!rocketChatClient?.isConnected()) {
        ctx.ui.notify("Not connected to Rocket.Chat", "error");
        return;
      }
      const parts = args.split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /rocketchat-send #channel <message>", "error");
        return;
      }
      const channelName = parts[0].replace(/^#/, "");
      const message = parts.slice(1).join(" ");
      const rooms = await rocketChatClient.getRooms();
      const room = rooms?.find((r) => r.name === channelName || r.name === channelName.replace(/^#/, ""));
      if (!room) { ctx.ui.notify(`Channel not found: ${channelName}`, "error"); return; }
      const sent = await rocketChatClient.sendMessage(room._id, message);
      ctx.ui.notify(sent ? "Message sent" : "Failed to send", sent ? "success" : "error");
    },
  });

  pi.registerCommand("rocketchat-reset-state", {
    description: "Reset Rocket.Chat state (clears saved message timestamps)",
    handler: async (_args, ctx) => {
      lastMessageTimestamps.clear();
      try {
        const fs = await import("node:fs/promises");
        await fs.unlink(RC_STATE_FILE).catch(() => {});
      } catch { /* ignore */ }
      ctx.ui.notify("Rocket.Chat state reset", "success");
    },
  });

  pi.registerCommand("rocketchat-clear-context", {
    description: "Clear the saved conversation context for a Rocket.Chat channel",
    getArgumentCompletions: () =>
      [...channelStates.keys()].map((c) => ({ value: c, label: c })),
    handler: async (args, ctx) => {
      const channel = args?.trim();
      if (!channel) {
        ctx.ui.notify("Usage: /rocketchat-clear-context <channel-name>", "warn");
        return;
      }
      clearChannelSession(channel);
      ctx.ui.notify(`Cleared context for #${channel}. Next message starts fresh.`, "info");
    },
  });

  pi.registerCommand("rocketchat-logs", {
    description: "Show recent Rocket.Chat extension logs",
    handler: async (_args, ctx) => {
      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(RC_LOG_FILE, "utf-8").catch(() => "No logs yet.");
        const lines = content.split("\n").filter((l) => l.trim()).slice(-50);
        ctx.ui.notify(`Last ${lines.length} log lines:\n${lines.join("\n")}`, "info");
      } catch (err) {
        ctx.ui.notify(`Error reading logs: ${err}`, "error");
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: the LLM in the main session can still send RC messages on request
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "rocketchat_send",
    label: "Send to Rocket.Chat",
    description:
      "Send a message to a Rocket.Chat channel or direct message. " +
      "Use this when the user asks to send something to a Rocket.Chat channel.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name (without #) or username for DMs" },
        message: { type: "string", description: "The message to send" },
      },
      required: ["channel", "message"],
    } as any,
    async execute(_toolCallId, params) {
      if (!rocketChatClient?.isConnected()) throw new Error("Not connected to Rocket.Chat");
      const rooms = await rocketChatClient.getRooms();
      const room = rooms?.find(
        (r) => r.name === params.channel || r.name === (params.channel as string).replace(/^#/, "")
      );
      if (!room) throw new Error(`Channel not found: ${params.channel}`);
      const sent = await rocketChatClient.sendMessage(room._id, params.message);
      if (!sent) throw new Error("Failed to send message");
      await rcLog("INFO", `Tool sent to #${params.channel}: ${(params.message as string).substring(0, 80)}`);
      return { content: [{ type: "text", text: `Message sent to #${params.channel}` }] };
    },
  });

  console.log("Rocket.Chat extension loaded (isolated-session architecture)");
}
