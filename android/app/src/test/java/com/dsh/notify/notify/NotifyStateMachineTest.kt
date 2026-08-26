package com.dsh.notify.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** V6:通知状态机 JVM 单测(边沿触发/会话级去重/running 差集/同帧聚合)。 */
class NotifyStateMachineTest {

    private fun frame(
        runningIds: List<String> = emptyList(),
        approvalIds: List<String> = emptyList(),
        questionIds: List<String> = emptyList(),
        runningTitle: String = "",
        approvalTitle: String = "",
        questionTitle: String = "",
    ) = NotifyFrame(
        running = runningIds.isNotEmpty(),
        pendingApproval = approvalIds.isNotEmpty(),
        runningTitle = runningTitle,
        approvalTitle = approvalTitle,
        runningSessionIds = runningIds,
        approvalSessionIds = approvalIds,
        questionSessionIds = questionIds,
        questionTitle = questionTitle,
        pendingQuestion = questionIds.isNotEmpty(),
    )

    @Test
    fun `基线首帧不发事件(冷启动不重放)`() {
        val sm = NotifyStateMachine()
        val events = sm.update(frame(runningIds = listOf("a"), approvalIds = listOf("x")))
        assertTrue("首帧必须静默", events.isEmpty())
        // 同状态第二帧:无边沿,仍静默
        assertTrue(sm.update(frame(runningIds = listOf("a"), approvalIds = listOf("x"))).isEmpty())
    }

    @Test
    fun `新审批 id 触发 ApprovalNeeded 且去重`() {
        val sm = NotifyStateMachine()
        sm.update(frame(approvalIds = listOf("x"))) // 基线:x 已存在(既有审批,不通知)
        val e1 = sm.update(frame(approvalIds = listOf("x", "y"), approvalTitle = "会话 B 等待审批"))
        assertEquals(1, e1.size)
        val ap = e1[0] as NotifyEvent.ApprovalNeeded
        assertEquals(listOf("y"), ap.sids) // x 在基线已存在,不算新
        assertEquals("会话 B 等待审批", ap.title)
        // 同 id 持续存在 → 不重复
        assertTrue(sm.update(frame(approvalIds = listOf("x", "y"))).isEmpty())
    }

    @Test
    fun `审批消失后再出现视为新审批`() {
        val sm = NotifyStateMachine()
        sm.update(frame())
        sm.update(frame(approvalIds = listOf("y"))) // y 首次通知
        val eRes = sm.update(frame(approvalIds = emptyList())) // y 处置完成 → 解决边沿(撤回用)
        assertEquals(1, eRes.size)
        assertEquals(listOf("y"), (eRes[0] as NotifyEvent.ApprovalResolved).sids)
        val e = sm.update(frame(approvalIds = listOf("y"))) // y 再出现
        assertEquals(1, e.size)
        assertEquals(listOf("y"), (e[0] as NotifyEvent.ApprovalNeeded).sids)
    }

