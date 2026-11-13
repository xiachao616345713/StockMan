/**
 * A 股市场相关工具：交易时段判断、代码 → 东财 secid 映射、板块归属、缓存 TTL 选择。
 *
 * 映射规则来源：
 * - app 端 StockRepo.eastMoneyStockSecId（secid 市场前缀）
 * - docs/stock-data-apis/README.md「东财 secid 市场前缀」
 * - CLAUDE.md「Board Types」
 *
 * 交易时段窗口（默认 09:15–15:05）自 v1.4.0 起取自 config.server（可在设置页调整）。
 */

import { getGroup } from './config.js';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

/** 返回上海时区当前时间的各字段 */
function shanghaiParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: SHANGHAI_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
        hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour: Number(get('hour')),
        minute: Number(get('minute')),
        second: Number(get('second')),
        weekday: get('weekday'), // Mon/Tue/...
    };
}

/**
 * 当前是否处于 A 股交易时段（宽松判断：周一至周五 + config.server 配置的时间窗，不含节假日识别）。
 * 仅用于选择缓存 TTL，判断偏差无业务风险。
 *
 * @returns {boolean}
 */
export function isTradingTime() {
    const now = shanghaiParts();
    if (now.weekday === 'Sat' || now.weekday === 'Sun') {
        return false;
    }
    const { tradingStart, tradingEnd } = getGroup('server');
    const toMinutes = (hhmm) => {
        const [hours, minutes] = String(hhmm).split(':').map(Number);
        return hours * 60 + minutes;
    };
    const minutes = now.hour * 60 + now.minute;
    return minutes >= toMinutes(tradingStart) && minutes <= toMinutes(tradingEnd);
}

/**
 * 距下一个交易日开盘的秒数（config.server.tradingStart，周一至周五，不识别节假日）。
 * 收盘后缓存 TTL 的上界（v1.6.0，见 docs/design.md D19）：收盘后数据静态可长缓存，
 * 但必须在下一个交易日开盘前过期——否则周一盘前会命中上周五的旧快照（行情尚未刷新）。
 *
 * 上海时区固定 UTC+8（无夏令时）：目标日开盘时刻 = Date.UTC(y, m-1, d, startH - 8, startM)。
 *
 * @param {Date} [from] 参考时间（可注入用于测试）
 * @returns {number} 剩余秒数（至少 60，避免产生零 TTL）
 */
export function secondsUntilNextTradingStart(from = new Date()) {
    const now = shanghaiParts(from);
    const { tradingStart } = getGroup('server');
    const [startHour, startMinute] = String(tradingStart).split(':').map(Number);
    const nowMinutes = now.hour * 60 + now.minute + now.second / 60;
    const startMinutes = startHour * 60 + startMinute;
    const isWeekend = (date) => {
        const weekday = shanghaiParts(date).weekday;
        return weekday === 'Sat' || weekday === 'Sun';
    };
    // 工作日且尚未到今日开盘 → 目标为今天；否则（已过开盘/周末）→ 向后找最近的工作日
    let advanceDays = 0;
    if (isWeekend(from) || nowMinutes >= startMinutes) {
        advanceDays = 1;
        while (isWeekend(new Date(from.getTime() + advanceDays * 86_400_000))) {
            advanceDays += 1;
        }
    }
    // Date.UTC 自动归一化 day+advanceDays 的跨月/跨年
    const openEpochMs = Date.UTC(now.year, now.month - 1, now.day + advanceDays, startHour - 8, startMinute);
    return Math.max(60, Math.round((openEpochMs - from.getTime()) / 1000));
}

/** 上海时区今天的 yyyyMMdd（涨停池/复盘接口的 date 参数默认值） */
export function todayYyyymmdd() {
    const now = shanghaiParts();
    return `${now.year}${String(now.month).padStart(2, '0')}${String(now.day).padStart(2, '0')}`;
}

/** 上海时区今天的 yyyy-MM-dd */
export function todayIsoDate() {
    const now = shanghaiParts();
    return `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
}

const SHENZHEN_PREFIXES = ['000', '001', '002', '003', '300', '301', '43', '82', '83', '87', '88', '92'];

/**
 * 6 位股票代码 → 东财 secid（与 app 端 eastMoneyStockSecId 一致）
 *
 * @param {string} code 6 位代码
 * @returns {string} 形如 `1.600000` / `0.000001`
 */
export function secIdForStock(code) {
    const isShenzhen = SHENZHEN_PREFIXES.some((prefix) => code.startsWith(prefix));
    return `${isShenzhen ? 0 : 1}.${code}`;
}

/**
 * 判断板块归属（用于前端展示标签）
 *
 * @param {string} code 6 位代码
 * @param {string} name 股票名称
 * @returns {string} 主板 / 创业板 / 科创板 / 北交所 / ST
 */
export function boardNameOf(code, name) {
    if (name && (name.startsWith('ST') || name.startsWith('*ST') || name.includes('退'))) {
        return 'ST';
    }
    if (code.startsWith('688') || code.startsWith('689')) {
        return '科创板';
    }
    if (code.startsWith('300') || code.startsWith('301')) {
        return '创业板';
    }
    if (['43', '82', '83', '87', '88', '92'].some((prefix) => code.startsWith(prefix))) {
        return '北交所';
    }
    return '主板';
}

/**
 * 涨跌停幅度（%）：主板 10、创业板/科创板 20、ST 5、北交所 30
 *
 * @param {string} code 6 位代码
 * @param {string} name 股票名称
 * @returns {number}
 */
export function limitPctOf(code, name) {
    if (name && (name.startsWith('ST') || name.startsWith('*ST'))) {
        return 5;
    }
    if (code.startsWith('300') || code.startsWith('301') || code.startsWith('688') || code.startsWith('689')) {
        return 20;
    }
    if (['43', '82', '83', '87', '88', '92'].some((prefix) => code.startsWith(prefix))) {
        return 30;
    }
    return 10;
}
