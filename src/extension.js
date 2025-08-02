const vscode = require('vscode');
const { encoding_for_model } = require('tiktoken');
const { countTokens } = require('@anthropic-ai/tokenizer');

let encoder = null;  // Initialize encoder as null

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = "gpt-token-counter-live.changeModel";

    const modelFamilies = {
        'openai': [
            'o3',
            'o1',
            'gpt-4o',
            'gpt-4',
            'gpt-3.5',
        ],
        'anthropic': [
            'claude-4*',
            'claude-3.7*',
            'claude-3.5*',
        ],
        'google': [
            'gemini*'
        ]
    };

    const specialTokens = {
        'o3': ['<|endoftext|>'],
        'o1': ['<|endoftext|>'],
        'gpt-4o': ['<|endoftext|>'],
        'gpt-4': ['<|endoftext|>'],
        'gpt-3.5': ['<|endoftext|>'],
        'claude-4*': [], // Approximate
        'claude-3.7*': [], // Approximate
        'claude-3.5*': [], // Approximate
        'gemini*': [], // Approximate
    };

    const familyToModel = {
        'o3': 'o3-mini',
        'o1': 'o1',
        'gpt-4o': 'gpt-4o',
        'gpt-4': 'gpt-4',
        'gpt-3.5': 'gpt-3.5-turbo',
        'claude-4*': 'claude-3.7*',
        'claude-3.7*': 'claude-3.7*',
        'claude-3.5*': 'claude-3.5*',
        'gemini*': 'cl100k_base'
    };

    let currentModel = modelFamilies.openai[0];
    let currentProvider = 'openai';

    context.subscriptions.push(statusBar);

    // Function to initialize the encoder
    function initializeEncoder(model) {
        const base = familyToModel[model] || model;
        if (encoder) {
            encoder.free();
        }
        encoder = encoding_for_model(base);
    }

    // Function to handle special tokens
    function handleSpecialTokens(text, model) {
        const tokens = specialTokens[model] || [];
        let specialTokenCount = 0;
        tokens.forEach(token => {
            const occurrences = text.split(token).length - 1;
            specialTokenCount += occurrences;
            text = text.split(token).join('');
        });
        return { text, specialTokenCount };
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
        const { text: processedText, specialTokenCount } = handleSpecialTokens(text, currentModel);

        let tokenCount;
        if (currentProvider === 'anthropic') {
            tokenCount = countTokens(processedText) + specialTokenCount;
        } else if (encoder) {
            tokenCount = encoder.encode(processedText).length + specialTokenCount;
        } else {
            tokenCount = specialTokenCount;
        }

        statusBar.text = `Token Count: ${tokenCount} (${currentModel})`;
        statusBar.show();
        highlightTokens();
    };

    vscode.window.onDidChangeTextEditorSelection(updateTokenCount, null, context.subscriptions);
    vscode.window.onDidChangeActiveTextEditor(updateTokenCount, null, context.subscriptions);
    vscode.workspace.onDidChangeTextDocument(updateTokenCount, null, context.subscriptions);

    let tokenViewEnabled = false;
    const decorationTypeA = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(255, 215, 0, 0.2)' });
    const decorationTypeB = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(173, 216, 230, 0.2)' });

    function clearHighlights(editor) {
        if (!editor) { return; }
        editor.setDecorations(decorationTypeA, []);
        editor.setDecorations(decorationTypeB, []);
    }

    function highlightTokens() {
        let editor = vscode.window.activeTextEditor;
        if (!editor || !tokenViewEnabled) {
            clearHighlights(editor);
            return;
        }

        let document = editor.document;
        let selection = editor.selection;
        let text = selection.isEmpty ? document.getText() : document.getText(selection);
        let startOffset = selection.isEmpty ? 0 : document.offsetAt(selection.start);

        let tokens = [];
        let decode;
        if (currentProvider === 'anthropic') {
            const { getTokenizer } = require('@anthropic-ai/tokenizer');
            const tok = getTokenizer();
            tokens = Array.from(tok.encode(text, 'all'));
            decode = t => Buffer.from(tok.decode_single_token_bytes(t)).toString();
            tok.free();
        } else if (encoder) {
            tokens = Array.from(encoder.encode(text));
            decode = t => Buffer.from(encoder.decode_single_token_bytes(t)).toString();
        }

        let decoA = [], decoB = [];
        let offset = 0;
        let useA = true;
        for (let tok of tokens) {
            let str = decode(tok);
            let start = document.positionAt(startOffset + offset);
            offset += str.length;
            let end = document.positionAt(startOffset + offset);
            let range = new vscode.Range(start, end);
            if (useA) {
                decoA.push({ range });
            } else {
                decoB.push({ range });
            }
            useA = !useA;
        }
        editor.setDecorations(decorationTypeA, decoA);
        editor.setDecorations(decorationTypeB, decoB);
    }

    let disposable = vscode.commands.registerCommand('gpt-token-counter-live.changeModel', async function () {
        let flatModelList = Object.entries(modelFamilies).reduce((acc, [provider, models]) => acc.concat(models.map(model => `${provider}: ${model}`)), []);
        const toggleLabel = `Toggle Token View (${tokenViewEnabled ? 'On' : 'Off'})`;
        flatModelList.push(toggleLabel);
        let selection = await vscode.window.showQuickPick(flatModelList, {
            placeHolder: 'Select a Model Family or Option',
        });

        if (selection) {
            if (selection === toggleLabel) {
                tokenViewEnabled = !tokenViewEnabled;
                highlightTokens();
                return;
            }
            const [provider, model] = selection.split(': ');
            currentProvider = provider;
            currentModel = model;

            if (currentProvider === 'openai' || currentProvider === 'google') {
                try {
                    initializeEncoder(currentModel);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to load encoder for model ${currentModel}: ${error.message}`);
                    return;
                }
            }

            updateTokenCount();
            highlightTokens();
        }
    });

    context.subscriptions.push(disposable);

    // Initial update
    initializeEncoder(currentModel);
    updateTokenCount();
    highlightTokens();
}

function deactivate() {
    if (encoder) {
        encoder.free();
    }
}

module.exports = {
    activate,
    deactivate
}
