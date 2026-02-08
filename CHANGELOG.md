# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


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