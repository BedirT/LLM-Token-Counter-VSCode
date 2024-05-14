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
            'gpt-4',
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

    const specialTokens = {
        'gpt-4o': ['<|endoftext|>'],
        'gpt-4': ['<|im_start|>', '<|endoftext|>', '<|im_end|>'],
        'gpt-3.5-turbo': ['<|im_start|>', '<|endoftext|>', '<|im_end|>'],
        'text-davinci-003': ['<|endoftext|>'],
        'davinci': ['<|endoftext|>'],
        'babbage': ['<|endoftext|>'],
        'claude-2': [],
        'claude-3': [] // Approximate
    };

    let currentModel = modelProviders.openai[0];
    let currentProvider = 'openai';

    context.subscriptions.push(statusBar);

    // Function to handle special tokens
    function handleSpecialTokens(text, model) {
        const tokens = specialTokens[model] || [];
        tokens.forEach(token => {
            text = text.split(token).join('');
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
        text = handleSpecialTokens(text, currentModel);

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
    vscode.workspace.onDidChangeTextDocument(updateTokenCount, null, context.subscriptions);
    vscode.workspace.onDidChangeTextDocument(updateTokenCount, null, context.subscriptions);

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
