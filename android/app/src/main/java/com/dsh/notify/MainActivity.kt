package com.dsh.notify

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import kotlin.concurrent.thread
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

/**
 * 主界面:WebView 直连 DSH web 局域网入口,与手机浏览器同屏。
 * - JS/DOM storage/cookie 启用;cleartext 由 manifest usesCleartextTraffic 放开(仅可信内网);
 * - 物理返回键 = WebView 历史回退;
 * - 配置变更/进程恢复:WebView saveState/restoreState + 上次地址持久化;
 * - 后台超时回收(U1):退后台超过设置时长(默认 15 分钟,0=不回收)→ 销毁内置 WebView 释放资源,
 *   通知服务(前台轮询)不受影响;再打开时重建并重新加载。回收两条路:onStop 安排 Handler 延迟销毁,
 *   onStart 回前台时按后台时间差一次性兜底判定(定时器被系统冻结未触发时)并随后无条件清零 bgStartAt;
 *   onResume 的 ensureWebView 只做「WebView 已回收则重建」(不做时间差判定);未超时返回不动(不重载,不能闪);
 * - 右下角半透明按钮进设置页。
 */
class MainActivity : AppCompatActivity() {

    private var webView: WebView? = null
    private lateinit var ball: com.dsh.notify.ui.FloatingBallView

