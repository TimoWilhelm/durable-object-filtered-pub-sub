import { defineConfig, Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';
import { readFile } from 'node:fs/promises';

function importAsText(match: RegExp): Plugin {
	return {
		name: 'import-as-text',
		enforce: 'pre',
		async load(id) {
			const path = id.split('?')[0];
			if (!match.test(path)) return null;
			return {
				code: `export default ${JSON.stringify(await readFile(path, 'utf8')).replace(
					/[\u2028\u2029]/g,
					(c) => `\\u${`000${c.charCodeAt(0).toString(16)}`.slice(-4)}`
				)};`,
				map: { mappings: '' },
			};
		},
	};
}

export default defineConfig({
	plugins: [importAsText(/\.sql$/i),
		cloudflare()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
});
