//! 全局共享 HTTP 客户端（渠道可靠性升级 · 超时治理根基）。
//!
//! 所有 provider 与 AI 相关命令统一使用本客户端，避免逐处 `Client::new()`
//! 产生无超时请求导致"无限等待"。个别 provider 若有更长时限需求，
//! 后续单独覆盖（参考 grsai 4K 实测 ~177s，300s 留足余量）。

use std::sync::OnceLock;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 单请求总超时：对齐实测 grsai 4K 177s 等长任务并留余量。
const TOTAL_TIMEOUT: Duration = Duration::from_secs(300);

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 进程级单例 reqwest 客户端（内部 Arc，clone 廉价）。
pub fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .build()
            .expect("failed to build global reqwest client")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_client_is_singleton() {
        let a: *const reqwest::Client = http_client();
        let b: *const reqwest::Client = http_client();
        assert_eq!(a, b);
    }
}
