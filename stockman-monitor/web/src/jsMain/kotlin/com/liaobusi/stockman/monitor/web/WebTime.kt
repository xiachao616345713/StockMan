package com.liaobusi.stockman.monitor.web

import kotlin.math.round

fun nowMs(): Long = (js("Date.now()") as Double).toLong()

fun money(value: Double): Double = round(value * 100.0) / 100.0

fun percent(value: Double): Double = round(value * 100.0) / 100.0

fun samePrice(left: Double, right: Double): Boolean =
    kotlin.math.abs(left - right) < 0.001

fun Double.fmt(): String = asDynamic().toFixed(2) as String

fun formatTime(time: Long): String {
    val date = js("new Date(time)")
    return date.toLocaleTimeString("zh-CN") as String
}

fun formatSeconds(time: Long): String {
    val date = js("new Date(time * 1000)")
    return date.toLocaleTimeString("zh-CN") as String
}

fun formatLimitUpTime(time: Long?): String {
    val value = time ?: return ""
    if (value <= 0L) return ""
    if (value > 999999L) return formatSeconds(value)
    val text = value.toString().padStart(6, '0')
    return "${text.substring(0, 2)}:${text.substring(2, 4)}:${text.substring(4, 6)}"
}

fun todayDate(): String {
    val date = js("new Date()")
    val year = date.getFullYear()
    val month = (date.getMonth() + 1).toString().padStart(2, '0')
    val day = date.getDate().toString().padStart(2, '0')
    return "$year-$month-$day"
}

fun tradeDateKey(time: Long): String {
    val date = js("new Date()")
    date.setTime(time)
    val year = date.getFullYear().toString()
    val month = (date.getMonth() + 1).toString().padStart(2, '0')
    val day = date.getDate().toString().padStart(2, '0')
    return "$year$month$day"
}

fun isAfterKplLiveClose(): Boolean {
    val date = js("new Date()")
    val hour = date.getHours() as Int
    val minute = date.getMinutes() as Int
    return hour > 15 || (hour == 15 && minute >= 0)
}

fun isTradingTime(): Boolean {
    val date = js("new Date()")
    val day = date.getDay() as Int
    if (day == 0 || day == 6) return false
    val hour = date.getHours() as Int
    val minute = date.getMinutes() as Int
    val minutes = hour * 60 + minute
    return minutes >= 9 * 60 + 25 && minutes < 11 * 60 + 30 ||
        minutes >= 13 * 60 && minutes < 15 * 60
}
