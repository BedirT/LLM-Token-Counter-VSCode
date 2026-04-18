const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { encoding_for_model, get_encoding } = require('tiktoken');
const { countTokens, getTokenizer } = require('@anthropic-ai/tokenizer');
const { Tokenizer: HuggingfaceTokenizer } = require('@huggingface/tokenizers');
const { minimatch } = require('minimatch');

const CONFIG_SECTION = 'gpt-token-counter-live';
const DEFAULT_EVEN_COLOR = '#B8D4FF';
const DEFAULT_ODD_COLOR = '#FFE0A6';
const DEFAULT_STATUS_TEMPLATE = 'Token Count: {count} ({family})';

const MODEL_FAMILIES = {
    'openai': 'GPT',
    'anthropic': 'Claude',
    'gemini': 'Gemini',
    'huggingface': 'HuggingFace'
};

const HF_CACHE_DIR_NAME = 'hf-tokenizers';
const HF_HUB_BASE_URL = 'https://huggingface.co';

const HIGHLIGHT_EVEN_KEY = 'highlightEvenColor';
const HIGHLIGHT_ODD_KEY = 'highlightOddColor';
const NON_HIGHLIGHT_SCHEMES = new Set([
    'output',
    'vscode-output',
    'vscode',
    'walkThrough',
    'walkThroughSnippet',
    'debug',
    'git',
    'gitlens-git'
]);

function sanitizeColorSetting(value, fallback) {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(trimmed)) {
        return trimmed;
    }
    if (/^#[0-9A-F]{8}$/.test(trimmed)) {
        return trimmed;
    }
    return fallback;
}

function stripAlpha(hex) {
    if (typeof hex !== 'string') {
        return '#000000';
    }
    const clean = hex.replace('#', '').toUpperCase();
    if (clean.length === 6) {
        return `#${clean}`;
    }
    if (clean.length === 8) {
        return `#${clean.slice(0, 6)}`;
    }
    return '#000000';
}

function hexToLinearRgb(hex) {
    const noAlpha = stripAlpha(hex).slice(1);
    const r = parseInt(noAlpha.slice(0, 2), 16) / 255;
    const g = parseInt(noAlpha.slice(2, 4), 16) / 255;
    const b = parseInt(noAlpha.slice(4, 6), 16) / 255;

    const toLinear = (channel) => {
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    };

    return {
        r: toLinear(r),
        g: toLinear(g),
        b: toLinear(b)
    };
}

function textColorForBackground(hex) {
    const linear = hexToLinearRgb(hex);
    const luminance = 0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b;
    return luminance > 0.55 ? '#1F1F1F' : '#FFFFFF';
}

function hexToCssColor(hex) {
    if (typeof hex !== 'string') {
        return hex;
    }
    const clean = hex.replace('#', '').toUpperCase();
    if (clean.length === 6) {
        return `#${clean}`;
    }
    if (clean.length === 8) {
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        const a = parseInt(clean.slice(6, 8), 16) / 255;
        return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
    }
    return hex;
}

function sanitizeStringSetting(value, fallback) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return fallback;
}

function sanitizeTemplateSetting(value, fallback) {
    const sanitized = sanitizeStringSetting(value, fallback);
    if (!sanitized.includes('{count}')) {
        return fallback;
    }
    return sanitized;
}

function sanitizeProviderSetting(value) {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (MODEL_FAMILIES[normalized]) {
            return normalized;
        }
    }
    return 'openai';
}

function buildUtf8BoundaryMap(text) {
    const boundaries = new Map();
    boundaries.set(0, 0);

    let utf16Offset = 0;
    let byteOffset = 0;

    while (utf16Offset < text.length) {
        const codePoint = text.codePointAt(utf16Offset);
        const char = String.fromCodePoint(codePoint);
        const utf16Width = char.length;
        const byteWidth = Buffer.byteLength(char, 'utf8');

        utf16Offset += utf16Width;
        byteOffset += byteWidth;
        boundaries.set(byteOffset, utf16Offset);
    }

    return boundaries;
}

function resolveUtf16Offset(boundaries, byteOffset, maxByteOffset, direction) {
    if (boundaries.has(byteOffset)) {
        return boundaries.get(byteOffset);
    }

    if (direction === 'backward') {
        for (let cursor = byteOffset; cursor >= 0; cursor--) {
            if (boundaries.has(cursor)) {
                return boundaries.get(cursor);
            }
        }
    } else {
        for (let cursor = byteOffset; cursor <= maxByteOffset; cursor++) {
            if (boundaries.has(cursor)) {
                return boundaries.get(cursor);
            }
        }
    }

    return null;
}

function iterateGraphemeSegments(text) {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
        throw new Error('Intl.Segmenter is required for token normalization mapping.');
    }

    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), ({ segment, index }) => ({
        segment,
        index
    }));
}

function buildNormalizationOffsetMap(text) {
    const normalizedText = text.normalize('NFKC');
    const backward = new Array(normalizedText.length + 1);
    const forward = new Array(normalizedText.length + 1);
    const normalizedChunks = [];
    let normalizedOffset = 0;

    for (const { segment, index } of iterateGraphemeSegments(text)) {
        const normalizedSegment = segment.normalize('NFKC');
        const originalStart = index;
        const originalEnd = index + segment.length;
        const start = normalizedOffset;
        const end = start + normalizedSegment.length;

        normalizedChunks.push(normalizedSegment);

        if (start === end) {
            backward[start] = originalEnd;
            forward[start] = originalEnd;
        } else {
            backward[start] = originalStart;
            forward[start] = originalStart;

            for (let cursor = start + 1; cursor < end; cursor++) {
                backward[cursor] = originalStart;
                forward[cursor] = originalEnd;
            }

            backward[end] = originalEnd;
            forward[end] = originalEnd;
        }

        normalizedOffset = end;
    }

    // Whole-text NFKC can merge across grapheme boundaries, so reject per-segment maps that do not reassemble exactly.
    const rebuiltNormalizedText = normalizedChunks.join('');
    if (rebuiltNormalizedText !== normalizedText) {
        return null;
    }

    backward[0] = 0;
    forward[0] = 0;
    backward[normalizedText.length] = text.length;
    forward[normalizedText.length] = text.length;

    return {
        normalizedText,
        backward,
        forward
    };
}

function resolveOriginalOffsetFromNormalized(offsetMap, normalizedOffset, direction) {
    if (!offsetMap || normalizedOffset < 0 || normalizedOffset >= offsetMap.backward.length) {
        return null;
    }

    if (direction === 'backward') {
        return offsetMap.backward[normalizedOffset];
    }

    return offsetMap.forward[normalizedOffset];
}

let highlightColors = {
    even: DEFAULT_EVEN_COLOR,
    odd: DEFAULT_ODD_COLOR
};

let statusBarTemplate = DEFAULT_STATUS_TEMPLATE;
let enabledFilePatterns = [];

function loadHighlightColors(context) {
    let evenStored = context.globalState.get(HIGHLIGHT_EVEN_KEY);
    let oddStored = context.globalState.get(HIGHLIGHT_ODD_KEY);

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    if (!evenStored) {
        const legacyEven = config.get('highlightEvenColor');
        if (legacyEven) {
            evenStored = sanitizeColorSetting(legacyEven, DEFAULT_EVEN_COLOR);
            void context.globalState.update(HIGHLIGHT_EVEN_KEY, evenStored);
        }
    }

    if (!oddStored) {
        const legacyOdd = config.get('highlightOddColor');
        if (legacyOdd) {
            oddStored = sanitizeColorSetting(legacyOdd, DEFAULT_ODD_COLOR);
            void context.globalState.update(HIGHLIGHT_ODD_KEY, oddStored);
        }
    }

    const resolvedEven = evenStored !== undefined && evenStored !== null ? evenStored : DEFAULT_EVEN_COLOR;
    const resolvedOdd = oddStored !== undefined && oddStored !== null ? oddStored : DEFAULT_ODD_COLOR;

    highlightColors = {
        even: sanitizeColorSetting(resolvedEven, DEFAULT_EVEN_COLOR),
        odd: sanitizeColorSetting(resolvedOdd, DEFAULT_ODD_COLOR)
    };
}

