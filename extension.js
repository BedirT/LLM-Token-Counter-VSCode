const vscode = require('vscode');
let encode = require('gpt-tokenizer').encode;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = "gpt-token-counter.changeModel";

    const availableModels = [
        // Add all your available models here
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
		'code-search-ada-code-001'
    ];
    let currentModel = availableModels[0];

    context.subscriptions.push(statusBar);

    let updateTokenCount = () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            statusBar.hide();
            return; // No open text editor
        }

        let document = editor.document;
        let selection = editor.selection;
        let text;

        if (!selection.isEmpty) {
            text = document.getText(selection);
        } else {
            text = document.getText();
        }

        let tokenCount = encode(text).length;
        statusBar.text = `Token Count: ${tokenCount} (${currentModel})`;
        statusBar.show();
    };

    vscode.window.onDidChangeTextEditorSelection(updateTokenCount, null, context.subscriptions);
    vscode.window.onDidChangeActiveTextEditor(updateTokenCount, null, context.subscriptions);

    let disposable = vscode.commands.registerCommand('gpt-token-counter.changeModel', async function () {
        let selection = await vscode.window.showQuickPick(availableModels, {
            placeHolder: 'Select a Model',
        });

        if (selection) {
            currentModel = selection;
            encode = require(`gpt-tokenizer/model/${currentModel}`).encode;
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
