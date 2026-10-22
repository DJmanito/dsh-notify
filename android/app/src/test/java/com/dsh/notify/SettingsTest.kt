package com.dsh.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** validateHost / validatePort 校验分支单测。 */
class SettingsTest {

    @Test
    fun `validateHost IPv4 合法与越界`() {
        assertTrue(Settings.validateHost("192.0.2.10")) // RFC 5737 TEST-NET-1(测试专用段)
        assertTrue(Settings.validateHost("10.0.0.1"))
        assertFalse(Settings.validateHost("256.1.1.1"))
        assertFalse(Settings.validateHost("1..2.3"))
        assertFalse(Settings.validateHost("1.2.3."))
        // 注: "1.2.3" 是合法数字标签域名(DNS 允许),格式校验放行,可达性由"测试连接"负责
    }

    @Test
    fun `validateHost 域名`() {
        assertTrue(Settings.validateHost("nas.home.lan"))
        assertTrue(Settings.validateHost("a.b-c.d"))
        assertFalse(Settings.validateHost("-bad.example"))
        assertFalse(Settings.validateHost("bad-"))
        assertFalse(Settings.validateHost(""))
        assertFalse(Settings.validateHost("has space"))
    }

    @Test
    fun `validateHost IPv6 简单形态`() {
        assertTrue(Settings.validateHost("fe80::1"))
        assertTrue(Settings.validateHost("::1"))
        assertFalse(Settings.validateHost(":"))
    }

    @Test
    fun `validatePort 边界`() {
        assertTrue(Settings.validatePort(1))
        assertTrue(Settings.validatePort(3081))
        assertTrue(Settings.validatePort(65535))
        assertFalse(Settings.validatePort(0))
        assertFalse(Settings.validatePort(65536))
        assertFalse(Settings.validatePort(-1))
    }

    // ---- 会话ID黑名单(U3): 存读往返 / 去空白去重 / 非法 JSON 容错 ----
    // 纯 JVM 单测: 覆盖 JSON 序列化层(set/read 的 Context 粘合层需 Android 环境,不在本腿范围)

    @Test
    fun `blacklist 编码为 JSON 数组字符串`() {
        assertEquals("[]", Settings.encodeBlacklist(emptyList()))
        assertEquals("[\"a\",\"b\"]", Settings.encodeBlacklist(listOf("a", "b")))
    }

    @Test
    fun `blacklist 存读往返(含逗号 引号 反斜杠 控制符 中文 unicode转义)`() {
        val ids = listOf("sess-001", "a,b", "q\"x", "b\\y", "t\tn", "n\nr", "中文会话")
        assertEquals(ids, Settings.parseBlacklist(Settings.encodeBlacklist(ids)))
        // \uXXXX 转义解码
        assertEquals(listOf("中文"), Settings.parseBlacklist("""["\u4e2d\u6587"]"""))
    }

    @Test
    fun `blacklist 去空白 去重 剔除空串`() {
        assertEquals(listOf("a", "b"), Settings.normalizeBlacklist(listOf(" a ", "a", "", "  ", "b", "a ")))
        // 解析路径同样规范化
        assertEquals(listOf("a", "b"), Settings.parseBlacklist("""[" a ", "a", "", "b"]"""))
    }

    @Test
    fun `blacklist 非法 JSON 容错(不抛异常,返回空)`() {
        assertTrue(Settings.parseBlacklist(null).isEmpty())
        assertTrue(Settings.parseBlacklist("").isEmpty())
        assertTrue(Settings.parseBlacklist("   ").isEmpty())
        assertTrue(Settings.parseBlacklist("not json").isEmpty())
        assertTrue(Settings.parseBlacklist("""{"a":"b"}""").isEmpty())
        assertTrue(Settings.parseBlacklist("""["a",]""").isEmpty())
        assertTrue(Settings.parseBlacklist("""["a" "b"]""").isEmpty())
        assertTrue(Settings.parseBlacklist("""["a", 1]""").isEmpty())
        assertTrue(Settings.parseBlacklist("""["a", true]""").isEmpty())
        assertTrue(Settings.parseBlacklist("""["\x"]""").isEmpty())
        assertTrue(Settings.parseBlacklist("""["abc""").isEmpty())
        // 合法输入不受容错影响
        assertEquals(listOf("a"), Settings.parseBlacklist("[\"a\"]"))
    }

