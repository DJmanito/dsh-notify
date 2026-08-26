package com.dsh.notify

import android.app.Activity
import android.app.Application
import android.os.Bundle

/** Application:统计前台可见 Activity 数(C-3 "App 可见时静默通知"依据)。 */
class DshRemoteApp : Application() {
    override fun onCreate() {
        super.onCreate()
        com.dsh.notify.notify.LogBus.init(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(a: Activity) { AppVisibility.onResumed() }
            override fun onActivityPaused(a: Activity) { AppVisibility.onPaused() }
            override fun onActivityCreated(a: Activity, s: Bundle?) {}
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })
    }
}

object AppVisibility {
    @Volatile var resumedCount = 0
        private set

    fun onResumed() { resumedCount++ }
    fun onPaused() { resumedCount = (resumedCount - 1).coerceAtLeast(0) }
    val isAppVisible: Boolean get() = resumedCount > 0
}
