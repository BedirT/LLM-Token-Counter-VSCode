# Change Log

All notable changes to the "gpt-token-counter" extension will be documented in this file.

## [1.2.2]

### Added
- Changelog file.

## [1.2.1]

### Changed
- Moved from `gpt-tokenizer` to `tiktoken` package.

### Fixed
- Fixed the special tokens issue.

## [1.2.0]

### Added
- Added support for GPT-4o tokenizer.
- Added Claude-3 as option using approximate token count.

### Changed
- Modified the code to increase security.

### Removed
- Removed unused models from the tokenizer list.

## [1.1.0]

### Added
- Added support for Claude tokenizer.

## [1.0.0]

### Added
- Initial release of gpt-token-counter-live.
- Provides a token count in the status bar for the selected text or the entire document.
- Automatically updates the token count as text is edited or selected.
- Allows the user to select the model to use for token counting.