    // ---- 黑名单输入切分(U3-修): 半/全角逗号切分,逐段 trim,丢空段;粘贴多逗号串不得当单标签 ----

    @Test
    fun `blacklist 切分 粘贴半角逗号串 a,b,c 得 3 标签且标签内无逗号`() {
        val tokens = SettingsActivity.splitBlacklistTokens("a,b,c")
        assertEquals(listOf("a", "b", "c"), tokens)
        tokens.forEach { assertFalse(it.contains(',')) }
    }

    @Test
    fun `blacklist 切分 粘贴全角逗号带空格与连续逗号串得 3 标签且标签内无逗号`() {
        val tokens = SettingsActivity.splitBlacklistTokens(" a ， b ，， c ")
        assertEquals(listOf("a", "b", "c"), tokens)
        tokens.forEach { assertFalse(it.contains(',')); assertFalse(it.contains('，')) }
    }

    // ---- 后台回收 WebView 阈值(U1): 默认值 / 夹紧边界 / 存取往返(纯函数层) ----
    // 纯 JVM 单测: Context 粘合层(webviewBgTimeoutMinutes/setWebviewBgTimeoutMinutes 的 prefs 读写)
    // 需 Android 环境,不在本腿范围。

    @Test
    fun `wvbg 默认值 未设为 15`() {
        assertEquals(15, Settings.webviewBgTimeoutFromStored(null))
        assertEquals(Settings.DEFAULT_WEBVIEW_BG_TIMEOUT_MINUTES, 15)
    }

    @Test
    fun `wvbg 读路径夹紧 0到1440 边界`() {
        assertEquals(0, Settings.webviewBgTimeoutFromStored(-1))
        assertEquals(0, Settings.webviewBgTimeoutFromStored(0))
        assertEquals(5, Settings.webviewBgTimeoutFromStored(5))
        assertEquals(1440, Settings.webviewBgTimeoutFromStored(1440))
        assertEquals(1440, Settings.webviewBgTimeoutFromStored(1441))
        assertEquals(1440, Settings.webviewBgTimeoutFromStored(Int.MAX_VALUE))
    }

    @Test
    fun `wvbg 写路径夹紧 0到1440`() {
        assertEquals(0, Settings.webviewBgTimeoutToStore(-100))
        assertEquals(1440, Settings.webviewBgTimeoutToStore(99999))
        assertEquals(30, Settings.webviewBgTimeoutToStore(30))
    }

    @Test
    fun `wvbg 存取往返 先写后读一致(越界值先被夹紧)`() {
        listOf(-5, 0, 1, 5, 15, 30, 60, 1439, 1440, 1441, 100000).forEach { v ->
            val stored = Settings.webviewBgTimeoutToStore(v)
            assertEquals(v.coerceIn(0, 1440), stored)
            assertEquals(stored, Settings.webviewBgTimeoutFromStored(stored))
        }
    }

    // ---- 后台超时判定(U1-修): isBgTimedOut 纯函数五分支(旧断言不动) ----

    @Test
    fun `isBgTimedOut 未超时 false`() {
        assertFalse(MainActivity.isBgTimedOut(1_000_000L, 900_000L, 15)) // 差 100s < 15 分钟
    }

    @Test
    fun `isBgTimedOut 刚超阈值 true`() {
        assertTrue(MainActivity.isBgTimedOut(1_900_000L, 1_000_000L, 15)) // 差恰好 15 分钟,>= 边界
    }

    @Test
    fun `isBgTimedOut 0 分钟 false`() {
        assertFalse(MainActivity.isBgTimedOut(9_999_999_999L, 1_000_000L, 0))
    }

    @Test
    fun `isBgTimedOut bgStartAt 为 0 false`() {
        assertFalse(MainActivity.isBgTimedOut(5_000_000L, 0L, 15))
    }

    @Test
    fun `isBgTimedOut now 早于 bgStartAt false`() {
        assertFalse(MainActivity.isBgTimedOut(1_000_000L, 2_000_000L, 15))
    }
}
