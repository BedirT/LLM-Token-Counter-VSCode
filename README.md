# GPT-Token-Counter Live

<a href="https://marketplace.visualstudio.com/items?itemName=bedirt.gpt-token-counter-live">![](https://img.shields.io/badge/VSCode-v0.1-blue?style=flat&logo=visualstudiocode)</a>

The "gpt-token-counter-live" is a Visual Studio Code extension that displays the token count of selected text or the entire open document in the status bar. The token count is determined using the [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) npm package.

This tool is built to get a speedy token counting result right on VS Code while you are working on prompting files. I personally needed a lot while working on many GPT projects, so I decided to make one for myself. I hope this helps you too!

## Features

- **Token Count Display:** The extension provides a real-time token count of the currently selected text or the entire document if no text is selected. The token count is displayed on the right side of the status bar.

- **Auto-Update:** The token count is automatically updated as you edit or select text, ensuring that the count is always accurate.

- **Easy Activation:** The extension is activated as soon as VS Code starts up, so you don't have to manually activate it every time you start your editor.

- **Model Selection:** The extension allows you to select the model you want to use for token counting. The default model is the GPT-4 model, currently only implements openai models (pretty much all that is available right now). You can change the model by clicking on the token count in the status bar and selecting the model you want to use.

## Requirements

- Visual Studio Code: The extension is developed for VS Code and will not work with other editors.

- Node.js and npm: The extension uses the gpt-tokenizer which is an npm package. You will need Node.js and npm installed to use the extension. 

- gpt-tokenizer: This is an npm package used for counting tokens. It can be installed with `npm install gpt-tokenizer`.

## Extension Settings

The extension does not currently add any VS Code settings.

## Known Issues

There are currently no known issues. If you encounter a problem, please report it on the [issue tracker](https://github.com/BedirT/GPT-Token-Counter-VSCode/issues).

## Release Notes

### 1.0.0

- Initial release of gpt-token-counter-live.
- Provides a token count in the status bar for the selected text or the entire document.
- Automatically updates the token count as text is edited or selected.
- Allows the user to select the model to use for token counting.
