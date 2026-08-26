// dsh-notify: DSH 浏览器通知推送插件(npm 包 @djmanito/dsh-notify)
//
// 功能:
//   检测:秒级轮询 agents/sessions 状态
//   GET /notify-state  → 10 字段状态端点(手机 App 轮询源;含 decisions 审批判定)
//   GET /notify-test?mode=approval|done|question|off  → 四态调试标志(仅改内存)
//   GET/POST /notify-smoke  → 注入脚本冒烟探测报告
//   GET/POST /notify-ops    → 通知操作日志(诊断撤回等问题)
//   tapIndex 注入 → DSH 桌面 GUI 标签闪烁 + 浏览器系统通知(Notification API;
//          三态语义:一直=每次新tag弹+响 / 静默=同tag更新仅首次弹 / 关=不发;
//          图标 ⏳/✅通过/❌不通过;撤回=清 sid 名下全部 tag;UA 含 DshNotify 的手机 WebView 不挂载)
//   设置 UI = 本包 client 模块(DSH 设置页「通知设置」分区,与注入脚本共享浏览器 localStorage)
//
// 检测逻辑:
//   运行中 = ctx.agents.list() 中 status === 'running';
//   待审批 = 会话事件流末尾为 approval/asked 且其后无 approval/decided;
//   待回答 = 会话存在 tool/call(name=ask_user_question, 带 callId) 且其后无
//            同 callId 的 tool/result(关联键 = tool/result.data.message.source.callId);
//   审批判定 = approval/decided.data.outcome(allowed* = 通过,其余 = 不通过)。
//
// 约束:不写文件、不碰网络(仅注册上述只读/调试路由)。
// 安装:npm 包形态,进 DSH profile 的 node_modules + dsh.profile.bundles(见包 README)。
// 回滚:从 bundles 数组移除包名 + npm rm + 重启 DSH。

