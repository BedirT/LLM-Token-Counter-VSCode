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
            'gpt-4', 
            'gpt-3.5-turbo',
            'text-davinci-003',
            'davinci',
            'curie',
            'babbage',
            'ada',
            'davinci-codex',
            'cushman-codex',
            'text-embedding-ada-002',
            'text-similarity-davinci-001',
            'text-similarity-curie-001',
            'text-similarity-babbage-001',
            'text-similarity-ada-001',
            'text-search-davinci-doc-001',
            'text-search-curie-doc-001',
            'text-search-babbage-doc-001',
            'text-search-ada-doc-001',
            'code-search-babbage-code-001',
            'code-search-ada-code-001',
        ],
        'anthropic': [
            'claude' // All anthropic models use the same tokenizer
        ]
    };

    let currentModel = modelProviders.openai[0];
    let currentProvider = 'openai';

    context.subscriptions.push(statusBar);

    let updateTokenCount = () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            statusBar.hide();
            return; // No open text editor
        }

        let document = editor.document;
        let selection = editor.selection;
        let text = selection.isEmpty ? document.getText() : document.getText(selection);

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
                encode = require(`gpt-tokenizer/model/${currentModel}`).encode;
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