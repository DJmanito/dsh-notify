package com.dsh.notify

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
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
 * - 右下角半透明按钮进设置页。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var ball: com.dsh.notify.ui.FloatingBallView

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

        webView = findViewById(R.id.webView)

        // 悬浮球接线(贴边半圆 🔧;点击 → 完整显示 + 直接打开设置页;可拖动)
        ball = findViewById(R.id.floatingBall)
        ball.onOpenSettings = { startActivity(Intent(this, SettingsActivity::class.java)) }
        // 初始位置:右侧贴边(球半圆在屏外)、屏幕 30% 高度
        ball.post {
            val p = ball.parent as android.view.ViewGroup
            ball.translationY = p.height * 0.3f
            ball.snapToRight(p)
        }

        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.userAgentString = "${s.userAgentString} DshNotify/2.0"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
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
        webView.webChromeClient = WebChromeClient()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else if (!Settings.hasServer(this)) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return
        } else {
            loadServerUrl()
        }
    }

    private fun loadServerUrl() {
        val url = Settings.baseUrl(this)
        if (url != webView.url) webView.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // 通知点击等场景:回到已保存地址
        if (Settings.hasServer(this)) loadServerUrl()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
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
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
