//! 画板生成图片自动上传公司阿里 OSS（批次11 · 全渠道统一一条路）。
//!
//! 出图成功后把结果图按 `{工程名}/{yyyy-MM}/{job_id}_{provider}_{裸模型名}.{ext}`
//! 归档到公司公共读桶，拿到桶直链永久 URL 供复制分享。
//!
//! 设计取舍 / 铁律：
//! - **纯 std 手写 SHA-1 / HMAC-SHA1 / IMF-fixdate HTTP-Date**：红线不新增 crate
//!   （现有依赖里没有 sha1/hmac/chrono），单测锁 RFC 3174 / RFC 2202 标准向量。
//! - **签名形态铁律（真实凭据 smoke 实证）**：请求 URL 用 percent-encoding 后的
//!   key（safe='/'，与 python `quote(key, safe="/")` 逐字节对齐），而签名
//!   resource 用**原始未编码** key——阿里服务端解码请求路径后按原始名重算签名，
//!   两者形态不一致必 403 SignatureDoesNotMatch。单测用哑密钥与 python 原型
//!   （image-studio 技能 `oss_v1_sign`）交叉验证的期望值锁死。
//! - **软失败**：任何失败 `tracing::warn!` 一行返回 None，绝不向上抛错——
//!   归档失败绝不影响出图（产品铁律）。
//! - **不覆盖语义**：先 HEAD 探测，404 才上传；200 视为已存在（job_id 是 UUID，
//!   实际只会是中断重试）直接返回该 URL；HEAD 网络错跳过本次归档。
//! - 密钥只存模块级 `RwLock<Option<OssConfig>>`，由 set_oss_config 命令注入
//!   （与 set_api_key 同哲学，Rust 不持久化密钥）。

use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};

/// 公司桶与 endpoint（主对话 smoke 实证的常量；对象 URL = 桶直链，不走画廊域名——
/// tu.jyounet.com 非浏览器 UA 会被 Cloudflare 1010 拦，不适合做分享直链）。
pub const OSS_BUCKET: &str = "juyou-meishu";
pub const OSS_ENDPOINT: &str = "oss-cn-hangzhou.aliyuncs.com";

/// HEAD 探测自身超时：桶不可达时尽快放弃，别拖住出图终态。
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
/// PUT 上传硬上限（tokio::time::timeout 包裹，任务书要求 60s）。
const PUT_TIMEOUT: Duration = Duration::from_secs(60);

// ──────────────────────────────────────────────────────────────────────
// 配置态（运行时注入，不持久化）
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct OssConfig {
    pub access_key: String,
    pub secret_key: String,
}

static OSS_CONFIG: RwLock<Option<OssConfig>> = RwLock::new(None);

/// 注入 / 清除凭据（空 ak 或空 sk = 关闭归档）。
pub fn set_oss_config(access_key: &str, secret_key: &str) {
    let ak = access_key.trim();
    let sk = secret_key.trim();
    let mut guard = OSS_CONFIG
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if ak.is_empty() || sk.is_empty() {
        *guard = None;
    } else {
        *guard = Some(OssConfig {
            access_key: ak.to_string(),
            secret_key: sk.to_string(),
        });
    }
}

