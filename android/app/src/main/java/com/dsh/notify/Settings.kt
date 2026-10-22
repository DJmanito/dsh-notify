package com.dsh.notify

import android.content.Context

/**
 * 连接设置持久化(SharedPreferences)。
 * 目标 = 局域网 DSH web 入口(默认端口 3080,以实际环境为准),明文 HTTP 仅限可信内网。
 */
object Settings {

    private const val FILE = "dsh_remote_prefs"
    // dsh web 默认入口端口 3080;环境不同时在设置页改一次保存
    private const val DEFAULT_PORT = 3080

    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun host(c: Context): String = prefs(c).getString("host", "") ?: ""

    fun port(c: Context): Int = prefs(c).getInt("port", DEFAULT_PORT)

    fun notifyEnabled(c: Context): Boolean = prefs(c).getBoolean("notifyEnabled", false)

    /** 轮询周期(秒),允许 5-60,默认 20。与 SettingsSync 共享同一 key。 */
    fun pollIntervalSec(c: Context): Int = prefs(c).getInt("pollIntervalSec", 20).coerceIn(5, 60)

    fun setHost(c: Context, h: String) = prefs(c).edit().putString("host", h.trim()).apply()

    fun setPort(c: Context, p: Int) = prefs(c).edit().putInt("port", p).apply()

    // commit() 同步落盘:开关状态在进程被杀前必须持久化(apply 异步,崩溃时会丢)
    fun setNotifyEnabled(c: Context, b: Boolean) = prefs(c).edit().putBoolean("notifyEnabled", b).commit()

    fun setPollIntervalSec(c: Context, s: Int) = prefs(c).edit().putInt("pollIntervalSec", s.coerceIn(5, 60)).apply()

    // ---- 会话ID黑名单(U3: 本地存储 API;通知过滤归 U4) ----
    // 契约: 文件 dsh_remote_prefs / 键 session_blacklist / 值为 JSON 字符串数组

    const val KEY_SESSION_BLACKLIST = "session_blacklist"

    /** 读: 容错解析,去空白,去重,剔除空串;任何非法输入返回空列表(不抛异常)。 */
    fun sessionBlacklist(c: Context): List<String> =
        parseBlacklist(prefs(c).getString(KEY_SESSION_BLACKLIST, null))

    /** 写: 去空白/去重/剔除空串后 JSON 编码落盘。 */
    fun setSessionBlacklist(c: Context, list: List<String>) {
        prefs(c).edit().putString(KEY_SESSION_BLACKLIST, encodeBlacklist(normalizeBlacklist(list))).apply()
    }

    /** 规范化: trim → 剔除空串 → 去重(保首次出现顺序)。纯函数,JVM 可测。 */
    fun normalizeBlacklist(raw: List<String>): List<String> {
        val out = LinkedHashSet<String>()
        raw.forEach { v -> val t = v.trim(); if (t.isNotEmpty()) out.add(t) }
        return out.toList()
    }

    /** 编码为 JSON 数组字符串;仅转义 " \ 与 0x20 以下控制符。纯函数,JVM 可测。 */
    fun encodeBlacklist(list: List<String>): String {
        val sb = StringBuilder("[")
        list.forEachIndexed { i, item ->
            if (i > 0) sb.append(',')
            sb.append('"')
            item.forEach { ch ->
                when (ch) {
                    '"' -> sb.append("\\\"")
                    '\\' -> sb.append("\\\\")
                    '\b' -> sb.append("\\b")
                    '\u000C' -> sb.append("\\f")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    else -> if (ch.code < 0x20) sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
                }
            }
            sb.append('"')
        }
        return sb.append(']').toString()
    }

    /** 容错解析: 只接受 JSON 字符串数组;其余(null/非数组/非字符串元素/坏转义/尾逗号)一律返回空列表。 */
    fun parseBlacklist(raw: String?): List<String> {
        if (raw == null) return emptyList()
        val s = raw.trim()
        if (s.length < 2 || s[0] != '[' || s[s.length - 1] != ']') return emptyList()
        val inner = s.substring(1, s.length - 1)
        val out = ArrayList<String>()
        var i = 0
        var first = true
        while (i < inner.length) {
            while (i < inner.length && inner[i].isWhitespace()) i++
            if (i >= inner.length) break
            if (!first) {
                if (inner[i] != ',') return emptyList()
                i++
                while (i < inner.length && inner[i].isWhitespace()) i++
                if (i >= inner.length) return emptyList() // 尾逗号
            }
            val pair = readJsonString(inner, i) ?: return emptyList()
            out.add(pair.first)
            i = pair.second
            first = false
        }
        return normalizeBlacklist(out)
    }

