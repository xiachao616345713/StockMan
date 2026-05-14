package com.liaobusi.stockman.monitor.web

import kotlinx.browser.window
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val localAlertJson = Json { ignoreUnknownKeys = true }
private const val LOCAL_ALERT_EVENTS_KEY = "stockman.monitor.localAlertEvents"
private const val LOCAL_ALERT_RETENTION_MS = 7L * 24L * 60L * 60L * 1000L
private const val LOCAL_ALERT_MERGE_WINDOW_MS = 30L * 1000L

fun loadLocalAlertHistory(): Map<String, List<AlertEvent>> {
    val events = loadLocalAlertEvents()
    persistLocalAlertEvents(events)
    return events.groupBy { it.code }
}

fun saveLocalAlertEvent(alert: AlertEvent): Map<String, List<AlertEvent>> {
    val currentEvents = loadLocalAlertEvents().toMutableList()
    val mergeIndex = currentEvents.indexOfFirst { existing ->
        existing.code == alert.code &&
            alertEventGroup(existing.primaryEventType()) == alertEventGroup(alert.primaryEventType()) &&
            kotlin.math.abs(alert.time - existing.time) <= LOCAL_ALERT_MERGE_WINDOW_MS
    }
    if (mergeIndex >= 0) {
        currentEvents[mergeIndex] = alert
    } else {
        currentEvents += alert
    }
    val events = currentEvents
        .distinctBy { "${it.code}:${alertEventGroup(it.primaryEventType())}:${it.time}" }
        .sortedByDescending { it.time }
        .take(500)
    persistLocalAlertEvents(events)
    return events.groupBy { it.code }
}

fun mergeVisibleAlert(
    alerts: MutableList<AlertEvent>,
    alert: AlertEvent
): Boolean {
    val matchedIndexes = alerts.mapIndexedNotNull { index, existing ->
        if (existing.code == alert.code && tradeDateKey(existing.time) == tradeDateKey(alert.time)) index else null
    }
    if (matchedIndexes.isEmpty()) return false
    alerts[matchedIndexes.first()] = alert
    matchedIndexes.drop(1).asReversed().forEach { index -> alerts.removeAt(index) }
    return true
}

private fun loadLocalAlertEvents(): List<AlertEvent> {
    val cutoff = nowMs() - LOCAL_ALERT_RETENTION_MS
    val raw = window.localStorage.getItem(LOCAL_ALERT_EVENTS_KEY) ?: return emptyList()
    return runCatching {
        localAlertJson.decodeFromString<List<AlertEvent>>(raw)
            .filter { it.time >= cutoff }
    }.getOrDefault(emptyList())
}

private fun persistLocalAlertEvents(events: List<AlertEvent>) {
    window.localStorage.setItem(LOCAL_ALERT_EVENTS_KEY, localAlertJson.encodeToString(events))
}