function loadStatusBarConfig() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    statusBarTemplate = sanitizeTemplateSetting(config.get('statusBarDisplayTemplate'), DEFAULT_STATUS_TEMPLATE);
}

function normalizeEnabledFilePatterns(patterns) {
    return Array.isArray(patterns)
        ? patterns.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
        : [];
}

function loadEnabledFilePatterns() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    enabledFilePatterns = normalizeEnabledFilePatterns(config.get('enabledFilePatterns'));
}

function matchesFilePatterns(relativePath, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        return true;
    }
    if (typeof relativePath !== 'string') {
        return false;
    }
    const unixPath = relativePath.replace(/\\/g, '/');
    const fileName = unixPath.split('/').pop() || '';
    return patterns.some(pattern => {
        const opts = { dot: true, nocase: process.platform === 'win32' };
        return minimatch(fileName, pattern, opts) || minimatch(unixPath, pattern, opts);
    });
}

function matchesEnabledFilePatterns(editor) {
    if (!editor || !editor.document) {
        return false;
    }
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    return matchesFilePatterns(relativePath, enabledFilePatterns);
}

function isHighlightableEditor(editor) {
    if (!editor || !editor.document) {
        return false;
    }
    const scheme = editor.document.uri.scheme || '';
    if (NON_HIGHLIGHT_SCHEMES.has(scheme)) {
        return false;
    }
    return true;
}

function getDefaultProviderFromConfig() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return sanitizeProviderSetting(config.get('defaultModelFamily'));
}

function applyStatusBarTemplate(template, data) {
    const toText = (value) => {
        return value === undefined || value === null ? '' : `${value}`;
    };

    const replacements = {
        count: toText(data.count),
        family: toText(data.family),
        provider: toText(data.provider),
        model: toText(data.family),
        label: 'Token Count'
    };

    const baseTemplate = template || DEFAULT_STATUS_TEMPLATE;
    return baseTemplate.replace(/\{(count|family|provider|model|label)\}/g, (_match, key) => {
        return replacements[key] !== undefined ? replacements[key] : '';
    });
}

function createTokenDecorationTypes() {
    const evenTextColor = textColorForBackground(highlightColors.even);
    const oddTextColor = textColorForBackground(highlightColors.odd);
    const evenBackground = hexToCssColor(highlightColors.even);
    const oddBackground = hexToCssColor(highlightColors.odd);

    return {
        even: vscode.window.createTextEditorDecorationType({
            backgroundColor: evenBackground,
            color: evenTextColor
        }),
        odd: vscode.window.createTextEditorDecorationType({
            backgroundColor: oddBackground,
            color: oddTextColor
        })
    };
}

function deriveHfSafeId(modelId) {
    if (typeof modelId !== 'string') {
        return '';
    }
    const trimmed = modelId.trim();
    if (!trimmed) {
        return '';
    }
    // Build a readable prefix for cache debuggability, then append a short hash of the
    // original model ID. The hash guarantees the mapping is injective, so inputs whose
    // readable forms would collide (e.g. `a/b--c` and `a--b/c` both reduce to `a--b--c`)
    // still resolve to distinct cache filenames and do not poison each other.
    const readable = trimmed
        .replace(/\\/g, '/')
        .replace(/\//g, '--')
        .replace(/[^A-Za-z0-9._-]/g, '_');
    const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
    return `${readable}_${hash}`;
}

function resolveHuggingfaceSource(config) {
    const modelId = typeof config.modelId === 'string' ? config.modelId.trim() : '';
    const localPath = typeof config.localPath === 'string' ? config.localPath.trim() : '';

    if (localPath) {
        return { kind: 'local', path: localPath };
    }
    if (modelId) {
        return { kind: 'remote', modelId, safeId: deriveHfSafeId(modelId) };
    }
    return { kind: 'none' };
}

function readHuggingfaceConfigFromVscode() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
        modelId: config.get('huggingfaceModelId') || '',
        localPath: config.get('huggingfaceTokenizerPath') || ''
    };
}

/**
 * Walks a token id array and produces character offsets in the decoded text by
 * progressively decoding each id. Byte-level BPE tokenizers emit multi-byte
 * characters across several consecutive ids; we group those ids together and
 * attribute the full run to the first id in the group (remaining ids get a
 * zero-length range so indexing matches).
 *
 * Returns `{ offsets, decoded, aligned }`. `aligned` is `true` only when the
 * full decode matches `text`, which is the guard we use before rendering
 * highlights. SentencePiece and other decoder-cleaning tokenizers can drop
 * leading whitespace and produce a text-shaped but offset-shifted output.
 *
 * @param {Object} tokenizer  An `@huggingface/tokenizers` Tokenizer instance.
 * @param {string} text       The original source text.
 * @param {number[]} ids      Token ids produced by `tokenizer.encode(text).ids`.
 */
function reconstructHuggingfaceOffsets(tokenizer, text, ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { offsets: [], decoded: '', aligned: text.length === 0 };
    }

    const decodeOptions = { skip_special_tokens: false, clean_up_tokenization_spaces: false };
    const FFFD = '\uFFFD';

    const endsWithHighSurrogate = (str) => str.length > 0 && /[\uD800-\uDBFF]$/.test(str);
    const needsContinuation = (str) => str.includes(FFFD) || endsWithHighSurrogate(str);

    const offsets = new Array(ids.length);
    let cursor = 0;
    let i = 0;
    let decoded = '';

    while (i < ids.length) {
        let piece;
        try {
            piece = tokenizer.decode([ids[i]], decodeOptions);
        } catch (error) {
            return { offsets, decoded, aligned: false, error };
        }

        if (!needsContinuation(piece)) {
            offsets[i] = [cursor, cursor + piece.length];
            cursor += piece.length;
            decoded += piece;
            i += 1;
            continue;
        }

        // Group this id with subsequent ids until the cumulative decode is a
        // well-formed string. Attribute the whole range to the first id and
        // give the follower ids a zero-length slice anchored at the group end.
        let end = i + 1;
        let groupDecoded = piece;
        while (end < ids.length && needsContinuation(groupDecoded)) {
            try {
                groupDecoded = tokenizer.decode(ids.slice(i, end + 1), decodeOptions);
            } catch (error) {
                return { offsets, decoded, aligned: false, error };
            }
            end += 1;
        }

        const groupEnd = cursor + groupDecoded.length;
        offsets[i] = [cursor, groupEnd];
        for (let k = i + 1; k < end; k++) {
            offsets[k] = [groupEnd, groupEnd];
        }
        decoded += groupDecoded;
        cursor = groupEnd;
        i = end;
    }

    const aligned = decoded === text;
    return { offsets, decoded, aligned };
}

async function fetchHuggingfaceTokenizerFiles(modelId) {
    if (typeof fetch !== 'function') {
        throw new Error('Global fetch is not available. VS Code 1.82+ / Node 18+ is required to load HuggingFace tokenizers from the Hub.');
    }

    const baseUrl = `${HF_HUB_BASE_URL}/${modelId}/resolve/main`;

    // Bound every network round trip so a stalled proxy can't pin `hfStatus` at `loading`
    // forever. On abort the promise rejects, `beginHuggingfaceLoad`'s catch flips status to
    // `error`, and `maybeRetryHuggingfaceLoad` can fire again after the cooldown.
    // Each fetch gets a FRESH timeout signal: a single shared `AbortSignal.timeout(...)`
    // starts counting the moment it's created, so a slow `tokenizer.json` would eat into
    // the `tokenizer_config.json` budget or abort it immediately.

    const tokenizerResp = await fetch(`${baseUrl}/tokenizer.json`, {
        signal: AbortSignal.timeout(HF_FETCH_TIMEOUT_MS)
    });
    if (!tokenizerResp.ok) {
        throw new Error(`Failed to fetch tokenizer.json for "${modelId}" (HTTP ${tokenizerResp.status}).`);
    }
    const tokenizerJson = await tokenizerResp.text();

    // tokenizer_config.json drives rules like `remove_space`, `do_lowercase_and_remove_accent`,
    // `eos_token`, and `target_lang` for Unigram/legacy tokenizers, so silently swallowing a
    // transient failure would poison the cache with wrong-count results. Treat 404 (repo
    // legitimately does not ship it) as the only non-fatal outcome; everything else throws.
    let tokenizerConfigJson = '{}';
    const configResp = await fetch(`${baseUrl}/tokenizer_config.json`, {
        signal: AbortSignal.timeout(HF_FETCH_TIMEOUT_MS)
    });
    if (configResp.ok) {
        tokenizerConfigJson = await configResp.text();
    } else if (configResp.status !== 404) {
        throw new Error(`Failed to fetch tokenizer_config.json for "${modelId}" (HTTP ${configResp.status}).`);
    }

    return { tokenizerJson, tokenizerConfigJson };
}

