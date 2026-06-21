# VS Code Extension Bundling Strategy

## Problem
VS Code extensions distributed via Marketplace need all runtime code bundled
into the `.vsix`. The Marketplace does **not** run `npm install` on the user's
machine — anything not inside the `.vsix` is simply missing at runtime.

## Solution
esbuild bundles `src/extension.ts` and everything it imports into a single
`dist/extension.js`. The extension talks to the MemoryAI server directly over
`fetch` and has **no native dependencies**, so the whole extension is pure JS.

`vscode` is the only external (always provided by the host).

## Build Configuration

### package.json
```json
{
  "scripts": {
    "build": "esbuild ./src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --target=node20"
  }
}
```

The extension does not depend on `@memoryai.dev/core` or `better-sqlite3`. It
has no runtime `dependencies` at all — only dev tooling (esbuild, typescript,
types).

### .vscodeignore
```
**/*.ts
node_modules/**
out/**
.git/**
.github/**
```
Nothing under `node_modules` ships: esbuild has already inlined every JS import
into `dist/extension.js`, and there are no native modules to re-include.

## Result
- Extension bundle: ~68KB (single JS file)
- Total .vsix: well under 1MB (no native binary)

## Publishing
```bash
npm run package    # esbuild --minify → dist/extension.js
vsce package       # Creates the .vsix
vsce publish       # Upload to Marketplace
```

User downloads from Marketplace → everything is in the bundle → no manual
`npm install`, works offline.
