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
const DARK_CONTRAST_TEXT = '#1F1F1F';
const LIGHT_CONTRAST_TEXT = '#FFFFFF';
const MAX_HIGHLIGHT_COLORS = 8;
const DEFAULT_HIGHLIGHT_COLORS = [
    DEFAULT_EVEN_COLOR,
    DEFAULT_ODD_COLOR
];
const ADDITIONAL_HIGHLIGHT_COLORS = [
    '#2D6F8E',
    '#5C4B8A',
    '#4E7A59',
    '#8B6428',
    '#8A3F46',
    '#36756F',
    '#765784',
    '#6E7846'
];
const DEFAULT_STATUS_TEMPLATE = 'Token Count: {count} ({family})';

const MODEL_FAMILIES = {
    'openai': 'GPT',
    'anthropic': 'Claude',
    'gemini': 'Gemini',
    'huggingface': 'HuggingFace'
};

const HF_CACHE_DIR_NAME = 'hf-tokenizers';
const HF_HUB_BASE_URL = 'https://huggingface.co';
const HF_SAFE_ID_READABLE_MAX_LENGTH = 96;
const HF_SAFE_ID_HASH_LENGTH = 12;

const HIGHLIGHT_EVEN_KEY = 'highlightEvenColor';
const HIGHLIGHT_ODD_KEY = 'highlightOddColor';
const HIGHLIGHT_COLORS_KEY = 'highlightColors';
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

function sanitizeHighlightPalette(value, fallback = DEFAULT_HIGHLIGHT_COLORS) {
    const fallbackPalette = Array.isArray(fallback) ? fallback : DEFAULT_HIGHLIGHT_COLORS;
    if (!Array.isArray(value)) {
        return fallbackPalette.slice(0, MAX_HIGHLIGHT_COLORS);
    }

    const colors = value
        .map(color => sanitizeColorSetting(color, null))
        .filter(Boolean)
        .slice(0, MAX_HIGHLIGHT_COLORS);

    return colors.length > 0 ? colors : fallbackPalette.slice(0, MAX_HIGHLIGHT_COLORS);
}

function resolveHighlightPalette(storedPalette, legacyEven, legacyOdd) {
    const savedPalette = sanitizeHighlightPalette(storedPalette, []);
    if (savedPalette.length > 0) {
        return savedPalette;
    }

    if (legacyEven !== undefined || legacyOdd !== undefined) {
        return [
            sanitizeColorSetting(legacyEven, DEFAULT_EVEN_COLOR),
            sanitizeColorSetting(legacyOdd, DEFAULT_ODD_COLOR)
        ];
    }

    return DEFAULT_HIGHLIGHT_COLORS.slice();
}

function getHighlightColorIndex(tokenIndex, colorCount) {
    if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || !Number.isInteger(colorCount) || colorCount < 1) {
        return 0;
    }
    return tokenIndex % colorCount;
}

function parseHexColor(hex) {
    const normalized = sanitizeColorSetting(hex, null);
    if (!normalized) {
        return null;
    }
    const clean = normalized.slice(1);
    return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
        a: clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1
    };
}

function blendColorOverBackground(foreground, background) {
    const alpha = Math.min(Math.max(foreground.a, 0), 1);
    return {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha)
    };
}

