package com.dsh.notify

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.dsh.notify.notify.LogBus
import com.dsh.notify.notify.NotifyService
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * 设置页:返回+标题 / 连接设置卡(测试并保存) / 通知卡(总开关+三态行+撤回开关,本地保存) /
 * 系统通知与后台设置跳转 / 日志独立页 / 轮询间隔 / 版本页脚。
 */
class SettingsActivity : AppCompatActivity() {

    companion object { private const val REQ_POST_NOTIFICATIONS = 2001 }

    private lateinit var etHost: EditText
    private lateinit var etPort: EditText
    private lateinit var etInterval: EditText
    private lateinit var swMaster: Switch
    private lateinit var tvTestResult: TextView
    private lateinit var tvIntervalResult: TextView
    private lateinit var tvSettingsState: TextView
    private lateinit var modeRows: LinearLayout

    private var serverSettings: SettingsSync.ServerSettings? = null
    private var programmaticSwitch = false
    private var pendingMasterOn = false

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val root = findViewById<View>(R.id.settingsRoot)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            insets
        }

        etHost = findViewById(R.id.etHost)
        etPort = findViewById(R.id.etPort)
        etInterval = findViewById(R.id.etInterval)
        swMaster = findViewById(R.id.swMaster)
        tvTestResult = findViewById(R.id.tvTestResult)
        tvIntervalResult = findViewById(R.id.tvIntervalResult)
        tvSettingsState = findViewById(R.id.tvSettingsState)
        modeRows = findViewById(R.id.modeRows)
        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }

        etHost.setText(Settings.host(this))
        etPort.setText(Settings.port(this).toString())

        findViewById<Button>(R.id.btnTestSave).setOnClickListener { testAndSave() }
        findViewById<Button>(R.id.btnSaveInterval).setOnClickListener { saveInterval() }
        findViewById<Button>(R.id.btnLog).setOnClickListener {
            startActivity(Intent(this, LogActivity::class.java))
        }
        findViewById<Button>(R.id.btnSysNotif).setOnClickListener { openSysNotif() }
        findViewById<Button>(R.id.btnSysBg).setOnClickListener { openSysBg() }

        swMaster.setOnCheckedChangeListener { _, on ->
            if (programmaticSwitch) return@setOnCheckedChangeListener
            if (on) requestMasterOn() else applyMaster(false)
        }

        tvFooter()
        loadServerSettings()
    }

    // ---------- 总开关(含 Android 13+ 运行时权限) ----------

    private fun requestMasterOn() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingMasterOn = true
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_POST_NOTIFICATIONS)
            return
        }
        applyMaster(true)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_POST_NOTIFICATIONS && pendingMasterOn) {
            pendingMasterOn = false
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                applyMaster(true)
            } else {
                programmaticSwitch = true
                swMaster.isChecked = false
                programmaticSwitch = false
                tvSettingsState.visibility = View.VISIBLE
                tvSettingsState.text = getString(R.string.notify_denied_hint)
                openSysNotif()
            }
        }
    }

    private fun applyMaster(on: Boolean) {
        val st = serverSettings ?: SettingsSync.cached(this).also {
            serverSettings = it
            renderModeRows()
        }
        programmaticSwitch = true
        swMaster.isChecked = on
        programmaticSwitch = false
        postPatch(mapOf("master" to on))
        if (on && !NotifyService.isRunning && Settings.hasServer(this)) {
            NotifyService.startAndSchedule(this, "settings-master")
        }
        LogBus.ok("MASTER 设置页切换 -> $on")
    }

    // ---------- 连接设置 ----------

    private fun testAndSave() {
        val h = etHost.text.toString().trim()
        val p = etPort.text.toString().trim().toIntOrNull()
        if (!Settings.validateHost(h) || p == null || !Settings.validatePort(p)) {
            showTestResult(false)
            return
        }
        tvTestResult.setTextColor(Color.parseColor("#888888"))
        tvTestResult.text = "测试中…"
        thread {
            val rootOk = probe("http://$h:$p/")
            val stateOk = if (rootOk) probe("http://$h:$p/notify-state") else false
            runOnUiThread {
                if (rootOk && stateOk) {
                    Settings.setHost(this, h)
                    Settings.setPort(this, p)
                    Settings.setNotifyEnabled(this, true)
                    if (!NotifyService.isRunning) NotifyService.startAndSchedule(this, "settings-save")
                    showTestResult(true)
                } else {
                    showTestResult(false)
                }
            }
        }
    }

    private fun showTestResult(ok: Boolean) {
        if (ok) {
            tvTestResult.setTextColor(Color.parseColor("#1B7F3B"))
            tvTestResult.text = "成功，已保存"
        } else {
            tvTestResult.setTextColor(Color.parseColor("#B03030"))
            tvTestResult.text = getString(R.string.test_fail_fmt)
        }
    }

    private fun probe(url: String): Boolean {
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.requestMethod = "GET"
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            false
        }
    }

    // ---------- 通知设置(服务端单一真源) ----------

    private fun loadServerSettings() {
        tvSettingsState.visibility = View.VISIBLE
        tvSettingsState.text = "通知设置加载中…"
        thread {
            val st = SettingsSync.fetch(this)
            runOnUiThread {
                serverSettings = st
                programmaticSwitch = true
                swMaster.isChecked = st.master
                programmaticSwitch = false
                tvSettingsState.visibility = View.GONE
                renderModeRows()
            }
        }
    }

    private fun postPatch(patch: Map<String, Any>) {
        tvSettingsState.visibility = View.VISIBLE
        tvSettingsState.text = "保存中…"
        thread {
            val st = SettingsSync.post(this, patch)
            runOnUiThread {
                if (st != null) {
                    serverSettings = st
                    tvSettingsState.visibility = View.GONE
                    renderModeRows()
                    LogBus.ok("SET 已同步服务端: $patch")
                } else {
                    tvSettingsState.visibility = View.VISIBLE
                    tvSettingsState.text = "⚠ 服务端不可达,修改未保存(已用本地缓存显示)"
                    LogBus.error("SET POST 失败(服务端不可达): $patch")
                }
            }
        }
    }

    private fun renderModeRows() {
        val st = serverSettings ?: return
        modeRows.removeAllViews()
        modeRows.addView(modeRow(getString(R.string.row_wait), listOf(
            Pair("always", getString(R.string.mode_always)),
            Pair("silent", getString(R.string.mode_silent)),
            Pair("off", getString(R.string.mode_off)),
        ), st.approval, "一直通知=每次都弹新通知;静默通知=更新已有通知(仅首次弹+响)") { v -> postPatch(mapOf("approval" to v)) })
        modeRows.addView(switchRow(getString(R.string.row_cleanup), st.approvalCleanup, "(当审批通过后,撤回之前的等待审批/问答的通知)") { v -> postPatch(mapOf("approvalCleanup" to v)) })
        modeRows.addView(modeRow(getString(R.string.row_done_state), listOf(
            Pair("always", getString(R.string.mode_always)),
            Pair("off", getString(R.string.mode_off)),
        ), st.approvalDone, "(审批/问答结束后,是否发\"✅ 通过 / ❌ 不通过\"通知)") { v -> postPatch(mapOf("approvalDone" to v)) })
        modeRows.addView(modeRow(getString(R.string.row_task_done), listOf(
            Pair("always", getString(R.string.mode_always)),
            Pair("silent", getString(R.string.mode_silent)),
            Pair("off", getString(R.string.mode_off)),
        ), st.taskDone, "(语义同\"等待审批/问答\")") { v -> postPatch(mapOf("taskDone" to v)) })
    }

    private fun modeRow(label: String, modes: List<Pair<String, String>>, current: String, hint: String, onPick: (String) -> Unit): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        wrap.addView(TextView(this).apply {
            text = label
            textSize = 14f
            setTextColor(Color.parseColor("#222222"))
        })
        wrap.addView(TextView(this).apply {
            text = hint
            textSize = 10f
            setTextColor(Color.parseColor("#888888"))
        })
        val group = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) }
        }
        modes.forEach { (mode, mlabel) ->
            val act = current == mode
            val b = TextView(this).apply {
                text = mlabel
                textSize = 12f
                gravity = Gravity.CENTER
                setPadding(dp(10), dp(5), dp(10), dp(5))
                isClickable = true
                setOnClickListener { onPick(mode) }
            }
            styleModeBtn(b, act)
            group.addView(b, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginStart = dp(6) })
        }
        wrap.addView(group)
        return wrap
    }

    private fun styleModeBtn(b: TextView, active: Boolean) {
        val bg = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = dp(6).toFloat()
            if (active) {
                setStroke(dp(1), Color.parseColor("#4D6BFE"))
                setColor(Color.parseColor("#1F4D6BFE"))
            } else {
                setStroke(dp(1), Color.parseColor("#C8C8D0"))
                setColor(Color.parseColor("#F5F5F8"))
            }
        }
        b.background = bg
        b.setTextColor(Color.parseColor(if (active) "#2B46C8" else "#444444"))
    }

    // 开关行(手机观感:Switch 代替小勾选框,与总开关同款)
    private fun switchRow(label: String, checked: Boolean, hint: String, onFlip: (Boolean) -> Unit): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            setOnClickListener { onFlip(!checked) }
        }
        top.addView(TextView(this).apply {
            text = label
            textSize = 14f
            setTextColor(Color.parseColor("#222222"))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        top.addView(Switch(this).apply {
            isChecked = checked
            isClickable = false // 点击由整行处理
        })
        wrap.addView(top)
        if (hint.isNotBlank()) {
            wrap.addView(TextView(this).apply {
                text = hint
                textSize = 10f
                setTextColor(Color.parseColor("#888888"))
            })
        }
        return wrap
    }

    // ---------- 轮询间隔 ----------

    private fun saveInterval() {
        val iv = etInterval.text.toString().trim().toIntOrNull()
        if (iv == null || iv !in 5..60) {
            tvIntervalResult.setTextColor(Color.parseColor("#B03030"))
            tvIntervalResult.text = "轮询间隔需为 5-60 秒"
            return
        }
        tvIntervalResult.setTextColor(Color.parseColor("#888888"))
        tvIntervalResult.text = "保存中…"
        thread {
            val st = SettingsSync.post(this, mapOf("pollInterval" to iv))
            runOnUiThread {
                Settings.setPollIntervalSec(this, iv)
                if (st != null) {
                    serverSettings = st
                    tvIntervalResult.setTextColor(Color.parseColor("#1B7F3B"))
                    tvIntervalResult.text = "已保存($iv 秒)"
                } else {
                    tvIntervalResult.setTextColor(Color.parseColor("#8A6D1A"))
                    tvIntervalResult.text = "本地已保存($iv 秒);服务端不可达,未同步 PC 面板"
                }
            }
        }
    }

    // ---------- 系统设置跳转 ----------

    private fun openSysNotif() {
        try {
            startActivity(Intent("android.settings.APP_NOTIFICATION_SETTINGS").apply {
                putExtra("android.provider.extra.APP_PACKAGE", packageName)
            })
        } catch (e: Exception) {
            try {
                // 字符串 action 全版本兼容(避免 android.provider.Settings API28 常量与 minSdk26 的编译冲突)
                startActivity(Intent("android.settings.APPLICATION_NOTIFICATION_SETTINGS").apply {
                    putExtra("android.provider.extra.APP_PACKAGE", packageName)
                })
            } catch (e2: Exception) {
                tvSettingsState.visibility = View.VISIBLE
                tvSettingsState.text = "⚠ 无法打开系统通知设置,请手动进入"
            }
        }
    }

    private fun openSysBg() {
        // 直接定位"耗电行为控制":请求本 App 忽略电池优化(系统弹"允许后台活动"对话框)
        val pm = getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            tvSettingsState.visibility = View.VISIBLE
            tvSettingsState.text = "✅ 本 App 已允许后台活动(耗电行为控制已通过)"
            return
        }
        try {
            startActivity(Intent("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATION", Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            try {
                startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                tvSettingsState.visibility = View.VISIBLE
                tvSettingsState.text = "⚠ 已打开应用详情页:点\"电池\"→\"允许全部后台活动\""
            } catch (e2: Exception) {
                tvSettingsState.visibility = View.VISIBLE
                tvSettingsState.text = "⚠ 无法打开系统后台设置,请手动进入(电池→允许后台活动)"
            }
        }
    }

    // ---------- 页脚 ----------

    private fun tvFooter() {
        val version = try {
            packageManager.getPackageInfo(packageName, 0).versionName
        } catch (e: Exception) { "?" }
        findViewById<TextView>(R.id.tvFooter).text =
            "版本号: $version\n" +
            "开源协议: MIT\n" +
            "开源地址: https://github.com/DJmanito/dsh-notify\n" +
            "免责信息: 本软件仅供个人参考与学习,按\"现状\"提供,不作任何担保;使用本软件的风险由使用者自行承担,作者不对使用本软件引起的数据丢失、系统损坏或任何间接损失负责。\n" +
            getString(R.string.wan_lan_warning)
    }

    override fun onResume() {
        super.onResume()
        etInterval.setText(serverSettings?.pollInterval?.toString() ?: Settings.pollIntervalSec(this).toString())
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
