#!/usr/bin/env sh
# Claude Code: add the Switchboard gateway as a remote MCP server (Streamable HTTP + OAuth).
# Then run /mcp inside Claude Code, pick "switchboard" and Authenticate: a browser opens the sign-in page.
claude mcp add --transport http switchboard http://localhost:8080/mcp

# Or, for one project only (writes .mcp.json in the current directory):
# claude mcp add --scope project --transport http switchboard http://localhost:8080/mcp
