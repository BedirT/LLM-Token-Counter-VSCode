# Change Log

All notable changes to the "gpt-token-counter" extension will be documented in this file.

## [1.5.0]

### Added
- HuggingFace tokenizer family: load any `tokenizer.json` from the Hub (first launch fetches + caches) or a local file.
  - New settings: `huggingfaceModelId` and `huggingfaceTokenizerPath`.
  - Byte-level BPE tokenizers (Qwen, Llama, Mistral, etc.) support highlighting via a decode-based offset reconstruction; SentencePiece tokenizers that transform whitespace still count tokens but skip highlights.
  - `huggingface` added to the `defaultModelFamily` enum and to the Change Model Family quick pick.
- New setting `enabledFilePatterns` to show status bar only for files matching specific glob patterns (e.g., `["*.md", "*.mdc"]`).

### Fixed
- Token highlighting no longer misaligns around multi-byte UTF-8 characters (emoji, CJK). The highlight renderer switched from matching decoded token strings to matching raw UTF-8 bytes against the source, so a token that spans or splits a multi-byte character still lands on the right boundary.
- Claude token highlighting now works on documents containing characters that are rewritten by NFKC normalization (e.g., full-width `（）` becoming ASCII `()`). A per-grapheme offset map reprojects token ranges from the normalized tokenization back onto the original text.

## [1.3.0]

### Added
- Gemini family token counting (approximate). Uses tiktoken `o200k_base`/`cl100k_base` when available; otherwise ~4 chars/token fallback as stated [in their website](https://ai.google.dev/gemini-api/docs/tokens?lang=node#about-tokens).

### Changed
- UI now shows model families (GPT, Claude, Gemini) instead of individual versions.
- GPT tokenizer now uses `gpt-5` tokenizer with `o200k_base` and `cl100k_base` as the fallback.
- Simplified special token handling by family.

## [1.2.5]

### Changed
- Changed "(Approximate)" notation to "*" for Claude models in the UI
- Improved documentation about approximate token counting for Claude models

## [1.2.4]

### Changed
- Minor fixes.

## [1.2.3]

### Added
- Added support for new OpenAI models: o3-mini, o1, o1-mini, gpt-4o-mini
- Added OpenVSX Registry support

### Changed
- Updated to tiktoken 1.0.20
- Updated Claude models to only include Claude-3.5, Claude-3.7

### Removed
- Removed older models: text-davinci-003, davinci, babbage
- Removed Claude-2 and Claude-3

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
