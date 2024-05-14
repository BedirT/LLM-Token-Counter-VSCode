const vscode = require('vscode');
const { countTokens } = require('@anthropic-ai/tokenizer');
let encode = require('gpt-tokenizer').encode;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = "gpt-token-counter-live.changeModel";

    const modelProviders = {
        'openai': [
            'gpt-4o',
            'gpt-4', // Turbo is also here
            'gpt-3.5-turbo',
            'text-davinci-003',
            'davinci',
            'babbage',
        ],
        'anthropic': [
            'claude-2',
            'claude-3 (Approximate)', // There is no exact tokenizer for claude-3
        ]
    };

    let currentModel = modelProviders.openai[0];
    let currentProvider = 'openai';

    context.subscriptions.push(statusBar);

    // Function to handle special tokens
    function handleSpecialTokens(text) {
        const specialTokens = [''];
        specialTokens.forEach(token => {
            if (text.includes(token)) {
                text = text.replace(token, '');
            }
        });
        return text;
    }

    let updateTokenCount = () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            statusBar.hide();
            return; // No open text editor
        }

        let document = editor.document;
        let selection = editor.selection;
        let text = selection.isEmpty ? document.getText() : document.getText(selection);

        // Handle special tokens before tokenizing
        text = handleSpecialTokens(text);

        let tokenCount;

        if (currentProvider === 'anthropic') {
            tokenCount = countTokens(text);
        } else {
            tokenCount = encode(text).length;
        }

        statusBar.text = `Token Count: ${tokenCount} (${currentModel})`;
        statusBar.show();
    };

    vscode.window.onDidChangeTextEditorSelection(updateTokenCount, null, context.subscriptions);
    vscode.window.onDidChangeActiveTextEditor(updateTokenCount, null, context.subscriptions);

    let disposable = vscode.commands.registerCommand('gpt-token-counter-live.changeModel', async function () {
        let flatModelList = Object.entries(modelProviders).reduce((acc, [provider, models]) => acc.concat(models.map(model => `${provider}: ${model}`)), []);
        let selection = await vscode.window.showQuickPick(flatModelList, {
            placeHolder: 'Select a Model',
        });

        if (selection) {
            const [provider, model] = selection.split(': ');
            currentProvider = provider;
            currentModel = model;

            if (currentProvider === 'openai') {
                try {
                    encode = require(`gpt-tokenizer/model/${currentModel}`).encode;
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to load encoder for model ${currentModel}: ${error.message}`);
                    return;
                }
            }

            updateTokenCount();
        }
    });

    context.subscriptions.push(disposable);

    // Initial update
    updateTokenCount();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}