// ---------- 注入脚本(tapIndex → 桌面 GUI;冒烟 + 闪烁 + 系统通知) ----------
// 注意:内容禁止出现 ` 与 ${ (模板字面量载体);禁止出现 </script> 字面量。
const INJECT_JS = `
(function () {
  if (window.__dshRemoteNotifyInjected) return
  window.__dshRemoteNotifyInjected = true

  // 手机 DSH Remote · Notify App 的 WebView(UA 含 DshNotify)不挂载:手机端有原生通知
  if (navigator.userAgent.indexOf('DshNotify') >= 0) return

  // 设置与 DSH 设置页「通知设置」(client 模块)共享浏览器 localStorage;
  // 每个 tick 重读,设置页改动 ≤1.5s 生效
  var LS_KEY = 'dshRemoteNotifySettings'
  function loadLS() {
    var s = { master: true, approval: 'always', approvalDone: 'off', taskDone: 'always', approvalCleanup: true, version: 1 }
    try {
      var raw = localStorage.getItem(LS_KEY)
      if (raw) {
        var p = JSON.parse(raw)
        if (typeof p.master === 'boolean') s.master = p.master
        if (['always', 'silent', 'off'].indexOf(p.approval) >= 0) s.approval = p.approval
        if (['always', 'off'].indexOf(p.approvalDone) >= 0) s.approvalDone = p.approvalDone
        if (['always', 'silent', 'off'].indexOf(p.taskDone) >= 0) s.taskDone = p.taskDone
        if (typeof p.approvalCleanup === 'boolean') s.approvalCleanup = p.approvalCleanup
      }
    } catch (e) {}
    return s
  }
  var settings = loadLS()
  var firstTick = true
  var lastApproval = {}, lastQuestion = {}, lastRunning = {}
  var origTitle = null
  var flashTimer = null
  var flashing = false

  function nOk() { return typeof window.Notification !== 'undefined' }
  function nGranted() { return nOk() && Notification.permission === 'granted' }
  function ensurePerm() { if (nOk() && Notification.permission === 'default') { try { Notification.requestPermission() } catch (e) {} } }

  function flash(text, keep) {
    if (origTitle === null) origTitle = document.title
    flashing = true
    document.title = text
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    if (!keep) flashTimer = setTimeout(function () { restoreTitle() }, 2500)
  }
  function restoreTitle() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    if (flashing) { if (origTitle !== null) document.title = origTitle; origTitle = null; flashing = false }
  }

  // 三态语义(用户定义):一直=每次新 tag(弹+响);静默=同 tag 更新(仅首次弹+响);关=不发
  var notifiedInstances = {}
  var tagsBySid = {}
  function reportOp(kind, extra) {
    var op = { kind: kind, ts: Date.now() }
    for (var k in (extra || {})) op[k] = extra[k]
    fetch('/notify-ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }).catch(function () {})
  }
  function pushTag(sid, kind, tag) {
    if (!tagsBySid[sid]) tagsBySid[sid] = {}
    var arr = tagsBySid[sid][kind] || (tagsBySid[sid][kind] = [])
    arr.push(tag)
    if (arr.length > 5) arr.shift()
  }
  function notify(title, body, tag) {
    if (!nGranted()) { reportOp('post-skip', { reason: 'not-granted', tag: tag }); return null }
    try {
      var n = new Notification(title, { body: body, tag: tag })
      n.onclick = function () { window.focus(); try { n.close() } catch (e) {} }
      notifiedInstances[tag] = n
      reportOp('post', { title: title, tag: tag })
      return n
    } catch (e) {
      reportOp('post-fail', { err: String(e).slice(0, 80), tag: tag })
      return null
    }
  }
  function cancelTag(tag) { if (nOk()) { try { Notification.cancel(tag) } catch (e) {} } }
  function withdrawSid(sid, kind) {
    var arr = tagsBySid[sid] && tagsBySid[sid][kind]
    if (!arr || !arr.length) { reportOp('cancel-miss', { sid: sid, kind: kind }); return }
    arr.forEach(function (t) {
      var inst = notifiedInstances[t]
      if (inst) { try { inst.close() } catch (e) {} delete notifiedInstances[t] }
      cancelTag(t)
      reportOp('cancel', { sid: sid, kind: kind, tag: t })
    })
    tagsBySid[sid][kind] = []
  }

  function onApprovalNew(sid, title) {
    if (!settings || !settings.master || settings.approval === 'off') return
    var t = settings.approval === 'silent' ? 'appr-' + sid : 'appr-' + sid + '-' + Date.now()
    notify('⏳ DSH 会话等待审批', title || '有会话等待审批', t)
    pushTag(sid, 'appr', t)
  }
  function onQuestionNew(sid, title) {
    if (!settings || !settings.master || settings.approval === 'off') return
    var t = settings.approval === 'silent' ? 'q-' + sid : 'q-' + sid + '-' + Date.now()
    notify('⏳ DSH 会话等待回答', title || '有会话等待回答', t)
    pushTag(sid, 'q', t)
  }
  function onApprovalResolved(sid, decision) {
    if (!settings) return
    if (settings.approvalCleanup) withdrawSid(sid, 'appr')
    if (settings.approvalDone === 'always') {
      var denied = decision === 'denied'
      notify(denied ? '❌ 审批未通过' : '✅ 审批已通过', denied ? '审批被拒绝' : '审批已允许', 'doneappr-' + sid + '-' + Date.now())
    }
  }
  function onQuestionResolved(sid) {
    if (!settings) return
    if (settings.approvalCleanup) withdrawSid(sid, 'q')
    if (settings.approvalDone === 'always') notify('✅ 已收到回答', '回答已回传', 'doneq-' + sid + '-' + Date.now())
  }
  function onSessionDone(sid, title) {
    if (!settings || !settings.master || settings.taskDone === 'off') return
    var t = settings.taskDone === 'silent' ? 'done-' + sid : 'done-' + sid + '-' + Date.now()
    notify('✅ DSH 会话已完成', title || '会话已完成', t)
  }

  function tick() {
    // 设置页改动 ≤1.5s 生效(localStorage 共享)
    var cur = loadLS()
    if (JSON.stringify(cur) !== JSON.stringify(settings)) settings = cur
    ensurePerm()
    fetch('/notify-state').then(function (r) { return r.ok ? r.json() : null }).then(function (s) {
      if (!s) return
      var a = {}, q = {}, rn = {}
      ;(s.approvalSessionIds || []).forEach(function (x) { a[x] = 1 })
      ;(s.questionSessionIds || []).forEach(function (x) { q[x] = 1 })
      ;(s.runningSessionIds || []).forEach(function (x) { rn[x] = 1 })
      if (!firstTick) {
        var dec = s.decisions || {}
        Object.keys(lastApproval).forEach(function (sid) { if (!a[sid]) onApprovalResolved(sid, dec[sid]) })
        Object.keys(lastQuestion).forEach(function (sid) { if (!q[sid]) onQuestionResolved(sid) })
        Object.keys(lastRunning).forEach(function (sid) {
          if (!rn[sid]) {
            onSessionDone(sid, s.runningTitle)
            if (!flashing) flash('✅ 任务完成', false)
          }
        })
      }
      Object.keys(a).forEach(function (sid) { if (!lastApproval[sid]) onApprovalNew(sid, s.approvalTitle) })
      Object.keys(q).forEach(function (sid) { if (!lastQuestion[sid]) onQuestionNew(sid, s.questionTitle) })
      firstTick = false
      lastApproval = a; lastQuestion = q; lastRunning = rn
      var na = Object.keys(a).length, nq = Object.keys(q).length
      if (na || nq) {
        var t = na ? '⏳ 等待审批' : ''
        if (nq) t = t ? t + ' / 等待回答' : '⏳ 等待回答'
        var ttl = (na ? s.approvalTitle : s.questionTitle) || ''
        flash(t + (ttl ? ' · ' + ttl.slice(0, 24) : ''), true)
      } else if (flashing) { restoreTitle() }
    }).catch(function () {})
  }

  // 冒烟探测:上报 Notification 可用性
  setTimeout(function () {
    var rep = {
      notif: typeof window.Notification,
      perm: nOk() ? Notification.permission : 'n/a',
      secure: window.isSecureContext,
      href: location.href.slice(0, 80),
      ts: Date.now()
    }
    fetch('/notify-smoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rep) }).catch(function () {})
  }, 1500)

  setTimeout(tick, 2000)
  setInterval(tick, 1500)
})()
`