function relativeLuminance({ r, g, b }) {
    const toLinear = (channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(firstLuminance, secondLuminance) {
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function textColorForBackground(hex, underlyingBackground) {
    const highlight = parseHexColor(hex);
    const background = parseHexColor(underlyingBackground);
    if (!highlight || !background) {
        return LIGHT_CONTRAST_TEXT;
    }

    const effectiveBackground = blendColorOverBackground(highlight, background);
    const backgroundLuminance = relativeLuminance(effectiveBackground);
    const darkLuminance = relativeLuminance(parseHexColor(DARK_CONTRAST_TEXT));
    const lightLuminance = relativeLuminance(parseHexColor(LIGHT_CONTRAST_TEXT));
    const darkContrast = contrastRatio(backgroundLuminance, darkLuminance);
    const lightContrast = contrastRatio(backgroundLuminance, lightLuminance);
    return darkContrast >= lightContrast ? DARK_CONTRAST_TEXT : LIGHT_CONTRAST_TEXT;
}

function getEditorBackgroundColor() {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
        ? '#FFFFFF'
        : '#1E1E1E';
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

let highlightColors = DEFAULT_HIGHLIGHT_COLORS.slice();

let statusBarTemplate = DEFAULT_STATUS_TEMPLATE;
let enabledFilePatterns = [];

function loadHighlightColors(context) {
    const storedPalette = context.globalState.get(HIGHLIGHT_COLORS_KEY);
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

    highlightColors = resolveHighlightPalette(storedPalette, evenStored, oddStored);

    const storedPaletteMatches = Array.isArray(storedPalette) &&
        storedPalette.length === highlightColors.length &&
        storedPalette.every((color, index) => color === highlightColors[index]);
    const needsPaletteRepair = storedPalette !== undefined && !storedPaletteMatches;
    const needsLegacyMigration = storedPalette === undefined && (evenStored !== undefined || oddStored !== undefined);

    if (needsPaletteRepair || needsLegacyMigration) {
        void context.globalState.update(HIGHLIGHT_COLORS_KEY, highlightColors);
    }
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
    const editorBackground = getEditorBackgroundColor();
    return highlightColors.map(color => {
        const options = {
            backgroundColor: hexToCssColor(color)
        };
        if (color.length !== 9 || !color.endsWith('00')) {
            options.color = textColorForBackground(color, editorBackground);
        }
        return vscode.window.createTextEditorDecorationType(options);
    });
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
    const readablePrefix = readable.slice(0, HF_SAFE_ID_READABLE_MAX_LENGTH) || 'model';
    const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, HF_SAFE_ID_HASH_LENGTH);
    return `${readablePrefix}_${hash}`;
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
// `FileHandle.write` may return a partial byte count (disk-full, network FS, signal
// interruption), so we loop until every byte lands before fsync+rename. A single
// raw call would silently truncate the cache file while still reporting success.
async function writeAtomicFile(finalPath, data) {
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
    let fileHandle = null;
    try {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        fileHandle = await fs.promises.open(tmpPath, 'w');
        try {
            let offset = 0;
            while (offset < buffer.length) {
                const result = await fileHandle.write(buffer, offset, buffer.length - offset, offset);
                if (result.bytesWritten <= 0) {
                    throw new Error(`FileHandle.write reported 0 bytes written at offset ${offset}/${buffer.length}`);
                }
                offset += result.bytesWritten;
            }
            await fileHandle.sync();
        } finally {
            await fileHandle.close();
            fileHandle = null;
        }
        await fs.promises.rename(tmpPath, finalPath);
    } catch (error) {
        if (fileHandle) {
            try {
                await fileHandle.close();
            } catch (_ignored) {
                // best-effort cleanup below still runs
            }
        }
        await removeFileIfExists(tmpPath);
        throw error;
    }
}

async function removeFileIfExists(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (_ignored) {
        // best-effort cleanup; leave the stale file rather than crash the extension
    }
}

async function readTextFileIfExists(filePath, fallback) {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return fallback;
        }
        throw error;
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
        context.globalState.setKeysForSync([HIGHLIGHT_COLORS_KEY, HIGHLIGHT_EVEN_KEY, HIGHLIGHT_ODD_KEY]);
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
                    tokenDecorations.forEach(decoration => decoration.dispose());
                }
            }
        }
    );

    function clearTokenHighlights(editor = vscode.window.activeTextEditor) {
        if (!editor) {
            return;
        }
        if (tokenDecorations) {
            tokenDecorations.forEach(decoration => editor.setDecorations(decoration, []));
        }
    }

    function refreshTokenDecorations() {
        if (!tokenDecorations) {
            tokenDecorations = createTokenDecorationTypes();
            return;
        }

        vscode.window.visibleTextEditors.forEach(editor => {
            tokenDecorations.forEach(decoration => editor.setDecorations(decoration, []));
        });

        tokenDecorations.forEach(decoration => decoration.dispose());
        tokenDecorations = createTokenDecorationTypes();

        vscode.window.visibleTextEditors.forEach(editor => {
            if (!isHighlightableEditor(editor)) {
                tokenDecorations.forEach(decoration => editor.setDecorations(decoration, []));
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

        const rangesByColor = tokenDecorations.map(() => []);
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
        let visibleIndex = 0;
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
                rangesByColor[getHighlightColorIndex(visibleIndex, rangesByColor.length)].push(range);
                visibleIndex++;
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

        tokenDecorations.forEach((decoration, index) => {
            editor.setDecorations(decoration, rangesByColor[index]);
        });
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

    function getHuggingfaceCacheDir() {
        const base = context.globalStorageUri && context.globalStorageUri.fsPath;
        if (!base) {
            throw new Error('Extension global storage path is unavailable.');
        }
        return path.join(base, HF_CACHE_DIR_NAME);
    }

    async function ensureHuggingfaceCacheDir() {
        const dir = getHuggingfaceCacheDir();
        await fs.promises.mkdir(dir, { recursive: true });
        return dir;
    }

    async function getHuggingfaceCacheFilePath(safeId, suffix) {
        const dir = await ensureHuggingfaceCacheDir();
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
            let tokenizerJson;
            try {
                tokenizerJson = await fs.promises.readFile(filePath, 'utf8');
            } catch (error) {
                if (error && error.code === 'ENOENT') {
                    throw new Error(`HuggingFace tokenizer file not found at "${filePath}".`);
                }
                throw error;
            }
            const siblingConfig = path.join(path.dirname(filePath), 'tokenizer_config.json');
            const tokenizerConfigJson = await readTextFileIfExists(siblingConfig, '{}');
            return {
                tokenizer: buildHuggingfaceTokenizerFromStrings(tokenizerJson, tokenizerConfigJson),
                loadToken
            };
        }

        if (source.kind === 'remote') {
            const tokenizerPath = await getHuggingfaceCacheFilePath(source.safeId, '.json');
            const configPath = await getHuggingfaceCacheFilePath(source.safeId, '.config.json');

            // Try the cache first. Validate by actually parsing + constructing the
            // tokenizer; if that throws, the cache entry is corrupt (interrupted
            // write, cross-window race, truncated disk) so we wipe it and refetch.
            try {
                const cachedTokenizerJson = await fs.promises.readFile(tokenizerPath, 'utf8');
                const cachedConfigJson = await readTextFileIfExists(configPath, '{}');
                return {
                    tokenizer: buildHuggingfaceTokenizerFromStrings(cachedTokenizerJson, cachedConfigJson),
                    loadToken
                };
            } catch (cacheError) {
                if (!cacheError || cacheError.code !== 'ENOENT') {
                    console.warn(`[gpt-token-counter-live] Discarding corrupt HuggingFace cache for "${source.modelId}" and refetching: ${cacheError.message}`);
                    await removeFileIfExists(tokenizerPath);
                    await removeFileIfExists(configPath);
                }
            }

            // Cache miss or self-healed from a corrupt entry. Fetch, build (which
            // validates the JSON), then only persist to the cache after we know
            // the data produces a usable tokenizer.
            const fetched = await fetchHuggingfaceTokenizerFiles(source.modelId);
            const tokenizer = buildHuggingfaceTokenizerFromStrings(fetched.tokenizerJson, fetched.tokenizerConfigJson);

            try {
                await writeAtomicFile(tokenizerPath, fetched.tokenizerJson);
                await writeAtomicFile(configPath, fetched.tokenizerConfigJson);
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
        if (tokenizerState.hfErrorLabel === '<no-config>') {
            return;
        }
        const source = resolveHuggingfaceSource(readHuggingfaceConfigFromVscode());
        if (source.kind === 'none') {
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

        const rangesByColor = tokenDecorations.map(() => []);
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
            rangesByColor[getHighlightColorIndex(visibleIndex, rangesByColor.length)].push(range);
            visibleIndex++;
        }

        tokenDecorations.forEach((decoration, index) => {
            editor.setDecorations(decoration, rangesByColor[index]);
        });
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
    vscode.window.onDidChangeActiveColorTheme(() => {
        refreshTokenDecorations();
        if (highlightEnabled && tokenizerState.supportsHighlight) {
            scheduleUpdateTokenCount();
        }
    }, null, context.subscriptions);

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
    const refreshHuggingfaceCache = vscode.commands.registerCommand('gpt-token-counter-live.refreshHuggingfaceCache', async () => {
        if (currentProvider !== 'huggingface') {
            vscode.window.showInformationMessage('Switch to the HuggingFace model family before refreshing its tokenizer cache.');
            return;
        }
        const hfConfig = readHuggingfaceConfigFromVscode();
        const source = resolveHuggingfaceSource(hfConfig);
        if (source.kind === 'remote') {
            await removeFileIfExists(await getHuggingfaceCacheFilePath(source.safeId, '.json'));
            await removeFileIfExists(await getHuggingfaceCacheFilePath(source.safeId, '.config.json'));
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

        const getHtml = (colors) => {
            const nonce = String(Date.now());
            const serializedColors = JSON.stringify(sanitizeHighlightPalette(colors)).replace(/</g, '\\u003c');
            const serializedDefaults = JSON.stringify(DEFAULT_HIGHLIGHT_COLORS).replace(/</g, '\\u003c');
            const serializedAdditionalColors = JSON.stringify(ADDITIONAL_HIGHLIGHT_COLORS).replace(/</g, '\\u003c');
            const serializedPreviewBackground = JSON.stringify(getEditorBackgroundColor());
            const maxHighlightColors = MAX_HIGHLIGHT_COLORS;

            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Token Highlight Colors</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        h1 { font-size: 1.3rem; margin-bottom: 8px; }
        button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 3px; padding: 6px 10px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
        button:disabled { opacity: 0.45; cursor: default; }
        .helper { font-size: 0.85rem; color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
        .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
        .palette-item { padding: 12px 0; border-top: 1px solid var(--vscode-editorWidget-border); }
        .palette-item:first-child { border-top: 0; padding-top: 0; }
        .picker-row, .alpha-row { display: flex; align-items: center; gap: 10px; }
        .picker-row { margin-bottom: 6px; }
        .alpha-row { margin-left: 126px; }
        label { width: 116px; flex: 0 0 116px; }
        input[type="color"] { appearance: none; -webkit-appearance: none; border: none; width: 40px; height: 34px; padding: 0; background: transparent; cursor: pointer; }
        input[type="range"] { flex: 1; min-width: 120px; }
        .value-chip { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8rem; padding: 4px 6px; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); min-width: 92px; text-align: center; }
        .row-actions { display: flex; gap: 4px; margin-left: auto; }
        .row-actions button { min-width: 30px; padding: 5px 8px; }
        .preview { position: sticky; bottom: 0; overflow: hidden; white-space: nowrap; padding: 4px 6px; background: var(--vscode-editor-background); }
    </style>
</head>
<body>
    <h1>Token Highlight Colors</h1>
    <p class="helper">Tokens cycle through this palette in order. Dragging previews locally; changes apply to the editor on release.</p>
    <div class="toolbar">
        <button id="addColor">Add color</button>
        <button id="resetPalette" class="secondary">Reset palette</button>
    </div>
    <div id="palette"></div>
    <div id="preview" class="preview"></div>
    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        const paletteElement = document.getElementById('palette');
        const previewElement = document.getElementById('preview');
        const addColorButton = document.getElementById('addColor');
        const resetPaletteButton = document.getElementById('resetPalette');
        const defaultColors = ${serializedDefaults};
        const additionalColors = ${serializedAdditionalColors};
        const previewBackground = ${serializedPreviewBackground};
        const maxColors = ${maxHighlightColors};
        let colors = ${serializedColors};
        let nextAdditionalColorIndex = Math.max(0, colors.length - defaultColors.length) % additionalColors.length;
        const previewTokens = ['##', ' Structure', '\\n', '-', ' pages/', ' contains', ' maintained', ' project', ' knowledge', '.'];

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const hexToRgba = (hex) => {
            const clean = hex.replace('#', '');
            return {
                r: parseInt(clean.slice(0, 2), 16),
                g: parseInt(clean.slice(2, 4), 16),
                b: parseInt(clean.slice(4, 6), 16),
                a: clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1
            };
        };

        const blendOnBackground = (foreground) => {
            const alpha = clamp(foreground.a, 0, 1);
            const background = hexToRgba(previewBackground);
            return {
                r: foreground.r * alpha + background.r * (1 - alpha),
                g: foreground.g * alpha + background.g * (1 - alpha),
                b: foreground.b * alpha + background.b * (1 - alpha)
            };
        };

        const luminance = ({ r, g, b }) => {
            const srgb = [r, g, b].map(component => {
                const scaled = component / 255;
                return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
        };

        const pickTextColor = (hex) => {
            if (hex.length === 9 && parseInt(hex.slice(7), 16) === 0) {
                return 'var(--vscode-editor-foreground)';
            }
            const blended = blendOnBackground(hexToRgba(hex));
            const backgroundLuminance = luminance(blended);
            const darkLuminance = luminance({ r: 31, g: 31, b: 31 });
            const lightLuminance = luminance({ r: 255, g: 255, b: 255 });
            const contrast = (first, second) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
            return contrast(backgroundLuminance, darkLuminance) >= contrast(backgroundLuminance, lightLuminance)
                ? '#1F1F1F'
                : '#FFFFFF';
        };

        const toHex6 = (value) => value.slice(0, 7).toLowerCase();
        const toAlphaPercent = (value) => value.length === 9
            ? Math.round((parseInt(value.slice(7), 16) / 255) * 100)
            : 100;

        const toAlphaHex = (percent) => {
            const alphaValue = Math.round((clamp(Number(percent), 0, 100) / 100) * 255);
            return alphaValue >= 255 ? '' : alphaValue.toString(16).padStart(2, '0').toUpperCase();
        };

        const composeColor = (baseHex, percent) => {
            const normalizedBase = baseHex.toUpperCase();
            const alphaHex = toAlphaHex(percent);
            return alphaHex ? normalizedBase + alphaHex : normalizedBase;
        };

        const applyPalette = () => {
            vscodeApi.postMessage({ type: 'paletteChange', colors: colors.slice() });
        };

        const renderPreview = () => {
            previewElement.innerHTML = previewTokens.map((token, index) => {
                const color = colors[index % colors.length];
                return '<span style="background:' + color + ';color:' + pickTextColor(color) + '">' + token.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
            }).join('');
        };

        const updateColorAt = (index, baseHex, alphaPercent, row) => {
            const color = composeColor(baseHex, alphaPercent);
            colors[index] = color;
            row.querySelector('[data-value]').textContent = color;
            row.querySelector('[data-alpha-value]').textContent = Math.round(alphaPercent) + '%';
            renderPreview();
        };

        const renderPalette = (focusRequest = null) => {
            addColorButton.disabled = colors.length >= maxColors;
            paletteElement.innerHTML = colors.map((color, index) => {
                const baseHex = toHex6(color);
                const alphaPercent = toAlphaPercent(color);
                return '<div class="palette-item" data-index="' + index + '">' +
                    '<div class="picker-row">' +
                        '<label>Color ' + (index + 1) + '</label>' +
                        '<input data-color type="color" value="' + baseHex + '" aria-label="Token color ' + (index + 1) + '" />' +
                        '<span class="value-chip" data-value>' + color + '</span>' +
                        '<div class="row-actions">' +
                            '<button class="secondary" data-move-up title="Move color ' + (index + 1) + ' up" aria-label="Move color ' + (index + 1) + ' up"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
                            '<button class="secondary" data-move-down title="Move color ' + (index + 1) + ' down" aria-label="Move color ' + (index + 1) + ' down"' + (index === colors.length - 1 ? ' disabled' : '') + '>↓</button>' +
                            '<button class="secondary" data-remove title="Remove color ' + (index + 1) + '" aria-label="Remove color ' + (index + 1) + '"' + (colors.length === 1 ? ' disabled' : '') + '>×</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="alpha-row">' +
                        '<label>Opacity</label>' +
                        '<input data-alpha type="range" min="0" max="100" step="1" value="' + alphaPercent + '" aria-label="Token color ' + (index + 1) + ' opacity" />' +
                        '<span class="value-chip" data-alpha-value>' + alphaPercent + '%</span>' +
                    '</div>' +
                '</div>';
            }).join('');

            paletteElement.querySelectorAll('.palette-item').forEach(row => {
                const index = Number(row.dataset.index);
                const colorInput = row.querySelector('[data-color]');
                const alphaInput = row.querySelector('[data-alpha]');

                const update = () => updateColorAt(index, colorInput.value, Number(alphaInput.value), row);
                colorInput.addEventListener('input', update);
                alphaInput.addEventListener('input', update);
                colorInput.addEventListener('change', applyPalette);
                alphaInput.addEventListener('change', applyPalette);

                row.querySelector('[data-move-up]').addEventListener('click', () => {
                    if (index === 0) return;
                    [colors[index - 1], colors[index]] = [colors[index], colors[index - 1]];
                    renderPalette({ index: index - 1, action: 'move-up' });
                    applyPalette();
                });

                row.querySelector('[data-move-down]').addEventListener('click', () => {
                    if (index >= colors.length - 1) return;
                    [colors[index], colors[index + 1]] = [colors[index + 1], colors[index]];
                    renderPalette({ index: index + 1, action: 'move-down' });
                    applyPalette();
                });

                row.querySelector('[data-remove]').addEventListener('click', () => {
                    if (colors.length === 1) return;
                    colors.splice(index, 1);
                    renderPalette({ index: Math.min(index, colors.length - 1), action: 'remove' });
                    applyPalette();
                });
            });

            renderPreview();

            if (focusRequest) {
                const focusRow = paletteElement.querySelector('.palette-item[data-index="' + focusRequest.index + '"]');
                const preferredTarget = focusRow && focusRow.querySelector('[data-' + focusRequest.action + ']');
                const fallbackTarget = focusRow && focusRow.querySelector('[data-color]');
                const focusTarget = preferredTarget && !preferredTarget.disabled ? preferredTarget : fallbackTarget;
                if (focusTarget) focusTarget.focus();
            }
        };

        addColorButton.addEventListener('click', () => {
            if (colors.length >= maxColors) return;
            colors.push(additionalColors[nextAdditionalColorIndex]);
            nextAdditionalColorIndex = (nextAdditionalColorIndex + 1) % additionalColors.length;
            renderPalette();
            applyPalette();
        });

        resetPaletteButton.addEventListener('click', () => {
            colors = defaultColors.slice();
            nextAdditionalColorIndex = 0;
            renderPalette();
            applyPalette();
        });

        renderPalette();
    </script>
</body>
</html>`;
        };

        panel.webview.html = getHtml(highlightColors);

        const updatePalette = async (colors) => {
            const nextPalette = sanitizeHighlightPalette(colors, highlightColors);
            if (nextPalette.length === highlightColors.length && nextPalette.every((color, index) => color === highlightColors[index])) {
                return;
            }
            highlightColors = nextPalette;
            await context.globalState.update(HIGHLIGHT_COLORS_KEY, nextPalette);
            refreshTokenDecorations();
            if (highlightEnabled && tokenizerState.supportsHighlight) {
                scheduleUpdateTokenCount();
            }
        };

        const messageDisposable = panel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'paletteChange' && Array.isArray(message.colors)) {
                await updatePalette(message.colors);
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
        sanitizeHighlightPalette,
        resolveHighlightPalette,
        getHighlightColorIndex,
        textColorForBackground,
        getDefaultHighlightColors: () => DEFAULT_HIGHLIGHT_COLORS.slice(),
        loadEnabledFilePatterns,
        matchesEnabledFilePatterns,
        matchesFilePatterns,
        normalizeEnabledFilePatterns,
        setEnabledFilePatterns: (patterns) => {
            enabledFilePatterns = normalizeEnabledFilePatterns(patterns);
        }
    }
};