function buildHuggingfaceTokenizerFromStrings(tokenizerJson, tokenizerConfigJson) {
    const tokenizerObj = JSON.parse(tokenizerJson);
    const configObj = tokenizerConfigJson ? JSON.parse(tokenizerConfigJson) : {};
    return new HuggingfaceTokenizer(tokenizerObj, configObj);
}

// Probe whether `reconstructHuggingfaceOffsets` will produce aligned offsets for this tokenizer.
// SentencePiece/WordPiece variants and other whitespace-normalizing decoders cannot round-trip,
// so we detect that at load time and advertise highlight support accordingly. A probe that mixes
// leading whitespace, punctuation, and multi-line text catches the common non-roundtripping cases.
const HF_HIGHLIGHT_PROBE_TEXT = ' Hello, world!\nSecond line.';
function huggingfaceTokenizerSupportsHighlight(tokenizer) {
    try {
        const encoded = tokenizer.encode(HF_HIGHLIGHT_PROBE_TEXT, { add_special_tokens: false });
        const ids = Array.isArray(encoded && encoded.ids) ? encoded.ids : [];
        const result = reconstructHuggingfaceOffsets(tokenizer, HF_HIGHLIGHT_PROBE_TEXT, ids);
        return result.aligned === true;
    } catch (_error) {
        return false;
    }
}

// Write `data` to `finalPath` atomically: stage to a temp file, fsync, rename.
// A crash or concurrent writer can no longer leave a half-written file at finalPath.
// On any failure during write/fsync/rename the temp file is unlinked so repeated
// retries don't accumulate orphan `*.tmp.*` files in globalStorage.
//
// `fs.writeSync` may return a partial byte count (disk-full, network FS, signal
// interruption), so we loop until every byte lands before fsync+rename. A single
// raw call would silently truncate the cache file while still reporting success.
function writeAtomicFileSync(finalPath, data) {
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const fd = fs.openSync(tmpPath, 'w');
        try {
            let offset = 0;
            while (offset < buffer.length) {
                const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
                if (written <= 0) {
                    throw new Error(`writeSync reported 0 bytes written at offset ${offset}/${buffer.length}`);
                }
                offset += written;
            }
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmpPath, finalPath);
    } catch (error) {
        removeFileIfExists(tmpPath);
        throw error;
    }
}

function removeFileIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (_ignored) {
        // best-effort cleanup; leave the stale file rather than crash the extension
    }
}

const HF_RETRY_COOLDOWN_MS = 30000;
const HF_FETCH_TIMEOUT_MS = 30000;

