# Changelog

## [0.2.0](https://github.com/webmakersteve/wcl-mcp/compare/v0.1.0...v0.2.0) (2026-10-17)


### Features

* support querying boss health ([aa30308](https://github.com/webmakersteve/wcl-mcp/commit/aa30308d98bdb383b53ebd842a368fbd6cf910a8))
* support reading raw logs from logs directory bypassing wcl ([#4](https://github.com/webmakersteve/wcl-mcp/issues/4)) ([9e74c37](https://github.com/webmakersteve/wcl-mcp/commit/9e74c3723ae6e381929f0528b5e9c6423a6b3ea6))


### Bug Fixes

* allow multiple readers on a single duck db. hold conn lock for short period ([ddd5c10](https://github.com/webmakersteve/wcl-mcp/commit/ddd5c102e40fff81e651a6cbc4c8223ff4fb1719))
* failure to connect would leave mcp unrecoverable ([3b95404](https://github.com/webmakersteve/wcl-mcp/commit/3b9540482cfbb7a0e8411c62660cfdf242dfbd47))
* mdt schema not orphaned on log schema update ([0620d91](https://github.com/webmakersteve/wcl-mcp/commit/0620d91d9b97f5e548f8b7ea8e688af7ae6030e9))
* schema level ttls ([98b77c0](https://github.com/webmakersteve/wcl-mcp/commit/98b77c0acf4521ae236d2db126ca4fe470082067))

## 0.1.0 (2026-10-16)


### Features

* package as a Claude Code plugin with automated releases ([3137827](https://github.com/webmakersteve/wcl-mcp/commit/3137827cdd6dca591ee769dbf2e8d38ca3da683b))
