// 从 DSH favicon.svg 生成白色鲸鱼通知小图标 vector(drawable/ic_notification.xml)
// 用法(项目根目录): node tools/gen-notification-icon.mjs
// 可通过环境变量覆盖 DSH favicon 路径: DSH_FAVICON_SVG=... node tools/gen-notification-icon.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SVG = process.env.DSH_FAVICON_SVG
  ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DSH Desktop',
      'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg');
const OUT = path.resolve(process.cwd(), 'app', 'src', 'main', 'res', 'drawable', 'ic_notification.xml');

const svg = readFileSync(SVG, 'utf8');
const m = svg.match(/ d="([^"]+)"/); // 注意: 必须带前导空格, 避免误匹配 id="path"
if (!m) { console.error('no path d found'); process.exit(1); }
const xml = [
  '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
  '    android:width="24dp"',
  '    android:height="24dp"',
  '    android:viewportWidth="50"',
  '    android:viewportHeight="50">',
  '    <path',
  '        android:fillColor="#FFFFFFFF"',
  `        android:pathData="${m[1]}" />`,
  '</vector>',
].join('\n') + '\n';
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, xml);
console.log('ic_notification.xml written, pathData len=' + m[1].length);
