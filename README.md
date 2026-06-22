<div align="center">
    <h1>Live LLM Token Counter</h1>
    <img src="images/icon.png" alt="Live LLM Token Counter logo" width="300" height="300"><br>
    <a href="https://marketplace.visualstudio.com/items?itemName=bedirt.gpt-token-counter-live"><img src="https://img.shields.io/badge/VSCode-v1.5.2-blue?style=flat&logo=visualstudiocode" alt="VS Code Marketplace version"></a>
    <a href="https://open-vsx.org/extension/bedirt/gpt-token-counter-live"><img alt="Open VSX version" src="https://img.shields.io/badge/OpenVSX%20-%20v1.5.2%20-%20%23bb3ec2?style=flat"></a>
    <br><br>
</div>

Live LLM Token Counter is a Visual Studio Code extension for prompt writers, AI app builders, and model evaluators who need local token feedback while editing. It shows live token counts for a selection or the whole document, lets you switch tokenizer families from the status bar, and can paint token boundaries directly over the editor text.

The extension identifier and settings namespace are `gpt-token-counter-live` so existing users keep their installs and settings.

Tokenizer support is provided by [tiktoken](https://www.npmjs.com/package/tiktoken) for GPT/OpenAI models, [Anthropic's tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript) for Claude, a local Gemini approximation, and [@huggingface/tokenizers](https://www.npmjs.com/package/@huggingface/tokenizers) for HuggingFace `tokenizer.json` files such as Qwen, Llama, and Mistral.

**NEW in v1.5.2:** Restored the original handmade logo and visible extension name while keeping the corrected project support link and clearer listing copy.

**NEW in v1.5.0:** Count and highlight tokens for **any HuggingFace tokenizer** (Qwen, Llama, Mistral, and more), loaded from the Hub or a local `tokenizer.json`. Plus **file pattern filtering** to scope the counter to specific file types.

<div align="center">
    <img src="images/hero.gif" alt="Live LLM Token Counter in action" width="800">
</div>

## Features

### Real-Time Token Counting
Live token counting for the current selection or entire document, displayed directly in the status bar. Counts update automatically as you type or change your selection.

### Multi-Model Family Support
Click the status bar to switch between model families: GPT (OpenAI), Claude (Anthropic), Gemini (Google AI), or HuggingFace.

<div align="center">
    <img src="images/model_picker.gif" alt="Model family selection" width="800">
</div>

- **GPT (OpenAI):** Uses tiktoken `encoding_for_model('gpt-5')` with fallbacks to `o200k_base` → `cl100k_base` for accurate token counting across all GPT models.
- **Claude (Anthropic):** Uses Anthropic's official tokenizer for precise token boundaries with full highlighting support.
- **Gemini (Google AI):** Approximates tokens using GPT encodings or ~4 chars/token fallback (highlighting not available).
- **HuggingFace:** Loads a `tokenizer.json` from the Hub (or a local file) and reuses it for live counts. Byte-level BPE tokenizers (Qwen, Llama, Mistral, etc.) support highlighting; SentencePiece tokenizers that alter whitespace fall back to counting only.

### Visual Token Highlighting
See your tokens in real-time with alternating color bands that show exactly where each token begins and ends. Available for GPT, Claude, and HuggingFace byte-level BPE tokenizers (Qwen, Llama, Mistral, etc.).

<div align="center">
    <img src="images/highlight_on_off.gif" alt="Token highlighting toggle" width="800">
</div>

**Key features:**
- **Toggle on/off:** Click the palette icon in the status bar to enable or disable highlighting.
- **Smart text contrast:** Foreground text color automatically adapts to your highlight colors for readability.
- **Customizable colors:** Choose your own colors with alpha/transparency support.
- **Editor-aware:** Only highlights in text editors; Output and Debug panes remain clean.

### Customizable Highlight Colors
Open the **Command Palette** and run `Configure Token Highlight Colors` to access a dedicated color configurator.

<div align="center">
    <img src="images/highlight_config.gif" alt="Token highlight configurator" width="800">
</div>

**Features:**
- Separate color pickers for even/odd token bands
- Hex color input with opacity sliders
- Live preview showing exactly how colors will look
- Smart contrast preview so you can ensure text remains readable

### Customizable Status Bar Display
Personalize how token information appears in your status bar using template placeholders.

<div align="center">
    <img src="images/status_bar_template.gif" alt="Status bar template customization" width="800">
</div>

**Supported placeholders:**
- `{count}` - Token count
- `{family}` or `{model}` - Model family name (GPT, Claude, Gemini)
- `{provider}` - Provider name (openai, anthropic, gemini)

## Requirements

- Visual Studio Code: The extension is developed for VS Code and will not work with other editors.
    - It is also hosted on the [Open VSX Registry](https://open-vsx.org/extension/bedirt/gpt-token-counter-live).

## Commands

This extension provides the following commands (accessible via Command Palette):

- **`Change Model Family`**: Switch between GPT (OpenAI), Claude (Anthropic), and Gemini (Google AI) tokenizers. Also accessible by clicking the token count in the status bar.

- **`Toggle Token Highlighting`**: Enable or disable visual token highlighting overlays. Also accessible by clicking the palette icon in the status bar.

- **`Configure Token Highlight Colors`**: Open an interactive color configurator to customize the highlight colors for even and odd token bands. Includes live preview and smart text contrast.

- **`Count Tokens`**: Manually trigger token counting for the current document or selection.

## Extension Settings

This extension contributes the following settings:

### Model & Display Settings
- **`gpt-token-counter-live.defaultModelFamily`**: Choose which model family activates by default when you open VS Code.
  - Options: `openai`, `anthropic`, `gemini`, or `huggingface`
  - Default: `openai`

- **`gpt-token-counter-live.statusBarDisplayTemplate`**: Customize how token information appears in the status bar.
  - Default: `Token Count: {count} ({family})`
  - Supported placeholders: `{count}`, `{family}`, `{model}` (alias for family), `{provider}`

- **`gpt-token-counter-live.enabledFilePatterns`**: Glob patterns for files where the status bar should be shown.
  - Default: `[]` (empty array shows for all files)
  - Example: `["*.md", "*.mdc"]` shows only for markdown files

### HuggingFace Tokenizers

Select `HuggingFace (huggingface)` in the model family picker, then point the extension at a tokenizer with either of the settings below. The first load fetches `tokenizer.json` from the Hub and caches it under the extension's global storage directory, so subsequent launches are offline-friendly.

- **`gpt-token-counter-live.huggingfaceModelId`**: HuggingFace repo ID (e.g. `Qwen/Qwen2.5-7B-Instruct`, `meta-llama/Llama-3-8B`, `mistralai/Mistral-7B-Instruct-v0.3`). The extension fetches `https://huggingface.co/{id}/resolve/main/tokenizer.json` plus `tokenizer_config.json` and caches them on disk.
- **`gpt-token-counter-live.huggingfaceTokenizerPath`**: Absolute path to a local `tokenizer.json` file. When set, it overrides `huggingfaceModelId`. A sibling `tokenizer_config.json` will be picked up automatically if present.

**What works and what doesn't:**

- Byte-level BPE tokenizers (Qwen, Llama, Mistral, most GPT-style tokenizers on the Hub) give **precise token counts and highlighting**.
- SentencePiece / Unigram tokenizers that strip or transform whitespace (T5, some BERT variants) still give precise counts, but highlighting is automatically disabled. Decoding an id sequence back to text doesn't produce an identical string, so offsets can't be attributed reliably. You'll see token counts but no color overlays.
- **Gated or private repositories** cannot be fetched without auth. The first load will surface the raw HTTP status in a VS Code error notification (typically `401` or `403`); download `tokenizer.json` manually and point `huggingfaceTokenizerPath` at it.
- **Missing repositories / offline first-load** show the same error notification and fall back to a rough `~4 chars/token` approximation until the tokenizer resolves.

### Highlighting Configuration
Token highlight colors are stored in your VS Code global state (synced across devices if you have Settings Sync enabled). To customize them select `Configure Token Highlight Colors` option from the Command Palette.

**Quick toggle:** Click the palette icon in the status bar to enable/disable token highlighting instantly.

## Known Issues

There are currently no known issues. If you encounter a problem, please report it on the [issue tracker](https://github.com/BedirT/LLM-Token-Counter-VSCode/issues).

## Release Notes

### 1.5.2 - Restore Original Branding & Fix Marketplace Metadata

**Changed:**

- Restored the original handmade icon and visible extension name.
- Updated support metadata to the project's own issue tracker.
- Rewrote the listing introduction to better describe local token counting, token highlighting, HuggingFace tokenizer loading, and file filters.

### 1.5.1

Superseded by 1.5.2.

### 1.5.0 - HuggingFace Tokenizers & File Pattern Filtering

**New features:**

- **HuggingFace tokenizer family**: load any `tokenizer.json` from the Hub (first launch fetches + caches) or a local file. Byte-level BPE tokenizers (Qwen, Llama, Mistral, etc.) support highlighting; SentencePiece tokenizers that transform whitespace count tokens but skip highlights. Configure via `huggingfaceModelId` or `huggingfaceTokenizerPath`.
- **New setting `enabledFilePatterns`**: Show status bar only for files matching specific glob patterns (e.g., `["*.md", "*.mdc"]`). Empty array shows for all files.

**Fixes:**

- Token highlighting stays aligned around multi-byte UTF-8 characters (emoji, CJK). The renderer now matches raw bytes against the source instead of decoded token strings, so a token that splits a multi-byte character still lands on the right boundary.
- Claude highlighting works on documents containing characters that NFKC-normalize to a different form (e.g., full-width `（）` becoming ASCII `()`). Token ranges are reprojected from the normalized tokenization back onto the original text.

### 1.4.0 - Token Highlighting & Customization

**Major new features:**

- **Visual Token Highlighting**: See exactly where each token begins and ends with alternating color bands overlaid on your text
  - Available for GPT (OpenAI) and Claude (Anthropic) tokenizers
  - Smart text contrast automatically adjusts foreground color for readability
  - Editor-aware: only applies to text editors, keeps Output/Debug panes clean

- **Interactive Color Configurator**: New command `Configure Token Highlight Colors` with:
  - Separate color pickers for even and odd token bands
  - Hex color input with opacity sliders for full alpha support
  - Real-time preview showing exactly how colors will appear
  - Smart contrast preview ensures text remains readable

- **Status Bar Palette Toggle**: Quick access toggle button in status bar
  - Click to instantly enable/disable token highlighting
  - Visual states: Active (on), Inactive (off), Unavailable (for unsupported models)

- **New Configuration Settings**:
  - `defaultModelFamily`: Choose which model family (GPT, Claude, or Gemini) activates by default
  - `statusBarDisplayTemplate`: Customize status bar text with template placeholders like `{count}`, `{family}`, `{provider}`

**Technical improvements:**
- Better Unicode normalization handling for Claude tokenizer (NFKC)
- Performance optimizations for real-time highlighting
- Improved error handling and user feedback

### 1.3.0
- Switch to model families in the UI: GPT, Claude, Gemini.
- Add Gemini token counting (approximate: `o200k_base`/`cl100k_base`, fallback ~4 chars/token).
- GPT tokenizer now uses `encoding_for_model('gpt-5')` with graceful fallbacks.
- Updated `tiktoken` to 1.0.22.

### 1.2.3
- Added support for new OpenAI models: o3-mini, o1, o1-mini, gpt-4o-mini
- Updated to tiktoken 1.0.20
- Updated Claude models to only include Claude-3.5, Claude-3.7
- Removed older models: text-davinci-003, davinci, babbage
- Removed Claude-2 and Claude-3

### 1.2.1

- Moved from `gpt-tokenizer` to `tiktoken` package.
- Fixed the special tokens issue.

### 1.2.0

- Modified the code to increase security.
- Added support for GPT-4o tokenizer.
- Removed unused models from the tokenizer list.
- Added Claude-3 as option using approximate token count.

### 1.1.0

- Added support for Claude tokenizer.

### 1.0.0

- Initial release of gpt-token-counter-live.
- Provides a token count in the status bar for the selected text or the entire document.
- Automatically updates the token count as text is edited or selected.
- Allows the user to select the model to use for token counting.
