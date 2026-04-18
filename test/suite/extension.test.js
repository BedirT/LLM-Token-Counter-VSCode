const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

const extension = require('../../src/extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('UTF-8 boundary map includes multi-byte character boundaries', () => {
		const map = extension.__internal.buildUtf8BoundaryMap('A❌B');
		assert.strictEqual(map.get(0), 0);
		assert.strictEqual(map.get(1), 1);
		assert.strictEqual(map.get(4), 2);
		assert.strictEqual(map.get(5), 3);
	});

	test('resolveUtf16Offset snaps to nearest valid boundary', () => {
		const source = 'A❌B';
		const map = extension.__internal.buildUtf8BoundaryMap(source);

		const totalBytes = Buffer.byteLength(source, 'utf8');

		assert.strictEqual(extension.__internal.resolveUtf16Offset(map, 2, totalBytes, 'backward'), 1);
		assert.strictEqual(extension.__internal.resolveUtf16Offset(map, 2, totalBytes, 'forward'), 2);
	});

	test('normalization offset map preserves full-width character spans', () => {
		const map = extension.__internal.buildNormalizationOffsetMap('ＡB');
		assert.strictEqual(map.normalizedText, 'AB');
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 0, 'backward'), 0);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 1, 'forward'), 1);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 2, 'forward'), 2);
	});

	test('normalization offset map expands combined characters back to original span', () => {
		const map = extension.__internal.buildNormalizationOffsetMap('e\u0301');
		assert.strictEqual(map.normalizedText, 'é');
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 0, 'backward'), 0);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 1, 'forward'), 2);
	});

	test('normalization offset map snaps interior expanded offsets to one original grapheme', () => {
		const map = extension.__internal.buildNormalizationOffsetMap('ﬃ');
		assert.strictEqual(map.normalizedText, 'ffi');
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 1, 'backward'), 0);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 1, 'forward'), 1);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 2, 'backward'), 0);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 2, 'forward'), 1);
	});

	test('normalization offset map preserves full-width parentheses spans', () => {
		const map = extension.__internal.buildNormalizationOffsetMap('（）');
		assert.strictEqual(map.normalizedText, '()');
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 0, 'backward'), 0);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 1, 'backward'), 1);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 1, 'forward'), 1);
		assert.strictEqual(extension.__internal.resolveOriginalOffsetFromNormalized(map, 2, 'forward'), 2);
	});

	test('normalization offset map returns null when NFKC merges across grapheme boundaries', () => {
		assert.strictEqual(extension.__internal.buildNormalizationOffsetMap('\uFFB5\uFFCC'), null);
	});

	test('iterateGraphemeSegments requires Intl.Segmenter support', () => {
		const originalSegmenter = Intl.Segmenter;
		try {
			Intl.Segmenter = undefined;
			assert.throws(
				() => extension.__internal.buildNormalizationOffsetMap('test'),
				/Intl\.Segmenter is required/
			);
		} finally {
			Intl.Segmenter = originalSegmenter;
		}
	});
});

