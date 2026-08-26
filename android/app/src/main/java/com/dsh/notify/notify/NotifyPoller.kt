package com.dsh.notify.notify

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * /notify-state 拉取(前台服务与 WorkManager 兜底共用,避免重复实现)。
 * 失败(网络/解析/非 200)返回 null = 本周期跳过,不改状态。
 */
fun fetchNotifyFrame(baseUrl: String): NotifyFrame? {
    return try {
        val conn = URL(baseUrl.trimEnd('/') + "/notify-state").openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        conn.requestMethod = "GET"
        if (conn.responseCode != 200) {
            conn.disconnect()
            return null
        }
        val j = JSONObject(conn.inputStream.bufferedReader().readText())
        conn.disconnect()
        NotifyFrame(
            running = j.optBoolean("running"),
            pendingApproval = j.optBoolean("pendingApproval"),
            runningTitle = j.optString("runningTitle"),
            approvalTitle = j.optString("approvalTitle"),
            runningSessionIds = j.optJSONArray("runningSessionIds")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
            approvalSessionIds = j.optJSONArray("approvalSessionIds")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
            // 问答字段(响应缺失时 → 空)
            questionSessionIds = j.optJSONArray("questionSessionIds")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
            questionTitle = j.optString("questionTitle"),
            pendingQuestion = j.optBoolean("pendingQuestion"),
            // 审批判定(sid -> approved|denied;响应缺失 → 空 map)
            decisions = j.optJSONObject("decisions")?.let { d ->
                val m = mutableMapOf<String, String>()
                d.keys().let { iter -> while (iter.hasNext()) { val k = iter.next(); m[k] = d.optString(k) } }
                m
            } ?: emptyMap(),
        )
    } catch (e: Exception) {
        null
    }
}
