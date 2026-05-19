package com.liaobusi.stockman.monitor.web

data class ClientAlertCandidate(
    val stock: StockTick,
    val events: List<ClientAlertSignal>
) {
    val eventTypes: List<String> get() = events.map { it.eventType }

    fun toAlert(
        allowedTypes: List<String>,
        sources: List<String>,
        replay: ZtReplayItem?
    ): AlertEvent {
        val allowed = events.filter { it.eventType in allowedTypes }
        val reasons = allowed.map { it.reason }
        val types = allowed.map { it.eventType }.distinct()
        return AlertEvent(
            code = stock.code,
            name = stock.name,
            title = "${stock.code}${stock.name}异动,涨跌幅${stock.chg.fmt()}%",
            content = reasons.joinToString(" "),
            chg = stock.chg,
            price = stock.price,
            time = stock.time,
            reasons = reasons,
            sources = sources,
            eventTypes = types,
            replay = replay
        )
    }
}

data class ClientAlertSignal(
    val eventType: String,
    val reason: String
)

class ClientMonitorTracker {
    private val cache = mutableListOf<StockTick>()
    private val speedStrategy = ClientSpeedMonitorStrategy()
    private var limitUpSealed = false
    private var limitDownSealed = false
    private var hasSeenLimitUp = false
    private var hasSeenLimitDown = false

    fun update(stock: StockTick): ClientAlertCandidate? {
        val events = mutableListOf<ClientAlertSignal>()
        val currentLimitUpSealed = isLimitUpSealed(stock)
        val currentLimitDownSealed = isLimitDownSealed(stock)

        if (cache.isNotEmpty()) {
            if (currentLimitUpSealed && !limitUpSealed) {
                events += ClientAlertSignal("LIMIT_UP", "[涨停]")
            }
            if (hasSeenLimitUp && limitUpSealed && !currentLimitUpSealed) {
                events += ClientAlertSignal("BREAK_LIMIT_UP", "[炸板]")
            }
            if (currentLimitDownSealed && !limitDownSealed) {
                events += ClientAlertSignal("LIMIT_DOWN", "[跌停]")
            }
            if (hasSeenLimitDown && limitDownSealed && !currentLimitDownSealed) {
                events += ClientAlertSignal("OPEN_LIMIT_DOWN", "[翘板]")
            }
            events += speedStrategy.evaluate(cache, stock)
        }

        if (currentLimitUpSealed) hasSeenLimitUp = true
        if (currentLimitDownSealed) hasSeenLimitDown = true
        limitUpSealed = currentLimitUpSealed
        limitDownSealed = currentLimitDownSealed
        cache += stock
        if (cache.size > 80) cache.removeAt(0)
        return events.takeIf { it.isNotEmpty() }?.let { ClientAlertCandidate(stock, it) }
    }

    private fun isLimitUpSealed(stock: StockTick): Boolean {
        return stock.price > 0.0 && stock.ztPrice > 0.0 && stock.price >= stock.ztPrice - PRICE_EPSILON
    }

    private fun isLimitDownSealed(stock: StockTick): Boolean {
        return stock.price > 0.0 && stock.dtPrice > 0.0 && stock.price <= stock.dtPrice + PRICE_EPSILON
    }

    private companion object {
        const val PRICE_EPSILON = 0.005
    }
}

private class ClientSpeedMonitorStrategy {
    private val windows = listOf(
        ClientSpeedWindow(0..15, 0.5),
        ClientSpeedWindow(15..60, 1.0),
        ClientSpeedWindow(61..90, 1.5),
        ClientSpeedWindow(91..180, 2.0)
    )

    fun evaluate(cache: List<StockTick>, current: StockTick): List<ClientAlertSignal> {
        if (cache.isEmpty()) return emptyList()
        return buildList {
            windows.forEach { window ->
                bestRiseSignal(cache, current, window)?.let { add(it) }
                bestDropSignal(cache, current, window)?.let { add(it) }
            }
        }
    }

    private fun bestRiseSignal(cache: List<StockTick>, current: StockTick, window: ClientSpeedWindow): ClientAlertSignal? {
        val anchor = bestAnchor(cache, current, window) { previous -> current.chg - previous.chg } ?: return null
        val seconds = elapsedSeconds(current, anchor)
        val delta = current.chg - anchor.chg
        if (delta < window.minDeltaChg) return null
        return ClientAlertSignal(
            eventType = "SPIKE",
            reason = "${seconds}秒内涨速+${delta.fmt()}% (${anchor.chg.fmt()}%→${current.chg.fmt()}%)"
        )
    }

    private fun bestDropSignal(cache: List<StockTick>, current: StockTick, window: ClientSpeedWindow): ClientAlertSignal? {
        val anchor = bestAnchor(cache, current, window) { previous -> previous.chg - current.chg } ?: return null
        val seconds = elapsedSeconds(current, anchor)
        val delta = anchor.chg - current.chg
        if (delta < window.minDeltaChg) return null
        return ClientAlertSignal(
            eventType = "DROP",
            reason = "${seconds}秒内跌速-${delta.fmt()}% (${anchor.chg.fmt()}%→${current.chg.fmt()}%)"
        )
    }

    private fun bestAnchor(
        cache: List<StockTick>,
        current: StockTick,
        window: ClientSpeedWindow,
        score: (StockTick) -> Double
    ): StockTick? {
        var best: StockTick? = null
        var bestScore = Double.NEGATIVE_INFINITY
        cache.forEach { previous ->
            if (elapsedSeconds(current, previous) !in window.secondsRange) return@forEach
            val value = score(previous)
            if (value > bestScore) {
                best = previous
                bestScore = value
            }
        }
        return best
    }

    private fun elapsedSeconds(current: StockTick, previous: StockTick): Int {
        return ((current.time - previous.time) / 1000).toInt().coerceAtLeast(0)
    }
}

private data class ClientSpeedWindow(
    val secondsRange: IntRange,
    val minDeltaChg: Double
)
