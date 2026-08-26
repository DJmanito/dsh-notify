// 图标生成(favicon 黑鲸 + 白底)
// 产出:
//  - legacy mipmap: mdpi48/hdpi72/xhdpi96/xxhdpi144/xxxhdpi192 ic_launcher.png(白底+黑鲸 80%)
//  - 自适应: mipmap-xxxhdpi/ic_launcher_foreground.png(432², 鲸鱼 66% 安全区, 透明底)
//  - mipmap-anydpi-v26/ic_launcher.xml + ic_launcher_round.xml
//  - values/ic_launcher_background.xml(白)
// 用法(项目根目录): node tools/gen-icons.mjs
// 环境变量(可选): DSH_PROFILE = DSH web profile 目录(默认 ~/.dsh/profiles/web, sharp 从此处借用)
//                DSH_FAVICON_SVG = favicon.svg 路径(默认 DSH Desktop 安装目录)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_PROFILE = process.env.DSH_PROFILE ?? path.join(os.homedir(), '.dsh', 'profiles', 'web');
const req = createRequire(path.join(DSH_PROFILE, 'package.json'));
const sharp = req('sharp');

const SVG = process.env.DSH_FAVICON_SVG
  ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DSH Desktop',
      'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg');
const RES = path.resolve(process.cwd(), 'app', 'src', 'main', 'res');

// 高清源: SVG 直接栅格化 1024(黑鲸, 透明底)
const big = await sharp(SVG, { density: 512 })
  .resize(1024, 1024, { fit: 'contain', background: null })
  .png()
  .toBuffer();

const meta = await sharp(big).metadata();
console.log('source raster:', meta.width + 'x' + meta.height);

// 1) legacy mipmap(白底, 鲸鱼 80%)
const legacy = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];
for (const [dir, size] of legacy) {
  mkdirSync(path.join(RES, dir), { recursive: true });
  const w = Math.round(size * 0.8);
  const whale = await sharp(big).resize(w, w, { fit: 'contain' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: whale, gravity: 'center' }])
    .png()
    .toFile(path.join(RES, dir, 'ic_launcher.png'));
  const m = await sharp(path.join(RES, dir, 'ic_launcher.png')).metadata();
  console.log('legacy', dir, m.width + 'x' + m.height);
}

// 2) 自适应前景 432x432, 鲸鱼 66% (≈285) 居中, 透明底
mkdirSync(path.join(RES, 'mipmap-xxxhdpi'), { recursive: true });
const fgW = Math.round(432 * 0.66);
const whale = await sharp(big).resize(fgW, fgW, { fit: 'contain' }).png().toBuffer();
await sharp({ create: { width: 432, height: 432, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: whale, gravity: 'center' }])
  .png()
  .toFile(path.join(RES, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png'));
const fg = await sharp(path.join(RES, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png')).metadata();
console.log('adaptive fg', fg.width + 'x' + fg.height, 'whale=' + fgW);

// 3) anydpi-v26 自适应声明 + 背景色
mkdirSync(path.join(RES, 'mipmap-anydpi-v26'), { recursive: true });
const axml = `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
writeFileSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), axml);
writeFileSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), axml);
mkdirSync(path.join(RES, 'values'), { recursive: true });
writeFileSync(
  path.join(RES, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n`
);
console.log('adaptive xml + background color written');
console.log('done');
