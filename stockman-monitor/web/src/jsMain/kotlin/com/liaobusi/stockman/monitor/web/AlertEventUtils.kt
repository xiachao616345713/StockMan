package com.liaobusi.stockman.monitor.web

fun AlertEvent.primaryEventType(): String {
    return eventTypes.firstOrNull().orEmpty().ifBlank {
        when {
            content.contains("炸板") -> "BREAK_LIMIT_UP"
            content.contains("涨停") -> "LIMIT_UP"
            content.contains("跌幅") -> "DROP"
            content.contains("涨幅") -> "SPIKE"
            content.contains("跌停") -> "LIMIT_DOWN"
            content.contains("翘板") -> "OPEN_LIMIT_DOWN"
            else -> "UNKNOWN"
        }
    }
}

fun alertEventLabel(type: String): String {
    return when (type) {
        "LIMIT_UP" -> "涨停"
        "BREAK_LIMIT_UP" -> "炸板"
        "SPIKE" -> "急涨"
        "DROP" -> "急跌"
        "LIMIT_DOWN" -> "跌停"
        "OPEN_LIMIT_DOWN" -> "翘板"
        else -> "异动"
    }
}

fun alertEventGroup(type: String): String {
    return when (type) {
        "SPIKE", "DROP" -> "SPEED"
        "LIMIT_UP", "BREAK_LIMIT_UP" -> "UP_LIMIT"
        "LIMIT_DOWN", "OPEN_LIMIT_DOWN" -> "DOWN_LIMIT"
        else -> type
    }
}

fun alertCount(alerts: List<AlertEvent>, type: String): Int {
    return if (type == "all") alerts.size else alerts.count { alertEventGroup(it.primaryEventType()) == type }
}

fun alertEventSummary(alerts: List<AlertEvent>): String {
    return "涨停 ${alertCount(alerts, "LIMIT_UP")} / 炸板 ${alertCount(alerts, "BREAK_LIMIT_UP")} / 急涨 ${alertCount(alerts, "SPIKE")} / 急跌 ${alertCount(alerts, "DROP")}"
}

fun alertTimelineDotStyle(type: String): String? {
    return when (type) {
        "SPIKE" -> AppStyles.alertTimelinePointUp
        "DROP" -> AppStyles.alertTimelinePointDown
        "LIMIT_UP" -> AppStyles.alertTimelinePointLimitUp
        "LIMIT_DOWN" -> AppStyles.alertTimelinePointLimitDown
        "BREAK_LIMIT_UP" -> AppStyles.alertTimelinePointBreakLimitUp
        "OPEN_LIMIT_DOWN" -> AppStyles.alertTimelinePointOpenLimitDown
        else -> null
    }
}

fun alertBadgeStyle(type: String): String {
    return when (type) {
        "SPIKE", "OPEN_LIMIT_DOWN" -> AppStyles.alertBadgeUp
        "DROP", "BREAK_LIMIT_UP" -> AppStyles.alertBadgeDown
        "LIMIT_UP" -> AppStyles.alertBadgeLimitUp
        "LIMIT_DOWN" -> AppStyles.alertBadgeLimitDown
        else -> AppStyles.alertBadgeNeutral
    }
}

fun notificationLabel(state: String): String {
    return when (state) {
        "granted" -> "已开启"
        "denied" -> "已关闭"
        "unsupported" -> "不支持"
        else -> "未授权"
    }
}

fun notificationHelp(state: String): String {
    return when (state) {
        "granted" -> "浏览器弹窗可用"
        "denied" -> "地址栏允许通知后生效"
        "unsupported" -> "当前浏览器不可用"
        else -> "点击右上角开启"
    }
}
