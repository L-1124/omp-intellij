package org.jetbrains.android.run

import org.junit.Assert.*
import org.junit.Test

class AndroidProcessInspectorTest {

    @Test
    fun testParseDumpsysActivityProcessesDistinguishesUsersStartSeqAndIgnoresFooter() {
        val dump = """
            ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)
              All known processes:
              *APP* UID 10243 ProcessRecord{a368399 5234:com.example.ompconfirmfixture/u0a243}
                user #0 uid=10243 gids={50243, 20243}
                packageList={com.example.ompconfirmfixture}
                pid=5234
                startSeq=79
              *APP* UID 1010243 ProcessRecord{c112233 6100:com.example.ompconfirmfixture:custom/u10a243}
                user #10 uid=1010243 gids={50243}
                packageList={com.example.ompconfirmfixture}
                pid=6100
                startSeq=91

              OOM levels:
                -900: SYSTEM_ADJ
              mHomeProcess: ProcessRecord{5519295 1290:com.google.android.apps.nexuslauncher/u0a191}
              PID mappings:
                PID #5234: ProcessRecord{a368399 5234:com.example.ompconfirmfixture/u0a243}
        """.trimIndent()

        val user0 = AndroidProcessInspector.parseDumpsysActivityProcesses(
            dump,
            "com.example.ompconfirmfixture",
            targetUserId = 0,
        )
        assertEquals(1, user0.size)
        assertEquals(5234, user0[0].pid)
        assertEquals(0, user0[0].userId)
        assertEquals(10243, user0[0].uid)
        assertEquals(79L, user0[0].startSeq)
        assertEquals("com.example.ompconfirmfixture", user0[0].processName)
        assertEquals("a368399 5234:com.example.ompconfirmfixture/u0a243", user0[0].amsRecord)

        val user10 = AndroidProcessInspector.parseDumpsysActivityProcesses(
            dump,
            "com.example.ompconfirmfixture",
            targetUserId = 10,
        )
        assertEquals(1, user10.size)
        assertEquals(6100, user10[0].pid)
        assertEquals(10, user10[0].userId)
        assertEquals(1010243, user10[0].uid)
        assertEquals(91L, user10[0].startSeq)
        assertEquals("com.example.ompconfirmfixture:custom", user10[0].processName)

        val allUsers = AndroidProcessInspector.parseDumpsysActivityProcesses(
            dump,
            "com.example.ompconfirmfixture",
            targetUserId = null,
        )
        assertEquals(2, allUsers.size)
    }

    @Test
    fun testPendingAmsRecordsAreNotRunningProcesses() {
        val pendingDump = """
            All known processes:
              *APP* UID 10243 ProcessRecord{a368399 0:com.example.app/u0a243}
                user #0 uid=10243
                packageList={com.example.app}
                pendingStart=true
        """.trimIndent()
        assertTrue(
            AndroidProcessInspector.parseDumpsysActivityProcesses(
                pendingDump,
                "com.example.app",
                targetUserId = 0,
            ).isEmpty()
        )

        val runningDump = """
            $pendingDump
              *APP* UID 10243 ProcessRecord{b112233 5234:com.example.app/u0a243}
                user #0 uid=10243
                packageList={com.example.app}
                startSeq=79
              *APP* UID 1010243 ProcessRecord{c112233 0:com.example.app/u10a243}
                user #10 uid=1010243
                packageList={com.example.app}
                startSeq=90
              *APP* UID 1010243 ProcessRecord{d112233 999999999999:com.example.app/u10a243}
                user #10 uid=1010243
                packageList={com.example.app}
                startSeq=91
        """.trimIndent()
        val running = AndroidProcessInspector.parseDumpsysActivityProcesses(
            runningDump,
            "com.example.app",
            targetUserId = 0,
        )
        assertEquals(listOf(5234), running.map { it.pid })
        assertEquals(10243, running.single().uid)
        assertEquals(79L, running.single().startSeq)
    }

    @Test
    fun testValidateAmStartOutput() {
        assertNull(
            AndroidProcessInspector.validateAmStartOutput(
                stdout = "Starting: Intent { cmp=com.example.app/.MainActivity }",
                stderr = "",
                exitCode = 0,
            )
        )
        assertNotNull(
            AndroidProcessInspector.validateAmStartOutput(
                stdout = "Starting: Intent { cmp=com.example.app/.Missing }\nError: Activity class {com.example.app/com.example.app.Missing} does not exist.",
                stderr = "",
                exitCode = 0,
            )
        )
        assertNotNull(
            AndroidProcessInspector.validateAmStartOutput(
                stdout = "Warning: Activity not started, its current task has been brought to the front",
                stderr = "",
                exitCode = 0,
            )
        )
        assertNotNull(
            AndroidProcessInspector.validateAmStartOutput(
                stdout = "Starting: Intent { cmp=com.example.app/.MainActivity }",
                stderr = "Permission Denial",
                exitCode = 1,
            )
        )
    }
}
