// dsh-notify 网页客户端打包:client/index.js → client/client.js(DSH 客户端模块 __ModuleLoader__ 模式)
// 零依赖构建:index.js 约定仅依赖 react(ESM import/export)→ 转换为 CJS factory 包裹。
// 若本机有 esbuild 也可用 esbuild 流程,产物形态一致。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(sourceDir, 'client.js');
// 宿主要求 __ModuleLoader__.load 的 id 必须等于完整包名(含 scope),否则报
// "loaded without registering <pkg> via __ModuleLoader__.load"
const loaderId = process.env.DSH_REMOTE_NOTIFY_CLIENT_ID ?? '@djmanito/dsh-notify';
const src = await readFile(resolve(sourceDir, 'index.js'), 'utf8');

// ESM → CJS factory 转换(仅处理约定内的两种语句):
//   import { a as b, c } from 'react'  →  const { a as b, c } = require("react")
//   export function X                   →  function X
//   export { a, b }                     →  收集到 module.exports
let code = src;
code = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"]react['"];?/g, (_m, names) => {
  // CJS 解构不支持 as 别名 → 拆开:先按原名解构,再逐个别名
  const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
  const spec = parts.map((p) => p.split(/\s+as\s+/)[0].trim());
  const local = parts.map((p) => (p.split(/\s+as\s+/)[1] ?? p.split(/\s+as\s+/)[0]).trim());
  const lines = [`const { ${spec.join(', ')} } = require("react");`];
  spec.forEach((s, i) => { if (s !== local[i]) lines.push(`const ${local[i]} = ${s};`); });
  return lines.join('\n');
});
const exportedNames = [];
code = code.replace(/export\s+function\s+([A-Za-z0-9_]+)/g, (m, n) => { exportedNames.push(n); return `function ${n}` });
code = code.replace(/export\s*\{([^}]+)\};?/g, (_m, names) => {
  names.split(',').forEach((n) => { const t = n.trim().split(/\s+as\s+/); if (t[0]) exportedNames.push(t[0]); });
  return '';
});
const exportList = [...new Set(exportedNames)];
if (exportList.length === 0) throw new Error('未找到任何 export — index.js 约定被破坏');
code += `\nmodule.exports = { ${exportList.join(', ')} };\n`;

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
${code}
    return module.exports;
  }
});
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath} (${wrapped.length} B), exports: ${exportList.join(',')}`);
