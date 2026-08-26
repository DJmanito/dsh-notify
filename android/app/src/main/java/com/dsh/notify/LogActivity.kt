package com.dsh.notify

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.dsh.notify.notify.LogBus

/** 日志独立页:LogBus 全量(每秒刷新),返回 + 清空。 */
class LogActivity : AppCompatActivity() {

    private lateinit var tvLog: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val ticker = object : Runnable {
        override fun run() {
            tvLog.text = LogBus.snapshot().joinToString("\n")
            tvLog.post { tvLog.scrollTo(0, tvLog.height) }
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_log)

        val root = findViewById<View>(R.id.btnLogBack)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            insets
        }

        tvLog = findViewById(R.id.tvLog)
        tvLog.movementMethod = android.text.method.ScrollingMovementMethod()
        root.setOnClickListener { finish() }
        findViewById<TextView>(R.id.btnLogClear).setOnClickListener { LogBus.clear() }
    }

    override fun onResume() {
        super.onResume()
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }
}