suite('File Pattern Matching', () => {
	const {
		matchesFilePatterns,
		matchesEnabledFilePatterns,
		normalizeEnabledFilePatterns,
		setEnabledFilePatterns
	} = extension._test;

	test('Empty patterns matches any path', () => {
		assert.strictEqual(matchesFilePatterns('docs/file.md', []), true);
		assert.strictEqual(matchesFilePatterns('src/main.js', []), true);
		assert.strictEqual(matchesFilePatterns('', []), true);
	});

	test('Filename-only globs match by basename', () => {
		assert.strictEqual(matchesFilePatterns('README.md', ['*.md']), true);
		assert.strictEqual(matchesFilePatterns('docs/file.md', ['*.md']), true);
		assert.strictEqual(matchesFilePatterns('deeply/nested/path/file.md', ['*.md']), true);
		assert.strictEqual(matchesFilePatterns('src/main.js', ['*.md']), false);
		assert.strictEqual(matchesFilePatterns('docs/file.mdc', ['*.md']), false);
	});

	test('Multiple patterns match with OR semantics', () => {
		const patterns = ['*.md', '*.mdc'];
		assert.strictEqual(matchesFilePatterns('README.md', patterns), true);
		assert.strictEqual(matchesFilePatterns('rules.mdc', patterns), true);
		assert.strictEqual(matchesFilePatterns('main.js', patterns), false);
	});

	test('Workspace-relative directory patterns', () => {
		// Users writing `docs/*.md` expect it to match files directly in the workspace's docs/ folder.
		assert.strictEqual(matchesFilePatterns('docs/file.md', ['docs/*.md']), true);
		assert.strictEqual(matchesFilePatterns('nested/docs/file.md', ['docs/*.md']), false);
		// Explicit `**` still works for any-depth matching.
		assert.strictEqual(matchesFilePatterns('nested/docs/file.md', ['**/docs/*.md']), true);
		assert.strictEqual(matchesFilePatterns('docs/file.md', ['**/docs/*.md']), true);
	});

	test('Dotfiles match via dot:true option', () => {
		assert.strictEqual(matchesFilePatterns('.hidden.md', ['*.md']), true);
		assert.strictEqual(matchesFilePatterns('.config/settings.md', ['**/*.md']), true);
	});

	test('Windows backslash separators are normalized', () => {
		assert.strictEqual(matchesFilePatterns('docs\\file.md', ['docs/*.md']), true);
		assert.strictEqual(matchesFilePatterns('project\\docs\\readme.md', ['**/docs/*.md']), true);
		assert.strictEqual(matchesFilePatterns('project\\src\\main.js', ['**/docs/*.md']), false);
	});

	test('Non-string path returns false when patterns are non-empty', () => {
		assert.strictEqual(matchesFilePatterns(null, ['*.md']), false);
		assert.strictEqual(matchesFilePatterns(undefined, ['*.md']), false);
		assert.strictEqual(matchesFilePatterns(42, ['*.md']), false);
	});

	test('matchesEnabledFilePatterns guards null/undefined editors', () => {
		setEnabledFilePatterns(['*.md']);
		assert.strictEqual(matchesEnabledFilePatterns(null), false);
		assert.strictEqual(matchesEnabledFilePatterns(undefined), false);
		assert.strictEqual(matchesEnabledFilePatterns({}), false);
		assert.strictEqual(matchesEnabledFilePatterns({ document: null }), false);
	});

	test('normalizeEnabledFilePatterns trims and drops non-strings', () => {
		assert.deepStrictEqual(
			normalizeEnabledFilePatterns([' *.md ', '  *.mdc  ']),
			['*.md', '*.mdc']
		);
		assert.deepStrictEqual(
			normalizeEnabledFilePatterns(['*.md', '', '   ', null, 42, '*.js']),
			['*.md', '*.js']
		);
		assert.deepStrictEqual(normalizeEnabledFilePatterns(null), []);
		assert.deepStrictEqual(normalizeEnabledFilePatterns('not-an-array'), []);
	});

	suiteTeardown(() => {
		setEnabledFilePatterns([]);
	});
});

