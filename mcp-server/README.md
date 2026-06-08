# apex-bdr local MCP server

Lets Claude Desktop send emails through this app's existing Microsoft 365 / Outlook integration. The app already has IT-blessed permission to send via Outlook; Claude Desktop reaches that capability through a local stdio MCP server, never touching Outlook directly.

**Tools exposed:**
- `send_email` — fresh outbound send. Returns a `messageId` you can chain into a reply.
- `reply_to_email` — true RFC 5322 threaded reply. `In-Reply-To` + `References` headers + `conversationId` all preserved by Microsoft Graph, so the reply lands in the same Outlook conversation as the original. Use this for sequence steps 2-N so follow-ups thread under the first send.

Both tools only require the `Mail.Send` + `Mail.Read` scopes you've already granted. **No new admin consent needed.**

```
Claude Desktop  ──stdio──▶  mcp-server (this folder)  ──HTTP──▶  apex-bdr app  ──Graph──▶  Outlook
                                       │
                                       └── MCP_BRIDGE_TOKEN (Bearer)
```

The server hosts a single tool, `send_email`, which calls the app's `POST /api/mcp/send-email` endpoint. Microsoft credentials never leave the app — this server is just a thin broker.

---

## 1. Configure the app

In the apex-bdr repo's `.env` (the backend's env file), set:

```
MCP_BRIDGE_TOKEN=<generate a random secret, e.g. `openssl rand -hex 32`>
```

The bridge endpoint is **off by default** when `MCP_BRIDGE_TOKEN` is unset — `POST /api/mcp/send-email` returns `503 MCP bridge disabled`. Setting the token turns it on.

Restart the backend so it picks up the env var.

Sanity check that the app is reachable and the bridge is enabled:

```sh
curl http://localhost:3000/api/mcp/health
# → {"ok":true,"bridgeEnabled":true}
```

You must also have signed into the app with Microsoft at least once so an `IntegrationCredential` row exists. The bridge picks the first connected Microsoft account by default (override per call with the `from` arg).

---

## 2. Install the MCP server

```sh
cd mcp-server
npm install
```

Requires Node 18+ (for the global `fetch`).

---

## 3. Test locally without Claude Desktop

With the app running on `localhost:3000`:

**Send:**

```sh
MCP_BRIDGE_URL=http://localhost:3000 \
MCP_BRIDGE_TOKEN=<your secret> \
node test-local.js you@c3.ai "Bridge test" "Hello from the local MCP."
```

You should see:

```
RESULT (ok):
✅ Sent.
   from:       henry.whittle@c3.ai
   to:         you@c3.ai
   subject:    Bridge test
   messageId:  AAMkAGE5MjU4...
   inetMsgId:  <abc...@outlook.com>
   convoId:    AAQkAGE5...
   latency:    812ms

To send a threaded reply later, pass the messageId above as inReplyToMessageId to reply_to_email.
```

**Reply** (using the `messageId` from the send above):

```sh
MCP_BRIDGE_URL=http://localhost:3000 \
MCP_BRIDGE_TOKEN=<your secret> \
node test-local.js reply AAMkAGE5MjU4... "Following up on my note — does Thursday work?"
```

Optional flags:
- `--replyAll` — reply to To + CC of the original instead of just the sender
- `--noQuote` — send only the new body, skip the auto-quoted original

Check Outlook — the reply should be in the same conversation as the original, with `Re: Bridge test` as subject.

If anything fails, the result message will name the cause (token wrong, no Microsoft account connected, message ID not found, Graph rejected with code X, etc.).

---

## 4. Register with Claude Desktop

Open Claude Desktop's config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add an `mcpServers` entry. If the file is empty, this is the whole file:

```json
{
  "mcpServers": {
    "apex-bdr": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/apex-bdr/mcp-server/index.js"],
      "env": {
        "MCP_BRIDGE_URL": "http://localhost:3000",
        "MCP_BRIDGE_TOKEN": "<same secret as the app's MCP_BRIDGE_TOKEN>"
      }
    }
  }
}
```

If you already have other MCP servers configured, just add the `apex-bdr` entry to the existing `mcpServers` object — don't overwrite.

> Replace `/ABSOLUTE/PATH/TO/apex-bdr/mcp-server/index.js` with the actual absolute path on your machine. `~` is not expanded by Claude Desktop here.

Restart Claude Desktop. In the chat input, the hammer/plug icon should now list `apex-bdr` → `send_email`. You can also confirm by asking Claude something like *"What tools do you have available?"*.

---

## 5. Send an email through Claude

In a Claude Desktop chat, say something like:

> Send an email to laura@example.com saying "Following up on our Q3 call — does Thursday at 10am work for a 30-min recap?" Subject: "Quick follow-up".

Claude will propose calling `send_email(...)`. **Claude Desktop will show the per-call approval prompt** with the exact arguments — read them, then approve or reject. There is no auto-approve in this server.

---

## Notes

- **Server logging**: this server logs to `stderr`, never `stdout`. (MCP uses `stdout` for JSON-RPC; anything else there would break the protocol.) Logs surface in Claude Desktop's MCP server log pane.
- **Timeout**: 15s per tool call (override with `MCP_REQUEST_TIMEOUT_MS`).
- **HTML / links in body**: the bridge auto-linkifies bare URLs and `[label](url)` markdown. You can also paste raw HTML and it'll be sent as-is.
- **Choosing the sending account**: if you have multiple Microsoft accounts connected to the app, pass `from` to the tool with the address you want to send from. Otherwise the bridge picks the first connected account.

### Threading model for `reply_to_email`

Microsoft Graph offers three reply patterns. We use the one that gives true threading with the smallest scope footprint:

| Pattern | Scopes needed | True thread? | Body control? |
|---|---|---|---|
| `/me/messages/{id}/createReply` → patch → `/send` | `Mail.ReadWrite` + `Mail.Send` | ✅ | full |
| `/me/sendMail` with custom `internetMessageHeaders` | `Mail.Send` | ❌ Graph rejects `In-Reply-To`/`References` (only `x-*` allowed) | full |
| **`/me/messages/{id}/reply` with `message.body` override** ← what we use | `Mail.Send` | ✅ | full |

The `/reply` endpoint asks Graph to handle the threading on its end — it sets `In-Reply-To`, `References`, and inherits `conversationId` from the original — while still letting us override the body with our own HTML. When `includeOriginalBody=true`, we manually `GET /me/messages/{id}` to fetch the original and prepend our content above a styled quote block (needs `Mail.Read`, already granted).

**ID accepted:** the Graph resource ID (long opaque base64-ish string, what `send_email` returns as `messageId`). RFC 5322 `internetMessageId` values (containing `@`, often `<…>`-wrapped) are also accepted and auto-resolved to the Graph ID via `$filter=internetMessageId eq '…'`.

---

## Why a local stdio server and not a remote connector?

A remote Anthropic-hosted connector would route through Anthropic's cloud, which can't reach a service bound to `localhost` or anything inside your corporate network. A local stdio server runs on the same machine as Claude Desktop and talks to the app over loopback, so the corporate-network restrictions on the app still apply.
