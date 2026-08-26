// 离线冒烟:模拟 DSH 客户端模块环境,验证 client.js 可加载、exports 完整、apply() 可执行
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

// 假 react(仅够组件定义期调用;不真正渲染)
const fakeReact = {
  createElement: (...a) => a,
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
};

// 假 ctx:记录 slots 注册
const registered = [];
const ctx = {
  slots: {
    inject: (slot, fn) => { fn() },
    register: (meta, comp) => registered.push({ meta, comp }),
  },
};

// 捕获 __ModuleLoader__.load
const loaded = {};
const window = { __ModuleLoader__: { load: (m) => { loaded[m.id] = m } } };
const factory = new Function('window', code);
factory(window);

const LOADER_ID = '@djmanito/dsh-notify'; // 宿主要求 = 完整包名
if (!loaded[LOADER_ID]) { console.error('FAIL: 模块未注册 期望id=' + LOADER_ID + ' 实际=' + Object.keys(loaded).join(',')); process.exit(1); }
const mod = loaded[LOADER_ID].factory((name) => (name === 'react' ? fakeReact : null));
console.log('exports:', Object.keys(mod).join(','));
if (typeof mod.apply !== 'function' || mod.name !== 'dsh-notify' || !Array.isArray(mod.inject)) {
  console.error('FAIL: exports 不完整'); process.exit(1);
}
mod.apply(ctx);
const sec = registered.find((r) => r.meta.id === 'dsh-notify' && r.meta.name === 'settings.section');
if (!sec) { console.error('FAIL: settings.section 未注册'); process.exit(1); }
console.log('settings.section 注册 OK: label=' + sec.meta.label() + ' order=' + sec.meta.order + ' component=' + (typeof sec.comp));
console.log('SMOKE PASS');
