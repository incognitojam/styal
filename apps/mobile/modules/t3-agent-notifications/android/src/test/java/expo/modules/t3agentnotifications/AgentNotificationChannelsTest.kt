package expo.modules.t3agentnotifications

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class AgentNotificationChannelsTest {
  private lateinit var context: Application
  private lateinit var manager: NotificationManager

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    manager = context.getSystemService(NotificationManager::class.java)
    AgentNotifications.channels(context)
  }

  @Test
  fun channelsShareOneGroupAndReportWhenAndroidTurnsThemOff() {
    val allOn = mapOf("alerts" to true, "activity" to true)
    assertEquals(allOn, AgentNotifications.channelStates(context))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    assertEquals("Agents", manager.notificationChannelGroups.single { it.id == "agents" }.name)
    for (id in listOf("agent-alerts", "agent-activity")) {
      assertEquals("agents", manager.getNotificationChannel(id).group)
    }
    // Stands in for the user switching the category off in Android settings.
    manager.deleteNotificationChannel("agent-alerts")
    manager.createNotificationChannel(
      NotificationChannel("agent-alerts", "Agent alerts", NotificationManager.IMPORTANCE_NONE)
    )
    assertEquals(
      mapOf("alerts" to false, "activity" to true),
      AgentNotifications.channelStates(context)
    )
  }
}
