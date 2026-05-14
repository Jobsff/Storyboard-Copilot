use std::sync::Arc;

use super::AIProvider;

pub mod ppio;
pub mod grsai;
pub mod kie;
pub mod fal;
pub mod api666;
pub mod juyouapi;

pub use fal::FalProvider;
pub use grsai::GrsaiProvider;
pub use kie::KieProvider;
pub use ppio::PPIOProvider;
pub use api666::Api666Provider;
pub use juyouapi::ApiJuyouProvider;

pub fn build_default_providers() -> Vec<Arc<dyn AIProvider>> {
    vec![
        Arc::new(Api666Provider::new()),
        Arc::new(ApiJuyouProvider::new_with_config("juyouapi", "")),
        Arc::new(PPIOProvider::new()),
        Arc::new(GrsaiProvider::new()),
        Arc::new(KieProvider::new()),
        Arc::new(FalProvider::new()),
    ]
}
