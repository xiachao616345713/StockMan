package com.liaobusi.stockman.monitor

import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.logging.HttpLoggingInterceptor
import org.slf4j.LoggerFactory
import java.net.InetAddress
import java.net.Proxy
import java.time.LocalDate
import java.util.concurrent.TimeUnit

class MonitorSourceProxy {
    private val logger = LoggerFactory.getLogger(MonitorSourceProxy::class.java)
    private val okHttpLogger = LoggerFactory.getLogger("OkHttp")
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    fun fetchKplLivePayload(): String {
        val body = FormBody.Builder()
            .add("a", "ZhiBoContent")
            .add("apiv", "w42")
            .add("c", "ConceptionPoint")
            .add("PhoneOSNew", "1")
            .add("DeviceID", "598d905194133b9e")
            .add("VerSion", "5.21.0.2")
            .add("index", "0")
            .build()
        val request = Request.Builder()
            .url("https://apphwhq.longhuvip.com/w1/api/index.php")
            .post(body)
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("HTTP ${response.code}: ${text.take(120)}")
            validateJsonPayload(text)
            return text
        }
    }

    fun fetchMonitorSourcePayload(id: String): String {
        val url = when (id) {
            "em-popularity" -> "https://data.eastmoney.com/dataapi/xuangu/list?st=POPULARITY_RANK&sr=1&ps=300&p=1&sty=SECUCODE%2CSECURITY_CODE%2CSECURITY_NAME_ABBR%2CPOPULARITY_RANK&filter=(POPULARITY_RANK%3E0)(POPULARITY_RANK%3C%3D1000)&source=SELECT_SECURITIES&client=WEB"
            "ths-hot" -> "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal"
            "dzh-hot" -> "https://imsearch.dzh.com.cn/stock/top?size=300&type=0&time=h"
            "cls-hot" -> "https://api3.cls.cn/v1/hot_stock?app=cailianpress&os=android&sv=850&sign=e4d8f886f269874b1578fec645b258fa"
            "tgb-hot" -> "https://www.tgb.cn/new/nrnt/getNoticeStock?type=D"
            "em-lhb" -> {
                val date = LocalDate.now().toString()
                "https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=SECURITY_CODE%2CTRADE_DATE&sortTypes=1%2C-1&pageSize=100&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=SECURITY_CODE%2CSECUCODE%2CSECURITY_NAME_ABBR%2CTRADE_DATE%2CEXPLAIN%2CCLOSE_PRICE%2CCHANGE_RATE%2CBILLBOARD_NET_AMT%2CBILLBOARD_BUY_AMT%2CBILLBOARD_SELL_AMT%2CBILLBOARD_DEAL_AMT%2CACCUM_AMOUNT%2CDEAL_NET_RATIO%2CDEAL_AMOUNT_RATIO%2CTURNOVERRATE%2CFREE_MARKET_CAP%2CEXPLANATION%2CD1_CLOSE_ADJCHRATE%2CD2_CLOSE_ADJCHRATE%2CD5_CLOSE_ADJCHRATE%2CD10_CLOSE_ADJCHRATE%2CSECURITY_TYPE_CODE&source=WEB&client=WEB&filter=(TRADE_DATE%3C%3D%27$date%27)(TRADE_DATE%3E%3D%27$date%27)"
            }
            "ths-lhb" -> {
                val date = LocalDate.now().toString()
                "https://data.10jqka.com.cn/dataapi/transaction/stock/v1/list?order_field=hot_rank&order_type=asc&date=$date&filter=&page=1&size=50&module=all&order_null_greater=1"
            }
            else -> error("unknown monitor source: $id")
        }
        return if (id == "tgb-hot") fetchTgbPayload(url) else fetchPayloadOnce(url, null)
    }

    fun debugEastMoneyHistoryRequest(
        code: String,
        direct: Boolean,
        limit: Int,
        end: String
    ): EastMoneyDebugResult {
        val secId = "${marketId(code)}.$code"
        val url = "http://push2his.eastmoney.com/api/qt/stock/kline/get" +
            "?secid=$secId" +
            "&klt=101" +
            "&fqt=1" +
            "&lmt=$limit" +
            "&end=$end" +
            "&iscca=1" +
            "&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6%2Cf7%2Cf8" +
            "&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61%2Cf62%2Cf63%2Cf64" +
            "&forcect=1"
        val hosts = runCatching {
            InetAddress.getAllByName("push2his.eastmoney.com").map { it.hostAddress }
        }.getOrElse { listOf("DNS failed: ${it.message ?: it::class.simpleName}") }
        val okHttpMessages = mutableListOf<String>()
        val debugClient = eastMoneyDebugClient(direct, okHttpMessages)
        val startedAt = System.currentTimeMillis()
        return runCatching {
            val request = Request.Builder()
                .url(url)
                .get()
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7")
                .header("Accept-Language", "en,zh;q=0.9,zh-CN;q=0.8")
                .header("Referer", "https://quote.eastmoney.com/")
                .header("Cookie", "st_nvi=WkClJtdsBAc4v9Iv-o1Vqcd0f; qgqp_b_id=0f78fd1076cc3135031c17e0f4166b39; nid18=0f7dba095cf921233ab46a9996b57d04; nid18_create_time=1777287090132; gviem=o73csaPU-xf80kF99diWT2fa9; gviem_create_time=1777287090132; websitepoptg_api_time=1777435139298; quote_lt=1; st_pvi=56099489576103; st_sp=2025-08-14%2010%3A02%3A05; st_inirUrl=https%3A%2F%2Fwww.baidu.com%2Flink")
                .header("DNT", "1")
                .header("Proxy-Connection", "keep-alive")
                .header("Upgrade-Insecure-Requests", "1")
                .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
                .build()
            debugClient.newCall(request).execute().use {
                val body = it.body?.string().orEmpty()
                EastMoneyDebugResult(
                    code = code,
                    secId = secId,
                    direct = direct,
                    url = url,
                    resolvedHosts = hosts,
                    httpCode = it.code,
                    success = it.isSuccessful && body.contains("\"klines\""),
                    elapsedMs = System.currentTimeMillis() - startedAt,
                    contentLength = body.length.toLong(),
                    bodyPreview = body.take(600),
                    okHttpLog = okHttpMessages.joinToString("\n")
                )
            }
        }.getOrElse {
            EastMoneyDebugResult(
                code = code,
                secId = secId,
                direct = direct,
                url = url,
                resolvedHosts = hosts,
                success = false,
                elapsedMs = System.currentTimeMillis() - startedAt,
                okHttpLog = okHttpMessages.joinToString("\n"),
                error = "${it::class.qualifiedName}: ${it.message}"
            )
        }
    }

    private fun fetchTgbPayload(url: String): String {
        val firstRequest = monitorSourceRequest(url, null)
        client.newCall(firstRequest).execute().use { firstResponse ->
            val firstText = firstResponse.body?.string().orEmpty()
            if (firstResponse.isSuccessful && firstText.trimStart().startsWith("{")) return firstText
            val cookie = firstResponse.headers("Set-Cookie")
                .firstOrNull { it.startsWith("acw_tc=") }
                ?.substringBefore(';')
            if (cookie.isNullOrBlank()) {
                error("淘股吧接口失败: HTTP ${firstResponse.code}")
            }
            return fetchPayloadOnce(url, cookie)
        }
    }

    private fun fetchPayloadOnce(url: String, cookie: String?): String {
        val request = monitorSourceRequest(url, cookie)
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("HTTP ${response.code}: ${text.take(120)}")
            validateJsonPayload(text)
            return text
        }
    }

    private fun monitorSourceRequest(url: String, cookie: String?): Request {
        val builder = Request.Builder()
            .url(url)
            .get()
            .header("User-Agent", "Mozilla/5.0")
            .header("Accept", "application/json,text/plain,*/*")
            .header("Referer", refererForMonitorSource(url))
        if (!cookie.isNullOrBlank()) {
            builder.header("Cookie", cookie)
        }
        return builder.build()
    }

    private fun refererForMonitorSource(url: String): String {
        return when {
            "eastmoney.com" in url -> "https://data.eastmoney.com/"
            "10jqka.com.cn" in url -> "https://data.10jqka.com.cn/"
            "cls.cn" in url -> "https://www.cls.cn/"
            "tgb.cn" in url || "taoguba.com.cn" in url -> "https://www.tgb.cn/"
            "dzh.com.cn" in url -> "https://www.dzh.com.cn/"
            else -> "https://localhost/"
        }
    }

    private fun validateJsonPayload(text: String) {
        if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
            error("非 JSON 响应: ${text.take(120)}")
        }
    }

    private fun marketId(code: String): Int {
        return when {
            code.startsWith("000") || code.startsWith("001") || code.startsWith("002") || code.startsWith("003") -> 0
            code.startsWith("30") -> 0
            code.startsWith("43") || code.startsWith("82") || code.startsWith("83") ||
                code.startsWith("87") || code.startsWith("88") || code.startsWith("92") -> 0
            else -> 1
        }
    }

    private fun eastMoneyDebugClient(direct: Boolean, messages: MutableList<String>): OkHttpClient {
        val loggingInterceptor = HttpLoggingInterceptor { message ->
            messages += message
            okHttpLogger.info(message)
        }.setLevel(HttpLoggingInterceptor.Level.BODY)
        return OkHttpClient.Builder()
            .addInterceptor(loggingInterceptor)
            .apply {
                if (direct) proxy(Proxy.NO_PROXY)
            }
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