let tokenizerState = {
    kind: null,
    encoder: null,
    hfTokenizer: null,
    hfStatus: 'idle',
    hfModelId: '',
    hfLocalPath: '',
    hfLoadToken: 0,
    hfLastAttemptAt: 0,
    hfErrorLabel: null,
    supportsHighlight: false,
    requiresNormalization: false
};

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    if (typeof context.globalState.setKeysForSync === 'function') {
        context.globalState.setKeysForSync([HIGHLIGHT_EVEN_KEY, HIGHLIGHT_ODD_KEY]);
    }

    loadHighlightColors(context);
    loadStatusBarConfig();
    loadEnabledFilePatterns();

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'gpt-token-counter-live.changeModel';
    statusBar.name = 'LLM Token Counter';

    const highlightStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    highlightStatusBar.command = 'gpt-token-counter-live.toggleHighlight';
    highlightStatusBar.name = 'Token Highlight Toggle';
    highlightStatusBar.accessibilityInformation = {
        label: 'Toggle token highlighting',
        role: 'button'
    };
    highlightStatusBar.text = '$(symbol-color)';

    let tokenDecorations = createTokenDecorationTypes();

    let currentProvider = getDefaultProviderFromConfig();
    let currentFamilyName = MODEL_FAMILIES[currentProvider];
    let highlightEnabled = false;
    // Tracks the last (document uri, HF model) pair we warned about for round-trip
    // misalignment so we don't spam the dev console on every keystroke.
    let lastHfHighlightWarnKey = null;

    context.subscriptions.push(
        statusBar,
        highlightStatusBar,
        {
            dispose: () => {
                if (tokenDecorations) {
                    tokenDecorations.even.dispose();
                    tokenDecorations.odd.dispose();
                }
            }
        }
    );

    function clearTokenHighlights(editor = vscode.window.activeTextEditor) {
        if (!editor) {
            return;
        }
        if (tokenDecorations) {
            editor.setDecorations(tokenDecorations.even, []);
            editor.setDecorations(tokenDecorations.odd, []);
        }
    }

    function refreshTokenDecorations() {
        if (!tokenDecorations) {
            tokenDecorations = createTokenDecorationTypes();
            return;
        }

        vscode.window.visibleTextEditors.forEach(editor => {
            editor.setDecorations(tokenDecorations.even, []);
            editor.setDecorations(tokenDecorations.odd, []);
        });

        tokenDecorations.even.dispose();
        tokenDecorations.odd.dispose();
        tokenDecorations = createTokenDecorationTypes();

        vscode.window.visibleTextEditors.forEach(editor => {
            if (!isHighlightableEditor(editor)) {
                editor.setDecorations(tokenDecorations.even, []);
                editor.setDecorations(tokenDecorations.odd, []);
            }
        });
    }

    function applyTokenHighlights(editor, sourceText, baseOffset, tokenizationResult) {
        if (!highlightEnabled || !tokenizerState.supportsHighlight || !tokenizationResult || !editor) {
            clearTokenHighlights(editor);
            return;
        }

        if (!isHighlightableEditor(editor)) {
            clearTokenHighlights(editor);
            return;
        }

        const evenRanges = [];
        const oddRanges = [];
        const tokens = tokenizationResult.tokens;
        const document = editor.document;
        const renderedText = tokenizationResult.processedText || sourceText;
        const sourceBytes = Buffer.from(renderedText, 'utf8');
        const boundaries = buildUtf8BoundaryMap(renderedText);
        const normalizationOffsetMap = tokenizationResult.normalizationOffsetMap || null;

        if (tokenizationResult.normalizationChanged && !normalizationOffsetMap) {
            clearTokenHighlights(editor);
            console.warn('[gpt-token-counter-live] Token highlighting skipped because normalization offsets could not be mapped to the original document.');
            return;
        }

        let byteCursor = 0;
        let hasMismatch = false;

        for (let i = 0; i < tokens.length; i++) {
            const tokenId = tokens[i];
            let tokenBytes;

            try {
                tokenBytes = tokenizerState.encoder.decode_single_token_bytes(tokenId);
            } catch (error) {
                hasMismatch = true;
                break;
            }

            if (!tokenBytes.length) {
                continue;
            }

            const startByte = byteCursor;
            const endByte = startByte + tokenBytes.length;

            if (endByte > sourceBytes.length) {
                hasMismatch = true;
                break;
            }

            const expectedBytes = sourceBytes.subarray(startByte, endByte);
            if (!Buffer.from(tokenBytes).equals(expectedBytes)) {
                hasMismatch = true;
                break;
            }

            const startUtf16 = resolveUtf16Offset(boundaries, startByte, sourceBytes.length, 'backward');
            const endUtf16 = resolveUtf16Offset(boundaries, endByte, sourceBytes.length, 'forward');

            if (startUtf16 === null || endUtf16 === null) {
                hasMismatch = true;
                break;
            }

            const mappedStart = normalizationOffsetMap
                ? resolveOriginalOffsetFromNormalized(normalizationOffsetMap, startUtf16, 'backward')
                : startUtf16;
            const mappedEnd = normalizationOffsetMap
                ? resolveOriginalOffsetFromNormalized(normalizationOffsetMap, endUtf16, 'forward')
                : endUtf16;

            if (mappedStart === null || mappedEnd === null) {
                hasMismatch = true;
                break;
            }

            const startOffset = baseOffset + mappedStart;
            const endOffset = baseOffset + mappedEnd;
            const range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));

            if (!range.isEmpty) {
                if (i % 2 === 0) {
                    evenRanges.push(range);
                } else {
                    oddRanges.push(range);
                }
            }

            byteCursor = endByte;
        }

        if (byteCursor !== sourceBytes.length) {
            hasMismatch = true;
        }

        if (hasMismatch) {
            clearTokenHighlights(editor);
            console.warn('[gpt-token-counter-live] Partial token highlight render due to unsupported UTF-8 token boundaries.');
            return;
        }

        editor.setDecorations(tokenDecorations.even, evenRanges);
        editor.setDecorations(tokenDecorations.odd, oddRanges);
    }

    function updateHighlightStatusBar() {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || !isHighlightableEditor(activeEditor) || !matchesEnabledFilePatterns(activeEditor)) {
            highlightStatusBar.hide();
            return;
        }

        const activeForeground = new vscode.ThemeColor('statusBarItem.activeForeground');
        const activeBackground = new vscode.ThemeColor('statusBarItem.activeBackground');
        const inactiveForeground = new vscode.ThemeColor('statusBarItem.inactiveForeground');
        const inactiveBackground = new vscode.ThemeColor('statusBarItem.inactiveBackground');
        const defaultForeground = new vscode.ThemeColor('statusBarItem.foreground');
        const defaultBackground = new vscode.ThemeColor('statusBarItem.background');
        const unavailableForeground = new vscode.ThemeColor('statusBarItem.errorForeground');
        const unavailableBackground = new vscode.ThemeColor('statusBarItem.errorBackground');

        const applyAppearance = (text, tooltip, foreground, background, fallbackForeground, fallbackBackground) => {
            highlightStatusBar.text = text;
            highlightStatusBar.tooltip = tooltip;
            highlightStatusBar.color = foreground || fallbackForeground;
            highlightStatusBar.backgroundColor = background || fallbackBackground;
        };

        if (!tokenizerState.supportsHighlight) {
            applyAppearance(
                '$(circle-slash)',
                'Token highlighting is unavailable for this model family.',
                unavailableForeground,
                unavailableBackground,
                defaultForeground,
                defaultBackground
            );
        } else if (highlightEnabled) {
            applyAppearance(
                '$(paintcan)',
                'Click to disable token highlighting.',
                activeForeground || new vscode.ThemeColor('statusBarItem.prominentForeground'),
                activeBackground || new vscode.ThemeColor('statusBarItem.prominentBackground'),
                defaultForeground,
                defaultBackground
            );
        } else {
            applyAppearance(
                '$(symbol-color)',
                'Click to enable token highlighting.',
                inactiveForeground,
                inactiveBackground,
                defaultForeground,
                undefined
            );
        }
        highlightStatusBar.show();
    }

    function resetTokenizerState() {
        if (tokenizerState.encoder && typeof tokenizerState.encoder.free === 'function') {
            tokenizerState.encoder.free();
        }
        tokenizerState = {
            kind: null,
            encoder: null,
            hfTokenizer: null,
            hfStatus: 'idle',
            hfModelId: '',
            hfLocalPath: '',
            hfLoadToken: tokenizerState.hfLoadToken + 1, // invalidate any pending async load
            hfLastAttemptAt: 0,
            hfErrorLabel: null,
            supportsHighlight: false,
            requiresNormalization: false
        };
    }

    function ensureHuggingfaceCacheDir() {
        const base = context.globalStorageUri && context.globalStorageUri.fsPath;
        if (!base) {
            throw new Error('Extension global storage path is unavailable.');
        }
        const dir = path.join(base, HF_CACHE_DIR_NAME);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    function getHuggingfaceCacheFilePath(safeId, suffix) {
        const dir = ensureHuggingfaceCacheDir();
        return path.join(dir, `${safeId}${suffix}`);
    }

    async function loadHuggingfaceTokenizerFromSource(source, loadToken) {
        if (source.kind === 'local') {
            const filePath = source.path;
            // The setting is documented as an absolute path. Relative paths resolve against
            // `process.cwd()`, which in the VS Code extension host is non-deterministic
            // (workspace root when launched from a terminal, the VS Code install dir when
            // launched from an app icon). Surface that explicitly instead of failing with a
            // misleading "not found" error using the literal relative string.
            if (!path.isAbsolute(filePath)) {
                throw new Error(`HuggingFace tokenizer path must be absolute, got "${filePath}".`);
            }
            if (!fs.existsSync(filePath)) {
                throw new Error(`HuggingFace tokenizer file not found at "${filePath}".`);
            }
            const tokenizerJson = fs.readFileSync(filePath, 'utf8');
            const siblingConfig = path.join(path.dirname(filePath), 'tokenizer_config.json');
            let tokenizerConfigJson = '{}';
            if (fs.existsSync(siblingConfig)) {
                tokenizerConfigJson = fs.readFileSync(siblingConfig, 'utf8');
            }
            return {
                tokenizer: buildHuggingfaceTokenizerFromStrings(tokenizerJson, tokenizerConfigJson),
                loadToken
            };
        }

        if (source.kind === 'remote') {
            const tokenizerPath = getHuggingfaceCacheFilePath(source.safeId, '.json');
            const configPath = getHuggingfaceCacheFilePath(source.safeId, '.config.json');

            // Try the cache first. Validate by actually parsing + constructing the
            // tokenizer; if that throws, the cache entry is corrupt (interrupted
            // write, cross-window race, truncated disk) so we wipe it and refetch.
            if (fs.existsSync(tokenizerPath)) {
                try {
                    const cachedTokenizerJson = fs.readFileSync(tokenizerPath, 'utf8');
                    const cachedConfigJson = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '{}';
                    return {
                        tokenizer: buildHuggingfaceTokenizerFromStrings(cachedTokenizerJson, cachedConfigJson),
                        loadToken
                    };
                } catch (cacheError) {
                    console.warn(`[gpt-token-counter-live] Discarding corrupt HuggingFace cache for "${source.modelId}" and refetching: ${cacheError.message}`);
                    removeFileIfExists(tokenizerPath);
                    removeFileIfExists(configPath);
                }
            }

            // Cache miss or self-healed from a corrupt entry. Fetch, build (which
            // validates the JSON), then only persist to the cache after we know
            // the data produces a usable tokenizer.
            const fetched = await fetchHuggingfaceTokenizerFiles(source.modelId);
            const tokenizer = buildHuggingfaceTokenizerFromStrings(fetched.tokenizerJson, fetched.tokenizerConfigJson);

            try {
                writeAtomicFileSync(tokenizerPath, fetched.tokenizerJson);
                writeAtomicFileSync(configPath, fetched.tokenizerConfigJson);
            } catch (writeError) {
                console.warn(`[gpt-token-counter-live] Could not cache tokenizer for "${source.modelId}": ${writeError.message}`);
            }

            return { tokenizer, loadToken };
        }

        throw new Error('Set `huggingfaceModelId` (e.g. "Qwen/Qwen2.5-7B-Instruct") or `huggingfaceTokenizerPath` to use the HuggingFace tokenizer.');
    }

    // Fire-and-forget retry when the HF tokenizer failed to load earlier. Triggered from
    // the tokenization hot path so the first keystroke after a network recovery (or after
    // the user drops a local tokenizer.json into the configured path) picks it up.
    // Throttled to avoid hammering the hub during sustained outages.
    function maybeRetryHuggingfaceLoad() {
        if (currentProvider !== 'huggingface') {
            return;
        }
        if (tokenizerState.hfStatus !== 'error') {
            return;
        }
        if (Date.now() - (tokenizerState.hfLastAttemptAt || 0) < HF_RETRY_COOLDOWN_MS) {
            return;
        }
        void beginHuggingfaceLoad();
    }

    async function beginHuggingfaceLoad() {
        const hfConfig = readHuggingfaceConfigFromVscode();
        const source = resolveHuggingfaceSource(hfConfig);
        const loadToken = tokenizerState.hfLoadToken;
        // Snapshot whether we were already advertising an error before this attempt.
        // Used below to gate the error notification so the throttled retry loop doesn't
        // pop a fresh toast every 30 seconds for the same sustained failure.
        const wasAlreadyErrored = tokenizerState.hfStatus === 'error';
        const previousErrorLabel = tokenizerState.hfErrorLabel || null;

        tokenizerState.kind = 'huggingface';
        tokenizerState.hfStatus = 'loading';
        tokenizerState.hfTokenizer = null;
        tokenizerState.hfModelId = hfConfig.modelId;
        tokenizerState.hfLocalPath = hfConfig.localPath;
        tokenizerState.hfLastAttemptAt = Date.now();
        tokenizerState.supportsHighlight = false;

        if (source.kind === 'none') {
            tokenizerState.hfStatus = 'error';
            tokenizerState.hfErrorLabel = '<no-config>';
            if (!wasAlreadyErrored || previousErrorLabel !== '<no-config>') {
                vscode.window.showErrorMessage('HuggingFace tokenizer is active but no model ID or local tokenizer path is configured. Open settings and set `gpt-token-counter-live.huggingfaceModelId` or `gpt-token-counter-live.huggingfaceTokenizerPath`.');
            }
            updateHighlightStatusBar();
            await updateTokenCount();
            return;
        }

        try {
            const { tokenizer, loadToken: returnedToken } = await loadHuggingfaceTokenizerFromSource(source, loadToken);
            // A concurrent reset (provider change, config change) may have invalidated this load.
            if (returnedToken !== tokenizerState.hfLoadToken || tokenizerState.kind !== 'huggingface') {
                return;
            }
            tokenizerState.hfTokenizer = tokenizer;
            tokenizerState.hfStatus = 'ready';
            tokenizerState.hfErrorLabel = null;
            tokenizerState.supportsHighlight = huggingfaceTokenizerSupportsHighlight(tokenizer);
        } catch (error) {
            // Mirror the success-branch guard. Without the `loadToken` check, a stale A-load
            // that rejects after B-load succeeded would overwrite B's good state with an
            // error and a toast referencing the wrong model.
            if (loadToken !== tokenizerState.hfLoadToken || tokenizerState.kind !== 'huggingface') {
                return;
            }
            tokenizerState.hfStatus = 'error';
            tokenizerState.hfTokenizer = null;
            tokenizerState.supportsHighlight = false;
            const label = source.kind === 'local' ? source.path : source.modelId;
            tokenizerState.hfErrorLabel = label;
            if (!wasAlreadyErrored || previousErrorLabel !== label) {
                vscode.window.showErrorMessage(`Failed to load HuggingFace tokenizer for "${label}": ${error.message}`);
            }
        }

        updateHighlightStatusBar();
        await updateTokenCount();
    }

    // Function to initialize the encoder for the selected family
    function initializeEncoderForFamily(provider) {
        resetTokenizerState();

        if (provider === 'openai') {
            let candidate = null;
            try {
                candidate = encoding_for_model('gpt-5');
            } catch (e0) {
                try {
                    candidate = get_encoding('o200k_base');
                } catch (e1) {
                    try {
                        candidate = get_encoding('cl100k_base');
                    } catch (e2) {
                        candidate = null;
                    }
                }
            }
            if (candidate) {
                tokenizerState.kind = 'tiktoken';
                tokenizerState.encoder = candidate;
                tokenizerState.supportsHighlight = true;
            }
        } else if (provider === 'anthropic') {
            try {
                tokenizerState.kind = 'anthropic';
                tokenizerState.encoder = getTokenizer();
                tokenizerState.supportsHighlight = true;
                tokenizerState.requiresNormalization = true;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to initialize tokenizer for ${MODEL_FAMILIES[provider]}: ${error.message}`);
            }
        } else if (provider === 'gemini') {
            try {
                tokenizerState.kind = 'tiktoken';
                tokenizerState.encoder = get_encoding('o200k_base');
            } catch (e1) {
                try {
                    tokenizerState.kind = 'tiktoken';
                    tokenizerState.encoder = get_encoding('cl100k_base');
                } catch (e2) {
                    tokenizerState.kind = null;
                    tokenizerState.encoder = null;
                }
            }
        } else if (provider === 'huggingface') {
            // HuggingFace loads asynchronously; the counter and highlight use the fallback
            // until the tokenizer is ready, then `beginHuggingfaceLoad` triggers a re-render.
            void beginHuggingfaceLoad();
        }

        if (highlightEnabled && !tokenizerState.supportsHighlight && provider !== 'huggingface') {
            highlightEnabled = false;
            clearTokenHighlights();
            vscode.window.showInformationMessage('Token highlighting disabled because the selected model family does not expose precise token boundaries.');
        }

        updateHighlightStatusBar();
    }

    function fallbackTokenCount(text) {
        if (currentProvider === 'anthropic') {
            return countTokens(text);
        }

        // Everyone else (gemini and huggingface while loading) falls back to the 4-chars/token heuristic.
        if (currentProvider === 'gemini' || currentProvider === 'huggingface') {
            return Math.ceil(text.length / 4);
        }

        return text.length;
    }

    function computeTokenization(text) {
        if (tokenizerState.kind === 'huggingface') {
            if (tokenizerState.hfStatus !== 'ready' || !tokenizerState.hfTokenizer) {
                // Previous load failed and the session has been sitting on ~4-char/token
                // approximations. Kick off a throttled retry so counts become accurate as
                // soon as the underlying problem (network, missing local file) is fixed.
                maybeRetryHuggingfaceLoad();
                return {
                    tokenCount: fallbackTokenCount(text),
                    tokenizationResult: null
                };
            }
            try {
                const encoded = tokenizerState.hfTokenizer.encode(text, { add_special_tokens: false });
                const ids = encoded.ids || [];
                // Offset reconstruction runs a per-token `decode()` and is the expensive part
                // of the HF hot path. Skip it when the user isn't highlighting (so plain count
                // updates stay cheap) and when the tokenizer already failed the load-time
                // probe (so we don't pay the cost only to throw the result away).
                const shouldReconstructOffsets = highlightEnabled && tokenizerState.supportsHighlight;
                const reconstruction = shouldReconstructOffsets
                    ? reconstructHuggingfaceOffsets(tokenizerState.hfTokenizer, text, ids)
                    : { offsets: [], aligned: false };
                return {
                    tokenCount: ids.length,
                    tokenizationResult: {
                        kind: 'huggingface',
                        ids,
                        tokens: encoded.tokens || [],
                        offsets: reconstruction.offsets,
                        aligned: reconstruction.aligned
                    }
                };
            } catch (error) {
                vscode.window.showErrorMessage(`HuggingFace tokenization failed: ${error.message}`);
                tokenizerState.hfStatus = 'error';
                tokenizerState.hfTokenizer = null;
                tokenizerState.supportsHighlight = false;
                return {
                    tokenCount: fallbackTokenCount(text),
                    tokenizationResult: null
                };
            }
        }

        if (tokenizerState.encoder) {
            const processedText = tokenizerState.requiresNormalization ? text.normalize('NFKC') : text;
            try {
                const encoded = tokenizerState.encoder.encode(processedText, 'all');
                const normalizationOffsetMap = tokenizerState.requiresNormalization && processedText !== text
                    ? buildNormalizationOffsetMap(text)
                    : null;
                return {
                    tokenCount: encoded.length,
                    tokenizationResult: {
                        kind: 'tiktoken',
                        tokens: encoded,
                        normalizationChanged: tokenizerState.requiresNormalization && processedText !== text,
                        processedText,
                        normalizationOffsetMap
                    }
                };
            } catch (error) {
                vscode.window.showErrorMessage(`Tokenization failed for ${currentFamilyName}: ${error.message}`);
                resetTokenizerState();
            }
        }

        return {
            tokenCount: fallbackTokenCount(text),
            tokenizationResult: null
        };
    }

    function applyHuggingfaceTokenHighlights(editor, baseOffset, tokenizationResult) {
        if (!editor || !tokenizationResult || !tokenizationResult.aligned) {
            clearTokenHighlights(editor);
            if (tokenizationResult && !tokenizationResult.aligned) {
                // updateTokenCount fires on every keystroke and selection change, so an
                // unconditional warn would flood the dev console. Emit only when the
                // (document, model) pair transitions into the misaligned state.
                const key = `${editor.document.uri.toString()}::${tokenizerState.hfModelId || ''}`;
                if (lastHfHighlightWarnKey !== key) {
                    lastHfHighlightWarnKey = key;
                    console.warn('[gpt-token-counter-live] HuggingFace token highlight skipped because decode round-trip does not match the source text. This happens with tokenizers that strip or transform whitespace (for example many SentencePiece tokenizers).');
                }
            }
            return;
        }
        lastHfHighlightWarnKey = null;

        if (!isHighlightableEditor(editor)) {
            clearTokenHighlights(editor);
            return;
        }

        const evenRanges = [];
        const oddRanges = [];
        const document = editor.document;
        const offsets = tokenizationResult.offsets || [];

        // Alternation parity tracks *visible* tokens. `reconstructHuggingfaceOffsets`
        // emits zero-length continuation entries for multi-id groups (CJK, emoji under
        // byte-level BPE), and using the raw loop index would cause two adjacent visible
        // tokens to share a color whenever a group has an even number of followers.
        let visibleIndex = 0;
        for (let i = 0; i < offsets.length; i++) {
            const [start, end] = offsets[i];
            if (start === end) {
                continue;
            }
            const startPos = document.positionAt(baseOffset + start);
            const endPos = document.positionAt(baseOffset + end);
            const range = new vscode.Range(startPos, endPos);
            if (range.isEmpty) {
                continue;
            }
            if (visibleIndex % 2 === 0) {
                evenRanges.push(range);
            } else {
                oddRanges.push(range);
            }
            visibleIndex++;
        }

        editor.setDecorations(tokenDecorations.even, evenRanges);
        editor.setDecorations(tokenDecorations.odd, oddRanges);
    }

    async function updateTokenCount() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            statusBar.hide();
            clearTokenHighlights();
            updateHighlightStatusBar();
            return; // No open text editor
        }

        if (!isHighlightableEditor(editor)) {
            statusBar.hide();
            clearTokenHighlights(editor);
            highlightStatusBar.hide();
            return;
        }

        if (!matchesEnabledFilePatterns(editor)) {
            statusBar.hide();
            clearTokenHighlights(editor);
            highlightStatusBar.hide();
            return;
        }

        const document = editor.document;
        const selection = editor.selection;
        const text = selection.isEmpty ? document.getText() : document.getText(selection);
        const baseOffset = selection.isEmpty ? 0 : document.offsetAt(selection.start);

        const { tokenCount, tokenizationResult } = computeTokenization(text);

        statusBar.text = applyStatusBarTemplate(statusBarTemplate, {
            count: tokenCount,
            family: currentFamilyName,
            provider: currentProvider
        });
        statusBar.show();

        if (highlightEnabled) {
            if (!tokenizerState.supportsHighlight) {
                clearTokenHighlights(editor);
            } else if (tokenizationResult && tokenizationResult.kind === 'huggingface') {
                applyHuggingfaceTokenHighlights(editor, baseOffset, tokenizationResult);
            } else {
                applyTokenHighlights(editor, text, baseOffset, tokenizationResult);
            }
        } else {
            clearTokenHighlights(editor);
        }

        updateHighlightStatusBar();
    }

    const scheduleUpdateTokenCount = () => { void updateTokenCount(); };

    vscode.window.onDidChangeTextEditorSelection(scheduleUpdateTokenCount, null, context.subscriptions);
    vscode.window.onDidChangeActiveTextEditor(scheduleUpdateTokenCount, null, context.subscriptions);
    vscode.workspace.onDidChangeTextDocument(scheduleUpdateTokenCount, null, context.subscriptions);

    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.statusBarDisplayTemplate`)) {
            loadStatusBarConfig();
            scheduleUpdateTokenCount();
        }

        // Track whether this event already re-initialized the HF tokenizer so a single
        // settings save that touches both `defaultModelFamily` and `huggingfaceModelId`
        // doesn't trigger two concurrent `beginHuggingfaceLoad()` calls (doubled fetch,
        // racing atomic writes onto the same cache path).
        let reinitializedInThisEvent = false;

        if (event.affectsConfiguration(`${CONFIG_SECTION}.defaultModelFamily`)) {
            const desiredProvider = getDefaultProviderFromConfig();
            if (desiredProvider !== currentProvider) {
                currentProvider = desiredProvider;
                currentFamilyName = MODEL_FAMILIES[currentProvider];

                try {
                    initializeEncoderForFamily(currentProvider);
                    reinitializedInThisEvent = true;
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to initialize tokenizer for ${currentFamilyName}: ${error.message}`);
                }

                scheduleUpdateTokenCount();
            }
        }

        if (event.affectsConfiguration(`${CONFIG_SECTION}.enabledFilePatterns`)) {
            loadEnabledFilePatterns();
            scheduleUpdateTokenCount();
        }

        if (!reinitializedInThisEvent && currentProvider === 'huggingface' && (
            event.affectsConfiguration(`${CONFIG_SECTION}.huggingfaceModelId`) ||
            event.affectsConfiguration(`${CONFIG_SECTION}.huggingfaceTokenizerPath`)
        )) {
            // Re-run initialization so a fresh beginHuggingfaceLoad kicks off.
            try {
                initializeEncoderForFamily(currentProvider);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to reload HuggingFace tokenizer: ${error.message}`);
            }
            scheduleUpdateTokenCount();
        }
    }, null, context.subscriptions);

    let disposable = vscode.commands.registerCommand('gpt-token-counter-live.changeModel', async function () {
        const providerDetail = (provider) => {
            if (provider === 'gemini') {
                return 'Approximate tokenizer (highlighting unavailable)';
            }
            if (provider === 'huggingface') {
                return 'HuggingFace tokenizer.json (configure via settings)';
            }
            return 'Precise tokenizer with highlighting';
        };

        /** @type {(vscode.QuickPickItem & { provider?: string, family?: string, command?: string })[]} */
        const familyItems = Object.entries(MODEL_FAMILIES).map(([provider, family]) => ({
            label: `${family} (${provider})`,
            description: provider === currentProvider ? 'Currently active' : undefined,
            detail: providerDetail(provider),
            provider,
            family,
            picked: provider === currentProvider
        }));

        /** @type {(vscode.QuickPickItem & { provider?: string, family?: string, command?: string })[]} */
        const quickPickItems = [
            ...familyItems,
            { kind: vscode.QuickPickItemKind.Separator },
            {
                label: '$(gear) Extension Settings',
                description: 'Open settings for Live LLM Token Counter',
                command: 'openSettings'
            },
            {
                label: '$(symbol-color) Configure Highlight Colors',
                description: 'Preview and adjust token highlight colors',
                command: 'configureHighlights'
            }
        ];

        const selection = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: 'Select a Model Family',
            matchOnDescription: true,
            ignoreFocusOut: true
        });

        if (selection) {
            if (selection.command === 'openSettings') {
                await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
                return;
            } else if (selection.command === 'configureHighlights') {
                await vscode.commands.executeCommand('gpt-token-counter-live.configureHighlights');
                return;
            }

            if (selection.provider && MODEL_FAMILIES[selection.provider]) {
                currentProvider = selection.provider;
                currentFamilyName = MODEL_FAMILIES[currentProvider];

                try {
                    initializeEncoderForFamily(currentProvider);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to initialize tokenizer for ${currentFamilyName}: ${error.message}`);
                    // Continue with approximation where applicable
                }

                scheduleUpdateTokenCount();
            }
        }
    });

    context.subscriptions.push(disposable);

    const toggleHighlight = vscode.commands.registerCommand('gpt-token-counter-live.toggleHighlight', () => {
        const nextState = !highlightEnabled;

        if (nextState && !tokenizerState.supportsHighlight) {
            if (currentProvider === 'huggingface' && tokenizerState.hfStatus === 'loading') {
                vscode.window.showInformationMessage('HuggingFace tokenizer is still loading. Try again once the download finishes.');
            } else if (currentProvider === 'huggingface') {
                vscode.window.showInformationMessage('Token highlighting is unavailable until a HuggingFace tokenizer is loaded successfully.');
            } else {
                vscode.window.showInformationMessage('Token highlighting is only available for GPT, Claude, and HuggingFace tokenizers.');
            }
            highlightEnabled = false;
        } else if (nextState) {
            highlightEnabled = true;
            vscode.window.showInformationMessage('Token highlighting enabled.');
        } else {
            highlightEnabled = false;
            vscode.window.showInformationMessage('Token highlighting disabled.');
        }

        if (!highlightEnabled) {
            clearTokenHighlights();
        }

        updateHighlightStatusBar();
        scheduleUpdateTokenCount();
    });

    context.subscriptions.push(toggleHighlight);

    // Manual cache-bust for the HuggingFace remote tokenizer. Addresses the fact that
    // we fetch `resolve/main` (mutable) and cache indefinitely, so an upstream tokenizer
    // change would otherwise silently drift token counts. Users can invoke this from the
    // Command Palette to force a re-fetch.
    const refreshHuggingfaceCache = vscode.commands.registerCommand('gpt-token-counter-live.refreshHuggingfaceCache', () => {
        if (currentProvider !== 'huggingface') {
            vscode.window.showInformationMessage('Switch to the HuggingFace model family before refreshing its tokenizer cache.');
            return;
        }
        const hfConfig = readHuggingfaceConfigFromVscode();
        const source = resolveHuggingfaceSource(hfConfig);
        if (source.kind === 'remote') {
            removeFileIfExists(getHuggingfaceCacheFilePath(source.safeId, '.json'));
            removeFileIfExists(getHuggingfaceCacheFilePath(source.safeId, '.config.json'));
            vscode.window.showInformationMessage(`HuggingFace tokenizer cache cleared for "${source.modelId}". Refetching...`);
        } else if (source.kind === 'local') {
            vscode.window.showInformationMessage(`Reloading HuggingFace tokenizer from "${source.path}"...`);
        } else {
            vscode.window.showInformationMessage('HuggingFace tokenizer has no model ID or local path configured.');
            return;
        }
        try {
            initializeEncoderForFamily('huggingface');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to reload HuggingFace tokenizer: ${error.message}`);
        }
        scheduleUpdateTokenCount();
    });

    context.subscriptions.push(refreshHuggingfaceCache);

    const configureHighlights = vscode.commands.registerCommand('gpt-token-counter-live.configureHighlights', async () => {
        loadHighlightColors(context);
        const panel = vscode.window.createWebviewPanel(
            'tokenHighlightConfigurator',
            'Token Highlight Colors',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const evenColor = sanitizeColorSetting(highlightColors.even, DEFAULT_EVEN_COLOR);
        const oddColor = sanitizeColorSetting(highlightColors.odd, DEFAULT_ODD_COLOR);

        const getHtml = (evenHex, oddHex) => {
            const nonce = String(Date.now());
            const toHex6 = (value) => {
                if (typeof value !== 'string') {
                    return '#000000';
                }
                const match = value.match(/^#([0-9A-Fa-f]{6})/);
                if (match) {
                    return `#${match[1].toUpperCase()}`;
                }
                const match8 = value.match(/^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})$/);
                if (match8) {
                    return `#${match8[1].toUpperCase()}`;
                }
                return '#000000';
            };

            const toAlphaPercent = (value) => {
                if (typeof value === 'string' && value.length === 9) {
                    return Math.round((parseInt(value.slice(7), 16) / 255) * 100);
                }
                return 100;
            };

            const normalizedEven = sanitizeColorSetting(evenHex, DEFAULT_EVEN_COLOR);
            const normalizedOdd = sanitizeColorSetting(oddHex, DEFAULT_ODD_COLOR);

            const evenHex6 = toHex6(normalizedEven).toLowerCase();
            const oddHex6 = toHex6(normalizedOdd).toLowerCase();
            const evenAlphaPercent = toAlphaPercent(normalizedEven);
            const oddAlphaPercent = toAlphaPercent(normalizedOdd);

            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Token Highlight Colors</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        h1 { font-size: 1.3rem; margin-bottom: 12px; }
        .picker-row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
        .alpha-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
        label { width: 160px; }
        input[type="color"] { appearance: none; -webkit-appearance: none; border: none; width: 40px; height: 40px; padding: 0; background: transparent; cursor: pointer; }
        input[type="range"] { flex: 1; }
        .preview { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
        .preview-row { display: flex; height: 36px; }
        .preview-row span { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; }
        .helper { font-size: 0.85rem; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
        .value-chip { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8rem; padding: 4px 6px; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); min-width: 110px; text-align: center; }
    </style>
</head>
<body>
    <h1>Token Highlight Colors</h1>
    <p class="helper">Adjust the alternating highlight colors. Changes apply immediately.</p>
    <div class="picker-row">
        <label for="evenColor">Even tokens</label>
        <input id="evenColor" type="color" value="${evenHex6}" aria-label="Even token color" />
        <span class="value-chip" data-label="even">${normalizedEven}</span>
    </div>
    <div class="alpha-row">
        <label for="evenAlpha">Opacity</label>
        <input id="evenAlpha" type="range" min="0" max="100" step="1" value="${evenAlphaPercent}" aria-label="Even token opacity" />
        <span class="value-chip" data-alpha-label="even">${evenAlphaPercent}%</span>
    </div>
    <div class="picker-row">
        <label for="oddColor">Odd tokens</label>
        <input id="oddColor" type="color" value="${oddHex6}" aria-label="Odd token color" />
        <span class="value-chip" data-label="odd">${normalizedOdd}</span>
    </div>
    <div class="alpha-row">
        <label for="oddAlpha">Opacity</label>
        <input id="oddAlpha" type="range" min="0" max="100" step="1" value="${oddAlphaPercent}" aria-label="Odd token opacity" />
        <span class="value-chip" data-alpha-label="odd">${oddAlphaPercent}%</span>
    </div>
    <div class="preview">
        <div class="preview-row" data-preview="even" style="background:${normalizedEven}; color: var(--vscode-editor-foreground);">
            <span>Even token preview (${normalizedEven})</span>
        </div>
        <div class="preview-row" data-preview="odd" style="background:${normalizedOdd}; color: var(--vscode-editor-foreground);">
            <span>Odd token preview (${normalizedOdd})</span>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        const evenInput = document.getElementById('evenColor');
        const oddInput = document.getElementById('oddColor');
        const evenAlpha = document.getElementById('evenAlpha');
        const oddAlpha = document.getElementById('oddAlpha');
        const evenPreview = document.querySelector('[data-preview="even"]');
        const oddPreview = document.querySelector('[data-preview="odd"]');
        const evenLabel = document.querySelector('[data-label="even"]');
        const oddLabel = document.querySelector('[data-label="odd"]');
        const evenAlphaLabel = document.querySelector('[data-alpha-label="even"]');
        const oddAlphaLabel = document.querySelector('[data-alpha-label="odd"]');

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const parseRgb = (value) => {
            const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (!match) {
                return { r: 30, g: 30, b: 30, a: 1 };
            }
            return {
                r: Number(match[1]),
                g: Number(match[2]),
                b: Number(match[3]),
                a: match[4] !== undefined ? Number(match[4]) : 1
            };
        };

        const bodyBackground = parseRgb(getComputedStyle(document.body).backgroundColor);

        const hexToRgba = (hex) => {
            const clean = hex.replace('#', '');
            const r = parseInt(clean.slice(0, 2), 16);
            const g = parseInt(clean.slice(2, 4), 16);
            const b = parseInt(clean.slice(4, 6), 16);
            const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1;
            return { r, g, b, a };
        };

        const blendOnBackground = (foreground) => {
            const alpha = clamp(foreground.a, 0, 1);
            return {
                r: Math.round(foreground.r * alpha + bodyBackground.r * (1 - alpha)),
                g: Math.round(foreground.g * alpha + bodyBackground.g * (1 - alpha)),
                b: Math.round(foreground.b * alpha + bodyBackground.b * (1 - alpha))
            };
        };

        const luminance = ({ r, g, b }) => {
            const srgb = [r, g, b].map(component => {
                const scaled = component / 255;
                return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
        };

        const pickTextColor = (hex) => {
            const fg = hexToRgba(hex);
            const blended = blendOnBackground(fg);
            const lum = luminance(blended);
            return lum > 0.55 ? '#1f1f1f' : '#f5f5f5';
        };

        const toAlphaHex = (percent) => {
            const clampedPercent = clamp(Number(percent), 0, 100);
            const alphaValue = Math.round((clampedPercent / 100) * 255);
            return alphaValue >= 255 ? '' : alphaValue.toString(16).padStart(2, '0').toUpperCase();
        };

        const composeColor = (baseHex, percent) => {
            const normalizedBase = baseHex.toUpperCase();
            const alphaHex = toAlphaHex(percent);
            return alphaHex ? normalizedBase + alphaHex : normalizedBase;
        };

        const updateAlphaLabel = (element, percent) => {
            if (element) {
                element.textContent = Math.round(percent) + '%';
            }
        };

        const applyPreview = (element, value, label) => {
            if (!element) {
                return;
            }
            element.style.background = value;
            const textColor = pickTextColor(value.toUpperCase());
            element.style.color = textColor;
            const span = element.querySelector('span');
            if (span) {
                span.textContent = label + ' preview (' + value.toUpperCase() + ')';
                span.style.color = textColor;
            }
        };

        const applyLabel = (element, value) => {
            if (element) {
                element.textContent = value.toUpperCase();
            }
        };

        const emitColorChange = (key, value) => {
            vscodeApi.postMessage({ type: 'colorChange', key, value });
        };

        const updateEven = () => {
            const percent = Number(evenAlpha.value);
            updateAlphaLabel(evenAlphaLabel, percent);
            const finalHex = composeColor(evenInput.value, percent);
            applyPreview(evenPreview, finalHex, 'Even token');
            applyLabel(evenLabel, finalHex);
            emitColorChange('${HIGHLIGHT_EVEN_KEY}', finalHex);
        };

        const updateOdd = () => {
            const percent = Number(oddAlpha.value);
            updateAlphaLabel(oddAlphaLabel, percent);
            const finalHex = composeColor(oddInput.value, percent);
            applyPreview(oddPreview, finalHex, 'Odd token');
            applyLabel(oddLabel, finalHex);
            emitColorChange('${HIGHLIGHT_ODD_KEY}', finalHex);
        };

        evenInput.addEventListener('input', updateEven);
        evenAlpha.addEventListener('input', updateEven);
        oddInput.addEventListener('input', updateOdd);
        oddAlpha.addEventListener('input', updateOdd);

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message && message.type === 'colorUpdate') {
                const applyIncomingColor = (input, alphaControl, alphaLabelEl, previewEl, labelEl, labelText) => {
                    const upperValue = message.value.toUpperCase();
                    const base = upperValue.slice(0, 7);
                    const percent = upperValue.length === 9 ? Math.round((parseInt(upperValue.slice(7), 16) / 255) * 100) : 100;
                    input.value = base.toLowerCase();
                    alphaControl.value = percent;
                    updateAlphaLabel(alphaLabelEl, percent);
                    applyPreview(previewEl, upperValue, labelText);
                    applyLabel(labelEl, upperValue);
                };

                if (message.key === '${HIGHLIGHT_EVEN_KEY}') {
                    applyIncomingColor(evenInput, evenAlpha, evenAlphaLabel, evenPreview, evenLabel, 'Even token');
                } else if (message.key === '${HIGHLIGHT_ODD_KEY}') {
                    applyIncomingColor(oddInput, oddAlpha, oddAlphaLabel, oddPreview, oddLabel, 'Odd token');
                }
            }
        });

        const initialize = () => {
            updateAlphaLabel(evenAlphaLabel, Number(evenAlpha.value));
            updateAlphaLabel(oddAlphaLabel, Number(oddAlpha.value));

            const initialEvenHex = composeColor(evenInput.value, Number(evenAlpha.value));
            const initialOddHex = composeColor(oddInput.value, Number(oddAlpha.value));

            applyPreview(evenPreview, initialEvenHex, 'Even token');
            applyPreview(oddPreview, initialOddHex, 'Odd token');
            applyLabel(evenLabel, initialEvenHex);
            applyLabel(oddLabel, initialOddHex);
        };

        initialize();
    </script>
</body>
</html>`;
        };

        panel.webview.html = getHtml(evenColor, oddColor);

        const updateColorSetting = async (key, value) => {
            const targetKey = key === HIGHLIGHT_EVEN_KEY ? 'even' : key === HIGHLIGHT_ODD_KEY ? 'odd' : null;
            if (!targetKey) {
                return;
            }

            const hexValue = sanitizeColorSetting(value, targetKey === 'even' ? DEFAULT_EVEN_COLOR : DEFAULT_ODD_COLOR);
            highlightColors[targetKey] = hexValue;
            await context.globalState.update(key, hexValue);
            loadHighlightColors(context);

            refreshTokenDecorations();
            scheduleUpdateTokenCount();
            panel.webview.postMessage({ type: 'colorUpdate', key, value: hexValue });
        };

        const messageDisposable = panel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'colorChange' && message.key) {
                await updateColorSetting(message.key, message.value);
            }
        });

        panel.onDidDispose(() => {
            messageDisposable.dispose();
        }, null, context.subscriptions);
    });

    context.subscriptions.push(configureHighlights);

    // Initial update
    initializeEncoderForFamily(currentProvider);
    scheduleUpdateTokenCount();
    updateHighlightStatusBar();
}

function deactivate() {
    if (tokenizerState.encoder && typeof tokenizerState.encoder.free === 'function') {
        tokenizerState.encoder.free();
        tokenizerState.encoder = null;
    }
    tokenizerState.hfTokenizer = null;
}

module.exports = {
    activate,
    deactivate,
    __internal: {
        buildUtf8BoundaryMap,
        resolveUtf16Offset,
        buildNormalizationOffsetMap,
        resolveOriginalOffsetFromNormalized
    },
    __hf: {
        deriveHfSafeId,
        resolveHuggingfaceSource,
        reconstructHuggingfaceOffsets,
        buildHuggingfaceTokenizerFromStrings,
        huggingfaceTokenizerSupportsHighlight,
        Tokenizer: HuggingfaceTokenizer
    },
    _test: {
        loadEnabledFilePatterns,
        matchesEnabledFilePatterns,
        matchesFilePatterns,
        normalizeEnabledFilePatterns,
        setEnabledFilePatterns: (patterns) => {
            enabledFilePatterns = normalizeEnabledFilePatterns(patterns);
        }
    }
};
