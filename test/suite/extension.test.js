const assert = require('assert');
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
