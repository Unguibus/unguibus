# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-15

### Added
- Initial release of unguibus
- **@unguibus/system**: Cross-agent MCP messaging via NATS
  - NATS bridge for reliable message routing
  - HTTP server for REST API endpoints
  - Agent registry for managing connected agents
  - Tool and registry management
- **@unguibus/client**: Node.js/TypeScript client for unguibus messaging
  - Type-safe message publishing and subscription
  - Zod schema validation
- **@unguibus/cli**: CLI tool for managing unguibus MCP configuration
  - Configuration management utilities
  - Command-line interface for unguibus operations

### Dependencies
- Express 5.2.1 for HTTP server
- NATS 2.29.3 for messaging
- MCP SDK 1.29.0 for protocol support
- TypeScript 5.5.0 for development
- Zod 3.25.0 for schema validation
