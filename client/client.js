window.__ModuleLoader__.load({
  id: "@djmanito/dsh-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
// dsh-notify 客户端:DSH 设置页「通知设置」分区
// 与页面注入脚本(浏览器通知)共享 localStorage[dshRemoteNotifySettings]。
// 纯 createElement 写法,零依赖构建为 client.js。
const { createElement, useEffect, useState } = require("react");
const h = createElement;

const name = 'dsh-notify';
const inject = ['slots'];

const LS_KEY = 'dshRemoteNotifySettings';
const DEFAULTS = { master: true, approval: 'always', approvalDone: 'off', taskDone: 'always', approvalCleanup: true, sessionBlacklist: [], version: 1 };

// 会话ID黑名单:只收非空字符串,trim 后去重(保持输入顺序)
function dedupeIds(list) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function loadLS() {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.master === 'boolean') s.master = p.master;
      if (['always', 'silent', 'off'].includes(p.approval)) s.approval = p.approval;
      if (['always', 'off'].includes(p.approvalDone)) s.approvalDone = p.approvalDone;
      if (['always', 'silent', 'off'].includes(p.taskDone)) s.taskDone = p.taskDone;
      if (typeof p.approvalCleanup === 'boolean') s.approvalCleanup = p.approvalCleanup;
      if (Array.isArray(p.sessionBlacklist)) s.sessionBlacklist = dedupeIds(p.sessionBlacklist);
    }
  } catch (e) { /* 损坏 → 默认值 */ }
  return s;
}

// 官方 DSH 设计令牌:正文 13px / 4px 栅格 / 胶囊按钮
const muted = { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 };
const card = { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 520 };

function Toggle({ on, onChange }) {
  return h('div', {
    role: 'switch',
    'aria-checked': on,
    onClick: onChange,
    style: { width: 40, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative', flex: 'none', transition: 'background .15s', background: on ? 'var(--dsw-alias-brand-primary,#4f6ef7)' : '#d1d5db' },
  }, h('div', {
    style: { position: 'absolute', top: 2, left: on ? 18 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.2)' },
  }));
}

function ModeBtns({ modes, current, onPick }) {
  return h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' } },
    modes.map((m) => h('button', {
      key: m.val,
      onClick: () => onPick(m.val),
      style: {
        font: 'inherit', fontSize: 12, height: 28, padding: '0 12px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
        border: '1px solid ' + (current === m.val ? 'var(--dsw-alias-brand-primary,#4f6ef7)' : 'var(--dsw-alias-border-l2,#d1d5db)'),
        background: current === m.val ? 'rgba(79,110,247,.12)' : 'var(--dsw-alias-bg-layer-1,#fff)',
        color: current === m.val ? 'var(--dsw-alias-brand-primary,#4f6ef7)' : 'inherit',
      },
    }, m.label)));
}

function Row({ label, hint, control }) {
  return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)' } },
    h('div', null,
      h('div', { style: { fontSize: 13 } }, label),
      hint ? h('div', { style: muted }, hint) : null),
    h('div', { style: { flex: 'none' } }, control));
}

// 黑名单输入框切分:整段按半/全角逗号切分,逐段 trim,丢弃空段(口径同安卓 splitBlacklistTokens)
function splitBlacklistTokens(raw) {
  return raw.split(/[,，]/).map((t) => t.trim()).filter((t) => t !== '');
}

// 会话ID黑名单标签输入:回车整段提交;出现逗号(半/全角)时整段切分逐段提交(空段/重复跳过),点 × 删除,去重
function TagInput({ value, onChange }) {
  const [text, setText] = useState('');
  const commit = () => {
    const t = text.trim();
    setText('');
    if (t === '' || value.includes(t)) return;
    onChange([...value, t]);
  };
  // 输入内容出现逗号:整段按 [,，] 切分,逐段 trim 后依次提交(空段/重复跳过),再清空输入框
  const commitMany = (raw) => {
    setText('');
    const merged = [...value];
    for (const t of splitBlacklistTokens(raw)) {
      if (!merged.includes(t)) merged.push(t);
    }
    if (merged.length !== value.length) onChange(merged);
  };
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, padding: '6px 8px' } },
    value.map((id) => h('span', {
      key: id,
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontFamily: 'ui-monospace,Menlo,monospace', background: 'rgba(79,110,247,.12)', color: 'var(--dsw-alias-brand-primary,#4f6ef7)', borderRadius: 999, padding: '2px 4px 2px 10px' },
    }, id, h('button', {
      type: 'button',
      'aria-label': '删除 ' + id,
      onClick: () => onChange(value.filter((x) => x !== id)),
      style: { font: 'inherit', fontSize: 12, lineHeight: 1, width: 16, height: 16, padding: 0, borderRadius: '50%', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' },
    }, '×'))),
    h('input', {
      value: text,
      placeholder: '粘贴完整会话ID(含 session- 前缀),回车或逗号提交;短ID不会命中',
      spellCheck: false,
      onKeyDown: (e) => {
        if (e.nativeEvent.isComposing) return; // 输入法合成中不提交
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); commit(); }
      },
      onChange: (e) => {
        const v = e.target.value;
        if (/[,，]/.test(v)) commitMany(v); // 粘贴/输入含逗号(半/全角)→ 整段切分逐段提交
        else setText(v);
      },
      onBlur: () => { if (text.trim() !== '') commit(); },
      style: { flex: '1 1 140px', minWidth: 120, border: 'none', outline: 'none', font: 'inherit', fontSize: 13, background: 'transparent', padding: '2px 0' },
    }));
}

