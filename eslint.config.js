import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '**/.expo/',
    'eval/packs/',
    // Expo-generated (git-ignored) and native build output
    'apps/mobile/expo-env.d.ts',
    'apps/mobile/android/',
    'apps/mobile/ios/',
    'apps/mobile/web-build/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  // Contracts and root scripts run on Node.
  {
    ignores: ['apps/mobile/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  // The React Native app: no Node globals in app code.
  {
    files: ['apps/mobile/test/**', 'apps/mobile/jest.setup.ts'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    // jest.mock factories are hoisted above imports, so they must use require().
    files: ['apps/mobile/jest.setup.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Babel / Metro / Expo config files are CommonJS evaluated by Node.
    files: ['apps/mobile/*.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
