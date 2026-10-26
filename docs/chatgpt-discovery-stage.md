# MCP discovery-only staging

Base: 45a03f899f4cf0a37b082cc6bf55cc7bd853c6c9.

The exact ChatGPT callback remains unverified. Do not register a client, guess a callback, use a wildcard, or enable generation.

First stage configuration:
- PINA_MCP_DISCOVERY_ONLY=true
- PINA_MCP_ORIGIN=the exact HTTPS deployment origin being tested
- PINA_MCP_ENABLED=false
- PINA_MCP_ALLOW_GENERATION=false

Only OAuth authorization-server metadata and protected-resource metadata are available. The MCP endpoint always returns 401; authorization, token, revocation, browser-session, and approval routes return 503. No database, OAuth client, or secret initialization occurs. The openid-configuration aliases provide OAuth metadata only, not full OpenID Connect discovery. Actual ChatGPT discovery compatibility remains a deployment test.

Production origin, after staged verification: https://www.pinastudio.jp. The server URL is https://www.pinastudio.jp/api/mcp. Inspect the actual ChatGPT OAuth form to obtain the exact callback before installing a usable client. This stage does not make the app connected or complete.

Rollback: set discovery-only false with MCP_ENABLED=false, or restore the prior deployment. No database or balance changes occur in this stage. Keep Preview protection enabled.
