# Live LLM Token Counter

<a href="https://marketplace.visualstudio.com/items?itemName=bedirt.gpt-token-counter-live">![](https://img.shields.io/badge/VSCode-v1.0-blue?style=flat&logo=visualstudiocode)</a>

The "gpt-token-counter-live" is a Visual Studio Code extension that displays the token count of selected text or the entire open document in the status bar. The token count is determined using the official tokenizers of [GPT](https://github.com/niieani/gpt-tokenizer) and [Claude](https://github.com/anthropics/anthropic-tokenizer-typescript).

This tool is built to get a speedy token counting result right on VS Code while you are working on prompting files. I personally needed a lot while working on many LLM projects, so I decided to make one for myself. I hope this helps you too!

## Features

- **Token Count Display:** The extension provides a real-time token count of the currently selected text or the entire document if no text is selected. The token count is displayed on the right side of the status bar.

https://github.com/BedirT/LLM-Token-Counter-VSCode/assets/10860127/d250f139-b1b1-4398-b3d4-052b3fa105c9

- **Auto-Update:** The token count is automatically updated as you edit or select text, ensuring that the count is always accurate.

- **Easy Activation:** The extension is activated as soon as VS Code starts up, so you don't have to manually activate it every time you start your editor.

- **Model Selection:** The extension allows you to select the model you want to use for token counting. The default model is the OpenAI's GPT-4 model. All OpenAI and Anthropic models are available. You can change the model by clicking on the token count in the status bar and selecting the model you want to use.

https://github.com/BedirT/LLM-Token-Counter-VSCode/assets/10860127/5dffabb0-28c2-49cb-aeb2-4c8d2a62b047

## Requirements

- Visual Studio Code: The extension is developed for VS Code and will not work with other editors.

## Extension Settings

The extension does not currently add any VS Code settings.

## Known Issues

There are currently no known issues. If you encounter a problem, please report it on the [issue tracker](https://github.com/BedirT/LLM-Token-Counter-VSCode/issues).

## Release Notes

### 1.1.0

- Added support for Claude tokenizer.

### 1.0.0

- Initial release of gpt-token-counter-live.
- Provides a token count in the status bar for the selected text or the entire document.
- Automatically updates the token count as text is edited or selected.
- Allows the user to select the model to use for token counting.