/// 当前凭据快照；未配置返回 None（归档静默跳过）。
pub fn current_config() -> Option<OssConfig> {
    OSS_CONFIG
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

// ──────────────────────────────────────────────────────────────────────
// 纯 std SHA-1（RFC 3174）
// ──────────────────────────────────────────────────────────────────────

/// SHA-1 摘要（20 字节）。纯 std 实现，无外部依赖。
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let bit_len = (data.len() as u64).wrapping_mul(8);

    // padding: 0x80 + 0x00 至 56 mod 64，再补 8 字节大端位长。
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

// ──────────────────────────────────────────────────────────────────────
// 纯 std HMAC-SHA1（RFC 2104 / RFC 2202 向量）
// ──────────────────────────────────────────────────────────────────────

/// HMAC-SHA1（块大小 64 字节；key 超长先 hash）。
fn hmac_sha1(key: &[u8], data: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner = Vec::with_capacity(64 + data.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(data);
    let inner_hash = sha1(&inner);

    let mut outer = Vec::with_capacity(84);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha1(&outer)
}

// ──────────────────────────────────────────────────────────────────────
// RFC 7231 IMF-fixdate（SystemTime → "Fri, 12 Sep 2026 02:00:00 GMT"）
// ──────────────────────────────────────────────────────────────────────

/// 天数（自 1970-01-01）→ 公历年月日（Howard Hinnant civil_from_days 算法）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

const WEEKDAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Unix 秒 → IMF-fixdate（如 `Thu, 01 Jan 1970 00:00:00 GMT`）。
pub fn http_date_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    // 1970-01-01 是周四：周几 = (days + 4) mod 7（0 = 周日）。
    let weekday = WEEKDAY_NAMES[(days.rem_euclid(7) + 4).rem_euclid(7) as usize];
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        weekday,
        d,
        MONTH_NAMES[(m - 1) as usize],
        y,
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// 当前时刻的 IMF-fixdate。
pub fn http_date_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    http_date_from_unix(secs)
}

/// 任务创建时刻（UTC 毫秒）→ `yyyy-MM`（目录分段）。
pub fn utc_year_month(created_at_utc_ms: i64) -> String {
    let days = created_at_utc_ms.div_euclid(1_000).div_euclid(86_400);
    let (y, m, _) = civil_from_days(days);
    format!("{:04}-{:02}", y, m)
}

// ──────────────────────────────────────────────────────────────────────
// OSS V1 签名 / key 编码 / 目录与命名
// ──────────────────────────────────────────────────────────────────────

/// 阿里 OSS 经典 V1 签名（对齐 image-studio 技能 python 原型 `oss_v1_sign`）。
/// StringToSign = `VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedResource`。
/// 返回 (string_to_sign, base64(hmac_sha1(sk, sts)))。
pub fn oss_v1_sign(
    method: &str,
    secret_key: &str,
    date: &str,
    resource: &str,
    content_type: &str,
    content_md5: &str,
) -> (String, String) {
    let sts = format!("{method}\n{content_md5}\n{content_type}\n{date}\n{resource}");
    let mac = hmac_sha1(secret_key.as_bytes(), sts.as_bytes());
    (sts, STANDARD.encode(mac))
}

/// percent-encode key（safe='/'，与 python `quote(key, safe="/")` 逐字节对齐：
/// 保留 `A-Za-z0-9 - _ . ~ /`，其余按 UTF-8 字节转 %XX）。
pub fn oss_encode_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for byte in key.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 桶直链对象 URL（分享用永久链接）。
pub fn object_url(key: &str) -> String {
    format!("https://{}.{}/{}", OSS_BUCKET, OSS_ENDPOINT, oss_encode_key(key))
}

/// 工程名清洗（单一真相源，前端 TS 同规则）：`/` → `-`，去首尾空白与点号，
/// 空则兜底「未分类」。中文原样保留。
pub fn sanitize_project_name(raw: &str) -> String {
    let replaced = raw.replace('/', "-");
    let cleaned = replaced.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "未分类".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 归档对象 key：
/// `{工程名}/{yyyy-MM}/{job_id}_{provider}_{裸模型名}.{ext}`
/// 例：`游戏A/2026-09/job-a1b2c3d4_grsai_nano-banana-pro.png`。
pub fn build_object_key(
    project: &str,
    created_at_utc_ms: i64,
    job_id: &str,
    provider_id: &str,
    model: &str,
    ext: &str,
) -> String {
    let bare_model = model.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(model);
    format!(
        "{}/{}/{}_{}_{}.{}",
        sanitize_project_name(project),
        utc_year_month(created_at_utc_ms),
        job_id,
        provider_id,
        bare_model,
        ext
    )
}

// ──────────────────────────────────────────────────────────────────────
// 上传（HEAD 探测 → 签名 PUT；任何失败 warn 一行 → None）
// ──────────────────────────────────────────────────────────────────────

/// 上传失败分类（test_oss_archive 人话文案用；正常归档路径不区分）。
#[derive(Debug)]
pub enum OssUploadError {
    /// OSS 返回非预期 HTTP 状态（403 = 密钥/签名错）。
    Http(u16),
    /// 请求超时（PUT 60s 硬上限）。
    Timeout,
    /// 网络不可达 / 连接失败。
    Network(String),
}

/// 先 HEAD 探测（404 才传；200=已存在直接返回该 URL；HEAD 网络错 → None 跳过），
/// 再签名 PUT（tokio::time::timeout 60s）。任何失败 warn 一行返回 None，绝不向上抛错。
pub async fn upload_image(
    cfg: &OssConfig,
    key: &str,
    bytes: &[u8],
    content_type: &str,
) -> Option<String> {
    match upload_image_detail(cfg, key, bytes, content_type).await {
        Ok(url) => Some(url),
        Err(error) => {
            tracing::warn!(
                "OSS archive failed: {} ({:?}) — generation result unaffected",
                key,
                error
            );
            None
        }
    }
}

/// 同 `upload_image`，但保留错误分类（连通性测试命令用）。
pub async fn upload_image_detail(
    cfg: &OssConfig,
    key: &str,
    bytes: &[u8],
    content_type: &str,
) -> Result<String, OssUploadError> {
    let url = object_url(key);

    // HEAD 探测：不带鉴权（桶公共读，与 python 原型 / smoke 证据一致）。
    let head_future = crate::ai::http::http_client().head(&url).send();
    match tokio::time::timeout(HEAD_TIMEOUT, head_future).await {
        Err(_) => return Err(OssUploadError::Timeout),
        Ok(Ok(response)) => {
            let status = response.status().as_u16();
            if status == 200 {
                // 已存在（中断重试同 key）：直接返回该 URL，不重复上传。
                return Ok(url);
            }
            if status != 404 {
                return Err(OssUploadError::Http(status));
            }
        }
        Ok(Err(error)) => return Err(OssUploadError::Network(error.to_string())),
    }

    // 签名铁律：URL 用编码 key，签名 resource 用原始未编码 key。
    let date = http_date_now();
    let resource = format!("/{}/{}", OSS_BUCKET, key);
    let (_, signature) = oss_v1_sign("PUT", &cfg.secret_key, &date, &resource, content_type, "");

    let put_future = crate::ai::http::http_client()
        .put(&url)
        .header("Date", date)
        .header("Content-Type", content_type)
        .header("Authorization", format!("OSS {}:{}", cfg.access_key, signature))
        .body(bytes.to_vec())
        .send();

    match tokio::time::timeout(PUT_TIMEOUT, put_future).await {
        Err(_) => Err(OssUploadError::Timeout),
        Ok(Ok(response)) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                Ok(url)
            } else {
                Err(OssUploadError::Http(status))
            }
        }
        Ok(Err(error)) => Err(OssUploadError::Network(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // ── SHA-1：RFC 3174 标准向量 ─────────────────────────────────────

    #[test]
    fn sha1_rfc3174_vectors() {
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex(&sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            hex(&sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // 百万级输入跨多块处理（1M 'a'）。
        let million_a = vec![b'a'; 1_000_000];
        assert_eq!(
            hex(&sha1(&million_a)),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
    }

    // ── HMAC-SHA1：RFC 2202 标准向量 ────────────────────────────────

    #[test]
    fn hmac_sha1_rfc2202_vectors() {
        // Case 1: key = 0x0b × 20, data = "Hi There"
        assert_eq!(
            hex(&hmac_sha1(&[0x0b; 20], b"Hi There")),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
        // Case 2: key = "Jefe", data = "what do ya want for nothing?"
        assert_eq!(
            hex(&hmac_sha1(b"Jefe", b"what do ya want for nothing?")),
            "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"
        );
        // Case 3: key = 0xaa × 20, data = 0xdd × 50（期望值经 python hmac 复核）
        assert_eq!(
            hex(&hmac_sha1(&[0xaa; 20], &[0xdd; 50])),
            "125d7342b9ac11cd91a39af48aa17b4f63f175d3"
        );
        // Case 6: key = 0xaa × 80（超块长，key 先 hash）
        let data = b"Test Using Larger Than Block-Size Key - Hash Key First";
        assert_eq!(
            hex(&hmac_sha1(&[0xaa; 80], data)),
            "aa4ae5e15272d00e95705637ce8a3b55ed402112"
        );
        // Case 7: key = 0xaa × 80 + 超一块长 data（期望值经 python hmac 复核）
        let data = b"Test Using Larger Than Block-Size Key and Larger Than One Block-Size Data";
        assert_eq!(
            hex(&hmac_sha1(&[0xaa; 80], data)),
            "e8e99d0f45237d786d6bbaa7965c7808bbff1a91"
        );
    }

    // ── HTTP-Date：固定 epoch → 固定串 ──────────────────────────────

    #[test]
    fn http_date_fixed_epochs() {
        assert_eq!(http_date_from_unix(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        // 2026-09-12 是周六（python calendar 复核；任务书示例的 Fri 为笔误）。
        assert_eq!(
            http_date_from_unix(1_789_178_400),
            "Sat, 12 Sep 2026 02:00:00 GMT"
        );
        // 闰年 2 月 29 日。
        assert_eq!(
            http_date_from_unix(951_782_400),
            "Tue, 29 Feb 2000 00:00:00 GMT"
        );
    }

    #[test]
    fn utc_year_month_formats() {
        assert_eq!(utc_year_month(0), "1970-01");
        assert_eq!(utc_year_month(1_789_178_400_000), "2026-09");
        // 毫秒取整边界：当月最后一秒。
        assert_eq!(utc_year_month(1_789_178_400_999), "2026-09");
    }

    // ── OSS V1 签名：与 python 原型交叉验证（哑密钥，期望值由
    //    image_studio.oss_v1_sign 离线生成后写死）──────────────────────

    #[test]
    fn oss_v1_sign_matches_python_prototype() {
        let date = "Fri, 12 Sep 2026 02:00:00 GMT";
        // 向量 1：中文目录 key。
        let (sts, sig) = oss_v1_sign(
            "PUT",
            "dummy-sk",
            date,
            "/juyou-meishu/游戏A/2026-09/job-a1b2c3d4-e5f6_grsai_nano-banana-pro.png",
            "image/png",
            "",
        );
        assert_eq!(
            sts,
            "PUT\n\nimage/png\nFri, 12 Sep 2026 02:00:00 GMT\n/juyou-meishu/游戏A/2026-09/job-a1b2c3d4-e5f6_grsai_nano-banana-pro.png"
        );
        assert_eq!(sig, "1sqOkR3DcwYwOVCXfjGYgeh38iI=");

        // 向量 2：未分类 + 点开头的连通性测试 key。
        let (_, sig) = oss_v1_sign(
            "PUT",
            "dummy-sk-2",
            date,
            "/juyou-meishu/未分类/.connectivity-test-1726099200.png",
            "image/png",
            "",
        );
        assert_eq!(sig, "lyfRw2/PQk1KwMC719aacgK6ZGg=");
    }

    // ── key 编码 / 工程名清洗 / 命名 ────────────────────────────────

    #[test]
    fn oss_encode_key_keeps_slash_encodes_chinese() {
        assert_eq!(oss_encode_key("游戏A/2026-09/x.png"), "%E6%B8%B8%E6%88%8FA/2026-09/x.png");
        assert_eq!(oss_encode_key("abc/def-_~.png"), "abc/def-_~.png");
        assert_eq!(oss_encode_key("a b+c.png"), "a%20b%2Bc.png");
    }

    #[test]
    fn sanitize_project_name_rules() {
        assert_eq!(sanitize_project_name("游戏A"), "游戏A");
        assert_eq!(sanitize_project_name("游戏/A"), "游戏-A");
        assert_eq!(sanitize_project_name("  我的项目 . "), "我的项目");
        assert_eq!(sanitize_project_name("..点号工程.."), "点号工程");
        assert_eq!(sanitize_project_name(""), "未分类");
        assert_eq!(sanitize_project_name("   "), "未分类");
        assert_eq!(sanitize_project_name(" . "), "未分类");
    }

    #[test]
    fn build_object_key_layout() {
        // 2026-09 的任务（created_at UTC ms）。
        let key = build_object_key(
            "游戏A",
            1_789_178_400_000,
            "job-a1b2c3d4-e5f6",
            "grsai",
            "grsai/nano-banana-pro",
            "png",
        );
        assert_eq!(key, "游戏A/2026-09/job-a1b2c3d4-e5f6_grsai_nano-banana-pro.png");

        // 工程名带斜杠 / 空工程兜底 / 无前缀裸模型。
        assert_eq!(
            build_object_key("a/b", 0, "job", "p", "q/m.png-model", "png"),
            "a-b/1970-01/job_p_m.png-model.png"
        );
        assert_eq!(
            build_object_key("", 0, "job", "p", "m", "webp"),
            "未分类/1970-01/job_p_m.webp"
        );
    }

    // ── 配置态注入 / 清除 ───────────────────────────────────────────

    #[test]
    fn set_and_clear_config() {
        set_oss_config("dummy-ak-for-config-test", "dummy-sk");
        let cfg = current_config().expect("config should be set");
        assert_eq!(cfg.access_key, "dummy-ak-for-config-test");

        // 空 sk = 关闭归档。
        set_oss_config("dummy-ak-for-config-test", "");
        assert!(current_config().is_none());
        // 恢复空态，避免影响其他依赖全局态的逻辑（本模块测试内自洽）。
        set_oss_config("", "");
        assert!(current_config().is_none());
    }
}
