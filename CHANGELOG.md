# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Server-side conversation search endpoint for full-history lookup (`GET /api/admin/conversations/search`)
- Search by tag in CRM (`tag:<nome>`, `#<nome>`, or direct known tag like `urgente`)
- Quick tag chips in conversation list search
- "Limpar" button in search box to clear text and active tag filter
- Batch reopen capabilities endpoint (`GET /api/admin/reopen-outdated-conversations/capabilities`)
- Batch reopen with scope and preview (`POST /api/admin/reopen-outdated-conversations` with `scope` + `preview`)
- Staging-only test scope (`staging_test`) restricted by `REOPEN_TEST_ALLOWED_PHONES`
- Result modal after batch reopen execution (same popup family used by preview)

### Changed
- Conversation search no longer depends only on locally loaded lists (50 per tab)
- Search now combines local results with backend results for better recall
- Administrative tools now separate batch reopen by scope (`Bot` and `Ativas`)
- Batch reopen success feedback now uses modal summary instead of toast

### Fixed
- Preview flow no longer updates conversation `updated_at` while checking 24h window


## [1.2.0] - 2026-02-08

### Added
- WhatsApp ProfileName capture from Twilio and display in CRM
- Separate display of declared name (CX) vs WhatsApp profile name
- Conversation takeover to transfer active/claimed conversations
- Quick replies per user with optional shortcuts
- Conversation tags with colored labels
- Assignee name surfaced in conversation list and header
- Basic spellcheck-enabled composer (textarea)

### Changed
- Claimed/active conversations are visible to all agents; only assignee can send
- Conversation list shows declared name + WhatsApp profile + phone number
- Selected conversation refreshes on list updates without switching selection

### Fixed
- List and message view sync when switching conversations

## [1.1.0] - 2026-01-16

### Added
- Robust parameter extraction from Dialogflow CX responses (query_result.parameters, sessionInfo.parameters)
- Compatibility for handoff parameter names (handoff_request, handoff_requested)
- CPU always allocated in Cloud Run for reliable async processing
- Concurrency set to 10 to prevent overload

### Fixed
- Handoff detection bug when conversation was resolved
- Missing handoff_request parameter capture from sessionInfo
- Async processing reliability with CPU throttling disabled

### Changed
- Standardized DF_HANDOFF_PARAM to handoff_request

## [1.0.0] - 2026-01-08

### Added
- Automatic retry mechanism for SSLEOFError with exponential backoff
- HTTP session with retry configuration for Twilio API calls
- SSL/connection error handling across webh and crm-api services

### Changed
- Replaced direct requests calls with retry-enabled session in send_whatsapp_text, send_twilio_template, _twilio_send_whatsapp, _twilio_send_template, proxy_media

### Technical Details
- Retry parameters: total=3, backoff_factor=0.5, status_forcelist=(500,502,503,504)