    /** 解析 s[start]=='"' 处的 JSON 字符串字面量;返回 (解码值, 闭引号后下标);坏转义/未闭合返回 null。 */
    private fun readJsonString(s: String, start: Int): Pair<String, Int>? {
        if (s[start] != '"') return null
        val sb = StringBuilder()
        var i = start + 1
        while (true) {
            if (i >= s.length) return null
            val ch = s[i]
            when {
                ch == '"' -> return sb.toString() to (i + 1)
                ch == '\\' -> {
                    i++
                    if (i >= s.length) return null
                    when (s[i]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (i + 5 > s.length) return null
                            val code = s.substring(i + 1, i + 5).toIntOrNull(16)
                            if (code == null || code > 0x10FFFF) return null
                            if (code in 0xD800..0xDFFF) sb.append(code.toChar()) else sb.appendCodePoint(code)
                            i += 4
                        }
                        else -> return null
                    }
                }
                else -> sb.append(ch)
            }
            i++
        }
    }

    // ---- 后台回收 WebView(U1): App 退后台超过阈值(分钟)销毁内置页面,仅留通知服务 ----
    // 契约: 文件 dsh_remote_prefs / 键 webview_bg_timeout_minutes / 0=不回收 / 读写夹紧 0..1440

    const val KEY_WEBVIEW_BG_TIMEOUT = "webview_bg_timeout_minutes"
    const val DEFAULT_WEBVIEW_BG_TIMEOUT_MINUTES = 15

    /** 读路径纯函数: 未设(null)=默认 15;存值夹紧 0..1440(0=不回收)。纯函数,JVM 可测。 */
    fun webviewBgTimeoutFromStored(stored: Int?): Int =
        (stored ?: DEFAULT_WEBVIEW_BG_TIMEOUT_MINUTES).coerceIn(0, 1440)

    /** 写路径纯函数: 夹紧 0..1440。纯函数,JVM 可测。 */
    fun webviewBgTimeoutToStore(minutes: Int): Int = minutes.coerceIn(0, 1440)

    /** 读: 后台多久(分钟)后销毁内置 WebView;0=不回收;未设=默认 15。 */
    fun webviewBgTimeoutMinutes(c: Context): Int {
        val p = prefs(c)
        return if (p.contains(KEY_WEBVIEW_BG_TIMEOUT))
            webviewBgTimeoutFromStored(p.getInt(KEY_WEBVIEW_BG_TIMEOUT, 0))
        else
            webviewBgTimeoutFromStored(null)
    }

    /** 写: 夹紧 0..1440 后落盘。 */
    fun setWebviewBgTimeoutMinutes(c: Context, minutes: Int) =
        prefs(c).edit().putInt(KEY_WEBVIEW_BG_TIMEOUT, webviewBgTimeoutToStore(minutes)).apply()

    fun baseUrl(c: Context): String = "http://${host(c)}:${port(c)}/"

    fun hasServer(c: Context): Boolean = validateHost(host(c)) && validatePort(port(c))

    /** IPv4 / IPv6 / 域名(hostnames)。不做 DNS 解析,格式校验。 */
    fun validateHost(h: String): Boolean {
        val s = h.trim()
        if (s.isEmpty()) return false
        // IPv4
        if (Regex("""^\d{1,3}(\.\d{1,3}){3}$""").matches(s)) {
            return s.split('.').all { it.toIntOrNull() in 0..255 }
        }
        // IPv6(简单形态:含冒号,无空白;最短 "::" = 2 字符)
        if (s.contains(':')) return s.length in 2..64 && s.all { it.isLetterOrDigit() || it == ':' || it == '-' }
        // 域名
        return Regex("""^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$""").matches(s)
    }

    fun validatePort(p: Int): Boolean = p in 1..65535

    // ---- 通知监控心跳(C-3 前台服务与工作器互斥用) ----

    fun lastPollAt(c: Context): Long = prefs(c).getLong("lastPollAt", 0L)

    fun touchPoll(c: Context) = prefs(c).edit().putLong("lastPollAt", System.currentTimeMillis()).apply()
}
