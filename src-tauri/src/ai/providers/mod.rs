use std::sync::Arc;

use super::AIProvider;

pub mod ppio;
pub mod grsai;
pub mod kie;
pub mod fal;
pub mod api666;
pub mod juyouapi;
pub mod ollama;
pub mod agnes;

pub use agnes::AgnesProvider;
pub use fal::FalProvider;
pub use grsai::GrsaiProvider;
pub use kie::KieProvider;
pub use ppio::PPIOProvider;
pub use api666::Api666Provider;
pub use juyouapi::ApiJuyouProvider;
pub use ollama::OllamaProvider;

pub fn build_default_providers() -> Vec<Arc<dyn AIProvider>> {
    vec![
        Arc::new(Api666Provider::new()),
        Arc::new(ApiJuyouProvider::new_with_config("juyouapi", "")),
        // aifast：NEWAPI 兼容中转站，base 固定（照 juyouapi 注册模式复用 Api666Provider）。
        // provider_id != "666api" → gemini 系模型自动走 /v1/chat/completions。
        Arc::new(Api666Provider::new_with_config("aifast", "https://picture.aifast.site")),
        Arc::new(AgnesProvider::new()),
        Arc::new(PPIOProvider::new()),
        Arc::new(GrsaiProvider::new()),
        Arc::new(KieProvider::new()),
        Arc::new(FalProvider::new()),
        Arc::new(OllamaProvider::new()),
    ]
}