export default {
  name: 'dsh-notify',
  inject: ['webServer', 'timer', 'agents', 'sessions', 'sessionQuery'],

  apply(ctx) {
    let runningSessionIds = []
    let runningSid = ''
    let runningTitle = ''
    let pendingApprovalIds = []
    let approvalSid = ''
    let approvalTitle = ''
    let questionSessionIds = []
    let questionSid = ''
    let questionTitle = ''
    let testMode = 0 // 0=off, 1=approval, 2=done, 3=question(仅 /notify-test 可改,内存态)
    const approvalDecisions = {} // sid -> 'approved'|'denied'(approval/decided.data.outcome: allowed* = 通过)

    const readTitle = (sid) =>
      ctx.sessionQuery.readTitle(sid)
        .then((t) => (t && typeof t.title === 'string' && t.title.length ? t.title : ''))
        .catch(() => '')

    const poll = () => {
      // 1) 运行中 agent 集合(子代理会话不计入"运行中" → 其完成不触发通知;
      //    子代理的审批/问答检测不受影响,仍照常通知——那是真正中断进度的事件)
      const subagentIds = new Set()
      try {
        for (const session of ctx.sessions.list()) {
          const h = session.header
          if (h && (h.origin === 'subagent' || (typeof h.delegationDepth === 'number' && h.delegationDepth > 0) || h.parentSession)) {
            subagentIds.add(session.id)
            if (!String(session.id).startsWith('session-')) subagentIds.add('session-' + session.id)
          }
        }
      } catch (e) {}
      const running = []
      try {
        for (const agent of ctx.agents.list()) {
          if (agent.status === 'running' && !subagentIds.has(agent.id)) running.push(agent.id)
        }
      } catch (e) {}
      runningSessionIds = running
      const rsid = running[0] ?? ''
      if (rsid && rsid !== runningSid) {
        runningSid = rsid
        void readTitle(rsid).then((t) => { if (t) runningTitle = t })
      }

      // 2) 待审批会话集合(末尾 approval/asked 且其后无 approval/decided)
      const approvals = []
      try {
        for (const session of ctx.sessions.list()) {
          const evs = session.events
          for (let i = evs.length - 1; i >= 0; i--) {
            const t = evs[i].type
            if (t === 'approval/asked') { approvals.push(session.id); break }
            if (t === 'approval/decided') {
              const out = evs[i].data && typeof evs[i].data.outcome === 'string' ? evs[i].data.outcome : ''
              approvalDecisions[session.id] = out.startsWith('allowed') ? 'approved' : 'denied'
              break
            }
          }
        }
      } catch (e) {}
      const dk = Object.keys(approvalDecisions)
      if (dk.length > 100) dk.slice(0, 50).forEach((k) => delete approvalDecisions[k])
      pendingApprovalIds = approvals
      const asid = approvals[0] ?? ''
      if (asid && asid !== approvalSid) {
        approvalSid = asid
        void readTitle(asid).then((t) => { if (t) approvalTitle = t })
      }

      // 3) 待回答会话集合(tool/call ask_user_question 无同 callId 的 tool/result)
      const questions = []
      try {
        for (const session of ctx.sessions.list()) {
          const evs = session.events
          let pending = false
          for (let i = 0; i < evs.length; i++) {
            const d = evs[i].type === 'tool/call' ? evs[i].data : null
            if (!d || d.name !== 'ask_user_question' || !d.callId) continue
            const cid = d.callId
            let resolved = false
            for (let j = i + 1; j < evs.length; j++) {
              const rd = evs[j].type === 'tool/result' ? evs[j].data : null
              if (rd && rd.message && rd.message.source && rd.message.source.callId === cid) { resolved = true; break }
            }
            if (!resolved) { pending = true; break }
          }
          if (pending) questions.push(session.id)
        }
      } catch (e) {}
      questionSessionIds = questions
      const qsid = questions[0] ?? ''
      if (qsid && qsid !== questionSid) {
        questionSid = qsid
        void readTitle(qsid).then((t) => { if (t) questionTitle = t })
      }
    }

    ctx.interval(poll, 1000)
    poll()

    // 4) 只读状态端点(手机端轮询源)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-state',
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        const running = runningSessionIds.length > 0 || testMode === 2
        const pendingApproval = pendingApprovalIds.length > 0 || testMode === 1
        const pendingQuestion = questionSessionIds.length > 0 || testMode === 3
        res.end(JSON.stringify({
          running,
          pendingApproval,
          runningTitle: testMode === 2 && !runningTitle ? '(测试)任务完成' : runningTitle,
          approvalTitle: testMode === 1 && !approvalTitle ? '(测试)等待审批' : approvalTitle,
          runningSessionIds: testMode === 2 ? [...runningSessionIds, 'test-done'] : runningSessionIds,
          approvalSessionIds: testMode === 1 ? [...pendingApprovalIds, 'test-approval'] : pendingApprovalIds,
          questionSessionIds: testMode === 3 ? [...questionSessionIds, 'test-question'] : questionSessionIds,
          questionTitle: testMode === 3 && !questionTitle ? '(测试)等待回答' : questionTitle,
          pendingQuestion,
          decisions: testMode === 1 ? { ...approvalDecisions, 'test-approval': 'approved' } : approvalDecisions,
        }))
      },
    }))

    // 5) 四态调试端点(仅改内存标志,off 复原)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-test',
      handler: (req, res) => {
        const qi = (req.url || '/').indexOf('?')
        const q = qi >= 0 ? new URLSearchParams((req.url || '/').slice(qi + 1)) : new URLSearchParams()
        const mode = q.get('mode') || 'off'
        testMode = mode === 'approval' ? 1 : mode === 'done' ? 2 : mode === 'question' ? 3 : 0
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('ok: ' + mode + ' (testMode=' + testMode + ')')
      },
    }))

    // 6) 通知操作日志(注入脚本上报;内存环形 50 条)
    const opsLog = []
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-ops',
      handler: (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy() })
          req.on('end', () => {
            try {
              const j = JSON.parse(body || '{}')
              j.at = new Date().toISOString()
              opsLog.push(j)
              if (opsLog.length > 50) opsLog.shift()
            } catch { /* 忽略坏帧 */ }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, ops: opsLog }))
      },
    }))

    // 7) 注入脚本冒烟报告
    let smokeReport = null
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/notify-smoke',
      handler: (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy() })
          req.on('end', () => {
            try { smokeReport = { ...(JSON.parse(body || '{}')), at: new Date().toISOString() } } catch { /* 忽略坏帧 */ }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(smokeReport ?? { ok: true, note: '尚无冒烟报告(页面未加载过?)' }))
      },
    }))

    // 8) tapIndex 注入(幂等)
    ctx.effect(() => ctx.webServer.tapIndex((html) => {
      if (html.indexOf('dsh-notify-inject') >= 0) return html
      const tag = '<script id="dsh-notify-inject">' + INJECT_JS + '</' + 'script>'
      return html.indexOf('</head>') >= 0 ? html.replace('</head>', tag + '\n</head>') : html + tag
    }))
  },
}
