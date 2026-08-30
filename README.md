<div align="center">
    <h1>Live LLM Token Counter</h1>
    <img src="images/icon.png" alt="Live LLM Token Counter logo" width="300" height="300"><br>
    <a href="https://marketplace.visualstudio.com/items?itemName=bedirt.gpt-token-counter-live"><img src="https://img.shields.io/badge/VSCode-v1.6.1-blue?style=flat&logo=visualstudiocode" alt="VS Code Marketplace version"></a>
    <a href="https://open-vsx.org/extension/bedirt/gpt-token-counter-live"><img alt="Open VSX version" src="https://img.shields.io/badge/OpenVSX%20-%20v1.6.1%20-%20%23bb3ec2?style=flat"></a>
    <br><br>
</div>

Live LLM Token Counter is a Visual Studio Code extension for prompt writers, AI app builders, and model evaluators who need local token feedback while editing. It shows live token counts for a selection or the whole document, lets you switch tokenizer families from the status bar, and can paint token boundaries directly over the editor text.

The extension identifier and settings namespace are `gpt-token-counter-live` so existing users keep their installs and settings.

Tokenizer support is provided by [tiktoken](https://www.npmjs.com/package/tiktoken) for GPT/OpenAI models, [Anthropic's tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript) for Claude, a local Gemini approximation, and [@huggingface/tokenizers](https://www.npmjs.com/package/@huggingface/tokenizers) for HuggingFace `tokenizer.json` files such as Qwen, Llama, and Mistral.

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
See your tokens in real-time with rotating color bands that show exactly where each token begins and ends. Available for GPT, Claude, and HuggingFace byte-level BPE tokenizers (Qwen, Llama, Mistral, etc.).

<div align="center">
    <img src="images/highlight_on_off.gif" alt="Token highlighting toggle" width="800">
</div>

**Key features:**
- **Toggle on/off:** Click the palette icon in the status bar to enable or disable highlighting.
- **Smart text contrast:** Highlight text automatically adapts to the visible color against the active editor theme; fully transparent highlights preserve the editor's existing text colors.
- **Customizable colors:** Choose your own colors with alpha/transparency support.
- **Editor-aware:** Only highlights in text editors; Output and Debug panes remain clean.

### Customizable Highlight Colors
Open the **Command Palette** and run `Configure Token Highlight Colors` to customize the rotating token color palette.

<div align="center">
    <img src="images/highlight_config.gif" alt="Token highlight configurator" width="800">
</div>

**Features:**
- Add, remove, and reorder palette colors
- Apply the 8-color preset
- Color pickers with opacity sliders
- Live token-style preview of the full palette cycle
- Dragging color and opacity controls previews locally; changes apply to editor highlighting on release
- The existing two-color palette remains the default; the 8-color palette is available as an opt-in preset
- Reset to the default two-color palette at any time

### Customizable Status Bar Display
Personalize how token information appears in your status bar using template placeholders.

<div align="center">
    <img src="images/status_bar_template.gif" alt="Status bar template customization" width="800">
</div>

**Supported placeholders:**
- `{count}` - Token count
- `{family}` or `{model}` - Model family name (GPT, Claude, Gemini, HuggingFace)
- `{provider}` - Provider name (`openai`, `anthropic`, `gemini`, `huggingface`)

## Requirements

- Visual Studio Code `1.82.0` or newer, or a compatible editor that installs extensions from the [Open VSX Registry](https://open-vsx.org/extension/bedirt/gpt-token-counter-live).

## Commands

This extension provides the following commands (accessible via Command Palette):

- **`Change Model Family`**: Switch between GPT (OpenAI), Claude (Anthropic), Gemini (Google AI), and HuggingFace tokenizers. Also accessible by clicking the token count in the status bar.

- **`Toggle Token Highlighting`**: Enable or disable visual token highlighting overlays. Also accessible by clicking the palette icon in the status bar.

- **`Configure Token Highlight Colors`**: Open an interactive palette editor to add, remove, reorder, and customize up to 8 token highlight colors with a live preview.

- **`Count Tokens`**: Manually trigger token counting for the current document or selection.

- **`Refresh HuggingFace Tokenizer Cache`**: Clear and reload the configured HuggingFace tokenizer cache.

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
Token highlight colors are stored as an ordered palette in your VS Code global state (synced across devices if you have Settings Sync enabled). Tokens cycle through the palette in order. To customize it, select `Configure Token Highlight Colors` from the Command Palette.

**Quick toggle:** Click the palette icon in the status bar to enable/disable token highlighting instantly.

## Known Issues

There are currently no known issues. If you encounter a problem, please report it on the [issue tracker](https://github.com/BedirT/LLM-Token-Counter-VSCode/issues).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the complete version history and release details.