    @Test
    fun `running 差集触发会话完成(单会话用标题)`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a"), runningTitle = "任务 A"))
        val e = sm.update(frame(runningIds = emptyList()))
        assertEquals(1, e.size)
        val done = e[0] as NotifyEvent.SessionDone
        assertEquals(listOf("a"), done.sids)
        assertEquals("任务 A", done.title)
    }

    @Test
    fun `同帧多会话消失聚合为一条`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a", "b")))
        val e = sm.update(frame(runningIds = emptyList()))
        assertEquals(1, e.size)
        val done = e[0] as NotifyEvent.SessionDone
        assertEquals(listOf("a", "b"), done.sids)
        assertEquals("2 个会话已完成", done.title)
    }

    @Test
    fun `同帧审批与完成可同时聚合`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a")))
        val e = sm.update(frame(runningIds = emptyList(), approvalIds = listOf("a")))
        assertEquals(2, e.size)
        assertTrue(e.any { it is NotifyEvent.SessionDone })
        assertTrue(e.any { it is NotifyEvent.ApprovalNeeded })
    }

    @Test
    fun `无标题时回退默认文案`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a", "b")))
        val e = sm.update(frame(runningIds = listOf("a"))) // b 消失,但上一帧 2 个 → 非单会话
        val done = e.filterIsInstance<NotifyEvent.SessionDone>().first()
        assertEquals(NotifyStateMachine.DEFAULT_DONE_TITLE, done.title)

        val sm2 = NotifyStateMachine()
        sm2.update(frame())
        val e2 = sm2.update(frame(approvalIds = listOf("z")))
        assertEquals(NotifyStateMachine.DEFAULT_APPROVAL_TITLE, (e2[0] as NotifyEvent.ApprovalNeeded).title)
    }

    @Test
    fun `reset 后重建基线且静默`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a")))
        sm.update(frame(runningIds = emptyList())) // 会发完成事件
        sm.reset()
        val e = sm.update(frame(runningIds = listOf("a"), approvalIds = listOf("x")))
        assertTrue("reset 后首帧必须静默", e.isEmpty())
    }

    @Test
    fun `新问答 id 触发 QuestionNeeded 且去重`() {
        val sm = NotifyStateMachine()
        sm.update(frame(questionIds = listOf("x"), questionTitle = "既有问题")) // 基线含 x
        val e1 = sm.update(frame(questionIds = listOf("x", "y"), questionTitle = "会话 B 在提问"))
        assertEquals(1, e1.size)
        val q = e1[0] as NotifyEvent.QuestionNeeded
        assertEquals(listOf("y"), q.sids)
        assertEquals("会话 B 在提问", q.title)
        // 持续存在 → 不重复
        assertTrue(sm.update(frame(questionIds = listOf("x", "y"))).isEmpty())
    }

    @Test
    fun `问答被回答后再问视为新问答`() {
        val sm = NotifyStateMachine()
        sm.update(frame())
        sm.update(frame(questionIds = listOf("y"))) // 首次通知
        val eRes = sm.update(frame(questionIds = emptyList())) // 已回答 → 解决边沿
        assertEquals(1, eRes.size)
        assertEquals(listOf("y"), (eRes[0] as NotifyEvent.QuestionResolved).sids)
        val e = sm.update(frame(questionIds = listOf("y"))) // 再问
        assertEquals(1, e.size)
        assertEquals(listOf("y"), (e[0] as NotifyEvent.QuestionNeeded).sids)
    }

    @Test
    fun `问答无标题回退默认文案`() {
        val sm = NotifyStateMachine()
        sm.update(frame())
        val e = sm.update(frame(questionIds = listOf("z")))
        assertEquals(NotifyStateMachine.DEFAULT_QUESTION_TITLE, (e[0] as NotifyEvent.QuestionNeeded).title)
    }

    @Test
    fun `snapshot-restore v2 保持问答去重状态`() {
        val sm = NotifyStateMachine()
        sm.update(frame(questionIds = listOf("q1"))) // 基线含 q1
        val snap = sm.snapshot()
        val sm2 = NotifyStateMachine()
        sm2.restore(snap)
        assertTrue("已通知问答不得重放", sm2.update(frame(questionIds = listOf("q1"))).isEmpty())
        val e = sm2.update(frame(questionIds = listOf("q1", "q2")))
        assertEquals(listOf("q2"), (e.single() as NotifyEvent.QuestionNeeded).sids)
    }

    @Test
    fun `restore 兼容 v1 四段快照`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a"), approvalIds = listOf("x")))
        // 手工构造 v1 格式(4 段)
        val v1 = "1\u0001a\u0001x\u0001标题A"
        val sm2 = NotifyStateMachine()
        sm2.restore(v1)
        assertTrue(sm2.update(frame(runningIds = listOf("a"), approvalIds = listOf("x"))).isEmpty())
    }

    @Test
    fun `审批解决边沿只对真正通知过的 id 触发(基线吞入的不发)`() {
        val sm = NotifyStateMachine()
        sm.update(frame(approvalIds = listOf("b"))) // 基线吞入 b(无事件)
        val e1 = sm.update(frame(approvalIds = listOf("b", "a"))) // a 新 → Needed
        assertEquals(1, e1.size)
        assertEquals(listOf("a"), (e1[0] as NotifyEvent.ApprovalNeeded).sids)
        val e2 = sm.update(frame(approvalIds = listOf("b"))) // a 解决 → Resolved([a])
        assertEquals(1, e2.size)
        assertEquals(listOf("a"), (e2[0] as NotifyEvent.ApprovalResolved).sids)
        assertTrue(sm.update(frame(approvalIds = listOf("b"))).isEmpty())
        val e4 = sm.update(frame(approvalIds = emptyList())) // b(基线,从未通知)解决 → 无事件
        assertTrue("基线吞入的审批解决不得发 Resolved", e4.isEmpty())
    }

    @Test
    fun `问答解决边沿语义同审批`() {
        val sm = NotifyStateMachine()
        sm.update(frame())
        sm.update(frame(questionIds = listOf("q"))) // Needed
        val e = sm.update(frame(questionIds = emptyList()))
        assertEquals(1, e.size)
        assertEquals(listOf("q"), (e[0] as NotifyEvent.QuestionResolved).sids)
    }

    @Test
    fun `snapshot-restore 进程重启后不重放且边沿保持`() {
        val sm = NotifyStateMachine()
        sm.update(frame(runningIds = listOf("a"), runningTitle = "任务 A"))
        sm.update(frame(runningIds = listOf("a"), approvalIds = listOf("x"))) // x 已通知
        val snap = sm.snapshot()

        val sm2 = NotifyStateMachine()
        sm2.restore(snap)
        // 已通知的审批 x 不重放
        val e1 = sm2.update(frame(runningIds = listOf("a"), approvalIds = listOf("x"), runningTitle = "任务 A"))
        assertTrue("恢复后已通知审批不得重放", e1.isEmpty())
        // running a 消失 → 完成事件仍在(标题保持)
        val e2 = sm2.update(frame(runningIds = emptyList(), approvalIds = emptyList()))
        val done = e2.filterIsInstance<NotifyEvent.SessionDone>().single()
        assertEquals(listOf("a"), done.sids)
        assertEquals("任务 A", done.title)
    }
}
