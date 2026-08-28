import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '.remember/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // eslint-plugin-react-hooks v7's React-Compiler-era ruleset flags
      // any setState reachable from an effect body — including the
      // standard "fetch on mount" pattern
      // (`useEffect(() => { void loadData() }, [])` where `loadData`
      // calls setState after an await). That's a correct, common
      // pattern for this app's screens (no data-fetching library is in
      // use yet), not a bug, so this specific rule is off rather than
      // rewriting every screen's initial-load effect around it.
      'react-hooks/set-state-in-effect': 'off'
    }
  },
  {
    // Server-mode seam (plan §1): these directories are plain TS with a
    // DB handle and must stay reusable by a future standalone server
    // package, so they may never import Electron.
    files: ['src/main/services/**/*.ts', 'src/main/importers/**/*.ts', 'src/main/kpi/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'services/, importers/, and kpi/ must stay Electron-free (server-mode seam, plan §1).'
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
