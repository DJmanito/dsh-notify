package com.dsh.notify

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
}
