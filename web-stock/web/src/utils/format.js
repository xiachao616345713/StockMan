/**
 * 数值格式化工具（价格/百分比/金额/成交量/市值）。
 * null 一律显示 '-'。
 */

const FALLBACK = '-';

/**
 * 涨跌方向的 CSS class（中国惯例：红涨绿跌）
 *
 * @param {number|null} value 涨跌幅或涨跌额
 * @returns {'up'|'down'|'flat'}
 */
export function trendClass(value) {
    if (value === null || value === undefined) {
        return 'flat';
    }
    if (value > 0) {
        return 'up';
    }
    return value < 0 ? 'down' : 'flat';
}

/** 价格：固定 2 位小数 */
export function fmtPrice(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    return Number(value).toFixed(2);
}

/** 比率类数值（市盈率/市净率/量比）：固定 2 位小数 */
export function fmtRatio(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    return Number(value).toFixed(2);
}

/** 普通数值 → 取整千分位（热度值等） */
export function fmtInt(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    return Math.round(Number(value)).toLocaleString('en-US');
}

/** 带符号数值（涨跌额等） */
export function fmtSigned(value, digits = 2) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    const num = Number(value);
    return `${num > 0 ? '+' : ''}${num.toFixed(digits)}`;
}

/** 百分比：带符号 + % 后缀 */
export function fmtPct(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    return `${fmtSigned(value)}%`;
}

/**
 * 金额（元）→ 自动 亿/万
 */
export function fmtAmount(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    const abs = Math.abs(value);
    if (abs >= 1e8) {
        return `${(value / 1e8).toFixed(2)}亿`;
    }
    if (abs >= 1e4) {
        return `${(value / 1e4).toFixed(2)}万`;
    }
    return value.toFixed(0);
}

/**
 * 成交量（手）→ 自动 亿手/万手
 */
export function fmtVolume(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    const abs = Math.abs(value);
    if (abs >= 1e8) {
        return `${(value / 1e8).toFixed(2)}亿手`;
    }
    if (abs >= 1e4) {
        return `${(value / 1e4).toFixed(2)}万手`;
    }
    return `${value.toFixed(0)}手`;
}

/**
 * 市值（元）→ 亿元
 */
export function fmtMarketValue(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    return `${(value / 1e8).toFixed(1)}亿`;
}

/**
 * 股数（封单量等）→ 自动 亿股/万股
 */
export function fmtShares(value) {
    if (value === null || value === undefined) {
        return FALLBACK;
    }
    const abs = Math.abs(value);
    if (abs >= 1e8) {
        return `${(value / 1e8).toFixed(2)}亿股`;
    }
    if (abs >= 1e4) {
        return `${(value / 1e4).toFixed(2)}万股`;
    }
    return `${value.toFixed(0)}股`;
}

/** yyyyMMdd 数字 → yyyy-MM-dd */
export function fmtDate8(value) {
    if (!value) {
        return FALLBACK;
    }
    const str = String(value);
    if (str.length !== 8) {
        return str;
    }
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}

/** ISO 时间字符串 → 本地 HH:mm:ss */
export function fmtClock(isoString) {
    if (!isoString) {
        return FALLBACK;
    }
    return new Date(isoString).toLocaleTimeString('zh-CN', { hour12: false });
}