    // 后台回收:主线程 Handler 延迟任务 + 后台开始时间(elapsedRealtime 单调时钟,不受校时影响)
    private val bgHandler = Handler(Looper.getMainLooper())
    private val bgReclaimTask = Runnable {
        // 延迟到期且仍在后台(onStart/onResume 会取消任务)且 WebView 尚存 → 销毁
        if (!isFinishing && !isDestroyed && webView != null) destroyWebView()
    }
    private var bgStartAt: Long = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // 安全区:浏览器显示区域 = 屏幕 - 状态栏 - 导航栏/品牌 bar(Android 15+ 强制 edge-to-edge,
        // 只能用 insets padding 排除;品牌特殊 bar 属 navigationBars insets,天然覆盖)
        val webContainer = findViewById<android.view.View>(R.id.webContainer)
        ViewCompat.setOnApplyWindowInsetsListener(webContainer) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            insets
        }
        // 状态栏/导航栏条带 = 白底 + 深色图标(保证时间/状态图标清晰可读)
        WindowCompat.getInsetsController(window, webContainer)?.let {
            it.isAppearanceLightStatusBars = true
            it.isAppearanceLightNavigationBars = true
        }

        // 首次 = 布局里的静态 WebView;后台被回收后由 ensureWebView 重建
        val w0 = findViewById<WebView>(R.id.webView)
        configureWebView(w0)
        webView = w0

        // 悬浮球接线(贴边半圆 🔧;点击 → 完整显示 + 直接打开设置页;可拖动)
        ball = findViewById(R.id.floatingBall)
        ball.onOpenSettings = { startActivity(Intent(this, SettingsActivity::class.java)) }
        // 初始位置:右侧贴边(球半圆在屏外)、屏幕 30% 高度
        ball.post {
            val p = ball.parent as android.view.ViewGroup
            ball.translationY = p.height * 0.3f
            ball.snapToRight(p)
        }

        if (savedInstanceState != null) {
            webView?.restoreState(savedInstanceState)
        } else if (!Settings.hasServer(this)) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return
        } else {
            loadServerUrl()
        }
    }

    /** WebView 公共配置:JS/DOM storage/cookie + http(s) 一律留在本 WebView。首建与回收后重建共用。 */
    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(w: WebView) {
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.userAgentString = "${s.userAgentString} DshNotify/2.0"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)

        w.webViewClient = object : WebViewClient() {
            // http(s) 一律留在本 WebView(目标即 DSH 局域网入口)
            override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                val u = request?.url?.toString() ?: return true
                return when {
                    u.startsWith("http://") || u.startsWith("https://") -> {
                        view?.loadUrl(u)
                        true
                    }
                    else -> false // 其它 scheme 交给系统
                }
            }
        }
        w.webChromeClient = WebChromeClient()
    }

    private fun loadServerUrl() {
        val w = webView ?: return
        val url = Settings.baseUrl(this)
        if (url != w.url) w.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // 通知点击等场景:回到已保存地址
        if (Settings.hasServer(this)) loadServerUrl()
    }

    override fun onBackPressed() {
        val w = webView
        if (w != null && w.canGoBack()) w.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onStart() {
        super.onStart()
        // 回到前台:撤销后台回收任务,并按后台停留时间差一次性兜底判定
        // (Handler 被系统冻结未触发时),超时先销毁;随后无条件清零 bgStartAt,
        // 避免旧时间戳在后续 onResume/ensureWebView 被重复判定造成误重载
        cancelBgReclaim()
        if (bgStartAt != 0L) {
            if (isBgTimedOut(SystemClock.elapsedRealtime(), bgStartAt, Settings.webviewBgTimeoutMinutes(this))) {
                destroyWebView()
            }
            bgStartAt = 0L
        }
    }

    override fun onResume() {
        super.onResume()
        // 回到前台:取消后台回收延迟任务;WebView 已被回收(延迟任务或 onStart 判定销毁)→ 重建并加载;
        // 未被回收则不动(不重载,不能闪)
        cancelBgReclaim()
        if (Settings.hasServer(this)) ensureWebView()
        webView?.onResume()
        // 自恢复:已配置服务器且服务不存活 → 从 RESUMED 状态(强 FGS 启动上下文)重拉。
        // 监控服务常跑(总开关只控制是否发通知,打开即生效);冷启动 onCreate 发起 FGS
        // 是 OEM 系统容易拦截的时机,故放 onResume。
        if (Settings.hasServer(this) && !com.dsh.notify.notify.NotifyService.isRunning) {
            com.dsh.notify.notify.NotifyService.startAndSchedule(this, "main-resume")
        }
        // 从设置页返回:悬浮球恢复贴边半圆状态
        ball.post {
            val p = ball.parent as android.view.ViewGroup
            if (ball.translationX >= 0) ball.snapToRight(p) else ball.snapToLeft(p)
        }
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        // 后台回收(U1):记录后台开始时间,安排延迟任务(时长=设置阈值)在后台销毁 WebView 释放资源;
        // 通知服务在前台服务内独立轮询,页面销毁不影响通知。阈值 0 = 不回收。
        val minutes = Settings.webviewBgTimeoutMinutes(this)
        if (minutes <= 0) {
            bgStartAt = 0L
            return
        }
        bgStartAt = SystemClock.elapsedRealtime()
        scheduleBgReclaim(minutes.toLong() * 60_000L)
    }

    override fun onDestroy() {
        cancelBgReclaim()
        webView?.destroy()
        super.onDestroy()
    }

    // ---------- 后台超时回收 WebView(U1) ----------

    /** 销毁内置 WebView:从父容器移除 + destroy + 字段置 null(通知服务不动)。 */
    private fun destroyWebView() {
        val w = webView ?: return
        (w.parent as? android.view.ViewGroup)?.removeView(w)
        w.destroy()
        webView = null
    }

    /** 前台重建:WebView 为 null(已被 onStop 延迟任务或 onStart 兜底判定回收)→ 重建并 load Settings.baseUrl。
     *  不做时间差判定(超时判定已移到 onStart 一次性处理)。 */
    private fun ensureWebView() {
        if (webView != null) return
        val w = WebView(this)
        configureWebView(w)
        // 插到容器最底层(索引 0):FrameLayout 后加者在上方,若追加末尾会盖住悬浮球/设置入口
        findViewById<android.view.ViewGroup>(R.id.webContainer).addView(
            w, 0, android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT))
        webView = w
        w.loadUrl(Settings.baseUrl(this))
    }

    private fun scheduleBgReclaim(delayMs: Long) {
        bgHandler.removeCallbacks(bgReclaimTask)
        bgHandler.postDelayed(bgReclaimTask, delayMs)
    }

    private fun cancelBgReclaim() {
        bgHandler.removeCallbacks(bgReclaimTask)
    }

    companion object {
        /** 后台超时判定(纯函数,供 onStart 兜底与单测):
         * minutes<=0 或 bgStartAt<=0 或 now<bgStartAt → false;否则 now-bgStartAt >= minutes*60000L。 */
        fun isBgTimedOut(nowMillis: Long, bgStartAtMillis: Long, minutes: Int): Boolean {
            if (minutes <= 0 || bgStartAtMillis <= 0L || nowMillis < bgStartAtMillis) return false
            return nowMillis - bgStartAtMillis >= minutes * 60_000L
        }
    }
}
