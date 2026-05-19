package com.liaobusi.stockman.monitor

class Tracker {
    private val cache = mutableListOf<StockTick>()
    private val cacheSize = 80
    private val speedMonitorStrategy = SpeedMonitorStrategy()
    private var limitUpSealed = false
    private var limitDownSealed = false
    private var hasSeenLimitUp = false
    private var hasSeenLimitDown = false

    fun update(stock: StockTick): AlertEvent? {
        val eventTypes = mutableListOf<String>()
        val reasons = buildList {
            val currentLimitUpSealed = isLimitUpSealed(stock)
            val currentLimitDownSealed = isLimitDownSealed(stock)
            if (cache.isNotEmpty()) {
                if (currentLimitUpSealed && !limitUpSealed) {
                    add("[涨停]")
                    eventTypes += "LIMIT_UP"
                }
                if (hasSeenLimitUp && limitUpSealed && !currentLimitUpSealed) {
                    add("[炸板]")
                    eventTypes += "BREAK_LIMIT_UP"
                }
                if (currentLimitDownSealed && !limitDownSealed) {
                    add("[跌停]")
                    eventTypes += "LIMIT_DOWN"
                }
                if (hasSeenLimitDown && limitDownSealed && !currentLimitDownSealed) {
                    add("[翘板]")
                    eventTypes += "OPEN_LIMIT_DOWN"
                }
            }

            speedMonitorStrategy.evaluate(cache, stock).forEach { signal ->
                add(signal.reason)
                eventTypes += signal.eventType
            }
        }

        updateLimitState(stock)
        pushCache(stock)

        if (reasons.isEmpty()) return null

        return AlertEvent(
            code = stock.code,
            name = stock.name,
            title = "${stock.code}${stock.name}异动,涨跌幅${stock.chg}%",
            content = reasons.joinToString(" "),
            chg = stock.chg,
            price = stock.price,
            time = stock.time,
            reasons = reasons,
            eventTypes = eventTypes.distinct()
        )
    }

    private fun updateLimitState(stock: StockTick) {
        val currentLimitUpSealed = isLimitUpSealed(stock)
        val currentLimitDownSealed = isLimitDownSealed(stock)
        if (currentLimitUpSealed) hasSeenLimitUp = true
        if (currentLimitDownSealed) hasSeenLimitDown = true
        limitUpSealed = currentLimitUpSealed
        limitDownSealed = currentLimitDownSealed
    }

    private fun isLimitUpSealed(stock: StockTick): Boolean {
        return stock.price > 0.0 && stock.ztPrice > 0.0 && stock.price >= stock.ztPrice - PRICE_EPSILON
    }

    private fun isLimitDownSealed(stock: StockTick): Boolean {
        return stock.price > 0.0 && stock.dtPrice > 0.0 && stock.price <= stock.dtPrice + PRICE_EPSILON
    }

    private fun pushCache(stock: StockTick) {
        cache.add(stock)
        if (cache.size >= cacheSize) {
            cache.removeAt(0)
        }
    }

    private companion object {
        const val PRICE_EPSILON = 0.005
    }
}
