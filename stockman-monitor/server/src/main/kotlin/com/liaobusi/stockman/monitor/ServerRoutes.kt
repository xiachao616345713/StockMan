package com.liaobusi.stockman.monitor

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import org.slf4j.Logger

fun Route.registerStatusRoutes(engine: MarketEngine) {
    get("/") {
        call.respond(
            mapOf(
                "name" to "StockMan Compose Monitor",
                "status" to "running",
                "database" to engine.database.path(),
                "dbViewer" to "http://localhost:8080/db"
            )
        )
    }
    get("/api/snapshot") {
        call.respond(engine.snapshot())
    }
    get("/api/stocks") {
        val codes = call.request.queryParameters["codes"].orEmpty()
            .split(',', ' ', '，')
            .map { it.trim() }
            .filter { it.length == 6 && it.all(Char::isDigit) }
            .toSet()
        call.respond(engine.stockTicks(codes))
    }
}

fun Route.registerMonitorRoutes(
    engine: MarketEngine,
    monitorSourceProxy: MonitorSourceProxy,
    logger: Logger
) {
    get("/api/monitor/config") {
        call.respond(engine.monitorConfig())
    }
    post("/api/monitor/config") {
        val request = call.receive<MonitorConfigRequest>()
        call.respond(engine.saveMonitorConfig(request))
    }
    get("/api/monitor/status") {
        call.respond(engine.monitorStatus())
    }
    post("/api/monitor/start") {
        call.respond(engine.startMonitor())
    }
    post("/api/monitor/stop") {
        call.respond(engine.stopMonitor())
    }
    get("/api/monitor/targets") {
        call.respond(engine.monitorTargets())
    }
    post("/api/monitor/follow") {
        call.respond(engine.upsertMonitorFollow(call.receive<MonitorFollowRequest>()))
    }
    post("/api/monitor/follow/remove") {
        val code = call.request.queryParameters["code"]?.trim().orEmpty()
        val type = call.request.queryParameters["type"]?.toIntOrNull() ?: 1
        call.respond(engine.removeMonitorFollow(code, type))
    }
    get("/api/monitor/follows") {
        call.respond(engine.monitorFollows())
    }
    post("/api/monitor/bk-stocks") {
        call.respond(engine.upsertBkStocks(call.receive<MonitorBkStocksRequest>()))
    }
    post("/api/monitor/unusual") {
        call.respond(engine.insertUnusualAction(call.receive<MonitorUnusualRequest>()))
    }
    post("/api/monitor/targets/refresh") {
        val date = call.request.queryParameters["date"]?.toIntOrNull()
            ?: ChinaMarketCalendar.currentRealtimeSnapshotDate()
        val pool = engine.syncLimitUpPool(date)
        runCatching { engine.syncKplLiveUnusual() }
            .onFailure { logger.warn("sync KPL unusual failed: {}", it.message) }
        val replay = runCatching { engine.syncZtReplay(date) }.getOrNull()
        call.respond(MonitorTargetsRefreshResult(pool, replay, engine.monitorTargets()))
    }
    get("/api/monitor/source/{id}") {
        val id = call.parameters["id"].orEmpty()
        runCatching {
            monitorSourceProxy.fetchMonitorSourcePayload(id)
        }.onSuccess {
            call.respondText(it, ContentType.Application.Json)
        }.onFailure {
            logger.warn("HTTP GET /api/monitor/source/{} failed: {}", id, it.message)
            call.respond(HttpStatusCode.BadRequest, mapOf("error" to (it.message ?: "source request failed")))
        }
    }
}