function BlacklistRow({ value, onChange }) {
  return h('div', { style: { padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)' } },
    h('div', null,
      h('div', { style: { fontSize: 13 } }, '会话ID黑名单'),
      h('div', { style: muted }, '黑名单内的会话完成时不发通知,其余会话正常发送;回车或逗号提交,点 × 删除。会话 ID 可从侧边栏会话行的 ⋯ 菜单「复制会话 ID」取得，请粘贴完整 ID（含 session- 前缀），短 ID 不会命中')),
    h('div', { style: { marginTop: 8 } }, h(TagInput, { value, onChange })));
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
  document.body.removeChild(ta);
}

function Guide() {
  const [copied, setCopied] = useState(false);
  const flagsUrl = 'chrome://flags/#unsafely-treat-insecure-origin-as-secure';
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(flagsUrl).then(done, () => fallbackCopy(flagsUrl, done));
    else fallbackCopy(flagsUrl, done);
  };
  return h('div', { style: { marginTop: 16, padding: '12px 16px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2,#f7f8fa)' } },
    h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '📖 通知设置指导'),
    h('div', { style: { ...muted, marginBottom: 6 } }, '1) 用 localhost 打开 DSH,Windows 系统通知直接可用,无需任何设置。'),
    h('div', { style: { ...muted, marginBottom: 6 } }, '2) 局域网 IP 入口(当前 ' + window.location.origin + '):Chrome/Edge 地址栏访问(点击复制):'),
    h('div', {
      onClick: copy,
      title: '点击复制',
      style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, padding: '6px 10px', margin: '6px 0', cursor: 'pointer', wordBreak: 'break-all', color: 'var(--dsw-alias-brand-primary,#4f6ef7)' },
    }, copied ? '✅ 已复制,请粘贴到地址栏打开' : flagsUrl),
    h('div', { style: { ...muted, marginBottom: 6 } }, '   在输入框中加入当前网址,选 Enabled,然后重启浏览器。'),
    h('div', { style: { ...muted, color: 'var(--dsw-alias-label-tertiary,#8b93a1)' } }, 'Firefox、Safari 等浏览器暂无临时办法(仅 HTTPS 或 localhost);未解锁时系统通知不可用(浏览器安全限制)。'),
  );
}

function RemoteNotifySettings() {
  const [s, setS] = useState(loadLS());
  // 双向同步:页面注入脚本只读 LS;多标签页之间 2s 对齐
  useEffect(() => {
    const t = setInterval(() => setS(loadLS()), 2000);
    return () => clearInterval(t);
  }, []);
  const patch = (p) => {
    const next = { ...loadLS(), ...p };
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
    setS(next);
  };

  const M3 = [
    { val: 'always', label: '一直通知' },
    { val: 'silent', label: '静默通知' },
    { val: 'off', label: '关闭通知' },
  ];
  const M2 = [
    { val: 'always', label: '一直通知' },
    { val: 'off', label: '关闭通知' },
  ];

  return h('div', { style: card },
    h('div', { style: { fontWeight: 600, fontSize: 13 } }, '通知'),
    h('div', { style: muted }, '浏览器系统通知(⏳ 等待 / ✅ 通过 / ❌ 不通过);手机APP不使用此设置。'),
    h(Row, { key: 'master', label: '总开关', hint: '关闭后不闪烁、不发任何系统通知', control: h(Toggle, { on: s.master, onChange: () => patch({ master: !s.master }) }) }),
    h(Row, { key: 'approval', label: '审批/问答 触发通知', hint: '一直通知=每次都弹新通知;静默通知=更新已有通知(仅首次弹+响)', control: h(ModeBtns, { modes: M3, current: s.approval, onPick: (v) => patch({ approval: v }) }) }),
    h(Row, { key: 'cleanup', label: '完成审批撤回消息通知', hint: '当审批通过后,撤回之前的等待审批/问答的通知', control: h(Toggle, { on: s.approvalCleanup, onChange: () => patch({ approvalCleanup: !s.approvalCleanup }) }) }),
    h(Row, { key: 'done', label: '审批/问答 完成通知', hint: '审批/问答结束后,是否发"✅ 通过 / ❌ 不通过"通知', control: h(ModeBtns, { modes: M2, current: s.approvalDone, onPick: (v) => patch({ approvalDone: v }) }) }),
    h(Row, { key: 'task', label: '任务完成 触发通知', hint: '主代理及其全部子代理都结束后才通知;语义同"审批/问答 触发通知"', control: h(ModeBtns, { modes: M3, current: s.taskDone, onPick: (v) => patch({ taskDone: v }) }) }),
    h(BlacklistRow, { key: 'blacklist', value: s.sessionBlacklist, onChange: (list) => patch({ sessionBlacklist: list }) }),
    h('div', { style: { marginTop: 12, fontSize: 12, color: 'var(--dsw-alias-state-warn-primary,#b45309)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
      '警告:请勿将 DSH 暴露到广域网,外网请使用 WireGuard 等方式连接!'),
    h('div', { style: { marginTop: 8, fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#8b93a1)' } }, '设置保存在本地(本浏览器 localStorage);不同设备设置独立,不同步。'),
    h(Guide, { key: 'guide' }),
  );
}

function apply(ctx) {
  // DSH 设置页一级分区
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-notify',
        order: 2,
        label: () => '通知设置',
      },
      RemoteNotifySettings,
    ),
  );
}



module.exports = { apply, name, inject };

    return module.exports;
  }
});
