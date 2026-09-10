//! 错误分类器（渠道可靠性升级 · 错误行动化 F 项）。
//!
//! 对错误消息文本做大小写不敏感的子串匹配，输出稳定的错误类别，
//! 供前端展示行动化按钮（换渠道 / 查密钥 / 充值 / 修改提示词等）。
//!
//! 规则按序短路；Auth / Quota / ContentFilter 排在 ChannelDown 之前，
//! 避免数字状态码（401/402/403/429）被 5xx 规则误判。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    Timeout,
    ChannelDown,
    Auth,
    Quota,
    ContentFilter,
    Unknown,
}

impl ErrorClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorClass::Timeout => "timeout",
            ErrorClass::ChannelDown => "channel_down",
            ErrorClass::Auth => "auth",
            ErrorClass::Quota => "quota",
            ErrorClass::ContentFilter => "content_filter",
            ErrorClass::Unknown => "unknown",
        }
    }
}

/// Timeout 规则。除英文外补中文 "超时"（国产中转常见中文报错，
/// 且本侧 fail 路径会产出 "渠道响应超时 / 生成超时" 人话前缀）。
const TIMEOUT_RULES: &[&str] = &["timeout", "timed out", "deadline", "elapsed", "超时"];

/// Auth 规则。数字码 401/403 需在 ChannelDown 之前判定。
const AUTH_RULES: &[&str] = &[
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "invalid_api_key",
    "authentication",
];

/// Quota 规则。数字码 402/429 需在 ChannelDown 之前判定。
const QUOTA_RULES: &[&str] = &[
    "402",
    "429",
    "insufficient",
    "balance",
    "quota",
    "余额",
    "额度",
];

/// ContentFilter 规则。
const CONTENT_FILTER_RULES: &[&str] = &[
    "safety",
    "blocked",
    "prohibited",
    "content policy",
    "安全",
    "敏感",
];

/// ChannelDown 规则：连接失败 / DNS / 5xx 网关与上游不可达语境。
const CHANNEL_DOWN_RULES: &[&str] = &[
    "connect",
    "dns",
    "connection refused",
    "502",
    "503",
    "504",
    "524",
    "500",
    "internal server error",
    "bad gateway",
    "service unavailable",
    "upstream",
    "network",
];

fn matches_any(lowered: &str, rules: &[&str]) -> bool {
    rules.iter().any(|rule| lowered.contains(rule))
}

/// 按序短路分类错误消息。
pub fn classify_error_message(message: &str) -> ErrorClass {
    let lowered = message.to_lowercase();

    // 注：连续 poll 失败语境由调用方直接映射，不经本函数推断。
    if matches_any(&lowered, TIMEOUT_RULES) {
        return ErrorClass::Timeout;
    }
    if matches_any(&lowered, AUTH_RULES) {
        return ErrorClass::Auth;
    }
    if matches_any(&lowered, QUOTA_RULES) {
        return ErrorClass::Quota;
    }
    if matches_any(&lowered, CONTENT_FILTER_RULES) {
        return ErrorClass::ContentFilter;
    }
    if matches_any(&lowered, CHANNEL_DOWN_RULES) {
        return ErrorClass::ChannelDown;
    }

    ErrorClass::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_rules() {
        assert_eq!(classify_error_message("operation timed out"), ErrorClass::Timeout);
        assert_eq!(classify_error_message("request timeout after 300s"), ErrorClass::Timeout);
        assert_eq!(classify_error_message("渠道响应超时（已等待 10 分钟）"), ErrorClass::Timeout);
    }

    #[test]
    fn channel_down_rules() {
        assert_eq!(
            classify_error_message("error trying to connect: dns error"),
            ErrorClass::ChannelDown
        );
        assert_eq!(
            classify_error_message("KIE createTask failed 502 Bad Gateway"),
            ErrorClass::ChannelDown
        );
        assert_eq!(
            classify_error_message("upstream service unavailable"),
            ErrorClass::ChannelDown
        );
    }

    #[test]
    fn auth_rules() {
        assert_eq!(
            classify_error_message("OpenAI API error: 401 Unauthorized"),
            ErrorClass::Auth
        );
        assert_eq!(
            classify_error_message("invalid api key provided"),
            ErrorClass::Auth
        );
    }

    #[test]
    fn quota_rules() {
        assert_eq!(
            classify_error_message("429 Too Many Requests"),
            ErrorClass::Quota
        );
        assert_eq!(classify_error_message("账户余额不足"), ErrorClass::Quota);
    }

    #[test]
    fn content_filter_rules() {
        assert_eq!(
            classify_error_message("request blocked by content policy"),
            ErrorClass::ContentFilter
        );
        assert_eq!(classify_error_message("提示包含敏感内容"), ErrorClass::ContentFilter);
    }

    #[test]
    fn numeric_code_priority_over_channel_down() {
        // 402 是数字码，不能落进 ChannelDown 的 5xx 规则
        assert_eq!(
            classify_error_message("402 payment required"),
            ErrorClass::Quota
        );
        assert_eq!(
            classify_error_message("HTTP 403 forbidden by upstream"),
            ErrorClass::Auth
        );
    }

    #[test]
    fn unknown_fallback() {
        assert_eq!(classify_error_message("something odd happened"), ErrorClass::Unknown);
        assert_eq!(classify_error_message(""), ErrorClass::Unknown);
    }

    #[test]
    fn serde_snake_case_names() {
        assert_eq!(
            serde_json::to_string(&ErrorClass::ChannelDown).unwrap(),
            "\"channel_down\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorClass::ContentFilter).unwrap(),
            "\"content_filter\""
        );
    }
}