fun Route.registerSyncRoutes(engine: MarketEngine, logger: Logger) {
    get("/api/sync/status") {
        call.respond(engine.syncStatus())
    }
    get("/api/sync/history/status") {
        call.respond(engine.historySyncStatus())
    }
    get("/api/sync/history/progress") {
        call.respond(engine.historyStocksSyncProgress())
    }
    post("/api/sync/unusual/kpl") {
        runCatching {
            engine.syncKplLiveUnusual()
        }.onSuccess {
            call.respond(it)
        }.onFailure {
            logger.warn("HTTP POST /api/sync/unusual/kpl failed: {}", it.message)
            call.respond(HttpStatusCode.BadRequest, mapOf("error" to (it.message ?: "kpl unusual sync failed")))
        }
    }
    post("/api/sync/limit-up-pool") {
        val date = call.request.queryParameters["date"]?.toIntOrNull()
            ?: ChinaMarketCalendar.currentHistoryTargetDate()
        call.respond(engine.syncLimitUpPool(date))
    }
    post("/api/sync/zt-replay") {
        val date = call.request.queryParameters["date"]?.toIntOrNull()
            ?: ChinaMarketCalendar.currentHistoryTargetDate()
        call.respond(engine.syncZtReplay(date))
    }
    post("/api/sync/history/start") {
        val codes = call.request.queryParameters.getAll("code").orEmpty() +
            call.request.queryParameters["codes"].orEmpty().split(',').filter { it.isNotBlank() }
        val full = call.request.queryParameters["full"] == "true"
        logger.info("HTTP POST /api/sync/history/start codes={} full={}", codes.size, full)
        call.respond(engine.startHistoryStocksSync(codes = codes.map { it.trim() }.distinct(), full = full))
    }
    post("/api/sync/history/stop") {
        logger.info("HTTP POST /api/sync/history/stop")
        call.respond(engine.stopHistoryStocksSync())
    }
    post("/api/sync/stocks") {
        val source = call.request.queryParameters["source"]?.trim().orEmpty().ifBlank { "sina" }
        logger.info("HTTP POST /api/sync/stocks source={}", source)
        runCatching {
            engine.refreshRealtimeStocksNow(source)
        }.onSuccess {
            call.respond(it)
        }.onFailure {
            logger.warn("HTTP POST /api/sync/stocks failed: {}", it.message)
            call.respond(HttpStatusCode.InternalServerError, mapOf("error" to (it.message ?: "sync failed")))
        }
    }
    post("/api/sync/history") {
        val codes = call.request.queryParameters.getAll("code").orEmpty() +
            call.request.queryParameters["codes"].orEmpty().split(',').filter { it.isNotBlank() }
        logger.info("HTTP POST /api/sync/history codes={}", codes.size)
        runCatching {
            engine.syncHistoryStocksNow(codes = codes.map { it.trim() }.distinct())
        }.onSuccess {
            call.respond(it)
        }.onFailure {
            logger.warn("HTTP POST /api/sync/history failed: {}", it.message)
            call.respond(HttpStatusCode.InternalServerError, mapOf("error" to (it.message ?: "history sync failed")))
        }
    }
}

fun Route.registerDebugRoutes(monitorSourceProxy: MonitorSourceProxy, logger: Logger) {
    get("/api/debug/eastmoney/history") {
        val code = call.request.queryParameters["code"]?.trim().orEmpty().ifBlank { "300059" }
        val direct = call.request.queryParameters["direct"] == "true"
        val limit = call.request.queryParameters["limit"]?.toIntOrNull()?.coerceIn(1, 210) ?: 120
        val end = call.request.queryParameters["end"]?.trim().orEmpty().ifBlank { "20500000" }
        logger.info("HTTP GET /api/debug/eastmoney/history code={} direct={} limit={} end={}", code, direct, limit, end)
        call.respond(monitorSourceProxy.debugEastMoneyHistoryRequest(code, direct, limit, end))
    }
    get("/api/replay/kpl-live") {
        runCatching {
            monitorSourceProxy.fetchKplLivePayload()
        }.onSuccess {
            call.respondText(it, ContentType.Application.Json)
        }.onFailure {
            logger.warn("HTTP GET /api/replay/kpl-live failed: {}", it.message)
            call.respond(HttpStatusCode.BadRequest, mapOf("error" to (it.message ?: "kpl live request failed")))
        }
    }
}

fun Route.registerDatabaseRoutes(engine: MarketEngine) {
    get("/db") {
        call.respondText(dbViewerHtml(), ContentType.Text.Html)
    }
    get("/api/db/tables") {
        call.respond(DbTables(database = engine.database.path(), tables = engine.database.tableNames()))
    }
    get("/api/db/table/{name}") {
        val name = call.parameters["name"].orEmpty()
        val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 100
        val offset = call.request.queryParameters["offset"]?.toIntOrNull() ?: 0
        runCatching {
            engine.database.queryTable(name, limit, offset)
        }.onSuccess {
            call.respond(it)
        }.onFailure {
            call.respond(HttpStatusCode.BadRequest, mapOf("error" to (it.message ?: "bad request")))
        }
    }
    get("/api/history/{code}") {
        val code = call.parameters["code"].orEmpty()
        val limit = call.request.queryParameters["limit"]?.toIntOrNull()?.coerceAtLeast(1) ?: 210
        runCatching {
            engine.database.dailyLines(code, limit)
        }.onSuccess {
            call.respond(it)
        }.onFailure {
            call.respond(HttpStatusCode.BadRequest, mapOf("error" to (it.message ?: "bad request")))
        }
    }
    post("/api/tick") {
        val request = call.receive<ManualTickRequest>()
        val tick = engine.manualTick(request)
        if (tick == null) {
            call.respond(HttpStatusCode.BadRequest, mapOf("error" to "unknown code or empty tick"))
        } else {
            call.respond(tick)
        }
    }
}