suite('HuggingFace Tokenizer', () => {
	const {
		deriveHfSafeId,
		resolveHuggingfaceSource,
		reconstructHuggingfaceOffsets,
		buildHuggingfaceTokenizerFromStrings,
		huggingfaceTokenizerSupportsHighlight,
		Tokenizer
	} = extension.__hf;

	test('deriveHfSafeId readable prefix uses double-dashes for path separators', () => {
		assert.ok(
			deriveHfSafeId('Qwen/Qwen2.5-7B-Instruct').startsWith('Qwen--Qwen2.5-7B-Instruct_'),
			'prefix should mirror the model ID before the hash separator'
		);
		assert.ok(
			deriveHfSafeId('meta-llama/Llama-3-8B').startsWith('meta-llama--Llama-3-8B_'),
			'prefix should mirror the model ID before the hash separator'
		);
	});

	test('deriveHfSafeId scrubs unsafe characters in the readable prefix', () => {
		assert.ok(deriveHfSafeId('my org/weird name (fork)').startsWith('my_org--weird_name__fork__'));
		assert.ok(deriveHfSafeId('bedirt/model_v1.0').startsWith('bedirt--model_v1.0_'));
	});

	test('deriveHfSafeId appends a 12-char hex hash for disambiguation', () => {
		assert.match(deriveHfSafeId('Qwen/Qwen2.5-7B-Instruct'), /_[0-9a-f]{12}$/);
		assert.match(deriveHfSafeId('bedirt/model_v1.0'), /_[0-9a-f]{12}$/);
	});

	test('deriveHfSafeId is injective for IDs that would share a readable prefix', () => {
		// Both of these previously collapsed to `a--b--c` and clobbered each other in the
		// cache. The hash suffix must keep them distinct.
		assert.notStrictEqual(deriveHfSafeId('a/b--c'), deriveHfSafeId('a--b/c'));
		assert.notStrictEqual(deriveHfSafeId('foo/bar'), deriveHfSafeId('foo--bar'));
	});

	test('deriveHfSafeId is deterministic for the same input', () => {
		assert.strictEqual(deriveHfSafeId('Qwen/Qwen2.5-7B-Instruct'), deriveHfSafeId('Qwen/Qwen2.5-7B-Instruct'));
	});

	test('deriveHfSafeId handles falsy input', () => {
		assert.strictEqual(deriveHfSafeId(''), '');
		assert.strictEqual(deriveHfSafeId(null), '');
		assert.strictEqual(deriveHfSafeId(undefined), '');
		assert.strictEqual(deriveHfSafeId(42), '');
	});

	test('resolveHuggingfaceSource picks local path when both present', () => {
		const both = resolveHuggingfaceSource({
			localPath: '/abs/path/tokenizer.json',
			modelId: 'Qwen/Qwen2.5-7B-Instruct'
		});
		assert.strictEqual(both.kind, 'local');
		assert.strictEqual(both.path, '/abs/path/tokenizer.json');
	});

	test('resolveHuggingfaceSource falls back to model id when local is empty', () => {
		const remote = resolveHuggingfaceSource({ localPath: '', modelId: 'Qwen/Qwen2.5-7B-Instruct' });
		assert.strictEqual(remote.kind, 'remote');
		assert.strictEqual(remote.modelId, 'Qwen/Qwen2.5-7B-Instruct');
		assert.ok(remote.safeId.startsWith('Qwen--Qwen2.5-7B-Instruct_'));
		assert.match(remote.safeId, /_[0-9a-f]{12}$/);
	});

	test('resolveHuggingfaceSource trims whitespace and treats whitespace-only as none', () => {
		assert.strictEqual(resolveHuggingfaceSource({ modelId: '   ', localPath: '   ' }).kind, 'none');
		assert.strictEqual(resolveHuggingfaceSource({}).kind, 'none');
	});

	test('reconstructHuggingfaceOffsets returns empty result for empty ids', () => {
		const fakeTokenizer = { decode: () => '' };
		const result = reconstructHuggingfaceOffsets(fakeTokenizer, '', []);
		assert.deepStrictEqual(result.offsets, []);
		assert.strictEqual(result.aligned, true);
	});

	test('reconstructHuggingfaceOffsets flags misalignment when decode does not match source text', () => {
		// Simulates a SentencePiece-style tokenizer that drops leading whitespace.
		const fakeTokenizer = {
			decode(ids) {
				const pieces = { 10: 'Hello', 11: ' world' };
				return ids.map((id) => pieces[id]).join('');
			}
		};
		const result = reconstructHuggingfaceOffsets(fakeTokenizer, '  Hello world', [10, 11]);
		assert.strictEqual(result.aligned, false, 'expected roundtrip mismatch to be flagged');
	});

	test('reconstructHuggingfaceOffsets produces aligned offsets for a simple byte-level BPE roundtrip', () => {
		// Mirror the actual @huggingface/tokenizers decode semantics: pass ids and let the
		// fake look up per-id pieces. Two-arg decode options are accepted but unused here.
		const pieces = { 1: 'Hello', 2: ' World', 3: '!' };
		const fakeTokenizer = {
			decode(ids) {
				return ids.map((id) => pieces[id]).join('');
			}
		};
		const text = 'Hello World!';
		const ids = [1, 2, 3];
		const result = reconstructHuggingfaceOffsets(fakeTokenizer, text, ids);
		assert.strictEqual(result.aligned, true);
		assert.deepStrictEqual(result.offsets, [[0, 5], [5, 11], [11, 12]]);
		// Slicing the source text with each offset yields the matching piece.
		assert.strictEqual(text.slice(0, 5), 'Hello');
		assert.strictEqual(text.slice(5, 11), ' World');
		assert.strictEqual(text.slice(11, 12), '!');
	});

	test('huggingfaceTokenizerSupportsHighlight returns true for a roundtripping tokenizer', () => {
		// Byte-level-BPE-style mock: per-id decode yields the corresponding piece, and the
		// concatenation of all pieces equals the probe text ` Hello, world!\nSecond line.`.
		const pieces = { 1: ' Hello', 2: ', world!', 3: '\nSecond line.' };
		const fakeTokenizer = {
			encode: () => ({ ids: [1, 2, 3] }),
			decode(ids) {
				return ids.map((id) => pieces[id]).join('');
			}
		};
		assert.strictEqual(huggingfaceTokenizerSupportsHighlight(fakeTokenizer), true);
	});

	test('huggingfaceTokenizerSupportsHighlight returns false when decode mutates whitespace', () => {
		// SentencePiece-style: strip leading whitespace on full decode. The probe text starts
		// with a space so the round trip will not match.
		const fakeTokenizer = {
			encode: () => ({ ids: [1] }),
			decode() {
				return 'Hello, world!\nSecond line.';
			}
		};
		assert.strictEqual(huggingfaceTokenizerSupportsHighlight(fakeTokenizer), false);
	});

	test('huggingfaceTokenizerSupportsHighlight returns false if the tokenizer throws', () => {
		const fakeTokenizer = {
			encode() { throw new Error('boom'); },
			decode() { return ''; }
		};
		assert.strictEqual(huggingfaceTokenizerSupportsHighlight(fakeTokenizer), false);
	});

	test('reconstructHuggingfaceOffsets groups byte-level fragments that individually decode to U+FFFD', () => {
		// Emulate the real CJK/emoji behavior: single ids decode to `\uFFFD`, but the full group
		// decodes cleanly. The first id in a group should hold the full slice; follow-up ids
		// collapse to zero-length so per-token indexing is preserved.
		const fakeTokenizer = {
			decode(ids) {
				const key = ids.join(',');
				// Individual or short prefixes still produce broken UTF-8 from a byte-level BPE.
				if (key === '10' || key === '11' || key === '12' || key === '10,11') return '\uFFFD';
				if (key === '10,11,12') return '\u4F60'; // "你"
				throw new Error(`unexpected ids ${key}`);
			}
		};
		const text = '\u4F60'; // "你"
		const result = reconstructHuggingfaceOffsets(fakeTokenizer, text, [10, 11, 12]);
		assert.strictEqual(result.aligned, true);
		assert.deepStrictEqual(result.offsets, [[0, 1], [1, 1], [1, 1]]);
	});

	// Real-tokenizer tests: these download a small gpt-4 tokenizer once and skip with a note
	// if the network is unreachable. They cover end-to-end encode + roundtrip alignment.
	suite('with real tokenizer', function () {
		// Allow extra time for the first-run download.
		this.timeout(30000);

		const tmpDir = path.join(os.tmpdir(), 'llm-token-counter-hf-test');
		const tokenizerPath = path.join(tmpDir, 'tokenizer.json');
		const tokenizerConfigPath = path.join(tmpDir, 'tokenizer_config.json');
		let tokenizer = null;
		let fetchFailed = false;

		suiteSetup(async function () {
			try {
				fs.mkdirSync(tmpDir, { recursive: true });
				if (!fs.existsSync(tokenizerPath)) {
					if (typeof fetch !== 'function') {
						fetchFailed = true;
						return;
					}
					const baseUrl = 'https://huggingface.co/Xenova/gpt-4/resolve/main';
					const [tResp, cResp] = await Promise.all([
						fetch(`${baseUrl}/tokenizer.json`),
						fetch(`${baseUrl}/tokenizer_config.json`)
					]);
					if (!tResp.ok || !cResp.ok) {
						fetchFailed = true;
						return;
					}
					fs.writeFileSync(tokenizerPath, await tResp.text());
					fs.writeFileSync(tokenizerConfigPath, await cResp.text());
				}
				const tokenizerJson = fs.readFileSync(tokenizerPath, 'utf8');
				const tokenizerConfigJson = fs.existsSync(tokenizerConfigPath)
					? fs.readFileSync(tokenizerConfigPath, 'utf8')
					: '{}';
				tokenizer = buildHuggingfaceTokenizerFromStrings(tokenizerJson, tokenizerConfigJson);
			} catch (error) {
				fetchFailed = true;
				console.warn('[hf-test] Could not prepare real tokenizer fixture:', error.message);
			}
		});

		const ensureTokenizer = function (ctx) {
			if (!tokenizer || fetchFailed) {
				ctx.skip();
			}
		};

		test('Tokenizer is the constructor exported by @huggingface/tokenizers', function () {
			ensureTokenizer(this);
			assert.ok(tokenizer instanceof Tokenizer, 'expected tokenizer to be an instance of Tokenizer');
		});

		test('ASCII text round-trips cleanly and offsets cover the source', function () {
			ensureTokenizer(this);
			const text = 'Hello World! Let us tokenize some text.';
			const encoded = tokenizer.encode(text, { add_special_tokens: false });
			const { offsets, aligned } = reconstructHuggingfaceOffsets(tokenizer, text, encoded.ids);
			assert.strictEqual(aligned, true);
			assert.strictEqual(offsets.length, encoded.ids.length);
			// Offsets start at 0, end at text.length.
			assert.strictEqual(offsets[0][0], 0);
			assert.strictEqual(offsets[offsets.length - 1][1], text.length);
			// Offsets reconstruct the original text when sliced and concatenated.
			let reconstructed = '';
			for (const [start, end] of offsets) {
				reconstructed += text.slice(start, end);
			}
			assert.strictEqual(reconstructed, text);
		});

		test('CJK text groups multi-byte tokens into a single aligned slice', function () {
			ensureTokenizer(this);
			const text = 'Chinese: \u4F60\u597D\u4E16\u754C';
			const encoded = tokenizer.encode(text, { add_special_tokens: false });
			const { offsets, aligned } = reconstructHuggingfaceOffsets(tokenizer, text, encoded.ids);
			assert.strictEqual(aligned, true, 'CJK reconstruction should still match the source text');
			assert.strictEqual(offsets[offsets.length - 1][1], text.length);
		});

		test('encode + offsets with emoji preserves alignment', function () {
			ensureTokenizer(this);
			const text = 'Emoji test: \uD83E\uDD9C';
			const encoded = tokenizer.encode(text, { add_special_tokens: false });
			const { offsets, aligned } = reconstructHuggingfaceOffsets(tokenizer, text, encoded.ids);
			assert.strictEqual(aligned, true);
			assert.strictEqual(offsets[offsets.length - 1][1], text.length);
		});
	});
});
