package com.liaobusi.stockman.monitor

@kotlinx.serialization.Serializable
data class DbTable(
    val name: String,
    val total: Int,
    val columns: List<String>,
    val rows: List<Map<String, String>>
)

@kotlinx.serialization.Serializable
data class DbTables(
    val database: String,
    val tables: List<String>
)

@kotlinx.serialization.Serializable
data class SyncStatus(
    val database: String,
    val stockCount: Int,
    val historyCount: Int,
    val lastStockSyncDate: Int?,
    val lastStockSyncTime: Long?,
    val lastStockSyncCount: Int?,
    val lastStockSyncSource: String?,
    val lastStockSyncSlot: String?
)

@kotlinx.serialization.Serializable
data class DailyLine(
    val date: Int,
    val closePrice: Double,
    val openPrice: Double,
    val highest: Double,
    val lowest: Double,
    val chg: Double,
    val averagePrice: Double
)

@kotlinx.serialization.Serializable
data class DailyLineResponse(
    val code: String,
    val name: String,
    val lines: List<DailyLine>
)

@kotlinx.serialization.Serializable
data class HistorySyncStatus(
    val database: String,
    val historyCount: Int,
    val pendingHistorySyncCount: Int,
    val lastHistorySyncTime: Long?,
    val lastHistorySyncDate: Int?,
    val lastHistorySyncCount: Int?,
    val lastHistorySyncStockCount: Int?,
    val lastHistorySyncRequestedStockCount: Int?,
    val lastHistorySyncSource: String?
)

data class StockRef(
    val code: String,
    val name: String,
    val toMarketTime: Int
)

data class SyncedStock(
    val code: String,
    val name: String,
    val price: Double,
    val chg: Double,
    val amplitude: Double,
    val turnoverRate: Double,
    val highest: Double,
    val lowest: Double,
    val circulationMarketValue: Double,
    val toMarketTime: Int,
    val openPrice: Double,
    val yesterdayClosePrice: Double,
    val ztPrice: Double,
    val dtPrice: Double,
    val averagePrice: Double,
    val bk: String
) {
    fun toHistory(date: Int): SyncedHistoryStock = SyncedHistoryStock(
        code = code,
        date = date,
        closePrice = price,
        openPrice = openPrice,
        highest = highest,
        lowest = lowest,
        chg = chg,
        amplitude = amplitude,
        turnoverRate = turnoverRate,
        ztPrice = ztPrice,
        dtPrice = dtPrice,
        yesterdayClosePrice = yesterdayClosePrice,
        averagePrice = averagePrice
    )
}

data class SyncedHistoryStock(
    val code: String,
    val date: Int,
    val closePrice: Double,
    val openPrice: Double,
    val highest: Double,
    val lowest: Double,
    val chg: Double,
    val amplitude: Double,
    val turnoverRate: Double,
    val ztPrice: Double,
    val dtPrice: Double,
    val yesterdayClosePrice: Double,
    val averagePrice: Double
)

enum class HistoryCodeSyncStatus {
    SUCCESS,
    FAILED,
    PENDING
}

data class HistoryCodeSyncResult(
    val code: String,
    val name: String,
    val status: HistoryCodeSyncStatus,
    val source: String,
    val rowCount: Int,
    val message: String,
    val startDate: Int,
    val endDate: Int
)

@kotlinx.serialization.Serializable
data class HistorySyncProgress(
    val running: Boolean = false,
    val stopRequested: Boolean = false,
    val total: Int = 0,
    val completed: Int = 0,
    val success: Int = 0,
    val failed: Int = 0,
    val currentCode: String = "",
    val currentName: String = "",
    val currentSource: String = "",
    val lastMessage: String = "",
    val startedAt: Long? = null,
    val endedAt: Long? = null
)
