import js from '@eslint/js'
import ts from 'typescript-eslint'

// The arrows of ARCHITECTURE.md: who may import whom.
const only = (files, group, message) => ({ files, rules: { 'no-restricted-imports': ['error', { patterns: [{ group, message }] }] } })

export default ts.config(
  { ignores: ['.orca/'] },
  js.configs.recommended,
  ts.configs.recommended,
  only(['src/telegram.ts', 'src/chat.ts', 'src/orca.ts', 'src/contracts.ts'], ['./*'], 'This module knows no other module of the plugin.'),
  only(['src/panel.tsx'], ['./*', '!./contracts', 'node:*'], 'The panel knows only the contracts.')
)
